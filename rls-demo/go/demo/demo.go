// Package demo deploys and seeds the RLS demo over /data with the plain SDK.
// It never touches the generated gen/ package, so `go run ./setup` works on a
// fresh clone before `go generate` has anything to pull.
package demo

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	synthigy "github.com/synthigy/go"
)

// Seed fixtures live in ../../datasets/project-management/seed/ (committed JSON, exported from the
// reference model). They carry both euuid + xid so /data sync never drops a
// relation ref. Order matters: role before users (users reference it), entities
// before the rows that link them.
//
// The four users are SHARED with the chat demo, which resolves them by name
// and grants its own role/group links on the same rows. `sync` replaces a
// link-set, so seeding users with it would strip whatever chat granted
// (Internal Member, the chat rooms) and chat posting would 403 — hence
// `stack` for users: it upserts the row and ADDS links, never removes.
var seedFixtures = []struct {
	file   string
	entity string
	array  bool
	stack  bool
}{
	{"role.json", "user_role", false, false},
	{"users.json", "user", true, true},
	{"group.json", "user_group", false, false},
	{"projects.json", "project", true, false},
	{"tasks.json", "project_task", true, false},
	{"allocations.json", "allocation", true, false},
}

// Seed upserts the committed JSON seed over /data as the BFF service user.
// `sync` upserts by xid, so a re-run resets to the pristine seeded state.
func Seed(ctx context.Context) error {
	for _, f := range seedFixtures {
		raw := ReadFirst(
			"../../datasets/project-management/seed/"+f.file,
			"examples/datasets/project-management/seed/"+f.file,
		)
		if raw == "" {
			return fmt.Errorf("seed fixture not found: datasets/seed/%s", f.file)
		}
		recs, err := decodeFixture(raw, f.array)
		if err != nil {
			return fmt.Errorf("%s: %w", f.file, err)
		}
		write := synthigy.Sync
		if f.stack {
			write = synthigy.Stack
		}
		for _, rec := range recs {
			if _, err := write(ctx, f.entity, rec); err != nil {
				return fmt.Errorf("seed %s: %w", f.entity, err)
			}
		}
	}
	return nil
}

func decodeFixture(raw string, array bool) ([]map[string]any, error) {
	if array {
		var recs []map[string]any
		return recs, json.Unmarshal([]byte(raw), &recs)
	}
	var one map[string]any
	if err := json.Unmarshal([]byte(raw), &one); err != nil {
		return nil, err
	}
	return []map[string]any{one}, nil
}

// Deploy deploys both demo datasets, RLS on or off. Each state is its own pair
// of dataset versions: the guarded models the modeler exported, and the
// unguarded ones baked beside them (bake-rls-toggle.py). Re-deploying
// the same version verbatim is a rollback, which the engine allows.
//
// One call per dataset, deliberately: both define Project Task, and deploying
// them in one request folds them together — the second create hits
// `table "project_task" already exists` and the model lands half-applied.
func Deploy(ctx context.Context, on bool) error {
	files := []string{"project-management@0.1.2.json", "resource-planning@0.1.0.json"}
	dir := "../../datasets/project-management"
	if !on {
		files = []string{"project-management-rls-off@0.1.2.json", "resource-planning-rls-off@0.1.0.json"}
		dir += "/deploy"
	}
	for _, f := range files {
		// The export travels verbatim; the server decodes it.
		export := ReadFirst(dir+"/"+f, "examples/datasets/project-management/"+f)
		if export == "" {
			return fmt.Errorf("dataset export not found: %s/%s", dir, f)
		}
		if _, err := synthigy.Deploy(ctx, export); err != nil {
			return err
		}
	}
	return nil
}

// Deployed reports whether the demo model is already on the server.
func Deployed(ctx context.Context) bool {
	_, err := synthigy.Search(ctx, "project_task", synthigy.Args{}, synthigy.Selection{"xid": nil})
	return err == nil
}

// ReadFirst returns the first of `paths` that exists, or "".
func ReadFirst(paths ...string) string {
	for _, p := range paths {
		if b, err := os.ReadFile(p); err == nil {
			return string(b)
		}
	}
	return ""
}
