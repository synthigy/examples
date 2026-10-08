# Movies — PHP

Three ways to talk to Synthigy from PHP, cheapest first: raw calls that need no
codegen, generated typed operations, and a batch that fetches a list and its
dashboard numbers in one round trip. A command-line tour and the same
operations behind a small web page.

The PHP SDK has no watch or SSE layer, so this port is reads and writes only.
The shared templates in [`../xsql`](../xsql) carry `@watch` for the languages
that support it; the PHP generator ignores the directive and emits nothing for
it.

## Prerequisites

- A running engine: `synthigy up` — a fresh install opens the setup wizard;
  pick SQLite. Run from inside this port it still reaches the instance, not
  the port's profile.
- This port's client on it, with the id and secret
  [`.synthigy/.env`](.synthigy/.env) connects as:

  ```bash
  synthigy iam add-client "Movies (PHP)" --id movies-php --type confidential \
    --secret moviesphp-secret --grant client_credentials \
    --api Synthigy --role SUPERUSER --trusted --local
  ```

  (`../../scripts/bootstrap-instance.sh` does this for every port at once.)
- PHP 8.1 or newer, with the curl and json extensions.

## Run

```bash
composer install
synthigy exec -- composer setup   # deploy the movies model + seed ml-latest-small
synthigy exec -- composer demo    # the command-line tour
synthigy exec -- composer serve   # the same operations at http://localhost:5176
```

`setup` needs nothing generated; `demo` and `serve` need the generated file. See below.

A static token works instead of client credentials: set `SYNTHIGY_TOKEN`. Some
servers also require an explicit audience for `/data` access, which the demo
reads from the environment.

## The codegen step

Nothing typed is committed here. The templates in [`../xsql`](../xsql) are the
only source, shared with the [JavaScript](../js/) and [Go](../go/) ports, and
one command turns them into a client:

```bash
synthigy exec -- vendor/bin/synthigy-codegen gen ../xsql --pull \
  --out generated/movies_gen.php --namespace 'Synthigy\Examples\Movies'
```

Three files appear and none of them are committed, because producing them is
the point.

1. **The schema** is the model your credentials are allowed to see, filtered by
   permission, so two users can pull two different schemas from one instance.
2. **The compiled representation** is the server's own reading of your
   templates: the operations, their parameters and every projection shape, plus
   a hash of the source it came from.
3. **The generated PHP** is rendered from those two.

Drop `--pull` to regenerate offline from the saved representation. After
editing a template the hash no longer matches, and the generator compiles the
templates on the server again rather than emitting a stale client.

In your own project you would commit the pulled files and generate offline.

## Configuration

Set in [`.synthigy/.env`](.synthigy/.env):

| Variable | Default | Meaning |
|---|---|---|
| `SYNTHIGY_ENDPOINT` | `http://localhost:7887` | Synthigy base URL |
| `SYNTHIGY_CLIENT_ID` | `movies-php` | OAuth client |
| `SYNTHIGY_CLIENT_SECRET` | `moviesphp-secret` | OAuth secret |
| `SYNTHIGY_TOKEN` | — | Static token, instead of the pair above |
