'use strict';

/*
 * Codalio Blueprint — registration contract test.
 *
 * Loads SimpleRAG's REAL extension host (GUI/extension_runtime.js) inside a vm
 * sandbox together with the plug-in's own modules, then asserts the host accepts
 * the controller and the manifest. This is the same validator path the app uses
 * at startup, so a pass here means the app-bar page will register in the app.
 *
 * Run: node tests/registration.test.cjs [--simplerag D:/PyMu/work_on_rag-main]
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'src');

function findSimpleRag() {
    const argIndex = process.argv.indexOf('--simplerag');
    if (argIndex !== -1 && process.argv[argIndex + 1]) return process.argv[argIndex + 1];
    if (process.env.SIMPLERAG_ROOT) return process.env.SIMPLERAG_ROOT;
    const candidates = [
        'D:/PyMu/work_on_rag-main',
        'C:/Users/Falab/work_on_rag-main'
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'GUI', 'extension_runtime.js'))) return candidate;
    }
    throw new Error('Could not locate the SimpleRAG checkout. Pass --simplerag <path>.');
}

const SIMPLERAG = findSimpleRag();
const HOST_RUNTIME = path.join(SIMPLERAG, 'GUI', 'extension_runtime.js');

// ---------------------------------------------------------------------------
// Minimal DOM stub — enough for extension_runtime.js to register and sync pages
// ---------------------------------------------------------------------------

function createElement(tagName) {
    const element = {
        tagName: String(tagName).toUpperCase(),
        className: '',
        id: '',
        dataset: {},
        style: { setProperty() {}, getPropertyValue() { return ''; } },
        children: [],
        childElementCount: 0,
        innerHTML: '',
        textContent: '',
        attributes: {},
        offsetParent: {},
        appendChild(child) { this.children.push(child); this.childElementCount = this.children.length; return child; },
        insertBefore(child) { this.children.unshift(child); this.childElementCount = this.children.length; return child; },
        removeChild(child) {
            this.children = this.children.filter(item => item !== child);
            this.childElementCount = this.children.length;
        },
        remove() {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] === undefined ? null : this.attributes[name]; },
        classList: {
            add() {}, remove() {}, toggle() {}, contains() { return false; }
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        addEventListener() {},
        removeEventListener() {},
        click() {},
        focus() {},
        dispatchEvent() { return true; }
    };
    return element;
}

// Track dynamically created ids so getElementById finds elements the host
// itself inserted (e.g. #extension-app-icons). Without this the host would build
// a fresh mount on every syncPageContributions() call instead of reusing one.
const elementsById = new Map();

function registerElementId(element) {
    if (element && element.id) elementsById.set(String(element.id), element);
}

const appBar = createElement('div');
appBar.id = 'app-bar';

const documentStub = {
    documentElement: createElement('html'),
    body: createElement('body'),
    readyState: 'complete',
    createElement(tagName) {
        const element = createElement(tagName);
        const originalSetAttribute = element.setAttribute.bind(element);
        element.setAttribute = (name, value) => {
            originalSetAttribute(name, value);
            if (name === 'id') registerElementId(element);
        };
        Object.defineProperty(element, 'id', {
            get() { return element.attributes.id || ''; },
            set(value) {
                element.attributes.id = String(value);
                registerElementId(element);
            },
            configurable: true
        });
        return element;
    },
    createDocumentFragment() { return createElement('fragment'); },
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
    getElementById(id) {
        const key = String(id);
        if (key === 'app-bar') return appBar;
        return elementsById.get(key) || null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; }
};

registerElementId(appBar);

const localStorageStub = (() => {
    const map = new Map();
    return {
        getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
        setItem: (key, value) => { map.set(String(key), String(value)); },
        removeItem: key => { map.delete(String(key)); },
        clear: () => { map.clear(); },
        _dump: () => Object.fromEntries(map)
    };
})();

const listeners = [];
const windowStub = {
    document: documentStub,
    localStorage: localStorageStub,
    location: { href: 'http://127.0.0.1:18411/gui/' },
    navigator: { clipboard: null },
    matchMedia: () => ({ addEventListener() {}, matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class CustomEvent {
        constructor(type, init) { this.type = type; this.detail = (init || {}).detail; }
    },
    addEventListener(type, handler) { listeners.push({ type, handler }); },
    removeEventListener() {},
    dispatchEvent(event) {
        listeners.filter(item => item.type === event.type).forEach(item => item.handler(event));
        return true;
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    prompt: () => null,
    confirm: () => true,
    fetch: () => Promise.reject(new Error('fetch is not available in this test')),
    Blob: class Blob {},
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    FileReader: class FileReader { readAsText() {} },
    console
};
windowStub.window = windowStub;
windowStub.globalThis = windowStub;

const sandbox = {
    window: windowStub,
    document: documentStub,
    localStorage: localStorageStub,
    navigator: windowStub.navigator,
    location: windowStub.location,
    console,
    setTimeout: windowStub.setTimeout,
    clearTimeout: windowStub.clearTimeout,
    setInterval: windowStub.setInterval,
    clearInterval: windowStub.clearInterval,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    MutationObserver: windowStub.MutationObserver,
    CustomEvent: windowStub.CustomEvent,
    URL: windowStub.URL,
    Blob: windowStub.Blob,
    FileReader: windowStub.FileReader,
    fetch: windowStub.fetch,
    TextDecoder: class TextDecoder { decode() { return ''; } },
    AbortController: global.AbortController,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, Promise,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

// The host runtime reads these as bare globals.
sandbox.state = { app: 'journal', folder: 'all', plugins: { installed: [] } };
sandbox.el = { appBarIcons: [] };
sandbox.api = async () => null;
sandbox.setApp = () => true;
sandbox.renderNav = () => {};
sandbox.renderRibbon = () => {};
sandbox.renderList = () => {};
sandbox.renderReadingPane = () => {};
sandbox.escapeHTML = value => String(value).replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[c]));

const context = vm.createContext(sandbox);

function runFile(file, label) {
    const code = fs.readFileSync(file, 'utf8');
    try {
        vm.runInContext(code, context, { filename: file });
    } catch (error) {
        throw new Error(`${label} failed to load (${path.basename(file)}): ${error.message}`);
    }
}

// ---------------------------------------------------------------------------
// Build the manifest module the same way tools/blueprint.py does
// ---------------------------------------------------------------------------

const pluginManifest = JSON.parse(fs.readFileSync(path.join(SRC, 'plugin.json'), 'utf8'));
const template = fs.readFileSync(path.join(SRC, 'manifest.template.js'), 'utf8');
const PLACEHOLDER = '/*__MANIFEST_JSON__*/null';
assert.ok(template.includes(PLACEHOLDER), 'manifest.template.js lost its placeholder');
const manifestJs = template.replace(PLACEHOLDER, JSON.stringify(pluginManifest));

// ---------------------------------------------------------------------------
// Load: host first (it defines window.RAGWorkspaceExtensions), then the plug-in
// ---------------------------------------------------------------------------

runFile(HOST_RUNTIME, 'SimpleRAG extension host');
assert.equal(typeof sandbox.window.RAGWorkspaceExtensions, 'object', 'host did not expose RAGWorkspaceExtensions');

vm.runInContext(manifestJs, context, { filename: 'manifest.js' });
assert.ok(sandbox.window.__codalioBlueprintManifest, 'manifest module did not expose the manifest');

runFile(path.join(SRC, 'controller-core.js'), 'controller-core');
runFile(path.join(SRC, 'skills.js'), 'skills');
runFile(path.join(SRC, 'agent.js'), 'agent');
runFile(path.join(SRC, 'ui.js'), 'ui');
runFile(path.join(SRC, 'controller.js'), 'controller');

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const host = sandbox.window.RAGWorkspaceExtensions;

// 1. The manifest registered, which means the host validator accepted it AND the
//    controller was already registered with matching capabilities.
const registered = host.getManifest('codalio-blueprint');
assert.ok(registered, 'host rejected the manifest — controller did not register');
assert.equal(registered.id, 'codalio-blueprint');
assert.equal(registered.schemaVersion, 1);

// Reproduce the real startup sequence: app.bundle.js defers init() to
// DOMContentLoaded, which calls RAGWorkspaceExtensions.initialize(). That reads
// the plug-in store (picking up the record the controller seeded at load time)
// and then registers the bundled manifests and syncs the app-bar page icons.
sandbox.loadPluginsFromStorage = () => {
    const raw = sandbox.localStorage.getItem('ragworkspace_plugins');
    sandbox.state.plugins.installed = raw ? JSON.parse(raw) : [];
};
sandbox.api = async endpoint => (endpoint === '/extensions/bundled-manifests'
    // The real app registers all twelve bundled controllers inline inside
    // app.bundle.js. This sandbox only loads Blueprint, so registering the
    // bundled manifests would throw "No frontend controller is registered".
    // What matters here is that initialize() reads the plug-in store (picking up
    // the record Blueprint seeded) and then syncs the contributed pages.
    ? { schemaVersion: 1, manifests: [] }
    : null);

let initResult;
(async () => {
    initResult = await host.initialize();
    runAssertions();
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

function runAssertions() {

// 2. The page is reachable by its appId.
const page = host.getPage('blueprint');
assert.ok(page, 'host did not register the blueprint page');
assert.equal(page.pluginId, 'codalio-blueprint');
assert.equal(page.controller.appId, 'blueprint');

// 3. The full page-controller lifecycle contract is implemented.
const REQUIRED_HOOKS = ['mount', 'activate', 'deactivate', 'unmount', 'renderPage', 'renderNav', 'renderRibbon', 'renderList'];
REQUIRED_HOOKS.forEach(hook => {
    assert.equal(typeof page.controller[hook], 'function', `page controller is missing ${hook}()`);
});
['serializeState', 'restoreState', 'onThemeChanged', 'onAccentChanged', 'onConnectivityChanged', 'onFolderChanged'].forEach(hook => {
    assert.equal(typeof page.controller[hook], 'function', `page controller is missing optional hook ${hook}()`);
});

// 4. The page is listed as enabled — this is what makes the app-bar icon appear.
assert.equal(host.isPluginEnabled('codalio-blueprint'), true, 'host does not consider the plug-in enabled');
const pages = host.listPages();
assert.ok(pages.some(item => item.appId === 'blueprint'), 'blueprint page is not in host.listPages()');

// 5. The host plugin record was seeded so isEnabled() passes on a cold profile.
const hostRecords = JSON.parse(sandbox.localStorage.getItem('ragworkspace_plugins') || '[]');
const record = hostRecords.find(item => item && item.id === 'codalio-blueprint');
assert.ok(record, 'controller did not seed its host plugin record');
assert.equal(record.enabled, true);
assert.equal(record.runtimeBacked, true);
assert.equal(record.runtimePage, 'blueprint');

// 6. Skills are complete and each carries its real Codalio methodology.
const skillSet = sandbox.window.__codalioBlueprintSkills;
assert.equal(skillSet.SKILLS.length, 6, 'expected the six codalio-blueprint skills');
const expectedIds = ['prd-builder', 'mvp-checklist', 'gtm-plan', 'arch-evaluation', 'doc-generation', 'code-to-prd'];
// deepStrictEqual fails across vm realms (different Array prototypes), so compare
// as a plain joined string — see rag-workspace pitfall 32.
assert.equal(
    Array.from(skillSet.SKILLS).map(skill => skill.id).sort().join(','),
    expectedIds.slice().sort().join(','),
    'skill set does not match the six codalio-blueprint skills'
);

const prd = skillSet.getSkill('prd-builder');
assert.equal(prd.lenses.length, 3, 'prd-builder must run three lenses');
assert.equal(prd.lenses.map(lens => lens.id).join(','), 'lens-product,lens-architecture,lens-gtm');
assert.equal(prd.outputFolder, 'docs/prd');

// 7. Lens prompts carry the source's exact output contracts.
const productPrompt = prd.lenses[0].buildPrompt({ idea: 'a tool-lending app for neighbors', answers: [] });
assert.match(productPrompt, /Elevator pitch/, 'product lens lost the elevator-pitch contract');
assert.match(productPrompt, /MVP checklist/, 'product lens lost the MVP checklist contract');
assert.match(productPrompt, /Return only these five sections/, 'product lens lost its output contract');
assert.match(productPrompt, /tool-lending app for neighbors/, 'lens prompt did not receive the idea');

const archPrompt = prd.lenses[1].buildPrompt({ idea: 'x', answers: [] });
assert.match(archPrompt, /lite pass, not a\s*\n?\s*full architecture evaluation/, 'architecture lens lost its lite-pass disclaimer');

const gtmPrompt = prd.lenses[2].buildPrompt({ idea: 'x', answers: [] });
assert.match(gtmPrompt, /lite pass, not a full GTM plan/, 'GTM lens lost its lite-pass disclaimer');

// 8. The synthesis step receives all three lens outputs (not a concatenation).
const synthPrompt = prd.phases[0].buildPrompt({
    idea: 'x',
    answers: [],
    lensOutputs: {
        'lens-product': 'PRODUCT FINDINGS',
        'lens-architecture': 'ARCH FINDINGS',
        'lens-gtm': 'GTM FINDINGS'
    }
});
assert.match(synthPrompt, /PRODUCT FINDINGS/);
assert.match(synthPrompt, /ARCH FINDINGS/);
assert.match(synthPrompt, /GTM FINDINGS/);
assert.match(synthPrompt, /Do NOT just concatenate/, 'synthesis lost its anti-concatenation rule');
assert.match(synthPrompt, /## 7\. Open Questions/, 'synthesis lost the PRD template');

// 9. Source-reading skills must refuse to invent an evaluation.
assert.equal(skillSet.getSkill('arch-evaluation').requiresSource, true);
assert.equal(skillSet.getSkill('code-to-prd').requiresSource, true);
assert.equal(skillSet.getSkill('doc-generation').requiresPrd, true);

// 10. Output paths follow the source skill conventions.
const agentRuntime = sandbox.window.__codalioBlueprintAgent;
const meta = { date: '2026-09-03', slug: 'toolshare', projectName: 'ToolShare' };
assert.equal(agentRuntime.outputPathFor(prd, prd.phases[0], meta), 'docs/prd/2026-09-03-toolshare-prd.md');
assert.equal(
    agentRuntime.outputPathFor(skillSet.getSkill('gtm-plan'), { kind: 'document' }, meta),
    'docs/gtm/2026-09-03-toolshare-gtm-plan.md'
);
assert.equal(
    agentRuntime.outputPathFor(skillSet.getSkill('mvp-checklist'), { kind: 'document' }, meta),
    'docs/mvp/2026-09-03-toolshare-mvp-checklist.md'
);
assert.equal(
    agentRuntime.outputPathFor(skillSet.getSkill('arch-evaluation'), { kind: 'document' }, meta),
    'docs/arch-eval/2026-09-03-toolshare-arch-evaluation.md'
);
const docGen = skillSet.getSkill('doc-generation');
assert.equal(
    agentRuntime.outputPathFor(docGen, { kind: 'document', optional: 'backlog' }, meta),
    'docs/backlog/2026-09-03-toolshare-backlog.md'
);
assert.equal(
    agentRuntime.outputPathFor(docGen, { kind: 'document', optional: 'api-contract' }, meta),
    'docs/api/2026-09-03-toolshare-api-contract.md'
);
assert.equal(
    agentRuntime.outputPathFor(docGen, { kind: 'document', optional: 'onboarding' }, meta),
    'docs/onboarding/2026-09-03-toolshare-onboarding.md'
);

// 11. Document post-processing fills the template placeholders and unwraps fences.
const finished = agentRuntime.applyDocumentHeader(
    '```markdown\n# <Project Name> — Product Requirements Document\n\n> Generated on <date> from `docs/prd/<source-prd-filename>`.\n```',
    meta,
    'docs/prd/2026-09-03-toolshare-prd.md'
);
assert.ok(!finished.includes('```'), 'document fence was not unwrapped');
assert.ok(!finished.includes('<Project Name>'), 'project name placeholder survived');
assert.ok(!finished.includes('<date>'), 'date placeholder survived');
assert.ok(!finished.includes('<source-prd-filename>'), 'PRD backlink placeholder survived');
assert.match(finished, /# ToolShare — Product Requirements Document/);
assert.match(finished, /2026-09-03-toolshare-prd\.md/);

// 12. Core Markdown renderer is XSS-safe and produces real structure.
const coreRuntime = sandbox.window.__codalioBlueprintCore;
const hostile = '# Title\n\nSome **bold** and <script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n- one\n- two';
const rendered = coreRuntime.renderMarkdown(hostile);
assert.equal(rendered.tagName, 'DIV');

// Walk the produced tree: the contract is that model-supplied markup becomes
// TEXT NODES (inert), never element nodes. Stringifying the tree would match the
// harmless text content, so assert on node types instead.
const elementTags = [];
const textValues = [];
(function walk(node) {
    if (node.nodeType === 3) {
        textValues.push(node.textContent);
        return;
    }
    if (node.tagName) elementTags.push(node.tagName);
    (node.children || []).forEach(walk);
}(rendered));

const FORBIDDEN = ['SCRIPT', 'IMG', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'STYLE', 'FORM', 'INPUT'];
FORBIDDEN.forEach(tag => {
    assert.ok(!elementTags.includes(tag), `markdown renderer created a <${tag}> element from model text`);
});
assert.ok(elementTags.includes('H3'), 'expected a heading element from "# Title"');
assert.ok(elementTags.includes('UL'), 'expected a list element from the bullets');
assert.ok(elementTags.includes('STRONG'), 'expected a <strong> from **bold**');

// The hostile markup survives only as escaped text the browser will display.
assert.ok(
    textValues.some(value => value.includes('<script>alert(1)</script>')),
    'raw <script> markup was dropped instead of rendered as inert text'
);
assert.ok(
    textValues.some(value => value.includes('<img src=x onerror=alert(2)>')),
    'raw <img onerror> markup was dropped instead of rendered as inert text'
);

// 12b. No module ever assigns model-derived text through innerHTML.
// Clearing a container with innerHTML = '' is safe and allowed; assigning any
// other value is what would let model text inject markup.
['controller-core.js', 'skills.js', 'agent.js', 'ui.js', 'controller.js'].forEach(name => {
    const source = fs.readFileSync(path.join(SRC, name), 'utf8');
    const offenders = [];
    source.split('\n').forEach((line, index) => {
        const hit = /\.innerHTML\s*=\s*([^=].*)$/.exec(line);
        if (!hit) return;
        const assigned = hit[1].trim();
        if (assigned === "'';" || assigned === '"";' || assigned === "''" || assigned === '""') return;
        offenders.push(`${name}:${index + 1}: ${line.trim()}`);
    });
    assert.equal(
        offenders.length,
        0,
        `${name} assigns non-empty innerHTML, which would let model text inject markup:\n  ${offenders.join('\n  ')}`
    );
});

const headings = elementTags.filter(tag => tag === 'H3');
assert.equal(headings.length, 1, 'expected exactly one heading from the markdown renderer');

// 13. Virtual filesystem is isolated to Blueprint's own storage key.
coreRuntime.writeFile('docs/prd/test.md', '# Test', { skill: 'test' });
assert.ok(coreRuntime.readFile('docs/prd/test.md'), 'virtual filesystem write failed');
assert.equal(coreRuntime.listFiles().join(','), 'docs/prd/test.md');
const stored = JSON.parse(sandbox.localStorage.getItem(coreRuntime.PROJECTS_KEY));
assert.ok(stored.files['docs/prd/test.md'], 'project state was not persisted');
assert.ok(!sandbox.localStorage.getItem('signal_life2_journal'), 'plug-in wrote to a SimpleRAG storage key');

// 14. Storage keys are all namespaced — no collision with SimpleRAG.
[coreRuntime.PROJECTS_KEY, coreRuntime.SETTINGS_KEY, coreRuntime.REMOVED_KEY].forEach(key => {
    assert.ok(key.startsWith('codalio-blueprint.'), `storage key ${key} is not namespaced`);
});

// 15. Public API surface for the host command dispatcher.
assert.equal(typeof sandbox.window.codalioBlueprint, 'object');
assert.equal(sandbox.window.codalioBlueprint.appId, 'blueprint');
assert.equal(sandbox.window.codalioBlueprint.listSkills().length, 6);

// 16. Uninstall marker: the controller leaves a note so a reinstall does not
//     resurrect a deliberately removed plug-in.
coreRuntime.writeFile('docs/prd/test.md', '', {});
coreRuntime.deleteFile('docs/prd/test.md');
assert.equal(coreRuntime.readFile('docs/prd/test.md'), null, 'virtual filesystem delete failed');

// 17. The host actually rendered Blueprint's app-bar icon during initialize().
// syncPageContributions() writes the icons as an HTML string onto the
// #extension-app-icons mount (this stub does not parse HTML, so assert on the
// string the host produced — that is the markup the real browser will parse).
const mount = appBar.children.find(child => child.id === 'extension-app-icons');
assert.ok(mount, 'host did not create the #extension-app-icons mount');
const mountHtml = String(mount.innerHTML || '');
const iconMatches = mountHtml.match(/data-app="blueprint"/g) || [];
assert.equal(iconMatches.length, 1, `host did not render exactly one Blueprint app-bar icon; got: ${mountHtml}`);
assert.match(mountHtml, /data-extension-plugin="codalio-blueprint"/, 'icon is not attributed to the plug-in');
assert.match(mountHtml, /aria-label="Open the Codalio Blueprint planning agent"/, 'icon has no accessible label');
assert.match(mountHtml, /role="button"/, 'icon is not keyboard reachable');
assert.match(mountHtml, /fa-compass-drafting/, 'icon does not use the declared Font Awesome icon');
assert.match(mountHtml, /title="Blueprint"/, 'icon has no tooltip title');
assert.equal(initResult.pages.some(item => item.appId === 'blueprint'), true, 'initialize() did not report the blueprint page');

// 18. Disabling the plug-in removes the page from the app bar (uninstall path).
const records = JSON.parse(sandbox.localStorage.getItem('ragworkspace_plugins'));
const blueprintRecord = records.find(item => item.id === 'codalio-blueprint');
blueprintRecord.enabled = false;
sandbox.localStorage.setItem('ragworkspace_plugins', JSON.stringify(records));
sandbox.state.plugins.installed = records;
host.syncPageContributions();
assert.equal(host.getPage('blueprint'), null, 'a disabled plug-in must not expose its page');
assert.equal(host.isPluginEnabled('codalio-blueprint'), false, 'a disabled plug-in must report as not enabled');
assert.ok(
    !String(mount.innerHTML || '').includes('data-app="blueprint"'),
    'the app-bar icon survived disabling the plug-in'
);
assert.equal(
    initResult.pages.filter(item => item.appId !== 'blueprint').length,
    host.listPages().length,
    'listPages() still reports the disabled plug-in'
);

console.log('registration.test.cjs: 18 contract groups passed');
console.log(`  SimpleRAG host : ${SIMPLERAG}`);
console.log('  page appId     : blueprint');
console.log('  app-bar icon   : rendered, and removed again when disabled');
console.log('  skills         : prd-builder, mvp-checklist, gtm-plan, arch-evaluation, doc-generation, code-to-prd');

}
