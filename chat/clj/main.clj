;; Synthigy Chat — babashka BFF (real-time, Tyrell UI).
;;
;; • RLS    — one confidential `chat-bff` client + `acting_as` per user. Which
;;            rooms and messages a user sees, and what they may change, is
;;            decided by the guards in the model, never by this file.
;; • LIVE   — per tab, three watch-queries (rooms, the rooms' messages, the
;;            activity SQL), each re-fetched AS that user on every change and
;;            pushed as a Datastar SSE patch. Membership changes are live too.
;; • ERRORS — every write that the engine refuses comes back with a typed code
;;            and category; the toast shows them as they arrived.
;; • SQL    — the activity panel is one SQL template for everyone; the engine
;;            injects the guards, so each user counts only what they can read.
;; • /history powers the edit trail and the recovery of deleted messages.
;; • UI     — Tyrell web components (<ty-*>) + Datastar, both via CDN. No build.
;;
;; Run:  bb main.clj   → http://localhost:5177 (PORT overrides)
;; Open two tabs as different users (?user=alice / ?user=bob) and watch a
;; message, a new member or a removal reach both, live.

(require '[org.httpkit.server :as http]
         '[hiccup2.core :as h]
         '[hiccup.util :as hu]
         '[clojure.string :as str]
         '[clojure.java.io :as io]
         '[babashka.json :as json]
         '[tyrell.lucide :as L]                ; icon SVGs from the dev.gersak/tyrell-icons jar
         '[synthigy.client :as syn]
         '[synthigy.client.core :as core]
         ;; generated from ../xsql/chat.xsql — regenerate with `bb gen`
         '[chat.ops.message :as message]
         '[chat.ops.room :as room])

;; Real Tyrell icons: each tyrell.lucide var IS the full <svg> string. Slot it
;; into <ty-icon> — renders server-side, sizes via ty-icon, survives morphs.
(def lucide {"send" L/send "pencil" L/pencil "trash" L/trash-2 "clock" L/clock
             "sun" L/sun "moon" L/moon "chat" L/message-circle "x" L/x
             "crown" L/crown "users" L/users "user-plus" L/user-plus "hash" L/hash
             "plus" L/plus "chart" L/chart-column "shield" L/shield-check
             "lock" L/lock "alert" L/circle-alert "eye" L/eye "sigma" L/sigma})

(defn icon [nm & {:keys [size cls] :or {size "sm"}}]
  [:ty-icon (cond-> {:size size} cls (assoc :class cls))
   (hu/raw-string (lucide nm))])

;; ── Config ─────────────────────────────────────────────────────────────────

(defn env [k d] (or (System/getenv k) d))

(def endpoint (env "SYNTHIGY_ENDPOINT" "http://localhost:7887"))

(syn/connect! {:endpoint      endpoint
               :client-id     (env "SYNTHIGY_CLIENT_ID" "chat-bff")
               :client-secret (env "SYNTHIGY_CLIENT_SECRET" nil)})

;; Nothing about the seeded data is pinned here. The cast is whoever setup
;; made an Internal Member, rooms come from the database per user, and the
;; attribute xid the /history filter needs comes from /schema.

(def content-attr
  (get-in (syn/schema ["chat-message"])
          [:entities :chat_message :xids :attributes :content]))

(defn cast-directory
  "Active Internal Members who are in a room or wrote in one — the chat's cast, by name."
  []
  (let [involved (into #{}
                       (concat (for [r (room/rooms {}) p (concat (:members r) (:administrators r))] (:xid p))
                               (for [m (syn/search "Chat Message" nil {:author [{:selections {:xid nil}}]})]
                                 (get-in m [:author :xid]))))]
    (->> (syn/search "User Role" {:name {:_eq "Internal Member"}}
                     {:users [{:selections {:xid nil :name nil :type nil :active nil}}]})
         (mapcat :users)
         (filter #(and (:active %) (= "PERSON" (name (:type %))) (involved (:xid %))))
         (map (juxt :name #(select-keys % [:xid :name])))
         (into (sorted-map)))))

(def people (atom (cast-directory)))

(defn user-xid [user-key] (:xid (@people user-key)))

(when (empty? @people)
  (println "No chat cast on" endpoint "— run `bb setup` first."))

;; A room record is touched by its own columns; membership lives on relations,
;; so a live room list must also listen to those two.
(def room-relations ["chat_room.members" "chat_room.administrators"])

(defonce deleted-log (atom []))                 ; [{:xid :room :author}], in BFF memory
(defonce conns (atom {}))                       ; SSE channel → its watches

;; ── Data (all RLS-scoped via acting_as) ────────────────────────────────────

(defn rooms-of [user-key]
  (room/rooms {} :acting-as (user-xid user-key)))

(defn messages-of [user-key room-xids]
  (if (seq room-xids)
    (message/list {:rooms (vec room-xids)} :acting-as (user-xid user-key))
    []))

(defn send-message! [user-key room-xid content]
  (when-not (str/blank? content)
    ;; `author` is a user-typed attribute, which the engine expands into a
    ;; to-one relation — write it as one, never as an internal row id.
    (syn/sync "Chat Message"
              {:content content
               :author {:xid (user-xid user-key)}
               :published-on (str (java.time.Instant/now))
               :chat-room {:xid room-xid}}
              :acting-as (user-xid user-key))))

(defn edit-message! [user-key xid content]
  (syn/stack "Chat Message" {:xid xid :content content}
             :acting-as (user-xid user-key)))

(defn delete-message! [user-key xid]
  ;; The room and author are read from the message itself, as this user, so
  ;; the recovery panel shows it only to those its read guard lets in.
  (let [m (first (filter #(= xid (:xid %)) (messages-of user-key (map :xid (rooms-of user-key)))))]
    (syn/delete "Chat Message" {:xid xid} :acting-as (user-xid user-key))
    (when m
      (swap! deleted-log conj {:xid xid
                               :room (get-in m [:chat-room :xid])
                               :author (get-in m [:author :xid])}))))

(defn add-member! [user-key room-xid member-xid]
  ;; stack ADDS to the link-set; the room's write guard decides whether this
  ;; user may touch the room's links at all.
  (syn/stack "Chat Room" {:xid room-xid :members [{:xid member-xid}]}
             :acting-as (user-xid user-key)))

(defn remove-member! [user-key room-xid member-xid]
  ;; sync REPLACES the link-set with what is sent. The member list is read as
  ;; this same user, so a user can only ever resend what they can see.
  (let [r (first (filter #(= room-xid (:xid %)) (rooms-of user-key)))]
    (syn/sync "Chat Room"
              {:xid room-xid
               :members (vec (for [m (:members (or r {})) :when (not= member-xid (:xid m))]
                               {:xid (:xid m)}))}
              :acting-as (user-xid user-key))))

(defn open-room! [user-key room-name description]
  ;; The app opens a room AS ITSELF and hands it to the user: from then on
  ;; only the room's administrators may change it. `name` is unique in the
  ;; model — a duplicate comes back as UNIQUE_VIOLATION.
  (let [u (user-xid user-key)]
    (when (str/blank? room-name)
      (throw (ex-info "A room needs a name." {})))
    (syn/sync "Chat Room" {:xid (core/new-xid) :name (str/trim room-name)
                           :description (when-not (str/blank? description) description)
                           :administrators [{:xid u}] :members [{:xid u}]})))

(defn content-history [xid]
  (->> (syn/history-events xid)
       (filter #(= content-attr (:attribute-xid %)))
       (map (fn [e] {:ts (:ts e) :value (:value e)}))
       (sort-by :ts)))

(defn recover-deleted [xid]
  (-> (syn/history-get-at xid (str (java.time.Instant/now)) :include-deleted? true)
      (get (keyword content-attr))))

;; ── Fragments (Tyrell components) ──────────────────────────────────────────

(defn url
  "`path` with query params, every value URL-encoded — safe inside a Datastar
   expression's single-quoted string, whatever a user or room name holds."
  [path & kvs]
  (str path "?" (str/join "&" (for [[k v] (partition 2 kvs)]
                                 (str (name k) "=" (java.net.URLEncoder/encode (str v) "UTF-8"))))))

(defn time-str [t] (some-> t str (#(subs % 0 (min 19 (count %)))) (str/replace "T" " ")))

(defn hhmm [t] (some-> (time-str t) (#(when (>= (count %) 16) (subs % 11 16)))))

(def avatar-bg {"alice" "ty-bg-primary" "bob" "ty-bg-success"
                "charlie" "ty-bg-warning" "diana" "ty-bg-accent"})

(defn avatar [name size]
  [:div.shrink-0.rounded-full.grid.place-items-center.font-semibold.select-none
   {:class (str (avatar-bg name "ty-bg-neutral") " " size)}
   (str/upper-case (subs (str name) 0 1))])

(defn xids [people] (set (map :xid people)))

(defn access
  "Why `uid` can read room `r`: :admin, :member, or :author (only through
   messages they wrote — the room's third read guard)."
  [uid r]
  (cond (contains? (xids (:administrators r)) uid) :admin
        (contains? (xids (:members r)) uid)        :member
        :else                                      :author))

(defn access-chip [a]
  (case a
    :admin  [:span.flex.items-center.gap-1.t11.ty-text-warning {:title "You administer this room"} (icon "crown" :size "xs") "admin"]
    :member [:span.t11.ty-text-- "member"]
    :author [:span.flex.items-center.gap-1.t11.ty-text-- {:title "Not a member: you read this room only through messages you wrote in it"}
             (icon "eye" :size "xs") "via your posts"]))

(def nav-reset
  "What belongs to the view being left: drafts, the open edit, the popover and the toast."
  (str "$loading=true, $content='', $editId='', $editText='', $newMember='', $opening=false, "
       "document.getElementById('panel')?.replaceChildren(), document.getElementById('toast')?.replaceChildren()"))

(defn go
  "Client-side navigation: set the view signals, push the URL, reopen the stream."
  [signal value]
  (let [v (json/write-str value)]
    (str "evt.metaKey || evt.ctrlKey || evt.shiftKey || (evt.preventDefault(), $" signal " !== " v " && ("
         "$" signal "=" v ", " nav-reset ", "
         "history.pushState(null, '', '/?user=' + encodeURIComponent($user) + '&room=' + encodeURIComponent($room)), "
         "window.dispatchEvent(new Event('chat-nav'))))")))

(defn rooms-sidebar [user-key active rooms stats]
  ;; Message counts come from the activity SQL, which the guards scope, not
  ;; from `_count`: an aggregate over a relation counts rows the user cannot
  ;; read.
  (let [uid (user-xid user-key)
        readable (into {} (map (juxt :room :messages)) stats)]
    [:nav#rooms.flex.flex-col.gap-1 {:data-tour "rooms"}
     [:a.flex.items-center.justify-between.px-3.py-2.rounded-lg.text-sm
      {:href (url "/" :user user-key :room "all") "data-on:click" (go "room" "all")
       :class (if (= "all" active) "ty-bg-secondary ty-text-secondary++" "ty-text- hover:ty-text")}
      [:span.flex.items-center.gap-2 (icon "chat" :size "xs") "All rooms"]
      [:span.t11.ty-text-- (reduce + 0 (vals readable))]]
     (for [r rooms]
       [:a.flex.flex-col.gap-1.px-3.py-2.rounded-lg
        {:href (url "/" :user user-key :room (:xid r)) "data-on:click" (go "room" (:xid r))
         :class (if (= (:xid r) active) "ty-bg-secondary ty-text-secondary++" "ty-text- hover:ty-text")}
        [:span.flex.items-center.justify-between.text-sm.font-medium
         [:span.flex.items-center.gap-1 (icon "hash" :size "xs") (:name r)]
         [:span.flex.items-center.gap-2.t11.ty-text--
          [:span {:title "members"} (icon "users" :size "xs") " " (get-in r [:_count :members] 0)]
          [:span {:title "messages you can read"} (icon "chat" :size "xs") " " (readable (:name r) 0)]]]
        (access-chip (access uid r))])
     (when (empty? rooms)
       [:div.t13.ty-text--.px-3.py-2 "No room lets you in yet."])]))

(defn msg-row [user-key rooms show-room? {:keys [xid content published-on author chat-room]}]
  (let [uid   (user-xid user-key)
        name  (or (:name author) "?")
        mine? (= uid (:xid author))
        r     (first (filter #(= (:xid chat-room) (:xid %)) rooms))
        admin? (and r (= :admin (access uid r)))]
    [:div.group.flex.items-start.gap-2 {:class (when mine? "flex-row-reverse")}
     (avatar name "w-8 h-8 text-xs")
     [:div.flex.flex-col.gap-1.bw {:class (if mine? "items-end" "items-start")}
      [:div.flex.items-center.gap-2.text-xs.px-1
       [:span.font-semibold.ty-text+ name]
       (when show-room?
         [:ty-tag {:size "xs" :flavor "secondary"} (str "#" (:name chat-room))])
       [:span.ty-text-- (time-str published-on)]]
      [:div.px-3.py-1.rounded-2xl.t13.leading-snug.shadow-sm.break-words
       {:class (if mine?
                 "ty-bg-primary ty-text-primary++ rounded-br-sm"
                 "ty-elevated rounded-bl-sm")}
       content]
      [:div.flex.gap-1.opacity-0.group-hover:opacity-100.transition-opacity
       [:ty-button {:size "xs" :appearance "ghost" :flavor "neutral" :title "History"
                    "data-on:click" (str "@get('" (url "/history" :user user-key :msg xid) "')")} (icon "clock" :size "xs")]
       (when mine?
         [:ty-button {:size "xs" :appearance "ghost" :flavor "neutral" :title "Edit"
                      "data-on:click" (str "@get('" (url "/edit-form" :user user-key :msg xid) "')")} (icon "pencil" :size "xs")])
       (when (or mine? admin?)
         [:ty-button {:size "xs" :appearance "ghost" :flavor "danger"
                      :title (if mine? "Delete" "Delete as room administrator")
                      :data-tour (when (and admin? (not mine?)) "moderate")
                      "data-on:click" (str "@post('" (url "/delete" :user user-key :msg xid) "')")}
          (icon (if (and admin? (not mine?)) "shield" "trash") :size "xs")])]]]))

(defn deleted-panel [user-key rooms]
  ;; The message read guard: its author, the room's members and administrators.
  ;; Reading a room only through your own posts shows only your own.
  (let [uid  (user-xid user-key)
        room (into {} (map (juxt :xid identity)) rooms)
        gone (filter (fn [{r :room author :author}]
                       (when-let [rm (room r)]
                         (or (= uid author) (#{:admin :member} (access uid rm)))))
                     @deleted-log)]
    (when (seq gone)
      [:div.mt-2.pt-3.border-t.ty-border-
       [:div.flex.items-center.gap-1.t11.ty-text--.mb-2.px-1
        (icon "trash" :size "xs") "recently deleted — recovered from /history"]
       [:div.flex.flex-col.gap-2
        (for [{:keys [xid]} (reverse gone)]
          [:div.flex.items-center.gap-2.opacity-60
           [:div.shrink-0.w-8.h-8.rounded-full.grid.place-items-center.ty-bg-neutral-.ty-text-
            (icon "trash" :size "xs")]
           [:div.px-3.py-1.rounded-2xl.ty-elevated.t13.italic.ty-text--.line-through
            (or (recover-deleted xid) "(unrecoverable)")]])]])))

;; Render #messages from the rows of the watch-query. No state — the rows ARE
;; the DB result, read AS this user; nothing is held client- or BFF-side.
(defn messages-pane [user-key active rooms rows]
  (let [visible (xids rooms)
        gone?   (and (not= "all" active) (not (contains? visible active)))]
    [:div#messages.flex.flex-col.gap-4.px-4.py-5
     (cond
       gone?
       [:div.flex.flex-col.items-center.gap-2.ty-text--.text-sm.text-center.py-10
        (icon "lock" :size "md")
        "This room is no longer visible to you — its guard just decided so."]

       (seq rows)
       (for [m (sort-by :published-on rows)] (msg-row user-key rooms (= "all" active) m))

       :else
       [:div.ty-text--.text-sm.text-center.py-10 "No messages in this view yet."])
     (deleted-panel user-key rooms)
     ;; bottom sentinel — id unique per RENDER (not per count, so edits and
     ;; refetches fire too) → Datastar re-runs data-init after every patch and
     ;; scrolls the ty-scroll-container to the latest message. MUST stay a
     ;; single expression (datastar compiles the value as `return (...)`);
     ;; `data-on:load`/`data-on-load` are DEAD in datastar v1 RC — data-init
     ;; is the on-mount hook.
     [:div {:id (str "end-" (System/currentTimeMillis))
            "data-init" "el.closest('ty-scroll-container')?.scrollToBottom?.(false)"}]]))

(defn compose [user-key active rooms]
  (let [r    (first (filter #(= active (:xid %)) rooms))
        send (str "@post('" (url "/send" :user user-key :room active) "')")]
    [:div#compose.px-4.pt-3.pb-4.shrink-0 {:data-tour "compose" "data-signals" "{content:''}"}
     (if-not r
       [:ty-textarea {:size "sm" :rows "1" :resize "none" :disabled true
                      :placeholder (if (= "all" active) "Pick a room on the left to send a message." "You cannot post here.")}]
       [:div.flex.flex-col.gap-1.5
        [:div.flex.items-end.gap-2
         [:ty-textarea {"data-bind" "content" :size "sm" :rows "2" :resize "none" :class "flex-1"
                        :min-height "44px" :max-height "160px"
                        :placeholder (str "Message #" (:name r))
                        "data-on:keydown" (str "evt.key==='Enter' && !evt.shiftKey && !evt.isComposing "
                                               "&& (evt.preventDefault(), " send ")")}]
         [:ty-button {:size "md" :flavor "primary" "data-on:click" send}
          (icon "send" :size "sm") "Send"]]
        [:div.flex.items-center.gap-2.t11.ty-text--.px-1
         (avatar user-key "w-4 h-4 text-[9px]")
         [:span "as " [:b.ty-text- user-key] " in " [:b.ty-text- "#" (:name r)]]
         [:span.hidden.md:inline "· Enter sends, Shift+Enter breaks the line"]]])]))

(defn person-row [user-key room-xid admin-view? removable? {:keys [xid name]}]
  [:div.flex.items-center.gap-2.py-1
   (avatar name "w-6 h-6 text-xs")
   [:span.text-sm.flex-1 name]
   (when removable?
     [:ty-button {:size "xs" :appearance "ghost" :flavor (if admin-view? "danger" "neutral")
                  :title (if admin-view? "Remove from the room" "Only administrators may — try it")
                  "data-on:click" (str "@post('" (url "/member/remove" :user user-key :room room-xid :member xid) "')")}
      (icon "x" :size "xs")])])

(defn room-panel [user-key active rooms]
  (let [uid (user-xid user-key)
        r   (first (filter #(= active (:xid %)) rooms))]
    (if-not r
      [:div#room-panel.t13.ty-text-- {:data-tour "members"}
       "Pick a room to see its administrators and members, and to try changing them."]
      (let [admin? (= :admin (access uid r))
            in-room (xids (:members r))
            candidates (remove #(contains? in-room (:xid %)) (vals @people))]
        [:div#room-panel.flex.flex-col.gap-4 {:data-tour "members"}
         [:div
          [:div.flex.items-center.gap-1.font-semibold.ty-text+ (icon "hash" :size "xs") (:name r)]
          (when (:description r) [:div.t13.ty-text-.mt-1 (:description r)])]
         [:div
          [:div.flex.items-center.gap-1.t11.uppercase.tracking-wide.ty-text--.mb-1 (icon "crown" :size "xs") "Administrators"]
          (for [p (:administrators r)] (person-row user-key (:xid r) admin? false p))]
         [:div
          [:div.flex.items-center.justify-between.t11.uppercase.tracking-wide.ty-text--.mb-1
           [:span.flex.items-center.gap-1 (icon "users" :size "xs") "Members"]
           [:span (count (:members r))]]
          (for [p (:members r)] (person-row user-key (:xid r) admin? true p))
          (when (seq candidates)
            [:div.flex.gap-2.items-center.mt-2
             [:ty-select {:size "sm" :class "flex-1" :placeholder "Add someone…"
                          "data-on:change" "$newMember = evt.detail.value || ''"}
              (for [p candidates] [:ty-option {:value (:xid p)} (:name p)])]
             [:ty-button {:size "md" :flavor (if admin? "primary" "neutral") :appearance (if admin? "solid" "outlined")
                          :title (if admin? "Add to the room" "Only administrators may — try it")
                          "data-on:click" (str "$newMember && @post('" (url "/member/add" :user user-key :room (:xid r)) "')")}
              (icon "user-plus" :size "sm")]])
          (when-not admin?
            [:div.t11.ty-text--.mt-2 "Only this room's administrators may change who is in it. The buttons are not hidden — try them, the engine answers."])]]))))

(defn activity-panel [user-key stats]
  [:div#activity.flex.flex-col.gap-2 {:data-tour "activity"}
   [:div.flex.items-center.gap-1.t11.uppercase.tracking-wide.ty-text-- (icon "chart" :size "xs") (str "What " user-key " can count")]
   (if (seq stats)
     [:table.w-full.t13
      [:thead [:tr.ty-text--.t11
               [:th.text-left.font-normal "room"] [:th.text-right.font-normal "msgs"]
               [:th.text-right.font-normal "authors"] [:th.text-right.font-normal "last"]]]
      [:tbody
       (for [{:keys [room messages authors] :as row} stats]
         [:tr [:td.py-1 (str "#" room)] [:td.text-right messages] [:td.text-right authors]
          [:td.text-right.t11.ty-text-- (hhmm (or (:last-post row) (:last_post row)))]])
       [:tr.border-t.ty-border-
        [:td.py-1.flex.items-center.gap-1 (icon "sigma" :size "xs")]
        [:td.text-right.font-semibold (reduce + 0 (map :messages stats))] [:td] [:td]]]]
     [:div.t13.ty-text-- "Nothing readable to count."])
   [:div.t11.ty-text--.leading-snug
    "One SQL template for everyone (" [:code "room/activity"] " in chat.xsql). "
    "The engine injects each user's guards into it, so these are " user-key "'s numbers. Switch user and compare."]])

(defn toast
  "The engine's answer to a write, as it arrived: code, category, message."
  [{:keys [kind code category message]}]
  [:div#toast.fixed.top-16.right-6.z-50.max-w-md
   (when message
     [:div.ty-floating.rounded-xl.shadow-xl.p-3.flex.gap-2.items-start
      {:class (if (= kind :error) "border ty-border-danger" "border ty-border-success")}
      (icon (if (= kind :error) "alert" "shield") :size "sm" :cls (if (= kind :error) "ty-text-danger" "ty-text-success"))
      [:div.flex.flex-col.gap-1.flex-1
       (when code
         [:div.flex.items-center.gap-2
          [:ty-tag {:size "xs" :flavor "danger"} code]
          (when category [:ty-tag {:size "xs" :flavor "neutral"} category])])
       [:div.t13.ty-text message]
       (when (= "iam" category)
         [:div.t11.ty-text-- "Refused by the engine: a guard in the model, not a check in this app."])]
      [:button.ty-text-.hover:ty-text {"data-on:click" "@get('/clear-toast')"} (icon "x" :size "xs")]])])

;; segmented user toggle (avatar pills)
(defn user-switcher [active room]
  [:div#cast.flex.items-center.gap-1.p-1.rounded-xl.ty-content {:data-tour "cast"}
   (for [[k _] @people]
     [:a.flex.items-center.gap-2.pl-1.pr-3.py-1.rounded-lg.transition
      {:class (if (= k active)
                "ty-bg-primary ty-text-primary++ shadow-sm"
                "ty-text- hover:ty-text")
       :href (url "/" :user k :room (or room "all"))
       "data-on:click" (go "user" k)}
      (avatar k "w-6 h-6 text-xs")
      [:span.text-sm.font-medium k]])])

(defn tour-link [user-key active]
  [:a#tour-link.text-xs.ty-text-.hover:ty-text.ml-1 {:href (url "/" :user user-key :room active :tour 1)}
   "Take the tour"])

(defn whoami-chip [user-key]
  (let [{:keys [name roles superuser]} (try (syn/whoami :acting-as (user-xid user-key))
                                            (catch Exception _ nil))]
    [:div#whoami.flex.items-center.gap-1.t11.ty-text--.px-2 {:data-tour "whoami"
                                                      :title "whoami over acting_as: who the engine thinks this request is"}
     (icon "shield" :size "xs")
     [:span "engine sees " [:b.ty-text name] (when (seq roles) (str " · " (str/join ", " roles)))
      (when superuser " · superuser")]]))

;; examples/shared/ (tools-rail.js, scenario.js, tour.js) resolved relative to THIS
;; source file, not the working directory — see examples/shared/README.md.
;; *file* is what the self-run check at the bottom of this file already
;; compares against babashka.file, so it's reliable here too.
(defn shared-asset [name]
  (io/file (.getParentFile (io/file *file*)) ".." ".." "shared" name))

(defn serve-js [name]
  {:status 200
   :headers {"Content-Type" "application/javascript; charset=utf-8"
             "Cache-Control" "no-store"}
   :body (slurp (shared-asset name))})

;; A locally built web-component bundle, when examples/scripts/build-tooling.sh
;; has dropped one — the loop for testing a component change before
;; @synthigy/tooling is republished. `page` points the rail here only when the
;; file exists, so deleting it reverts to the CDN.
(defn local-bundle? []
  (.isFile (shared-asset (str "vendor" java.io.File/separator "tooling"
                              java.io.File/separator "tooling.js"))))

(defn serve-vendor [uri]
  (let [name (subs uri (count "/vendor/tooling/"))
        f    (shared-asset (str "vendor" java.io.File/separator "tooling"
                                java.io.File/separator name))]
    (if (and (.isFile f) (not (str/includes? name "..")))
      {:status 200
       :headers {"Content-Type" (if (str/ends-with? name ".css")
                                  "text/css; charset=utf-8"
                                  "application/javascript; charset=utf-8")
                 "Cache-Control" "no-store"}
       :body (slurp f)}
      {:status 404 :body "not found"})))

;; The domain's own .xsql — the exact file `bb gen` reads. Served so the
;; tools rail can open it as a data-console workspace: the visitor sees that
;; these queries are what shape the data this page renders.
(defn serve-xsql [uri]
  (let [name (subs uri (count "/xsql/"))
        f    (io/file (.getParentFile (io/file *file*)) ".." "xsql" name)]
    (if (and (str/ends-with? name ".xsql")
             (not (str/includes? name ".."))
             (.isFile f))
      {:status 200
       :headers {"Content-Type" "text/plain; charset=utf-8"
                 "Cache-Control" "no-store"}
       :body (slurp f)}
      {:status 404 :body "not found"})))

;; shared tools rail + guided tour config — see examples/shared/README.md.
;; tour targets match the data-tour attributes above.
(def tools-and-tour-js
  ;; endpoint is the Synthigy engine's own address — the tools rail's
  ;; components talk to it directly, not to this BFF (examples/shared/
  ;; README.md); this demo runs standalone (no hub in front) so it would
  ;; otherwise default to its own origin and 404 on every /data call.
  (str "window.SYNTHIGY_TOOLS = { endpoint: \"" endpoint "\", xsql: [\"/xsql/chat.xsql\"]"
       (when (local-bundle?)
         ", bundle: \"/vendor/tooling/tooling.js\", bundleCss: \"/vendor/tooling/tooling.css\"")
       " };
window.SYNTHIGY_TOUR = \"/tour.json\";"))

;; retry ~forever with capped backoff, so a BFF restart doesn't leave the tab deaf
(def open-stream
  (str "@get('/stream', {filterSignals: {include: /^(user|room)$/}, openWhenHidden: true, "
       "retryMaxCount: 1000000, retryMaxWait: 10000})"))

(defn page [user-key active]
  (reset! people (cast-directory))
  (let [{:keys [rooms activity]} (room/overview {} :acting-as (user-xid user-key))
        room-xids (if (= "all" active) (map :xid rooms) [active])
        rows (messages-of user-key (filter (xids rooms) room-xids))]
    (str "<!doctype html>"
         (h/html
          [:html {:class "dark"}
           [:head
            [:meta {:charset "utf-8"}]
            [:meta {:name "viewport" :content "width=device-width, initial-scale=1"}]
            [:title "Synthigy Chat"]
            [:script {:src "https://cdn.tailwindcss.com"}]                                 ; layout/spacing
            [:link {:rel "stylesheet" :href "https://cdn.jsdelivr.net/npm/tyrell-components@1.0.0-TC31/css/tyrell.css"}]  ; components
            ;; the token layer — without it every --ty-* is undefined and the page renders unthemed
            [:link {:rel "stylesheet" :href "https://cdn.jsdelivr.net/npm/tyrell-components@1.0.0-TC31/css/tyrell-brand.css"}]
            [:script {:type "module" :src "https://cdn.jsdelivr.net/npm/tyrell-components@1.0.0-TC31/dist/tyrell.js"}]
            [:script {:type "module" :src "https://cdn.jsdelivr.net/gh/starfederation/datastar@v1.0.2/bundles/datastar.js"}]
            [:style "#panel:empty{display:none}
                     ty-input,ty-select,ty-textarea{--ty-input-border:var(--ty-border)}
                     /* sugar-safe aliases for Tailwind arbitraries (can't live in a hiccup tag) */
                     .t13{font-size:13px}.t11{font-size:11px}.bw{max-width:78%}
                     #live{transition:opacity .15s}#live.loading{opacity:.55;pointer-events:none}
                     /* server-rendered icons hold their size before ty-icon upgrades */
                     ty-icon:not(:defined){display:inline-flex;width:1em;height:1em}
                     ty-icon:not(:defined)[size=xs]{width:.75em;height:.75em}
                     ty-icon:not(:defined)[size=sm]{width:.875em;height:.875em}
                     ty-icon:not(:defined) svg{width:100%;height:100%}"]]
           [:body.ty-canvas.ty-text.t13.h-screen.flex.flex-col.overflow-hidden
            {"data-signals" (json/write-str {:user user-key :room active :loading false
                                             :editId "" :editText "" :newMember "" :opening false
                                             :roomName "" :roomDescription ""})}
            ;; ── header: brand · user toggle · whoami · theme · tour ──
            [:header.ty-elevated.border-b.ty-border-.px-5.py-2.flex.items-center.gap-4.shrink-0
             [:div.flex.items-center.gap-2
              [:div.w-7.h-7.rounded-lg.ty-bg-primary.ty-text-primary++.grid.place-items-center
               (icon "chat" :size "sm")]
              [:div.flex.flex-col.leading-tight
               [:span.font-semibold.ty-text++.text-sm "Synthigy Chat"]
               [:span.t11.ty-text-- "RLS · live · SQL · history"]]]
             [:div.ml-auto (user-switcher user-key active)]
             (whoami-chip user-key)
             [:button.ty-text-.hover:ty-text.ml-1
              {:title "Toggle theme"
               "data-on:click" "document.documentElement.classList.toggle('dark')"}
              (icon "sun" :cls "hidden dark:block") (icon "moon" :cls "block dark:hidden")]
             (tour-link user-key active)]
            ;; ── three columns: rooms · conversation · room + activity ──
            ;; data-init opens the live DB-backed stream; navigation reopens it.
            ;; One URL on purpose: datastar 1.0.2 cancels the previous request
            ;; by method+URL, so user and room travel as signals.
            [:div#live.flex-1.flex.min-h-0
             {"data-init" open-stream
              "data-on:chat-nav__window" open-stream
              "data-on:popstate__window" (str "$user = new URLSearchParams(location.search).get('user') || $user; "
                                              "$room = new URLSearchParams(location.search).get('room') || 'all'; "
                                              nav-reset "; " open-stream)
              "data-class:loading" "$loading"}
             [:aside.w-64.shrink-0.border-r.ty-border-.flex.flex-col.min-h-0
              [:div.px-3.pt-3.pb-2.flex.flex-col.gap-2 {:data-tour "open-room"}
               [:div.flex.items-center.justify-between.pl-3
                [:span.t11.uppercase.tracking-wide.ty-text-- "Rooms"]
                [:ty-button {:size "xs" :appearance "ghost" :flavor "neutral" :title "Open a room"
                             "data-on:click" "$opening = !$opening"}
                 (icon "plus" :size "xs")]]
               [:div.flex.flex-col.gap-2.p-2.rounded-lg.ty-content {"data-show" "$opening" :style {:display "none"}}
                [:ty-input {"data-bind" "roomName" :size "sm" :placeholder "Name (unique)"}]
                [:ty-input {"data-bind" "roomDescription" :size "sm" :placeholder "Description"}]
                [:div.flex.justify-end.gap-2
                 [:ty-button {:size "md" :appearance "ghost" :flavor "neutral" "data-on:click" "$opening = false"} "Cancel"]
                 [:ty-button {:size "md" :flavor "primary"
                              "data-on:click" "$roomName.trim() && @post('/room/open?user=' + encodeURIComponent($user))"}
                  "Open"]]]]
              [:div.flex-1.overflow-y-auto.px-3.pb-3 (rooms-sidebar user-key active rooms activity)]
              ;; the shared tools dock is fixed bottom-left: this tray is its seat
              [:div.shrink-0.border-t.ty-border-.px-4.pt-3 {:style {:height "220px"}}
               [:span.t11.uppercase.tracking-wide.ty-text-- "Synthigy tools"]]]
             [:main.flex-1.flex.flex-col.min-h-0
              ;; relative flex box → ty-scroll-container fills it absolutely, so its
              ;; height is DEFINITE (= the box), which is what .scroll-wrapper's
              ;; height:100% needs. Resizes with the flex box; no JS.
              [:div.relative.flex-1.min-h-0
               [:ty-scroll-container.absolute.inset-0 {:custom-scrollbar "true" :data-tour "messages"}
                (messages-pane user-key active rooms rows)]]
              ;; the edit composer takes the compose slot while a message is being edited
              (let [save "@post('/edit?user=' + encodeURIComponent($user))"]
                [:div.px-4.pt-3.pb-4.shrink-0 {"data-show" "$editId != ''" :style {:display "none"}}
                 [:ty-textarea {"data-bind" "editText" :size "sm" :rows "1" :resize "none"
                                :min-height "40px" :max-height "160px"
                                "data-on:keydown" (str "evt.target===el && (evt.key==='Escape' ? ($editId='') : "
                                                       "evt.key==='Enter' && !evt.shiftKey && !evt.isComposing "
                                                       "&& (evt.preventDefault(), " save "))")}
                  [:span.flex.items-center.gap-1.t11.ty-text-- {:slot "header"}
                   (icon "pencil" :size "xs") "Editing your message · Esc cancels"]
                  [:span {:slot "footer"}]
                  [:span.flex.gap-2 {:slot "footer"}
                   [:ty-button {:size "md" :appearance "ghost" :flavor "neutral" "data-on:click" "$editId=''"} "Cancel"]
                   [:ty-button {:size "md" :flavor "primary" "data-on:click" save} "Save"]]]])
              [:div {"data-show" "$editId == ''"} (compose user-key active rooms)]]
             [:aside.w-80.shrink-0.border-l.ty-border-.overflow-y-auto.p-4.flex.flex-col.gap-6
              (room-panel user-key active rooms)
              (activity-panel user-key activity)]]
            ;; history popover (patched in by /history) and the write toast
            [:div#panel {:data-tour "history"}]
            (toast nil)
            [:script (hu/raw-string tools-and-tour-js)]
            [:script {:src "/tools-rail.js"}]
            [:script {:src "/scenario.js"}]]]))))

(defn history-panel [_user-key xid]
  [:div#panel.fixed.bottom-24.right-6.z-50.w-80.ty-floating.rounded-xl.shadow-xl.p-4
   {:data-tour "history"}
   [:div.flex.items-center.gap-1.mb-3
    (icon "clock" :size "sm" :cls "ty-text-primary")
    [:span.font-semibold.ty-text+.text-sm "Edit history"]
    [:button.ml-auto.ty-text-.hover:ty-text {"data-on:click" "@get('/clear-panel')"}
     (icon "x" :size "xs")]]
   (let [vs (content-history xid)]
     (if (seq vs)
       [:div.flex.flex-col.gap-2
        (for [{:keys [ts value]} vs]
          [:div.border-l-2.ty-border-primary.pl-2
           [:div.t11.ty-text-- (time-str ts)]
           [:div.ty-text.t13 value]])]
       [:p.t13.ty-text-- "No history yet (audit drain may lag a moment)."]))])

;; ── Datastar SSE ───────────────────────────────────────────────────────────

(defn frag->html [hiccup] (str (h/html hiccup)))

(defn patch-elements [& hiccups]
  ;; SSE framing: a data value may not contain raw line breaks — multiline
  ;; HTML (e.g. a chat message with line breaks) must be split into one
  ;; `data: elements <line>` per line or everything after the first break is
  ;; silently dropped. CR, LF and CRLF all end an SSE line: a lone CR left
  ;; inside one line would let message content inject SSE fields. Several
  ;; top-level elements in one event are each morphed into their id.
  (str "event: datastar-patch-elements\n"
       (->> (str/split (apply str (map frag->html hiccups)) #"\r\n|\r|\n")
            (map #(str "data: elements " %))
            (str/join "\n"))
       "\n\n"))

(defn patch-signals [m]
  (str "event: datastar-patch-signals\ndata: signals " (json/write-str m) "\n\n"))

(def sse-headers {"Content-Type" "text/event-stream" "Cache-Control" "no-cache"})

(defn sse-response [& events]
  {:status 200 :headers sse-headers :body (apply str events)})

(defn engine-answer
  "Run a write; the toast carries the engine's answer, refusal included."
  [f ok-message]
  (try
    (f)
    (toast {:kind :ok :message ok-message})
    (catch clojure.lang.ExceptionInfo e
      (let [{:keys [code category]} (ex-data e)]
        (toast {:kind :error :code code :category (some-> category name) :message (ex-message e)})))))

;; ── Live stream: one per open tab ─────────────────────────────────────────

;; Each open tab gets three live, RLS-scoped watch-queries (DB-backed atoms),
;; all read AS this tab's user. Any change re-renders the live fragments.
;; The message watch is scoped to the rooms the user can read right now, so
;; when the room watch changes that set (a membership change, live), the
;; message watch is reopened over the new set.
(defn release!
  "Closes a stream's watches once, whichever of on-open and on-close gets here last."
  [ch]
  (let [[old _] (swap-vals! conns dissoc ch)]
    (when-let [[rooms-w stats-w msgs-w closed?] (get old ch)]
      (reset! closed? true)
      (remove-watch rooms-w ::rescope)
      (remove-watch stats-w ::render)
      (syn/close-watch! rooms-w)
      (syn/close-watch! stats-w)
      (when-let [m @msgs-w]
        (remove-watch m ::render)
        (syn/close-watch! m)))))

(defn stream [req user-key active]
  (let [uid (user-xid user-key)
        closed? (atom false)]
    (http/as-channel req
                     {:on-open
                      (fn [ch]
                        (http/send! ch {:status 200 :headers sse-headers} false)
                        (try
                          (let [rooms-w (room/watch-rooms {} :acting-as uid :relations room-relations)
                                stats-w (room/watch-activity {} :acting-as uid :relations room-relations)
                                msgs-w  (atom nil)
                                scope   (atom nil)
                                render! (fn []
                                          (let [rooms @rooms-w]
                                            (try
                                              (http/send! ch (patch-elements (rooms-sidebar user-key active rooms @stats-w)
                                                                             (messages-pane user-key active rooms (some-> @msgs-w deref))
                                                                             (compose user-key active rooms)
                                                                             (room-panel user-key active rooms)
                                                                             (activity-panel user-key @stats-w))
                                                          false)
                                              (catch Throwable _ nil))))
                                rescope! (fn [rooms]
                                           (let [visible (xids rooms)
                                                 wanted  (set (if (= "all" active) visible (filter visible [active])))]
                                             (when (and (not @closed?) (not= wanted @scope))
                                               (reset! scope wanted)
                                               (when-let [old @msgs-w]
                                                 (remove-watch old ::render)
                                                 (syn/close-watch! old))
                                               (reset! msgs-w
                                                       (when (seq wanted)
                                                         ;; Any Chat Message change re-runs this user's
                                                         ;; query; the guards decide what comes back.
                                                         (doto (message/watch-list {:rooms (vec wanted)}
                                                                                   :acting-as uid)
                                                           (add-watch ::render (fn [_ _ _ _] (render!)))))))))]
                            (rescope! @rooms-w)
                            (add-watch rooms-w ::rescope (fn [_ _ _ rooms] (rescope! rooms) (render!)))
                            (add-watch stats-w ::render (fn [_ _ _ _] (render!)))
                            (swap! conns assoc ch [rooms-w stats-w msgs-w closed?])
                            (render!)
                            ;; navigation reopens this stream without a page load: the
                            ;; user-bound header follows it here. A false send means the
                            ;; client left during on-open, before on-close could find us.
                            (when-not (http/send! ch (str (patch-elements (user-switcher user-key active)
                                                                          (whoami-chip user-key)
                                                                          (tour-link user-key active))
                                                          (patch-signals {:loading false}))
                                                  false)
                              (release! ch)))
                        (catch Exception e
                          (release! ch)
                          (http/send! ch (str (patch-elements (toast {:kind :error :message (ex-message e)}))
                                              (patch-signals {:loading false}))
                                      false)
                          (http/close ch))))
                      :on-close
                      (fn [ch _]
                        (reset! closed? true)
                        (release! ch))})))

;; ── HTTP ─────────────────────────────────────────────────────────────────

(defn signals [req]
  (let [raw (some-> (:body req) slurp)]
    (when-not (str/blank? raw) (json/read-str raw))))

(defn qp [qs]
  (when qs (into {} (for [p (str/split qs #"&") :let [[k v] (str/split p #"=" 2)]]
                      [k (try (some-> v (java.net.URLDecoder/decode "UTF-8"))
                              (catch Exception _ nil))]))))

(def xid-pattern #"[1-9A-HJ-NP-Za-km-z]{22}")

(defn readable-message
  "Message `xid` if `user-key` may read it — the same RLS-scoped read the page does."
  [user-key xid]
  (when xid
    (first (filter #(= xid (:xid %)) (messages-of user-key (map :xid (rooms-of user-key)))))))

(def user-routes #{"/stream" "/history" "/edit-form" "/send" "/edit" "/delete"
                   "/member/add" "/member/remove" "/room/open"})

(defn route [{:keys [uri request-method] :as req} q user active]
  (case [request-method uri]
    [:get "/"]            (cond
                            user {:status 200 :headers {"Content-Type" "text/html; charset=utf-8"}
                                  :body (page user active)}
                            (seq @people) {:status 302 :headers {"Location" (url "/" :user (first (keys @people)) :room active)}}
                            :else {:status 503 :headers {"Content-Type" "text/plain; charset=utf-8"}
                                   :body "No chat cast on this engine yet: run `bb setup`, then restart the BFF."})
    [:get "/tools-rail.js"]  (serve-js "tools-rail.js")
    [:get "/scenario.js"]    (serve-js "scenario.js")
    [:get "/tour.js"]        (serve-js "tour.js")
    [:get "/tour.json"]      {:status 200
                              :headers {"Content-Type" "application/json"
                                        "Cache-Control" "no-store"}
                              :body (slurp (io/file (.getParentFile (io/file *file*)) ".." "tour.json"))}
    [:get "/stream"]      (stream req user active)
    ;; /history runs as the app's client, so the BFF checks first that this
    ;; user may read the message at all
    [:get "/history"]     (let [msg (get q "msg")]
                            (sse-response (patch-elements (if (and user (readable-message user msg))
                                                            (history-panel user msg)
                                                            [:div#panel]))))
    [:get "/clear-panel"] (sse-response (patch-elements [:div#panel]))
    [:get "/clear-toast"] (sse-response (patch-elements (toast nil)))
    ;; edit: server round-trip avoids escaping content into client JS — load
    ;; the current text into the edit signals (RLS-scoped fetch).
    [:get "/edit-form"]   (let [xid (get q "msg")
                                m (readable-message user xid)]
                            (sse-response (patch-signals {:editId xid :editText (or (:content m) "")})))
    ;; Writes just hit the DB, AS the user. Every open tab refreshes itself
    ;; through its own watch-queries; the response carries only the
    ;; engine's answer (toast) and resets the inputs.
    [:post "/send"]       (let [s (signals req)]
                            (sse-response (patch-elements (engine-answer #(send-message! user active (:content s)) nil))
                                          (patch-signals {:content ""})))
    [:post "/edit"]       (let [s (signals req)]
                            (sse-response (patch-elements (engine-answer #(edit-message! user (:editId s) (:editText s)) "Edited."))
                                          (patch-signals {:editId "" :editText ""})))
    [:post "/delete"]     (sse-response (patch-elements (engine-answer #(delete-message! user (get q "msg")) "Deleted — recoverable from /history.")))
    [:post "/member/add"] (let [s (signals req)]
                            (sse-response (patch-elements (engine-answer #(add-member! user (get q "room") (:newMember s)) "Member added."))
                                          (patch-signals {:newMember ""})))
    [:post "/member/remove"] (sse-response (patch-elements (engine-answer #(remove-member! user (get q "room") (get q "member")) "Member removed.")))
    [:post "/room/open"]  (let [s (signals req)]
                            (sse-response (patch-elements (engine-answer #(open-room! user (:roomName s) (:roomDescription s))
                                                                         (str "Room " (:roomName s) " opened — you administer it.")))
                                          (patch-signals {:roomName "" :roomDescription "" :opening false})))
    ;; `case` matches exact values only, so the prefix routes land here.
    (cond
      (and (= :get request-method) (str/starts-with? uri "/vendor/tooling/"))
      (serve-vendor uri)

      (and (= :get request-method) (str/starts-with? uri "/xsql/"))
      (serve-xsql uri)

      :else {:status 404 :body "not found"})))

(defn handler [{:keys [uri query-string] :as req}]
  (let [q (let [q  (qp query-string)
                ds (some-> (get q "datastar") (#(try (json/read-str %) (catch Exception _ nil))))]
            (merge (into {} (remove (comp nil? val)) {"user" (:user ds) "room" (:room ds)}) q))
        ;; only a cast member acts — never a typo, never the client itself
        user (let [u (get q "user")] (when (contains? @people u) u))
        active (let [r (get q "room")] (if (and r (re-matches xid-pattern r)) r "all"))]
    (cond
      (and (nil? user) (= "/stream" uri))
      (sse-response (patch-signals {:loading false})
                    "event: datastar-patch-elements\ndata: mode append\ndata: selector body\ndata: elements <script>location.href='/'</script>\n\n")

      (and (nil? user) (user-routes uri))
      {:status 400 :headers {"Content-Type" "text/plain; charset=utf-8"} :body "unknown user"}

      :else (route req q user active))))

(defonce server (atom nil))
(defn -main []
  (when @server (@server))
  (let [port (parse-long (env "PORT" "5177"))]
    (reset! server (http/run-server #'handler {:port port}))
    (println (str "Synthigy Chat BFF → http://localhost:" port
                  " (per-tab watch-queries; all DB)"))))

;; Auto-run only when executed as a script (`bb main.clj`). When loaded in an
;; nREPL (load-file), this is skipped — call (-main) yourself; the nREPL keeps
;; the process alive, so no blocking @(promise) is needed.
;; Script mode also opens an nREPL (:1667) so a running BFF can be inspected
;; live — e.g. the watch multiplexer: (:watches @(:mux synthigy.client/*client*)).
(when (= *file* (System/getProperty "babashka.file"))
  (-main)
  ((requiring-resolve 'babashka.nrepl.server/start-server!) {:host "127.0.0.1" :port 1667})
  (spit ".nrepl-port" "1667")
  @(promise))
