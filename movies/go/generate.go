package main

// Regenerate the typed API in ./gen from the shared templates in ../xsql.
//
// `-pull` is deliberate: the example walks the whole path, pulling the schema
// your credentials are allowed to see and compiling the templates on the
// server, so it needs one running (SYNTHIGY_ENDPOINT plus credentials). Your
// own project would commit the pulled snapshots and generate offline; an
// example that shipped them would skip the step worth reading.
//
//go:generate go run github.com/synthigy/go/cmd/synthigy-gen -pull -xsql ../xsql
