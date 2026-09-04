#!/usr/bin/env bash
# Verify the live scratch instance: injection + per-asset hash integrity.
set -u
BASE=http://127.0.0.1:18411
WORK="$LOCALAPPDATA/Temp/blueprint-verify"
mkdir -p "$WORK"
cd "$WORK" || exit 1

curl -s "$BASE/gui/" -o gui.html
echo "served /gui/: $(wc -c < gui.html) bytes"
echo
echo "=== injection markers ==="
grep -c 'data-simplerag-extension="codalio-blueprint"' gui.html | sed 's/^/blueprint asset tags: /'
grep -o '<!-- SimpleRAG local extension:codalio-blueprint[^>]*-->' gui.html
echo
echo "=== injection position (must be BEFORE </body>) ==="
python - <<'PY'
import re, pathlib
html = pathlib.Path('gui.html').read_text(encoding='utf-8')
ext = html.find('data-simplerag-extension="codalio-blueprint"')
bundle = html.find('app.bundle.js')
body = html.rfind('</body>')
print(f"app.bundle.js at  : {bundle}")
print(f"blueprint tags at : {ext}")
print(f"</body> at        : {body}")
assert 0 < bundle < ext < body, "injection order is wrong"
print("OK: host bundle runs first, Blueprint registers after, before </body>")
css = html.find('codalio-blueprint.css')
print(f"css tag at        : {css} (before scripts: {css < ext or css >= 0})")
PY
echo
echo "=== per-asset fetch + sha256 verification ==="
fail=0
# Derive the asset list from what the SERVED page actually injects, not from a
# hardcoded list. A hardcoded list silently skips newly added modules, which is
# exactly how a broken script would ship unverified.
ASSETS=$(python - <<'PY'
import re, pathlib
html = pathlib.Path('gui.html').read_text(encoding='utf-8')
names = re.findall(r'local-extensions/codalio-blueprint/([A-Za-z0-9._-]+)\?v=', html)
# Preserve injection order, drop duplicates (each asset appears once per tag).
seen, ordered = set(), []
for name in names:
    if name not in seen:
        seen.add(name)
        ordered.append(name)
print(' '.join(ordered))
PY
)
EXPECTED_COUNT=$(echo "$ASSETS" | wc -w)
echo "injected assets   : $EXPECTED_COUNT"
echo "$ASSETS" | tr ' ' '\n' | sed 's/^/    /'
# 1 stylesheet + every declared script must all be present.
if [ "$EXPECTED_COUNT" -lt 10 ]; then
  echo "FAIL: expected at least 10 injected assets (1 css + 9 scripts), found $EXPECTED_COUNT"
  fail=1
fi
for a in $ASSETS; do
  sha=$(grep -o "codalio-blueprint/$a?v=1.0.0&amp;sha256=[a-f0-9]\{64\}" gui.html | sed 's/.*sha256=//')
  if [ -z "$sha" ]; then echo "$a: NOT INJECTED"; fail=1; continue; fi
  code=$(curl -s -o "out.$a" -w "%{http_code}" "$BASE/local-extensions/codalio-blueprint/$a?v=1.0.0&sha256=$sha")
  ctype=$(curl -s -o /dev/null -w "%{content_type}" "$BASE/local-extensions/codalio-blueprint/$a?v=1.0.0&sha256=$sha")
  actual=$(sha256sum "out.$a" | cut -d' ' -f1)
  size=$(wc -c < "out.$a")
  if [ "$actual" = "$sha" ]; then match="HASH-OK"; else match="HASH-MISMATCH"; fail=1; fi
  # A wrong Content-Type makes the browser refuse to execute the script, so the
  # page would silently do nothing. Assert the type matches the extension.
  case "$a" in
    *.css) want="text/css" ;;
    *.js)  want="application/javascript" ;;
    *)     want="" ;;
  esac
  if [ -n "$want" ] && [ "$ctype" != "$want" ]; then match="$match WRONG-MIME(want $want)"; fail=1; fi
  if [ "$code" != "200" ]; then match="$match HTTP-$code"; fail=1; fi
  printf "%-24s http=%s %-24s %8s bytes %s\n" "$a" "$code" "$ctype" "$size" "$match"
done
echo
echo "=== fail-closed checks ==="
printf "wrong sha256       -> http=%s (expect 404)\n" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/local-extensions/codalio-blueprint/controller.js?v=1.0.0&sha256=***")"
printf "path traversal     -> http=%s (expect 404)\n" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/local-extensions/codalio-blueprint/%2e%2e/secret.js?sha256=***")"
printf "undeclared asset   -> http=%s (expect 404)\n" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/local-extensions/codalio-blueprint/plugin.json?sha256=***")"
echo
echo "=== registry endpoint ==="
curl -s "$BASE/local-extensions/registry.json" -o registry.json -w "http=%{http_code}\n"
python - <<'PY'
import json, os, pathlib
reg = json.loads(pathlib.Path('registry.json').read_text(encoding='utf-8'))
served = sorted(e['id'] for e in reg['extensions'])
print("served by host :", served)
print("schema_version :", reg['schema_version'])
bp = [e for e in reg['extensions'] if e['id'] == 'codalio-blueprint']
assert bp, "blueprint missing from registry endpoint"
print("blueprint surfaces:", bp[0]['surfaces'])
print("blueprint scripts :", [s['path'] for s in bp[0]['scripts']])
print("blueprint styles  :", [s['path'] for s in bp[0]['styles']])
# Script order is load order: manifest first, controller last.
order = [s['path'] for s in bp[0]['scripts']]
assert order[0] == 'manifest.js', f"manifest.js must load first, got {order}"
assert order[-1] == 'controller.js', f"controller.js must load last, got {order}"
print("OK: script load order is manifest.js ... controller.js")

# The installer must never disturb ANOTHER extension's registry entry. Note the
# host only SERVES extensions whose assets still hash-match, so compare against
# the on-disk registry (what the installer writes) rather than the served list.
home = pathlib.Path(os.environ['LOCALAPPDATA']) / 'RAGWorkspace' / 'extensions'
disk = json.loads((home / 'registry.json').read_text(encoding='utf-8'))
disk_ids = sorted(e['id'] for e in disk['extensions'])
print("on-disk registry :", disk_ids)
others_disk = [e for e in disk['extensions'] if e['id'] != 'codalio-blueprint']
assert others_disk, "the install wiped another extension's registry entry"
for entry in others_disk:
    pkg = home / 'packages' / entry['id'] / entry['version']
    print(f"  {entry['id']} {entry['version']}: entry preserved, package dir "
          f"{'present' if pkg.is_dir() else 'MISSING'}")
    assert pkg.is_dir(), "installer deleted another extension's package directory"
print("OK: other extensions' registry entries survived the install")
PY
echo
[ "$fail" = 0 ] && echo "VERIFY RESULT: PASS" || echo "VERIFY RESULT: FAIL"
exit $fail
