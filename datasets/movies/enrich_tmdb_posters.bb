#!/usr/bin/env bb
;; Fetch movie posters from TMDb for every MovieLens movie with a TMDb id.
;;
;; Usage:  TMDB_TOKEN_FILE=/tmp/tmdb-token bb enrich_tmdb_posters.bb \
;;           <ml-csv-dir> <prep-out-dir>
;;
;; Reads:
;;   <ml-csv-dir>/links.csv   TMDb id mapping (movieId,imdbId,tmdbId)
;;
;; Emits into <prep-out-dir>:
;;   movie_posters.json   — {euuid, poster} for every movie with a poster
;;
;; Caches every TMDb response under $TMDB_CACHE_DIR (default /tmp/tmdb-cache/);
;; re-runs cost zero API calls. Soft-fails on non-200/429 — those entries are
;; simply skipped and not cached, so a future re-run will retry them.
;;
;; Sibling of enrich_tmdb.bb (same HTTP/cache/throttle/id machinery); kept
;; separate because it hits /movie/{id} (details) rather than
;; /movie/{id}/credits + /person/{id} — a different TMDb endpoint pair, no
;; cast/actor output.

(require '[clojure.string :as str]
         '[clojure.java.io :as io]
         '[cheshire.core :as json]
         '[babashka.http-client :as http])

(import '[java.util UUID])

;; ---------- Config ------------------------------------------------------

(def TMDB-BASE "https://api.themoviedb.org/3")
(def REQ-INTERVAL-MS (Integer/parseInt (or (System/getenv "TMDB_INTERVAL_MS") "100")))
(def CACHE-DIR (or (System/getenv "TMDB_CACHE_DIR") "/tmp/tmdb-cache"))

(defn token []
  (let [tf (System/getenv "TMDB_TOKEN_FILE")
        t  (System/getenv "TMDB_TOKEN")]
    (cond
      tf (str/trim (slurp tf))
      t  (str/trim t)
      :else (throw (ex-info "Set TMDB_TOKEN_FILE or TMDB_TOKEN" {})))))

;; ---------- IDs (identical to enrich_tmdb.bb — same deterministic euuids) --

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

(defn- try-parse-json [^String body url]
  (try
    (json/parse-string body keyword)
    (catch Exception e
      (binding [*out* *err*]
        (println (str "  parse-fail — skipping " url
                      "  (head: " (subs (str body) 0 (min 40 (count (str body)))) "…)")))
      :parse-fail)))

(defn- http-get-json [url]
  (loop [attempt 0]
    (throttle!)
    (let [resp (http/get url {:headers {"Authorization" (str "Bearer " (token))
                                        "Accept" "application/json"}
                              :throw false})
          status (:status resp)]
      (cond
        (= 200 status)
        (let [parsed (try-parse-json (:body resp) url)]
          (if (= :parse-fail parsed) nil parsed))

        (and (= 429 status) (< attempt 4))
        (let [retry (or (some-> (get-in resp [:headers "retry-after"]) Integer/parseInt) 10)]
          (binding [*out* *err*] (println (str "  429 — sleeping " retry "s")))
          (Thread/sleep (* 1000 (inc retry)))
          (recur (inc attempt)))

        (and (>= status 500) (< attempt 3))
        (do (Thread/sleep 2000) (recur (inc attempt)))

        :else
        (do (binding [*out* *err*] (println (str "  " status " — skipping " url)))
            nil)))))

(defn- cached-get [subdir id url]
  (let [path (io/file CACHE-DIR subdir (str id ".json"))]
    (if (.exists path)
      (json/parse-string (slurp path) keyword)
      (when-some [data (http-get-json url)]
        (.mkdirs (.getParentFile path))
        (spit path (json/generate-string data))
        data))))

(defn fetch-details [tmdb-movie-id]
  (cached-get "movie-details" tmdb-movie-id
              (str TMDB-BASE "/movie/" tmdb-movie-id)))

(defn poster-url [poster-path]
  (when (and poster-path (not (str/blank? poster-path)))
    (str "https://image.tmdb.org/t/p/w500" poster-path)))

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

;; ---------- Main pipeline ----------------------------------------------

(defn enrich [ml-csv-dir prep-dir]
  (println "Loading local data...")
  (let [links (read-links (str ml-csv-dir "/links.csv"))
        total (count links)
        progress-every (max 100 (long (/ total 100)))]
    (println "All movies →" total "have TMDb ids")
    (println "\nFetching posters...")
    (let [out (->> links
                   (map-indexed
                     (fn [i [mid tmdb-id]]
                       (when (zero? (mod (inc i) progress-every))
                         (println (str "  " (inc i) "/" total)))
                       (let [details (fetch-details tmdb-id)
                             poster (poster-url (:poster_path details))]
                         (when poster
                           {:euuid (det-uuid "movie" mid) :poster poster}))))
                   (keep identity)
                   vec)]
      (println "\nWriting" (str prep-dir "/movie_posters.json") "—" (count out) "posters")
      (with-open [w (io/writer (str prep-dir "/movie_posters.json"))]
        (json/generate-stream out w))
      (println "Done."))))

(defn -main [& [ml-csv-dir prep-dir]]
  (when (or (nil? ml-csv-dir) (nil? prep-dir))
    (println "Usage: bb enrich_tmdb_posters.bb <ml-csv-dir> <prep-dir>")
    (System/exit 2))
  (enrich ml-csv-dir prep-dir))

(apply -main *command-line-args*)
