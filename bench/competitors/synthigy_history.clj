;; /history read latency against whatever audit provider is bound, on data a
;; write bench imported. Samples records from the provider's own events.
;;
;;   (load-file ".../synthigy_history.clj")
;;   (synthigy-bench.history/run! {:n 1000})

(ns synthigy-bench.history
  (:require [synthigy.audit :as audit]))

(defn percentiles [xs]
  (let [s (vec (sort xs)) n (count s)
        at (fn [p] (s (min (dec n) (long (* p n)))))]
    {:p50 (at 0.5) :p95 (at 0.95) :p99 (at 0.99) :max (peek s)}))

(defn timed [f]
  (let [t (System/nanoTime)] (f) (/ (- (System/nanoTime) t) 1e6)))

(defn run! [{:keys [n] :or {n 1000}}]
  (let [p       audit/*audit-provider*
        now     (str (java.time.Instant/now))
        from    (str (.minusSeconds (java.time.Instant/now) (* 30 86400)))
        sample  (->> (audit/since p {:seq 0 :limit 200000})
                     (map (juxt :record-xid :tenant-xid :seq))
                     distinct shuffle (take n) vec)
        max-seq (reduce max 0 (map peek sample))
        ops     {:get-at   (fn [[r t]] (audit/get-at p {:record-xid r :at now :tenant t}))
                 :events   (fn [[r t]] (audit/events p {:record-xid r :between [from now] :tenant t :limit 100}))
                 :diff     (fn [[r t]] (audit/diff p {:record-xid r :from-ts from :to-ts now :tenant t}))
                 :since    (fn [[_ t]] (audit/since p {:seq (rand-int max-seq) :tenant t :limit 1000}))
                 :relation (fn [[r t]] (audit/events p {:track :relation :record-xid r :between [from now] :tenant t :limit 100}))}]
    (doseq [[_ f] ops x (take 50 sample)] (f x))
    {:provider (some-> p class .getSimpleName)
     :sampled  (count sample)
     :ms       (into (sorted-map)
                     (for [[k f] ops] [k (percentiles (mapv #(timed (fn [] (f %))) sample))]))}))
