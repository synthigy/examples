#!/usr/bin/env bb
;; Enrich top-N MovieLens movies with TMDb cast data.
;;
;; Usage:  TMDB_TOKEN_FILE=/tmp/tmdb-token bb enrich_tmdb.bb \
;;           <ml-csv-dir> <prep-out-dir> [top-n]
;;
;; Reads:
;;   <ml-csv-dir>/links.csv          (movieId,imdbId,tmdbId — to discover TMDb ids)
;;   <prep-out-dir>/user_ratings.json (to rank movies by rating count)
;;
;; Emits into <prep-out-dir>:
;;   movie_actors.json          — unique actors {euuid, name, birth_year}
;;   movie_actors_mapping.json  — m2m payload {actor-euuid, movies:[{euuid}]}
;;
;; Caches every TMDb response under $TMDB_CACHE_DIR (default /tmp/tmdb-cache/)
;; so re-runs cost zero API calls.

(require '[clojure.string :as str]
         '[clojure.java.io :as io]
         '[cheshire.core :as json]
         '[babashka.http-client :as http])

(import '[java.util UUID])

;; ---------- Config ------------------------------------------------------

(def TMDB-BASE "https://api.themoviedb.org/3")
(def CAST-CAP 10)
(def REQ-INTERVAL-MS 350)            ;; ~3 req/sec; TMDb limit is 40/10s = 4/sec
(def CACHE-DIR (or (System/getenv "TMDB_CACHE_DIR") "/tmp/tmdb-cache"))

(defn token []
  (let [tf (System/getenv "TMDB_TOKEN_FILE")
        t  (System/getenv "TMDB_TOKEN")]
    (cond
      tf (str/trim (slurp tf))
      t  (str/trim t)
      :else (throw (ex-info "Set TMDB_TOKEN_FILE or TMDB_TOKEN" {})))))

;; ---------- IDs ---------------------------------------------------------

(defn det-uuid [kind & parts]
  (let [k (str "synthigy-movies-example/" kind "/" (str/join "/" parts))]
    (str (UUID/nameUUIDFromBytes (.getBytes k "UTF-8")))))

;; ---------- HTTP with rate limit + retry + disk cache -------------------

(def last-call-ms (atom 0))
(def call-lock (Object.))

(defn- throttle! []
  (locking call-lock
    (let [now  (System/currentTimeMillis)
          wait (- (+ @last-call-ms REQ-INTERVAL-MS) now)]
      (when (pos? wait) (Thread/sleep wait))
      (reset! last-call-ms (System/currentTimeMillis)))))

(defn- http-get-json [url]
  (loop [attempt 0]
    (throttle!)
    (let [resp (http/get url {:headers {"Authorization" (str "Bearer " (token))
                                        "Accept" "application/json"}
                              :throw false})]
      (cond
        (= 200 (:status resp))
        (json/parse-string (:body resp) keyword)

        (and (= 429 (:status resp)) (< attempt 4))
        (let [retry (or (some-> (get-in resp [:headers "retry-after"]) Integer/parseInt) 10)]
          (binding [*out* *err*]
            (println (str "  429 — sleeping " retry "s")))
          (Thread/sleep (* 1000 (inc retry)))
          (recur (inc attempt)))

        :else
        (throw (ex-info "TMDb HTTP error"
                        {:status (:status resp)
                         :url url
                         :body (subs (str (:body resp)) 0 (min 200 (count (str (:body resp)))))}))))))

(defn- cached-get [subdir id url]
  (let [path (io/file CACHE-DIR subdir (str id ".json"))]
    (if (.exists path)
      (json/parse-string (slurp path) keyword)
      (let [data (http-get-json url)]
        (.mkdirs (.getParentFile path))
        (spit path (json/generate-string data))
        data))))

(defn fetch-credits [tmdb-movie-id]
  (cached-get "movie-credits" tmdb-movie-id
              (str TMDB-BASE "/movie/" tmdb-movie-id "/credits")))

(defn fetch-person [person-id]
  (cached-get "person" person-id
              (str TMDB-BASE "/person/" person-id)))

;; ---------- Local data loading -----------------------------------------

(defn read-links [csv-path]
  ;; movieId,imdbId,tmdbId  — map movieId-string → tmdbId-string
  (with-open [r (io/reader csv-path)]
    (let [lines (rest (line-seq r))]
      (into {}
            (keep (fn [line]
                    (let [parts (str/split line #",")
                          mid (nth parts 0)
                          tmdb (nth parts 2 "")]
                      (when-not (str/blank? tmdb) [mid tmdb]))))
            (doall lines)))))

(defn top-n-movie-euuids [ratings-json-path n]
  (let [counts (->> (json/parse-string (slurp ratings-json-path) keyword)
                    (reduce (fn [m r]
                              (let [e (get-in r [:movie :euuid])]
                                (assoc m e (inc (long (or (m e) 0))))))
                            {}))]
    (->> counts (sort-by val >) (take n) (map first) vec)))

;; ---------- Main pipeline ----------------------------------------------

(defn enrich [ml-csv-dir prep-dir top-n]
  (println "Loading local data...")
  (let [links             (read-links (str ml-csv-dir "/links.csv"))
        movieid->euuid    (into {} (map (fn [mid] [mid (det-uuid "movie" mid)])) (keys links))
        euuid->movieid    (into {} (map (juxt val key)) movieid->euuid)
        top-euuids        (top-n-movie-euuids (str prep-dir "/user_ratings.json") top-n)
        top-with-tmdb     (keep (fn [e]
                                  (when-some [mid (euuid->movieid e)]
                                    (when-some [tmdb (links mid)]
                                      {:movie-euuid e :movieId mid :tmdb-id tmdb})))
                                top-euuids)]
    (println "Top" top-n "movies →" (count top-with-tmdb) "have TMDb ids")

    ;; --- Fetch credits → list of (movie-euuid, [tmdb-person-id ...]) ---
    (println "\nFetching credits...")
    (let [movie->cast-ids
          (reduce
            (fn [acc {:keys [movie-euuid tmdb-id]}]
              (let [credits (fetch-credits tmdb-id)
                    cast (->> (:cast credits)
                              (sort-by (fnil :order (constantly 99999)))
                              (filter #(= "Acting" (:known_for_department %)))
                              (take CAST-CAP)
                              (map :id)
                              vec)]
                (when (zero? (mod (inc (count acc)) 25))
                  (println (str "  " (inc (count acc)) "/" (count top-with-tmdb))))
                (assoc acc movie-euuid cast)))
            {}
            top-with-tmdb)
          unique-actors (->> movie->cast-ids vals (mapcat identity) distinct vec)]
      (println "Unique actors:" (count unique-actors))

      ;; --- Fetch person records ---
      (println "\nFetching person records...")
      (let [actor-data
            (reduce
              (fn [acc i]
                (let [pid (nth unique-actors i)
                      p (fetch-person pid)
                      birth-year (when-some [b (:birthday p)]
                                   (when (and (string? b) (>= (count b) 4))
                                     (try (Integer/parseInt (subs b 0 4)) (catch Exception _ nil))))]
                  (when (zero? (mod (inc i) 100))
                    (println (str "  " (inc i) "/" (count unique-actors))))
                  (assoc acc pid {:euuid (det-uuid "actor" pid)
                                  :name (:name p)
                                  :birth_year birth-year})))
              {}
              (range (count unique-actors)))

            ;; --- Emit actors (drop nil names/years cleanly) ---
            actors-out (->> unique-actors
                            (keep (fn [pid]
                                    (let [a (actor-data pid)]
                                      (when (and a (:name a) (not (str/blank? (:name a))))
                                        (cond-> {:euuid (:euuid a) :name (:name a)}
                                          (:birth_year a) (assoc :birth_year (:birth_year a))))))))

            ;; --- Emit mapping: for each actor, list of movie euuids ---
            actor->movies (reduce
                            (fn [m [movie-euuid cast-ids]]
                              (reduce (fn [m pid]
                                        (update m pid (fnil conj []) {:euuid movie-euuid}))
                                      m
                                      cast-ids))
                            {}
                            movie->cast-ids)
            mapping-out (->> unique-actors
                             (keep (fn [pid]
                                     (let [a (actor-data pid)]
                                       (when (and a (:name a) (not (str/blank? (:name a))))
                                         {:euuid (:euuid a)
                                          :movies (vec (sort-by :euuid (or (actor->movies pid) [])))})))))]

        (println "\nWriting" (str prep-dir "/movie_actors.json") "—" (count actors-out) "actors")
        (with-open [w (io/writer (str prep-dir "/movie_actors.json"))]
          (json/generate-stream actors-out w))
        (println "Writing" (str prep-dir "/movie_actors_mapping.json") "—" (count mapping-out) "mapping records")
        (with-open [w (io/writer (str prep-dir "/movie_actors_mapping.json"))]
          (json/generate-stream mapping-out w))
        (println "Done.")))))

(defn -main [& [ml-csv-dir prep-dir top-n]]
  (when (or (nil? ml-csv-dir) (nil? prep-dir))
    (println "Usage: bb enrich_tmdb.bb <ml-csv-dir> <prep-dir> [top-n]")
    (System/exit 2))
  (enrich ml-csv-dir prep-dir (Integer/parseInt (or top-n "200"))))

(apply -main *command-line-args*)
