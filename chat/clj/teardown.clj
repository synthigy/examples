;; Destroy what setup.clj created — the dataset (rooms and messages with it),
;; then the users it minted. Idempotent: safe after a failed setup, safe to run
;; twice.
;;
;;   bb teardown
(ns teardown
  (:require [synthigy.client :as syn]
            [clojure.edn :as edn]
            [clojure.java.io :as io]))

(def state (io/file ".deploy.edn"))

(syn/connect! {:endpoint      (or (System/getenv "SYNTHIGY_ENDPOINT") "http://localhost:7887")
               :client-id     (or (System/getenv "SYNTHIGY_CLIENT_ID") "chat-bff")
               :client-secret (System/getenv "SYNTHIGY_CLIENT_SECRET")})

(defn -main [& _]
  (if-not (.exists state)
    (println "nothing deployed by setup.clj — nothing to destroy")
    (let [{:keys [dataset users]} (edn/read-string (slurp state))]
      (syn/destroy dataset)
      (println "destroyed dataset" dataset)
      (doseq [xid users] (try (syn/delete "User" {:xid xid}) (catch Exception _ nil)))
      (println (format "removed cast: %d users" (count users)))
      (.delete state)))
  (syn/disconnect!))

(when (= *file* (System/getProperty "babashka.file")) (-main))
