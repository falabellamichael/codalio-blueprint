#!/usr/bin/env python3
"""
Compare the installed package against src/, and check that every core symbol the
INSTALLED controller/ui call actually exists in the INSTALLED core.

A partially stale install is worse than a fully stale one: if controller.js is
current but controller-core.js is not, the controller calls functions that do not
exist, renderHostSurfaces() catches the TypeError into a console.warn, and the
sidebar silently renders nothing. That is exactly the reported symptom.
"""
import hashlib
import os
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
PKG = Path(os.environ["LOCALAPPDATA"]) / "RAGWorkspace/extensions/packages/codalio-blueprint/1.0.0"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


FILES = [
    "manifest.js", "controller-core.js", "skills.js", "settings.js", "agent.js",
    "preview.js", "ui.js", "workspace.js", "settings-page.js", "controller.js",
    "codalio-blueprint.css",
]

print("=== installed vs source ===")
stale = []
for name in FILES:
    src_path = SRC / name
    pkg_path = PKG / name
    if not pkg_path.is_file():
        print(f"  MISSING   {name}  (not in the installed package)")
        stale.append(name)
        continue
    if not src_path.is_file():
        print(f"  NO SRC    {name}")
        continue
    same = sha(src_path) == sha(pkg_path)
    print(f"  {'IN SYNC' if same else 'STALE  '}   {name}")
    if not same:
        stale.append(name)

def check_surface(label: str, base: Path) -> list[str]:
    """Report core.* symbols used under `base` that core does not export."""
    core_path = base / "controller-core.js"
    if not core_path.is_file():
        print(f"  {label}: no controller-core.js at {base}")
        return []
    core_text = core_path.read_text(encoding="utf-8")

    export_match = re.search(r"window\.__codalioBlueprintCore = Object\.freeze\(\{(.*?)\}\);", core_text, re.S)
    exported = set()
    if export_match:
        for line in export_match.group(1).splitlines():
            stripped = line.strip().rstrip(",")
            if not stripped or stripped.startswith("//") or stripped.startswith("/*"):
                continue
            # Three real forms appear in the export block:
            #   name            (shorthand property)
            #   name: value     (computed / renamed export, e.g. `writeStore: () => ...`)
            #   NAME            (an exported CONSTANT)
            bare = re.match(r"^([A-Za-z_$][\w$]*)$", stripped)
            keyed = re.match(r"^([A-Za-z_$][\w$]*)\s*:", stripped)
            if bare:
                exported.add(bare.group(1))
            elif keyed:
                exported.add(keyed.group(1))
    print(f"  {label}: core exports {len(exported)} symbols")

    needed = set()
    for name in ("controller.js", "ui.js", "agent.js", "workspace.js", "settings-page.js", "preview.js"):
        path = base / name
        if not path.is_file():
            continue
        needed |= set(re.findall(r"\bcore\.([A-Za-z_$][\w$]*)", strip_comments(path.read_text(encoding="utf-8"))))

    # `store` is an exported object whose properties are reached into directly.
    missing = sorted(s for s in needed if s not in exported and s not in ALLOWED_NON_EXPORT)
    if missing:
        print(f"  {label}: BROKEN — callers use core.{' , core.'.join(missing)}")
        print(f"  {label}:          -> those are not exported, so the page throws at runtime")
    else:
        print(f"  {label}: every core.* symbol the callers use is exported")
    return missing


def strip_comments(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", " ", source, flags=re.S)
    source = re.sub(r"(?m)//.*$", " ", source)
    return source


# Symbols that are legitimately not exports (property access on the store object).
ALLOWED_NON_EXPORT = {"store"}

print()
print("=== cross-module symbol check ===")
# Source first: a live bug is worth catching before it is installed at all.
missing_src = check_surface("source   ", SRC)
missing_pkg = check_surface("installed", PKG)
missing = missing_src + missing_pkg

print()
if stale or missing:
    print(f"ACTION: reinstall. stale={len(stale)} broken-symbols={len(missing)}")
    sys.exit(1)
print("installed package is current and self-consistent")
