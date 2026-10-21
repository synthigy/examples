"""Put the Groove Harbor brand on the engine's side of the music flow.

    synthigy exec -- python brand.py

1. Uploads ../brand/ (sign-in, status and error pages, brand.css, logo.svg)
   as the custom-pages bundle "groove-harbor" and serves it. The upload is
   what the console's System → Custom pages screen does, over its HTTP
   endpoints, signed in as DEMO_USER (default admin / admin).
2. Points this app's OAuth client at it: its Login page, its logo, and the
   page /oauth/logout may send people back to. Client settings are data, so
   this is a plain SDK read and write.

Re-runnable: every run stores and serves a new bundle version. The other
examples keep the "default" bundle; only this client changes.
"""

from __future__ import annotations

import io
import os
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import synthigy

BUNDLE = os.environ.get("BRAND_BUNDLE", "groove-harbor")
BRAND_DIR = Path(__file__).resolve().parent.parent / "brand"
ENGINE = os.environ.get("SYNTHIGY_ENDPOINT", "http://localhost:7887").rstrip("/")
CLIENT_ID = os.environ.get("SYNTHIGY_CLIENT_ID", "datastar-music")
BASE_URL = os.environ.get("BASE_URL", "http://localhost:5175").rstrip("/")
DEMO_USER = os.environ.get("DEMO_USER", "admin")
DEMO_PASSWORD = os.environ.get("DEMO_PASSWORD", "admin")


def bundle_zip() -> bytes:
    """../brand/ as a zip, the demo account filled into the HTML."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(BRAND_DIR.iterdir()):
            if not f.is_file() or f.name.startswith("."):
                continue
            data = f.read_bytes()
            if f.suffix == ".html":
                data = (data.decode("utf-8").replace("{{DEMO_USER}}", DEMO_USER)
                        .replace("{{DEMO_PASSWORD}}", DEMO_PASSWORD).encode("utf-8"))
            z.writestr(f.name, data)
    return buf.getvalue()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def upload(zipped: bytes) -> int:
    """Upload and activate the bundle through the console; returns its version."""
    web = urllib.request.build_opener(_NoRedirect)
    cookies: dict[str, str] = {}

    def call(path, data=None, headers=None, method=None):
        headers = dict(headers or {})
        if cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
        req = urllib.request.Request(ENGINE + path, data=data, headers=headers, method=method)
        try:
            r = web.open(req)
        except urllib.error.HTTPError as e:  # the console answers with redirects
            r = e
        # the console session rides a cookie set on these redirects
        for c in r.headers.get_all("Set-Cookie") or []:
            name, _, rest = c.partition("=")
            cookies[name.strip()] = rest.split(";", 1)[0]
        return r.status, r.headers.get("Location") or ""

    call("/console/login", urllib.parse.urlencode(
        {"username": DEMO_USER, "password": DEMO_PASSWORD}).encode())
    _, landed = call(f"/console/custom-pages/upload?name={BUNDLE}", zipped,
                     {"Content-Type": "application/zip"})
    m = re.search(r"[?&]version=(\d+)", landed)
    if not m:
        sys.exit(f"upload failed: {landed or 'no redirect — wrong login, or engine older than 0.3.0?'}")
    version = int(m.group(1))
    _, landed = call(f"/console/custom-pages/activate?name={BUNDLE}&version={version}", b"", method="POST")
    if "activated=1" not in landed:
        sys.exit(f"activate failed: {landed or 'no redirect'}")
    return version


def wire_client() -> dict:
    """Merge the brand into this app's OAuth client settings."""
    client = synthigy.connect()
    rows = client.search("oauth_client", {"id": {"_eq": CLIENT_ID}}, {"xid": None, "settings": None})
    if not rows:
        sys.exit(f"OAuth client {CLIENT_ID!r} not found — run scripts/bootstrap-instance.sh")
    settings = dict(rows[0].get("settings") or {})
    settings["login-page"] = BUNDLE
    settings["logo-url"] = f"{BASE_URL}/brand/logo.svg"
    settings["logout-redirections"] = sorted(set(settings.get("logout-redirections") or []) | {f"{BASE_URL}/signed-out"})
    client.sync("oauth_client", {"xid": rows[0]["xid"], "settings": settings})
    return settings


if __name__ == "__main__":
    v = upload(bundle_zip())
    print(f'bundle "{BUNDLE}" v{v} served at {ENGINE}/login/{BUNDLE}/')
    s = wire_client()
    print(f"{CLIENT_ID}: login page {s['login-page']}, logo {s['logo-url']}")
