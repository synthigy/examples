# Movies — Go

The smallest useful Synthigy client: one query, then the same query live.
Roughly 70 lines, no web framework, no UI. Read this one first if you want to
see the shape of the SDK before reading the [access-control
demo](../../rls-demo/go/), which is a full application.

## Prerequisites

- A running engine: `synthigy up` — a fresh install opens the setup wizard;
  pick SQLite. Run from inside this port it still reaches the instance, not
  the port's profile.
- This port's client on it, with the id and secret
  [`.synthigy/.env`](.synthigy/.env) connects as:

  ```bash
  synthigy iam add-client "Movies (Go)" --id movies-go --type confidential \
    --secret moviesgo-secret --grant client_credentials \
    --api Synthigy --role SUPERUSER --trusted --local
  ```

  (`../../scripts/bootstrap-instance.sh` does this for every port at once.)

## Run

```bash
synthigy exec -- go run ./setup      # deploy the movies model + seed ml-latest-small
synthigy exec -- go generate ./...   # see below: this is the interesting step
synthigy exec -- go run .
```

`./setup` builds without the generated code, which is why it can come first:
the generator needs the model on the server. It deploys
[`../../datasets/movies`](../../datasets/movies)'s export and seeds the same
rows as the JS port's `npm run setup`; re-running it is safe.

It prints the movie list, then waits. Change a movie from another client and
the list reprints. Interrupt to stop.

## The codegen step

This is the part worth reading, because it is how a typed client appears for
your own model rather than this one. Nothing typed is committed here. The
templates in [`../xsql`](../xsql) are the only source, shared with the
[JavaScript port](../js/), and `go generate` turns them into a client in three
moves:

1. **Pull the schema.** The generator asks your server for the model you are
   allowed to see. It is filtered by your permissions, so two users can get two
   different schemas from one instance.
2. **Compile the templates.** Your `.xsql` goes to the server, which returns
   the operations, their parameters, and the exact shape of every projection.
   The server owns this, which is why the types match what `/data` will really
   return.
3. **Generate.** Those two produce `gen/generated.go`.

The parameter type and the row type both come from the template, so a mistyped
filter is a compile error rather than a runtime rejection. The template carries
`@watch`, which is why the generator emits `WatchList` next to `List`.

In your own project you would commit the pulled schema and the compiled
representation and generate offline, which is what the generator's defaults
assume. Here all three are gitignored, so the path is one you walk.

## Configuration

Set in [`.synthigy/.env`](.synthigy/.env):

| Variable | Default | Meaning |
|---|---|---|
| `SYNTHIGY_ENDPOINT` | `http://localhost:7887` | Synthigy base URL |
| `SYNTHIGY_CLIENT_ID` | `movies-go` | OAuth client |
| `SYNTHIGY_CLIENT_SECRET` | `moviesgo-secret` | OAuth secret |
