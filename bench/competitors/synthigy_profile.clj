;; Server-side timing probes for the /data write path. Wraps the load-bearing
;; fns with alter-var-root so the existing import harness produces a
;; stage-level breakdown — no code edit in the server, no recompile, no
;; restart between probed and unprobed.
;;
;; 2026-08-27: execute-operations/transform-results moved from
;; synthigy.server.data to synthigy.engine since this script was written
;; (server/data.clj now only owns HTTP framing — parse/format — the
;; plane/dispatch logic lives in engine.clj as `execute`). Repointed below.
;;
;; Stages timed (nanos, per-call, summed):
;;   :parse-body       — request body JSON -> Clojure map
;;   :execute-ops      — engine/execute-operations (write dispatch + sync-entity work)
;;   :sync-entity      — pure dataset/sync-entity call (subset of :execute-ops)
;;   :transform        — engine/transform-results (selection strip + key-fmt)
;;   :format-response  — response shape -> JSON
;;
;; Usage from a Synthigy nREPL with bare-server up:
;;   (load-file ".../bench/competitors/synthigy_profile.clj")
;;   (synthigy-bench.profile/install!)
;;   ;; (run the import via the JS harness)
;;   (synthigy-bench.profile/report!)
;;   (synthigy-bench.profile/uninstall!)   ; restores original fns

(ns synthigy-bench.profile
  (:require [synthigy.server.data :as data]
            [synthigy.engine :as engine]
            [synthigy.dataset :as dataset]))

(defonce stats (atom {}))
(defonce originals (atom {}))

(defn- record! [stage nanos]
  (swap! stats update stage
         (fn [s] (-> (or s {:calls 0 :nanos 0})
                     (update :calls inc)
                     (update :nanos + nanos)))))

(defn- timer [stage f]
  (fn [& args]
    (let [t0 (System/nanoTime)
          r  (apply f args)
          dt (- (System/nanoTime) t0)]
      (record! stage dt)
      r)))

(defn reset-stats! []
  (reset! stats {}))

(defn install! []
  (when (seq @originals)
    (throw (ex-info "Probes already installed — call uninstall! first." {})))
  (reset-stats!)
  (let [orig-parse  data/parse-request-body
        orig-format data/format-response
        orig-exec   (var-get #'engine/execute-operations)
        orig-trans  (var-get #'engine/transform-results)
        orig-sync   dataset/sync-entity]
    (reset! originals
            {:parse-body      orig-parse
             :format-response orig-format
             :execute-ops     orig-exec
             :transform       orig-trans
             :sync-entity     orig-sync})
    (alter-var-root #'data/parse-request-body   (constantly (timer :parse-body orig-parse)))
    (alter-var-root #'data/format-response      (constantly (timer :format-response orig-format)))
    (alter-var-root #'engine/execute-operations (constantly (timer :execute-ops orig-exec)))
    (alter-var-root #'engine/transform-results  (constantly (timer :transform orig-trans)))
    (alter-var-root #'dataset/sync-entity       (constantly (timer :sync-entity orig-sync))))
  :installed)

(defn uninstall! []
  (when-let [orig (and (seq @originals) @originals)]
    (alter-var-root #'data/parse-request-body   (constantly (:parse-body orig)))
    (alter-var-root #'data/format-response      (constantly (:format-response orig)))
    (alter-var-root #'engine/execute-operations (constantly (:execute-ops orig)))
    (alter-var-root #'engine/transform-results  (constantly (:transform orig)))
    (alter-var-root #'dataset/sync-entity       (constantly (:sync-entity orig)))
    (reset! originals {}))
  :uninstalled)

(defn snapshot []
  (let [s @stats
        order [:parse-body :execute-ops :sync-entity :transform :format-response]]
    (mapv (fn [k]
            (let [{:keys [calls nanos]} (get s k {:calls 0 :nanos 0})
                  ms (* nanos 1e-6)]
              {:stage k
               :calls calls
               :total-ms (Math/round ms)
               :per-call-us (if (zero? calls) 0 (Math/round (* (/ ms calls) 1000)))}))
          order)))

(defn report!
  "Print the breakdown. Returns the data."
  []
  (let [rows (snapshot)
        exec-ms (some #(when (= :execute-ops (:stage %)) (:total-ms %)) rows)
        sync-ms (some #(when (= :sync-entity (:stage %)) (:total-ms %)) rows)
        framework-ms (when (and exec-ms sync-ms) (- exec-ms sync-ms))]
    (printf "%n  %-18s %8s  %12s  %14s%n" "stage" "calls" "total ms" "per-call us")
    (printf "  %s%n" (apply str (repeat 60 \-)))
    (doseq [{:keys [stage calls total-ms per-call-us]} rows]
      (printf "  %-18s %8d  %12d  %14d%n"
              (name stage) calls total-ms per-call-us))
    (when framework-ms
      (printf "  %s%n" (apply str (repeat 60 \-)))
      (printf "  %-18s            %12d   <-- :execute-ops minus :sync-entity%n"
              "framework-only" framework-ms))
    (flush)
    rows))
