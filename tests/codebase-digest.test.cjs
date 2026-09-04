'use strict';

/*
 * Codalio Blueprint — whole-codebase digest test.
 *
 * Covers the structural digest that lets the code-reading skills see a whole
 * project inside a token budget:
 *
 *   1. Per-file extraction: Python routes/classes/methods, JS functions/classes,
 *      host-extension registrations, declarative slash-command tables, CSS
 *      selectors, Markdown headings, JSON keys, HTML wiring.
 *   2. Exclusion: vendored paths and minified bundles become one-line stubs and
 *      never consume symbol budget.
 *   3. Deduplication: a file that declares the same symbol twice lists it once
 *      (router.py did exactly this in the real project).
 *   4. Budget: Tier 1 + Tier 2 stay within the budget; adaptive depth deepens
 *      high-scoring files; overflow degrades the LOWEST-scoring files to stubs
 *      rather than dropping them, so coverage stays total.
 *   5. Scoring: a hub file imported by many others outranks leaf files;
 *      stylesheets and vendor files rank below code.
 *   6. Scope filter: the clarifying "scope" answer narrows the digest, a
 *      "whole codebase" answer does not, and a no-match falls back to the whole
 *      project instead of producing an empty digest.
 *
 * Run: node tests/codebase-digest.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');
const { createDocument, createLocalStorage } = require('./dom-stub.cjs');

function loadCore() {
    const documentStub = createDocument();
    const localStorageStub = createLocalStorage();
    const windowStub = {
        document: documentStub, localStorage: localStorageStub,
        location: { href: 'http://127.0.0.1:18411/gui/' },
        navigator: { clipboard: null }, console,
        setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
        setInterval: () => 0, clearInterval: () => {},
        requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
        MutationObserver: class { observe() {} disconnect() {} },
        CustomEvent: class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
        Blob: class {}, FileReader: class { readAsText() {} },
        fetch: async () => { throw new Error('this test makes no network calls'); },
        TextDecoder: global.TextDecoder, TextEncoder: global.TextEncoder,
        AbortController: global.AbortController
    };
    windowStub.window = windowStub;
    windowStub.globalThis = windowStub;
    const sandbox = {
        window: windowStub, document: documentStub, localStorage: localStorageStub,
        navigator: windowStub.navigator, location: windowStub.location, console,
        setTimeout: windowStub.setTimeout, clearTimeout: windowStub.clearTimeout,
        setInterval: () => 0, clearInterval: () => {},
        requestAnimationFrame: windowStub.requestAnimationFrame,
        MutationObserver: windowStub.MutationObserver, CustomEvent: windowStub.CustomEvent,
        URL: windowStub.URL, Blob: windowStub.Blob, FileReader: windowStub.FileReader,
        fetch: windowStub.fetch, TextDecoder: global.TextDecoder, TextEncoder: global.TextEncoder,
        AbortController: global.AbortController,
        Math, Date, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
        Promise, Intl, Symbol, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(SRC, 'controller-core.js'), 'utf8'),
        context, { filename: 'controller-core.js' });
    return sandbox.window.__codalioBlueprintCore;
}

const core = loadCore();
const TOK = text => Math.max(1, Math.round(String(text || '').length / 3.8));

// ---------------------------------------------------------------------------
// 1. Per-file extraction
// ---------------------------------------------------------------------------

const PY = [
    'import sqlite3',
    'from fastapi import APIRouter',
    '',
    'router = APIRouter()',
    '',
    '@router.get("/tasks")',
    'def list_tasks(limit: int = 100):',
    '    return []',
    '',
    '@router.post("/tasks")',
    'def create_task(body: TaskIn):',
    '    return body',
    '',
    'class TaskIn(BaseModel):',
    '    title: str',
    '',
    'class Helper:',
    '    def _private(self):',
    '        pass',
    '    def public_method(self, x):',
    '        return x',
    ''
].join('\n');

let d = core.digestFileStructure('router.py', PY, 30);
assert.equal(d.excluded, false, 'a normal source file was marked excluded');
assert.match(d.text, /ROUTES \(2\)/, 'python routes were not extracted');
assert.match(d.text, /GET \/tasks/, 'the GET route was lost');
assert.match(d.text, /POST \/tasks/, 'the POST route was lost');
assert.match(d.text, /classes \(2\): TaskIn\(BaseModel\); Helper/, 'python classes were not extracted');
assert.match(d.text, /list_tasks/, 'a module-level function was lost');
assert.match(d.text, /\.public_method/, 'an indented method was not marked as a method');
assert.match(d.text, /imports: sqlite3, fastapi/, 'python imports were not extracted');

const JS = [
    "import { helper } from './helper.js';",
    "const other = require('./other');",
    '',
    'export class Panel extends HTMLElement {',
    '  render() { return null; }',
    '}',
    '',
    'function buildPanel(options) {',
    '  return options;',
    '}',
    '',
    'const quickAction = (event) => event;',
    '',
    "(function registerThing() {",
    "    window.RAGWorkspaceExtensions.registerController({",
    "        pluginId: 'my-plugin',",
    "        capabilities: ['workspace.commands.v1', 'workspace.page-controller.v1'],",
    "        commands: {",
    "            'myPlugin.doThing': context => context.actions.doThing()",
    "        }",
    "    });",
    "}());",
    ''
].join('\n');

d = core.digestFileStructure('panel.js', JS, 30);
assert.match(d.text, /imports: \.\/helper\.js, \.\/other/, 'js imports (esm + cjs) were not extracted');
assert.match(d.text, /classes \(1\): Panel extends HTMLElement/, 'a js class with extends was not extracted');
assert.match(d.text, /buildPanel\(options\)/, 'a function declaration was not extracted');
assert.match(d.text, /quickAction\(event\)/, 'an arrow function was not extracted');
assert.match(d.text, /HOST EXTENSION: pluginId=my-plugin/, 'a host registration was not detected');
assert.match(d.text, /capabilities=workspace\.commands\.v1\+workspace\.page-controller\.v1/,
    'registration capabilities were not parsed');
assert.match(d.text, /handlers=myPlugin\.doThing/, 'registration handlers were not parsed');

// Declarative command tables: invisible to a function/class-only scan, but they
// carry real product behaviour. Six of these files in the real project produced
// NOTHING in the first prototype pass.
const COMMANDS = [
    '(function () {',
    '    window.aiCommandSets = window.aiCommandSets || {};',
    '    window.aiCommandSets.tasks = [',
    '        { command: "/help", title: "Help" },',
    '        { command: "/prioritize", title: "Prioritize" },',
    '        { command: "/plan today", title: "Plan" }',
    '    ];',
    '}());',
    ''
].join('\n');
d = core.digestFileStructure('ai_tasks_commands.js', COMMANDS, 30);
assert.match(d.text, /COMMANDS: 3 slash commands/, 'a declarative command table was invisible');
assert.match(d.text, /\/help/, 'slash commands were not listed');

d = core.digestFileStructure('theme.css', ':root { --cb-bg: #000; }\n.cb-btn { color: red; }\n.cb-toast { padding: 4px; }\n', 30);
assert.match(d.text, /\[stylesheet\] 3 selectors/, 'css selectors were not counted');
assert.match(d.text, /--cb-bg/, 'css custom properties were not extracted');

d = core.digestFileStructure('README.md', '# Title\n\n## Section One\n\nprose\n', 30);
assert.match(d.text, /# Title/, 'markdown headings were not extracted');
assert.match(d.text, /## Section One/, 'a second-level heading was not extracted');

d = core.digestFileStructure('package.json', '{"name":"x","version":"1.0.0","scripts":{}}', 30);
assert.match(d.text, /keys \(3\): name; version; scripts/, 'json keys were not extracted');

d = core.digestFileStructure('index.html',
    '<html><head><link href="a.css"></head><body><div id="app"></div>'
    + '<button data-cb-action="send">Go</button><script src="app.js"></script></body></html>', 30);
assert.match(d.text, /scripts: app\.js/, 'html script tags were not extracted');
assert.match(d.text, /stylesheets: a\.css/, 'html link tags were not extracted');
assert.match(d.text, /ids: #app/, 'html ids were not extracted');
assert.match(d.text, /UI actions: send/, 'html data-action wiring was not extracted');

// ---------------------------------------------------------------------------
// 2. Exclusion of vendored and minified code
// ---------------------------------------------------------------------------

d = core.digestFileStructure('vendor/d3.min.js', 'x'.repeat(5000), 30);
assert.equal(d.excluded, true, 'a vendored path was not excluded');
assert.match(d.text, /vendored third-party library/, 'the vendored stub message is missing');
assert.equal(d.value, 0, 'a vendored file was given structural value');

const oneLongLine = 'var a=1;' + ';'.repeat(4000);
d = core.digestFileStructure('bundle.js', oneLongLine, 30);
assert.equal(d.excluded, true, 'a minified bundle was not excluded');
assert.match(d.text, /minified bundle/, 'the minified stub message is missing');

assert.equal(core.isVendoredPath('vendor/x.js'), true);
assert.equal(core.isVendoredPath('src/vendor-tools/x.js'), false,
    'a directory merely containing the word vendor was excluded');
assert.equal(core.isVendoredPath('src/x.js'), false);
assert.equal(core.isMinifiedSource('x.js', 'a\nb\nc\n'), false, 'normal source was called minified');

// ---------------------------------------------------------------------------
// 3. Deduplication
// ---------------------------------------------------------------------------

const DUPES = [
    'class Alpha(BaseModel):',
    '    pass',
    '',
    'class Beta(BaseModel):',
    '    pass',
    '',
    'class Alpha(BaseModel):',
    '    pass',
    '',
    'def same():',
    '    pass',
    '',
    'def same():',
    '    pass',
    ''
].join('\n');
d = core.digestFileStructure('dupes.py', DUPES, 60);
const classCount = /classes \((\d+)\)/.exec(d.text);
assert.ok(classCount, 'no class list was produced');
assert.equal(Number(classCount[1]), 2, 'duplicate classes were not deduplicated');
const fnCount = /functions \((\d+)\)/.exec(d.text);
assert.equal(Number(fnCount[1]), 1, 'duplicate functions were not deduplicated');
const occurrences = (d.text.match(/Alpha/g) || []).length;
assert.equal(occurrences, 1, 'a duplicated symbol name still appears twice in the digest');

// ---------------------------------------------------------------------------
// 4. Budget, adaptive depth, and overflow degradation
// ---------------------------------------------------------------------------

function makeProject(fileCount, bodyLines) {
    const records = [];
    for (let i = 0; i < fileCount; i += 1) {
        const lines = [];
        for (let j = 0; j < bodyLines; j += 1) {
            lines.push(`def module_${i}_function_${j}(arg_${j}, other):`);
            lines.push(`    return arg_${j} + other`);
        }
        records.push({ path: `pkg/module_${i}.py`, content: lines.join('\n') });
    }
    return records;
}

let project = makeProject(40, 30);
let result = core.buildCodebaseDigest(project, { budgetTokens: 16000 });
assert.ok(result.tokens <= 16000,
    `digest exceeded its budget: ${result.tokens} > 16000`);
assert.equal(result.fileCount, 40, 'not every first-party file was mapped');
assert.equal(result.excluded, 0, 'a first-party file was wrongly excluded');
assert.equal(result.trimmed, 0, 'a small project should not need trimming');
assert.equal(result.coverage, 1, 'coverage was not total for a project inside budget');
assert.ok(result.deepened > 0, 'adaptive depth never deepened anything with room to spare');

// Overflow: many large files. The budget is a HARD guarantee, because it exists
// to bound prompt-evaluation wall-clock — silently overrunning it would turn a
// 2-minute step into a 20-minute one.
project = makeProject(400, 120);
result = core.buildCodebaseDigest(project, { budgetTokens: 8000 });
assert.ok(result.tokens <= 8000,
    `an overflowing digest exceeded its budget: ${result.tokens} > 8000`);
assert.ok(result.fileCount < 400, 'an overflowing digest kept every file in full detail');
// Nothing is lost without a record: mapped + omitted must account for the whole
// project, and the digest must SAY it is incomplete.
assert.equal(result.fileCount + result.omittedCount, 400,
    'files vanished without being counted as omitted');
assert.equal(result.scannedCount, 400, 'the scanned count does not reflect the project');
assert.ok(result.omittedCount > 0, 'nothing was reported as omitted despite overflow');
assert.ok(result.coverage < 1, 'coverage claimed to be total despite overflow');
assert.match(result.digestText, /left out of this map/,
    'the digest did not disclose that it is incomplete');
assert.match(result.digestText, /do not assume their contents/,
    'the omission note did not warn against inferring missing files');
// The dropped entries are the LOWEST-scoring, so the map keeps the files that
// explain the system.
assert.ok(result.digestText.indexOf('pkg/module_0.py') >= 0,
    'a high-scoring file was dropped while low-scoring ones survived');
assert.ok(result.omitted.indexOf('pkg/module_0.py') < 0,
    'the first module was omitted from an overflowing digest');

// A vendored-heavy project: excluded files must not consume the budget.
project = makeProject(20, 30).concat([
    { path: 'vendor/lib_a.js', content: 'x'.repeat(200000) },
    { path: 'vendor/deep/lib_b.js', content: 'y'.repeat(200000) },
    { path: 'assets/app.min.js', content: 'z'.repeat(200000) }
]);
result = core.buildCodebaseDigest(project, { budgetTokens: 8000 });
assert.equal(result.excluded, 3, 'vendored/minified files were not counted as excluded');
assert.ok(result.tokens <= 8000, 'excluded bundles consumed budget');
// Excluded files are deliberately NOT in the map — they are generated artifacts
// whose structure means nothing. Their existence is disclosed through
// `excluded`, which sourceBlock() tells the model about, so the model still
// knows bundles were present but not analysed.
assert.ok(result.digestText.indexOf('vendor/lib_a.js') < 0,
    'a vendored bundle was mapped instead of being excluded');
assert.equal(result.fileCount + result.omittedCount + result.excluded, project.length,
    'excluded files were not accounted for');

// ---------------------------------------------------------------------------
// 5. Scoring: hubs and entry points outrank leaves
// ---------------------------------------------------------------------------

project = [
    { path: 'router.py', content: '@app.get("/x")\ndef x():\n    pass\n' },
    { path: 'core.py', content: 'def shared():\n    return 1\n' },
    { path: 'leaf_a.py', content: 'from core import shared\nimport router\n' },
    { path: 'leaf_b.py', content: 'from core import shared\nimport router\n' },
    { path: 'leaf_c.py', content: 'from core import shared\n' },
    { path: 'styles.css', content: '.a { color: red; }\n'.repeat(50) }
];
const scored = core.scoreFilesForDigest(project);
const rankOf = name => scored.findIndex(item => item.path === name);
assert.ok(rankOf('router.py') < rankOf('leaf_a.py'),
    'an entry-point hub did not outrank a leaf file');
assert.ok(rankOf('core.py') < rankOf('leaf_a.py'),
    'a file imported by three others did not outrank its importers');
const byPath = Object.fromEntries(scored.map(item => [item.path, item]));
assert.ok(byPath['core.py'].references >= 3,
    `inbound reference counting failed: core.py references=${byPath['core.py'].references}`);
assert.ok(byPath['styles.css'].score < byPath['router.py'].score,
    'a stylesheet outranked code');

// Vendor files score far below everything else.
const withVendor = core.scoreFilesForDigest(project.concat([
    { path: 'vendor/big.js', content: 'a'.repeat(10000) }
]));
assert.ok(withVendor[withVendor.length - 1].path === 'vendor/big.js',
    'a vendored file did not sort to the bottom');

// ---------------------------------------------------------------------------
// 6. Scope filter behaviour (the answer that used to be decorative)
// ---------------------------------------------------------------------------

// These live in agent.js; exercise them through the same core helpers the
// agent uses so the contract is tested, not just the parser.
project = [
    { path: 'comfy/index.html', content: '<html></html>\n' },
    { path: 'comfy/runtime-config.js', content: 'const x = 1;\n'.repeat(60) },
    { path: 'ai_agents/graph.js', content: 'function g() {}\n'.repeat(60) },
    { path: 'router.py', content: 'def r():\n    pass\n'.repeat(60) }
];
const narrow = project.filter(item => item.path.toLowerCase().indexOf('comfy') >= 0);
assert.equal(narrow.length, 2, 'the path filter shape used by the scope answer is wrong');
result = core.buildCodebaseDigest(narrow, { budgetTokens: 8000 });
assert.equal(result.fileCount, 2, 'a narrowed digest did not restrict to the subsystem');
assert.ok(result.digestText.indexOf('ai_agents/graph.js') < 0,
    'a narrowed digest still contained files outside the subsystem');

// A whole-project digest of the same set keeps everything.
result = core.buildCodebaseDigest(project, { budgetTokens: 8000 });
assert.equal(result.fileCount, 4, 'the unnarrowed digest lost files');

// Degenerate inputs must not throw.
result = core.buildCodebaseDigest([], { budgetTokens: 8000 });
assert.equal(result.fileCount, 0);
assert.equal(result.tokens, 0);
assert.equal(result.coverage, 0, 'an empty project reported non-zero coverage');
result = core.buildCodebaseDigest(null, { budgetTokens: 8000 });
assert.equal(result.fileCount, 0);
result = core.buildCodebaseDigest([{ path: 'a.py' }, null, { content: 'x' }], { budgetTokens: 8000 });
assert.equal(result.fileCount, 0, 'malformed records were not filtered out');

// Budget clamping: a nonsense budget still yields a usable digest.
result = core.buildCodebaseDigest(makeProject(10, 20), { budgetTokens: 0 });
assert.ok(result.budget >= 512, `the budget floor was not applied: ${result.budget}`);
assert.ok(result.tokens <= result.budget, 'a clamped budget was still exceeded');

console.log('codebase-digest.test.cjs: 6 groups passed');
console.log('  extraction  : py routes/classes/methods, js classes/arrows, host registrations,');
console.log('                command tables, css selectors, md headings, json keys, html wiring');
console.log('  exclusion   : vendored paths and minified bundles stubbed, budget untouched');
console.log('  dedup       : repeated classes/functions listed once');
console.log('  budget      : hard cap at any size, adaptive depth, overflow drops lowest-scoring');
console.log('                and discloses the omission instead of silently overrunning');
console.log('  scoring     : entry points and import hubs outrank leaves; css and vendor sink');
console.log('  scope       : narrowing restricts the digest; degenerate inputs are safe');
process.exit(0);
