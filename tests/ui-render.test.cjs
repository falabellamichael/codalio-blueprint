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
runFile(path.join(SRC, 'controller-core.js'));
runFile(path.join(SRC, 'skills.js'));
runFile(path.join(SRC, 'ui.js'));

const core = sandbox.window.__codalioBlueprintCore;
const ui = sandbox.window.__codalioBlueprintUi;
const skills = sandbox.window.__codalioBlueprintSkills;

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
    addSourceFile() {}, newFile() {}, exportProject() {}, clearHistory() {}
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

// Source mode shows the raw Markdown instead of the rendered preview.
const sourcePage = ui.renderFilesPage(baseState({ folder: 'cb-files', viewerMode: 'source', openPath: 'docs/prd/2026-09-03-toolshare-prd.md' }));
const sourcePre = findAll(sourcePage, byClass('cb-viewer-source'));
assert.equal(sourcePre.length, 1, 'source mode has no raw text view');
assert.match(textOf(sourcePre[0]), /^# ToolShare — PRD/, 'source mode did not show the raw Markdown');

// No file open -> an empty state with a way forward, not a blank pane.
const noFilePage = ui.renderFilesPage(baseState({ folder: 'cb-files', openPath: '' }));
assert.equal(findAll(noFilePage, byClass('cb-viewer-empty')).length, 1, 'no empty state for an unopened project');
assert.equal(findAll(noFilePage, byAction('add-source-file')).length, 1, 'empty state offers no way to add a file');

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
// 7. Settings page exposes every real setting
// ---------------------------------------------------------------------------

core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { concurrency: 'sequential', lensMaxOutputTokens: 6000 }));
const settingsPage = ui.renderSettingsPage(baseState({ folder: 'cb-settings' }));
const settingInputs = findAll(settingsPage, node => node.nodeType === 1 && node.dataset && node.dataset.cbSetting);
const settingKeys = settingInputs.map(input => input.dataset.cbSetting).sort();
assert.equal(
    settingKeys.join(','),
    ['askClarifyingQuestions', 'autoOpenWrittenDocument', 'concurrency', 'documentMaxOutputTokens', 'lensMaxOutputTokens', 'temperature'].join(','),
    'settings page does not expose every persisted setting'
);
const concurrencySelect = settingInputs.find(input => input.dataset.cbSetting === 'concurrency');
assert.equal(concurrencySelect.tagName, 'SELECT');
assert.equal(concurrencySelect.value, 'sequential', 'the select did not reflect the stored value');
const lensInput = settingInputs.find(input => input.dataset.cbSetting === 'lensMaxOutputTokens');
assert.equal(lensInput.value, '6000', 'the token budget did not reflect the stored value');
assert.equal(findAll(settingsPage, byAction('clear-history')).length, 1, 'no way to clear run history');
assert.equal(findAll(settingsPage, byAction('clear-files')).length, 1, 'no way to clear project files');
assert.match(textOf(settingsPage), /never read or written/i, 'settings must state that SimpleRAG data is untouched');

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

[emptyAgent, busyAgent, msgAgent, filesPage, sourcePage, historyPage, settingsPage, listContent, modal, toast].forEach(root => {
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

console.log('ui-render.test.cjs: 10 render groups passed');
console.log(`  skill cards    : ${welcomeCards.length}`);
console.log(`  step rows      : ${renderedSteps.length} (done/running/error/question/lens/document)`);
console.log(`  tree rows      : ${treeRows.length} across nested docs/ and src/`);
console.log(`  nav sections   : ${navFolders.length}`);
console.log('  innerHTML      : never assigned with content in any rendered tree');
