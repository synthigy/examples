(require '[synthigy.dataset.id :as id]
         '[jsonista.core :as j]
         '[clojure.walk :as walk])

(defn- ->xid [s] (id/uuid->nanoid (java.util.UUID/fromString s)))

;; Identical postwalk to synthigy_import.clj's euuid->xid — any map carrying
;; :euuid becomes the same map with :xid (deterministic) and no :euuid.
(defn- euuid->xid [m]
  (walk/postwalk
   (fn [x] (if (and (map? x) (:euuid x))
             (-> x (assoc :xid (->xid (:euuid x))) (dissoc :euuid))
             x))
   m))

(def dir "/home/rgersak/dev/synthigy/examples/datasets/movies/movies/")
(doseq [f ["movie_genres" "movie_actors" "movies" "movie_genres_mapping"
           "movie_actors_mapping" "user_ratings" "user_tags"]]
  (let [path (str dir f ".json")
        data (j/read-value (slurp path) j/keyword-keys-object-mapper)
        out  (euuid->xid data)]
    (spit path (j/write-value-as-string out))
    (println (format "  %-22s %d records  (sample xid: %s)"
                     f (count out) (or (:xid (first out)) "—")))))
(println "done")
