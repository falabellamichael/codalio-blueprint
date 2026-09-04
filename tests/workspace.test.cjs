'use strict';

/*
 * Codalio Blueprint — tabbed workspace test.
 *
 * Proves the IDE behaviour the page is built around: pressing Project Files,
 * Runs or Settings OPENS A TAB beside the pinned Agent instead of replacing it,
 * documents open as their own editor tabs, the tab cap evicts least-recently-used
 * files, the layout survives a reload, and the keyboard map drives all of it.
 *
 * Run: node tests/workspace.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');

// ---------------------------------------------------------------------------
// DOM stub
// ---------------------------------------------------------------------------

function makeElement(tagName) {
    const classes = new Set();
    let ownValue = '';
    const element = {
        tagName: String(tagName).toUpperCase(),
        nodeType: 1,
        id: '',
        dataset: {},
        attributes: {},
        children: [],
        childElementCount: 0,
        style: { setProperty() {}, getPropertyValue() { return ''; } },
        innerHTML: '',
        offsetParent: {},
        disabled: false,
        type: '',
        rows: 0,
        tabIndex: 0,
        selected: false,
        checked: false,
        min: '',
        max: '',
        step: '',
        accept: '',
        maxLength: 0,
        placeholder: '',
        hidden: false,
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        lastElementChild: null,
        htmlFor: '',
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
        insertBefore(child) {
            this.children.unshift(child);
            this.childElementCount = this.children.length;
            return child;
        },
        remove() {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] === undefined ? null : this.attributes[name]; },
        addEventListener() {},
        removeEventListener() {},
        click() {},
        focus() {},
        dispatchEvent() { return true; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; }
    };
    Object.defineProperty(element, 'className', {
        get: () => [...classes].join(' '),
        set: value => { classes.clear(); String(value || '').split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
        configurable: true
    });
    Object.defineProperty(element, 'textContent', {
        get() {
            const parts = [];
            (element.children || []).forEach(child => {
                if (child.textContent) parts.push(child.textContent);
            });
            return parts.join('');
        },
        set(value) {
            element.children.length = 0;
            element.childElementCount = 0;
            if (value !== '' && value !== null && value !== undefined) {
                element.children.push({ nodeType: 3, textContent: String(value), children: [] });
            }
        },
        configurable: true
    });
    Object.defineProperty(element, 'value', {
        get() {
            if (element.tagName !== 'SELECT') return ownValue;
            const selected = (element.children || []).find(child => child.selected);
            return selected ? String(selected.value) : '';
        },
        set(next) { ownValue = String(next); },
        configurable: true
    });
    // The real DOM reflects el.title to the title attribute, so getAttribute('title')
    // works. Mirror that, otherwise tooltip assertions test a stub quirk.
    Object.defineProperty(element, 'title', {
        get: () => element.attributes.title === undefined ? '' : element.attributes.title,
        set: value => { element.attributes.title = String(value); },
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
        clear: () => { map.clear(); },
        _has: key => map.has(String(key))
    };
})();

const documentStub = {
    documentElement: makeElement('html'),
    body: makeElement('body'),
    readyState: 'complete',
    createElement: makeElement,
    createDocumentFragment() { const f = makeElement('fragment'); f.isFragment = true; return f; },
    createTextNode(text) { return { nodeType: 3, textContent: String(text), children: [] }; },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; }
};

const windowStub = {
    document: documentStub,
    localStorage: localStorageStub,
    location: { href: 'http://127.0.0.1:18411/gui/' },
    navigator: { clipboard: null },
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = (init || {}).detail; } },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    Blob: class Blob {},
    FileReader: class { readAsText() {} },
    fetch: () => Promise.reject(new Error('no network in this test')),
    TextDecoder: global.TextDecoder,
    TextEncoder: global.TextEncoder,
    AbortController: global.AbortController
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
    TextDecoder: global.TextDecoder,
    TextEncoder: global.TextEncoder,
    AbortController: global.AbortController,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, Promise, Intl,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);
function runFile(file) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
}

// Load in the installer's declared order.
runFile(path.join(SRC, 'controller-core.js'));
runFile(path.join(SRC, 'skills.js'));
runFile(path.join(SRC, 'settings.js'));
runFile(path.join(SRC, 'agent.js'));
runFile(path.join(SRC, 'preview.js'));
runFile(path.join(SRC, 'ui.js'));
runFile(path.join(SRC, 'workspace.js'));
runFile(path.join(SRC, 'settings-page.js'));

const core = sandbox.window.__codalioBlueprintCore;
const ui = sandbox.window.__codalioBlueprintUi;
const ws = sandbox.window.__codalioBlueprintWorkspace;
const schema = sandbox.window.__codalioBlueprintSettings;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walk(root, visit) {
    visit(root);
    (root.children || []).forEach(child => walk(child, visit));
}

function findAll(root, predicate) {
    const found = [];
    walk(root, node => { if (predicate(node)) found.push(node); });
    return found;
}

const byClass = name => node => node.nodeType === 1 && String(node.className || '').split(/\s+/).includes(name);
const byAction = action => node => node.nodeType === 1 && node.dataset && node.dataset.cbAction === action;
const byTag = tag => node => node.nodeType === 1 && node.tagName === String(tag).toUpperCase();

function textOf(root) {
    const parts = [];
    walk(root, node => { if (node.nodeType === 3) parts.push(node.textContent); });
    return parts.join(' ');
}

function tabIds(workspace) {
    return ws.tabs(workspace).map(tab => tab.id);
}

function resetProject() {
    core.store.files = {};
    core.store.runs = [];
    core.store.openPath = '';
    core.store.openFolderId = '';
    core.store.activeRunId = '';
    Object.keys(core.store.folders).forEach(id => {
        if (id !== core.DEFAULT_FOLDER_ID) delete core.store.folders[id];
    });
    core.store.activeFolderId = core.DEFAULT_FOLDER_ID;
    core.writeStore();
    core.clearWorkspace();
    core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS));
}

// ---------------------------------------------------------------------------
// 1. A fresh workspace is the pinned Agent tab alone
// ---------------------------------------------------------------------------

resetProject();
let work = ws.createWorkspace(core.readSettings());
assert.equal(ws.tabs(work).length, 1, 'a new workspace should start with one tab');
assert.equal(ws.tabs(work)[0].kind, 'agent');
assert.equal(ws.tabs(work)[0].pinned, true, 'the Agent tab should be pinned by default');
assert.equal(ws.activeTab(work).id, ws.AGENT_TAB_ID);
assert.equal(ws.isAgentActive(work), true);
assert.equal(ws.activeSectionId(work), 'cb-agent');

// ---------------------------------------------------------------------------
// 2. THE HEADLINE BEHAVIOUR: sections open BESIDE the Agent, never replacing it
// ---------------------------------------------------------------------------

ws.openSection(work, 'cb-files', core.readSettings());
assert.equal(ws.tabs(work).length, 2, 'opening Project Files must ADD a tab');
assert.ok(ws.findTab(work, ws.AGENT_TAB_ID), 'opening Project Files must not remove the Agent tab');
assert.equal(ws.activeTab(work).sectionId, 'cb-files');
assert.equal(ws.activeSectionId(work), 'cb-files');

ws.openSection(work, 'cb-history', core.readSettings());
assert.equal(ws.tabs(work).length, 3, 'opening Runs must ADD a tab');
assert.ok(ws.findTab(work, ws.AGENT_TAB_ID), 'opening Runs must not remove the Agent tab');

ws.openSection(work, 'cb-settings', core.readSettings());
assert.equal(ws.tabs(work).length, 4, 'opening Settings must ADD a tab');
assert.equal(tabIds(work).join(','), 'tab-agent,tab-cb-files,tab-cb-history,tab-cb-settings',
    'the Agent tab must stay first');

// Sections are singletons: re-pressing one activates it rather than duplicating.
ws.openSection(work, 'cb-files', core.readSettings());
assert.equal(ws.tabs(work).length, 4, 're-opening a section duplicated its tab');
assert.equal(ws.activeSectionId(work), 'cb-files', 're-opening a section did not activate it');

// The chat survives all of that navigation.
ws.activateAgent(work);
assert.equal(ws.isAgentActive(work), true);
assert.equal(ws.tabs(work).length, 4, 'returning to the Agent lost the other tabs');

// ---------------------------------------------------------------------------
// 3. Documents open as their own editor tabs
// ---------------------------------------------------------------------------

core.writeFile('docs/prd/2026-09-03-toolshare-prd.md', '# ToolShare PRD\n\nBody text.', {});
core.writeFile('docs/mvp/2026-09-03-toolshare-mvp.md', '# MVP\n\nBody text.', {});

ws.openFile(work, 'docs/prd/2026-09-03-toolshare-prd.md', core.readSettings());
assert.equal(ws.tabs(work).length, 5, 'opening a document must ADD a tab');
const fileTab = ws.activeTab(work);
assert.equal(fileTab.kind, 'file');
assert.equal(fileTab.path, 'docs/prd/2026-09-03-toolshare-prd.md');
assert.equal(fileTab.title, '2026-09-03-toolshare-prd.md', 'a document tab should show its file name');
assert.ok(ws.findTab(work, ws.AGENT_TAB_ID), 'opening a document removed the Agent tab');

// A file tab still belongs to the Project Files section for nav highlighting.
assert.equal(ws.activeSectionId(work), 'cb-files', 'a document tab should highlight Project Files');

// Opening the same document twice activates the existing tab.
ws.openFile(work, 'docs/prd/2026-09-03-toolshare-prd.md', core.readSettings());
assert.equal(ws.tabs(work).length, 5, 're-opening a document duplicated its tab');

ws.openFile(work, 'docs/mvp/2026-09-03-toolshare-mvp.md', core.readSettings());
assert.equal(ws.tabs(work).length, 6, 'a second document did not get its own tab');

// Two project roots may contain the same relative path. They must remain two
// independently readable, restorable tabs with independent viewer preferences.
resetProject();
work = ws.createWorkspace(core.readSettings());
const rootA = core.createFolder('Root A').folder;
core.writeFile('src/index.js', 'export const root = "A";\n', { folder: rootA.id, origin: 'imported' });
const rootB = core.createFolder('Root B').folder;
core.writeFile('src/index.js', 'export const root = "B";\n', { folder: rootB.id, origin: 'imported' });
ws.openFile(work, 'src/index.js', core.readSettings(), true, rootA.id);
ws.openFile(work, 'src/index.js', core.readSettings(), true, rootB.id);
const duplicateTabs = ws.tabs(work).filter(tab => tab.kind === 'file' && tab.path === 'src/index.js');
assert.equal(duplicateTabs.length, 2, 'same-path files from two roots collapsed into one tab');
assert.notEqual(duplicateTabs[0].id, duplicateTabs[1].id, 'file tab ids ignored the owning root');
assert.ok(ws.fileTab(work, 'src/index.js', rootA.id));
assert.ok(ws.fileTab(work, 'src/index.js', rootB.id));
ws.setViewerMode(work, 'src/index.js', 'preview', rootA.id);
ws.setViewerMode(work, 'src/index.js', 'source', rootB.id);
assert.equal(ws.viewerModeFor(work, 'src/index.js', core.readSettings(), rootA.id), 'preview');
assert.equal(ws.viewerModeFor(work, 'src/index.js', core.readSettings(), rootB.id), 'source');
core.saveWorkspace(work);
const duplicateRestored = ws.normalizeWorkspace(core.readWorkspaceRaw(), core.readSettings());
assert.ok(ws.fileTab(duplicateRestored, 'src/index.js', rootA.id), 'root A tab did not restore');
    assert.ok(ws.fileTab(duplicateRestored, 'src/index.js', rootB.id), 'root B tab did not restore');
    ws.openFile(duplicateRestored, '/src/index.js', core.readSettings(), true, rootB.id);
    assert.equal(ws.tabs(duplicateRestored).filter(tab => tab.kind === 'file'
        && tab.folderId === rootB.id && tab.path === 'src/index.js').length, 1,
    'a leading-slash alias created a duplicate tab for the same owned file');
    assert.equal(ws.activeTab(duplicateRestored).path, 'src/index.js',
        'an alias path was retained instead of the canonical file identity');
core.deleteFile('src/index.js', rootA.id);
ws.onFileDeleted(duplicateRestored, 'src/index.js', core.readSettings(), rootA.id);
assert.ok(!ws.fileTab(duplicateRestored, 'src/index.js', rootA.id), 'deleting root A left its tab open');
assert.ok(ws.fileTab(duplicateRestored, 'src/index.js', rootB.id), 'deleting root A closed root B\'s tab');

// ---------------------------------------------------------------------------
// 4. The tab cap evicts least-recently-used FILES, never the Agent
// ---------------------------------------------------------------------------

resetProject();
core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { maxOpenTabs: 4 }));
const cappedSettings = core.readSettings();
work = ws.createWorkspace(cappedSettings);

for (let index = 1; index <= 8; index += 1) {
    const filePath = `docs/prd/doc-${index}.md`;
    core.writeFile(filePath, `# Doc ${index}\n`, {});
    ws.openFile(work, filePath, cappedSettings);
}

assert.equal(ws.tabs(work).length, 4, `the tab cap was not enforced (got ${ws.tabs(work).length})`);
assert.ok(ws.findTab(work, ws.AGENT_TAB_ID), 'LRU eviction closed the pinned Agent tab');
const fileTabs = ws.tabs(work).filter(tab => tab.kind === 'file');
assert.equal(fileTabs.length, 3, 'the cap should leave room for the Agent plus three files');
// The most recently opened documents survive; the oldest are evicted.
assert.ok(fileTabs.some(tab => tab.path === 'docs/prd/doc-8.md'), 'the newest document was evicted');
assert.ok(fileTabs.some(tab => tab.path === 'docs/prd/doc-7.md'), 'the second-newest document was evicted');
assert.ok(!fileTabs.some(tab => tab.path === 'docs/prd/doc-1.md'), 'the least-recently-used document survived');
assert.equal(ws.activeTab(work).path, 'docs/prd/doc-8.md', 'eviction changed the active tab');

// Recency is honoured: touch an old tab and it survives the next eviction.
ws.openFile(work, 'docs/prd/doc-7.md', cappedSettings);
core.writeFile('docs/prd/doc-9.md', '# Doc 9\n', {});
ws.openFile(work, 'docs/prd/doc-9.md', cappedSettings);
assert.equal(ws.tabs(work).length, 4, 'the cap was exceeded after touching an old tab');
assert.ok(ws.fileTab(work, 'docs/prd/doc-7.md'), 'a recently touched tab was evicted ahead of a staler one');

// ---------------------------------------------------------------------------
// 5. Closing tabs: the Agent refuses, neighbours take over
// ---------------------------------------------------------------------------

resetProject();
work = ws.createWorkspace(core.readSettings());
ws.openSection(work, 'cb-files', core.readSettings());
core.writeFile('docs/prd/a.md', '# A\n', {});
ws.openFile(work, 'docs/prd/a.md', core.readSettings());

// Middle of the strip: closing activates the neighbour to the right.
const beforeClose = tabIds(work);
ws.closeTab(work, 'tab-cb-files', core.readSettings());
assert.ok(!ws.findTab(work, 'tab-cb-files'), 'the section tab did not close');
assert.equal(ws.tabs(work).length, beforeClose.length - 1);
assert.equal(ws.activeTab(work).kind, 'file', 'closing should activate the neighbouring tab');

// The pinned Agent refuses to close.
ws.closeTab(work, ws.AGENT_TAB_ID, core.readSettings());
assert.ok(ws.findTab(work, ws.AGENT_TAB_ID), 'the pinned Agent tab was closed');

// With pinning off, the Agent becomes closable and the workspace still recovers.
core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { pinAgentTab: false }));
const unpinnedSettings = core.readSettings();
ws.syncAgentPin(work, unpinnedSettings);
assert.equal(ws.findTab(work, ws.AGENT_TAB_ID).pinned, false, 'syncAgentPin did not unpin the Agent');
ws.closeTab(work, ws.AGENT_TAB_ID, unpinnedSettings);
assert.ok(!ws.findTab(work, ws.AGENT_TAB_ID), 'an unpinned Agent tab should close');
assert.ok(ws.tabs(work).length >= 1, 'closing every tab left the workspace empty');
assert.ok(ws.activeTab(work), 'no tab is active after closing the Agent');

// closeOtherTabs keeps the target and the pinned Agent.
resetProject();
work = ws.createWorkspace(core.readSettings());
ws.openSection(work, 'cb-files', core.readSettings());
ws.openSection(work, 'cb-history', core.readSettings());
ws.openSection(work, 'cb-settings', core.readSettings());
ws.closeOtherTabs(work, 'tab-cb-settings', core.readSettings());
assert.ok(ws.findTab(work, 'tab-cb-settings'), 'closeOtherTabs closed the target tab');
assert.ok(ws.findTab(work, ws.AGENT_TAB_ID), 'closeOtherTabs closed the pinned Agent tab');
assert.equal(ws.tabs(work).length, 2, 'closeOtherTabs left stray tabs');

// closeFileTabs only clears documents.
core.writeFile('docs/prd/b.md', '# B\n', {});
core.writeFile('docs/prd/c.md', '# C\n', {});
ws.openFile(work, 'docs/prd/b.md', core.readSettings());
ws.openFile(work, 'docs/prd/c.md', core.readSettings());
assert.equal(ws.tabs(work).filter(tab => tab.kind === 'file').length, 2);
ws.closeFileTabs(work, core.readSettings());
assert.equal(ws.tabs(work).filter(tab => tab.kind === 'file').length, 0, 'closeFileTabs left document tabs open');
assert.ok(ws.findTab(work, 'tab-cb-settings'), 'closeFileTabs closed a section tab');

// ---------------------------------------------------------------------------
// 6. Written / deleted / renamed files drive tabs per settings
// ---------------------------------------------------------------------------

resetProject();
work = ws.createWorkspace(core.readSettings());

// A run writing a document opens its tab (autoOpenWrittenDocument is on) but in
// the BACKGROUND: the run is still streaming steps into the Agent tab, and
// stealing focus mid-run hides the trace the user is watching.
const agentActiveBefore = ws.activeTab(work).id;
assert.ok(core.writeFile('docs/prd/written.md', '# Written\n', {}),
    'written-file fixture could not be persisted');
ws.onFileWritten(work, 'docs/prd/written.md', core.readSettings());
assert.ok(ws.fileTab(work, 'docs/prd/written.md'), 'a written document did not open a tab');
assert.equal(ws.activeTab(work).id, agentActiveBefore,
    'a written document stole focus from the running Agent tab');
assert.notEqual(ws.activeTab(work).path, 'docs/prd/written.md',
    'the written document became the active tab mid-run');
// The tab is in the strip, ready to click, and carries the right title.
const backgroundTab = ws.fileTab(work, 'docs/prd/written.md');
assert.equal(backgroundTab.title, 'written.md');
assert.equal(backgroundTab.kind, 'file');

// An explicitly opened file still takes focus (the click path is unchanged).
ws.openFile(work, 'docs/prd/written.md', core.readSettings());
assert.equal(ws.activeTab(work).path, 'docs/prd/written.md', 'an explicit openFile did not activate the tab');
ws.activateAgent(work);

// Writing a second document also stays in the background.
assert.ok(core.writeFile('docs/prd/second.md', '# Second\n', {}),
    'second written-file fixture could not be persisted');
ws.onFileWritten(work, 'docs/prd/second.md', core.readSettings());
assert.ok(ws.fileTab(work, 'docs/prd/second.md'), 'a second written document did not open a tab');
assert.equal(ws.activeTab(work).id, ws.AGENT_TAB_ID, 'the second write stole focus too');

// With auto-open off, the tab is not created.
core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { autoOpenWrittenDocument: false }));
const quietSettings = core.readSettings();
ws.onFileWritten(work, 'docs/prd/quiet.md', quietSettings);
assert.ok(!ws.fileTab(work, 'docs/prd/quiet.md'), 'auto-open was off but a tab appeared');
// An already-open tab still gets touched so its title stays right.
ws.onFileWritten(work, 'docs/prd/written.md', quietSettings);
assert.ok(ws.fileTab(work, 'docs/prd/written.md'), 'an existing tab was closed by a quiet write');

// Deleting closes the tab by default.
core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS));
ws.onFileDeleted(work, 'docs/prd/written.md', core.readSettings());
assert.ok(!ws.fileTab(work, 'docs/prd/written.md'), 'deleting a file left its tab open');

// With closeTabOnDelete off, the tab stays so the viewer can explain what happened.
// Note the contract: the CALLER deletes the file (core.deleteFile), then tells the
// workspace about it — onFileDeleted only manages the tab, never the file.
core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { closeTabOnDelete: false }));
const keepSettings = core.readSettings();
core.writeFile('docs/prd/keep.md', '# Keep\n', {});
ws.openFile(work, 'docs/prd/keep.md', keepSettings);
core.deleteFile('docs/prd/keep.md');
ws.onFileDeleted(work, 'docs/prd/keep.md', keepSettings);
assert.ok(ws.fileTab(work, 'docs/prd/keep.md'), 'closeTabOnDelete was off but the tab closed');
// That tab now points at a missing file, so the UI must render its own state.
assert.equal(core.readFile('docs/prd/keep.md'), null, 'the file itself should be gone');
// onFileDeleted must never delete a file it was only told about.
core.writeFile('docs/prd/survivor.md', '# Survivor\n', {});
ws.onFileDeleted(work, 'docs/prd/survivor.md', keepSettings);
assert.ok(core.readFile('docs/prd/survivor.md'), 'onFileDeleted deleted the file instead of only the tab');

// Renaming moves the tab and keeps the per-path viewer mode.
resetProject();
core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS));
work = ws.createWorkspace(core.readSettings());
core.writeFile('docs/prd/old.md', '# Old\n', {});
ws.openFile(work, 'docs/prd/old.md', core.readSettings());
ws.setViewerMode(work, 'docs/prd/old.md', 'source');
core.renameFile('docs/prd/old.md', 'docs/prd/new.md');
ws.onFileRenamed(work, 'docs/prd/old.md', 'docs/prd/new.md', core.readSettings());
assert.ok(ws.fileTab(work, 'docs/prd/new.md'), 'renaming did not move the tab');
assert.ok(!ws.fileTab(work, 'docs/prd/old.md'), 'renaming left the old tab behind');
assert.equal(ws.activeTab(work).path, 'docs/prd/new.md', 'renaming lost the active tab');
assert.equal(ws.viewerModeFor(work, 'docs/prd/new.md', core.readSettings()), 'source',
    'renaming lost the per-document viewer mode');

// ---------------------------------------------------------------------------
// 7. Per-document viewer mode, with the settings default behind it
// ---------------------------------------------------------------------------

resetProject();
work = ws.createWorkspace(core.readSettings());
core.writeFile('docs/prd/v.md', '# V\n', {});
assert.equal(ws.viewerModeFor(work, 'docs/prd/v.md', core.readSettings()), 'preview',
    'the default viewer mode should be preview');
ws.setViewerMode(work, 'docs/prd/v.md', 'source');
assert.equal(ws.viewerModeFor(work, 'docs/prd/v.md', core.readSettings()), 'source');
// Another document is unaffected.
core.writeFile('docs/prd/w.md', '# W\n', {});
assert.equal(ws.viewerModeFor(work, 'docs/prd/w.md', core.readSettings()), 'preview',
    'viewer mode leaked across documents');
// Changing the default applies to documents with no explicit choice.
core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { defaultViewerMode: 'source' }));
assert.equal(ws.viewerModeFor(work, 'docs/prd/w.md', core.readSettings()), 'source',
    'the default viewer mode setting was ignored');
assert.equal(ws.viewerModeFor(work, 'docs/prd/v.md', core.readSettings()), 'source');

// ---------------------------------------------------------------------------
// 8. Persistence: save, reload, and normalize away the impossible
// ---------------------------------------------------------------------------

resetProject();
work = ws.createWorkspace(core.readSettings());
ws.openSection(work, 'cb-files', core.readSettings());
ws.openSection(work, 'cb-settings', core.readSettings());
ws.setSettingsLocation(work, 'workspace', 'editor');
ws.setDivider(work, 380);
core.writeFile('docs/prd/x.md', '# X\n', {});
ws.setViewerMode(work, 'docs/prd/x.md', 'source', core.DEFAULT_FOLDER_ID);
ws.openFile(work, 'docs/prd/x.md', core.readSettings());
ws.openSection(work, 'cb-agent', core.readSettings());   // back to the chat

assert.equal(core.saveWorkspace(work), true, 'saveWorkspace reported failure');
assert.ok(localStorageStub._has(core.WORKSPACE_KEY), 'the workspace was not persisted under its own key');
// Projects and settings keep their own keys — clearing one must not clear another.
assert.ok(localStorageStub._has(core.PROJECTS_KEY), 'saving the workspace clobbered the project store');

const persisted = core.readWorkspaceRaw();
assert.ok(persisted, 'readWorkspaceRaw returned nothing after a save');
const restored = ws.normalizeWorkspace(persisted, core.readSettings());
assert.equal(tabIds(restored).join(','), tabIds(work).join(','), 'the tab order changed across a reload');
assert.equal(restored.activeTabId, work.activeTabId, 'the active tab changed across a reload');
assert.equal(restored.settingsSection, 'workspace');
assert.equal(restored.settingsPage, 'editor');
assert.equal(restored.dividerPx, 380, 'the divider width was not restored');
assert.equal(restored.viewerModeByPath[ws.viewerKey('docs/prd/x.md', core.DEFAULT_FOLDER_ID)], 'source');

// A persisted file tab whose document is gone must not come back.
core.deleteFile('docs/prd/x.md');
const afterDelete = ws.normalizeWorkspace(core.readWorkspaceRaw(), core.readSettings());
assert.ok(!ws.fileTab(afterDelete, 'docs/prd/x.md'), 'a tab was restored for a deleted document');
assert.ok(ws.findTab(afterDelete, ws.AGENT_TAB_ID), 'normalizing dropped the Agent tab');

// Garbage in, sane workspace out.
const junk = ws.normalizeWorkspace({
    tabs: [
        null,
        'not-an-object',
        { kind: 'section', sectionId: 'does-not-exist' },
        { kind: 'file', path: 'docs/prd/never-written.md' },
        { kind: 'agent' },
        { kind: 'agent' },                                  // duplicate
        { kind: 'section', sectionId: 'cb-files' },
        { kind: 'section', sectionId: 'cb-files' }          // duplicate
    ],
    activeTabId: 'tab-does-not-exist',
    settingsSection: 'not-a-section',
    settingsPage: 'not-a-page',
    viewerModeByPath: { 'a.md': 'sideways', 'b.md': 'source' },
    dividerPx: 99999
}, core.readSettings());
assert.equal(junk.tabs.filter(tab => tab.kind === 'agent').length, 1, 'duplicate agent tabs survived');
assert.equal(junk.tabs.filter(tab => tab.id === 'tab-cb-files').length, 1, 'duplicate section tabs survived');
assert.ok(!junk.tabs.some(tab => tab.sectionId === 'does-not-exist'), 'an unknown section tab survived');
assert.ok(!junk.tabs.some(tab => tab.path === 'docs/prd/never-written.md'), 'a tab for a missing file survived');
assert.equal(junk.activeTabId, ws.AGENT_TAB_ID, 'an unknown active tab id was kept');
assert.equal(junk.settingsSection, 'agent', 'an unknown settings section was kept');
assert.equal(junk.settingsPage, 'planning', 'an unknown settings page was kept');
assert.equal(junk.viewerModeByPath['b.md'], 'source');
assert.equal(junk.viewerModeByPath['a.md'], undefined, 'an invalid viewer mode was kept');
assert.ok(junk.dividerPx <= 640, 'an absurd divider width was kept');

// Corrupt JSON in storage falls back to a clean workspace.
localStorageStub.setItem(core.WORKSPACE_KEY, '{not json');
assert.equal(core.readWorkspaceRaw(), null, 'corrupt workspace JSON was not rejected');
const fromCorrupt = ws.normalizeWorkspace(core.readWorkspaceRaw(), core.readSettings());
assert.equal(fromCorrupt.tabs.length, 1);
assert.equal(fromCorrupt.tabs[0].kind, 'agent');

// restoreTabsOnLoad off means a fresh workspace every visit.
core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { restoreTabsOnLoad: false }));
const noRestore = core.readSettings();
const freshWork = ws.normalizeWorkspace(null, noRestore);
assert.equal(freshWork.tabs.length, 1, 'a disabled restore still produced extra tabs');

// ---------------------------------------------------------------------------
// 9. The tab strip renders every tab with the right affordances
// ---------------------------------------------------------------------------

resetProject();
work = ws.createWorkspace(core.readSettings());
ws.openSection(work, 'cb-files', core.readSettings());
core.writeFile('docs/prd/strip.md', '# Strip\n', {});
ws.openFile(work, 'docs/prd/strip.md', core.readSettings());

const strip = ws.renderTabStrip(work, { busy: false, pinAgentTab: true });
assert.equal(strip.getAttribute('role'), 'tablist', 'the strip is not an ARIA tablist');
const tabButtons = findAll(strip, byAction('activate-tab'));
assert.equal(tabButtons.length, 3, 'the strip did not render one button per tab');
tabButtons.forEach(button => {
    assert.equal(button.tagName, 'BUTTON');
    assert.equal(button.getAttribute('role'), 'tab');
    assert.ok(button.getAttribute('aria-controls'), 'a tab is not wired to its panel');
    assert.ok(button.getAttribute('title'), 'a tab has no tooltip');
});
const selectedTabs = tabButtons.filter(button => button.getAttribute('aria-selected') === 'true');
assert.equal(selectedTabs.length, 1, 'exactly one tab should be selected');
assert.equal(selectedTabs[0].dataset.tabId, ws.activeTab(work).id);
assert.equal(selectedTabs[0].tabIndex, 0, 'the selected tab should be the tab-stop');
assert.equal(tabButtons.filter(button => button.tabIndex === -1).length, 2,
    'unselected tabs should be removed from the tab order');

// The pinned Agent shows a pin, not a close button.
const agentButton = tabButtons.find(button => button.dataset.tabId === ws.AGENT_TAB_ID);
assert.equal(findAll(agentButton, byClass('cb-tab-pin')).length, 1, 'the pinned tab shows no pin marker');
assert.equal(findAll(agentButton, byAction('close-tab')).length, 0, 'the pinned Agent tab offers a close button');
assert.ok(String(agentButton.className).includes('pinned'), 'the pinned tab is not marked as pinned');

// Closable tabs each carry a close affordance.
const closable = tabButtons.filter(button => button.dataset.tabId !== ws.AGENT_TAB_ID);
assert.equal(closable.length, 2);
closable.forEach(button => {
    const close = findAll(button, byAction('close-tab'))[0];
    assert.ok(close, 'a closable tab has no close button');
    assert.equal(close.dataset.tabId, button.dataset.tabId, 'the close button targets the wrong tab');
    assert.ok(close.getAttribute('aria-label'), 'the close button has no accessible name');
    assert.equal(close.getAttribute('role'), 'button');
});

// A document tab shows its file name and a document icon.
const stripTab = ws.fileTab(work, 'docs/prd/strip.md');
const fileButton = tabButtons.find(button => button.dataset.tabId === stripTab.id);
assert.match(textOf(fileButton), /strip\.md/, 'the document tab does not show its file name');
assert.ok(findAll(fileButton, byClass('fa-file-lines')).length, 'the document tab has no file icon');

// With pinning off the Agent becomes closable.
core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { pinAgentTab: false }));
const unpinnedStrip = ws.renderTabStrip(work, { busy: false, pinAgentTab: false });
const unpinnedAgent = findAll(unpinnedStrip, byAction('activate-tab'))
    .find(button => button.dataset.tabId === ws.AGENT_TAB_ID);
assert.equal(findAll(unpinnedAgent, byAction('close-tab')).length, 1,
    'an unpinned Agent tab should offer a close button');

// A busy run puts a spinner on the Agent tab so work is visible from any tab.
const busyStrip = ws.renderTabStrip(work, { busy: true, pinAgentTab: true });
const busyAgent = findAll(busyStrip, byAction('activate-tab'))
    .find(button => button.dataset.tabId === ws.AGENT_TAB_ID);
assert.equal(findAll(busyAgent, byClass('cb-tab-busy')).length, 1, 'a busy run shows no indicator on the Agent tab');

// "Close all document tabs" is always reachable from the strip.
assert.equal(findAll(strip, byAction('close-file-tabs')).length, 1, 'no way to close all document tabs');

// ---------------------------------------------------------------------------
// 10. The workspace shell renders the strip plus the active tab's panel
// ---------------------------------------------------------------------------

function workspaceState(overrides) {
    return Object.assign({
        folder: ws.activeSectionId(work),
        busy: false,
        draft: '',
        hint: '',
        settings: core.readSettings(),
        workspace: work,
        settingsSection: work.settingsSection,
        settingsPage: work.settingsPage,
        settingsQuery: '',
        settingsFocusKey: '',
        pinAgentTab: core.readSettings().pinAgentTab !== false,
        treeIndentPx: 13,
        showFileMeta: true,
        viewerMode: 'preview',
        expanded: new Set(['docs', 'docs/prd']),
        selectedSkillId: 'prd-builder',
        messages: [],
        runs: [],
        runCount: 0,
        activeRunId: '',
        projectName: 'ToolShare',
        sourceFiles: [],
        openPath: core.store.openPath,
        pendingQuestion: null,
        run: null,
        modal: null,
        toast: null,
        handlers: {
            render() {}, newRun() {}, stopRun() {}, focusComposer() {}, goSection() {},
            addSourceFile() {}, newFile() {}, exportProject() {}, clearHistory() {}
        }
    }, overrides || {});
}

resetProject();
work = ws.createWorkspace(core.readSettings());
core.writeFile('docs/prd/shell.md', '# Shell\n\nContent here.', {});
ws.openFile(work, 'docs/prd/shell.md', core.readSettings());

const shell = ui.renderWorkspace(workspaceState());
assert.equal(findAll(shell, byClass('cb-workspace')).length >= 1, true, 'the shell root is missing');
const strips = findAll(shell, node => node.dataset && node.dataset.cbRole === 'tabstrip');
assert.equal(strips.length, 1, 'the shell must render exactly one tab strip');
const panels = findAll(shell, node => node.dataset && node.dataset.cbRole === 'tabpanel');
assert.equal(panels.length, 1, 'the shell must render exactly one tab panel');
assert.equal(panels[0].getAttribute('role'), 'tabpanel');

// The strip comes BEFORE the panel in document order — tabs on top, like an IDE.
const shellChildren = shell.children.filter(child => child.nodeType === 1);
const stripIndex = shellChildren.findIndex(child => child.dataset && child.dataset.cbRole === 'tabstrip');
const panelIndex = shellChildren.findIndex(child => child.dataset && child.dataset.cbRole === 'tabpanel');
assert.ok(stripIndex >= 0 && panelIndex >= 0, 'the strip or panel is not a direct child of the shell');
assert.ok(stripIndex < panelIndex, 'the tab strip must render above the panel');

// The panel holds the ACTIVE tab's content: a document, so the viewer.
assert.equal(ws.activeTab(work).kind, 'file');
assert.equal(findAll(panels[0], byClass('cb-viewer')).length, 1, 'the panel does not show the active document');
assert.match(textOf(panels[0]), /Content here/, 'the document content is not rendered in its tab');

// Switch to the Agent and the panel becomes the chat — with the files tab intact.
ws.activateAgent(work);
const agentShell = ui.renderWorkspace(workspaceState());
const agentPanel = findAll(agentShell, node => node.dataset && node.dataset.cbRole === 'tabpanel')[0];
assert.equal(findAll(agentPanel, byClass('cb-agent')).length, 1, 'the Agent tab does not render the chat');
assert.equal(findAll(agentPanel, byClass('cb-viewer')).length, 0, 'the viewer leaked into the Agent tab');
assert.ok(ws.fileTab(work, 'docs/prd/shell.md'), 'switching to the Agent lost the document tab');
assert.equal(findAll(agentShell, byAction('activate-tab')).length, 2, 'the strip lost a tab on switch');

// Each section renders its own page in the panel.
//
// Note the split: the file TREE lives in the host's list pane (sidebar), and the
// Project Files TAB shows the document viewer — the same sidebar/reading-pane
// division SimpleRAG itself uses. So cb-files is expected to render the viewer.
const sectionExpectations = [
    ['cb-files', 'cb-viewer'],
    ['cb-history', 'cb-history'],
    ['cb-settings', 'cb-settings']
];
sectionExpectations.forEach(([sectionId, expectedClass]) => {
    ws.openSection(work, sectionId, core.readSettings());
    const sectionShell = ui.renderWorkspace(workspaceState({ folder: sectionId }));
    const sectionPanel = findAll(sectionShell, node => node.dataset && node.dataset.cbRole === 'tabpanel')[0];
    assert.ok(
        findAll(sectionPanel, byClass(expectedClass)).length >= 1,
        `the ${sectionId} tab did not render its page (expected .${expectedClass})`
    );
});

// The sidebar renders the tree for Project Files, the run list for Runs, and the
// settings navigation for Settings — driven by the active tab, not by a separate
// folder switch.
const sidebarExpectations = [
    ['cb-files', 'cb-tree-wrap'],
    ['cb-history', 'cb-run-list'],
    ['cb-settings', 'cb-settings-nav'],
    ['cb-agent', 'cb-skill-list']
];
sidebarExpectations.forEach(([sectionId, expectedClass]) => {
    ws.openSection(work, sectionId, core.readSettings());
    const listTitle = makeElement('div');
    const listContent = makeElement('div');
    ui.renderList(workspaceState({ folder: sectionId }), listTitle, listContent);
    assert.ok(
        findAll(listContent, byClass(expectedClass)).length >= 1,
        `the ${sectionId} sidebar did not render .${expectedClass}`
    );
    assert.ok(String(listTitle.textContent).length > 0, `the ${sectionId} sidebar has no title`);
});

// A file tab whose document was deleted renders an explanatory state, not a crash.
core.deleteFile('docs/prd/shell.md');
ws.activateTab(work, ws.fileTab(work, 'docs/prd/shell.md').id);
const missingShell = ui.renderWorkspace(workspaceState());
const missingPanel = findAll(missingShell, node => node.dataset && node.dataset.cbRole === 'tabpanel')[0];
assert.equal(findAll(missingPanel, byClass('cb-viewer-empty')).length, 1, 'a deleted document tab rendered nothing useful');
assert.match(textOf(missingPanel), /no longer in the project/, 'the missing-file tab does not explain itself');
assert.equal(findAll(missingPanel, byAction('close-tab')).length, 1, 'the missing-file tab offers no way out');
assert.equal(findAll(missingPanel, byAction('activate-tab')).length, 1, 'the missing-file tab offers no way back to the chat');

// Without a workspace the shell still renders the chat rather than throwing.
const degraded = ui.renderWorkspace(workspaceState({ workspace: null }));
assert.equal(findAll(degraded, byClass('cb-agent')).length, 1, 'a missing workspace should still render the agent');

// ---------------------------------------------------------------------------
// 11. Keyboard shortcuts drive the workspace
// ---------------------------------------------------------------------------

resetProject();
work = ws.createWorkspace(core.readSettings());
core.writeFile('docs/prd/k1.md', '# K1\n', {});
core.writeFile('docs/prd/k2.md', '# K2\n', {});
ws.openFile(work, 'docs/prd/k1.md', core.readSettings());
ws.openFile(work, 'docs/prd/k2.md', core.readSettings());
ws.openSection(work, 'cb-settings', core.readSettings());

const calls = [];
const actions = {
    closeTab: tabId => { calls.push(['closeTab', tabId]); ws.closeTab(work, tabId, core.readSettings()); },
    cycleTab: direction => { calls.push(['cycleTab', direction]); ws.activateTab(work, ws.cycleIndex(work, direction), core.readSettings()); },
    openSection: sectionId => { calls.push(['openSection', sectionId]); ws.openSection(work, sectionId, core.readSettings()); },
    downloadFile: filePath => { calls.push(['downloadFile', filePath]); },
    focusSettingsSearch: () => { calls.push(['focusSettingsSearch']); }
};

function key(combo, extra) {
    return Object.assign({
        key: combo.key,
        ctrlKey: Boolean(combo.ctrl),
        metaKey: false,
        shiftKey: Boolean(combo.shift),
        altKey: Boolean(combo.alt),
        altGraphKey: false,
        target: { tagName: 'DIV', isContentEditable: false }
    }, extra || {});
}

// Ctrl+1..4 jump to Agent / Files / Runs / Settings.
ws.handleShortcut(work, key({ key: '1', ctrl: true }), actions, core.readSettings());
assert.equal(ws.isAgentActive(work), true, 'Ctrl+1 did not jump to the Agent');
ws.handleShortcut(work, key({ key: '4', ctrl: true }), actions, core.readSettings());
assert.equal(ws.activeSectionId(work), 'cb-settings', 'Ctrl+4 did not jump to Settings');
ws.handleShortcut(work, key({ key: '2', ctrl: true }), actions, core.readSettings());
assert.equal(ws.activeSectionId(work), 'cb-files', 'Ctrl+2 did not jump to Project Files');
ws.handleShortcut(work, key({ key: '3', ctrl: true }), actions, core.readSettings());
assert.equal(ws.activeSectionId(work), 'cb-history', 'Ctrl+3 did not jump to Runs');

// Ctrl+Tab cycles forward, Ctrl+Shift+Tab back.
const cycleStart = ws.activeTab(work).id;
assert.equal(ws.handleShortcut(work, key({ key: 'Tab', ctrl: true }), actions, core.readSettings()), true,
    'Ctrl+Tab was not handled');
const afterForward = ws.activeTab(work).id;
assert.notEqual(afterForward, cycleStart, 'Ctrl+Tab did not move to another tab');
ws.handleShortcut(work, key({ key: 'Tab', ctrl: true, shift: true }), actions, core.readSettings());
assert.equal(ws.activeTab(work).id, cycleStart, 'Ctrl+Shift+Tab did not return to the previous tab');
// Cycling wraps around both ends.
const ids = tabIds(work);
let guard = 0;
while (ws.activeTab(work).id !== ids[ids.length - 1] && guard++ < 40) {
    ws.handleShortcut(work, key({ key: 'Tab', ctrl: true }), actions, core.readSettings());
}
assert.ok(guard < 40, 'forward cycling never reached the last tab');
ws.handleShortcut(work, key({ key: 'Tab', ctrl: true }), actions, core.readSettings());
assert.equal(ws.activeTab(work).id, ids[0], 'forward cycling did not wrap to the first tab');

// Ctrl+W closes the active tab, but never the pinned Agent.
ws.activateTab(work, 'tab-cb-settings');
assert.equal(ws.handleShortcut(work, key({ key: 'w', ctrl: true }), actions, core.readSettings()), true);
assert.ok(!ws.findTab(work, 'tab-cb-settings'), 'Ctrl+W did not close the active tab');
ws.activateAgent(work);
const pinnedResult = ws.handleShortcut(work, key({ key: 'w', ctrl: true }), actions, core.readSettings());
assert.equal(pinnedResult, false, 'Ctrl+W should refuse to close the pinned Agent tab');
assert.ok(ws.findTab(work, ws.AGENT_TAB_ID), 'Ctrl+W closed the pinned Agent tab');

// Ctrl+S downloads the open document, and does nothing on a non-file tab.
ws.openFile(work, 'docs/prd/k1.md', core.readSettings());
calls.length = 0;
assert.equal(ws.handleShortcut(work, key({ key: 's', ctrl: true }), actions, core.readSettings()), true);
assert.deepEqual(calls[calls.length - 1], ['downloadFile', 'docs/prd/k1.md']);
ws.activateAgent(work);
calls.length = 0;
assert.equal(ws.handleShortcut(work, key({ key: 's', ctrl: true }), actions, core.readSettings()), false,
    'Ctrl+S should not be captured on the Agent tab');
assert.equal(calls.length, 0, 'Ctrl+S fired a download on a non-file tab');

// Ctrl+F focuses settings search only while the Settings tab is active.
ws.openSection(work, 'cb-settings', core.readSettings());
calls.length = 0;
assert.equal(ws.handleShortcut(work, key({ key: 'f', ctrl: true }), actions, core.readSettings()), true);
assert.deepEqual(calls[calls.length - 1], ['focusSettingsSearch']);
ws.activateAgent(work);
assert.equal(ws.handleShortcut(work, key({ key: 'f', ctrl: true }), actions, core.readSettings()), false,
    'Ctrl+F should not be captured outside Settings');

// Alt+Left returns to the Agent from anywhere.
ws.openSection(work, 'cb-history', core.readSettings());
assert.equal(ws.handleShortcut(work, key({ key: 'ArrowLeft', alt: true }), actions, core.readSettings()), true);
assert.equal(ws.isAgentActive(work), true, 'Alt+Left did not return to the Agent');

// Typing in a text field must not be hijacked.
const typingTarget = { tagName: 'TEXTAREA', isContentEditable: false };
assert.equal(ws.handleShortcut(work, key({ key: 'f', ctrl: true }, { target: typingTarget }), actions, core.readSettings()),
    false, 'Ctrl+F was captured while typing in a textarea');
const editableTarget = { tagName: 'DIV', isContentEditable: true };
assert.equal(ws.handleShortcut(work, key({ key: 'f', ctrl: true }, { target: editableTarget }), actions, core.readSettings()),
    false, 'Ctrl+F was captured inside a contenteditable');
// Tab management still works while a field has focus (IDEs do this too).
assert.equal(ws.handleShortcut(work, key({ key: '2', ctrl: true }, { target: typingTarget }), actions, core.readSettings()),
    true, 'Ctrl+2 should work while a text field has focus');

// AltGr combinations are ignored: on many layouts AltGr reports ctrlKey+altKey.
assert.equal(ws.handleShortcut(work, key({ key: '1', ctrl: true, alt: true }, { altGraphKey: true }), actions, core.readSettings()),
    false, 'an AltGr combination was treated as a shortcut');

// Every documented shortcut is reachable and the reference is complete.
const documented = ws.SHORTCUTS.map(shortcut => shortcut.combo).join(' ');
['Ctrl+W', 'Ctrl+Tab', 'Ctrl+S', 'Ctrl+F'].forEach(combo => {
    assert.ok(documented.includes(combo), `${combo} works but is not documented`);
});
ws.SHORTCUTS.forEach(shortcut => {
    assert.ok(shortcut.combo && shortcut.description, 'a documented shortcut is missing its description');
});

// ---------------------------------------------------------------------------
// 12. Settings location state is validated, not trusted
// ---------------------------------------------------------------------------

ws.setSettingsLocation(work, 'documents', 'naming');
assert.equal(work.settingsSection, 'documents');
assert.equal(work.settingsPage, 'naming');

// An unknown section falls back to the first one.
ws.setSettingsLocation(work, 'not-a-section', 'naming');
assert.equal(work.settingsSection, schema.sections()[0].id, 'an unknown section was accepted');

// A page that does not belong to the section falls back to that section's first.
ws.setSettingsLocation(work, 'documents', 'planning');
assert.equal(work.settingsSection, 'documents');
assert.equal(work.settingsPage, schema.getPage('documents', null).id,
    'a page from another section was accepted');

// The search query is length-limited so it cannot be used to store junk.
ws.setSettingsQuery(work, 'x'.repeat(500));
assert.ok(work.settingsQuery.length <= 120, 'the settings query was not length-limited');

// The divider is clamped to a usable range.
ws.setDivider(work, 10);
assert.ok(work.dividerPx >= 180, 'the divider was allowed below its minimum');
ws.setDivider(work, 100000);
assert.ok(work.dividerPx <= 640, 'the divider was allowed above its maximum');
ws.setDivider(work, 0);
assert.equal(work.dividerPx, 0, 'zero means "use the setting" and must stay zero');
ws.setDivider(work, 'not a number');
assert.equal(work.dividerPx, 0, 'a non-numeric divider was not rejected');

console.log('workspace.test.cjs: 13 workspace groups passed');
console.log(`  tabs verified  : agent pinned, 3 sections, per-document editors`);
console.log(`  cap behaviour  : LRU file eviction at maxOpenTabs`);
console.log(`  shortcuts      : ${ws.SHORTCUTS.length} documented and exercised`);
console.log(`  persistence    : save/restore + normalization of corrupt layouts`);
