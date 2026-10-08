;; Destroy what setup.clj created — the dataset, then the IAM cast it minted.
;; Idempotent: safe after a failed setup, safe to run twice.
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
    (let [{:keys [dataset users groups]} (edn/read-string (slurp state))]
      (syn/destroy dataset)
      (println "destroyed dataset" dataset)
      (doseq [xid users]  (try (syn/delete "User" {:xid xid}) (catch Exception _ nil)))
      (doseq [xid groups] (try (syn/delete "User Group" {:xid xid}) (catch Exception _ nil)))
      (println (format "removed cast: %d users, %d groups" (count users) (count groups)))
      (.delete state)))
  (syn/disconnect!))

(when (= *file* (System/getProperty "babashka.file")) (-main))
