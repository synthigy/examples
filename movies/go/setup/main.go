// Deploy the movies model and seed ml-latest-small — run once, before
// `go generate`:
//
//	synthigy exec -- go run ./setup
//
// The same deploy and the same rows as the JS port's `npm run setup`.
package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"

	synthigy "github.com/synthigy/go"
)

const datasets = "../../datasets/movies"

type row = map[string]any

func load(name string) []row {
	b, err := os.ReadFile(filepath.Join(datasets, "movies", name+".json"))
	if err != nil {
		log.Fatal(err)
	}
	var rows []row
	if err := json.Unmarshal(b, &rows); err != nil {
		log.Fatalf("%s: %v", name, err)
	}
	return rows
}

func pick(r row, keys ...string) row {
	out := row{}
	for _, k := range keys {
		out[k] = r[k]
	}
	return out
}

func xidRefs(v any) []row {
	var out []row
	for _, m := range v.([]any) {
		out = append(out, row{"xid": m.(map[string]any)["xid"]})
	}
	return out
}

type phase struct {
	entity string
	rows   []row
}

// phases reshapes the raw files the way the model declares them: actors
// dedupe on Name (UNIQUE) and their movie links follow the kept row,
// ratings and tags carry only their own fields.
func phases() []phase {
	var genres, genreLinks, actors, movies, ratings, tags []row
	for _, g := range load("movie_genres") {
		genres = append(genres, pick(g, "xid", "name"))
	}
	for _, g := range load("movie_genres_mapping") {
		genreLinks = append(genreLinks, row{"xid": g["xid"], "movies": xidRefs(g["movies"])})
	}

	kept, remap := map[any]row{}, map[any]any{}
	for _, a := range load("movie_actors") {
		if k, dup := kept[a["name"]]; dup {
			remap[a["xid"]] = k["xid"]
			continue
		}
		kept[a["name"]] = a
		actors = append(actors, pick(a, "xid", "name", "avatar", "birth_year", "nationality"))
	}
	links, order := map[any]row{}, []any{}
	for _, a := range load("movie_actors_mapping") {
		xid := a["xid"]
		if to, ok := remap[xid]; ok {
			xid = to
		}
		l, ok := links[xid]
		if !ok {
			l = row{"xid": xid, "movies": []row{}}
			links[xid], order = l, append(order, xid)
		}
		seen := map[any]bool{}
		for _, m := range l["movies"].([]row) {
			seen[m["xid"]] = true
		}
		for _, m := range xidRefs(a["movies"]) {
			if !seen[m["xid"]] {
				l["movies"] = append(l["movies"].([]row), m)
				seen[m["xid"]] = true
			}
		}
	}
	var actorLinks []row
	for _, xid := range order {
		actorLinks = append(actorLinks, links[xid])
	}

	for _, m := range load("movies") {
		movies = append(movies, pick(m, "xid", "title", "release_year", "poster"))
	}
	strip := func(r row) row {
		return row{"xid": r["xid"], "value": r["value"], "timestamp": r["timestamp"],
			"movie": row{"xid": r["movie"].(map[string]any)["xid"]}}
	}
	for _, r := range load("user_ratings") {
		ratings = append(ratings, strip(r))
	}
	for _, t := range load("user_tags") {
		tags = append(tags, strip(t))
	}

	return []phase{
		{"Movie Genre", genres},
		{"Movie Actor", actors},
		{"Movie", movies},
		{"Movie Genre", genreLinks},
		{"Movie Actor", actorLinks},
		{"User Rating", ratings},
		{"User Tag", tags},
	}
}

func main() {
	if err := synthigy.Connect(synthigy.Config{
		Endpoint:     os.Getenv("SYNTHIGY_ENDPOINT"),
		ClientID:     os.Getenv("SYNTHIGY_CLIENT_ID"),
		ClientSecret: os.Getenv("SYNTHIGY_CLIENT_SECRET"),
		Timeout:      5 * time.Minute,
	}); err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer synthigy.Disconnect()
	ctx := context.Background()

	export, err := os.ReadFile(filepath.Join(datasets, "Movies Example@0.4.json"))
	if err != nil {
		log.Fatal(err)
	}
	ack, err := synthigy.Deploy(ctx, string(export))
	if err != nil {
		log.Fatalf("deploy: %v", err)
	}
	log.Printf("deployed %s (dataset %s)", ack.Version, ack.Dataset)

	// 500 sync ops per request: one round trip per chunk.
	for _, p := range phases() {
		for i := 0; i < len(p.rows); i += 500 {
			var ops []synthigy.Op
			for _, r := range p.rows[i:min(i+500, len(p.rows))] {
				ops = append(ops, synthigy.OpSync(p.entity, r))
			}
			results, err := synthigy.Exec(ctx, ops)
			if err != nil {
				log.Fatalf("seed %s: %v", p.entity, err)
			}
			for _, r := range results {
				if !r.OK {
					log.Fatalf("seed %s: %s", p.entity, r.Error.Message)
				}
			}
		}
		log.Printf("seeded %s: %d", p.entity, len(p.rows))
	}
}
