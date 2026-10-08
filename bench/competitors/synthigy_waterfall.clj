;; Synthigy e2e write-path waterfall profiler — REUSABLE ACROSS SESSIONS.
;;
;; Wraps the /data write pipeline vars with timing probes and prints a
;; call-tree "waterfall": wall ms, % of engine/execute, CPU ms and
;; cpu/wall per stage. cpu/wall ~ 1 -> the JVM is busy the whole time
;; (in-process work); << 1 -> the JVM is idle waiting on Postgres
;; (JDBC is synchronous, so DB time shows as wall without CPU); > 1 ->
;; parallel JVM activity (GC/JIT) on top of the stage.
;;
;; Driven by run_synthigy_waterfall.sh, or by hand on any REPL with
;; :synthigy/bare-server up:
;;
;;   (load-file ".../competitors/synthigy_waterfall.clj")
;;   (synthigy-bench.waterfall/install!)
;;   ;; drive load: node competitors/synthigy_http.mjs
;;   (synthigy-bench.waterfall/report!)
;;   (synthigy-bench.waterfall/uninstall!)
;;
;; Probes count only the OUTERMOST call per thread — self-recursive fns
;; (analyze-data calls itself through its var) would otherwise double-count,
;; which burned a debug cycle in the 2026-08-27 session.
;;
;; CPU is PROCESS CPU delta, not thread CPU: http-kit 2.8 on JDK 21+ runs
;; handlers on VIRTUAL threads, where ThreadMXBean/getCurrentThreadCpuTime
;; returns -1. Process delta is attributable because the import harness is
;; strictly sequential (one request in flight, one stage active at a time)
;; and it honestly charges a stage for the GC/JIT it causes. Under
;; concurrent load the cpu column is NOT attributable — ignore it there.

(ns synthigy-bench.waterfall
  (:require [synthigy.server.data]
            [synthigy.engine]
            [synthigy.dataset]
            [synthigy.dataset.sql.query]
            [synthigy.dataset.postgres.fused])
  (:import [java.lang.management ManagementFactory]))

;; [indent label var] — pipeline order; indent = call-tree depth, used both
;; for display and to compute each parent's self/unaccounted time.
(def PROBES
  [[0 "parse-request-body"     #'synthigy.server.data/parse-request-body]
   [0 "engine/execute"         #'synthigy.engine/execute]
   [1 "dataset/sync-entity"    #'synthigy.dataset/sync-entity]
   [2 "set-entity"             #'synthigy.dataset.sql.query/set-entity]
   [3 "analyze-data"           #'synthigy.dataset.sql.query/analyze-data]
   [3 "resolve-one-satellites" #'synthigy.dataset.sql.query/resolve-one-satellites]
   [3 "prepare-references"     #'synthigy.dataset.sql.query/prepare-references]
   [3 "enhance-write"          #'synthigy.dataset.sql.query/enhance-write]
   [3 "store-entity-records"   #'synthigy.dataset.sql.query/store-entity-records]
   [3 "project-saved-entities" #'synthigy.dataset.sql.query/project-saved-entities]
   [3 "link-relations"         #'synthigy.dataset.sql.query/link-relations]
   [4 "delete-by-from-side!"   #'synthigy.dataset.sql.query/delete-by-from-side!]
   [4 "execute-multi-row!"     #'synthigy.dataset.sql.query/execute-multi-row!]
   [1 "transform-results"      #'synthigy.engine/transform-results]
   [0 "format-response"        #'synthigy.server.data/format-response]])

;; Read path (in-process via dataset/search-entity — no HTTP framing).
;; parse-json / coerce-node are per-row-scale: probe overhead (a JMX call
;; per invocation) distorts them on bulk reads — micro-time those by hand.
(def READ-PROBES
  [[0 "dataset/search-entity"  #'synthigy.dataset/search-entity]
   [1 "fused/search"           #'synthigy.dataset.postgres.fused/search]
   [2 "expand-tree"            #'synthigy.dataset.postgres.fused/expand-tree]
   [0 "engine/transform-results" #'synthigy.engine/transform-results]])

(def stats (atom {}))
(def originals (atom nil))
(def window (atom nil))
(def active-probes (atom nil))

(defn process-cpu-ns []
  (let [os (ManagementFactory/getOperatingSystemMXBean)]
    (if (instance? com.sun.management.OperatingSystemMXBean os)
      (.getProcessCpuTime ^com.sun.management.OperatingSystemMXBean os)
      0)))

(defn wrap [label f]
  (let [depth (proxy [ThreadLocal] [] (initialValue [] (int 0)))]
    (fn [& args]
      (if (pos? (int (.get depth)))
        (apply f args)
        (do (.set depth (int 1))
            (let [w0 (System/nanoTime)
                  c0 (process-cpu-ns)]
              (try (apply f args)
                   (finally
                     (.set depth (int 0))
                     (let [w (- (System/nanoTime) w0)
                           c (- (process-cpu-ns) c0)]
                       (swap! stats update label
                              (fn [{:keys [calls wall cpu]
                                    :or {calls 0 wall 0 cpu 0}}]
                                {:calls (inc calls)
                                 :wall (+ wall w)
                                 :cpu (+ cpu c)})))))))))))

(defn reset-stats! []
  (reset! stats {})
  (reset! window {:wall (System/nanoTime) :pcpu (process-cpu-ns)})
  :reset)

(defn install!
  ([] (install! PROBES))
  ([probes]
   (when @originals
     (throw (ex-info "waterfall probes already installed" {})))
   (reset! active-probes probes)
   (reset! originals (into {} (for [[_ _ v] probes] [v @v])))
   (doseq [[_ label v] probes]
     (alter-var-root v (fn [f] (wrap label f))))
   (reset-stats!)
   (str "installed " (count probes) " probes")))

(defn uninstall! []
  (doseq [[v f] @originals]
    (alter-var-root v (constantly f)))
  (reset! originals nil)
  :uninstalled)

(defn children-wall [probes s idx]
  (let [[indent _ _] (nth probes idx)]
    (->> (drop (inc idx) probes)
         (take-while (fn [[i _ _]] (> i indent)))
         (filter (fn [[i _ _]] (= i (inc indent))))
         (keep (fn [[_ label _]] (get-in s [label :wall])))
         (reduce + 0))))

(defn report! []
  (let [s @stats
        probes @active-probes
        anchor (->> probes
                    (keep (fn [[i label _]] (when (and (zero? i) (get s label)) label)))
                    (apply max-key (fn [label] (get-in s [label :wall] 0))))
        total (max 1 (get-in s [anchor :wall] 1))
        {:keys [wall pcpu]} @window
        row (fn [indent label {:keys [calls wall cpu]} note]
              (let [ratio (if (pos? wall) (/ cpu (double wall)) 0.0)]
                (printf "%-36s %6s %9.1f %6.1f%% %9.1f %6.2f  %s%n"
                        (str (apply str (repeat indent "  ")) label)
                        (or calls "") (/ wall 1e6)
                        (* 100.0 (/ wall (double total)))
                        (/ cpu 1e6) ratio
                        (or note
                            (cond (< ratio 0.35) "DB/IO-wait"
                                  (> ratio 0.85) "JVM"
                                  :else "mixed")))))]
    (printf "%nSynthigy waterfall — %% relative to %s%n%n" anchor)
    (printf "%-36s %6s %9s %7s %9s %6s  %s%n"
            "stage" "calls" "wall ms" "%anchor" "cpu ms" "c/w" "")
    (printf "%s%n" (apply str (repeat 90 \-)))
    (doseq [[idx [indent label _]] (map-indexed vector probes)
            :let [st (get s label)]
            :when st]
      (row indent label st nil)
      (let [kids (children-wall probes s idx)]
        (when (pos? kids)
          (row (inc indent) "(self/unaccounted)"
               {:calls nil :wall (- (:wall st) kids) :cpu 0} "framework glue"))))
    (printf "%nwindow: wall %.1f s, process CPU %.1f s (all JVM threads, GC included)%n"
            (/ (- (System/nanoTime) wall) 1e9)
            (if pcpu (/ (- (process-cpu-ns) pcpu) 1e9) -1.0))
    (flush)
    :ok))
