;; Drain metrics around a write harness: import wall, time until the delta
;; queues are empty, max backlog, and live-publish lag per envelope.
;;
;;   (load-file ".../synthigy_drain.clj")
;;   (synthigy-bench.drain/measure! #(synthigy-bench.import/run! {:batch 1000}))

(ns synthigy-bench.drain
  (:require [next.jdbc :as jdbc]
            [synthigy.dataset.delta :as delta]
            [synthigy.db :as db]))

(def queues ["__entity_delta_queue" "__relation_delta_queue"])

(def pending-tables ["__entity_delta_pending" "__relation_delta_pending"])

(defn depth [tables]
  (reduce + (for [q tables]
              (try (-> (jdbc/execute-one! (:datasource db/*db*) [(str "SELECT count(*) AS n FROM " q)])
                       vals first long)
                   (catch Throwable _ 0)))))

(defn queue-depth [] (depth queues))

(defn pending-depth [] (depth pending-tables))

(defn envelope-ms [env]
  (let [ts (-> env :delta :data :ts)]
    (cond
      (instance? java.util.Date ts)    (.getTime ^java.util.Date ts)
      (instance? java.time.Instant ts) (.toEpochMilli ^java.time.Instant ts)
      :else nil)))

(defrecord Recording [lags inner]
  delta/DeltaProvider
  (publish-deltas! [_ envelopes]
    (let [now (System/currentTimeMillis)]
      (swap! lags into (keep #(some->> (envelope-ms %) (- now))) envelopes))
    (delta/publish-deltas! inner envelopes))
  (reconcile-interest! [_ interests]
    (delta/reconcile-interest! inner interests)))

(defn percentile [sorted p]
  (when (seq sorted)
    (nth sorted (min (dec (count sorted)) (long (Math/floor (* p (count sorted))))))))

(defn measure!
  "Run `harness`, then wait for the drain; returns import, drain, backlog and lag figures."
  [harness]
  (let [lags     (atom [])
        backlog  (atom 0)
        sampling (atom true)
        original delta/*delta-provider*
        sampler  (future
                   (while @sampling
                     (try (swap! backlog max (queue-depth)) (catch Throwable _))
                     (Thread/sleep 100)))]
    (alter-var-root #'delta/*delta-provider* (constantly (->Recording lags original)))
    (try
      (let [t0       (System/nanoTime)
            result   (harness)
            t-import (System/nanoTime)
            _        (loop [n 0]
                       (when (and (pos? (queue-depth)) (< n 36000))
                         (Thread/sleep 100)
                         (recur (inc n))))
            t-drain  (System/nanoTime)
            _        (loop [n 0]
                       (when (and (pos? (pending-depth)) (< n 36000))
                         (Thread/sleep 100)
                         (recur (inc n))))
            t-persist (System/nanoTime)
            _        (Thread/sleep 500)
            sorted   (vec (sort @lags))]
        (reset! sampling false)
        @sampler
        {:import-s    (/ (- t-import t0) 1e9)
         :drain-s     (/ (- t-drain t-import) 1e9)
         :persist-s   (/ (- t-persist t-import) 1e9)
         :quiesce-s   (/ (- t-persist t0) 1e9)
         :backlog-max @backlog
         :published   (count sorted)
         :lag-ms      {:p50 (percentile sorted 0.50)
                       :p95 (percentile sorted 0.95)
                       :p99 (percentile sorted 0.99)
                       :max (peek sorted)}
         :harness     (select-keys result [:total :rows])})
      (finally
        (reset! sampling false)
        (alter-var-root #'delta/*delta-provider* (constantly original))))))
