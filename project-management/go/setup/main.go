// Deploy the Project Management model and seed its cast — run once, before
// `go generate`:
//
//	synthigy exec -- go run ./setup
package main

import (
	"context"
	"log"
	"os"
	"time"

	synthigy "github.com/synthigy/go"
	"github.com/synthigy/project-management-bff/demo"
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

	ack, err := demo.Deploy(ctx)
	if err != nil {
		log.Fatalf("deploy: %v", err)
	}
	log.Printf("deployed %s %s", demo.DatasetName, ack.Version)

	seed, err := demo.LoadSeed()
	if err != nil {
		log.Fatalf("seed.json: %v", err)
	}
	res, err := demo.SeedAll(ctx, seed)
	if err != nil {
		log.Fatalf("seed: %v", err)
	}
	log.Printf("seeded %d users, %d projects, %d tasks", res.Users, res.Projects, res.Tasks)
	if res.ProjectsExisted {
		log.Print("projects were already there: their tasks are left as they are")
	}
}
