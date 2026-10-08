;; Server-side timing probes for the write-path PIPELINE inside sync-entity
;; (synthigy.dataset.sql.query/set-entity's letfn stages), one level deeper
;; than synthigy_profile.clj's top-level parse/exec/sync/transform/format
;; split. Same alter-var-root technique — no code edit, no recompile.
;;
;; Stages (in pipeline order):
;;   :analyze-data              :resolve-one-satellites  :prepare-references
;;   :enhance-write             :store-entity-records     :project-saved-entities
;;   :link-relations
;;
;; Usage from a Synthigy nREPL with bare-server up:
;;   (load-file ".../competitors/synthigy_stage_profile.clj")
;;   (synthigy-bench.stage-profile/install!)
;;   ;; (run the import via the JS harness)
;;   (synthigy-bench.stage-profile/report!)
;;   (synthigy-bench.stage-profile/uninstall!)

(ns synthigy-bench.stage-profile
  (:require [synthigy.dataset.sql.query :as q]))

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

(defn reset-stats! [] (reset! stats {}))

(def ^:private stage-vars
  [[:analyze-data             #'q/analyze-data]
   [:resolve-one-satellites   #'q/resolve-one-satellites]
   [:prepare-references       #'q/prepare-references]
   [:enhance-write            #'q/enhance-write]
   [:store-entity-records     #'q/store-entity-records]
   [:project-saved-entities   #'q/project-saved-entities]
   [:link-relations           #'q/link-relations]])

(defn install! []
  (when (seq @originals)
    (throw (ex-info "Probes already installed — call uninstall! first." {})))
  (reset-stats!)
  (reset! originals (into {} (map (fn [[k v]] [k (var-get v)])) stage-vars))
  (doseq [[k v] stage-vars]
    (alter-var-root v (constantly (timer k (get @originals k)))))
  :installed)

(defn uninstall! []
  (when-let [orig (and (seq @originals) @originals)]
    (doseq [[k v] stage-vars]
      (alter-var-root v (constantly (get orig k))))
    (reset! originals {}))
  :uninstalled)

(defn report! []
  (let [order (mapv first stage-vars)
        total-ns (reduce + (map (comp :nanos #(get @stats % {:nanos 0})) order))]
    (printf "%n  %-24s %8s  %12s  %8s%n" "stage" "calls" "total ms" "share")
    (printf "  %s%n" (apply str (repeat 64 \-)))
    (doseq [k order]
      (let [{:keys [calls nanos]} (get @stats k {:calls 0 :nanos 0})
            ms (* nanos 1e-6)]
        (printf "  %-24s %8d  %12.1f  %7.1f%%%n"
                (name k) calls ms (if (pos? total-ns) (* 100.0 (/ nanos total-ns)) 0.0))))
    (printf "  %s%n" (apply str (repeat 64 \-)))
    (printf "  %-24s %8s  %12.1f  100.0%%%n" "TOTAL (sum of stages)" "" (* total-ns 1e-6))
    (flush)
    @stats))
