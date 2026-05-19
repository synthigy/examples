#!/usr/bin/env bb
;; Transform MovieLens-small CSVs into Synthigy import JSONs.
;;
;; Usage:  bb prep_movielens.bb <path-to-ml-latest-small> <out-dir>
;;
;; Produces:
;;   movies.json                 — Movie entities
;;   movie_genres.json           — MovieGenre entities (unique genres)
;;   movie_genres_mapping.json   — Movie ↔ MovieGenre m2m sync payload
;;   users.json                  — IAM User bootstrap list (consumed by bootstrap_iam.clj)
;;   user_ratings.json           — UserRating entities (movie + user xrefs by euuid)
;;   user_tags.json              — UserTag entities (movie + user xrefs by euuid)
;;
;; Deterministic euuids: UUID v3 (MD5) over a namespaced key. Re-runs produce
;; byte-identical output, so files diff cleanly across regenerations.

(require '[clojure.string :as str]
         '[clojure.java.io :as io]
         '[cheshire.core :as json])

(import '[java.util UUID]
        '[java.time Instant]
        '[java.time.format DateTimeFormatter])

;; ---------- IDs ----------------------------------------------------------

(defn det-uuid
  "Deterministic UUID v3 (MD5) over a namespaced key. Stable across runs."
  [kind & parts]
  (let [k (str "synthigy-movies-example/" kind "/" (str/join "/" parts))]
    (str (UUID/nameUUIDFromBytes (.getBytes k "UTF-8")))))

;; ---------- CSV parsing --------------------------------------------------

(defn parse-csv
  "Lazy line-by-line CSV parser handling double-quoted fields with commas."
  [path]
  (with-open [r (io/reader path)]
    (let [lines (line-seq r)
          header (mapv keyword (str/split (first lines) #","))
          parse-row (fn [line]
                      (let [n (count line)
                            sb (StringBuilder.)]
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
                                :else (do (.append sb c) (recur (inc i) in-q? fields))))))))]
      (doall (map (fn [line] (zipmap header (parse-row line))) (rest lines))))))

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

;; ---------- Build payloads ----------------------------------------------

(defn build [ml-dir]
  (let [movies-csv  (parse-csv (str ml-dir "/movies.csv"))
        ratings-csv (parse-csv (str ml-dir "/ratings.csv"))
        tags-csv    (parse-csv (str ml-dir "/tags.csv"))

        ;; Movies + genre extraction
        movies (mapv (fn [{:keys [movieId title genres]}]
                       (let [[t y] (split-title-year title)]
                         (cond-> {:euuid (det-uuid "movie" movieId)
                                  :title t}
                           y (assoc :release_year y)
                           :always (assoc :_movieId movieId :_genres (split-genres genres)))))
                     movies-csv)
        movies-public (mapv #(dissoc % :_movieId :_genres) movies)

        ;; Unique genres
        genre-names (->> movies (mapcat :_genres) distinct sort)
        genres      (mapv (fn [g] {:euuid (det-uuid "genre" g) :name g}) genre-names)

        ;; Movie ↔ Genre mapping (one record per genre with array of linked movies)
        genres-mapping (mapv (fn [g]
                               {:euuid (det-uuid "genre" (:name g))
                                :movies (->> movies
                                             (filter #(some #{(:name g)} (:_genres %)))
                                             (mapv (fn [m] {:euuid (:euuid m)})))})
                             genres)

        ;; Users from MovieLens userIds (union over ratings and tags)
        user-ids (->> (concat ratings-csv tags-csv)
                      (map :userId) distinct
                      (map #(Integer/parseInt %)) sort)
        users (mapv (fn [uid]
                      {:euuid (det-uuid "user" uid)
                       :name (str "MovieLens User " uid)
                       :email (str "ml-user-" uid "@movies.demo.synthigy.dev")
                       :_movielens_user_id uid})
                    user-ids)

        movie-euuid (into {} (map (fn [m] [(:_movieId m) (:euuid m)])) movies)
        user-euuid  (into {} (map (fn [u] [(:_movielens_user_id u) (:euuid u)])) users)

        ;; Ratings — float value, ISO timestamp, xrefs by euuid
        ratings (mapv (fn [{:keys [userId movieId rating timestamp]}]
                        {:euuid (det-uuid "rating" userId movieId timestamp)
                         :value (Double/parseDouble rating)
                         :timestamp (unix->iso timestamp)
                         :movie {:euuid (movie-euuid movieId)}
                         :user  {:euuid (user-euuid (Integer/parseInt userId))}})
                      ratings-csv)

        ;; Tags — string value, ISO timestamp, xrefs by euuid
        tags (mapv (fn [{:keys [userId movieId tag timestamp]}]
                     {:euuid (det-uuid "tag" userId movieId tag timestamp)
                      :value tag
                      :timestamp (unix->iso timestamp)
                      :movie {:euuid (movie-euuid movieId)}
                      :user  {:euuid (user-euuid (Integer/parseInt userId))}})
                   tags-csv)

        ;; Strip helper key from users on the way out
        users-public (mapv #(dissoc % :_movielens_user_id) users)]

    {:movies movies-public
     :genres genres
     :genres-mapping genres-mapping
     :users users-public
     :ratings ratings
     :tags tags}))

;; ---------- Main --------------------------------------------------------

(defn -main [& [ml-dir out-dir]]
  (when (or (nil? ml-dir) (nil? out-dir))
    (println "Usage: bb prep_movielens.bb <ml-dir> <out-dir>")
    (System/exit 2))
  (.mkdirs (io/file out-dir))
  (let [{:keys [movies genres genres-mapping users ratings tags]} (build ml-dir)
        write (fn [name data]
                (let [path (str out-dir "/" name)]
                  (with-open [w (io/writer path)]
                    (json/generate-stream data w {:pretty false}))
                  (printf "  %-32s %7d items%n" name (count data))))]
    (println "Writing to" out-dir)
    (write "movies.json" movies)
    (write "movie_genres.json" genres)
    (write "movie_genres_mapping.json" genres-mapping)
    (write "users.json" users)
    (write "user_ratings.json" ratings)
    (write "user_tags.json" tags)))

(apply -main *command-line-args*)
