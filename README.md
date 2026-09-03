# Codalio Blueprint for SimpleRAG

A **Cursor-style planning agent page** for [SimpleRAG](https://github.com/kalle07/work_on_rag) — one big AI chat that runs the [codalio-blueprint](https://github.com/codalio/codalio-blueprint) planning skills and shows you *everything* it does: every step, every prompt, every streamed token, the project folder tree, and each document it writes.

It is a **standalone plug-in**. It does not modify a single SimpleRAG file, and uninstalling it leaves zero residue.

---

## What it does

Describe a product idea in the chat. Blueprint picks the matching skill and runs it as a visible sequence of steps — the same way a coding agent shows its work — then writes the resulting document into the project file tree.

```
You: I want to build an app for neighbors to lend and borrow tools
     instead of everyone buying their own.

Blueprint: I'm using the prd-builder skill to build your PRD.
  ▸ Clarifying questions skipped            (or asked, one at a time)
  ▸ Running 3 lenses concurrently
  ✓ Lens 1 — Product & Scope            4.2s   ← open it: prompt + full output
  ✓ Lens 2 — Architecture & Data (lite) 3.8s
  ✓ Lens 3 — GTM (lite)                 3.1s
  ● Synthesize the three lenses into one PRD   ← streaming live
  ✓ Wrote docs/prd/2026-09-03-toolshare-prd.md
  ✓ Self-review complete — your review gate

  Written to project: [docs/prd/2026-09-03-toolshare-prd.md]
```

Every row is expandable and shows **the exact prompt sent to the model** and **the exact output it returned**. Nothing is hidden behind a spinner.

### The six skills

Ported faithfully from `codalio-blueprint` — same process order, same lens prompts, same output contracts, same document templates, same output paths.

| Skill | What it produces | Writes to |
| --- | --- | --- |
| **PRD Builder** | Three independent lenses (Product & Scope, Architecture-lite, GTM-lite) synthesized into one PRD — not three documents stapled together | `docs/prd/` |
| **MVP Checklist** | Deeper than a Now/Next/Later sketch: scored candidates, an **explicit cut list**, and checkable v1 done-criteria | `docs/mvp/` |
| **GTM Plan** | Positioning, ranked channels with justification, a pricing approach, and a phased launch sequence where every phase has a real exit criterion | `docs/gtm/` |
| **Architecture Evaluation** | Gap analysis per requirement against the *actual code*, tech debt ranked by how much it blocks those requirements, and a per-requireation build-on/refactor/rewrite call | `docs/arch-eval/` |
| **Doc Generation** | Backlog, API contract sketch, and onboarding doc derived from an existing PRD | `docs/backlog/`, `docs/api/`, `docs/onboarding/` |
| **Code to PRD** | The reverse direction: reconstruct a PRD from an existing codebase, marking inferred items as inferred | `docs/prd/` |

**Skills that must read real code refuse to guess.** Architecture Evaluation and Code to PRD stop with a visible *"Waiting for source"* step until you attach files — the source skill is explicit that it must not evaluate from a README or file names alone. Doc Generation likewise stops if there is no PRD in the project rather than improvising one.

### The page

Four sections, in SimpleRAG's native three-pane shell (so it matches the app's theme and accent automatically):

- **Agent** — the one big chat with the step timeline and composer
- **Project Files** — folder tree, attached source, and the document viewer (rendered Markdown or raw source, copy / download / rename / delete)
- **Runs** — every past run with its complete step trace, reopenable
- **Settings** — lens concurrency, token budgets, temperature, clarifying questions, data controls

---

## How it stays standalone

SimpleRAG already ships a **local-extension registry** built for exactly this. It lives *outside* the application:

```
%LOCALAPPDATA%\RAGWorkspace\extensions\
    registry.json
    packages\codalio-blueprint\1.0.0\
        manifest.json          ← asset hashes the host verifies
        codalio-blueprint.css
        manifest.js
        controller-core.js
        skills.js
        agent.js
        ui.js
        controller.js
```

SimpleRAG's frontend server (`PDF_parser/chat_frontend_server.py`) SHA256-verifies every declared asset **on each request** and injects the surviving `<link>` / `<script>` tags into the Advanced page at serve time.

That means:

- **No SimpleRAG file is read, written, or modified.** Not `app.bundle.js`, not `index.html`, not `router.py`. Nothing.
- **Uninstall is exact.** Removing the registry entry makes the injection vanish. Verified: the served Advanced page drops from 82,505 → 80,961 bytes, zero Blueprint tags remain, asset routes return 404, and other installed extensions are untouched.
- **It fails closed.** A tampered asset, a wrong hash, a path traversal, or an undeclared file all return 404 and the extension is simply not injected — the host page keeps working normally.
- **It survives app updates.** The registry sits outside the replaceable GUI tree, so a SimpleRAG rebuild or reinstall does not remove the plug-in.

The plug-in talks to SimpleRAG only through its public surfaces: the extension host API (`window.RAGWorkspaceExtensions`), the documented page-controller contract, and the existing `/chat/stream` endpoint. **No backend code, no new routes, no database tables.**

---

## Install

Requires Python 3.10+. No third-party packages.

```bash
python tools/blueprint.py install
```

Then start SimpleRAG and open the **Advanced** page (`/gui/`). The Blueprint icon (a drafting compass) appears in the far-left app bar.

If SimpleRAG is already running, just reload the page.

### Check it

```bash
python tools/blueprint.py status
```

Verifies the registry entry, the manifest hash, and every asset hash. Exit code is non-zero if anything would prevent the host from injecting it.

### Update

Re-run `install` after changing anything in `src/`. It writes the new versioned package first and flips the registry afterwards, so a failed copy can never leave the registry pointing at a missing package. Old versions of *this* plug-in are removed; other extensions are never touched.

### Uninstall

```bash
python tools/blueprint.py uninstall
```

Reload the page and it is gone.

Blueprint's generated documents and run history live in the browser profile under `codalio-blueprint.*` localStorage keys, so reinstalling restores them. Clear them from **Blueprint → Settings** if you want them gone.

### Other options

```bash
python tools/blueprint.py install --dry-run          # show what would be written
python tools/blueprint.py install --extension-home P # custom registry root
python tools/blueprint.py package                    # build a distributable .zip
python tools/blueprint.py verify                     # validate against SimpleRAG's own contract
```

`--extension-home` mirrors SimpleRAG's own resolution order: `PYMU_RAG_EXTENSION_HOME`, then `PYMU_RAG_HOME/../extensions`, then `%LOCALAPPDATA%\RAGWorkspace\extensions`.

---

## Before you run it

Blueprint uses **whatever model endpoint SimpleRAG is already configured with** — it never stores credentials or adds its own. Set one up in SimpleRAG under **Settings → General → Model Endpoints** first.

With no endpoint selected, the first step fails with a clear message rather than silently producing nothing.

**Lens concurrency** matters on a local GPU. Parallel runs all three lenses at once; sequential runs them one after another. Both produce identical output — sequential is just easier to watch and lighter on a single local endpoint.

**Token budgets** are per step, not per run. If a step keeps hitting its output limit, raise *Document token budget* in Settings; a full PRD needs more room than one lens.

---

## Development

```
src/
  plugin.json              schema-v1 manifest (the contract SimpleRAG validates)
  manifest.template.js     exposes plugin.json to the controller; built at install
  codalio-blueprint.css    every rule namespaced under .cb-
  controller-core.js       state, virtual filesystem, safe Markdown, model streaming
  skills.js                the six skills as declarative phase plans
  agent.js                 the step engine: questions → lenses → synthesis → write
  ui.js                    the page: nav, list, ribbon, chat, tree, viewer, settings
  controller.js            registers with the host; implements the page lifecycle
  skills/                  the original codalio-blueprint skill sources (reference)
tools/blueprint.py         install / uninstall / status / package / verify
tests/                     contract, run-flow, and render suites
```

Script load order matters — each module reads the ones before it. `manifest.js` first, `controller.js` last.

### Tests

```bash
node tests/registration.test.cjs   # 18 groups — against SimpleRAG's REAL host
node tests/agent-flow.test.cjs     # 10 groups — full skill runs, mocked model
node tests/ui-render.test.cjs      # 10 groups — real DOM trees from ui.js
bash tests/verify-live.sh          # live server: injection, hashes, fail-closed
```

`registration.test.cjs` loads SimpleRAG's actual `GUI/extension_runtime.js` in a VM sandbox and runs its real `initialize()`, so a pass means the host genuinely accepts the manifest and renders the app-bar icon. Pass `--simplerag <path>` if your checkout is not at `D:/PyMu/work_on_rag-main`.

```bash
python tools/blueprint.py verify   # manifest vs SimpleRAG's extension_contract.py
```

This uses the same validator the app's installer, gallery review, and startup discovery use — so a pass means the host will accept the plug-in through any install path.

### What the tests actually caught

- A shared module-level `/g` regex in the Markdown renderer: recursive inline parsing reset each other's `lastIndex` and looped forever on nested bold. Any document with `**bold with *nested* inside**` would have hung the page.
- A CSS class collision between a step's error *status* and its error *box*, so both rulesets landed on the same element.
- An empty-state action row that was built and never appended — an empty project showed no way to add a file.
- Three storage-key constants that had collapsed to the same corrupted string, which would have made projects, settings, and the removal marker overwrite each other.

---

## Design notes

**Model text never becomes markup.** The Markdown renderer builds DOM nodes and puts unrecognised content into text nodes. No module assigns a non-empty `innerHTML` anywhere, and the test suite enforces both properties — so a document containing `<script>` or `<img onerror=…>` renders as inert visible text.

**Nothing is written to your SimpleRAG workspace.** Generated documents, run history, and attached source live in a virtual filesystem under Blueprint's own localStorage keys. Your journal, documents, knowledge graph, and settings are never read or written. The agent explicitly sends `use_workspace_context: false`.

**Every step carries a `cancel_id`** so Stop actually stops the backend turn rather than just abandoning the fetch.

**The host's `isEnabled()` gate.** SimpleRAG only shows a contributed page when its plug-in store carries an enabled record. The controller seeds exactly one record — its own — at script-load time, before the host reads the store on `DOMContentLoaded`. It never modifies another plug-in's entry, and disabling or uninstalling removes the page from the app bar immediately.

**Layout.** The host marks the reading pane `.calendar-mode` for every contributed page, and that class reserves a 292px column for Calendar's side panel. Blueprint collapses that grid to one column, scoped with `:has()` so Calendar itself is unaffected.

---

## Credits

The planning methodology, lens prompts, process flows, output contracts, document templates, and output paths are from **[codalio-blueprint](https://github.com/codalio/codalio-blueprint)** by Codalio (MIT). The `src/skills/` directory carries the original skill sources for reference; `src/skills.js` is the executable port.

This plug-in — the SimpleRAG page, the step engine, the agent runtime, the installer, and the tests — is by **Michael Anthony Falabella**, MIT licensed.

## License

MIT. See [LICENSE](LICENSE).
