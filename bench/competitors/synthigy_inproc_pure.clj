;; Pure in-process sync-entity microbench — no read-json, no postwalk, no
;; select-keys inside the timer. Pre-loads + pre-converts the dataset
;; into REPL memory, then times ONLY the sync-entity batch loop. If this
;; lands close to the HTTP bare-server figure, the in-process "regression"
;; is harness pre-processing overhead, not a code-path regression.
;;
;; Usage (from a Synthigy nREPL on bench-postgres/synthigy with the
;; Movies model deployed):
;;   (load-file ".../synthigy_inproc_pure.clj")
;;   (synthigy-bench.pure/run!)

(ns synthigy-bench.pure
  (:require [synthigy.dataset :as dataset]
            [synthigy.dataset.id :as id]
            [synthigy.db :as db]
            [next.jdbc :as jdbc]
            [jsonista.core :as j]
            [clojure.walk :as walk]))

(def DATA "/home/rgersak/dev/synthigy/examples/datasets/movies/movies/")
(def ENTITY-RATING "9H1gEBp1Jzv55tTtVjBNhJ")
(def ENTITY-MOVIE  "CuquTMuTdnWZUP6GxurJqM")
(def ENTITY-GENRE  "FHjMsfeB3c38CpgRoper49")

(defn- ->xid [s] (id/uuid->nanoid (java.util.UUID/fromString s)))

(defn- euuid->xid [m]
  (walk/postwalk
   (fn [x] (if (and (map? x) (:euuid x))
             (-> x (assoc :xid (->xid (:euuid x))) (dissoc :euuid))
             x))
   m))

(defn- read-json [p]
  (j/read-value (slurp p) j/keyword-keys-object-mapper))

(defn preload!
  "Returns {:genres :movies :ratings} fully reshaped, ready for sync-entity."
  []
  (let [t0 (System/nanoTime)
        genres (mapv #(select-keys % [:xid :name])
                     (euuid->xid (read-json (str DATA "movie_genres.json"))))
        movies (mapv #(select-keys % [:xid :title :release_year])
                     (euuid->xid (read-json (str DATA "movies.json"))))
        ratings (mapv #(select-keys (euuid->xid %) [:xid :value :timestamp :movie])
                      (read-json (str DATA "user_ratings.json")))
        secs (/ (- (System/nanoTime) t0) 1e9)]
    (printf "preload (read+postwalk+select-keys): %.2fs  (%d ratings)%n"
            secs (count ratings))
    {:genres genres :movies movies :ratings ratings}))

(defn sync-batched!
  "Time only the sync-entity loop. No reads, no walks, nothing else."
  [entity-xid rows batch]
  (let [t0 (System/nanoTime)
        n  (count rows)]
    (doseq [b (partition-all batch rows)]
      (dataset/sync-entity entity-xid (vec b)))
    (let [secs (/ (- (System/nanoTime) t0) 1e9)]
      {:rows n :secs secs :rec-s (long (/ n secs))})))

(defn run!
  "Pre-seed genres + movies, then run a clean ratings-only sync timing."
  ([] (run! 1000))
  ([batch]
   (let [data (preload!)]
     (println "\n--- Pre-seeding genres + movies (not timed) ---")
     (sync-batched! ENTITY-GENRE (:genres data) batch)
     (sync-batched! ENTITY-MOVIE (:movies data) batch)
     (println "\n--- Timed: user_rating sync-entity loop only ---")
     (let [r (sync-batched! ENTITY-RATING (:ratings data) batch)]
       (printf "user_rating: %d rows  %.2fs  %d rec/s%n"
               (:rows r) (:secs r) (:rec-s r))
       r))))

(defn sweep!
  "Pre-seed once, then run the user_rating phase at multiple batch sizes
   so we can see how throughput scales with chunk size. Each run hits a
   freshly-truncated rating table to keep the workload identical."
  ([] (sweep! [1000 5000 10000 25000 50000 100836]))
  ([batches]
   (let [data (preload!)]
     (println "\n--- Pre-seeding genres + movies (not timed) ---")
     (sync-batched! ENTITY-GENRE (:genres data) 1000)
     (sync-batched! ENTITY-MOVIE (:movies data) 1000)
     (println "\n--- Batch-size sweep on user_rating ---")
     (printf "  %-10s %12s %12s%n" "batch" "secs" "rec/s")
     (printf "  %s%n" (apply str (repeat 40 \-)))
     (vec
      (for [b batches]
        (do
          (jdbc/execute! db/*db*
            ["TRUNCATE user_rating, \"user_rati_19gqxz9i4AxhVSqJ2qYe92_movi\" CASCADE"])
          (let [r (sync-batched! ENTITY-RATING (:ratings data) b)]
            (printf "  %-10d %12.2f %12d%n" b (:secs r) (:rec-s r))
            (assoc r :batch b))))))))

(defn one-shot!
  "Single sync-entity call with ALL 100,836 ratings — Synthigy's
   design-target chunk size. No partitioning, no loop."
  []
  (let [data (preload!)]
    (println "\n--- Pre-seeding genres + movies (not timed) ---")
    (sync-batched! ENTITY-GENRE (:genres data) 1000)
    (sync-batched! ENTITY-MOVIE (:movies data) 1000)
    (println "\n--- One-shot: 100,836 ratings in ONE sync-entity call ---")
    (let [rows (:ratings data)
          n (count rows)
          t0 (System/nanoTime)
          _ (dataset/sync-entity ENTITY-RATING rows)
          secs (/ (- (System/nanoTime) t0) 1e9)]
      (printf "user_rating: %d rows  %.2fs  %d rec/s%n"
              n secs (long (/ n secs)))
      {:rows n :secs secs :rec-s (long (/ n secs))})))

(defn no-triggers!
  "Bench user_rating with ALL user triggers on rating + junction tables
   DISABLED — isolates the cost of the audit-enqueue + xid-guard +
   modified_on triggers that deploy installs regardless of whether
   :synthigy/audit is running."
  ([] (no-triggers! 1000))
  ([batch]
   (let [data (preload!)
         junction "user_rati_19gqxz9i4AxhVSqJ2qYe92_movi"]
     (println "\n--- Pre-seeding genres + movies ---")
     (sync-batched! ENTITY-GENRE (:genres data) 1000)
     (sync-batched! ENTITY-MOVIE (:movies data) 1000)
     (println "\n--- Disabling user triggers on rating + junction tables ---")
     (jdbc/execute! db/*db* ["ALTER TABLE user_rating DISABLE TRIGGER USER"])
     (jdbc/execute! db/*db* [(str "ALTER TABLE \"" junction "\" DISABLE TRIGGER USER")])
     (println "\n--- Timed: user_rating sync-entity (no triggers) ---")
     (let [r (sync-batched! ENTITY-RATING (:ratings data) batch)]
       (printf "user_rating: %d rows  %.2fs  %d rec/s%n"
               (:rows r) (:secs r) (:rec-s r))
       (println "\n--- Re-enabling triggers ---")
       (jdbc/execute! db/*db* ["ALTER TABLE user_rating ENABLE TRIGGER USER"])
       (jdbc/execute! db/*db* [(str "ALTER TABLE \"" junction "\" ENABLE TRIGGER USER")])
       r))))
