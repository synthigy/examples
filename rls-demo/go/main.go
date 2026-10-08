// Command bff is the Synthigy RLS + analytics showcase: a Go + Datastar + Tyrell
// BFF that renders the SAME query for four users side by side, so row-level
// security is visible at a glance. The BFF is a single confidential, trusted
// OAuth client; it switches identity per panel via the /data `acting_as`
// trusted parameter. No per-user login.
//
// Run (defaults target a local server + the seeded rls-demo-bff client):
//
//	cd rls-demo/go && go run .
//	open http://localhost:5176
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	datastar "github.com/starfederation/datastar-go/datastar"
	synthigy "github.com/synthigy/go"
)

// User is one panel identity. XID feeds the /data acting_as parameter.
type User struct {
	Key     string // url-safe handle
	Name    string
	XID     string
	Flavor  string // Tyrell semantic color: primary|success|warning|danger
	Initial string
}

// roster — the four demo principals (xids from the seeded demo DB).
var roster = []User{
	{Key: "alice", Name: "Alice", XID: "LtaGL8FbjyACjzZEC1Dk9v", Flavor: "primary", Initial: "A"},
	{Key: "bob", Name: "Bob", XID: "NzomzeDJgTPUCSdQojsyBF", Flavor: "success", Initial: "B"},
	{Key: "charlie", Name: "Charlie", XID: "R73HfAB1cwcjethbRUYCCa", Flavor: "warning", Initial: "C"},
	{Key: "diana", Name: "Diana", XID: "TDGoKg8iZRr17Lmn3DCRDu", Flavor: "danger", Initial: "D"},
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// sharedDir resolves examples/shared/ relative to THIS source file rather
// than the working directory, so `go run .` and a built binary invoked from
// anywhere both find it — see examples/shared/README.md.
func sharedDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "shared")
}

// handleShared serves one file from examples/shared/ (tools-rail.js,
// scenario.js, tour.js) — see examples/shared/README.md. Every demo serves
// its own copy of the same source until the try-container hub serves it once
// at /_shared/*.
func handleShared(name string) http.HandlerFunc {
	path := filepath.Join(sharedDir(), name)
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, path)
	}
}

// handleTourJSON serves the domain's tour scenario, shared by every port of
// this domain (examples/shared/scenario.js reads it).
func handleTourJSON(w http.ResponseWriter, r *http.Request) {
	_, file, _, _ := runtime.Caller(0)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, filepath.Join(filepath.Dir(file), "..", "tour.json"))
}

// handleXSQL serves the domain's own .xsql sources — the exact files
// `go generate` compiles the typed API from. The tools rail opens them as
// data-console workspaces, so the visitor sees that these queries are what
// shapes the data this page renders. Restricted to `.xsql` because ../xsql
// also holds the generator's pulled schema.json and IR.
func handleXSQL(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/xsql/")
	if !strings.HasSuffix(name, ".xsql") || strings.ContainsAny(name, "/\\") {
		http.NotFound(w, r)
		return
	}
	_, file, _, _ := runtime.Caller(0)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, filepath.Join(filepath.Dir(file), "..", "xsql", name))
}

// localToolingBundle reports whether examples/scripts/build-tooling.sh has
// dropped a locally built web-component bundle. When it has, the page tells
// the rail to load that instead of the pinned CDN version — the loop for
// testing a component change before @synthigy/tooling is republished. Delete
// the directory and the demo is back on the CDN with no code change.
func localToolingBundle() bool {
	_, err := os.Stat(filepath.Join(sharedDir(), "vendor", "tooling", "tooling.js"))
	return err == nil
}

// hub is a tiny fan-out: every open /stream connection registers a channel and
// gets pinged whenever the data might have changed (BFF write, RLS toggle, or
// an upstream plug event).
type hub struct {
	mu   sync.Mutex
	subs map[chan struct{}]struct{}
}

func newHub() *hub { return &hub{subs: map[chan struct{}]struct{}{}} }

func (h *hub) subscribe() chan struct{} {
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *hub) unsubscribe(ch chan struct{}) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func (h *hub) broadcast() {
	h.mu.Lock()
	for ch := range h.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	h.mu.Unlock()
}

type server struct {
	endpoint string
	hub      *hub
	mu       sync.RWMutex
	byProj   bool // grid pivot: false = a column per user, true = a column per project
}

func main() {
	endpoint := env("SYNTHIGY_ENDPOINT", "http://localhost:7887")
	clientID := env("SYNTHIGY_CLIENT_ID", "rls-demo-bff")
	clientSecret := env("SYNTHIGY_CLIENT_SECRET", "rlsbff-2Wm8Qz5Tn7Vx1Kp4Lr9Cs6Bd3Hf0Ga")
	addr := ":" + env("PORT", "5176")

	// Single-client model: install the process-wide default; every synthigy.*
	// call and the generated gen.* namespaces operate on it. Per-user identity
	// is multiplexed with synthigy.ActingAs, never a second client.
	if err := synthigy.Connect(synthigy.Config{
		Endpoint:     endpoint,
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Timeout:      30 * time.Second,
		KeepAlive:    true,
	}); err != nil {
		log.Fatalf("synthigy connect: %v", err)
	}
	defer synthigy.Disconnect()

	s := &server{endpoint: endpoint, hub: newHub()}

	// Cold start: if the demo data is missing, seed it from the committed JSON
	// fixtures over /data. No REPL, no Clojure — a fresh checkout just works.
	seedCtx, seedCancel := context.WithTimeout(context.Background(), 60*time.Second)
	s.ensureDeployed(seedCtx)
	s.ensureSeeded(seedCtx)
	seedCancel()

	// Upstream plug watch: when project/task/allocation data changes (even
	// from a raw psql write), nudge every open browser stream to refetch. This
	// is notify-then-refetch — we never trust delta payloads for RLS-scoped
	// lists, we just learn "something changed" and re-run each panel's query.
	go s.watchUpstream(context.Background())

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/stream", s.handleStream)
	mux.HandleFunc("/toggle-rls", s.handleToggleRLS)
	mux.HandleFunc("/view", s.handleView)
	mux.HandleFunc("/cycle-task", s.handleCycleTask)
	mux.HandleFunc("/generate-task", s.handleGenerateTask)
	mux.HandleFunc("/reseed", s.handleReseed)
	mux.HandleFunc("/tools-rail.js", handleShared("tools-rail.js"))
	mux.HandleFunc("/scenario.js", handleShared("scenario.js"))
	mux.HandleFunc("/tour.js", handleShared("tour.js"))
	mux.HandleFunc("/tour.json", handleTourJSON)
	mux.Handle("/vendor/tooling/", http.StripPrefix("/vendor/tooling/",
		http.FileServer(http.Dir(filepath.Join(sharedDir(), "vendor", "tooling")))))
	mux.HandleFunc("/xsql/", handleXSQL)

	log.Printf("RLS demo BFF on http://localhost%s  → %s (client %s)", addr, endpoint, clientID)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

// handleIndex serves the shell; Datastar opens the persistent /stream on load.
func (s *server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// ?snapshot inlines the server-rendered grid (no SSE) so headless
	// browsers / no-JS clients see the full UI immediately. The live page
	// (no query) ships a shell and opens the SSE.
	if r.URL.Query().Has("snapshot") {
		w.Write([]byte(indexHTMLWith(s.renderGrid(r.Context()), s.endpoint)))
		return
	}
	w.Write([]byte(indexHTML(s.endpoint)))
}

// handleStream is the persistent Datastar SSE. It renders the grid on connect,
// then re-renders whenever the hub fires (debounced) plus a slow heartbeat.
func (s *server) handleStream(w http.ResponseWriter, r *http.Request) {
	log.Printf("/stream connected from %s", r.RemoteAddr)
	sse := datastar.NewSSE(w, r)
	ctx := r.Context()

	notify := s.hub.subscribe()
	defer s.hub.unsubscribe(notify)

	// Initial paint.
	if err := sse.PatchElements(s.renderGrid(ctx)); err != nil {
		return
	}

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-notify:
			// Coalesce a burst of notifications into one refetch.
			drain(notify)
			time.Sleep(60 * time.Millisecond)
			drain(notify)
			if err := sse.PatchElements(s.renderGrid(ctx)); err != nil {
				return
			}
		case <-heartbeat.C:
			if sse.IsClosed() {
				return
			}
		}
	}
}

func drain(ch chan struct{}) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

// watchUpstream consumes plug touch events for the demo entities and
// nudges the hub. Best-effort: if the stream drops, the SDK reconnects.
func (s *server) watchUpstream(ctx context.Context) {
	w, err := synthigy.Watch(ctx, synthigy.WatchInterest{
		Entities: []string{"project", "project_task", "allocation"},
	})
	if err != nil {
		log.Printf("upstream watch: %v", err)
		return
	}
	defer w.Close()
	for range w.Events() {
		s.hub.broadcast()
	}
}
