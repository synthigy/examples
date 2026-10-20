// Command project-management-bff is a project-management app on Synthigy:
// projects, tasks, people and their roles, where every rule about who may see
// or change what lives in the model as a guard. A Go + Datastar + Tyrell BFF
// holds one confidential, trusted OAuth client and acts for whoever is picked
// in the header through the /data `acting_as` parameter. No per-user login.
//
//	synthigy exec -- go run .
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

	synthigy "github.com/synthigy/go"
	"github.com/synthigy/project-management-bff/demo"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// Person is one of the seeded cast. Nothing about them is pinned here: the
// xids are resolved by name at start, so the app works against any instance
// `go run ./setup` has seeded.
type Person struct {
	Key    string // url handle, the seeded name
	Name   string // display name
	XID    string
	Flavor string // Tyrell semantic color
}

var cast = []*Person{
	{Key: "alice", Name: "Alice", Flavor: "primary"},
	{Key: "bob", Name: "Bob", Flavor: "success"},
	{Key: "charlie", Name: "Charlie", Flavor: "warning"},
	{Key: "diana", Name: "Diana", Flavor: "danger"},
}

func personByKey(k string) *Person {
	for _, p := range cast {
		if p.Key == k {
			return p
		}
	}
	return cast[0]
}

func personByXID(x string) *Person {
	for _, p := range cast {
		if p.XID == x {
			return p
		}
	}
	return nil
}

// resolveCast looks the cast up by name, as the service user.
func resolveCast(ctx context.Context) error {
	keys := make([]any, len(cast))
	for i, p := range cast {
		keys[i] = p.Key
	}
	rows, err := synthigy.Search(ctx, "user", synthigy.Args{"name": synthigy.In(keys...)},
		synthigy.Selection{"name": nil})
	if err != nil {
		return err
	}
	for _, r := range rows {
		n, _ := r["name"].(string)
		x, _ := r["xid"].(string)
		for _, p := range cast {
			if p.Key == n {
				p.XID = x
			}
		}
	}
	for _, p := range cast {
		if p.XID == "" {
			return errMissing(p.Key)
		}
	}
	return nil
}

type errMissing string

func (e errMissing) Error() string { return "user " + string(e) + " not found — run: go run ./setup" }

// sharedDir resolves examples/shared/ relative to THIS source file rather
// than the working directory, so `go run .` and a built binary invoked from
// anywhere both find it — see examples/shared/README.md.
func sharedDir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "shared")
}

// domainFile resolves a file of this domain (tour.json, xsql/) the same way.
func domainFile(parts ...string) string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(append([]string{filepath.Dir(file), ".."}, parts...)...)
}

// handleShared serves one file from examples/shared/ (tools-rail.js,
// scenario.js, tour.js). Every demo serves its own copy of the same source
// until the try-container hub serves it once at /_shared/*.
func handleShared(name string) http.HandlerFunc {
	path := filepath.Join(sharedDir(), name)
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, path)
	}
}

// handleTourJSON serves the domain's tour scenario (examples/shared/scenario.js
// reads it).
func handleTourJSON(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, domainFile("tour.json"))
}

// handleXSQL serves the domain's own .xsql sources — the exact files
// `go generate` compiles the typed API from. The tools rail opens them as
// data-console workspaces. Restricted to `.xsql` because ../xsql also holds
// the generator's pulled schema.json and IR.
func handleXSQL(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/xsql/")
	if !strings.HasSuffix(name, ".xsql") || strings.ContainsAny(name, "/\\") {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, domainFile("xsql", name))
}

// localToolingBundle reports whether examples/scripts/build-tooling.sh has
// dropped a locally built web-component bundle; the page then tells the rail
// to load it instead of the pinned CDN version.
func localToolingBundle() bool {
	_, err := os.Stat(filepath.Join(sharedDir(), "vendor", "tooling", "tooling.js"))
	return err == nil
}

// hub fans "something changed" out to every open /stream. Each stream then
// re-reads as its own user: the hub carries no data.
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
	endpoint    string // the engine the tools rail's components call
	examplesURL string // the examples landing page, when there is one
	hub         *hub
	inbox       *inbox
	writers     writers
}

func main() {
	endpoint := env("SYNTHIGY_ENDPOINT", "http://localhost:7887")
	clientID := env("SYNTHIGY_CLIENT_ID", "project-management-bff")
	addr := ":" + env("PORT", "5176")

	// One client for the whole process. Every call for a person carries
	// synthigy.ActingAs; there is never a second client.
	if err := synthigy.Connect(synthigy.Config{
		Endpoint:     endpoint,
		ClientID:     clientID,
		ClientSecret: env("SYNTHIGY_CLIENT_SECRET", "pmbff-secret"),
		Timeout:      30 * time.Second,
		KeepAlive:    true,
	}); err != nil {
		log.Fatalf("synthigy connect: %v", err)
	}
	defer synthigy.Disconnect()

	s := &server{
		endpoint:    env("SYNTHIGY_PUBLIC_ENDPOINT", endpoint),
		examplesURL: os.Getenv("EXAMPLES_URL"),
		hub:         newHub(),
		inbox:       newInbox(),
	}

	// Cold start: a bare instance gets the model and the cast, so the app
	// never needs an operator. `go run ./setup` does the same, verbosely.
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	if !demo.Deployed(ctx) {
		if _, err := demo.Deploy(ctx); err != nil {
			log.Fatalf("cold start deploy: %v", err)
		}
		log.Print("cold start: deployed " + demo.Export)
	}
	if err := resolveCast(ctx); err != nil {
		seed, lerr := demo.LoadSeed()
		if lerr != nil {
			log.Fatalf("seed.json: %v", lerr)
		}
		if _, err := demo.SeedAll(ctx, seed); err != nil {
			log.Fatalf("cold start seed: %v", err)
		}
		log.Print("cold start: seeded the cast, projects and tasks")
		if err := resolveCast(ctx); err != nil {
			log.Fatal(err)
		}
	}
	cancel()

	// One subscription for the app; each person is re-read as themselves on
	// every change. The source of their notifications: see live.go.
	go s.watch(context.Background())

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/stream", s.handleStream)
	mux.HandleFunc("/act/", s.handleAct)
	mux.HandleFunc("/notifications/read", s.handleRead)
	mux.HandleFunc("/reset", s.handleReset)
	mux.HandleFunc("/tools-rail.js", handleShared("tools-rail.js"))
	mux.HandleFunc("/scenario.js", handleShared("scenario.js"))
	mux.HandleFunc("/tour.js", handleShared("tour.js"))
	mux.HandleFunc("/tour.json", handleTourJSON)
	mux.Handle("/vendor/tooling/", http.StripPrefix("/vendor/tooling/",
		http.FileServer(http.Dir(filepath.Join(sharedDir(), "vendor", "tooling")))))
	mux.HandleFunc("/xsql/", handleXSQL)

	log.Printf("Synthigy Projects on http://localhost%s → %s (client %s)", addr, endpoint, clientID)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
