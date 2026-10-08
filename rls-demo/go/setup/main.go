// Deploy the demo's model and seed its cast — run once, before `go generate`:
//
//	synthigy exec -- go run ./setup
package main

import (
	"context"
	"log"
	"os"
	"time"

	synthigy "github.com/synthigy/go"
	"github.com/synthigy/rls-demo-bff/demo"
)

func main() {
	if err := synthigy.Connect(synthigy.Config{
		Endpoint:     os.Getenv("SYNTHIGY_ENDPOINT"),
		ClientID:     os.Getenv("SYNTHIGY_CLIENT_ID"),
		ClientSecret: os.Getenv("SYNTHIGY_CLIENT_SECRET"),
		Timeout:      60 * time.Second,
	}); err != nil {
		log.Fatalf("connect: %v", err)
	}
	defer synthigy.Disconnect()
	ctx := context.Background()

	if err := demo.Deploy(ctx, true); err != nil {
		log.Fatalf("deploy: %v", err)
	}
	log.Print("deployed project-management + resource-planning")
	if err := demo.Seed(ctx); err != nil {
		log.Fatalf("seed: %v", err)
	}
	log.Print("seeded the demo cast")
}
