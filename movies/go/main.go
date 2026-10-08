// A minimal Synthigy client in Go: one query, then the same query live.
//
// Everything typed here comes out of ../xsql. Nothing typed is committed —
// `go generate ./...` pulls the schema, compiles the templates on the server
// and writes ./gen/generated.go. See ../../README.md for why.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	gen "github.com/synthigy/examples-movies-go/gen"
	synthigy "github.com/synthigy/go"
)

func env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}

// Nullable columns generate as pointers, so a nil is a real absence rather
// than a zero that looks like data.
func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func year(p *int64) string {
	if p == nil {
		return "----"
	}
	return fmt.Sprintf("%d", *p)
}

func main() {
	log.SetFlags(0)

	if err := synthigy.Connect(synthigy.Config{
		Endpoint:     env("SYNTHIGY_ENDPOINT", "http://localhost:7887"),
		ClientID:     os.Getenv("SYNTHIGY_CLIENT_ID"),
		ClientSecret: os.Getenv("SYNTHIGY_CLIENT_SECRET"),
	}); err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer synthigy.Disconnect()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// One query. The row type and the parameter type both come from the
	// template, so a typo here is a compile error rather than a 400.
	movies, err := gen.API.Movie.List(ctx, gen.MovieListParams{})
	if err != nil {
		log.Fatalf("list: %v", err)
	}
	fmt.Printf("%d movies\n", len(movies))
	for _, m := range movies {
		fmt.Printf("  %-44s %s\n", str(m.Title), year(m.ReleaseYear))
	}

	// The same query, live. The template carries `@watch`, so the generator
	// emits this alongside the plain call. Changes anywhere that affect the
	// result set re-run it, scoped to the same principal.
	w, err := gen.API.Movie.WatchList(ctx, gen.MovieListParams{})
	if err != nil {
		log.Fatalf("watch: %v", err)
	}
	defer w.Close()

	fmt.Println("\nwatching — change a movie and it reprints; ctrl-c to stop")
	for {
		select {
		case <-ctx.Done():
			fmt.Println("bye")
			return
		case _, ok := <-w.Events():
			if !ok {
				return
			}
			rows := w.List()
			fmt.Printf("[%s] %d movies\n", time.Now().Format("15:04:05"), len(rows))
		}
	}
}
