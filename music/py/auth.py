"""Sessions + cookies for the datastar-music demo's browser login.

BFF pattern — the browser never sees a token. The OIDC protocol half
(PKCE, authorize URL, code exchange, id_token → user) is the SDK's
`client.login`; what lives here is what the SDK deliberately leaves to
the app: the session store and its cookie.

Sessions live in a dict mirrored to a JSON file next to this module, so
`uvicorn --reload` (which restarts the process on every code edit) does
NOT log everyone out. Production: swap for Redis/Postgres.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from collections.abc import Sequence
from dataclasses import dataclass, field

SESSION_COOKIE = "datastar_music_sid"
SESSION_TTL = 8 * 60 * 60  # seconds


@dataclass
class User:
    name: str
    xid: str | None = None
    scopes: Sequence[str] = field(default_factory=list)


@dataclass
class Session:
    sid: str
    tokens: dict
    user: User
    expires_at: float


# sid → Session, file-mirrored
_SESSIONS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              ".sessions.json")


def _load_sessions() -> dict[str, Session]:
    try:
        with open(_SESSIONS_FILE) as f:
            raw = json.load(f)
        return {sid: Session(sid, s["tokens"],
                             User(s["user"]["name"], s["user"].get("xid"),
                                  s["user"].get("scopes") or []),
                             s["expires_at"])
                for sid, s in raw.items()}
    except Exception:
        return {}


def _save_sessions() -> None:
    data = {sid: {"tokens": s.tokens, "expires_at": s.expires_at,
                  "user": {"name": s.user.name, "xid": s.user.xid,
                           "scopes": list(s.user.scopes)}}
            for sid, s in _sessions.items()}
    try:
        tmp = _SESSIONS_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, _SESSIONS_FILE)
    except OSError:
        pass


_sessions: dict[str, Session] = _load_sessions()


def _sweep() -> None:
    now = time.time()
    expired = [k for k, s in _sessions.items() if s.expires_at < now]
    for sid in expired:
        _sessions.pop(sid, None)
    if expired:
        _save_sessions()


def get_session(sid: str | None) -> Session | None:
    if not sid:
        return None
    sess = _sessions.get(sid)
    if not sess:
        return None
    if sess.expires_at < time.time():
        _sessions.pop(sid, None)
        return None
    return sess


def drop_session(sid: str | None) -> None:
    if sid and _sessions.pop(sid, None):
        _save_sessions()


def create_session(login: dict) -> str:
    """Store a completed `client.login.complete()` result; returns the sid."""
    _sweep()
    u = login["user"]
    sid = secrets.token_urlsafe(24)
    _sessions[sid] = Session(sid, login["tokens"],
                             User(u["name"] or "?", u["xid"], u["scopes"]),
                             time.time() + SESSION_TTL)
    _save_sessions()
    return sid


def cookie_header(sid: str) -> str:
    return (f"{SESSION_COOKIE}={sid}; Path=/; HttpOnly; SameSite=Lax; "
            f"Max-Age={SESSION_TTL}")


def clear_cookie_header() -> str:
    return f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
