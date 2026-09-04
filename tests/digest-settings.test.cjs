'use strict';
/* Verify the new digest settings normalize correctly through BOTH paths:
   settings.js schema engine AND core's built-in fallback bounds. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');
const { createDocument, createLocalStorage } = require('./dom-stub.cjs');

function loadCoreOnly() {
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
        fetch: async () => { throw new Error('no network in this test'); },
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
    sandbox.globalThis = sandbox; sandbox.self = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(SRC, 'controller-core.js'), 'utf8'),
        context, { filename: 'controller-core.js' });
    return { core: sandbox.window.__codalioBlueprintCore, sandbox, context, localStorage: localStorageStub };
}

const { core, sandbox, context } = loadCoreOnly();

// --- core fallback bounds (settings.js NOT loaded) -------------------------
let s = core.readSettings();
assert.equal(s.sourceContextMode, 'attached', 'default mode must be attached (back-compat)');
assert.equal(s.digestBudgetTokens, 16000, 'default digest budget must be 16000');
assert.equal(s.digestMinFullTextLines, 40, 'default min full-text lines must be 40');

// clamping via core's own bounds
sandbox.window.localStorage.setItem(core.SETTINGS_KEY, JSON.stringify({
    sourceContextMode: 'digest', digestBudgetTokens: 999999, digestMinFullTextLines: -5
}));
s = core.readSettings();
assert.equal(s.sourceContextMode, 'digest', 'digest mode was not accepted');
assert.equal(s.digestBudgetTokens, 65536, 'budget was not clamped to the max');
assert.equal(s.digestMinFullTextLines, 1, 'min-lines was not clamped to the floor');

// invalid enum falls back to default
sandbox.window.localStorage.setItem(core.SETTINGS_KEY, JSON.stringify({ sourceContextMode: 'bogus' }));
assert.equal(core.readSettings().sourceContextMode, 'attached', 'an invalid mode did not fall back');

// --- settings.js schema engine --------------------------------------------
vm.runInContext(fs.readFileSync(path.join(SRC, 'settings.js'), 'utf8'),
    context, { filename: 'settings.js' });
const schema = sandbox.window.__codalioBlueprintSettings;
assert.ok(schema, 'settings.js did not register');

// core.readSettings() now routes through normalizeSettings
sandbox.window.localStorage.setItem(core.SETTINGS_KEY, JSON.stringify({
    sourceContextMode: 'digest', digestBudgetTokens: 24000, digestMinFullTextLines: 80
}));
s = core.readSettings();
assert.equal(s.sourceContextMode, 'digest');
assert.equal(s.digestBudgetTokens, 24000);
assert.equal(s.digestMinFullTextLines, 80);

// every new field is discoverable by the UI
assert.ok(schema.getField('sourceContextMode'), 'sourceContextMode not in ALL_FIELDS');
assert.ok(schema.getField('digestBudgetTokens'), 'digestBudgetTokens not in ALL_FIELDS');
assert.ok(schema.getField('digestMinFullTextLines'), 'digestMinFullTextLines not in ALL_FIELDS');
assert.equal(schema.getField('sourceContextMode').type, 'segmented');
assert.equal(schema.getField('digestBudgetTokens').type, 'number');

// the digest sub-page exists under the source section
const page = schema.getPage('source', 'digest');
assert.equal(page.id, 'digest', 'the digest settings page was not registered');
assert.equal(page.label, 'Whole-codebase reading');

// summary renders for both modes
const sumDigest = schema.pageSummary('source', 'digest', { sourceContextMode: 'digest', digestBudgetTokens: 16000 });
assert.match(sumDigest, /Whole project/);
assert.match(sumDigest, /16,000/);
const sumAttached = schema.pageSummary('source', 'digest', { sourceContextMode: 'attached' });
assert.match(sumAttached, /Attached files only/);

// defaults survive a full normalize of an empty object
const fresh = schema.normalizeSettings({});
assert.equal(fresh.sourceContextMode, 'attached');
assert.equal(fresh.digestBudgetTokens, 16000);
assert.equal(fresh.digestMinFullTextLines, 40);

console.log('digest-settings.test.cjs: all assertions passed');
console.log('  core fallback : defaults, clamping (65536 max, 1 min), invalid enum');
console.log('  schema engine : discovery, types, digest page, summaries, defaults');
process.exit(0);
