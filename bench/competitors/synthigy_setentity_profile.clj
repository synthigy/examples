;; Deep profiler — wraps every stage of `set-entity` with timing probes via
;; alter-var-root and runs the user_rating phase pre-loaded (no harness
;; overhead). Surfaces which stage dominates so we can find what made the
;; rating-write path ~2× slower than the 2026-05-20 "post-fix 8.20 s"
;; measurement.
;;
;; Usage:
;;   (load-file ".../synthigy_setentity_profile.clj")
;;   (synthigy-bench.setentity-profile/run!)
;;
;; Reports per-stage call count, total ms, per-call µs across the full
;; 100,836-row rating phase at batch=1000 (so 101 set-entity invocations).

(ns synthigy-bench.setentity-profile
  (:require [synthigy.dataset :as dataset]
            [synthigy.dataset.sql.query :as sq]
            [synthigy.dataset.id :as id]
            [jsonista.core :as j]
            [clojure.walk :as walk]))

(def DATA "/home/rgersak/dev/synthigy/examples/datasets/movies/movies/")
(def ENTITY-RATING "9H1gEBp1Jzv55tTtVjBNhJ")
(def ENTITY-MOVIE  "CuquTMuTdnWZUP6GxurJqM")
(def ENTITY-GENRE  "FHjMsfeB3c38CpgRoper49")

(def stats (atom {}))
(def originals (atom {}))

(defn- record! [stage nanos]
  (swap! stats update stage
         (fn [s] (-> (or s {:calls 0 :nanos 0})
                     (update :calls inc)
                     (update :nanos + nanos)))))

(defn- timer [stage f]
  (fn [& args]
    (let [t0 (System/nanoTime)
          r  (apply f args)]
      (record! stage (- (System/nanoTime) t0))
      r)))

(defn install! []
  (when (seq @originals)
    (throw (ex-info "Probes already installed; call uninstall! first." {})))
  (reset! stats {})
  ;; Capture originals then wrap. Each stage is a top-level defn in
  ;; synthigy.dataset.sql.query — same shape as the 2026-05-20 profiling.
  (let [fns [:analyze-data :prepare-references :enhance-write
             :store-entity-records :project-saved-entities
             :link-relations :sync-entity]
        get-var (fn [k]
                  (case k
                    :analyze-data           #'sq/analyze-data
                    :prepare-references     #'sq/prepare-references
                    :enhance-write          #'sq/enhance-write
                    :store-entity-records   #'sq/store-entity-records
                    :project-saved-entities #'sq/project-saved-entities
                    :link-relations         #'sq/link-relations
                    :sync-entity            #'dataset/sync-entity))]
    (doseq [k fns]
      (let [v (get-var k)
            orig (var-get v)]
        (swap! originals assoc k orig)
        (alter-var-root v (constantly (timer k orig))))))
  :installed)

(defn uninstall! []
  (let [orig @originals]
    (doseq [[k f] orig]
      (let [v (case k
                :analyze-data           #'sq/analyze-data
                :prepare-references     #'sq/prepare-references
                :enhance-write          #'sq/enhance-write
                :store-entity-records   #'sq/store-entity-records
                :project-saved-entities #'sq/project-saved-entities
                :link-relations         #'sq/link-relations
                :sync-entity            #'dataset/sync-entity)]
        (alter-var-root v (constantly f))))
    (reset! originals {}))
  :uninstalled)

(defn- ->xid [s] (id/uuid->nanoid (java.util.UUID/fromString s)))
(defn- euuid->xid [m]
  (walk/postwalk
   (fn [x] (if (and (map? x) (:euuid x))
             (-> x (assoc :xid (->xid (:euuid x))) (dissoc :euuid))
             x))
   m))
(defn- read-json [p] (j/read-value (slurp p) j/keyword-keys-object-mapper))

(defn preload! []
  (let [genres (mapv #(select-keys % [:xid :name])
                     (euuid->xid (read-json (str DATA "movie_genres.json"))))
        movies (mapv #(select-keys % [:xid :title :release_year])
                     (euuid->xid (read-json (str DATA "movies.json"))))
        ratings (mapv #(select-keys (euuid->xid %) [:xid :value :timestamp :movie])
                      (read-json (str DATA "user_ratings.json")))]
    {:genres genres :movies movies :ratings ratings}))

(defn- report! []
  (let [order [:sync-entity :analyze-data :prepare-references :enhance-write
               :store-entity-records :project-saved-entities :link-relations
               :publish-delta]
        s @stats
        sync-ms (double (* (get-in s [:sync-entity :nanos] 0) 1e-6))]
    (printf "%n  %-24s %8s  %12s  %14s  %7s%n"
            "stage" "calls" "total ms" "per-call us" "% of sync")
    (printf "  %s%n" (apply str (repeat 76 \-)))
    (doseq [k order]
      (let [{:keys [calls nanos]} (get s k {:calls 0 :nanos 0})
            ms (double (* nanos 1e-6))
            us (if (zero? calls) 0.0 (* (/ ms calls) 1000.0))
            pct (if (zero? sync-ms) 0.0 (* 100.0 (/ ms sync-ms)))]
        (printf "  %-24s %8d  %12.1f  %14.1f  %5.1f%%%n"
                (name k) calls ms us pct)))
    (flush)))

(defn run!
  ([] (run! 1000))
  ([batch]
   (println "Pre-loading dataset...")
   (let [data (preload!)]
     (println "  loaded\n")
     ;; Pre-seed genres + movies WITHOUT probes (would pollute stats)
     (println "Pre-seeding genres + movies (probes off)...")
     (uninstall!)
     (reset! stats {})
     (doseq [b (partition-all 1000 (:genres data))]
       (dataset/sync-entity ENTITY-GENRE (vec b)))
     (doseq [b (partition-all 1000 (:movies data))]
       (dataset/sync-entity ENTITY-MOVIE (vec b)))
     (install!)
     (println "  done; probes re-installed.\n")
     (println "Timed: user_rating sync at batch=" batch)
     (let [t0 (System/nanoTime)
           rs (:ratings data)
           n (count rs)]
       (doseq [b (partition-all batch rs)]
         (dataset/sync-entity ENTITY-RATING (vec b)))
       (let [secs (/ (- (System/nanoTime) t0) 1e9)]
         (printf "  user_rating: %d rows  %.2fs  %d rec/s%n%n"
                 n secs (long (/ n secs)))))
     (report!)
     (uninstall!)
     :done)))
