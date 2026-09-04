#!/usr/bin/env python3
"""
Wait until no source file has been modified for `quiet_seconds`.

Two agents are editing this repo concurrently. Running the test battery, the
installer, or a git commit while the other agent is mid-write produces failures
that are not real (a half-written controller-core.js is a syntax error to every
suite that loads it) and risks committing a truncated file.
"""
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
QUIET = 20          # seconds with no writes => considered settled
TIMEOUT = 300       # give up after this long

watched = list((REPO / "src").glob("*.js")) + list((REPO / "src").glob("*.css"))
watched += list((REPO / "tests").glob("*.cjs")) + list((REPO / "tools").glob("*.py"))

start = time.time()
last_snapshot = None
quiet_since = time.time()

while time.time() - start < TIMEOUT:
    snapshot = {p: p.stat().st_mtime for p in watched if p.exists()}
    if snapshot != last_snapshot:
        if last_snapshot is not None:
            changed = [p.name for p in snapshot
                       if last_snapshot.get(p) != snapshot.get(p)]
            if changed:
                print(f"  [{time.strftime('%H:%M:%S')}] writes detected: {', '.join(sorted(changed))}", flush=True)
        last_snapshot = snapshot
        quiet_since = time.time()
    elif time.time() - quiet_since >= QUIET:
        print(f"  settled: no writes for {QUIET}s ({time.strftime('%H:%M:%S')})")
        break
    time.sleep(2)
else:
    print(f"  TIMEOUT: still being written after {TIMEOUT}s — do not commit")
    raise SystemExit(3)
