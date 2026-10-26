"""Point the OAuth clients at this container's public hosts (start.sh).

The redirect URIs a client accepts are data on its `oauth_client` row, in
`settings`; they depend on PUBLIC_HOST, so they are set on every start rather
than at build time. Runs as the music BFF's client (a SUPERUSER).
"""

import argparse
import os

import synthigy

p = argparse.ArgumentParser()
p.add_argument("--movies", required=True)
p.add_argument("--music", required=True)
p.add_argument("--apps", nargs="+", required=True)
p.add_argument("--engine", required=True)
p.add_argument("--console", required=True)
a = p.parse_args()

client = synthigy.connect(os.environ["SYNTHIGY_ENDPOINT"],
                          client_id=os.environ["SYNTHIGY_CLIENT_ID"],
                          client_secret=os.environ["SYNTHIGY_CLIENT_SECRET"])


def update(where: dict, change) -> None:
    rows = client.search("oauth_client", where, {"xid": None, "settings": None})
    if not rows:
        raise SystemExit(f"no OAuth client matches {where}")
    settings = dict(rows[0].get("settings") or {})
    change(settings)
    client.sync("oauth_client", {"xid": rows[0]["xid"], "settings": settings})


def movies(s):
    s["redirections"] = [f"{a.movies}/auth/callback"]


def music(s):
    s["redirections"] = [f"{a.music}/auth/callback"]
    s["logout-redirections"] = [f"{a.music}/signed-out"]
    s["logo-url"] = f"{a.music}/brand/logo.svg"


def tools(s):
    # The tools rail signs in from each example's page; the console's own
    # tools come back to /console/tools/callback.
    callbacks = [f"{a.console}/console/tools/callback", f"{a.engine}/console/tools/callback"]
    s["redirections"] = list(dict.fromkeys((s.get("redirections") or []) + callbacks + a.apps))
    s["logout-redirections"] = list(dict.fromkeys((s.get("logout-redirections") or []) + a.apps))


update({"id": {"_eq": "movies-js"}}, movies)
update({"id": {"_eq": "datastar-music"}}, music)
update({"name": {"_eq": "Synthigy Tools"}}, tools)
print("OAuth clients now point at", ", ".join(a.apps))
