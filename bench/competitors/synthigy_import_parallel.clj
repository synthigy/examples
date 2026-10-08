;; Synthigy parallel import harness — MovieLens via dataset/sync-entity, with
;; the dominant user_rating + user_tag phases run across N worker threads.
;;
;;   (load-file ".../synthigy_import_parallel.clj")
;;   (synthigy-bench.import-parallel/run! {:batch 1000 :workers 8})
;;
;; Small entities (genres, actors, movies, mappings) stay serial — they're
;; <2s combined and parallelizing would just add overhead. The streaming
;; user_rating + user_tag phases split their row list into N approximately
;; equal chunks; each chunk goes to a future that runs sync-entity in
;; `batch`-sized sub-batches sequentially within the worker.
;;
;; Requires the parallel-batched fixes shipped 2026-05-20 (memory:
;; project-parallel-write-anti-scaling): store-entity-records' identity-only
;; classifier + with-write-retry on 40P01/40001.

(ns synthigy-bench.import-parallel
  (:require [synthigy.dataset :as dataset]
            [synthigy.dataset.id :as id]
            [jsonista.core :as j]
            [clojure.walk :as walk])
  (:import [java.io File]))

(def ^:dynamic *data-dir*
  (str "/home/rgersak/dev/synthigy/examples/datasets/movies/"
       (or (System/getenv "MOVIES_DATASET") "movies") "/"))

(defn- data-dir [] *data-dir*)

(def ENTITY
  {:genre "FHjMsfeB3c38CpgRoper49"
   :actor "WwVbcZzGnKjJaKtdWiAqmw"
   :movie "CuquTMuTdnWZUP6GxurJqM"
   :rating "9H1gEBp1Jzv55tTtVjBNhJ"
   :tag   "DYmymKZXjoYuLguora8Yp2"})

(defn- ->xid [s] (id/uuid->nanoid (java.util.UUID/fromString s)))

(defn- euuid->xid [m]
  (walk/postwalk
   (fn [x] (if (and (map? x) (:euuid x))
             (-> x (assoc :xid (->xid (:euuid x))) (dissoc :euuid))
             x))
   m))

(defn- read-json [^File f]
  (j/read-value (slurp f) j/keyword-keys-object-mapper))

(defn- list-shards [base]
  (let [re (re-pattern (str base "_\\d+\\.json"))]
    (->> (.listFiles (File. ^String (data-dir)))
         (filter #(re-matches re (.getName ^File %)))
         (sort-by #(.getName ^File %))
         vec)))

(defn- shard-files [base]
  (let [single (File. (str (data-dir) base ".json"))]
    (if (.exists single)
      [single]
      (let [shards (list-shards base)]
        (when (empty? shards)
          (throw (ex-info (str "No " base ".json or " base "_NNNN.json in " (data-dir)) {})))
        shards))))

(defn- load-collection [base]
  (euuid->xid (vec (mapcat read-json (shard-files base)))))

(defn load-small []
  (let [genres  (mapv #(select-keys % [:xid :name]) (load-collection "movie_genres"))
        actors-raw (load-collection "movie_actors")
        by-name (reduce (fn [m a] (if (m (:name a)) m (assoc m (:name a) a)))
                        {} actors-raw)
        remap   (into {} (for [a actors-raw
                               :let [k (get-in by-name [(:name a) :xid])]
                               :when (not= k (:xid a))]
                           [(:xid a) k]))
        rmx     (fn [x] (get remap x x))
        actors  (mapv #(select-keys % [:xid :name :birth_year :nationality])
                      (vals by-name))
        movies  (mapv #(select-keys % [:xid :title :release_year])
                      (load-collection "movies"))
        genre-map (mapv #(select-keys % [:xid :movies])
                        (load-collection "movie_genres_mapping"))
        actor-map (->> (load-collection "movie_actors_mapping")
                       (map (fn [a] {:xid (rmx (:xid a)) :movies (:movies a)}))
                       (group-by :xid)
                       (mapv (fn [[xid es]]
                               {:xid xid
                                :movies (vec (distinct (mapcat :movies es)))})))]
    {:genre genres :actor actors :movie movies
     :genre-map genre-map :actor-map actor-map}))

(defn- links-count [recs] (reduce + (map #(count (:movies %)) recs)))

;; ---------- Parallel sync over a row list -------------------------------

(defn- parallel-sync!
  "Split `rows` into `workers` chunks of contiguous rows. Each chunk runs
   on its own future, sequentially firing sync-entity in `batch`-sized
   sub-batches. Returns {:rows :secs :workers}.

   Note: chunks are contiguous, not interleaved — keeps related rows on
   the same worker, which reduces cross-worker contention on parent rows
   (movies are pre-seeded so this matters less, but it's still a freebie)."
  [{:keys [entity-xid rows batch workers phase-label]}]
  (let [n-rows (count rows)
        chunk-size (max 1 (long (Math/ceil (/ n-rows (double workers)))))
        chunks (vec (partition-all chunk-size rows))
        actual-workers (count chunks)
        t0 (System/nanoTime)
        futures (mapv
                  (fn [chunk]
                    (future
                      (doseq [b (partition-all batch chunk)]
                        (dataset/sync-entity entity-xid (vec b)))
                      (count chunk)))
                  chunks)
        per-worker (mapv deref futures)
        secs (/ (- (System/nanoTime) t0) 1e9)
        n (reduce + per-worker)]
    (printf "  %-22s %9d rows  %2d workers  %8.2fs  %12.0f rec/s%n"
            phase-label n actual-workers secs (if (zero? secs) 0 (/ n secs)))
    (flush)
    {:rows n :secs secs :workers actual-workers}))

(defn- stream-parallel-sync!
  "Parallel version of stream-sync-shards!: read each shard fully, then
   parallel-sync across workers, then drop the shard before reading the
   next. Heap stays bounded; only one shard's worth of rows is materialized
   at a time."
  [{:keys [base entity-xid keep-keys batch workers max-shards phase-label]}]
  (let [all-files (shard-files base)
        files (if max-shards (vec (take max-shards all-files)) all-files)
        total-shards (count files)
        t0 (System/nanoTime)
        rows-total (atom 0)]
    (doseq [[i ^File f] (map-indexed vector files)]
      (let [data (->> (read-json f)
                      (mapv #(select-keys (euuid->xid %) keep-keys)))
            n (count data)
            shard-result (parallel-sync!
                           {:entity-xid entity-xid
                            :rows data
                            :batch batch
                            :workers workers
                            :phase-label (format "  shard %d/%d" (inc i) total-shards)})]
        (swap! rows-total + n)))
    {:rows @rows-total
     :secs (/ (- (System/nanoTime) t0) 1e9)
     :shards total-shards}))

;; ---------- Public entry point ------------------------------------------

(defn run!
  "Parallel timed import. Opts:
     :batch              batch size for sync-entity (default 1000)
     :workers            parallel worker count for user_rating + user_tag (default 8)
     :dataset            override dataset dir name (e.g. \"movies-25m\")
     :max-rating-shards  limit rating shards to first N (default: all)
     :max-tag-shards     limit tag shards to first N (default: all)
   Returns {:phases [...] :total secs :rows n :workers w}."
  [{:keys [batch workers dataset max-rating-shards max-tag-shards]
    :or   {batch 1000 workers 8}}]
  (when dataset
    (alter-var-root #'*data-dir*
      (constantly (str "/home/rgersak/dev/synthigy/examples/datasets/movies/" dataset "/"))))
  (println (format "%nSynthigy parallel import — dir=%s  batch=%d  workers=%d%s%s%n"
                   (data-dir) batch workers
                   (if max-rating-shards (str "  rating-shards≤" max-rating-shards) "")
                   (if max-tag-shards (str "  tag-shards≤" max-tag-shards) "")))
  (let [t0 (System/nanoTime)
        _ (println "Loading small entities (serial, in-process)...")
        small (load-small)
        small-phases
        [[:movie_genre        :genre  (:genre small)     (count (:genre small))]
         [:movie_actor        :actor  (:actor small)     (count (:actor small))]
         [:movie              :movie  (:movie small)     (count (:movie small))]
         [:movie_genre_mapping :genre (:genre-map small) (links-count (:genre-map small))]
         [:movie_actor_mapping :actor (:actor-map small) (links-count (:actor-map small))]]
        small-results
        (vec (for [[phase ekey rows rcount] small-phases]
               (let [eid (ENTITY ekey)
                     p0 (System/nanoTime)]
                 (doseq [b (partition-all batch rows)]
                   (dataset/sync-entity eid (vec b)))
                 (let [secs (/ (- (System/nanoTime) p0) 1e9)]
                   (printf "  %-22s %9d rows  %8.2fs  %12.0f rec/s%n"
                           (name phase) rcount secs (if (zero? secs) 0 (/ rcount secs)))
                   (flush)
                   {:phase phase :rows rcount :secs secs}))))
        _ (println (format "%nUser_rating shards across %d workers..." workers))
        rating-result (stream-parallel-sync!
                        {:base "user_ratings"
                         :entity-xid (ENTITY :rating)
                         :keep-keys [:xid :value :timestamp :movie]
                         :batch batch
                         :workers workers
                         :max-shards max-rating-shards
                         :phase-label "rating"})
        _ (printf "  %-22s %9d rows  %8.2fs  %12.0f rec/s  (%d shards)%n"
                  "user_rating" (:rows rating-result) (:secs rating-result)
                  (if (zero? (:secs rating-result)) 0 (/ (:rows rating-result) (:secs rating-result)))
                  (:shards rating-result))
        _ (println (format "%nUser_tag shards across %d workers..." workers))
        tag-result (stream-parallel-sync!
                     {:base "user_tags"
                      :entity-xid (ENTITY :tag)
                      :keep-keys [:xid :value :timestamp :movie]
                      :batch batch
                      :workers workers
                      :max-shards max-tag-shards
                      :phase-label "tag"})
        _ (printf "  %-22s %9d rows  %8.2fs  %12.0f rec/s  (%d shards)%n"
                  "user_tag" (:rows tag-result) (:secs tag-result)
                  (if (zero? (:secs tag-result)) 0 (/ (:rows tag-result) (:secs tag-result)))
                  (:shards tag-result))
        large-results [{:phase :user_rating :rows (:rows rating-result) :secs (:secs rating-result)}
                       {:phase :user_tag    :rows (:rows tag-result)    :secs (:secs tag-result)}]
        all-results (into small-results large-results)
        total (/ (- (System/nanoTime) t0) 1e9)
        n (reduce + (map :rows all-results))]
    (println "  " (apply str (repeat 70 \-)))
    (printf "  %-22s %9d rows  %8.2fs  %12.0f rec/s  (workers=%d)%n"
            "TOTAL — Synthigy" n total (if (zero? total) 0 (/ n total)) workers)
    (flush)
    {:phases all-results :total total :rows n :workers workers}))
