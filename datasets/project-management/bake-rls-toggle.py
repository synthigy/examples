#!/usr/bin/env python3
"""Bake the demo's RLS-off dataset exports from the guarded ones.

The toggle deploys each dataset twice over its life: guarded, then unguarded,
then back. Two rules shape the artifacts, and getting either wrong makes the
button a no-op:

  * A DEPLOYED VERSION IS IMMUTABLE IN CONTENT — re-deploying one verbatim is
    fine (that is how rollback works), but the unguarded model is different
    content, so it has to be its OWN version, with its own xid.
  * BOTH DATASETS DEFINE `Project Task`. Deploying them in one request folds
    them together and the second create hits "table already exists". The BFF
    deploys one dataset per call.

Output is a plain version export per dataset — the same shape the modeler
writes and the same shape every SDK's `deploy` verb takes verbatim. Nothing
here builds a wire envelope: the client does not need to know transit.
"""
import json
import secrets
import string
import sys
import uuid
from pathlib import Path

DS = Path(__file__).resolve().parent
SOURCES = ["project-management@0.1.2.json", "resource-planning@0.1.0.json"]
ALPHA = string.ascii_letters + string.digits
ERD = "~#synthigy.dataset.core.ERDEntity"


def xid():
    return "".join(secrets.choice(ALPHA) for _ in range(22))


def disarm(version):
    """Same model, guards off — and a version identity of its own."""
    version = json.loads(json.dumps(version))
    version["~:xid"] = xid()
    version["~:name"] = f'{version["~:name"]}-rls-off'
    version["~:euuid"] = "~u" + str(uuid.uuid4())
    entities = version["~:model"]["~#synthigy.dataset.core.ERDModel"]["~:entities"]
    for wrapper in entities.values():
        cfg = wrapper[ERD].get("~:configuration") or {}
        if "~:rls" in cfg:
            cfg["~:rls"] = {"~:guards": [], "~:enabled": False}
    return version


def main():
    out = DS / "deploy"
    out.mkdir(exist_ok=True)
    for name in SOURCES:
        guarded = json.load(open(DS / name))
        off = disarm(guarded)
        target = out / name.replace("@", "-rls-off@")
        json.dump(off, open(target, "w"))
        print(f'{guarded["~:dataset"]["~:name"]:20s} {guarded["~:name"]:8s} -> {target.name}  ({off["~:name"]})')


if __name__ == "__main__":
    sys.exit(main())
