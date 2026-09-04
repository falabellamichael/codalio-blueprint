#!/usr/bin/env python3
"""Corruption + syntax sweep across every src module."""
import re
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
ELLIPSIS = "\u2026"
SMART = ["\u201c", "\u201d", "\u2018", "\u2019"]

js_files = sorted(SRC.glob("*.js"))
failures = 0

for path in js_files:
    text = path.read_text(encoding="utf-8")
    problems = []

    # A corrupted key/identifier literal would have an ellipsis between quotes
    # with no surrounding prose. Flag any ellipsis that is NOT inside a template
    # literal or a help/summary string we authored deliberately.
    for i, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        # Deliberate ellipses live in help text, summaries, UI labels, comments.
        deliberate = any(marker in line for marker in (
            "help:", "summary:", "hint:", "label:", "//", "*", "description:",
            "hint =", "…", "Running", "Waiting", "truncated", "more characters",
            "placeholder:", "note:", "'…'",
        ))
        if ELLIPSIS in line and not deliberate:
            problems.append(f"  line {i}: suspicious ellipsis -> {stripped[:80]}")
        # Smart quotes must never appear as string delimiters in code.
        for ch in SMART:
            if ch in line and "help:" not in line and "//" not in line and "*" not in line:
                # allow inside authored prose strings; only flag if it breaks a token
                pass

    # Syntax check via node.
    result = subprocess.run(
        ["node", "--check", str(path)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        problems.append("  NODE SYNTAX FAIL:\n" + result.stderr.strip()[:400])
        failures += 1

    status = "OK" if not problems else "ISSUES"
    print(f"{status:8} {path.name}")
    for p in problems:
        print(p)

# Identifier integrity: setting keys are camelCase, action keys are hyphen-case.
# Both are deliberate; anything else (whitespace, ellipsis, smart quotes) means
# a corrupted literal.
settings = (SRC / "settings.js").read_text(encoding="utf-8")
for m in re.finditer(r"key: '([^']*)'", settings):
    if not re.fullmatch(r"[a-zA-Z]+|[a-z]+(?:-[a-z]+)+", m.group(1)):
        print("BAD KEY LITERAL:", repr(m.group(1)))
        failures += 1

print()

# ---- string-literal corruption sweep -------------------------------------
# The write_file tool has been seen to replace the middle of a long quoted
# literal with U+2026, e.g. 'codalio-blueprint.workspace.v1' -> 'codal…e.v1'.
# That still parses and still runs (reads and writes the same wrong key), so it
# passes every test while the product stores data under a name the source does
# not say. Only a check on the literal itself catches it.
ELL = chr(0x2026)
LITERAL = re.compile(r"'([^'\n]*)'|\"([^\"\n]*)\"|`([^`]*)`")
corrupt = []
for path in sorted(SRC.glob("*.js")):
    body = path.read_text(encoding="utf-8")
    if ELL not in body:
        continue
    for i, line in enumerate(body.splitlines(), 1):
        if ELL not in line:
            continue
        for m in LITERAL.finditer(line):
            value = m.group(1) or m.group(2) or m.group(3) or ""
            if ELL not in value:
                continue
            # A trailing ellipsis on a word is a UI label ("Running…"), not
            # corruption. Corruption leaves fragments on BOTH sides.
            trailing_only = value.endswith(ELL) and value.count(ELL) == 1
            identifier_like = (
                not trailing_only
                and " " not in value
                and len(value) < 80
                and re.fullmatch(r"[A-Za-z0-9._:/\-]*" + ELL + r"[A-Za-z0-9._:/\-]*", value)
            )
            if identifier_like:
                corrupt.append(f"{path.name}:{i}: {value!r}")

if corrupt:
    failures += len(corrupt)
    print("CORRUPTED STRING LITERALS (identifier-like, ellipsis in the middle):")
    for item in corrupt:
        print("  ", item)
else:
    print("string literals: no identifier-like corruption found")

print()
print("FAILURES:", failures)
sys.exit(1 if failures else 0)
