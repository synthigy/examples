;; Synthigy read-path harness — the nested search query from docs/plans/bench/SEARCH.md,
;; run through the /data query engine (dataset/search-entity).
;;
;;   (load-file ".../competitors/synthigy_search.clj")
;;   (synthigy-bench.search/run!)
;;
;; Times the query N times and writes synthigy-result.json (min/median/p95
;; + the normalised result) for search-bench.mjs to fold in and diff.

(ns synthigy-bench.search
  (:require [synthigy.dataset :as dataset]
            [jsonista.core :as j]))

(def OUT "/home/rgersak/dev/synthigy/examples/bench/synthigy-result.json")
(def MOVIE "CuquTMuTdnWZUP6GxurJqM")
(def N 30)

(def ARGS {:release_year {:_gt 2000} :_order_by {:title :asc} :_limit 10})

(def SELECTION
  {:title nil
   :genres [{:selections {:name nil}}]
   :_count [{:selections {:movie_ratings [nil]}}]
   :_agg  [{:selections {:movie_ratings [{:selections {:value [{:selections {:avg nil}}]}}]}}]
   :movie_ratings [{:args {:_order_by {:value :desc} :_limit 3}
                    :selections {:value nil}}]})

(defn- normalise [rows]
  (mapv (fn [r]
          {:title        (:title r)
           :genres       (mapv :name (:genres r))
           :rating_count (get-in r [:_count :movie_ratings])
           :avg_rating   (some-> (get-in r [:_agg :movie_ratings :value :avg]) double)
           :top_ratings  (mapv (comp double :value) (:movie_ratings r))})
        rows))

(defn run! []
  (dataset/search-entity MOVIE ARGS SELECTION) ; warm-up
  (let [times (vec (for [_ (range N)]
                     (let [t0 (System/nanoTime)]
                       (dataset/search-entity MOVIE ARGS SELECTION)
                       (/ (- (System/nanoTime) t0) 1e6))))
        sorted (sort times)
        pct    (fn [p] (nth sorted (min (dec N) (int (* N p)))))
        result (normalise (dataset/search-entity MOVIE ARGS SELECTION))]
    (spit OUT (j/write-value-as-string
               {:min (first sorted) :median (pct 0.5) :p95 (pct 0.95)
                :result result}))
    (printf "Synthigy — %d runs — min %.2f / median %.2f / p95 %.2f ms — %d rows%n"
            N (first sorted) (pct 0.5) (pct 0.95) (count result))
    (flush)
    :ok))
