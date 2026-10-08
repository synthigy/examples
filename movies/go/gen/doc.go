// Package gen holds the typed Synthigy API that synthigy-gen produces from the
// shared templates in ../../xsql.
//
// generated.go is a build artifact and is git-ignored, as are the schema and IR
// the generator pulls. Produce all three with `go generate ./...` from this
// module root; it needs a running server (see ../generate.go).
package gen
