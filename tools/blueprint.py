#!/usr/bin/env python3
"""
Codalio Blueprint for SimpleRAG — installer / uninstaller / status.

Registers the plug-in in SimpleRAG's OWN local-extension registry, which lives
outside the SimpleRAG source tree:

    %LOCALAPPDATA%\\RAGWorkspace\\extensions\\
        registry.json
        packages\\codalio-blueprint\\<version>\\
            manifest.json
            codalio-blueprint.css
            manifest.js
            controller-core.js
            skills.js
            agent.js
            ui.js
            controller.js

SimpleRAG's frontend server (PDF_parser/chat_frontend_server.py) SHA256-verifies
every declared asset on each request and injects the surviving <link>/<script>
tags into the Advanced page at serve time. No SimpleRAG file on disk is read,
written, or modified — install and uninstall are fully reversible.

Usage:
    python tools/blueprint.py install   [--extension-home PATH] [--dry-run]
    python tools/blueprint.py uninstall [--extension-home PATH] [--keep-data]
    python tools/blueprint.py status    [--extension-home PATH]
    python tools/blueprint.py package   [--out PATH]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "src"
PLUGIN_JSON = SRC_DIR / "plugin.json"
MANIFEST_TEMPLATE = SRC_DIR / "manifest.template.js"
MANIFEST_PLACEHOLDER = "/*__MANIFEST_JSON__*/null"

PLUGIN_ID = "codalio-blueprint"
SURFACES = ["advanced"]
SCHEMA_VERSION = 1

# Script load order matters: each module reads the ones before it.
SCRIPT_SOURCES = [
    "manifest.js",
    "controller-core.js",
    "skills.js",
    "settings.js",
    "agent.js",
    "preview.js",
    "ui.js",
    "workspace.js",
    "settings-page.js",
    "controller.js",
]
STYLE_SOURCES = ["codalio-blueprint.css"]

MAX_ASSETS = 32
MAX_ASSET_BYTES = 8 * 1024 * 1024
MAX_EXTENSION_BYTES = 16 * 1024 * 1024


# ----------------------------------------------------------------------
# Registry location — mirrors chat_frontend_server.local_extension_root()
# ----------------------------------------------------------------------

def extension_home(override: str | None = None) -> Path:
    """Resolve the registry root exactly the way SimpleRAG's server does."""
    if override:
        return Path(override).expanduser().resolve()

    configured = os.environ.get("PYMU_RAG_EXTENSION_HOME")
    if configured:
        return Path(configured).expanduser().resolve()

    runtime_home = os.environ.get("PYMU_RAG_HOME")
    if runtime_home:
        return Path(runtime_home).expanduser().resolve().parent / "extensions"

    local_app_data = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local_app_data).expanduser().resolve() / "RAGWorkspace" / "extensions"


def package_dir(home: Path, version: str) -> Path:
    return home / "packages" / PLUGIN_ID / version


# ----------------------------------------------------------------------
# Build
# ----------------------------------------------------------------------

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def load_plugin_manifest() -> dict:
    if not PLUGIN_JSON.is_file():
        raise SystemExit(f"error: missing {PLUGIN_JSON}")
    return json.loads(PLUGIN_JSON.read_text(encoding="utf-8"))


def build_manifest_js(plugin: dict) -> bytes:
    """Render manifest.template.js with the real manifest inlined."""
    if not MANIFEST_TEMPLATE.is_file():
        raise SystemExit(f"error: missing {MANIFEST_TEMPLATE}")
    template = MANIFEST_TEMPLATE.read_text(encoding="utf-8")
    if MANIFEST_PLACEHOLDER not in template:
        raise SystemExit(
            f"error: {MANIFEST_TEMPLATE.name} no longer contains {MANIFEST_PLACEHOLDER}"
        )
    payload = json.dumps(plugin, separators=(",", ":"), ensure_ascii=False)
    # Keep the injected JSON a single JS expression: no line terminators inside.
    payload = payload.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    return template.replace(MANIFEST_PLACEHOLDER, payload).encode("utf-8")


def collect_assets(plugin: dict) -> list[tuple[str, bytes]]:
    """Return (registry-relative path, bytes) for every declared asset."""
    assets: list[tuple[str, bytes]] = []
    for name in STYLE_SOURCES:
        path = SRC_DIR / name
        if not path.is_file():
            raise SystemExit(f"error: missing style source {path}")
        assets.append((name, path.read_bytes()))
    for name in SCRIPT_SOURCES:
        if name == "manifest.js":
            assets.append((name, build_manifest_js(plugin)))
            continue
        path = SRC_DIR / name
        if not path.is_file():
            raise SystemExit(f"error: missing script source {path}")
        assets.append((name, path.read_bytes()))
    return assets


def validate_assets(assets: list[tuple[str, bytes]]) -> None:
    """Enforce the same limits chat_frontend_server.py applies at serve time."""
    if len(assets) > MAX_ASSETS:
        raise SystemExit(f"error: {len(assets)} assets exceeds the host limit of {MAX_ASSETS}")
    total = 0
    for name, data in assets:
        if not data:
            raise SystemExit(f"error: asset {name} is empty")
        if len(data) > MAX_ASSET_BYTES:
            raise SystemExit(
                f"error: asset {name} is {len(data)} bytes, over the {MAX_ASSET_BYTES}-byte host limit"
            )
        total += len(data)
    if total > MAX_EXTENSION_BYTES:
        raise SystemExit(
            f"error: total payload {total} bytes exceeds the {MAX_EXTENSION_BYTES}-byte host limit"
        )


def build_extension_manifest(plugin: dict, assets: list[tuple[str, bytes]]) -> bytes:
    """The per-package manifest.json the host validates on every request."""
    scripts = [
        {"path": name, "sha256": sha256_bytes(data), "size": len(data)}
        for name, data in assets
        if name.endswith(".js")
    ]
    # Preserve declared load order rather than the styles-first collection order.
    order = {name: index for index, name in enumerate(SCRIPT_SOURCES)}
    scripts.sort(key=lambda item: order.get(item["path"], 999))
    styles = [
        {"path": name, "sha256": sha256_bytes(data), "size": len(data)}
        for name, data in assets
        if name.endswith(".css")
    ]
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "id": PLUGIN_ID,
        "version": plugin["version"],
        "enabled": True,
        "surfaces": SURFACES,
        "scripts": scripts,
        "styles": styles,
    }
    return json.dumps(manifest, separators=(",", ":")).encode("utf-8")


# ----------------------------------------------------------------------
# Registry read/write
# ----------------------------------------------------------------------

def read_registry(home: Path) -> dict:
    path = home / "registry.json"
    if not path.is_file():
        return {"schema_version": SCHEMA_VERSION, "extensions": []}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"warning: could not read {path} ({exc}); starting a fresh registry")
        return {"schema_version": SCHEMA_VERSION, "extensions": []}
    if not isinstance(parsed, dict) or parsed.get("schema_version") != SCHEMA_VERSION:
        print(f"warning: {path} is not a schema-v1 registry; starting a fresh one")
        return {"schema_version": SCHEMA_VERSION, "extensions": []}
    entries = parsed.get("extensions")
    if not isinstance(entries, list):
        entries = []
    parsed["extensions"] = [entry for entry in entries if isinstance(entry, dict)]
    return parsed


def write_registry(home: Path, registry: dict) -> None:
    home.mkdir(parents=True, exist_ok=True)
    path = home / "registry.json"
    path.write_text(
        json.dumps(registry, separators=(",", ":")),
        encoding="utf-8",
    )


def other_entries(registry: dict) -> list[dict]:
    """Every registered extension except ours — never touched by uninstall."""
    return [entry for entry in registry["extensions"] if entry.get("id") != PLUGIN_ID]


# ----------------------------------------------------------------------
# Commands
# ----------------------------------------------------------------------

def command_install(home: Path, dry_run: bool) -> int:
    plugin = load_plugin_manifest()
    version = str(plugin["version"])
    assets = collect_assets(plugin)
    validate_assets(assets)
    extension_manifest = build_extension_manifest(plugin, assets)
    manifest_hash = sha256_bytes(extension_manifest)

    target = package_dir(home, version)
    print(f"Plug-in        : {plugin['name']} {version}")
    print(f"Publisher      : {plugin.get('publisher', {}).get('name', 'unknown')}")
    print(f"Registry root  : {home}")
    print(f"Package dir    : {target}")
    print(f"Surfaces       : {', '.join(SURFACES)}")
    print(f"Manifest sha256: {manifest_hash}")
    print("Assets:")
    for name, data in assets:
        print(f"  {name:<24} {len(data):>8,} bytes  {sha256_bytes(data)[:16]}…")
    print(f"  {'manifest.json':<24} {len(extension_manifest):>8,} bytes  {manifest_hash[:16]}…")

    if dry_run:
        print("\n--dry-run: nothing was written.")
        return 0

    # Write the new versioned package first, then flip the registry. A failed
    # copy therefore cannot leave the registry pointing at a missing package.
    target.mkdir(parents=True, exist_ok=True)
    for name, data in assets:
        (target / name).write_bytes(data)
    (target / "manifest.json").write_bytes(extension_manifest)

    # Drop the schema-v1 plug-in manifest alongside the payload for reference.
    # It is not declared as an asset, so the host never serves or executes it.
    (target / "plugin.json").write_bytes(
        json.dumps(plugin, indent=2, ensure_ascii=False).encode("utf-8")
    )

    registry = read_registry(home)
    registry["extensions"] = other_entries(registry)
    registry["extensions"].append(
        {
            "id": PLUGIN_ID,
            "version": version,
            "enabled": True,
            "manifest_sha256": manifest_hash,
        }
    )
    write_registry(home, registry)

    # Remove stale versions of this plug-in only; other extensions are untouched.
    packages = home / "packages" / PLUGIN_ID
    if packages.is_dir():
        for entry in sorted(packages.iterdir()):
            if entry.is_dir() and entry.name != version:
                shutil.rmtree(entry, ignore_errors=True)
                print(f"Removed previous version: {entry.name}")

    print("\nInstalled. Restart SimpleRAG (or reload the Advanced page) and the")
    print("Blueprint icon appears in the far-left app bar.")
    return 0


def command_uninstall(home: Path, keep_data: bool) -> int:
    registry = read_registry(home)
    ours = [entry for entry in registry["extensions"] if entry.get("id") == PLUGIN_ID]
    packages = home / "packages" / PLUGIN_ID

    if not ours and not packages.is_dir():
        print("Codalio Blueprint is not installed — nothing to do.")
        return 0

    for entry in ours:
        print(f"Unregistering {PLUGIN_ID} {entry.get('version', '?')}")
    registry["extensions"] = other_entries(registry)
    write_registry(home, registry)

    if packages.is_dir():
        shutil.rmtree(packages, ignore_errors=True)
        print(f"Removed package files: {packages}")

    remaining = home / "packages"
    if remaining.is_dir() and not any(remaining.iterdir()):
        remaining.rmdir()
    if not ours and not (home / "registry.json").exists():
        pass

    print("\nUninstalled. No SimpleRAG file was ever modified, so nothing else")
    print("needs restoring. Reload the Advanced page and the Blueprint icon is gone.")
    if not keep_data:
        print(
            "\nBlueprint's generated documents and run history still live in the\n"
            "browser profile under the codalio-blueprint.* localStorage keys.\n"
            "Reinstalling restores them. Clear them from Blueprint > Settings, or\n"
            "from the browser's site data for this app, if you want them gone."
        )
    return 0


def command_status(home: Path) -> int:
    registry_path = home / "registry.json"
    print(f"Registry root : {home}")
    print(f"registry.json : {'present' if registry_path.is_file() else 'absent'}")
    registry = read_registry(home)
    ours = [entry for entry in registry["extensions"] if entry.get("id") == PLUGIN_ID]
    print(f"Registered    : {len(registry['extensions'])} extension(s) total")

    if not ours:
        print(f"{PLUGIN_ID}: NOT installed")
        return 1

    entry = ours[0]
    version = str(entry.get("version", ""))
    target = package_dir(home, version)
    print(f"{PLUGIN_ID}: installed, version {version}, enabled={entry.get('enabled')}")
    print(f"Package dir   : {target} ({'present' if target.is_dir() else 'MISSING'})")

    manifest_path = target / "manifest.json"
    if manifest_path.is_file():
        actual = sha256_file(manifest_path)
        declared = str(entry.get("manifest_sha256", ""))
        print(f"Manifest hash : {'OK' if actual == declared else 'MISMATCH'} ({actual[:16]}…)")
        if actual != declared:
            print("  -> the host will refuse to inject this extension; reinstall it.")
            return 2
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print("  -> manifest.json is not valid JSON; reinstall.")
            return 2
        for kind in ("scripts", "styles"):
            for asset in manifest.get(kind, []):
                path = target / str(asset.get("path", ""))
                if not path.is_file():
                    print(f"  -> MISSING asset {asset.get('path')}")
                    return 2
                actual_hash = sha256_file(path)
                if actual_hash != str(asset.get("sha256", "")):
                    print(f"  -> HASH MISMATCH for {asset.get('path')}; reinstall.")
                    return 2
        print("Assets        : all present and hash-valid")
    else:
        print("Manifest      : MISSING — reinstall the plug-in")
        return 2

    print("\nThe host injects these into the Advanced page (/gui/) at serve time.")
    return 0


def command_package(out: Path) -> int:
    plugin = load_plugin_manifest()
    assets = collect_assets(plugin)
    validate_assets(assets)
    extension_manifest = build_extension_manifest(plugin, assets)

    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(".ragworkspace-plugin/plugin.json", json.dumps(plugin, indent=2, ensure_ascii=False))
        archive.writestr("package/manifest.json", extension_manifest)
        for name, data in assets:
            archive.writestr(f"package/{name}", data)
        for extra in ("README.md", "LICENSE"):
            path = REPO_ROOT / extra
            if path.is_file():
                archive.writestr(extra, path.read_bytes())
    print(f"Wrote {out} ({out.stat().st_size:,} bytes)")
    return 0


def command_test(only: str | None, quick: bool) -> int:
    """Run the full verification battery.

    Node suites are DISCOVERED from tests/*.test.cjs rather than hardcoded, so a
    suite added later cannot be silently skipped — the failure mode that let the
    previewer ship untested. Static checks (string-literal corruption, CSS class
    coverage, install freshness) run afterwards unless --quick.

    --only NAME runs a single suite substring match, for iterating on one.
    """
    tests_dir = REPO_ROOT / "tests"
    suites = sorted(tests_dir.glob("*.test.cjs"))
    if not suites:
        print("error: no tests/*.test.cjs suites found")
        return 2

    if only:
        suites = [s for s in suites if only in s.name]
        if not suites:
            print(f"error: --only {only!r} matched no suite")
            return 2

    node = shutil.which("node") or "node"
    print(f"=== node suites ({len(suites)}) ===")
    failed: list[str] = []
    for suite in suites:
        result = subprocess.run(
            [node, str(suite)],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=240,
        )
        status = "PASS" if result.returncode == 0 else "FAIL"
        print(f"  {suite.name:<38} {status}")
        if result.returncode != 0:
            failed.append(suite.name)
            # Show the tail so a failure is diagnosable without a re-run.
            tail = "\n".join((result.stderr or result.stdout).strip().splitlines()[-12:])
            if tail:
                print("    " + tail.replace("\n", "\n    "))

    if quick:
        print()
        return 1 if failed else 0

    # ---- static checks --------------------------------------------------
    # Each is a standalone script under tools/; run them the same way and treat a
    # non-zero exit as a failure. These catch classes of bug the suites cannot:
    # corrupted string literals, unstyled CSS, and a stale installed package.
    static = [
        ("string-literal integrity", "check_source.py"),
        ("CSS class coverage", "check_css.py"),
    ]
    print()
    print("=== static checks ===")
    python = sys.executable or "python"
    for label, script in static:
        path = REPO_ROOT / "tools" / script
        if not path.is_file():
            print(f"  {label:<38} SKIP (no tools/{script})")
            continue
        env = dict(os.environ, PYTHONPATH="")
        result = subprocess.run(
            [python, str(path)], cwd=str(REPO_ROOT),
            capture_output=True, text=True, timeout=120, env=env,
        )
        status = "PASS" if result.returncode == 0 else "FAIL"
        print(f"  {label:<38} {status}")
        if result.returncode != 0:
            failed.append(label)
            tail = "\n".join((result.stdout + result.stderr).strip().splitlines()[-12:])
            if tail:
                print("    " + tail.replace("\n", "\n    "))

    # The install-freshness check only applies once the plug-in is installed; if
    # the package dir is absent, report it as not-installed rather than a failure.
    installcheck = REPO_ROOT / "tools" / "check_install.py"
    if installcheck.is_file():
        env = dict(os.environ, PYTHONPATH="")
        result = subprocess.run(
            [python, str(installcheck)], cwd=str(REPO_ROOT),
            capture_output=True, text=True, timeout=120, env=env,
        )
        if "could not locate" in (result.stdout + result.stderr).lower():
            print("  install freshness                     SKIP (not installed)")
        else:
            status = "PASS" if result.returncode == 0 else "FAIL"
            print(f"  {'install freshness':<38} {status}")
            if result.returncode != 0:
                failed.append("install freshness")
                print("    -> run: python tools/blueprint.py install")

    print()
    if failed:
        print(f"FAILURES ({len(failed)}): {', '.join(failed)}")
        return 1
    print("all checks passed")
    return 0


def command_verify(simplerag: str | None) -> int:
    """Validate the manifest with SimpleRAG's own schema-v1 contract validator.

    Uses GUI/extension_contract.py from the SimpleRAG checkout, the same code
    path the app's installer, gallery review, and startup discovery use — so a
    pass here means the host will accept the plug-in.
    """
    candidates = [
        simplerag,
        os.environ.get("SIMPLERAG_ROOT"),
        "D:/PyMu/work_on_rag-main",
        str(Path.home() / "work_on_rag-main"),
    ]
    root = None
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if (path / "GUI" / "extension_contract.py").is_file():
            root = path
            break
    if root is None:
        print(
            "warning: could not locate a SimpleRAG checkout with "
            "GUI/extension_contract.py; pass --simplerag <path> to validate "
            "against the host's real contract. Skipping host validation."
        )
        return 0

    sys.path.insert(0, str(root / "GUI"))
    try:
        import extension_contract  # noqa: PLC0415 — SimpleRAG's validator module
    except Exception as exc:  # pragma: no cover — environment dependent
        print(f"warning: could not import extension_contract from {root}: {exc}")
        return 0
    finally:
        if str(root / "GUI") in sys.path:
            sys.path.remove(str(root / "GUI"))

    plugin = load_plugin_manifest()
    try:
        extension_contract.validate_manifest(plugin)
    except extension_contract.ManifestValidationError as exc:
        print(f"FAILED host validation against {root}:")
        for error in exc.errors:
            print(f"  - {error}")
        return 2

    page = plugin["contributes"]["pages"][0]
    print(f"Host validation : PASS ({root})")
    print(f"  plug-in id    : {plugin['id']} {plugin['version']}")
    print(f"  app-bar page  : {page['id']} -> appId supplied by the controller")
    print(f"  icon / order  : {page['icon']} / {page['order']}")
    print(f"  permissions   : {', '.join(p['id'] for p in plugin['permissions'])}")
    print(f"  capabilities  : {', '.join(plugin['frontend']['capabilities'])}")
    print(f"  commands      : {len(plugin['contributes']['commands'])}")
    print(f"  exporters     : {len(plugin['contributes'].get('exporters', []))}")
    return 0


# ----------------------------------------------------------------------

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="blueprint.py",
        description="Install, uninstall, or inspect the Codalio Blueprint SimpleRAG plug-in.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    install = sub.add_parser("install", help="register the plug-in with SimpleRAG")
    install.add_argument("--extension-home", help="override the registry root")
    install.add_argument("--dry-run", action="store_true", help="show what would be written")

    uninstall = sub.add_parser("uninstall", help="unregister and remove the plug-in")
    uninstall.add_argument("--extension-home", help="override the registry root")
    uninstall.add_argument(
        "--keep-data",
        action="store_true",
        help="do not print the note about browser-profile project data",
    )

    status = sub.add_parser("status", help="verify the installed package and hashes")
    status.add_argument("--extension-home", help="override the registry root")

    package = sub.add_parser("package", help="build a distributable .zip of the plug-in")
    package.add_argument("--out", help="output zip path")

    verify = sub.add_parser(
        "verify", help="validate the manifest with SimpleRAG's own contract validator"
    )
    verify.add_argument("--simplerag", help="path to the SimpleRAG checkout")

    test = sub.add_parser(
        "test", help="run every test suite plus the static integrity checks"
    )
    test.add_argument("--only", help="run only suites whose name contains this string")
    test.add_argument("--quick", action="store_true", help="node suites only; skip static checks")

    args = parser.parse_args(argv)
    if args.command == "package":
        out = Path(args.out) if args.out else REPO_ROOT / "dist" / f"{PLUGIN_ID}-{load_plugin_manifest()['version']}.zip"
        return command_package(out)
    if args.command == "verify":
        return command_verify(args.simplerag)
    if args.command == "test":
        return command_test(args.only, args.quick)

    home = extension_home(getattr(args, "extension_home", None))
    if args.command == "install":
        return command_install(home, args.dry_run)
    if args.command == "uninstall":
        return command_uninstall(home, args.keep_data)
    return command_status(home)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
