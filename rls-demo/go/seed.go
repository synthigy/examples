package main

import (
	"context"
	"log"

	synthigy "github.com/synthigy/go"
	"github.com/synthigy/rls-demo-bff/demo"
)

// ensureDeployed deploys the demo's own model when the server has never seen
// it — the example owns its dataset, so a bare instance needs no REPL and no
// operator. Seeding cannot run before this: there is nothing to write into.
func (s *server) ensureDeployed(ctx context.Context) {
	if demo.Deployed(ctx) {
		return
	}
	if err := s.deployRLS(ctx, true); err != nil {
		log.Printf("startup deploy failed (continuing; the demo will be empty): %v", err)
		return
	}
	log.Printf("cold start: deployed project-management from ../../datasets/project-management/deploy")
}

// ensureSeeded seeds the demo only if it looks empty (the roster's first user
// can't be resolved) — so a cold start against a fresh server self-seeds.
func (s *server) ensureSeeded(ctx context.Context) {
	u, err := synthigy.Get(ctx, "user",
		synthigy.Args{"xid": roster[0].XID},
		synthigy.Selection{"xid": nil})
	if err == nil && u != nil {
		return // already seeded
	}
	if err := demo.Seed(ctx); err != nil {
		log.Printf("startup seed failed (continuing; use /reseed): %v", err)
		return
	}
	log.Printf("cold start: seeded demo data from ../../datasets/project-management/seed over /data")
}
