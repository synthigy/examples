#!/usr/bin/env bb
;; Enrich MovieLens movies with TMDb cast data.
;;
;; Usage:  TMDB_TOKEN_FILE=/tmp/tmdb-token bb enrich_tmdb.bb \
;;           <ml-csv-dir> <prep-out-dir> [top-n]
;;
;; top-n:
;;   integer    — enrich the N most-rated movies (default 200)
;;   "all"      — enrich every movie in links.csv with a TMDb id
;;                (skips the rating-count pass; memory-bounded for ml-25m)
;;
;; Reads:
;;   <ml-csv-dir>/links.csv                                  TMDb id mapping
;;   <prep-out-dir>/user_ratings.json or user_ratings_*.json (rating counts)
;;
;; Emits into <prep-out-dir>:
;;   movie_actors.json          — unique actors {euuid, name, birth_year, ...}
;;   movie_actors_mapping.json  — m2m payload {actor-euuid, movies:[{euuid}]}
;;
;; Caches every TMDb response under $TMDB_CACHE_DIR (default /tmp/tmdb-cache/);
;; re-runs cost zero API calls. Soft-fails on non-200/429 (e.g. 404 deleted
;; movies) — those entries are simply skipped and not cached, so a future
;; re-run will retry them.

(require '[clojure.string :as str]
         '[clojure.java.io :as io]
         '[cheshire.core :as json]
         '[babashka.http-client :as http])

(import '[java.util UUID]
        '[java.io BufferedReader File])

;; ---------- Config ------------------------------------------------------

(def TMDB-BASE "https://api.themoviedb.org/3")
(def CAST-CAP 10)
;; TMDb v4 (bearer token) has no enforced rate limit; we keep a modest gap
;; to be polite. 100 ms ≈ 10 req/sec; 429 retry handles backoff if hit.
(def REQ-INTERVAL-MS (Integer/parseInt (or (System/getenv "TMDB_INTERVAL_MS") "100")))
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

(defn- try-parse-json
  "Parse body as JSON; on parse failure log and return :parse-fail (not nil,
   so the caller can distinguish 'body was non-JSON' from 'no body')."
  [^String body url]
  (try
    (json/parse-string body keyword)
    (catch Exception e
      (binding [*out* *err*]
        (println (str "  parse-fail — skipping " url
                      "  (head: "
                      (subs (str body) 0 (min 40 (count (str body))))
                      "…)")))
      :parse-fail)))

(defn- http-get-json
  "GET → parsed JSON, or nil if the resource is permanently unavailable
   (404, 4xx other than 429, or 200-with-non-JSON-body). 429 backs off
   and retries; transient 5xx retries briefly."
  [url]
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
          (binding [*out* *err*]
            (println (str "  429 — sleeping " retry "s")))
          (Thread/sleep (* 1000 (inc retry)))
          (recur (inc attempt)))

        (and (>= status 500) (< attempt 3))
        (do (Thread/sleep 2000) (recur (inc attempt)))

        :else
        (do (binding [*out* *err*]
              (println (str "  " status " — skipping " url)))
            nil)))))

(defn- cached-get
  "Disk cache wrapper. Successful responses are persisted; misses (nil) are
   NOT cached so that retrying later (after upstream fixes) re-fetches."
  [subdir id url]
  (let [path (io/file CACHE-DIR subdir (str id ".json"))]
    (if (.exists path)
      (json/parse-string (slurp path) keyword)
      (when-some [data (http-get-json url)]
        (.mkdirs (.getParentFile path))
        (spit path (json/generate-string data))
        data))))

(defn fetch-credits [tmdb-movie-id]
  (cached-get "movie-credits" tmdb-movie-id
              (str TMDB-BASE "/movie/" tmdb-movie-id "/credits")))

(defn fetch-person [person-id]
  (cached-get "person" person-id
              (str TMDB-BASE "/person/" person-id)))

;; ---------- TMDb → Synthigy field mapping ------------------------------

(def tmdb-gender->enum
  ;; TMDb: 0 unspecified, 1 female, 2 male, 3 non-binary
  {0 "Unknown" 1 "Female" 2 "Male" 3 "NonBinary"})

(defn parse-year [date-str]
  (when (and (string? date-str) (>= (count date-str) 4))
    (try (Integer/parseInt (subs date-str 0 4)) (catch Exception _ nil))))

(defn parse-nationality
  "Last comma-separated segment of place_of_birth, with [bracketed] annotations stripped.
   Works for ~95% of cases ('Shawnee, Oklahoma, USA' → 'USA'); edge cases like
   'Casablanca, French Protectorate in Morocco [now Morocco]' produce wonkier values."
  [place-of-birth]
  (when (and place-of-birth (not (str/blank? place-of-birth)))
    (-> place-of-birth
        (str/replace #"\s*\[.*?\]" "")
        (str/split #",")
        last
        str/trim
        not-empty)))

(defn avatar-url [profile-path]
  (when (and profile-path (not (str/blank? profile-path)))
    (str "https://image.tmdb.org/t/p/w500" profile-path)))

(defn build-actor [pid p]
  (let [base {:euuid (det-uuid "actor" pid) :name (:name p)}
        birth (parse-year (:birthday p))
        death (parse-year (:deathday p))
        place (when-not (str/blank? (:place_of_birth p)) (:place_of_birth p))
        nationality (parse-nationality place)
        avatar (avatar-url (:profile_path p))
        gender (tmdb-gender->enum (or (:gender p) 0) "Unknown")
        popularity (when (number? (:popularity p)) (:popularity p))]
    (cond-> base
      avatar      (assoc :avatar avatar)
      popularity  (assoc :popularity popularity)
      birth       (assoc :birth_year birth)
      nationality (assoc :nationality nationality)
      place       (assoc :place_of_birth place)
      gender      (assoc :gender gender)
      death       (assoc :death_year death))))

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

(defn- list-rating-shards
  "Return [<file> ...] for ratings JSON in `prep-dir`. Prefers a single
   `user_ratings.json`; falls back to sharded `user_ratings_NNNN.json`."
  [prep-dir]
  (let [single (File. (str prep-dir "/user_ratings.json"))]
    (if (.exists single)
      [single]
      (->> (.listFiles (File. ^String prep-dir))
           (filter #(re-matches #"user_ratings_\d+\.json" (.getName ^File %)))
           (sort-by #(.getName ^File %))
           vec))))

(defn top-n-movie-euuids
  "Stream every ratings shard, tallying movie rating counts (memory-bounded
   to one shard at a time)."
  [prep-dir n]
  (let [shards (list-rating-shards prep-dir)
        _ (println "  scanning" (count shards) "rating shard(s) for counts...")
        counts (reduce
                 (fn [m ^File f]
                   (reduce (fn [m r]
                             (let [e (get-in r [:movie :euuid])]
                               (assoc m e (inc (long (or (m e) 0))))))
                           m
                           (json/parse-string (slurp f) keyword)))
                 {}
                 shards)]
    (->> counts (sort-by val >) (take n) (map first) vec)))

(defn- all-movie-euuids
  "Every movie that links.csv has a TMDb id for — no rating-count pass."
  [links]
  (mapv (fn [mid] (det-uuid "movie" mid)) (keys links)))

;; ---------- Main pipeline ----------------------------------------------

(defn enrich
  "top-n is either a positive integer (top-N by rating count) or :all
   (every movie in links.csv with a TMDb id)."
  [ml-csv-dir prep-dir top-n]
  (println "Loading local data...")
  (let [all-mode?         (= :all top-n)
        links             (read-links (str ml-csv-dir "/links.csv"))
        movieid->euuid    (into {} (map (fn [mid] [mid (det-uuid "movie" mid)])) (keys links))
        euuid->movieid    (into {} (map (juxt val key)) movieid->euuid)
        candidate-euuids  (if all-mode?
                            (all-movie-euuids links)
                            (top-n-movie-euuids prep-dir top-n))
        top-with-tmdb     (keep (fn [e]
                                  (when-some [mid (euuid->movieid e)]
                                    (when-some [tmdb (links mid)]
                                      {:movie-euuid e :movieId mid :tmdb-id tmdb})))
                                candidate-euuids)]
    (println (if all-mode? "All" (str "Top " top-n))
             "movies →" (count top-with-tmdb) "have TMDb ids")

    ;; --- Fetch credits → list of (movie-euuid, [tmdb-person-id ...]) ---
    (println "\nFetching credits...")
    (let [total (count top-with-tmdb)
          progress-every (max 100 (long (/ total 100)))   ;; ≤100 progress lines
          movie->cast-ids
          (reduce
            (fn [acc {:keys [movie-euuid tmdb-id]}]
              (let [credits (fetch-credits tmdb-id)
                    cast (when credits
                           (->> (:cast credits)
                                (sort-by (fnil :order (constantly 99999)))
                                (filter #(= "Acting" (:known_for_department %)))
                                (take CAST-CAP)
                                (map :id)
                                vec))]
                (when (zero? (mod (inc (count acc)) progress-every))
                  (println (str "  " (inc (count acc)) "/" total)))
                (if cast
                  (assoc acc movie-euuid cast)
                  acc)))
            {}
            top-with-tmdb)
          unique-actors (->> movie->cast-ids vals (mapcat identity) distinct vec)]
      (println "Movies with cast:" (count movie->cast-ids) "— unique actors:" (count unique-actors))

      ;; --- Fetch person records ---
      (println "\nFetching person records...")
      (let [a-total (count unique-actors)
            a-progress (max 200 (long (/ a-total 100)))
            actor-data
            (reduce
              (fn [acc i]
                (let [pid (nth unique-actors i)
                      p (fetch-person pid)]
                  (when (zero? (mod (inc i) a-progress))
                    (println (str "  " (inc i) "/" a-total)))
                  (assoc acc pid (when p (build-actor pid p)))))
              {}
              (range (count unique-actors)))

            ;; --- Emit actors (drop nil/blank names) ---
            actors-out (->> unique-actors
                            (keep (fn [pid]
                                    (let [a (actor-data pid)]
                                      (when (and a (:name a) (not (str/blank? (:name a))))
                                        a)))))

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
    (println "Usage: bb enrich_tmdb.bb <ml-csv-dir> <prep-dir> [top-n|all]")
    (System/exit 2))
  (let [arg (or top-n "200")
        parsed (if (= "all" (str/lower-case arg))
                 :all
                 (Integer/parseInt arg))]
    (enrich ml-csv-dir prep-dir parsed)))

(apply -main *command-line-args*)
