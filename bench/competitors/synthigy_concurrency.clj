;; Synthigy read-path harness — throughput under concurrency, in-process.
;;
;; Same nested query as synthigy_search.clj / concurrency-bench.mjs, but driven
;; from inside the JVM through dataset/search-entity: no HTTP, no OAuth, so the
;; number is the engine + the database's own concurrency, nothing else. Runs
;; unchanged on any backend alias (SQLite / Postgres / CockroachDB).
;;
;;   (load-file ".../competitors/synthigy_concurrency.clj")
;;   (synthigy-bench.concurrency/run!)              ; levels [1 8 16 32 64], 3 s each
;;   (synthigy-bench.concurrency/run! {:levels [1 8] :duration-ms 2000})
;;
;; Prints one row per level (req/s, p50/p95/p99 ms, errors) and writes OUT.

(ns synthigy-bench.concurrency
  (:require [synthigy.dataset :as dataset]
            [jsonista.core :as j])
  (:import [java.util.concurrent Executors TimeUnit]))

(def OUT "/tmp/synthigy-concurrency-result.json")
(def MOVIE "CuquTMuTdnWZUP6GxurJqM")

(def ARGS {:release_year {:_gt 2000} :_order_by {:title :asc} :_limit 10})

(def SELECTION
  {:title nil
   :genres [{:selections {:name nil}}]
   :_count [{:selections {:movie_ratings [nil]}}]
   :_agg  [{:selections {:movie_ratings [{:selections {:value [{:selections {:avg nil}}]}}]}}]
   :movie_ratings [{:args {:_order_by {:value :desc} :_limit 3}
                    :selections {:value nil}}]})

(defn query! [] (dataset/search-entity MOVIE ARGS SELECTION))

(defn percentile [sorted p]
  (when (seq sorted)
    (nth sorted (min (dec (count sorted)) (int (* (count sorted) p))))))

(defn load-level!
  "Hammer `query!` from `n` threads for `duration-ms`; every call is timed, errors counted."
  [n duration-ms]
  (let [pool     (Executors/newFixedThreadPool (int n))
        deadline (+ (System/nanoTime) (* duration-ms 1000000))
        worker   (bound-fn []
                   (loop [lat (transient []) errs 0]
                     (if (>= (System/nanoTime) deadline)
                       {:lat (persistent! lat) :errs errs}
                       (let [t0 (System/nanoTime)
                             ok (try (query!) true (catch Throwable _ false))
                             ms (/ (- (System/nanoTime) t0) 1e6)]
                         (recur (if ok (conj! lat ms) lat) (if ok errs (inc errs)))))))
        t0       (System/nanoTime)
        results  (mapv deref (mapv (fn [_] (.submit pool ^Callable worker)) (range n)))
        wall-s   (/ (- (System/nanoTime) t0) 1e9)]
    (.shutdown pool)
    (.awaitTermination pool 10 TimeUnit/SECONDS)
    (let [lat    (sort (mapcat :lat results))
          errs   (reduce + (map :errs results))
          reqs   (count lat)]
      {:concurrency n
       :requests    reqs
       :errors      errs
       :req-per-s   (/ reqs wall-s)
       :p50         (percentile lat 0.5)
       :p95         (percentile lat 0.95)
       :p99         (percentile lat 0.99)})))

(defn run!
  ([] (run! {}))
  ([{:keys [levels duration-ms] :or {levels [1 8 16 32 64] duration-ms 3000}}]
   (dotimes [_ 20] (query!))
   (println (format "%6s %10s %9s %9s %9s %7s" "conc" "req/s" "p50 ms" "p95 ms" "p99 ms" "errors"))
   (let [rows (vec (for [n levels]
                     (let [r (load-level! n duration-ms)]
                       (println (format "%6d %10.0f %9.2f %9.2f %9.2f %7d"
                                        n (double (:req-per-s r)) (double (:p50 r))
                                        (double (:p95 r)) (double (:p99 r)) (:errors r)))
                       (flush)
                       r)))]
     (spit OUT (j/write-value-as-string {:levels rows}))
     :ok)))
