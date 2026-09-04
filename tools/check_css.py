#!/usr/bin/env python3
"""
Audit cb-* class coverage between JS and CSS.

Previously this read a HARDCODED list of JS files, so preview.js was never
scanned and its ~40 classes were reported as fully styled when none of them had
any CSS at all. Derive the file list from the directory instead: a module added
later is then covered automatically.

Also separates three things that were previously lumped together:
  * genuinely unstyled classes the page emits
  * template PREFIXES (`cb-run-`, from `cb-run-${status}`) which are not classes
  * ribbon button ids (`cb-new-folder`) which the HOST styles, not us
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
CSS_FILE = SRC / "codalio-blueprint.css"

# Every module that can emit markup. Derived, not hardcoded.
JS = sorted(p.name for p in SRC.glob("*.js") if p.name != "manifest.template.js")
print(f"scanning {len(JS)} JS modules: {', '.join(JS)}")

css = CSS_FILE.read_text(encoding="utf-8")
# Strip CSS comments first: the header comment says "namespaced under .cb-", and
# scanning it as a selector reports a phantom `.cb-` class forever.
css_code = re.sub(r"/\*[\s\S]*?\*/", " ", css)
css_classes = set(re.findall(r"\.((?:cb|tok)[\w-]+)", css_code))

used = {}          # class -> set of files
prefixes = set()   # `cb-run-` style fragments from template literals

for name in JS:
    text = (SRC / name).read_text(encoding="utf-8")

    # Collect ONLY from positions that really carry class names. A blanket
    # `(?:cb|tok)-[\w-]+` sweep also picks up section ids ('cb-files'), ribbon
    # button ids, and action names, which then report as classes needing CSS.
    #
    # Class positions in this codebase:
    #   node('div', 'cb-a cb-b')      second argument
    #   node('div', `cb-a ${x}`)      template form
    #   element.className = 'cb-a'
    #   classList.add('cb-a')
    #   classList.toggle/remove(...)
    candidates = []

    for match in re.finditer(r"\bnode\(\s*'[^']*'\s*,\s*(`[^`]*`|'[^']*')", text):
        candidates.append(match.group(1))
    for match in re.finditer(r"\bclassName\s*=\s*(`[^`]*`|'[^']*')", text):
        candidates.append(match.group(1))
    for match in re.finditer(r"\bclassList\.(?:add|remove|toggle)\(\s*(`[^`]*`|'[^']*')", text):
        candidates.append(match.group(1))
    # Tokenizer rule tables: `{ cls: 'tok-keyword', ... }`. These are data, not
    # markup, but the renderer turns every cls into a span class — so all 26 tok-*
    # colours are genuinely emitted and must not be reported as dead CSS.
    for match in re.finditer(r"\bcls:\s*(`[^`]*`|'[^']*')", text):
        candidates.append(match.group(1))
    # icon(name, extraClass) appends a class to an <i>, e.g.
    # icon('fa-chevron-down cb-select-caret') and icon('fa-brain', 'cb-brain-pulse').
    for match in re.finditer(r"\bicon\(\s*'[^']*'\s*,\s*(`[^`]*`|'[^']*')", text):
        candidates.append(match.group(1))
    for match in re.finditer(r"\bicon\(\s*'([^']*(?:cb|tok)-[\w-][^']*)'", text):
        candidates.append(f"'{match.group(1)}'")

    for chunk in candidates:
        body = chunk[1:-1]
        for token in re.findall(r"(?:cb|tok)-[\w-]+", body):
            # A trailing hyphen means `${...}` interpolation, e.g. `cb-run-${status}`
            # — a prefix, not a class.
            if token.endswith("-"):
                prefixes.add(token)
                continue
            used.setdefault(token, set()).add(name)

print(f"\nJS emits {len(used)} cb-*/tok-* class tokens (+{len(prefixes)} template prefixes)")
print(f"CSS defines {len(css_classes)} cb-*/tok-* classes")

# Ribbon button ids are passed to host.addBtn() and styled by SimpleRAG itself.
RIBBON_IDS = set(re.findall(r"addBtn\(\s*'(cb-[\w-]+)'", (SRC / "ui.js").read_text(encoding="utf-8")))

missing = sorted(token for token in used if token not in css_classes)
ribbon_only = [t for t in missing if t in RIBBON_IDS]
real_missing = [t for t in missing if t not in RIBBON_IDS]

print(f"\n=== UNSTYLED, emitted by us ({len(real_missing)}) ===")
for token in real_missing:
    print(f"  {token:38} <- {', '.join(sorted(used[token]))}")

print(f"\n=== host-styled ribbon ids ({len(ribbon_only)}) — ours to emit, theirs to style ===")
for token in ribbon_only:
    print(f"  {token}")

def loose_tokens(text: str) -> set:
    """
    Every cb-*/tok-* identifier anywhere in a file, including inside ternaries and
    computed strings (`icon('fa-brain', isRunning ? 'cb-brain-pulse' : '')`).

    Used ONLY for the "defined in CSS but never emitted" direction. Reporting live
    CSS as dead is the dangerous error here — someone deletes a rule and the page
    silently loses styling — so this check errs toward keeping. The UNSTYLED
    direction still uses the precise `used` map, because a false "unstyled" report
    is merely noise.
    """
    return set(re.findall(r"(?:cb|tok)-[\w-]*[\w]", text))


all_js_text = "".join((SRC / name).read_text(encoding="utf-8") for name in JS)
loose = loose_tokens(all_js_text)

dead = sorted(
    c for c in css_classes
    if c not in used and c not in loose and not any(c.startswith(p) for p in prefixes)
)
print(f"\n=== defined in CSS but never emitted ({len(dead)}) ===")
for token in dead[:40]:
    print(f"  {token}")
if len(dead) > 40:
    print(f"  ... and {len(dead) - 40} more")

print(f"\ntemplate prefixes (not classes): {', '.join(sorted(prefixes))}")
raise SystemExit(1 if real_missing else 0)
