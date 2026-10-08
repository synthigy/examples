#!/usr/bin/env bb
;; Transform MovieLens CSVs into Synthigy import JSONs.
;;
;; Usage:  bb prep_movielens.bb <path-to-ml-dir> <out-dir> [--shard N]
;;
;; Produces:
;;   movies.json                 — Movie entities
;;   movie_genres.json           — MovieGenre entities (unique genres)
;;   movie_genres_mapping.json   — Movie ↔ MovieGenre m2m sync payload
;;   users.json                  — IAM User bootstrap list
;;   user_ratings.json           — UserRating entities                [no --shard]
;;   user_tags.json              — UserTag entities                   [no --shard]
;;
;; With --shard N (N > 0), ratings/tags are sharded into:
;;   user_ratings_0001.json, user_ratings_0002.json, ...   ≤ N rows per shard
;;   user_tags_0001.json,    user_tags_0002.json,    ...   ≤ N rows per shard
;;
;; Use --shard for ml-25m/ml-32m; omit for ml-latest-small (legacy single-file
;; layout — output is byte-identical to the pre-refactor script).
;;
;; Deterministic euuids: UUID v3 (MD5) over a namespaced key.

(require '[clojure.string :as str]
         '[clojure.java.io :as io]
         '[cheshire.core :as json])

(import '[java.util UUID ArrayList]
        '[java.io BufferedReader]
        '[java.time Instant])

;; ---------- IDs ----------------------------------------------------------

(defn det-uuid
  "Deterministic UUID v3 (MD5) over a namespaced key. Stable across runs."
  [kind & parts]
  (let [k (str "synthigy-movies-example/" kind "/" (str/join "/" parts))]
    (str (UUID/nameUUIDFromBytes (.getBytes k "UTF-8")))))

(defn movie-uuid [movieId] (det-uuid "movie" movieId))
(defn user-uuid  [uid]     (det-uuid "user"  uid))

;; ---------- CSV parsing --------------------------------------------------

(defn parse-row
  "Parse one CSV line into a vector of string fields. Handles double-quoted
   fields with embedded commas and escaped quotes."
  [^String line]
  (let [n (count line) sb (StringBuilder.)]
    (loop [i 0 in-q? false fields []]
      (if (= i n)
        (conj fields (.toString sb))
        (let [c (.charAt line i)]
          (cond
            (and (= c \") (not in-q?)) (recur (inc i) true fields)
            (and (= c \") in-q?)
            (if (and (< (inc i) n) (= (.charAt line (inc i)) \"))
              (do (.append sb \") (recur (+ i 2) true fields))
              (recur (inc i) false fields))
            (and (= c \,) (not in-q?))
            (let [s (.toString sb)] (.setLength sb 0)
              (recur (inc i) false (conj fields s)))
            :else (do (.append sb c) (recur (inc i) in-q? fields))))))))

(defn read-csv-all
  "Read a CSV file fully into a vector of maps. Use for small CSVs."
  [path]
  (with-open [^BufferedReader r (io/reader path)]
    (let [header (mapv keyword (parse-row (.readLine r)))]
      (loop [out (transient [])]
        (let [line (.readLine r)]
          (if (nil? line)
            (persistent! out)
            (recur (conj! out (zipmap header (parse-row line))))))))))

;; ---------- Field normalization -----------------------------------------

(def title+year-re #"^(.*?)\s+\((\d{4})\)\s*$")

(defn split-title-year
  "MovieLens titles look like 'Toy Story (1995)'. Returns [title year-or-nil]."
  [raw]
  (if-some [m (re-matches title+year-re raw)]
    [(nth m 1) (Integer/parseInt (nth m 2))]
    [raw nil]))

(defn split-genres [raw]
  (let [gs (->> (str/split raw #"\|") (remove #(or (str/blank? %) (= "(no genres listed)" %))))]
    (vec gs)))

(defn unix->iso [s]
  (-> s Long/parseLong (* 1000) Instant/ofEpochMilli .toString))

;; ---------- Movies / genres (in memory — small) -------------------------

(defn build-movies+genres
  "Returns {:movies movies-public :genres genres :genres-mapping mapping
            :movie-ids #{movieId-string ...}}."
  [ml-dir]
  (let [movies-csv (read-csv-all (str ml-dir "/movies.csv"))
        movies (mapv (fn [{:keys [movieId title genres]}]
                       (let [[t y] (split-title-year title)]
                         (cond-> {:euuid (movie-uuid movieId)
                                  :title t}
                           y (assoc :release_year y)
                           :always (assoc :_movieId movieId :_genres (split-genres genres)))))
                     movies-csv)
        movies-public (mapv #(dissoc % :_movieId :_genres) movies)
        movie-ids (into #{} (map :_movieId) movies)
        genre-names (->> movies (mapcat :_genres) distinct sort)
        genres (mapv (fn [g] {:euuid (det-uuid "genre" g) :name g}) genre-names)
        ;; one row per genre with array of linked movies
        genres-mapping (mapv (fn [g]
                               {:euuid (det-uuid "genre" (:name g))
                                :movies (->> movies
                                             (filter #(some #{(:name g)} (:_genres %)))
                                             (mapv (fn [m] {:euuid (:euuid m)})))})
                             genres)]
    {:movies movies-public
     :genres genres
     :genres-mapping genres-mapping
     :movie-ids movie-ids}))

;; ---------- Streaming write for large CSVs ------------------------------

(defn write-json [path data]
  (with-open [w (io/writer path)]
    (json/generate-stream data w {:pretty false})))

(defn shard-path [out-dir base idx]
  (str out-dir "/" base "_" (format "%04d" (inc idx)) ".json"))

(defn- file-basename [path]
  (last (str/split path #"/")))

(defn stream-shards
  "Stream a CSV through `row->record`, writing JSON shards. Walks the file
   via `.readLine` directly (no lazy-seq head retention). Skips rows where
   row->record returns nil. Invokes `collect-user!` per emitted row.

   With shard-size nil/0/<=0: writes single file `<base>.json` (legacy layout).
   With positive shard-size: writes `<base>_NNNN.json` shards.

   Returns {:total N :shards K}."
  [{:keys [csv-path out-dir base shard-size row->record collect-user!]}]
  (let [single? (or (nil? shard-size) (<= shard-size 0))]
    (with-open [^BufferedReader r (io/reader csv-path)]
      (let [header (mapv keyword (parse-row (.readLine r)))
            flush! (fn [idx ^ArrayList buf]
                     (let [v (vec buf)
                           path (if single?
                                  (str out-dir "/" base ".json")
                                  (shard-path out-dir base idx))]
                       (write-json path v)
                       (printf "  %-36s %9d items%n" (file-basename path) (count v))
                       (count v)))]
        (loop [idx 0 buf (ArrayList.) total 0 shards 0]
          (let [line (.readLine r)]
            (cond
              ;; EOF
              (nil? line)
              (let [last-count (if (.isEmpty buf) 0 (flush! idx buf))
                    total* (+ total last-count)
                    shards* (+ shards (if (zero? last-count) 0 1))]
                (when (and (not single?) (> shards* 1))
                  (printf "  %-36s %9d items (across %d shards)%n"
                          (str base "_*.json") total* shards*))
                {:total total* :shards shards*})

              :else
              (let [row (zipmap header (parse-row line))
                    rec (row->record row)]
                (cond
                  (nil? rec) (recur idx buf total shards)

                  ;; shard full → flush then start fresh with current rec
                  (and (not single?) (>= (.size buf) shard-size))
                  (let [c (flush! idx buf)]
                    (collect-user! row)
                    (.clear buf)
                    (.add buf rec)
                    (recur (inc idx) buf (+ total c) (inc shards)))

                  :else
                  (do (collect-user! row)
                      (.add buf rec)
                      (recur idx buf total shards)))))))))))

;; ---------- Main --------------------------------------------------------

(defn parse-args [args]
  (loop [args args opts {} positional []]
    (cond
      (empty? args) {:opts opts :positional positional}
      (= "--shard" (first args)) (recur (drop 2 args)
                                        (assoc opts :shard (Long/parseLong (second args)))
                                        positional)
      :else (recur (rest args) opts (conj positional (first args))))))

(defn -main [& argv]
  (let [{:keys [opts positional]} (parse-args argv)
        [ml-dir out-dir] positional
        shard-size (:shard opts)]
    (when (or (nil? ml-dir) (nil? out-dir))
      (println "Usage: bb prep_movielens.bb <ml-dir> <out-dir> [--shard N]")
      (System/exit 2))
    (.mkdirs (io/file out-dir))
    (println "Reading" ml-dir "→ writing" out-dir
             (if shard-size (str "  (shard " shard-size ")") ""))

    (let [{:keys [movies genres genres-mapping movie-ids]} (build-movies+genres ml-dir)]
      (write-json (str out-dir "/movies.json") movies)
      (printf "  %-36s %9d items%n" "movies.json" (count movies))
      (write-json (str out-dir "/movie_genres.json") genres)
      (printf "  %-36s %9d items%n" "movie_genres.json" (count genres))
      (write-json (str out-dir "/movie_genres_mapping.json") genres-mapping)
      (printf "  %-36s %9d items%n" "movie_genres_mapping.json" (count genres-mapping))

      (let [user-ids (atom (sorted-set))
            collect! (fn [{:keys [userId]}]
                       (swap! user-ids conj (Integer/parseInt userId)))]
        (stream-shards
          {:csv-path (str ml-dir "/ratings.csv")
           :out-dir out-dir
           :base "user_ratings"
           :shard-size shard-size
           :collect-user! collect!
           :row->record
           (fn [{:keys [userId movieId rating timestamp]}]
             (when (movie-ids movieId)
               {:euuid (det-uuid "rating" userId movieId timestamp)
                :value (Double/parseDouble rating)
                :timestamp (unix->iso timestamp)
                :movie {:euuid (movie-uuid movieId)}
                :user  {:euuid (user-uuid (Integer/parseInt userId))}}))})
        (stream-shards
          {:csv-path (str ml-dir "/tags.csv")
           :out-dir out-dir
           :base "user_tags"
           :shard-size shard-size
           :collect-user! collect!
           :row->record
           (fn [{:keys [userId movieId tag timestamp]}]
             (when (movie-ids movieId)
               {:euuid (det-uuid "tag" userId movieId tag timestamp)
                :value tag
                :timestamp (unix->iso timestamp)
                :movie {:euuid (movie-uuid movieId)}
                :user  {:euuid (user-uuid (Integer/parseInt userId))}}))})

        (let [users (mapv (fn [uid]
                            {:euuid (user-uuid uid)
                             :name (str "MovieLens User " uid)
                             :email (str "ml-user-" uid "@movies.demo.synthigy.dev")})
                          @user-ids)]
          (write-json (str out-dir "/users.json") users)
          (printf "  %-36s %9d items%n" "users.json" (count users)))))))

(apply -main *command-line-args*)
