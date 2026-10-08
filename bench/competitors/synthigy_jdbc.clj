;; Raw next.jdbc bulk-insert benchmark — Synthigy's JDBC stack, ZERO framework.
;;
;; Purpose: isolate the JDBC/driver layer from the `sync-entity` machinery.
;; This imports the SAME MovieLens dataset into the SAME flat `schema.sql`
;; that PostgREST/Supabase uses, via the SAME next.jdbc + pgjdbc Synthigy
;; uses — but with none of sync-entity / RLS / hooks / xid-resolution.
;;
;;   - if this lands near PostgREST's ~6 s  → JDBC is innocent; the gap is
;;     100 % the sync-entity framework.
;;   - if this lands near Synthigy's ~17 s  → the cost is in the JDBC/driver
;;     layer, and sync-entity is not the culprit.
;;
;; Usage (in any REPL with next.jdbc + jsonista — e.g. the Synthigy nREPL):
;;   (load-file ".../bench/competitors/synthigy_jdbc.clj")
;;   (synthigy-bench.jdbc/run! {:batch 1000})
;;
;; Requires the flat schema applied to the `bench` DB first:  ./setup.sh

(ns synthigy-bench.jdbc
  (:require [next.jdbc :as jdbc]
            [jsonista.core :as j]
            [clojure.string :as str])
  (:import [java.io File]))

;; Dataset selection: env var MOVIES_DATASET overrides the default
;; (ml-latest-small). Set MOVIES_DATASET=movies-25m to point at sharded ml-25m.
(def DATA
  (let [name (or (System/getenv "MOVIES_DATASET") "movies")
        root "/home/rgersak/dev/synthigy/examples/datasets/movies/"]
    (str root name "/")))

(def db-spec {:dbtype "postgresql" :host "localhost" :port 5433
              :dbname "bench" :user "bench" :password "bench"})

(defn- read-json [^File f]
  (j/read-value (slurp f) j/keyword-keys-object-mapper))

(defn- list-shards [base]
  (let [re (re-pattern (str base "_\\d+\\.json"))]
    (->> (.listFiles (File. ^String DATA))
         (filter #(re-matches re (.getName ^File %)))
         (sort-by #(.getName ^File %)))))

(defn- load-json
  "Load `<base>.json` if present, else concat shards `<base>_NNNN.json`."
  [f]
  (let [base (if (str/ends-with? f ".json") (subs f 0 (- (count f) 5)) f)
        single (File. (str DATA base ".json"))]
    (if (.exists single)
      (read-json single)
      (let [shards (list-shards base)]
        (when (empty? shards)
          (throw (ex-info (str "No " base ".json or " base "_NNNN.json in " DATA) {})))
        (vec (mapcat read-json shards))))))

(defn- uuid [s] (java.util.UUID/fromString s))
(defn- ts [s] (when s (java.time.OffsetDateTime/parse s)))

(defn load-dataset
  "Flat FK-resolved rows — identical shape to data.mjs / schema.sql."
  []
  (let [movies   (load-json "movies.json")
        genres   (load-json "movie_genres.json")
        actorsR  (load-json "movie_actors.json")
        users    (load-json "users.json")
        ratings  (load-json "user_ratings.json")
        tags     (load-json "user_tags.json")
        gmap     (load-json "movie_genres_mapping.json")
        amap     (load-json "movie_actors_mapping.json")
        ;; dedupe actors by name (one source collision), remap mapping rows
        by-name  (reduce (fn [m a] (if (m (:name a)) m (assoc m (:name a) a)))
                         {} actorsR)
        remap    (into {} (for [a actorsR
                                :let [k (:euuid (by-name (:name a)))]
                                :when (not= k (:euuid a))]
                            [(:euuid a) k]))
        rmx      (fn [e] (get remap e e))]
    {:movie       (mapv (fn [m] [(uuid (:euuid m)) (:title m) (:release_year m)]) movies)
     :movie_genre (mapv (fn [g] [(uuid (:euuid g)) (:name g)]) genres)
     :movie_actor (mapv (fn [a] [(uuid (:euuid a)) (:name a) (:birth_year a) (:nationality a)])
                        (vals by-name))
     :app_user    (mapv (fn [u] [(uuid (:euuid u)) (:name u) (:email u)]) users)
     :user_rating (mapv (fn [r] [(uuid (:euuid r)) (:value r) (ts (:timestamp r))
                                 (uuid (-> r :movie :euuid)) (uuid (-> r :user :euuid))])
                        ratings)
     :user_tag    (mapv (fn [t] [(uuid (:euuid t)) (:value t) (ts (:timestamp t))
                                 (uuid (-> t :movie :euuid)) (uuid (-> t :user :euuid))])
                        tags)
     :movie_genre_mapping
     (vec (distinct (for [g gmap, m (:movies g)]
                      [(uuid (:euuid m)) (uuid (:euuid g))])))
     :movie_actor_mapping
     (vec (distinct (for [a amap, m (:movies a)]
                      [(uuid (:euuid m)) (uuid (rmx (:euuid a)))])))}))

(def ^:private cols
  {:movie ["id" "title" "release_year"]
   :movie_genre ["id" "name"]
   :movie_actor ["id" "name" "birth_year" "nationality"]
   :app_user ["id" "name" "email"]
   :user_rating ["id" "value" "\"timestamp\"" "movie_id" "user_id"]
   :user_tag ["id" "value" "\"timestamp\"" "movie_id" "user_id"]
   :movie_genre_mapping ["movie_id" "genre_id"]
   :movie_actor_mapping ["movie_id" "actor_id"]})

(def PHASES [:movie_genre :movie_actor :app_user :movie
             :movie_genre_mapping :movie_actor_mapping :user_rating :user_tag])

(defn- bulk-insert! [conn table col-list rows batch]
  (let [n  (count col-list)
        ph (str "(" (str/join "," (repeat n "?")) ")")]
    (doseq [chunk (partition-all batch rows)]
      (jdbc/execute! conn
        (into [(str "INSERT INTO " (name table)
                    " (" (str/join "," col-list) ") VALUES "
                    (str/join "," (repeat (count chunk) ph)))]
              cat chunk)))))

(defn run!
  [{:keys [batch] :or {batch 1000}}]
  (println (format "\nRaw next.jdbc bulk insert — Synthigy's JDBC stack, no framework, batch=%d\n" batch))
  (let [data (load-dataset)]
    (with-open [conn (jdbc/get-connection db-spec)]
      (let [t0 (System/nanoTime)]
        (doseq [phase PHASES]
          (let [rows (data phase)
                p0   (System/nanoTime)]
            (bulk-insert! conn phase (cols phase) rows batch)
            (let [secs (/ (- (System/nanoTime) p0) 1e9)]
              (printf "  %-22s %8d rows  %8.2fs  %12.0f rec/s%n"
                      (name phase) (count rows) secs (/ (count rows) secs))
              (flush))))
        (let [total (/ (- (System/nanoTime) t0) 1e9)
              n (reduce + (map #(count (data %)) PHASES))]
          (println "  " (apply str (repeat 64 \-)))
          (printf "  %-22s %8d rows  %8.2fs  %12.0f rec/s%n"
                  "TOTAL — raw next.jdbc" n total (/ n total))
          (flush)
          {:total total :rows n})))))
