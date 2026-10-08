;; Synthigy read-path harness — latency vs traversal depth, plus one bulk read.
;;
;; In-process port of depth-bench.mjs: movie -> genres -> movies -> actors,
;; order + limit 3 at every level, measured at depth 1..4 (median of N runs).
;; Bulk: 20k movies with their genres, median of 5 — the SDK-style fetch.
;; Runs unchanged on any backend alias.
;;
;;   (load-file ".../competitors/synthigy_depth.clj")
;;   (synthigy-bench.depth/run!)

(ns synthigy-bench.depth
  (:require [synthigy.dataset :as dataset]
            [jsonista.core :as j]))

(def OUT "/tmp/synthigy-depth-result.json")
(def MOVIE "CuquTMuTdnWZUP6GxurJqM")
(def N 20)

(def ARGS {:release_year {:_gt 2000} :_order_by {:title :asc} :_limit 10})

(defn rel [order sel]
  [{:args {:_order_by order :_limit 3 :_join :left} :selections sel}])

(defn selections [depth]
  (cond-> {:title nil}
    (>= depth 2)
    (assoc :genres
           (rel {:name :asc}
                (cond-> {:name nil}
                  (>= depth 3)
                  (assoc :movies
                         (rel {:title :asc}
                              (cond-> {:title nil}
                                (>= depth 4)
                                (assoc :actors (rel {:name :asc} {:name nil}))))))))))

(def BULK-ARGS {:_order_by {:title :asc} :_limit 20000})
(def BULK-SELECTION {:title nil :genres [{:selections {:name nil}}]})

(defn timed-median [f n]
  (f)
  (let [times (sort (vec (for [_ (range n)]
                           (let [t0 (System/nanoTime)]
                             (f)
                             (/ (- (System/nanoTime) t0) 1e6)))))]
    {:min (first times) :median (nth times (quot n 2)) :max (last times)}))

(defn run! []
  (println (format "%6s %10s %10s %10s" "depth" "min ms" "median ms" "max ms"))
  (let [depths (vec (for [d (range 1 5)]
                      (let [sel (selections d)
                            r   (timed-median #(dataset/search-entity MOVIE ARGS sel) N)]
                        (println (format "%6d %10.2f %10.2f %10.2f" d (:min r) (:median r) (:max r)))
                        (flush)
                        (assoc r :depth d))))
        rows  (count (dataset/search-entity MOVIE BULK-ARGS BULK-SELECTION))
        bulk  (timed-median #(dataset/search-entity MOVIE BULK-ARGS BULK-SELECTION) 5)]
    (println (format "%6s %10.2f %10.2f %10.2f   (%d rows + genres)"
                     "bulk" (:min bulk) (:median bulk) (:max bulk) rows))
    (flush)
    (spit OUT (j/write-value-as-string {:depths depths :bulk (assoc bulk :rows rows)}))
    :ok))
