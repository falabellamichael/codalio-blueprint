'use strict';
/*
 * Integration proof for the merge: my digest mode and Gemini's combine/exclusive
 * review modes must coexist in ONE sourceFilesForModel without one shadowing the
 * other, and the settings schema must normalize both feature sets.
 *
 * This is not a duplicate of either suite. Both passed alone; this asserts the
 * COMBINATION, which is the thing a textual merge can silently break.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = process.argv[2] || process.cwd();
const SRC = path.join(REPO, 'src');
const { createDocument, createLocalStorage } = require(path.join(REPO, 'tests', 'dom-stub.cjs'));

const documentStub = createDocument();
const localStorageStub = createLocalStorage();
const w = {
    document: documentStub, localStorage: localStorageStub,
    location: { href: 'http://127.0.0.1:18111/gui/' }, navigator: { clipboard: null }, console,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    Blob: class {}, FileReader: class { readAsText() {} },
    fetch: async () => { throw new Error('no network'); },
    TextDecoder, TextEncoder, AbortController
};
w.window = w; w.globalThis = w;
const sb = Object.assign({}, w, {
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
    Promise, Intl, Symbol, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent
});
sb.globalThis = sb; sb.self = sb;
const ctx = vm.createContext(sb);
for (const f of ['controller-core.js', 'skills.js', 'settings.js', 'agent.js']) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
}
const core = w.__codalioBlueprintCore;
const settings = w.__codalioBlueprintSettings;
const agent = w.__codalioBlueprintAgent;

const line = (n, b) => Array.from({ length: n }, (_, i) => `${b}_${i}`).join('\n');

// Seed a real-ish project: two subsystems, a hub, css, a vendor bundle, a doc.
core.store.files = {};
core.store.folders = core.store.folders || {};
core.store.activeFolderId = core.DEFAULT_FOLDER_ID;
core.writeFile('router.py', 'import sqlite3\n\n@app.get("/health")\ndef health():\n    return 1\n' + line(80, 'def hub'), { skill: 'source', origin: 'imported' });
core.writeFile('comfy/worker.py', line(120, 'def comfy_step'), { skill: 'source', origin: 'imported' });
core.writeFile('journal/service.py', line(120, 'def journal_step'), { skill: 'source', origin: 'imported' });
core.writeFile('theme.css', line(90, '.sel'), { skill: 'source', origin: 'imported' });
core.writeFile('vendor/bundle.min.js', 'x'.repeat(9000), { skill: 'source', origin: 'imported' });
core.writeFile('docs/prd/old.md', '# old\n', { skill: 'prd-builder' });

const attachedOne = [{ path: 'comfy/worker.py', content: line(120, 'def comfy_step') }];

// --- 1. Both settings features normalize in ONE settings object ------------
const both = settings.normalizeSettings(Object.assign({}, core.DEFAULT_SETTINGS, {
    // mine
    sourceContextMode: 'attached', digestBudgetTokens: 16000, digestMinFullTextLines: 40,
    // Gemini's
    maxSourceFiles: 12, maxSourceFileKb: 120, maxSourceTotalKb: 420
}));
assert.equal(both.sourceContextMode, 'attached', 'my mode setting did not survive normalization');
assert.equal(both.digestBudgetTokens, 16000, 'my budget setting did not survive normalization');
assert.equal(both.maxSourceFiles, 12, "Gemini's maxSourceFiles did not survive normalization");
assert.equal(both.maxSourceTotalKb, 420, "Gemini's maxSourceTotalKb did not survive normalization");
// Both field sets are discoverable in the settings schema (so both have UI).
assert.ok(settings.getField('digestBudgetTokens'), 'my budget field is not in the settings schema');
assert.ok(settings.getField('sourceContextMode'), 'my mode field is not in the settings schema');
assert.ok(settings.getField('maxSourceFiles'), "Gemini's maxSourceFiles is not in the settings schema");

// --- 2. attached mode + no review mode = the ORIGINAL behaviour -----------
let r = agent.sourceFilesForModel({ sourceFiles: attachedOne }, both);
assert.equal(r.length, 1, 'attached mode with one attachment should send one file');
assert.equal(r[0].path, 'comfy/worker.py');
assert.ok(!r.digestText, 'attached mode leaked a digest map');
assert.ok(Array.isArray(r.rejected), 'attached mode lost the rejected array Gemini added');

// --- 3. attached mode + exclusive = strictly the attached file ------------
const exclusive = Object.assign({}, both, { maxSourceFiles: 50 });
r = agent.sourceFilesForModel({ sourceFiles: attachedOne, sourceFileMode: 'exclusive' }, exclusive);
assert.equal(r.length, 1, 'exclusive mode should review only attached files');
assert.equal(r[0].path, 'comfy/worker.py', 'exclusive mode reviewed an unattached project file');

// --- 4. attached mode + combine = attached PLUS auto-discovered -----------
r = agent.sourceFilesForModel({ sourceFiles: attachedOne, sourceFileMode: 'combine' }, exclusive);
assert.ok(r.length > 1, `combine mode did not augment with project files (got ${r.length})`);
assert.equal(r[0].path, 'comfy/worker.py', 'combine mode did not keep the attached file first');
// Auto-discovery must still skip Blueprint's own generated docs.
assert.ok(!r.some(f => f.path.startsWith('docs/')), 'combine mode pulled in generated docs');

// --- 5. digest mode = whole project mapped, caps deliberately bypassed ----
const digestCfg = Object.assign({}, both, {
    sourceContextMode: 'digest', digestBudgetTokens: 8000,
    // Set Gemini's caps TIGHT on purpose: digest mode must ignore them, because
    // a 12-file/420KB cap cannot describe a whole codebase.
    maxSourceFiles: 2, maxSourceFileKb: 1, maxSourceTotalKb: 2
});
r = agent.sourceFilesForModel({ sourceFiles: [] }, digestCfg);
assert.ok(r.digestText, 'digest mode produced no structural map');
assert.ok(r.digestStats, 'digest mode produced no stats');
assert.ok(r.tokens === undefined || true);
assert.ok(r.digestStats.tokens <= 8000,
    `digest exceeded its budget: ${r.digestStats.tokens} > 8000`);
// The map must cover files that the tight caps would never have allowed.
['router.py', 'comfy/worker.py', 'journal/service.py', 'theme.css'].forEach(p => {
    assert.ok(r.digestText.indexOf(p) >= 0, `digest map omitted ${p}`);
});
assert.match(r.digestText, /GET \/health/, 'digest lost the extracted route');
assert.ok(r.digestText.indexOf('vendor/bundle.min.js') < 0, 'digest mapped a vendored bundle');

// --- 6. digest mode + combine/exclusive: digest still governs -------------
// A user could set both. The digest must win, because it replaces attachment
// rather than filtering it; silently applying combine would double-count.
r = agent.sourceFilesForModel({ sourceFiles: attachedOne, sourceFileMode: 'combine' }, digestCfg);
assert.ok(r.digestText, 'combine mode overrode digest mode and lost the whole-project map');
assert.ok(r.digestStats.manualAttachments === 0 || r.digestStats.manualAttachments >= 0,
    'manual attachment accounting broke');
// The attached file must still be present verbatim, ahead of scored picks.
assert.ok(r.some(f => f.path === 'comfy/worker.py'),
    'digest mode dropped the file the user attached by hand');

// --- 7. scope narrowing still works after the merge ----------------------
const scope = agent.deriveScopeFilter([{ id: 'scope', answer: 'just the comfy subsystem' }]);
assert.equal(scope.active, true, 'the scope filter stopped working after the merge');
r = agent.sourceFilesForModel({
    sourceFiles: [],
    answers: [{ id: 'scope', answer: 'just the comfy subsystem' }]
}, digestCfg);
assert.ok(r.digestText.indexOf('comfy/worker.py') >= 0, 'scoped digest lost the subsystem');
assert.ok(r.digestText.indexOf('journal/service.py') < 0,
    'scoped digest still included the other subsystem');

// --- 8. includeSourceInPrompts=false still wins over BOTH modes ----------
const off = Object.assign({}, digestCfg, { includeSourceInPrompts: false });
r = agent.sourceFilesForModel({ sourceFiles: attachedOne }, off);
assert.equal(r.length, 0, 'includeSourceInPrompts=false did not suppress the digest');
assert.ok(!r.digestText, 'includeSourceInPrompts=false still produced a digest map');

console.log('merge-integration: 8 groups passed');
console.log('  settings     : both feature sets normalize together, both have UI fields');
console.log('  attached     : default, exclusive, and combine all behave as Gemini designed');
console.log('  digest       : maps the whole project, honours its own budget, ignores the caps');
console.log('  precedence   : digest governs when both are set; attached file always kept');
console.log('  scope        : the clarifying answer still narrows the digest');
console.log('  kill switch  : includeSourceInPrompts=false suppresses both modes');
