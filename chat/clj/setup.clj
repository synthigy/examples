;; Deploy the chat model and seed its cast, using nothing but the SDK.
;;
;;   synthigy exec -- bb setup   (the client needs Dataset Developer + IAM Admin)
;;
;; The export's bytes go over the wire untouched — the server decodes them.
;; Re-runnable: a group or user that already carries one of these names is
;; reused, never duplicated (`name` is UNIQUE on both).
;;
;; The cast is IAM data, not dataset data, so `destroy` does not reclaim it.
;; Setup records what it minted in .deploy.edn and teardown removes exactly
;; that — never a row it found already there.
(ns setup
  (:require [synthigy.client :as syn]
            [synthigy.client.core :as core]
            [babashka.json :as json]
            [clojure.java.io :as io]))

(def datasets (io/file ".." ".." "datasets" "chat"))
(def export   (io/file datasets "synthigy-chat@0.1.2.json"))
(def seed     (io/file datasets "seed.json"))
(def state    (io/file ".deploy.edn"))

(syn/connect! {:endpoint      (or (System/getenv "SYNTHIGY_ENDPOINT") "http://localhost:7887")
               :client-id     (or (System/getenv "SYNTHIGY_CLIENT_ID") "chat-bff")
               :client-secret (System/getenv "SYNTHIGY_CLIENT_SECRET")})

(defn resolve-by-name
  "xid per name for rows that already exist under `entity`."
  [entity names]
  (into {} (for [r (syn/search entity {:name {:_in (vec names)}} {:xid nil :name nil})]
             [(:name r) (:xid r)]))) 

(defn -main [& _]
  (let [{:keys [groups users messages]} (json/read-str (slurp seed) {:key-fn keyword})
        ack       (syn/deploy (slurp export))
        _         (println (format "deployed %s (dataset %s)" (:version ack) (:dataset ack)))

        existing-g (resolve-by-name "User Group" (map :name groups))
        group-xid  (into {} (for [g groups] [(:name g) (or (existing-g (:name g)) (core/new-xid))]))
        existing-u (resolve-by-name "User" (map :name users))
        user-xid   (into {} (for [u users] [(:name u) (or (existing-u (:name u)) (core/new-xid))]))]

    (syn/sync "User Group"
              (vec (for [g groups]
                     {:xid (group-xid (:name g)) :name (:name g)
                      :description (:description g) :type "ACCESS" :active true})))
    (println "seeded User Group:" (count groups))

    ;; Membership is the IAM `groups` m2m — the same link the model's read
    ;; guard walks from Chato Message through `user_groups`.
    ;;
    ;; `stack`, not `sync`, for anything touching a user's link-sets: the cast
    ;; is SHARED with the rls-demo, which seeds the same alice/bob/charlie/
    ;; diana and grants its own role and group. `sync` replaces the link-set
    ;; and would strip that grant; `stack` adds and never removes.
    (syn/stack "User"
               (vec (for [u users]
                      {:xid (user-xid (:name u)) :name (:name u) :type "PERSON" :active true
                       :groups (vec (for [g (:groups u)] {:xid (group-xid g)}))})))
    (println "seeded User:" (count users))

    ;; Internal Member is the directory-read preset every internal user gets.
    ;; Without it a user cannot see a User Group, and so cannot post a message
    ;; INTO one — the link write resolves the group as a pointer. Rooted at the
    ;; role, which is the only grant path the doctrine allows.
    (let [role (first (syn/search "User Role" {:name {:_eq "Internal Member"}} {:xid nil}))]
      (syn/stack "User Role" {:xid (:xid role)
                              :users (vec (for [u users] {:xid (user-xid (:name u))}))})
      (println "granted Internal Member to" (count users) "users"))

    ;; `author` is a user-typed attribute, which the engine expands into a
    ;; to-one relation — write it as one, never as an internal row id.
    ;;
    ;; The model's write guard is `author = current user`, so each message has
    ;; to be written AS its author (the client is trusted, so acting_as is
    ;; allowed). Seeding as the service user would fail ROW_FORBIDDEN, which is
    ;; the guard doing its job.
    (doseq [[author batch] (group-by :author messages)]
      (syn/sync "Chato Message"
                (vec (for [{:keys [group content]} batch]
                       {:xid (core/new-xid) :content content
                        :author {:xid (user-xid author)}
                        :published-on (str (java.time.Instant/now))
                        :user-groups [{:xid (group-xid group)}]}))
                :acting-as (user-xid author)))
    (println "seeded Chato Message:" (count messages))

    (spit state (pr-str {:dataset (:dataset ack) :version (:version ack)
                         :users  (vec (for [u users  :when (not (existing-u (:name u)))] (user-xid (:name u))))
                         :groups (vec (for [g groups :when (not (existing-g (:name g)))] (group-xid (:name g))))}))
    (println "wrote" (str state))
    (syn/disconnect!)))

(when (= *file* (System/getProperty "babashka.file")) (-main))
