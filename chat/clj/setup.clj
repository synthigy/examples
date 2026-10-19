;; Deploy the chat model and seed its cast, using nothing but the SDK.
;;
;;   synthigy exec -- bb setup   (the client needs Dataset Developer + IAM Admin)
;;
;; The export's bytes go over the wire untouched — the server decodes them.
;; Re-runnable: a user or room that already carries one of these names is
;; reused, never duplicated (`name` is UNIQUE on both), and messages are seeded
;; only into rooms setup itself opened.
;;
;; Rooms and messages are dataset data, so `destroy` takes them with the
;; dataset. The cast is IAM data, which it does not: setup records the users
;; it minted in .deploy.edn and teardown removes exactly those.
(ns setup
  (:require [synthigy.client :as syn]
            [synthigy.client.core :as core]
            [babashka.json :as json]
            [clojure.edn :as edn]
            [clojure.java.io :as io]))

(def datasets (io/file ".." ".." "datasets" "chat"))
(def export   (io/file datasets "synthigy-chat@0.1.3.json"))
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
  (let [{:keys [users rooms messages]} (json/read-str (slurp seed) {:key-fn keyword})
        ack       (syn/deploy (slurp export))
        _         (println (format "deployed %s (dataset %s)" (:version ack) (:dataset ack)))

        existing-u (resolve-by-name "User" (map :name users))
        user-xid   (into {} (for [u users] [(:name u) (or (existing-u (:name u)) (core/new-xid))]))
        existing-r (resolve-by-name "Chat Room" (map :name rooms))
        room-xid   (into {} (for [r rooms] [(:name r) (or (existing-r (:name r)) (core/new-xid))]))
        refs       (fn [names] (vec (for [n names] {:xid (user-xid n)})))]

    ;; `stack`, not `sync`, for anything touching a user's link-sets: the cast
    ;; is SHARED with the rls-demo, which seeds the same alice/bob/charlie/
    ;; diana and grants its own role and group. `sync` replaces the link-set
    ;; and would strip that grant; `stack` adds and never removes.
    (syn/stack "User"
               (vec (for [u users]
                      {:xid (user-xid (:name u)) :name (:name u) :type "PERSON" :active true})))
    (println "seeded User:" (count users))

    ;; Internal Member is the directory-read preset every internal user gets:
    ;; it is what lets a member see the names of the people beside them. The
    ;; chat entities need no role at all — their guards decide alone.
    (let [role (first (syn/search "User Role" {:name {:_eq "Internal Member"}} {:xid nil}))]
      (syn/stack "User Role" {:xid (:xid role) :users (refs (map :name users))})
      (println "granted Internal Member to" (count users) "users"))

    ;; Rooms are opened by the app, as the service user. From then on the
    ;; room's guard decides: only its administrators may rename it, change who
    ;; is in it or delete it, whoever asks.
    (syn/sync "Chat Room"
              (vec (for [{:keys [name description administrators members]} rooms]
                     {:xid (room-xid name) :name name :description description
                      :administrators (refs administrators)
                      :members (refs members)})))
    (println "seeded Chat Room:" (count rooms))

    ;; `author` is a user-typed attribute, which the engine expands into a
    ;; to-one relation — write it as one, never as an internal row id. The
    ;; message's write guard is `author = current user`, so each one is written
    ;; AS its author; seeded as anyone else it would fail ROW_FORBIDDEN.
    ;; Timestamps follow the seed's order, a second apart, so conversations
    ;; read as written although they are sent author by author.
    (if (= (count existing-r) (count rooms))
      (println "rooms were already there — messages left as they are")
      (let [start (.minusSeconds (java.time.Instant/now) (count messages))
            stamped (map-indexed (fn [i m] (assoc m :at (str (.plusSeconds start i)))) messages)]
        (doseq [[author batch] (group-by :author stamped)]
          (syn/sync "Chat Message"
                    (vec (for [{:keys [room content at]} batch]
                           {:xid (core/new-xid) :content content
                            :author {:xid (user-xid author)}
                            :published-on at
                            :chat-room {:xid (room-xid room)}}))
                    :acting-as (user-xid author)))
        (println "seeded Chat Message:" (count messages))))

    ;; Users minted by an earlier run stay on the list, so teardown still
    ;; removes them after a re-run.
    (spit state (pr-str {:dataset (:dataset ack) :version (:version ack)
                         :users (vec (distinct (concat (when (.exists state) (:users (edn/read-string (slurp state))))
                                                       (for [u users :when (not (existing-u (:name u)))]
                                                         (user-xid (:name u))))))}))
    (println "wrote" (str state))
    (syn/disconnect!)))

(when (= *file* (System/getProperty "babashka.file")) (-main))
