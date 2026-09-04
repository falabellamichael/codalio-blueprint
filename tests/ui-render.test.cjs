'use strict';

/*
 * Codalio Blueprint — page render test.
 *
 * Calls the real ui.js render functions with a DOM stub and walks the trees they
 * build, asserting the Cursor-style page is actually constructed: skill cards,
 * the one big chat with its step timeline, the composer, the project file tree
 * with correct nesting, the document viewer, the runs list, and settings.
 *
 * Run: node tests/ui-render.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');

// ---------------------------------------------------------------------------
// DOM stub with query support so the trees can be inspected like the real DOM
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
        value: '',
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
        className: '',
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
            this.lastElementChild = this.children[this.children.length - 1] || null;
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
    // Mirror the real DOM: assigning textContent replaces children with one text
    // node, and reading it concatenates every descendant text node. Without this
    // the tree walk in textOf() misses labels set as `el.textContent = 'x'`.
    Object.defineProperty(element, 'textContent', {
        get() {
            const parts = [];
            (element.children || []).forEach(child => {
                if (child.nodeType === 3) parts.push(child.textContent);
                else if (child.textContent) parts.push(child.textContent);
            });
            return parts.join('');
        },
        set(value) {
            element.children.length = 0;
            element.childElementCount = 0;
            element.lastElementChild = null;
            if (value !== '' && value !== null && value !== undefined) {
                element.children.push({ nodeType: 3, textContent: String(value), children: [] });
            }
        },
        configurable: true
    });
    // A real <select> derives .value from its selected <option>; the stub must
    // too, otherwise assertions on select state test nothing.
    Object.defineProperty(element, 'value', {
        get() {
            if (element.tagName !== 'SELECT') return ownValue;
            const selected = (element.children || []).find(child => child.selected);
            return selected ? String(selected.value) : '';
        },
        set(next) { ownValue = String(next); },
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
    createDocumentFragment() { const f = makeElement('fragment'); f.isFragment = true; return f; },
    createTextNode(text) { return { nodeType: 3, textContent: String(text), children: [] }; },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; }
};

const sandbox = {
    window: {
        document: documentStub,
        localStorage: localStorageStub,
        location: { href: 'http://127.0.0.1:18411/gui/' },
        navigator: { clipboard: null },
        matchMedia: () => ({ addEventListener() {}, matches: false }),
        MutationObserver: class { observe() {} disconnect() {} },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = (init || {}).detail; } },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return true; },
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        requestAnimationFrame: () => 0,
        console
    },
    document: documentStub,
    localStorage: localStorageStub,
    navigator: { clipboard: null },
    location: { href: 'http://127.0.0.1:18411/gui/' },
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = (init || {}).detail; } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    Blob: class Blob {},
    FileReader: class { readAsText() {} },
    fetch: () => Promise.reject(new Error('no fetch in this test')),
    TextDecoder: global.TextDecoder,
    TextEncoder: global.TextEncoder,
    AbortController: global.AbortController,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, Promise,
    Intl,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent
};
sandbox.window.window = sandbox.window;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);
function runFile(file) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
}
// Load the module chain in the order the installer declares it. Loading only
// ui.js would exercise the "settings module missing" error card instead of the
// page that actually ships, so the test would pass while the product is broken.
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
const skills = sandbox.window.__codalioBlueprintSkills;
const schema = sandbox.window.__codalioBlueprintSettings;
const ws = sandbox.window.__codalioBlueprintWorkspace;
const settingsPageModule = sandbox.window.__codalioBlueprintSettingsPage;

// The test must load the real modules, not fall back to an error card.
assert.ok(schema, 'settings.js did not load');
assert.ok(ws, 'workspace.js did not load');
assert.ok(settingsPageModule, 'settings-page.js did not load');

// ---------------------------------------------------------------------------
// Tree walking helpers
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
const byRole = role => node => node.nodeType === 1 && node.dataset && node.dataset.cbRole === role;
const byTag = tag => node => node.nodeType === 1 && node.tagName === String(tag).toUpperCase();

function textOf(root) {
    const parts = [];
    walk(root, node => { if (node.nodeType === 3) parts.push(node.textContent); });
    return parts.join(' ');
}

function directChildrenByClass(root, name) {
    return (root.children || []).filter(byClass(name));
}

// ---------------------------------------------------------------------------
// Fixture state
// ---------------------------------------------------------------------------

core.store.files = {};
core.store.runs = [];
core.store.openPath = '';
core.store.activeRunId = '';
core.writeStore();

const handlers = {
    render() {}, newRun() {}, stopRun() {}, focusComposer() {}, goSection() {},
    addSourceFile() {}, newFile() {}, exportProject() {}, clearHistory() {},
    // The Project Files ribbon and the multi-root explorer call these. Without them
    // renderRibbon('cb-files') throws on a missing function.
    newFolder() {}, openFolder() {}, selectFolder() {}, renameFolder() {}, deleteFolder() {}
};

function baseState(overrides) {
    return Object.assign({
        folder: 'cb-agent',
        busy: false,
        draft: '',
        hint: '',
        viewerMode: 'preview',
        expanded: new Set(['docs', 'docs/prd']),
        selectedSkillId: 'prd-builder',
        messages: [],
        runs: [],
        runCount: 0,
        activeRunId: '',
        projectName: 'ToolShare',
        sourceFiles: [],
        openPath: '',
        pendingQuestion: null,
        run: null,
        modal: null,
        toast: null,
        handlers
    }, overrides || {});
}

// ---------------------------------------------------------------------------
// 1. Agent page: the one big chat
// ---------------------------------------------------------------------------

const emptyAgent = ui.renderAgentPage(baseState());
assert.ok(directChildrenByClass(emptyAgent, 'cb-agent').length === 1 || String(emptyAgent.className).includes('cb-agent'), 'agent page root missing');
assert.equal(findAll(emptyAgent, byClass('cb-agent-header')).length, 1, 'agent header missing');
assert.equal(findAll(emptyAgent, byRole('transcript')).length, 1, 'transcript container missing');

const transcriptNode = findAll(emptyAgent, byRole('transcript'))[0];
assert.equal(transcriptNode.getAttribute('role'), 'log', 'transcript is not an aria live log');
assert.equal(transcriptNode.getAttribute('aria-live'), 'polite');

// Welcome state offers all six skills as pickers.
const welcome = findAll(emptyAgent, byClass('cb-welcome'));
assert.equal(welcome.length, 1, 'welcome panel missing on an empty run');
const welcomeCards = findAll(welcome[0], byAction('pick-skill'));
assert.equal(welcomeCards.length, 6, `expected 6 skill cards in the welcome state, got ${welcomeCards.length}`);
const cardIds = welcomeCards.map(card => card.dataset.skillId).sort();
assert.equal(cardIds.join(','), skills.SKILLS.map(s => s.id).sort().join(','), 'skill cards do not cover every skill');

// Composer with a send control exists and is enabled when idle.
const composer = findAll(emptyAgent, byRole('composer'));
assert.equal(composer.length, 1, 'composer textarea missing');
assert.equal(composer[0].tagName, 'TEXTAREA');
assert.equal(composer[0].disabled, false);
const send = findAll(emptyAgent, byAction('send'));
assert.equal(send.length, 1, 'send button missing');
assert.equal(send[0].disabled, false);
assert.equal(findAll(emptyAgent, byAction('stop-run')).length, 0, 'stop button should not show while idle');

// ---------------------------------------------------------------------------
// 2. Busy state swaps Send for Stop and locks the composer
// ---------------------------------------------------------------------------

const busyAgent = ui.renderAgentPage(baseState({ busy: true, draft: 'an idea' }));
assert.equal(findAll(busyAgent, byAction('stop-run')).length, 1, 'stop button missing while running');
const busyComposer = findAll(busyAgent, byRole('composer'))[0];
assert.equal(busyComposer.disabled, true, 'composer must be locked while a step runs');
assert.equal(busyComposer.value, 'an idea', 'the draft was not restored into the composer');
const busySend = findAll(busyAgent, byAction('send'))[0];
assert.equal(busySend.disabled, true, 'send must be disabled while running');

// ---------------------------------------------------------------------------
// 3. A message with steps renders the visible Cursor-style trace
// ---------------------------------------------------------------------------

const steps = [
    { id: 's1', kind: 'notice', label: "I'm using the prd-builder skill to build your PRD.", summary: 'tagline', status: 'done', text: 'desc', open: false },
    { id: 's2', kind: 'lens', label: 'Lens 1 — Product & Scope', summary: 'pitch, stories, MVP', status: 'done', text: '## Elevator pitch\nFor neighbors…', promptPreview: 'LENS PROMPT TEXT', open: true, elapsedMs: 4210 },
    { id: 's3', kind: 'document', label: 'Synthesize the three lenses into one PRD', summary: 'merge', status: 'running', text: 'partial', promptPreview: 'SYNTH PROMPT', open: true, streaming: true, liveElement: makeElement('div') },
    { id: 's4', kind: 'question', label: 'Clarifying question — user', summary: 'who', status: 'running', question: 'Who is this for?', options: ['Designers', 'Developers'], open: true },
    { id: 's5', kind: 'notice', label: 'Wrote docs/prd/2026-09-03-toolshare-prd.md', summary: '1,204 chars', status: 'done', text: 'saved', open: false },
    { id: 's6', kind: 'notice', label: 'Failed step', summary: '', status: 'error', text: '', error: 'The model stream ended before completion.', open: true }
];

const msgAgent = ui.renderAgentPage(baseState({
    messages: [
        { id: 'm1', role: 'user', at: new Date().toISOString(), text: 'An app for neighbors to lend tools.' },
        { id: 'm2', role: 'assistant', at: new Date().toISOString(), skillName: 'PRD Builder', steps, paths: ['docs/prd/2026-09-03-toolshare-prd.md'], text: 'Run complete.', canRetry: false }
    ],
    run: { id: 'r1', title: 'PRD Builder', status: 'done', skillName: 'PRD Builder' }
}));

const timelines = findAll(msgAgent, byRole('timeline'));
assert.equal(timelines.length, 1, 'step timeline missing');
const renderedSteps = directChildrenByClass(timelines[0], 'cb-step');
assert.equal(renderedSteps.length, steps.length, `expected ${steps.length} step rows, got ${renderedSteps.length}`);

// Each step carries its status class so the user can see done/running/error.
assert.ok(renderedSteps.some(s => String(s.className).includes('cb-step-done')), 'no done step');
assert.ok(renderedSteps.some(s => String(s.className).includes('cb-step-running')), 'no running step');
assert.ok(renderedSteps.some(s => String(s.className).includes('cb-step-error')), 'no error step');

// Every step head is a button the user can expand/collapse.
const stepHeads = findAll(timelines[0], byAction('toggle-step'));
assert.equal(stepHeads.length, steps.length, 'not every step is expandable');
stepHeads.forEach(head => {
    assert.equal(head.tagName, 'BUTTON');
    assert.equal(head.getAttribute('aria-expanded') === 'true' || head.getAttribute('aria-expanded') === 'false', true, 'step head has no aria-expanded');
});

// An open model step exposes BOTH the prompt and the output — the whole point of
// showing every step like Cursor does.
const openLens = renderedSteps.find(s => s.dataset.stepId === 's2');
assert.match(textOf(openLens), /Prompt sent to the model/, 'open step does not show the prompt it sent');
assert.match(textOf(openLens), /LENS PROMPT TEXT/, 'prompt text is not visible to the user');
assert.match(textOf(openLens), /Elevator pitch/, 'model output is not rendered');
assert.match(textOf(openLens), /4\.2s/, 'elapsed time is not shown');

// A streaming step shows the live element rather than static text.
const streamingStep = renderedSteps.find(s => s.dataset.stepId === 's3');
assert.match(textOf(streamingStep), /streaming/i, 'streaming step is not labelled as streaming');

// An error step surfaces the message in its own box (distinct class from the
// row's cb-step-error status, so the two never fight over the same element).
const errorStep = renderedSteps.find(s => s.dataset.stepId === 's6');
assert.equal(findAll(errorStep, byClass('cb-step-errbox')).length, 1, 'error step has no error box');
assert.match(textOf(errorStep), /The model stream ended before completion/, 'the error message is not shown');
assert.ok(String(errorStep.className).includes('cb-step-error'), 'the failed step row lost its error status class');

// A question step offers clickable options.
const questionStep = renderedSteps.find(s => s.dataset.stepId === 's4');
const optionChips = findAll(questionStep, byAction('answer-question'));
assert.equal(optionChips.length, 2, 'question options are not clickable');
assert.equal(optionChips[0].dataset.answer, 'Designers');
assert.match(textOf(questionStep), /Who is this for\?/);

// Written documents are one-click openable from the message.
const pathChips = findAll(msgAgent, byAction('open-file'));
assert.ok(pathChips.some(chip => chip.dataset.path === 'docs/prd/2026-09-03-toolshare-prd.md'), 'written path chip missing');

// Message actions.
assert.equal(findAll(msgAgent, byAction('copy-message')).length, 1, 'copy action missing');
assert.equal(findAll(msgAgent, byAction('revise-message')).length, 1, 'revise action missing');

// ---------------------------------------------------------------------------
// 4. Project file tree nests folders correctly
// ---------------------------------------------------------------------------

core.store.files = {};
core.writeFile('docs/prd/2026-09-03-toolshare-prd.md', '# ToolShare — PRD\n\nBody.', {});
core.writeFile('docs/backlog/2026-09-03-toolshare-backlog.md', '# Backlog\n', {});
core.writeFile('docs/mvp/2026-09-03-toolshare-mvp-checklist.md', '# MVP\n', {});
core.writeFile('src/router.py', 'def handle(): pass\n', {});
core.setOpenPath('docs/prd/2026-09-03-toolshare-prd.md');

const treeState = baseState({ folder: 'cb-files', expanded: new Set(['docs', 'docs/prd', 'src']) });
const treeHost = makeElement('div');
const listTitle = makeElement('div');
const listContent = makeElement('div');
ui.renderList(treeState, listTitle, listContent);
void treeHost;

const treeRows = findAll(listContent, byClass('cb-tree-row'));
assert.ok(treeRows.length >= 4, `expected folder + file rows, got ${treeRows.length}`);
const folderRows = findAll(listContent, byClass('cb-tree-folder'));
const fileRows = findAll(listContent, byClass('cb-tree-file'));
assert.ok(folderRows.some(r => textOf(r).includes('docs')), 'docs folder missing');
assert.ok(folderRows.some(r => textOf(r).includes('prd')), 'nested prd folder missing (tree did not nest)');
assert.ok(folderRows.some(r => textOf(r).includes('src')), 'src folder missing');
assert.ok(fileRows.some(r => r.dataset.path === 'docs/prd/2026-09-03-toolshare-prd.md'), 'nested file row missing');
assert.ok(fileRows.some(r => r.dataset.path === 'src/router.py'), 'src/router.py row missing');

// Collapsed folders hide their children.
const collapsed = baseState({ folder: 'cb-files', expanded: new Set() });
const collapsedContent = makeElement('div');
ui.renderList(collapsed, makeElement('div'), collapsedContent);
const collapsedFiles = findAll(collapsedContent, byClass('cb-tree-file'));
assert.equal(collapsedFiles.length, 0, 'collapsed folders still showed their files');

// Indentation increases with depth so the nesting is visible.
const docsRow = folderRows.find(r => textOf(r).trim() === 'docs');
const prdRow = folderRows.find(r => textOf(r).trim() === 'prd');
const docsIndent = Number.parseInt(String(docsRow.style.paddingLeft), 10);
const prdIndent = Number.parseInt(String(prdRow.style.paddingLeft), 10);
assert.ok(prdIndent > docsIndent, 'nested folders are not indented deeper than their parent');

// Tree rows are keyboard reachable and expose treeitem semantics.
fileRows.forEach(row => {
    assert.equal(row.getAttribute('role'), 'treeitem');
    assert.equal(row.tabIndex, 0);
});

// ---------------------------------------------------------------------------
// 5. Document viewer renders Markdown and offers the file tools
// ---------------------------------------------------------------------------

const filesPage = ui.renderFilesPage(baseState({ folder: 'cb-files', openPath: 'docs/prd/2026-09-03-toolshare-prd.md' }));
const viewerBody = findAll(filesPage, byClass('cb-viewer-body'));
assert.equal(viewerBody.length, 1, 'viewer body missing');
assert.match(textOf(viewerBody[0]), /ToolShare — PRD/, 'document content not rendered');
assert.equal(findAll(filesPage, byAction('copy-file')).length, 1);
assert.equal(findAll(filesPage, byAction('download-file')).length, 1);
assert.equal(findAll(filesPage, byAction('delete-file')).length, 1);
assert.equal(findAll(filesPage, byAction('rename-file')).length, 1);
assert.equal(findAll(filesPage, byAction('viewer-toggle')).length, 1);
assert.match(textOf(filesPage), /docs\/prd\/2026-09-03-toolshare-prd\.md/, 'viewer does not show the open path');

// Source mode renders the file through the code previewer: line-number gutter,
// syntax colouring, and an Ln/Col status bar. It must still show the RAW text —
// a previewer that reformatted what it displayed would be worse than a <pre>.
const sourcePage = ui.renderFilesPage(baseState({ folder: 'cb-files', viewerMode: 'source', openPath: 'docs/prd/2026-09-03-toolshare-prd.md' }));
const sourcePreview = findAll(sourcePage, byClass('cb-preview'));
assert.equal(sourcePreview.length, 1, 'source mode did not render the code previewer');

// The gutter numbers every line of the document.
const gutterCells = findAll(sourcePage, byClass('cb-preview-ln'));
const sourceLines = core.readFile('docs/prd/2026-09-03-toolshare-prd.md').content.split('\n').length;
assert.equal(gutterCells.length, sourceLines, 'the gutter did not number every line');
assert.equal(gutterCells[0].textContent, '1', 'gutter numbering does not start at 1');

// The status bar reports a caret position, the language, and the encoding.
const statusText = textOf(findAll(sourcePage, byClass('cb-preview-status'))[0]);
assert.match(statusText, /Ln 1, Col 1/, 'the status bar reports no caret position');
assert.match(statusText, /Markdown/, 'the status bar does not name the language');
assert.match(statusText, /UTF-8/, 'the status bar does not report an encoding');

// Every character of the source is still readable — the heading survives as raw
// Markdown ('#'), not as a rendered <h1>. The toolbar and status bar text precede
// the code, so this is a containment check rather than an anchored one.
const previewText = textOf(sourcePreview[0]);
assert.ok(previewText.includes('# ToolShare — PRD'),
    'source mode did not show the raw Markdown heading');
assert.ok(!previewText.includes('<h1'), 'source mode rendered HTML instead of showing raw text');

// No file open -> an empty state with a way forward, not a blank pane.
const noFilePage = ui.renderFilesPage(baseState({ folder: 'cb-files', openPath: '' }));
assert.equal(findAll(noFilePage, byClass('cb-viewer-empty')).length, 1, 'no empty state for an unopened project');
assert.equal(findAll(noFilePage, byAction('add-source-file')).length, 1, 'empty state offers no way to add a file');

// ---------------------------------------------------------------------------
// 5b. The Project Files sidebar is a MULTI-ROOT explorer
//
// Regression guard for the reported bug: selecting a project folder used to scope
// the tree to that folder, so every other folder's documents disappeared from the
// sidebar and it read as "the files are not showing". Now every project folder is
// a root and every root lists all of its own files, so nothing is hidden by
// selection.
// ---------------------------------------------------------------------------

// Start from an empty project so each folder holds exactly the files written
// below. Section 4 left documents under docs/backlog and docs/mvp, whose
// subfolders are not expanded here, so carrying them over would hide them and
// fail the "lists every file" assertion for an unrelated reason.
core.store.files = {};
core.store.openPath = '';
core.writeStore();

const multiFolders = core.listFolders();
const folderA = multiFolders[0];
const folderB = core.createFolder('Second project').folder;
const folderC = core.createFolder('Imported repo', 'imported').folder;

core.setActiveFolder(folderA.id);
core.writeFile('docs/prd/a-prd.md', '# A PRD\n', {});
core.writeFile('src/a-main.py', 'def a(): pass\n', {});
core.setActiveFolder(folderB.id);
core.writeFile('docs/prd/b-prd.md', '# B PRD\n', {});
core.setActiveFolder(folderC.id);
core.writeFile('README.md', '# Imported\n', {});
core.writeFile('lib/tool.js', 'export const t = 1;\n', {});
core.setActiveFolder(folderA.id);

// Every directory that contains a listed file, so the tree is fully open and the
// "lists every file" assertion below is about the explorer, not about which
// subfolders happen to be expanded.
const allDirs = new Set();
core.listFiles().forEach(path => {
    const parts = path.split('/');
    parts.pop();
    let walked = [];
    parts.forEach(part => { walked = walked.concat([part]); allDirs.add(walked.join('/')); });
});

// Deliberately leave folderA ACTIVE while asserting that B's and C's files are
// still visible — that is the exact case the old scoped tree failed.
const multiState = baseState({
    folder: 'cb-files',
    openPath: '',
    folders: core.listFolders(),
    activeFolderId: folderA.id,
    activeFolderName: folderA.name,
    folderFileCounts: core.listFolders().reduce((acc, f) => { acc[f.id] = core.folderFileCount(f.id); return acc; }, {}),
    collapsedRoots: new Set(),
    expanded: allDirs
});
const multiContent = makeElement('div');
ui.renderList(multiState, makeElement('div'), multiContent);

// Every project folder renders as a root.
const roots = findAll(multiContent, byClass('cb-tree-root'));
assert.equal(roots.length, core.listFolders().length,
    'not every project folder rendered as a root');
assert.equal(roots.filter(byAction('toggle-folder-root')).length, roots.length,
    'a folder root is not clickable to expand or collapse');

// The active folder is badged, the others are not.
assert.equal(roots.filter(r => r.className.includes('active')).length, 1,
    'exactly one root should be marked as the target folder');
assert.equal(findAll(multiContent, byClass('cb-root-badge')).length, 1,
    'the target-folder badge is missing or duplicated');

// EVERY file in EVERY folder is listed, including folders that are not active.
const listedPaths = findAll(multiContent, byAction('open-file')).map(r => r.dataset.path);
['docs/prd/a-prd.md', 'src/a-main.py', 'docs/prd/b-prd.md', 'README.md', 'lib/tool.js'].forEach(expected => {
    assert.ok(listedPaths.includes(expected),
        `${expected} is missing from the sidebar (its folder is not the active one)`);
});
assert.equal(listedPaths.length, core.listFiles().length,
    'the sidebar does not list every file in the project');

// Each root reports its own file count, so the user can see where things are.
const countCells = findAll(multiContent, byClass('cb-tree-meta')).map(c => c.textContent);
assert.ok(countCells.includes('2'), 'no root reports its 2-file count');
assert.ok(countCells.includes('1'), 'no root reports its 1-file count');

// Imported folders are visually distinguishable and keep their origin in the tooltip.
const importedRoot = roots.find(r => r.dataset.folderId === folderC.id);
assert.ok(importedRoot, 'the imported folder did not render');
assert.match(importedRoot.title, /imported from disk/, 'the imported folder does not say where it came from');

// A collapsed root hides only its own files — the other roots keep theirs.
const collapsedRootState = Object.assign({}, multiState, {
    collapsedRoots: new Set([ui.folderRootKey(folderC.id)])
});
const collapsedRootContent = makeElement('div');
ui.renderList(collapsedRootState, makeElement('div'), collapsedRootContent);
const collapsedPaths = findAll(collapsedRootContent, byAction('open-file')).map(r => r.dataset.path);
assert.ok(!collapsedPaths.includes('README.md'), 'a collapsed root still listed its files');
assert.ok(collapsedPaths.includes('docs/prd/b-prd.md'),
    'collapsing one root hid another root\'s files');
assert.equal(findAll(collapsedRootContent, byClass('cb-tree-root')).length, core.listFolders().length,
    'collapsing a root removed it from the list entirely');

// Folder tools: rename/delete on non-default roots, never on the default one.
assert.equal(findAll(multiContent, byAction('rename-folder')).length, core.listFolders().length - 1,
    'rename should be offered on every folder except the default');
assert.ok(!findAll(multiContent, byAction('delete-folder')).some(b => b.dataset.folderId === core.DEFAULT_FOLDER_ID),
    'the default folder offers a delete button');
// A non-active root offers "create files here"; the active one does not need to.
assert.equal(findAll(multiContent, byAction('select-folder')).length, core.listFolders().length - 1,
    'the target-folder action should be offered on every non-active folder');

// Restore a single-folder state for the remaining sections.
core.setActiveFolder(core.DEFAULT_FOLDER_ID);
[folderB.id, folderC.id].forEach(id => core.deleteFolder(id));
core.store.files = {};
core.writeFile('docs/prd/2026-09-03-toolshare-prd.md', '# ToolShare — PRD\n\nBody.', {});
core.writeFile('docs/backlog/2026-09-03-toolshare-backlog.md', '# Backlog\n', {});
core.writeFile('docs/mvp/2026-09-03-toolshare-mvp-checklist.md', '# MVP\n', {});
core.writeFile('src/router.py', 'def handle(): pass\n', {});
core.writeStore();

// ---------------------------------------------------------------------------
// 6. Runs list and history page
// ---------------------------------------------------------------------------

const run = {
    id: 'r1', skillId: 'prd-builder', skillName: 'PRD Builder', title: 'PRD Builder',
    idea: 'An app for neighbors to lend tools.', createdAt: new Date().toISOString(),
    status: 'done', projectName: 'ToolShare', slug: 'toolshare',
    phases: [{ id: 'p1', kind: 'notice', label: 'Wrote docs/prd/x.md', status: 'done', text: 'saved', open: false }],
    writtenPaths: ['docs/prd/2026-09-03-toolshare-prd.md'], error: ''
};
const historyListContent = makeElement('div');
ui.renderList(baseState({ folder: 'cb-history', runs: [run], activeRunId: 'r1', runCount: 1 }), makeElement('div'), historyListContent);
const runItems = findAll(historyListContent, byAction('open-run'));
assert.equal(runItems.length, 1, 'run list did not show the stored run');
assert.match(textOf(runItems[0]), /PRD Builder/);
assert.match(textOf(runItems[0]), /1 written/, 'run row does not report how many documents it wrote');

const historyPage = ui.renderHistoryPage(baseState({ folder: 'cb-history', runs: [run], activeRunId: 'r1' }));
assert.match(textOf(historyPage), /An app for neighbors to lend tools/, 'history page lost the original idea');
assert.equal(findAll(historyPage, byAction('delete-run')).length, 1, 'history page has no way to delete a run');
assert.equal(findAll(historyPage, byClass('cb-timeline')).length, 1, 'history page has no step trace');

// Empty history is a real empty state.
const emptyHistory = ui.renderHistoryPage(baseState({ folder: 'cb-history', runs: [] }));
assert.equal(findAll(emptyHistory, byClass('cb-viewer-empty')).length, 1, 'no empty state for zero runs');

// ---------------------------------------------------------------------------
// 7. Settings page is schema-driven and thorough
// ---------------------------------------------------------------------------

core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { concurrency: 'sequential', lensMaxOutputTokens: 6000 }));

// 7a. Every page of every section renders, and every field on that page appears.
let fieldCount = 0;
schema.sections().forEach(section => {
    section.pages.forEach(page => {
        const pageNode = ui.renderSettingsPage(baseState({
            folder: 'cb-settings',
            settingsSection: section.id,
            settingsPage: page.id,
            settings: core.readSettings()
        }));
        assert.ok(pageNode, `${section.id}/${page.id} rendered nothing`);

        const expected = [];
        page.groups.forEach(group => (group.fields || []).forEach(field => expected.push(field.key)));
        const rendered = findAll(pageNode, node => node.nodeType === 1 && node.dataset && node.dataset.cbSetting)
            .map(input => input.dataset.cbSetting);
        // Segmented controls emit one input per option, so compare unique keys.
        const unique = [...new Set(rendered)].sort();
        assert.equal(
            unique.join(','),
            expected.slice().sort().join(','),
            `${section.id}/${page.id} does not render exactly its own fields`
        );
        fieldCount += expected.length;

        // The page header names the page and carries its live summary.
        assert.match(textOf(pageNode), new RegExp(page.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
            `${section.id}/${page.id} header does not name the page`);

        // Actions declared on a group render as buttons keyed by action name.
        page.groups.forEach(group => {
            (group.actions || []).forEach(action => {
                assert.equal(
                    findAll(pageNode, byAction(`settings-action:${action.key}`)).length,
                    1,
                    `${section.id}/${page.id} is missing the ${action.key} action`
                );
            });
        });
    });
});
assert.equal(fieldCount, schema.allFields().length,
    'the union of rendered fields does not equal the schema — some field is unreachable from the UI');
assert.ok(fieldCount >= 40, `expected a thorough settings surface, found ${fieldCount} fields`);

// 7b. Controls match the declared type.
const planningPage = ui.renderSettingsPage(baseState({
    folder: 'cb-settings', settingsSection: 'agent', settingsPage: 'planning', settings: core.readSettings()
}));
const concurrencyInputs = findAll(planningPage, node => node.dataset && node.dataset.cbSetting === 'concurrency');
assert.ok(concurrencyInputs.length >= 2, 'a segmented control should emit one radio per option');
concurrencyInputs.forEach(input => assert.equal(input.type, 'radio'));
const checkedConcurrency = concurrencyInputs.find(input => input.checked);
assert.equal(checkedConcurrency.value, 'sequential', 'the segmented control did not reflect the stored value');

const toggleInput = findAll(planningPage, node => node.dataset && node.dataset.cbSetting === 'askClarifyingQuestions')[0];
assert.equal(toggleInput.type, 'checkbox');
assert.equal(toggleInput.checked, true, 'a default-on toggle did not render as checked');

// 7c. Numeric controls carry their documented bounds, so the UI cannot offer a
// value the engine would clamp away.
const modelPage = ui.renderSettingsPage(baseState({
    folder: 'cb-settings', settingsSection: 'agent', settingsPage: 'model', settings: core.readSettings()
}));
const lensInput = findAll(modelPage, node => node.dataset && node.dataset.cbSetting === 'lensMaxOutputTokens')[0];
assert.equal(lensInput.tagName, 'INPUT');
assert.equal(lensInput.value, '6000', 'the token budget did not reflect the stored value');
assert.equal(lensInput.min, '512');
assert.equal(lensInput.max, '32768');
const tempField = schema.getField('temperature');
const tempInput = findAll(modelPage, node => node.dataset && node.dataset.cbSetting === 'temperature')[0];
assert.equal(tempInput.type, 'range', 'temperature should be a range slider');
assert.equal(tempInput.min, String(tempField.min));
assert.equal(tempInput.max, String(tempField.max));
// The readout shows the formatted value, not a raw float.
const tempReadout = findAll(modelPage, node => node.dataset && node.dataset.cbRole === 'range-value-temperature')[0];
assert.ok(tempReadout, 'the temperature slider has no readout');
assert.equal(tempReadout.textContent, tempField.format(core.readSettings().temperature));
// Hint presets let the user jump to a documented value.
const tempHints = findAll(modelPage, node => node.dataset && node.dataset.cbAction === 'settings-range-jump'
    && node.dataset.settingKey === 'temperature');
assert.equal(tempHints.length, tempField.hints.length, 'range hints are missing');

// 7d. Every field row states its label, current value and help text.
schema.allFields().forEach(field => {
    const page = ui.renderSettingsPage(baseState({
        folder: 'cb-settings',
        settingsSection: field.sectionId,
        settingsPage: field.pageId,
        settings: core.readSettings()
    }));
    const row = findAll(page, node => node.dataset && node.dataset.cbSettingKey === field.key)[0];
    assert.ok(row, `no row rendered for ${field.key}`);
    assert.match(textOf(row), new RegExp(field.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${field.key} row does not show its label`);
    assert.match(textOf(row), new RegExp(field.help.split('.')[0].slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${field.key} row does not show its help text`);
    // The label is wired to the control.
    const label = findAll(row, byTag('label'))[0];
    assert.ok(label, `${field.key} row has no label element`);
});

// 7e. Sidebar navigation lists every section and page with live summaries.
const navNode = settingsPageModule.renderSettingsNav(baseState({
    folder: 'cb-settings', settingsSection: 'agent', settingsPage: 'planning',
    settingsQuery: '', settings: core.readSettings()
}));
const navItems = findAll(navNode, byAction('settings-goto'));
const expectedPages = schema.sections().reduce((total, section) => total + section.pages.length, 0);
assert.equal(navItems.length, expectedPages, 'the sidebar does not list every settings page');
navItems.forEach(item => {
    assert.ok(item.dataset.sectionId && item.dataset.pageId, 'a nav item cannot navigate');
});
const activeNav = navItems.filter(item => String(item.className).includes('active'));
assert.equal(activeNav.length, 1, 'exactly one nav item should be marked active');
assert.equal(activeNav[0].dataset.pageId, 'planning');
assert.equal(activeNav[0].getAttribute('aria-current'), 'page');
// Summaries reflect real values, not static copy.
assert.match(textOf(navNode), /Sequential lenses/, 'the planning summary does not report the stored value');
const searchInput = findAll(navNode, node => node.dataset && node.dataset.cbRole === 'settings-search')[0];
assert.ok(searchInput, 'the sidebar has no search field');
assert.equal(searchInput.type, 'search');

// 7f. Search finds a field by plain-language query and reports where it lives.
const temperatureHits = schema.searchFields('temperature');
assert.ok(temperatureHits.length, 'searching "temperature" found nothing');
assert.equal(temperatureHits[0].key, 'temperature');
assert.equal(temperatureHits[0].sectionId, 'agent');
assert.equal(temperatureHits[0].pageId, 'model');

const tabHits = schema.searchFields('tabs');
assert.ok(tabHits.some(hit => hit.key === 'maxOpenTabs'), 'searching "tabs" did not find the tab limit');

const tokenHits = schema.searchFields('token budget');
assert.ok(
    tokenHits.some(hit => hit.key === 'lensMaxOutputTokens') && tokenHits.some(hit => hit.key === 'documentMaxOutputTokens'),
    'searching "token budget" did not find both token budgets'
);
assert.equal(schema.searchFields('zzzqqq-not-a-setting').length, 0, 'a nonsense query returned matches');

// Searching renders results in the sidebar instead of the tree.
const searchedNav = settingsPageModule.renderSettingsNav(baseState({
    folder: 'cb-settings', settingsSection: 'agent', settingsPage: 'planning',
    settingsQuery: 'temperature', settings: core.readSettings()
}));
const results = findAll(searchedNav, byAction('settings-focus'));
assert.ok(results.length, 'an active search rendered no results');
assert.equal(results[0].dataset.settingKey, 'temperature');
assert.equal(findAll(searchedNav, byAction('settings-goto')).length, 0, 'the nav tree should be replaced while searching');
assert.equal(findAll(searchedNav, byAction('clear-settings-search')).length, 1, 'no way to clear the search');

// A query with no match says so instead of showing an empty pane.
const emptyNav = settingsPageModule.renderSettingsNav(baseState({
    folder: 'cb-settings', settingsSection: 'agent', settingsPage: 'planning',
    settingsQuery: 'zzzqqq', settings: core.readSettings()
}));
assert.equal(findAll(emptyNav, byClass('cb-settings-results-empty')).length, 1, 'no empty state for a failed search');

// 7g. Sub-page tabs appear only when a section has more than one page.
//
// Asserted as a CONTRACT against the live schema rather than as hardcoded
// counts: "the source section renders 0 tabs" froze a snapshot that became
// wrong the moment a second page was added to that section.
// The invariant under test is RELATIONSHIP, not a count: sub-tabs render iff a
// section has more than one page, exactly one per page. Deriving the expected
// count from the schema means this holds however the schema grows — a hardcoded
// number broke the moment Path context became the Source section's third page.
const dataSection = schema.getSection('data');
const dataPage = ui.renderSettingsPage(baseState({
    folder: 'cb-settings', settingsSection: 'data', settingsPage: 'storage', settings: core.readSettings()
}));
assert.equal(findAll(dataPage, byAction('settings-goto')).length, dataSection.pages.length,
    `the Data section has ${dataSection.pages.length} pages so that many sub-tabs should render`);

// Both source pages are rendered and kept, because the innerHTML sweep in
// section 10 walks them for unsafe model text.
const sourceSection = schema.getSection('source');
const sourceLimitsPage = ui.renderSettingsPage(baseState({
    folder: 'cb-settings', settingsSection: 'source', settingsPage: 'limits', settings: core.readSettings()
}));
const sourceDigestPage = ui.renderSettingsPage(baseState({
    folder: 'cb-settings', settingsSection: 'source', settingsPage: 'digest', settings: core.readSettings()
}));
assert.equal(findAll(sourceLimitsPage, byAction('settings-goto')).length, sourceSection.pages.length,
    `the Source section has ${sourceSection.pages.length} pages (attach limits, whole-codebase reading, path context)`);
assert.ok(sourceSection.pages.some(page => page.id === 'path-context'),
    'the Path context page is missing from the Source section schema');

// The digest page renders its three controls with the documented bounds, so a
// user can actually reach the feature and cannot configure a step that hangs.
const digestText = textOf(sourceDigestPage);
assert.match(digestText, /Source context mode/, 'the mode control is missing from the digest page');
assert.match(digestText, /Whole codebase/, 'the whole-codebase option is missing');
assert.match(digestText, /Attached only/, 'the attached-only option is missing');
assert.match(digestText, /Token budget/, 'the token budget control is missing');
const digestInputs = findAll(sourceDigestPage, node => node.tagName === 'INPUT');
const budgetInput = digestInputs.find(input => input.dataset.cbSetting === 'digestBudgetTokens');
assert.ok(budgetInput, 'the token budget input did not render');
assert.equal(budgetInput.value, '16000', 'the token budget did not render its default');
assert.equal(budgetInput.min, '2048', 'the token budget floor is not enforced in the UI');
assert.equal(budgetInput.max, '65536', 'the token budget ceiling is not enforced in the UI');
const minLinesInput = digestInputs.find(input => input.dataset.cbSetting === 'digestMinFullTextLines');
assert.ok(minLinesInput, 'the minimum-lines input did not render');
assert.equal(minLinesInput.value, '40', 'the minimum-lines default did not render');
const modeInputs = digestInputs.filter(input => input.dataset.cbSetting === 'sourceContextMode');
assert.equal(modeInputs.length, 2, 'the mode control did not render both options');
const checkedMode = modeInputs.find(input => input.checked);
assert.ok(checkedMode, 'neither source context mode was selected by default');
assert.equal(checkedMode.value, 'attached',
    'the default mode is not "attached" — that would silently change behaviour for existing users');

// The Path context page renders its controls with the documented bounds, so a
// user can actually reach the feature and cannot configure a read that hangs
// the tab. Defaults mirror core.DEFAULT_SETTINGS.
const pathContextPage = ui.renderSettingsPage(baseState({
    folder: 'cb-settings', settingsSection: 'source', settingsPage: 'path-context', settings: core.readSettings()
}));
const pathContextText = textOf(pathContextPage);
assert.match(pathContextText, /Folder to read/, 'the path field label is missing from the Path context page');
assert.match(pathContextText, /Maximum files read/, 'the file-cap control is missing');
const pathContextInputs = findAll(pathContextPage, node => node.tagName === 'INPUT');
const pathInput = pathContextInputs.find(input => input.dataset.cbSetting === 'pathContextPath');
assert.ok(pathInput, 'the path input did not render');
assert.equal(pathInput.value, '', 'the path field did not render its empty default');
assert.equal(pathInput.maxLength, 500, 'the path length cap is not enforced in the UI');
const enabledToggle = pathContextInputs.find(input => input.dataset.cbSetting === 'pathContextEnabled');
assert.ok(enabledToggle, 'the enable toggle did not render');
assert.equal(enabledToggle.checked, false,
    'path context must default OFF in the UI — it reads the disk at run time');
const maxFilesInput = pathContextInputs.find(input => input.dataset.cbSetting === 'pathContextMaxFiles');
assert.ok(maxFilesInput, 'the file-cap input did not render');
assert.equal(maxFilesInput.value, '400', 'the file cap did not render its default');
assert.equal(maxFilesInput.max, '5000', 'the file-cap ceiling is not enforced in the UI');
const totalKbInput = pathContextInputs.find(input => input.dataset.cbSetting === 'pathContextTotalKb');
assert.ok(totalKbInput, 'the total-size input did not render');
assert.equal(totalKbInput.value, '6144', 'the total-size cap did not render its default');
const fileKbInput = pathContextInputs.find(input => input.dataset.cbSetting === 'pathContextFileKb');
assert.ok(fileKbInput, 'the per-file-size input did not render');
assert.equal(fileKbInput.value, '256', 'the per-file cap did not render its default');
assert.equal(fileKbInput.max, '4096', 'the per-file ceiling is not enforced in the UI');

schema.sections().forEach(section => {
    section.pages.forEach(page => {
        const rendered = ui.renderSettingsPage(baseState({
            folder: 'cb-settings', settingsSection: section.id, settingsPage: page.id,
            settings: core.readSettings()
        }));
        const tabs = findAll(rendered, byAction('settings-goto'));
        const expected = section.pages.length > 1 ? section.pages.length : 0;
        assert.equal(tabs.length, expected,
            `section "${section.id}" page "${page.id}": expected ${expected} sub-page tabs, got ${tabs.length}`);
        if (expected) {
            // Every page of the section is reachable, and the current one is marked.
            const ids = tabs.map(tab => tab.dataset.pageId);
            section.pages.forEach(item => {
                assert.ok(ids.indexOf(item.id) >= 0,
                    `section "${section.id}" has no sub-tab for page "${item.id}"`);
            });
            const active = tabs.filter(tab => tab.classList.contains('active'));
            assert.equal(active.length, 1,
                `section "${section.id}" page "${page.id}": expected exactly one active sub-tab`);
            assert.equal(active[0].dataset.pageId, page.id,
                `section "${section.id}": the active sub-tab is not the page being rendered`);
        }
    });
});
assert.ok(schema.sections().length >= 5, 'the settings schema lost sections');

// 7h. Read-only panels land on their own pages.
assert.equal(findAll(dataPage, byClass('cb-metrics')).length, 1, 'the storage metrics strip is missing');
assert.match(textOf(dataPage), /Documents/, 'the metrics strip does not report document counts');
const tabsPage = ui.renderSettingsPage(baseState({
    folder: 'cb-settings', settingsSection: 'workspace', settingsPage: 'tabs', settings: core.readSettings()
}));
assert.equal(findAll(tabsPage, byClass('cb-shortcuts')).length, 1, 'the shortcut reference is missing');
const kbdCount = findAll(tabsPage, byTag('kbd')).length;
assert.equal(kbdCount, ws.SHORTCUTS.length, 'not every shortcut is documented on the Tabs page');

// 7i. Per-page reset restores just that page's fields.
const resetButtons = findAll(modelPage, byAction('reset-settings-page'));
assert.equal(resetButtons.length, 1, 'no per-page reset button');
assert.equal(resetButtons[0].dataset.pageId, 'model');

// 7j. Privacy claim: the settings surface states the workspace is untouched.
assert.match(textOf(dataPage), /never read or written/i, 'settings must state that SimpleRAG data is untouched');

// ---------------------------------------------------------------------------
// 8. Nav + ribbon host surfaces
// ---------------------------------------------------------------------------

const navFolders = [];
ui.renderNav(baseState({ runCount: 2 }), {
    addFolder: (id, iconName, label, count) => navFolders.push({ id, iconName, label, count })
});
assert.equal(navFolders.length, ui.SECTIONS.length, 'nav did not offer every section');
assert.equal(navFolders.map(f => f.id).join(','), 'cb-agent,cb-files,cb-history,cb-settings');
const filesFolder = navFolders.find(f => f.id === 'cb-files');
assert.equal(filesFolder.count, core.listFiles().length, 'nav file count does not match the project');
const historyFolder = navFolders.find(f => f.id === 'cb-history');
assert.equal(historyFolder.count, 2, 'nav run count is wrong');

const ribbonButtons = [];
ui.renderRibbon(baseState({ folder: 'cb-agent' }), {
    addBtn: (id, iconName, label, primary, onclick) => ribbonButtons.push({ id, iconName, label, primary, onclick }),
    addSep: () => ribbonButtons.push({ id: 'sep' })
});
assert.ok(ribbonButtons.some(b => b.id === 'cb-run-new'), 'ribbon has no New Run');
assert.ok(ribbonButtons.some(b => b.id === 'cb-run-resume'), 'idle ribbon has no Run');
assert.ok(!ribbonButtons.some(b => b.id === 'cb-run-stop'), 'idle ribbon must not show Stop');
ribbonButtons.filter(b => b.onclick).forEach(b => assert.equal(typeof b.onclick, 'function'));

const busyRibbon = [];
ui.renderRibbon(baseState({ folder: 'cb-agent', busy: true }), {
    addBtn: (id, iconName, label, primary, onclick) => busyRibbon.push({ id, onclick }),
    addSep: () => {}
});
assert.ok(busyRibbon.some(b => b.id === 'cb-run-stop'), 'busy ribbon has no Stop');
assert.ok(!busyRibbon.some(b => b.id === 'cb-run-resume'), 'busy ribbon must not offer Run');

const filesRibbon = [];
ui.renderRibbon(baseState({ folder: 'cb-files' }), {
    addBtn: (id, iconName, label, primary, onclick) => filesRibbon.push({ id }),
    addSep: () => {}
});
assert.ok(filesRibbon.some(b => b.id === 'cb-add-source'), 'files ribbon has no Add Source File');
assert.ok(filesRibbon.some(b => b.id === 'cb-export-project'), 'files ribbon has no Download All');

// ---------------------------------------------------------------------------
// 9. Modal + toast
// ---------------------------------------------------------------------------

const modalState = baseState({
    modal: {
        kind: 'file', title: 'Add a source file', icon: 'fa-file-circle-plus',
        description: 'desc', path: 'src/main.py', allowUpload: true,
        accept: '.py', confirmLabel: 'Add file', onConfirm: () => true
    }
});
const modal = ui.renderModal(modalState);
assert.equal(findAll(modal, byAction('close-modal')).length >= 2, true, 'modal cannot be dismissed');
assert.equal(findAll(modal, byAction('confirm-modal')).length, 1, 'modal has no confirm');
assert.equal(modal.getAttribute('role') === null, true, 'backdrop should not be the dialog');
const dialog = findAll(modal, byClass('cb-modal'))[0];
assert.equal(dialog.getAttribute('role'), 'dialog');
assert.equal(dialog.getAttribute('aria-modal'), 'true');
assert.equal(findAll(modal, node => node.dataset && node.dataset.cbField === 'path').length, 1, 'modal has no path field');
assert.equal(findAll(modal, node => node.dataset && node.dataset.cbField === 'file').length, 1, 'upload modal has no file input');
assert.equal(findAll(modal, byAction('pick-upload')).length, 1, 'upload modal has no choose-file button');

const confirmModal = ui.renderModal(baseState({
    modal: { kind: 'confirm', title: 'Delete file', message: 'Delete x?', danger: true, confirmLabel: 'Delete', onConfirm: () => true }
}));
const dangerButton = findAll(confirmModal, byAction('confirm-modal'))[0];
assert.ok(String(dangerButton.className).includes('danger'), 'a destructive confirm is not styled as dangerous');

const toast = ui.renderToast(baseState({ toast: { text: 'Saved.', tone: 'success' } }));
assert.equal(toast.getAttribute('role'), 'status', 'toast is not announced');
assert.match(textOf(toast), /Saved\./);

// ---------------------------------------------------------------------------
// 10. No innerHTML carries model text anywhere in the rendered trees
// ---------------------------------------------------------------------------

[
    emptyAgent, busyAgent, msgAgent, filesPage, sourcePage, historyPage,
    planningPage, modelPage, dataPage, tabsPage, sourceLimitsPage, sourceDigestPage,
    navNode, searchedNav, emptyNav,
    listContent, modal, toast
].forEach(root => {
    walk(root, node => {
        if (node.nodeType !== 1) return;
        const assigned = String(node.innerHTML || '');
        assert.equal(assigned, '', 'a rendered node assigned innerHTML with content');
    });
});

// Hostile model text must reach the DOM only as inert text nodes.
const hostileRecord = core.writeFile('docs/prd/hostile.md', '# T\n\n<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n', {});
assert.ok(hostileRecord);
const hostilePage = ui.renderFilesPage(baseState({ folder: 'cb-files', openPath: 'docs/prd/hostile.md' }));
const hostileTags = [];
walk(hostilePage, node => { if (node.nodeType === 1) hostileTags.push(node.tagName); });
['SCRIPT', 'IMG'].forEach(tag => {
    assert.ok(!hostileTags.includes(tag), `the viewer created a <${tag}> from document content`);
});
assert.match(textOf(hostilePage), /<img src=x onerror=alert\(1\)>/, 'hostile markup was dropped rather than shown as text');

console.log('ui-render.test.cjs: 11 render groups passed');
console.log(`  skill cards    : ${welcomeCards.length}`);
console.log(`  step rows      : ${renderedSteps.length} (done/running/error/question/lens/document)`);
console.log(`  tree rows      : ${treeRows.length} across nested docs/ and src/`);
console.log(`  folder roots   : ${roots.length} roots, ${listedPaths.length} files listed across all of them`);
console.log(`  nav sections   : ${navFolders.length}`);
console.log('  innerHTML      : never assigned with content in any rendered tree');
