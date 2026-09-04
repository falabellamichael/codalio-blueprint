# codalio-blueprint — SimpleRAG fork

A fork of [**codalio-blueprint**](https://github.com/codalio/codalio-blueprint) by Codalio: a set of planning skills for IDE coding agents that turn a rough product idea into written documents, all the way through launch.

This fork keeps upstream intact and **adds a second host**: a standalone [SimpleRAG](https://github.com/kalle07/work_on_rag) plug-in that runs those same skills as a visible, Cursor-style agent page — one big chat showing every step, every prompt, every streamed token, the project folder tree, and each document it writes.

| | What it is | Lives in | Install |
| --- | --- | --- | --- |
| **Upstream** | Planning skills for IDE coding agents (Claude Code, Cursor, Codex, Antigravity, Gemini) | `skills/`, `examples/`, `.*-plugin/` | your IDE's plugin mechanism |
| **This fork** | A Blueprint agent page inside SimpleRAG | `src/`, `tests/`, `tools/` | `python tools/blueprint.py install` |

Nothing in either half is required by the other. The SimpleRAG plug-in is a port of upstream's methodology, not a dependency on it — it does not read `skills/` at runtime.

---

# Part 1 — Upstream: planning skills for IDE agents

**Idea in, PRD out.** Describe what you're building; get a structured PRD file written to your project.

- **Multi-lens, not single-shot.** Product & Scope, Architecture & Data (lite), and GTM (lite) each run as a distinct pass, then get synthesized into one document — not three documents stapled together.
- **Works across hosts.** Ships for Claude Code, Cursor, Codex, Antigravity, and Gemini.

### Before / after

**Before:** "I want to build an app for neighbors to lend and borrow tools instead of everyone buying their own."

**After:** a full PRD — summary, target user, user stories, MVP scope (Now/Next/Later), a lite architecture overview, a lite GTM plan, and open questions — written to `docs/prd/`. See a complete sample run: [`examples/2026-08-06-toolshare-prd.md`](examples/2026-08-06-toolshare-prd.md).

### Quickstart

**Claude Code:**

```
/plugin marketplace add codalio/codalio-blueprint
/plugin install codalio-blueprint@codalio-blueprint
```

**Cursor, Codex, Antigravity, Gemini:** each vendor's local-plugin/extension mechanism changes over time — see that vendor's current docs for installing a local/extension skill, then point it at this repo.

### The six skills

| Skill | What it produces | Writes to |
| --- | --- | --- |
| **PRD Builder** | Three independent lenses (Product & Scope, Architecture-lite, GTM-lite) synthesized into one PRD | `docs/prd/` |
| **MVP Checklist** | Scored candidates, an **explicit cut list**, and checkable v1 done-criteria | `docs/mvp/` |
| **GTM Plan** | Positioning, ranked channels with justification, a pricing approach, and a phased launch sequence where every phase has a real exit criterion | `docs/gtm/` |
| **Architecture Evaluation** | Gap analysis per requirement against the *actual code*, tech debt ranked by how much it blocks those requirements, and a per-requirement build-on/refactor/rewrite call | `docs/arch-eval/` |
| **Doc Generation** | Backlog, API contract sketch, and onboarding doc derived from an existing PRD | `docs/backlog/`, `docs/api/`, `docs/onboarding/` |
| **Code to PRD** | The reverse direction: reconstruct a PRD from an existing codebase, marking inferred items as inferred | `docs/prd/` |

---

# Part 2 — This fork: the SimpleRAG plug-in

A **Cursor-style planning agent page** for SimpleRAG that runs the six skills above and shows you *everything* it does.

It is a **standalone plug-in**. It does not modify a single SimpleRAG file, and uninstalling it leaves zero residue.

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

**Skills that must read real code refuse to guess.** Architecture Evaluation and Code to PRD stop with a visible *"Waiting for source"* step until you attach files. Doc Generation likewise stops if there is no PRD in the project rather than improvising one.

### The page

An IDE-style tabbed workspace inside SimpleRAG's native three-pane shell, so it follows the app's theme and accent automatically:

- **Agent** — a pinned tab: the one big chat, the step timeline, and the composer
- **Project Files** — a multi-root explorer of every project folder and file, plus the document viewer
- **Runs** — every past run with its complete step trace, reopenable
- **Settings** — a thorough, schema-driven surface: sections, sub-pages, cards, groups, search, import/export

Pressing Project Files, Runs or Settings opens a tab **beside** the pinned Agent tab, so the conversation is never destroyed.

### The file previewer

Documents open in whichever reading suits them: Markdown renders as prose, and code opens in a **Notepad++-style** view with a line-number gutter, syntax colouring for 15 languages, and an Ln / Col status bar.

> The layout idea is Notepad++'s. Notepad++ itself is a GPL C++ Win32 desktop application with no browser component, so none of its code is used or could be; the previewer here is original to this plug-in.

### Project folders

- **New Folder** creates a project; each is a root in the explorer.
- **Open Folder** imports a directory from disk through `<input webkitdirectory>`, enforcing count / per-file / total budgets from Settings. Every skipped file is reported **with its reason** (`ignored directory`, `unsupported type .png`, `binary file`). Nothing is uploaded anywhere.
- Imported source files are **read-only** to Blueprint — overwrite attempts divert to `docs/<path>.revised.md` instead of touching your source. Documents Blueprint created stay freely rewritable.

---

## How the plug-in stays standalone

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
        settings.js
        agent.js
        preview.js
        ui.js
        workspace.js
        settings-page.js
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

## Install the plug-in

Requires Python 3.10+. No third-party packages.

```bash
python tools/blueprint.py install
```

Then start SimpleRAG and open the **Advanced** page (`/gui/`). The Blueprint icon (a drafting compass) appears in the far-left app bar.

If SimpleRAG is already running, just reload the page.

### Check it

```bash
python tools/blueprint.py status     # registry entry, manifest hash, every asset hash
python tools/blueprint.py verify     # manifest vs SimpleRAG's own extension_contract.py
```

Exit code is non-zero if anything would prevent the host from injecting it.

### Update / uninstall

```bash
python tools/blueprint.py install     # re-run after changing anything in src/
python tools/blueprint.py uninstall   # reload the page and it is gone
```

`install` writes the new versioned package first and flips the registry afterwards, so a failed copy can never leave the registry pointing at a missing package. Old versions of *this* plug-in are removed; other extensions are never touched.

Generated documents and run history live in the browser profile under `codalio-blueprint.*` localStorage keys, so reinstalling restores them. Clear them from **Blueprint → Settings** if you want them gone.

### Other options

```bash
python tools/blueprint.py install --dry-run          # show what would be written
python tools/blueprint.py install --extension-home P # custom registry root
python tools/blueprint.py package                    # build a distributable .zip
```

`--extension-home` mirrors SimpleRAG's own resolution order: `PYMU_RAG_EXTENSION_HOME`, then `PYMU_RAG_HOME/../extensions`, then `%LOCALAPPDATA%\RAGWorkspace\extensions`.

---

## Before you run it

Blueprint uses **whatever model endpoint SimpleRAG is already configured with** — it never stores credentials or adds its own. Set one up in SimpleRAG under **Settings → General → Model Endpoints** first.

With no endpoint selected, the first step fails with a clear message rather than silently producing nothing.

**Lens concurrency** matters on a local GPU. Parallel runs all three lenses at once; sequential runs them one after another. Both produce identical output — sequential is just easier to watch and lighter on a single local endpoint.

**Token budgets** are per step, not per run. If a step keeps hitting its output limit, raise *Document token budget* in Settings; a full PRD needs more room than one lens.

---

## Repository layout

```
skills/                    upstream: the six planning skills (authoritative source)
examples/                  upstream: sample outputs
.claude-plugin/            upstream: vendor manifests
.cursor-plugin/  .codex-plugin/  .antigravity-plugin/  gemini-extension.json
scripts/validate-manifests.sh    upstream CI validation

src/                       this fork: the SimpleRAG plug-in
  plugin.json              schema-v1 manifest (the contract SimpleRAG validates)
  manifest.template.js     exposes plugin.json to the controller; built at install
  codalio-blueprint.css    every rule namespaced under .cb-
  controller-core.js       state, project folders, virtual filesystem, safe Markdown, streaming
  skills.js                the six skills ported as declarative phase plans
  settings.js              the settings schema: sections, sub-pages, cards, groups
  settings-page.js         the Settings tab renderer
  agent.js                 the step engine: questions → lenses → synthesis → write
  preview.js               the file previewer: gutter, tokenizer, Ln/Col status bar
  ui.js                    the page: nav, list, ribbon, chat, tree, viewer, modals
  workspace.js             the tab engine: pinned Agent, section tabs, file tabs
  controller.js            registers with the host; implements the page lifecycle

tools/blueprint.py         install / uninstall / status / package / verify / test
tools/check_source.py      string-literal integrity
tools/check_css.py         CSS class coverage, both directions
tools/check_install.py     installed package vs src/
tools/wait_for_quiet.py    wait for concurrent edits to settle before testing
tests/                     13 suites (Node, no dependencies)
```

Script load order matters — each module reads the ones before it. `manifest.js` first, `controller.js` last. It is declared once in `tools/blueprint.py` as `SCRIPT_SOURCES`, and the suites assert they load modules in that same order.

### Tests

```bash
python tools/blueprint.py test           # every suite + all static checks
python tools/blueprint.py test --quick   # node suites only
python tools/blueprint.py test --only preview
```

Suites are **discovered** from `tests/*.test.cjs`, not hardcoded, so a suite added later cannot be silently skipped.

```bash
bash tests/verify-live.sh                # live server: injection, hashes, fail-closed
```

`registration.test.cjs` loads SimpleRAG's actual `GUI/extension_runtime.js` in a VM sandbox and runs its real `initialize()`, so a pass means the host genuinely accepts the manifest and renders the app-bar icon. Pass `--simplerag <path>` if your checkout is elsewhere.

`controller-integration.test.cjs` drives the whole page through the host's real public API (`callPageHook`) against a stubbed DOM — mount, activate, click, stream, stop, persist.

The static checks catch classes of bug the suites cannot: corrupted string literals, CSS a class is emitted for but never styled (and the reverse), and an installed package that has drifted from `src/`.

### What the tests actually caught

- **Extension hooks receive the host context first.** Five hooks omitted that parameter, so `onFolderChanged(id)` got the context object, `String()` gave `"[object Object]"`, and pressing a sidebar section did nothing — silently, with no error anywhere.
- **`stopRun()` compared a run generation against its own pre-increment value**, so it always bailed early: Stop aborted the request but never released the busy flag, leaving the composer locked with a dead "Running…" state forever.
- **Streaming steps hold a live DOM node.** DOM nodes are cyclic, so `JSON.stringify` threw and the run was never persisted for the entire duration of every streaming step.
- **The Markdown tokenizer matched on `line.slice(index)`**, making it O(n²) — a 50,000-character line took 13 seconds to colour. Sticky matching made it linear.
- **A shared module-level `/g` regex** in the Markdown renderer: recursive inline parsing reset each other's `lastIndex` and looped forever on nested bold.
- **`WORKSPACE_KEY` was written with a truncated literal** — an ellipsis in place of `io-blueprint.workspac`. It parsed, ran, and passed tests while storing data under a key the source did not say. Storage keys are now composed from parts, and `check_source.py` guards the whole tree.
- **The importer's total-size budget compared bytes against kilobytes**, so the cap never applied.
- **`writeFile()` stored a folder object instead of an id** when given an explicit folder, so imported documents never appeared under their own folder.
- **Code files defaulted to the Markdown renderer**, turning Python `#` comments into headings.
- **The file previewer and the chat-history flyout had no CSS at all** — 66 unstyled classes, reported clean by an audit tool that had been reading a hardcoded file list.

---

## Design notes

**Model text never becomes markup.** The Markdown renderer and the previewer both build DOM nodes and put unrecognised content into text nodes. No module assigns a non-empty `innerHTML` anywhere, and the suites enforce both properties — so a document containing `<script>` or `<img onerror=…>` renders as inert visible text.

**Nothing is written to your SimpleRAG workspace.** Generated documents, run history, imported source, and settings live in a virtual filesystem under Blueprint's own localStorage keys. Your journal, documents, knowledge graph, and settings are never read or written. The agent explicitly sends `use_workspace_context: false`.

**Every step carries a `cancel_id`** so Stop actually stops the backend turn rather than just abandoning the fetch.

**Boot failures are visible.** If SimpleRAG's own bundle fails to parse, the extension host never exists and Blueprint cannot register. It renders an on-page alert naming the missing host object and pointing at the likely cause, instead of logging one console line and leaving a blank page. The panel is inline-styled and `cb-`-free, because when the host is broken this plug-in's own stylesheet may not have loaded either.

**The host's `isEnabled()` gate.** SimpleRAG only shows a contributed page when its plug-in store carries an enabled record. The controller seeds exactly one record — its own — at script-load time, before the host reads the store on `DOMContentLoaded`. It never modifies another plug-in's entry, and disabling or uninstalling removes the page from the app bar immediately.

**Layout.** The host marks the reading pane `.calendar-mode` for every contributed page, and that class reserves a 292px column for Calendar's side panel. Blueprint collapses that grid to one column, scoped so Calendar itself is unaffected.

---

## Relationship to upstream

This is a GitHub fork, so upstream's history is in this repo's ancestry. To pull upstream changes:

```bash
git remote add upstream https://github.com/codalio/codalio-blueprint.git   # once
git fetch upstream
git merge upstream/main
```

Upstream owns `skills/`, `examples/`, the vendor manifests, and the upstream CI. This fork owns `src/`, `tests/`, and `tools/`. The two halves do not share files, so upstream updates should merge cleanly.

If upstream changes a skill's process, lenses, output contract or templates, **`src/skills.js` must be ported by hand** — it is an executable port, not a runtime reader of `skills/*/SKILL.md`. That is deliberate: the SimpleRAG plug-in has to work with no filesystem access to this repo, since only `src/` is packaged and installed.

---

## Credits and license

The planning methodology, lens prompts, process flows, output contracts, document templates, and output paths are from **[codalio-blueprint](https://github.com/codalio/codalio-blueprint)** by **Codalio** (MIT).

The SimpleRAG plug-in — the page, tabbed workspace, step engine, agent runtime, file previewer, installer, stylesheet and tests — is by **Michael Anthony Falabella** (MIT).

Both bodies of work are MIT licensed. See [LICENSE](LICENSE), which is upstream's MIT text verbatim plus this fork's copyright line; the attribution detail — which part of the tree belongs to whom, and the Notepad++ layout-idea note — is in [NOTICE](NOTICE).
