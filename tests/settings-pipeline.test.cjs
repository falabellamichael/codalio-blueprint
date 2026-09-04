'use strict';

/*
 * Codalio Blueprint — settings engine + document pipeline test.
 *
 * Covers the schema-driven settings (clamping, coercion, import/export round
 * trip, garbage rejection), the deterministic document cleanup pipeline, the
 * naming/folder/collision output-path logic, storage accounting, and the agent
 * behaviours the new settings drive — including the source-limit bug that was
 * silently a no-op before (it compared against an undefined constant).
 *
 * Run: node tests/settings-pipeline.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');

// ---------------------------------------------------------------------------
// Minimal DOM + storage stubs (the pipeline needs document.createElement for the
// markdown renderer and localStorage for persistence).
// ---------------------------------------------------------------------------

function makeElement(tagName) {
    const classes = new Set();
    const element = {
        tagName: String(tagName).toUpperCase(),
        nodeType: 1,
        dataset: {},
        attributes: {},
        children: [],
        childElementCount: 0,
        style: { setProperty() {}, getPropertyValue() { return ''; } },
        innerHTML: '',
        lastElementChild: null,
        get classList() {
            return {
                add: (...names) => names.forEach(name => classes.add(name)),
                remove: (...names) => names.forEach(name => classes.delete(name)),
                toggle: (name, force) => {
                    const on = force === undefined ? !classes.has(name) : Boolean(force);
                    if (on) classes.add(name); else classes.delete(name);
                    return on;
                },
                contains: name => classes.has(name)
            };
        },
        appendChild(child) {
            this.children.push(child);
            this.childElementCount = this.children.length;
            this.lastElementChild = child;
            return child;
        },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] === undefined ? null : this.attributes[name]; },
        addEventListener() {}, removeEventListener() {}, click() {}, focus() {},
        dispatchEvent() { return true; },
        querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; }
    };
    Object.defineProperty(element, 'className', {
        get: () => [...classes].join(' '),
        set: value => { classes.clear(); String(value || '').split(/\s+/).filter(Boolean).forEach(n => classes.add(n)); },
        configurable: true
    });
    Object.defineProperty(element, 'textContent', {
        get() { return (element.children || []).map(c => c.textContent || '').join(''); },
        set(value) {
            element.children.length = 0;
            element.childElementCount = 0;
            if (value) element.children.push({ nodeType: 3, textContent: String(value), children: [] });
        },
        configurable: true
    });
    return element;
}

const localStorageStub = (() => {
    const map = new Map();
    return {
        getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
        setItem: (key, value) => { map.set(String(key), String(value)); },
        removeItem: key => { map.delete(String(key)); },
        clear: () => { map.clear(); }
    };
})();

const documentStub = {
    documentElement: makeElement('html'),
    body: makeElement('body'),
    readyState: 'complete',
    createElement: makeElement,
    createDocumentFragment() { return makeElement('fragment'); },
    createTextNode(text) { return { nodeType: 3, textContent: String(text), children: [] }; },
    getElementById() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }
};

// Mocked stream so the agent can run without a live endpoint.
const requests = [];
let canned = '';
async function fakeFetch(url, options) {
    const href = String(url || '');
    if (href.endsWith('/chat/stream') && String((options && options.method) || 'GET') === 'POST') {
        const payload = JSON.parse(String(options.body || '{}'));
        requests.push(payload);
        const full = canned;
        const lines = [
            JSON.stringify({ type: 'content', delta: full }),
            JSON.stringify({ type: 'done', response: full, thinking: '', finish_reason: 'stop', usage: { completion_tokens: full.length } })
        ];
        const encoded = lines.map(line => new TextEncoder().encode(line + '\n'));
        return {
            ok: true, status: 200,
            body: { getReader() { let i = 0; return { async read() { return i >= encoded.length ? { value: new TextEncoder().encode(''), done: true } : { value: encoded[i++], done: false }; } }; } },
            json: async () => ({ response: full })
        };
    }
    throw new Error(`unexpected fetch: ${href}`);
}

const windowStub = {
    document: documentStub,
    localStorage: localStorageStub,
    location: { href: 'http://127.0.0.1:18411/gui/' },
    navigator: { clipboard: null },
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = (init || {}).detail; } },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    Blob: class {}, FileReader: class { readAsText() {} },
    fetch: fakeFetch,
    TextDecoder: global.TextDecoder, TextEncoder: global.TextEncoder, AbortController: global.AbortController,
    withConfiguredModelEndpointPayload: payload => Object.assign({}, payload, { endpoint_id: 'test', model: 'test-model' }),
    RagChatStreaming: {
        readJsonLineStream: async (response, onEvent) => {
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let nl;
                while ((nl = buffer.search(/\r?\n/)) !== -1) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + (buffer[nl] === '\r' ? 2 : 1));
                    if (line) await onEvent(JSON.parse(line));
                }
            }
            const tail = buffer.trim();
            if (tail) await onEvent(JSON.parse(tail));
        }
    }
};
windowStub.window = windowStub;
windowStub.globalThis = windowStub;

const sandbox = {
    window: windowStub, document: documentStub, localStorage: localStorageStub,
    navigator: windowStub.navigator, location: windowStub.location, console,
    setTimeout: windowStub.setTimeout, clearTimeout: windowStub.clearTimeout,
    setInterval: windowStub.setInterval, clearInterval: windowStub.clearInterval,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    MutationObserver: windowStub.MutationObserver, CustomEvent: windowStub.CustomEvent,
    URL: windowStub.URL, Blob: windowStub.Blob, FileReader: windowStub.FileReader, fetch: fakeFetch,
    TextDecoder: global.TextDecoder, TextEncoder: global.TextEncoder, AbortController: global.AbortController,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, Promise, Intl,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);
function runFile(file) { vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file }); }

runFile(path.join(SRC, 'controller-core.js'));
runFile(path.join(SRC, 'skills.js'));
runFile(path.join(SRC, 'settings.js'));
runFile(path.join(SRC, 'agent.js'));

const core = sandbox.window.__codalioBlueprintCore;
const skills = sandbox.window.__codalioBlueprintSkills;
const schema = sandbox.window.__codalioBlueprintSettings;
const agent = sandbox.window.__codalioBlueprintAgent;

function resetStores() {
    localStorageStub.clear();
    core.store.files = {};
    core.store.runs = [];
    core.store.openPath = '';
    core.store.activeRunId = '';
    core.store.projectName = '';
    core.writeStore();
    requests.length = 0;
}

// ---------------------------------------------------------------------------
// 1. Every schema field has a matching core default, and vice versa
// ---------------------------------------------------------------------------

resetStores();
const schemaFields = schema.allFields();
const schemaKeys = schemaFields.map(f => f.key).sort();
const coreKeys = Object.keys(core.DEFAULT_SETTINGS).sort();

// Duplicate keys are checked FIRST and separately. Two agents editing this repo
// concurrently both added `contextCompression` / `autoCompactThreshold`, once
// inline and once in a dedicated sub-page; the key-set comparison below did catch
// it, but only as an unreadable 44-key string diff. Naming the duplicates is what
// makes the failure diagnosable.
const seen = new Set();
const duplicates = [];
schemaFields.forEach(field => {
    if (seen.has(field.key)) duplicates.push(field.key);
    seen.add(field.key);
});
assert.deepEqual(duplicates, [],
    `settings schema declares duplicate keys: ${duplicates.join(', ')}`);

assert.equal(schemaKeys.join(','), coreKeys.join(','),
    'settings.js schema and core.DEFAULT_SETTINGS disagree on the key set');
assert.ok(schemaKeys.length >= 40, `expected a thorough settings surface, found ${schemaKeys.length}`);

// Every default is inside its declared bounds (a default out of range would be
// clamped away on first read, so the UI would never show the documented value).
schemaFields.forEach(field => {
    const value = core.DEFAULT_SETTINGS[field.key];
    if (field.type === 'number' || field.type === 'range') {
        assert.ok(value >= field.min && value <= field.max,
            `default for ${field.key} (${value}) is outside ${field.min}..${field.max}`);
    }
    if (field.type === 'segmented' || field.type === 'select') {
        assert.ok(field.options.some(o => o.value === value),
            `default for ${field.key} (${value}) is not one of its options`);
    }
});

// ---------------------------------------------------------------------------
// 2. Normalization clamps out-of-range and rejects wrong-typed values
// ---------------------------------------------------------------------------

const clamped = schema.normalizeSettings({
    temperature: 9,                       // max 1.5
    lensMaxOutputTokens: 99,             // min 512
    documentMaxOutputTokens: 1e9,        // max 32768
    maxOpenTabs: 1,                      // min 2
    listPaneWidth: 40,                   // min 220
    concurrency: 'sideways',             // not an option
    fileNameStyle: 'nope',
    askClarifyingQuestions: 'yes',       // wrong type -> falls back to default
    extraGuidance: 'x'.repeat(5000),     // longer than maxChars
    maxSourceFiles: 'twelve'             // NaN
});
assert.equal(clamped.temperature, 1.5, 'temperature was not clamped to its max');
assert.equal(clamped.lensMaxOutputTokens, 512, 'lens tokens were not clamped to the min');
assert.equal(clamped.documentMaxOutputTokens, 32768, 'document tokens were not clamped to the max');
assert.equal(clamped.maxOpenTabs, 2, 'maxOpenTabs was not clamped to its min');
assert.equal(clamped.listPaneWidth, 220, 'listPaneWidth was not clamped to its min');
assert.equal(clamped.concurrency, 'parallel', 'an invalid enum fell back to something other than the default');
assert.equal(clamped.fileNameStyle, 'date-slug');
assert.equal(clamped.askClarifyingQuestions, true, 'a non-boolean toggle did not fall back to its default');
assert.ok(clamped.extraGuidance.length <= 1200, 'extraGuidance was not length-limited');
assert.equal(clamped.maxSourceFiles, core.DEFAULT_SETTINGS.maxSourceFiles, 'a NaN number did not fall back');

// Unknown keys are dropped, known keys kept.
const filtered = schema.normalizeSettings({ temperature: 0.5, notASetting: 'x', another: 2 });
assert.equal(filtered.temperature, 0.5);
assert.equal('notASetting' in filtered, false, 'an unknown key survived normalization');
assert.equal('another' in filtered, false, 'an unknown key survived normalization');

// Temperature snaps to its declared step so a slider and the value agree.
const snapped = schema.normalizeSettings({ temperature: 0.313 });
assert.equal(snapped.temperature, 0.3, 'temperature was not snapped to its step');

// A corrupt stored settings blob reads back as all-defaults, never throws.
localStorageStub.setItem(core.SETTINGS_KEY, '{ broken json');
assert.doesNotThrow(() => core.readSettings());
assert.equal(core.readSettings().concurrency, 'parallel');

// core.readSettings() delegates to the schema, so both agree on a stored value.
resetStores();
core.writeSettings({ temperature: 0.9, concurrency: 'sequential' });
const viaCore = core.readSettings();
assert.equal(viaCore.temperature, 0.9);
assert.equal(viaCore.concurrency, 'sequential');
// A value the schema would clamp is clamped through core too.
core.writeSettings({ temperature: 42 });
assert.equal(core.readSettings().temperature, 1.5, 'core.readSettings bypassed schema clamping');

// ---------------------------------------------------------------------------
// 3. Export / import round-trip
// ---------------------------------------------------------------------------

resetStores();
core.writeSettings({ temperature: 0.7, concurrency: 'sequential', maxOpenTabs: 5, extraGuidance: 'Write in British English.' });
const exported = schema.exportSettings(core.readSettings());
const parsedExport = JSON.parse(exported);
assert.equal(parsedExport.format, 'codalio-blueprint.settings');
assert.equal(parsedExport.version, 1);
assert.equal(parsedExport.settings.temperature, 0.7);
assert.equal(parsedExport.settings.extraGuidance, 'Write in British English.');

// Round-trip into a different current state and confirm the values transfer.
core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS));
const importResult = schema.parseSettingsFile(exported);
assert.equal(importResult.settings.temperature, 0.7, 'import did not restore temperature');
assert.equal(importResult.settings.concurrency, 'sequential', 'import did not restore concurrency');
assert.equal(importResult.settings.maxOpenTabs, 5, 'import did not restore maxOpenTabs');
assert.equal(importResult.applied, schemaKeys.length, 'import did not report the applied count');

// A bare { key: value } object also imports.
const bare = schema.parseSettingsFile(JSON.stringify({ temperature: 0.2, concurrency: 'parallel' }));
assert.equal(bare.settings.temperature, 0.2);
assert.ok(bare.applied >= 2);
assert.ok(bare.ignored >= 0);

// Importing clamps hostile values rather than trusting them.
const hostile = schema.parseSettingsFile(JSON.stringify({ settings: { temperature: 999, maxOpenTabs: 0 } }));
assert.equal(hostile.settings.temperature, 1.5, 'import did not clamp an out-of-range temperature');
assert.equal(hostile.settings.maxOpenTabs, 2, 'import did not clamp an out-of-range tab count');

// Importing unknown keys ignores them and still applies the known ones.
const mixed = schema.parseSettingsFile(JSON.stringify({ bogus: 1, temperature: 0.4 }));
assert.equal(mixed.settings.temperature, 0.4);
assert.equal(mixed.ignored, 1, 'an unknown import key was not counted as ignored');
assert.equal('bogus' in mixed.settings, false);

// Garbage import throws a clear error rather than corrupting state.
assert.throws(() => schema.parseSettingsFile('not json'), /./);
assert.throws(() => schema.parseSettingsFile('{}'), /No recognised/, 'an empty object should be rejected');
assert.throws(() => schema.parseSettingsFile(JSON.stringify({ nope: 1 })), /No recognised/);

// ---------------------------------------------------------------------------
// 4. Value descriptions are human-readable and reflect the value
// ---------------------------------------------------------------------------

const tempField = schema.getField('temperature');
assert.equal(schema.describeValue(tempField, 0.3), '0.30', 'a range with a format fn was not formatted');
const concField = schema.getField('concurrency');
assert.equal(schema.describeValue(concField, 'sequential'), 'Sequential', 'an enum was not mapped to its label');
const toggleField = schema.getField('askClarifyingQuestions');
assert.equal(schema.describeValue(toggleField, true), 'On');
assert.equal(schema.describeValue(toggleField, false), 'Off');
const numField = schema.getField('lensMaxOutputTokens');
assert.match(schema.describeValue(numField, 4096), /tokens/, 'a unit was not appended');
const textField = schema.getField('extraGuidance');
assert.equal(schema.describeValue(textField, ''), 'Empty');
assert.match(schema.describeValue(textField, 'y'.repeat(80)), /\.\.\.$/, 'long text was not truncated');

// ---------------------------------------------------------------------------
// 5. Document cleanup pipeline
// ---------------------------------------------------------------------------

const pipelineSettings = Object.assign({}, core.DEFAULT_SETTINGS, {
    unwrapCodeFences: true, trimPreamble: true, substitutePlaceholders: true, applyDocumentHeader: false
});

// Code fence is unwrapped.
const fenced = '```markdown\n# Title\n\nBody.\n```';
const unwrapped = core.prepareDocument(fenced, { projectName: 'ToolShare', date: '2026-09-03' }, pipelineSettings);
assert.ok(!unwrapped.startsWith('```'), 'the opening fence survived');
assert.ok(!unwrapped.endsWith('```'), 'the closing fence survived');
assert.match(unwrapped, /^# Title/);

// Preamble before the first heading is trimmed.
const withPreamble = 'Sure! Here is your PRD.\n\n# Title\n\nBody.';
const trimmed = core.prepareDocument(withPreamble, { projectName: 'X', date: '2026-09-03' }, pipelineSettings);
assert.match(trimmed, /^# Title/, 'the conversational preamble was not trimmed');
assert.ok(!trimmed.includes('Sure!'), 'preamble text survived');

// Placeholders are substituted.
const withPlaceholders = '# <Project Name> PRD\n\nGenerated <date>.';
const substituted = core.prepareDocument(withPlaceholders, { projectName: 'ToolShare', date: '2026-09-03' }, pipelineSettings);
assert.ok(!substituted.includes('<Project Name>'), 'the project-name placeholder survived');
assert.ok(!substituted.includes('<date>'), 'the date placeholder survived');
assert.match(substituted, /ToolShare/);
assert.match(substituted, /2026-09-03/);

// A long "preamble" is really the document's own intro and is kept.
const longIntro = `${'A genuine introduction paragraph. '.repeat(20)}\n\n# Title\n\nBody.`;
const keptIntro = core.prepareDocument(longIntro, { projectName: 'X', date: '2026-09-03' }, pipelineSettings);
assert.match(keptIntro, /^A genuine introduction/, 'a long genuine intro was wrongly trimmed');

// Front matter is not mistaken for a preamble.
const frontMatter = '---\ntitle: x\n---\n\n# Title\n\nBody.';
const keptFront = core.prepareDocument(frontMatter, { projectName: 'X', date: '2026-09-03' }, pipelineSettings);
assert.match(keptFront, /^---/, 'YAML front matter was trimmed');

// The provenance header is added only when enabled, and never doubled.
const headerSettings = Object.assign({}, pipelineSettings, { applyDocumentHeader: true });
const headed = core.prepareDocument('# Title\n\nBody.', { projectName: 'X', date: '2026-09-03', skillName: 'PRD Builder' }, headerSettings);
assert.match(headed, /^> Generated by the PRD Builder skill on 2026-09-03/, 'no provenance header was added');
const doubleHeaded = core.prepareDocument(headed, { projectName: 'X', date: '2026-09-03', skillName: 'PRD Builder' }, headerSettings);
assert.equal(doubleHeaded.match(/> Generated by/g).length, 1, 'a second provenance header was stacked');

// Turning a stage off leaves that transformation undone.
const rawSettings = Object.assign({}, core.DEFAULT_SETTINGS, {
    unwrapCodeFences: false, trimPreamble: false, substitutePlaceholders: false, applyDocumentHeader: false
});
const untouched = core.prepareDocument('```markdown\n# <Project Name>\n```', { projectName: 'X', date: '2026-09-03' }, rawSettings);
assert.match(untouched, /```/, 'unwrapping ran despite being disabled');
assert.match(untouched, /<Project Name>/, 'substitution ran despite being disabled');

// ---------------------------------------------------------------------------
// 6. Output paths honour naming style, folder layout, and collisions
// ---------------------------------------------------------------------------

const prdSkill = skills.getSkill('prd-builder');
const meta = { date: '2026-09-03', slug: 'toolshare', projectName: 'ToolShare' };

// The skill declares its own outputFileName, which the upstream contract fixes.
const ownName = core.buildOutputPath(prdSkill, null, meta, Object.assign({}, core.DEFAULT_SETTINGS));
assert.match(ownName, /^docs\/prd\/2026-09-03-toolshare-prd\.md$/, `unexpected PRD path ${ownName}`);

// A skill with no declared name follows fileNameStyle.
const bareSkill = { id: 'bare', outputFolder: 'docs/notes' };
const dateSlug = core.buildOutputPath(bareSkill, null, meta, Object.assign({}, core.DEFAULT_SETTINGS, { fileNameStyle: 'date-slug' }));
assert.equal(dateSlug, 'docs/notes/2026-09-03-toolshare.md');
const slugDate = core.buildOutputPath(bareSkill, null, meta, Object.assign({}, core.DEFAULT_SETTINGS, { fileNameStyle: 'slug-date' }));
assert.equal(slugDate, 'docs/notes/toolshare-2026-09-03.md');
const slugOnly = core.buildOutputPath(bareSkill, null, meta, Object.assign({}, core.DEFAULT_SETTINGS, { fileNameStyle: 'slug' }));
assert.equal(slugOnly, 'docs/notes/toolshare.md');

// Flat layout collapses the folder into docs/ and folds the leaf into the name.
const flat = core.buildOutputPath(bareSkill, null, meta, Object.assign({}, core.DEFAULT_SETTINGS, { folderLayout: 'flat', fileNameStyle: 'date-slug' }));
assert.match(flat, /^docs\//, `flat layout did not collapse to docs/: ${flat}`);
assert.match(flat, /notes/, 'flat layout dropped the folder name instead of folding it into the file name');

// Collision handling: 'version' appends -2, -3 ...; 'overwrite' reuses the path.
resetStores();
const versionSettings = Object.assign({}, core.DEFAULT_SETTINGS, { overwriteExistingFile: 'version' });
core.writeFile('docs/notes/2026-09-03-toolshare.md', '# First\n', {});
const versioned = core.buildOutputPath(bareSkill, null, meta, versionSettings);
assert.equal(versioned, 'docs/notes/2026-09-03-toolshare-2.md', 'a collision did not bump to -2');
core.writeFile('docs/notes/2026-09-03-toolshare-2.md', '# Second\n', {});
const versioned3 = core.buildOutputPath(bareSkill, null, meta, versionSettings);
assert.equal(versioned3, 'docs/notes/2026-09-03-toolshare-3.md', 'a second collision did not bump to -3');
const overwrite = core.buildOutputPath(bareSkill, null, meta, Object.assign({}, core.DEFAULT_SETTINGS, { overwriteExistingFile: 'overwrite' }));
assert.equal(overwrite, 'docs/notes/2026-09-03-toolshare.md', 'overwrite mode should reuse the path');
const ask = core.buildOutputPath(bareSkill, null, meta, Object.assign({}, core.DEFAULT_SETTINGS, { overwriteExistingFile: 'ask' }));
assert.equal(ask, 'docs/notes/2026-09-03-toolshare.md', 'ask mode returns the base path for the controller to prompt on');
assert.equal(core.fileExists('docs/notes/2026-09-03-toolshare.md'), true);
assert.equal(core.fileExists('docs/notes/nope.md'), false);

// ---------------------------------------------------------------------------
// 7. Storage accounting + export bundle
// ---------------------------------------------------------------------------

resetStores();
core.writeFile('docs/prd/a.md', '# A\n\nSome body text here.', {});
core.writeFile('docs/prd/b.md', '# B\n', {});
core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS));
const usage = core.storageUsage();
assert.equal(usage.fileCount, 2);
assert.equal(usage.runCount, 0);
assert.ok(usage.projects > 0, 'project storage measured as zero with files present');
assert.ok(usage.settings > 0, 'settings storage measured as zero after a write');
assert.equal(usage.total, usage.projects + usage.settings + usage.workspace + usage.removed, 'the total does not add up');
assert.match(core.formatBytes(usage.total), /(B|KB|MB)$/, 'formatBytes did not produce a unit');
assert.equal(core.formatBytes(512), '512 B');
assert.match(core.formatBytes(2048), /KB/);

const bundle = core.exportBundle();
assert.match(bundle, /^# Blueprint project export/, 'the bundle has no header');
assert.match(bundle, /docs\/prd\/a\.md/, 'the bundle omitted a document');
assert.match(bundle, /Some body text here/, 'the bundle omitted document content');
assert.equal(bundle.split('---').length >= 3, true, 'the bundle does not separate documents');

// ---------------------------------------------------------------------------
// 8. THE SOURCE-LIMIT BUG: limits are now real, not compared to undefined
// ---------------------------------------------------------------------------

// Before the fix, sourceFilesForModel() compared `total + bytes > core.MAX_SOURCE_TOTAL_BYTES`
// where that constant was undefined — so `x > undefined` was always false and the
// cap never applied. Assert the caps now actually bite.
const tightSettings = Object.assign({}, core.DEFAULT_SETTINGS, {
    includeSourceInPrompts: true, maxSourceFiles: 2, maxSourceFileKb: 1, maxSourceTotalKb: 2
});
const oneKb = 'a'.repeat(1024);          // exactly 1 KB
const tooBig = 'b'.repeat(2048);          // 2 KB, over the per-file cap

// Per-file cap rejects an oversized file.
let selected = agent.sourceFilesForModel({ sourceFiles: [{ path: 'big.js', content: tooBig }] }, tightSettings);
assert.equal(selected.length, 0, 'a file over the per-file cap was not rejected');
assert.equal(selected.rejected.length, 1);
assert.match(selected.rejected[0].reason, /larger than/, 'the rejection did not say why');

// File-count cap rejects the third file.
selected = agent.sourceFilesForModel({
    sourceFiles: [
        { path: 'a.js', content: oneKb.slice(0, 600) },
        { path: 'b.js', content: oneKb.slice(0, 600) },
        { path: 'c.js', content: oneKb.slice(0, 600) }
    ]
}, tightSettings);
assert.equal(selected.length, 2, 'the maximum file count was not enforced');
assert.equal(selected.rejected.length, 1);
assert.match(selected.rejected[0].reason, /maximum file count/);

// Total-size cap stops before exceeding the budget. The file count must NOT be
// the binding constraint here, or the count cap fires first and this asserts
// nothing about the byte budget — so allow plenty of files and starve the bytes.
const byteSettings = Object.assign({}, core.DEFAULT_SETTINGS, {
    includeSourceInPrompts: true, maxSourceFiles: 10, maxSourceFileKb: 1, maxSourceTotalKb: 2
});
selected = agent.sourceFilesForModel({
    sourceFiles: [
        { path: 'a.js', content: 'a'.repeat(900) },
        { path: 'b.js', content: 'b'.repeat(900) },
        { path: 'c.js', content: 'c'.repeat(900) }   // 2700 total > 2048 budget
    ]
}, byteSettings);
assert.equal(selected.length, 2, 'the byte budget should admit exactly two 900-byte files');
assert.ok(selected.totalBytes <= 2 * 1024, `the total-size cap was exceeded (${selected.totalBytes})`);
assert.equal(selected.rejected.length, 1, 'the over-budget file was dropped silently instead of reported');
assert.match(selected.rejected[0].reason, /total size budget/, 'no total-budget rejection reason was reported');
assert.equal(selected.rejected[0].path, 'c.js', 'the wrong file was blamed for the budget');

// Every rejection is reported, not just the first: scanning continues past a
// rejected file so the user sees the whole picture rather than a truncated list.
selected = agent.sourceFilesForModel({
    sourceFiles: [
        { path: 'big1.js', content: tooBig },
        { path: 'ok.js', content: oneKb.slice(0, 400) },
        { path: 'big2.js', content: tooBig }
    ]
}, tightSettings);
assert.equal(selected.length, 1, 'a valid file wedged between two oversized ones was dropped');
assert.equal(selected.rejected.length, 2, 'only the first rejection was reported');
// deepStrictEqual fails across vm realms (different Array prototypes), so compare
// as a joined string — see rag-workspace pitfall 32.
assert.equal(selected.rejected.map(r => r.path).sort().join(','), 'big1.js,big2.js');

// includeSourceInPrompts off sends nothing, so a code-reading skill will refuse.
const offSettings = Object.assign({}, core.DEFAULT_SETTINGS, { includeSourceInPrompts: false });
selected = agent.sourceFilesForModel({ sourceFiles: [{ path: 'a.js', content: oneKb }] }, offSettings);
assert.equal(selected.length, 0, 'includeSourceInPrompts=false still sent source');

// With generous defaults the same files all pass (no false rejections).
const loose = core.DEFAULT_SETTINGS;
selected = agent.sourceFilesForModel({ sourceFiles: [{ path: 'a.js', content: oneKb }, { path: 'b.js', content: oneKb }] }, loose);
assert.equal(selected.length, 2, 'normal-size files were rejected under default limits');

// ---------------------------------------------------------------------------
// 9. Real self-review checks the written document against requiredSections
// ---------------------------------------------------------------------------

// A complete PRD passes.
const goodPrd = [
    '# ToolShare — Product Requirements Document',
    '## 1. Summary', 'Enough words here to not be considered thin by the reviewer.',
    '## 2. Target User', 'Urban renters who own too many rarely-used tools already.',
    '## 3. User Stories', 'As a neighbor, I want to list a drill so others can borrow it.',
    '## 4. MVP Scope', 'Now: list a tool, request it, confirm the handoff in person.',
    '## 5. Data & Architecture Overview', 'Tool, User, Loan entities with a small Postgres store.',
    '## 6. Go-to-Market', 'Seed one apartment building and grow by referral from there.',
    '## 7. Open Questions', 'How is trust established between strangers sharing tools?',
    '## 8. Appendix: Assumptions', 'Urban density is high enough for local matching.'
].join('\n\n');
const goodReview = agent.reviewDocument(goodPrd, prdSkill.requiredSections);
assert.equal(goodReview.ok, true, `a complete PRD was flagged: missing=${goodReview.missing}`);
assert.equal(goodReview.missing.length, 0);
assert.equal(goodReview.placeholders.length, 0);
assert.ok(goodReview.present.length === prdSkill.requiredSections.length, 'not every section was recognised');

// A PRD missing sections and carrying a placeholder fails, with specifics.
const badPrd = '# ToolShare PRD\n\n## 1. Summary\n\nShort.\n\n## 2. Target User\n\n<who is this for>\n';
const badReview = agent.reviewDocument(badPrd, prdSkill.requiredSections);
assert.equal(badReview.ok, false, 'an incomplete PRD passed review');
assert.ok(badReview.missing.length > 0, 'missing sections were not reported');
assert.ok(badReview.missing.includes('User Stories'), 'a known-missing section was not named');
assert.ok(badReview.placeholders.includes('<who is this for>'), 'a leftover placeholder was not reported');
assert.ok(badReview.thin.some(t => /Summary/.test(t)), 'a one-word section was not flagged as thin');

// No required sections means nothing to check against; it is trivially ok.
const noReq = agent.reviewDocument('# Anything\n\nSome content.', []);
assert.equal(noReq.ok, true);
assert.equal(noReq.present.length, 0);

// Each of the six skills declares required sections (so the review is meaningful).
skills.SKILLS.forEach(skill => {
    const hasReq = Array.isArray(skill.requiredSections) && skill.requiredSections.length > 0;
    const phasesHaveReq = Array.isArray(skill.phases) && skill.phases.some(
        phase => phase.kind === 'document' && Array.isArray(phase.requiredSections) && phase.requiredSections.length > 0
    );
    assert.ok(hasReq || phasesHaveReq, `${skill.id} declares no requiredSections, so its self-review checks nothing`);
});

// ---------------------------------------------------------------------------
// 10. The agent honours announceSkill, extraGuidance, and the review gate
// ---------------------------------------------------------------------------

async function runPrd(idea, settingsOverride, doc) {
    resetStores();
    core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, {
        concurrency: 'sequential', askClarifyingQuestions: false
    }, settingsOverride || {}));
    canned = doc;
    const skill = skills.getSkill('prd-builder');
    const run = core.createRun(skill, idea);
    return agent.runSkill(run, skill, { idea, answers: [], signal: new AbortController().signal }, {
        onRender() {}, onStep() {}, onStream() {},
        askQuestion: async () => null
    });
}

(async () => {
    // announceSkill off removes the announce step.
    const announced = await runPrd('A tool lending app for neighbors.', { announceSkill: true }, goodPrd);
    const announceRun = core.store.runs[core.store.runs.length - 1];
    assert.ok(announceRun.phases.some(p => /using the prd-builder skill/.test(p.label)), 'announceSkill=true emitted no announce step');

    const silent = await runPrd('A tool lending app for neighbors.', { announceSkill: false }, goodPrd);
    const silentRun = core.store.runs[core.store.runs.length - 1];
    assert.ok(!silentRun.phases.some(p => /using the prd-builder skill/.test(p.label)), 'announceSkill=false still announced');

    // extraGuidance is appended to every system prompt.
    requests.length = 0;
    await runPrd('A tool lending app.', { extraGuidance: 'Write in British English and never invent metrics.' }, goodPrd);
    assert.ok(requests.length >= 4, 'the PRD run did not make its model turns');
    requests.forEach(payload => {
        assert.match(payload.system_prompt, /British English/, 'standing guidance was not appended to a system prompt');
        assert.match(payload.system_prompt, /never invent metrics/);
    });

    // With no guidance, the system prompt is the plain base.
    requests.length = 0;
    await runPrd('A tool lending app.', { extraGuidance: '' }, goodPrd);
    requests.forEach(payload => {
        assert.ok(!/British English/.test(payload.system_prompt), 'guidance leaked in with an empty setting');
    });

    // selfReviewPass produces a real review step reflecting document quality.
    const reviewed = await runPrd('A tool lending app.', { selfReviewPass: true, requireReviewGate: true }, goodPrd);
    const reviewedRun = core.store.runs[core.store.runs.length - 1];
    assert.ok(reviewedRun.phases.some(p => /Self-review passed/.test(p.label)), 'a complete PRD did not get a passing self-review');
    assert.ok(reviewedRun.phases.some(p => /review gate/i.test(p.label)), 'no user review gate step');
    assert.equal(reviewedRun.status, 'done', 'a clean run should finish as done');

    // An incomplete document is flagged and the run status becomes 'gaps'.
    await runPrd('A tool lending app.', { selfReviewPass: true, requireReviewGate: true }, badPrd);
    const gapRun = core.store.runs[core.store.runs.length - 1];
    assert.ok(gapRun.phases.some(p => /Self-review found gaps/.test(p.label)), 'an incomplete PRD did not get a gaps self-review');
    assert.equal(gapRun.status, 'gaps', 'a run with review gaps should not report plain done');
    assert.ok(Array.isArray(gapRun.reviews) && gapRun.reviews.length, 'the run did not record its reviews');

    // requireReviewGate off drops the gate but keeps the self-review.
    await runPrd('A tool lending app.', { selfReviewPass: true, requireReviewGate: false }, goodPrd);
    const noGateRun = core.store.runs[core.store.runs.length - 1];
    assert.ok(!noGateRun.phases.some(p => /review gate/i.test(p.label)), 'requireReviewGate=false still emitted a gate');

    // selfReviewPass off skips the review entirely.
    await runPrd('A tool lending app.', { selfReviewPass: false, requireReviewGate: false }, goodPrd);
    const noReviewRun = core.store.runs[core.store.runs.length - 1];
    assert.ok(!noReviewRun.phases.some(p => /Self-review/.test(p.label)), 'selfReviewPass=false still ran a review');

    // -----------------------------------------------------------------
    // 11. Persistence must survive a live DOM node on a step
    //
    // Regression guard. Agent steps carry `liveElement` — the node a streaming
    // step paints tokens into — while they run. DOM nodes are cyclic
    // (node.ownerDocument -> document.activeElement -> node), so JSON.stringify
    // threw and writeStore() caught it and returned false. The run then was not
    // persisted for the whole duration of every streaming step: a reload
    // mid-run lost the transcript. writeStore() now strips DOM nodes.
    // -----------------------------------------------------------------

    resetStores();
    const domRun = core.createRun(skills.getSkill('prd-builder'), 'A run holding a live DOM node.');
    // A node shaped like a real one: cyclic through ownerDocument, which is what
    // broke serialization. A plain object would not reproduce the bug.
    const fakeDoc = {};
    const liveNode = makeElement('div');
    liveNode.ownerDocument = fakeDoc;
    fakeDoc.activeElement = liveNode;
    domRun.phases.push({
        id: 'step-with-node',
        kind: 'lens',
        label: 'Lens 1 — Product & Scope',
        status: 'running',
        text: 'streaming…',
        streaming: true,
        liveElement: liveNode
    });

    assert.equal(core.saveRun(domRun), true, 'saveRun returned false with a DOM node on a step');
    const persistedRaw = localStorageStub.getItem(core.PROJECTS_KEY);
    assert.ok(persistedRaw, 'the run was not persisted while a step held a live node');
    const persisted = JSON.parse(persistedRaw);
    const persistedStep = persisted.runs[0].phases.find(step => step.id === 'step-with-node');
    assert.ok(persistedStep, 'the streaming step was dropped instead of sanitized');
    assert.equal(persistedStep.label, 'Lens 1 — Product & Scope', 'sanitizing lost the step label');
    assert.equal(persistedStep.streaming, true, 'sanitizing lost the streaming flag');
    assert.equal('liveElement' in persistedStep, false, 'a DOM node was written to storage');
    assert.ok(!persistedRaw.includes('ownerDocument'), 'the cyclic node leaked into storage');

    // The persisted run is plain data: reloading it cannot resurrect a node.
    const restoredRun = persisted.runs[0];
    assert.equal(restoredRun.phases.length, 1);
    assert.equal(restoredRun.phases[0].liveElement, undefined);

    // The replacer is exported so this boundary is assertable, not incidental.
    assert.equal(typeof core.withoutDomNodes, 'function');
    assert.equal(core.isDomNode(liveNode), true, 'isDomNode did not recognise an element');
    assert.equal(core.isDomNode({ nodeType: 1 }), true, 'isDomNode should key off nodeType');
    assert.equal(core.isDomNode({ text: 'plain data' }), false, 'isDomNode flagged a plain object');
    assert.equal(core.isDomNode(null), false);
    assert.equal(JSON.stringify({ keep: 'this', drop: liveNode }, core.withoutDomNodes),
        '{"keep":"this"}', 'the replacer did not drop the node');

    console.log('settings-pipeline.test.cjs: 11 groups passed');
    console.log(`  schema fields   : ${schemaKeys.length} (all clamped, all with defaults in range)`);
    console.log(`  source limits   : per-file / count / total all enforced (was a silent no-op)`);
    console.log(`  self-review     : real structural check; gaps set run.status='gaps'`);
    console.log(`  import/export   : round-trips, clamps hostile values, rejects garbage`);
    process.exit(0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
