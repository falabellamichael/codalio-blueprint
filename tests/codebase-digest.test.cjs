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
 *      before disclosing any files that still cannot fit.
 *   5. Scoring: a hub file imported by many others outranks leaf files;
 *      stylesheets and vendor files rank below code.
 *   6. Scope filter: the clarifying "scope" answer narrows the digest, a
 *      "whole codebase" answer does not, and an explicit scope never expands
 *      through a dependency outside the permitted paths.
 *   7-9. Request-focused chunks, static links, prompt rendering and budgets.
 *
 * Run: node tests/codebase-digest.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');
const { createDocument, createLocalStorage } = require('./dom-stub.cjs');

function loadBlueprint() {
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
    for (const name of ['skills.js', 'agent.js']) {
        vm.runInContext(fs.readFileSync(path.join(SRC, name), 'utf8'), context, { filename: name });
    }
    return {
        core: sandbox.window.__codalioBlueprintCore,
        agent: sandbox.window.__codalioBlueprintAgent,
        skills: sandbox.window.__codalioBlueprintSkills
    };
}

const { core, agent, skills } = loadBlueprint();
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

// 7. Request-focused chunks find implementation in the middle of a large
// module; static coupling adds direct neighbours without following a chain.
const largeModule = [
    "import { helper } from './utils.js';",
    ...Array.from({ length: 250 }, (_, i) => `const before_${i} = ${i};`),
    'export function refreshLease(owner) {',
    '    const verified = helper(owner);',
    '    return verified;',
    '}',
    'function unrelatedTail() {',
    ...Array.from({ length: 250 }, (_, i) => `    const after_${i} = ${i};`),
    '}'
].join('\n');
const coupledProject = [
    { path: 'src/session/lease.js', content: largeModule },
    { path: 'src/session/utils.js', content: "import { clock } from '../clock.js';\nexport function helper(value) { return clock(value); }" },
    { path: 'src/clock.js', content: 'export function clock(value) { return value; }' },
    { path: 'other/utils.js', content: 'export function privateUnrelatedBody() { return 999; }' },
    { path: 'unrelated.js', content: 'export function unrelatedBody() { return 123; }' }
];
result = core.buildCodebaseDigest(coupledProject, { budgetTokens: 4000, focusText: 'Explain refreshLease', minFullTextLines: 40 });
assert.equal(result.focused, true);
assert.equal(result.coupledFiles, 1, 'one direct dependency should get implementation evidence');
assert.deepEqual(Array.from(result.fullTextFiles).sort(), ['src/session/lease.js', 'src/session/utils.js']);
assert.match(result.fullTextRecords[0].content, /const verified = helper\(owner\)/);
assert.doesNotMatch(result.fullTextRecords[0].content, /before_0|after_249|unrelatedTail/);
assert.match(result.digestText, /uses: src\/session\/utils\.js/);
assert.match(result.digestText, /used by: src\/session\/lease\.js/);
assert.ok(result.fullTextRecords.every(file => file.path !== 'src/clock.js'), 'a transitive dependency was automatically read');
for (const record of result.fullTextRecords) {
    const original = coupledProject.find(file => file.path === record.path).content.split('\n');
    assert.ok(record.ranges.length <= 2);
    let lastEnd = 0;
    for (const range of record.ranges) {
        assert.ok(range.startLine > lastEnd, 'chunks overlap or repeat');
        assert.ok(range.endLine - range.startLine < 80, 'chunk exceeded the line bound');
        assert.ok(record.content.includes(original.slice(range.startLine - 1, range.endLine).join('\n')),
            'line range does not refer to the supplied original lines');
        lastEnd = range.endLine;
    }
}
assert.ok(result.tokens <= 4000);

// 8. Resolve exact relative modules, Python packages, HTML assets and IIFE
// globals; don't turn an external package or duplicate basename into a link.
const linkingProject = [
    { path: 'a/main.js', content: "import './setup.js';\nexport { helper } from './utils';\nconst { config } = require('../config.js');\nimport external from 'utils';" },
    { path: 'a/utils.js', content: 'export const helper = 1;' },
    { path: 'b/utils.js', content: 'export const other = 2;' },
    { path: 'a/setup.js', content: 'window.setupReady = true;' },
    { path: 'config.js', content: 'export const config = {};' },
    { path: 'pkg/main.py', content: 'from .utils import helper\nfrom pkg.sub import entry' },
    { path: 'pkg/utils.py', content: 'def helper():\n    return True' },
    { path: 'pkg/sub/__init__.py', content: 'def entry():\n    return True' },
    { path: 'utils.py', content: 'def other():\n    pass' },
    { path: 'a/page.html', content: '<script src="./main.js"></script><link href="theme.css" rel="stylesheet">' },
    { path: 'a/theme.css', content: '.panel { color: red; }' },
    { path: 'globals.js', content: 'window.__exampleCore = Object.freeze({});' },
    { path: 'consumer.js', content: 'const core = window.__exampleCore;\nfunction consume() { return core; }' }
];
result = core.buildCodebaseDigest(linkingProject, { budgetTokens: 16000 });
assert.match(result.digestText, /uses: a\/setup\.js, a\/utils\.js, config\.js;.*1 import\(s\) external or unresolved/);
assert.match(result.digestText, /uses: pkg\/utils\.py, pkg\/sub\/__init__\.py/);
assert.match(result.digestText, /uses: a\/main\.js, a\/theme\.css/);
assert.match(result.digestText, /uses: globals\.js/);
const linkedScores = Object.fromEntries(core.scoreFilesForDigest(linkingProject).map(file => [file.path, file]));
assert.equal(linkedScores['b/utils.js'].references, 0);
assert.equal(linkedScores['utils.py'].references, 0);
assert.equal(linkedScores['a/utils.js'].references, 1, 'external package incorrectly added an inbound reference');
const ambiguous = core.buildCodebaseDigest([
    { path: 'main.js', content: "import './utils';\nimport '../outside.js';" },
    { path: 'utils.js', content: 'const a = 1;' },
    { path: 'utils.ts', content: 'const a = 2;' },
    { path: 'outside.js', content: 'const privateValue = 3;' }
], { budgetTokens: 4000 });
assert.match(ambiguous.digestText, /2 import\(s\) external or unresolved/);
assert.doesNotMatch(ambiguous.digestText, /uses: /);

// 9. Exercise the actual agent selection and source renderer, not just helper
// counts. Every rendered envelope stays inside the budget, including fences,
// static links, chunk labels and omission disclosure.
const folder = core.createFolder('Chunk fixture').folder;
for (const file of coupledProject) core.writeFile(file.path, file.content, { folder: folder.id, origin: 'imported' });
for (const budget of [2048, 4000, 16000]) {
    const selected = agent.sourceFilesForModel({ activeFolderId: folder.id, idea: 'Explain refreshLease', answers: [] },
        Object.assign({}, core.DEFAULT_SETTINGS, { sourceContextMode: 'digest', digestBudgetTokens: budget }));
    const prompt = skills.sourceBlock(selected);
    assert.equal(selected.digestStats.focused, true, 'the agent did not pass the request into chunk selection');
    assert.match(prompt, /lease\.js:L252-L255/);
    assert.match(prompt, /const verified = helper\(owner\)/);
    assert.doesNotMatch(prompt, /privateUnrelatedBody\(\) \{ return 999/);
    assert.ok(TOK(prompt) <= budget, `rendered source exceeded ${budget}: ${TOK(prompt)}`);
    assert.ok(selected.digestStats.tokens <= budget);
}
const manual = agent.sourceFilesForModel({
    activeFolderId: folder.id, idea: 'Explain refreshLease', answers: [], sourceFiles: [{ path: 'other/utils.js', folderId: folder.id }]
}, Object.assign({}, core.DEFAULT_SETTINGS, { sourceContextMode: 'digest' }));
assert.equal(manual.find(file => file.path === 'other/utils.js').excerpted, false);
assert.equal(manual.find(file => file.path === 'other/utils.js').content, coupledProject[3].content);
const scoped = agent.sourceFilesForModel({ activeFolderId: folder.id, idea: 'Explain refreshLease',
    answers: [{ id: 'scope', question: 'Scope?', answer: 'src/session' }] },
Object.assign({}, core.DEFAULT_SETTINGS, { sourceContextMode: 'digest' }));
assert.ok(scoped.every(file => file.path.startsWith('src/session/')), 'coupling escaped the explicit subsystem');
assert.match(scoped.digestText, /external or unresolved/);
assert.doesNotMatch(scoped.digestText, /### src\/clock\.js/);
assert.match(agent.systemPromptWith('Return the requested Markdown.', {}), /Bounded code reading/);
assert.match(agent.systemPromptWith('Return the requested Markdown.', {}), /do not invent it or imply you fetched it/);

// Redaction cannot shift every source citation below a multiline credential.
const privateBlock = '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----';
const sourceWithKey = `const metadata = \`${privateBlock}\`;\nfunction refreshLease() { return 7; }`;
const sanitized = core.sanitizeSourceForModel(sourceWithKey);
assert.equal(sanitized.content.split('\n').length, sourceWithKey.split('\n').length);
assert.doesNotMatch(sanitized.content, /not-a-real-key/);
assert.equal(sanitized.content.split('\n')[3], 'function refreshLease() { return 7; }');

// A manual starting point must not cause broad fallback reading of unrelated
// bodies. Cycles and fan-out still obey the finite automatic selection bound.
const manualOnly = core.buildCodebaseDigest(coupledProject, {
    budgetTokens: 16000, priorityFullTextPaths: ['other/utils.js']
});
assert.deepEqual(Array.from(manualOnly.fullTextFiles), ['other/utils.js']);
const fanout = Array.from({ length: 25 }, (_, i) => ({ path: `dep${i}.js`,
    content: `import './entry.js';\nexport function value${i}() { return ${i}; }` }));
fanout.unshift({ path: 'entry.js', content: fanout.map(file => `import './${file.path}';`).join('\n')
    + '\nexport function focusAction() { return 1; }' });
const fanoutDigest = core.buildCodebaseDigest(fanout, { budgetTokens: 16000, focusText: 'Explain focusAction' });
assert.ok(fanoutDigest.fullTextFiles.length <= 5, 'fan-out escaped the four-neighbour bound');
assert.ok(fanoutDigest.chunkCount <= 10);
assert.equal(core.scoreFilesForDigest(fanout).find(file => file.path === 'dep24.js').references, 1,
    'coupling stopped at the old fourteen-import display cap');
const oversizedLine = core.buildCodebaseDigest([{ path: 'long.js',
    content: 'function longAction() { return "' + 'x'.repeat(5000) + '"; }\n' + '// padding\n'.repeat(20)
}], { budgetTokens: 16000, focusText: 'longAction' });
assert.ok(oversizedLine.fullTextRecords.every(file => !file.content.includes('x'.repeat(5000))),
    'one long source line escaped the per-chunk character cap');
const localCoupling = core.buildCodebaseDigest([
    { path: 'feature.js', content: 'function helper() { return 42; }\n'
        + 'function focusAction() { return helper(); }\n'
        + 'function unrelated() { return 0; }' },
    { path: 'caller.js', content: "import './feature.js';\n// focusAction is used elsewhere\nfunction caller() { return 0; }" }
], { budgetTokens: 4000, focusText: 'Explain focusAction' });
assert.deepEqual(Array.from(localCoupling.fullTextFiles), ['feature.js'], 'a weak caller/comment match widened reading');
assert.match(localCoupling.fullTextRecords[0].content, /function helper\(\) \{ return 42; \}/,
    'a directly referenced local helper lost to unrelated text');
assert.doesNotMatch(localCoupling.fullTextRecords[0].content, /function unrelated/);

// Budget checks on an overflowing map use exactly the same renderer the
// phase prompt calls.
for (const budget of [2048, 4000]) {
    const crowded = core.buildCodebaseDigest(makeProject(300, 15), { budgetTokens: budget });
    const selected = Array.from(crowded.fullTextRecords, record => Object.assign({
        lines: record.content.split('\n').length
    }, record));
    selected.digestText = crowded.digestText;
    selected.digestStats = {
        filesScanned: crowded.scannedCount, filesDigested: crowded.fileCount,
        coverage: crowded.coverage, trimmed: crowded.trimmed, omittedCount: crowded.omittedCount,
        chunkCount: crowded.chunkCount, coupledFiles: crowded.coupledFiles
    };
    assert.ok(TOK(skills.sourceBlock(selected)) <= budget, `crowded map exceeded ${budget}`);
}

// 10. Small manifest facts remain usable without attaching its entire body.
const pluginManifest = fs.readFileSync(path.join(SRC, 'plugin.json'), 'utf8');
const manifestMap = core.digestFileStructure('src/plugin.json', pluginManifest).text;
assert.match(manifestMap, /declared manifest metadata: .*"id":"codalio-blueprint"/);
assert.match(manifestMap, /"name":"Codalio Blueprint","version":"1\.0\.0"/);
assert.match(manifestMap, /"permissions":\["ui\.page","llm\.use","filesystem\.write","clipboard\.write"\]/);
assert.doesNotMatch(manifestMap, /Michael|Contributes one dedicated/);
assert.doesNotMatch(core.digestFileStructure('settings.json', pluginManifest).text, /declared manifest metadata/);
assert.doesNotThrow(() => core.digestFileStructure('plugin.json', '{broken'));
const longManifest = core.digestFileStructure('package.json', JSON.stringify({
    name: 'x'.repeat(1000), version: '1.0', api_key: 'shouldNeverEnterTheMap',
    permissions: Array.from({ length: 100 }, (_, i) => ({ id: 'permission' + i, reason: 'privateReason' }))
}, null, 2)).text;
assert.match(longManifest, /truncated/);
assert.match(longManifest, /"permissionsOmitted":88/);
assert.doesNotMatch(longManifest, /shouldNeverEnterTheMap|privateReason|permission12/);
assert.ok(longManifest.length < 1000);
const metadataSecret = 'sk-proj-' + 'a'.repeat(24);
assert.doesNotMatch(core.digestFileStructure('manifest.json', JSON.stringify({ name: metadataSecret })).text,
    new RegExp(metadataSecret), 'metadata bypassed source sanitization');

// Exercise the real settings/schema through import, selection, rendering and
// the final model sanitizer. Identifiers must survive all four boundaries.
const schemaFolder = core.createFolder('Schema fixture').folder;
core.writeFile('src/plugin.json', pluginManifest, { folder: schemaFolder.id, origin: 'imported' });
core.writeFile('src/settings.js', fs.readFileSync(path.join(SRC, 'settings.js'), 'utf8'),
    { folder: schemaFolder.id, origin: 'imported' });
const schemaSelected = agent.sourceFilesForModel({ activeFolderId: schemaFolder.id,
    idea: 'Explain listPaneWidth', answers: [] }, Object.assign({}, core.DEFAULT_SETTINGS,
    { sourceContextMode: 'digest', digestBudgetTokens: 4000 }));
const schemaPrompt = core.sanitizeSourceForModel(skills.sourceBlock(schemaSelected)).content;
assert.deepEqual(Array.from(schemaSelected, file => file.path), ['src/settings.js'],
    'manifest metadata widened automatic implementation reading');
assert.match(schemaPrompt, /key: 'listPaneWidth'/);
assert.match(schemaPrompt, /"name":"Codalio Blueprint","version":"1\.0\.0"/);
assert.ok(TOK(schemaPrompt) <= 4000);

// 11. A branch near the 80-line boundary stays together, including its message,
// destination rule and else arm. Quotes/comments/regexes are not delimiters.
const revisionBranch = [
    "    if (file.origin === 'imported') {",
    '        showNotice(',
    "            'Writing revision ' +",
    "            'to docs/ instead.',",
    "            { type: 'info' }",
    '        );',
    '        const destination = `docs/${file.name}`;',
    '        return writeFile(destination, file.content);',
    '    }',
    '    else {',
    '        return writeFile(file.path, file.content);',
    '    }'
].join('\n');
const branchSource = 'function reviseImported(file) {\n'
    + Array.from({ length: 74 }, (_, i) => `    const before_${i} = ${i};`).join('\n') + '\n'
    + revisionBranch + '\n}\n'
    + 'function unrelated() { return /[{}]/.test("}"); /* { */ }';
const branchDigest = core.buildCodebaseDigest([{ path: 'writer.js', content: branchSource }],
    { budgetTokens: 4000, focusText: 'Explain revision destination docs' });
assert.ok(branchDigest.fullTextRecords.some(file => file.content.includes(revisionBranch)),
    'the supplied evidence split a fitting branch/message across excerpt boundaries');
assert.ok(branchDigest.fullTextRecords.every(file => !file.content.includes('function unrelated')));
for (const file of branchDigest.fullTextRecords) {
    for (const range of file.ranges) assert.ok(range.endLine - range.startLine < 80);
}

// If a whole excerpt cannot fit the remaining token allowance, omit it instead
// of chopping the tail off a multiline call. Larger budgets still supply it.
const longMessage = 'function renderRevision() {\n    return showNotice(\n'
    + "        'Writing revision ' +\n"
    + Array.from({ length: 20 }, (_, i) => `        '${i}: ${'context '.repeat(12)}' +`).join('\n')
    + "\n        'to docs/ instead.'\n    );\n}";
for (const budget of [2048, 4000]) {
    const messageDigest = core.buildCodebaseDigest([{ path: 'message.js', content: longMessage }],
        { budgetTokens: budget, focusText: 'Explain renderRevision' });
    assert.ok(messageDigest.fullTextRecords.every(file => file.content.includes(longMessage)),
        `budget ${budget} sent a partial multiline call`);
    if (budget === 4000) assert.equal(messageDigest.fullTextRecords.length, 1);
    assert.ok(messageDigest.tokens <= budget);
}
const hugeMessage = longMessage.replace('context ', 'x'.repeat(4000));
const hugeDigest = core.buildCodebaseDigest([{ path: 'message.js', content: hugeMessage }],
    { budgetTokens: 16000, focusText: 'Explain renderRevision' });
assert.ok(hugeDigest.fullTextRecords.every(file => !/Writing revision|to docs\/ instead/.test(file.content)),
    'an oversized statement leaked continuation lines as separate evidence');

console.log('codebase-digest.test.cjs: 11 groups passed');
console.log('  extraction  : py routes/classes/methods, js classes/arrows, host registrations,');
console.log('                command tables, css selectors, md headings, json keys, html wiring');
console.log('  exclusion   : vendored paths and minified bundles stubbed, budget untouched');
console.log('  dedup       : repeated classes/functions listed once');
console.log('  budget      : hard cap at any size, adaptive depth, overflow drops lowest-scoring');
console.log('                and discloses the omission instead of silently overrunning');
console.log('  scoring     : entry points and import hubs outrank leaves; css and vendor sink');
console.log('  scope       : narrowing restricts the digest; degenerate inputs are safe');
console.log('  chunks      : middle-of-file evidence, local helpers, one-hop dependencies, accurate ranges');
console.log('  boundaries  : explicit scope, manual priority, redaction, fan-out and rendered budgets');
process.exit(0);
