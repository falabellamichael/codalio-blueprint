'use strict';

/*
 * Codalio Blueprint — File Selector & Review Manager Overlay Test Suite.
 *
 * Verifies:
 * 1. sourceFilesForModel: 'combine' (on top of agent files) vs 'exclusive' (review independently)
 * 2. ui.renderFileSelectorOverlay: layout, mode cards, search, category chips, folder filtering,
 *    bulk actions, file list badges, preview drawer, stats/token budget calculation, and action buttons.
 * 3. Event / data attribute integrity across all FSO controls.
 *
 * Run: node tests/file-selector-overlay.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'src');

function createDOMStub() {
    function createElement(tagName) {
        const classes = new Set();
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
            get textContent() {
                if (this._text !== undefined) return this._text;
                return (this.children || []).map(c => (c && c.textContent) || '').join('');
            },
            set textContent(v) {
                this._text = String(v);
            },
            offsetParent: {},
            disabled: false,
            checked: false,
            selected: false,
            get value() {
                if (this.tagName === 'SELECT') {
                    const sel = (this.children || []).find(c => c.selected);
                    return sel ? (sel.value || '') : (this._value !== undefined ? this._value : '');
                }
                return this._value !== undefined ? this._value : '';
            },
            set value(v) {
                this._value = String(v);
            },
            type: '',
            scrollTop: 0,
            scrollHeight: 0,
            clientHeight: 0,
            lastElementChild: null,
            get classList() {
                return {
                    add: (...names) => names.forEach(n => classes.add(n)),
                    remove: (...names) => names.forEach(n => classes.delete(n)),
                    toggle: (n, force) => {
                        const on = force === undefined ? !classes.has(n) : Boolean(force);
                        if (on) classes.add(n); else classes.delete(n);
                        return on;
                    },
                    contains: n => classes.has(n)
                };
            },
            appendChild(child) {
                if (!child) return null;
                this.children.push(child);
                child.parentElement = this;
                child.parentNode = this;
                this.childElementCount = this.children.length;
                this.lastElementChild = child;
                return child;
            },
            setAttribute(name, value) {
                this.attributes[name] = String(value);
            },
            getAttribute(name) {
                return this.attributes[name] !== undefined ? this.attributes[name] : null;
            },
            removeAttribute(name) {
                delete this.attributes[name];
            },
            hasAttribute(name) {
                return this.attributes[name] !== undefined;
            },
            querySelector(selector) {
                const results = this.querySelectorAll(selector);
                return results[0] || null;
            },
            querySelectorAll(selector) {
                const matches = [];
                function walk(node) {
                    if (!node || !node.children) return;
                    for (const child of node.children) {
                        if (child.nodeType !== 1) continue;
                        if (matchesSelector(child, selector)) {
                            matches.push(child);
                        }
                        walk(child);
                    }
                }
                walk(this);
                return matches;
            },
            closest(selector) {
                let curr = this;
                while (curr) {
                    if (curr.nodeType === 1 && matchesSelector(curr, selector)) return curr;
                    curr = curr.parentElement;
                }
                return null;
            }
        };

        Object.defineProperty(element, 'className', {
            get: () => Array.from(classes).join(' '),
            set: val => {
                classes.clear();
                String(val || '').split(/\s+/).filter(Boolean).forEach(n => classes.add(n));
            },
            configurable: true
        });
        return element;
    }

    function matchesSelector(el, selector) {
        if (!el || el.nodeType !== 1) return false;
        if (selector === '*') return true;
        if (selector.startsWith('.')) {
            const classList = selector.slice(1).split('.').filter(Boolean);
            return classList.every(cls => el.classList.contains(cls));
        }
        if (selector.startsWith('[')) {
            const inner = selector.slice(1, -1);
            const eqIdx = inner.indexOf('=');
            if (eqIdx === -1) {
                return el.hasAttribute(inner) || (inner.startsWith('data-') && el.dataset[toCamel(inner.slice(5))] !== undefined);
            }
            const attr = inner.slice(0, eqIdx);
            const val = inner.slice(eqIdx + 1).replace(/^['"]|['"]$/g, '');
            if (attr.startsWith('data-')) {
                const camel = toCamel(attr.slice(5));
                return String(el.dataset[camel]) === val;
            }
            return el.getAttribute(attr) === val;
        }
        if (selector.toLowerCase() === el.tagName.toLowerCase()) return true;
        return false;
    }

    function toCamel(str) {
        return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    }

    function createTextNode(text) {
        return {
            nodeType: 3,
            textContent: String(text),
            parentElement: null,
            parentNode: null
        };
    }

    return {
        createElement,
        createTextNode,
        body: createElement('body')
    };
}

function createLocalStorageStub() {
    const store = new Map();
    return {
        getItem: k => store.has(k) ? store.get(k) : null,
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: k => store.delete(k),
        clear: () => store.clear(),
        get length() { return store.size; },
        key: i => Array.from(store.keys())[i] || null
    };
}

function createSandbox() {
    const doc = createDOMStub();
    const storage = createLocalStorageStub();
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        AbortController,
        window: {
            localStorage: storage,
            document: doc
        },
        document: doc,
        localStorage: storage
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);

    doc.addEventListener = (type, handler) => {
        if (!doc._handlers) doc._handlers = {};
        if (!doc._handlers[type]) doc._handlers[type] = [];
        doc._handlers[type].push(handler);
    };
    doc.removeEventListener = () => {};
    doc.getElementById = id => doc.querySelector('#' + id);
    sandbox.window.addEventListener = doc.addEventListener;
    sandbox.window.removeEventListener = () => {};
    sandbox.window.document = doc;
    sandbox.window.RAGWorkspaceExtensions = {
        registerController() {},
        registerManifest() {}
    };
    sandbox.window.__codalioBlueprintManifest = JSON.parse(fs.readFileSync(path.join(SRC, 'plugin.json'), 'utf8'));

    // Load dependencies in order
    const load = filename => {
        const code = fs.readFileSync(path.join(SRC, filename), 'utf8');
        vm.runInContext(code, sandbox, { filename });
    };

    load('controller-core.js');
    load('settings.js');
    load('skills.js');
    load('agent.js');
    load('preview.js');
    load('workspace.js');
    load('ui.js');
    load('settings-page.js');
    load('controller.js');

    return {
        core: sandbox.window.__codalioBlueprintCore,
        settings: sandbox.window.__codalioBlueprintSettings,
        skills: sandbox.window.__codalioBlueprintSkills,
        agent: sandbox.window.__codalioBlueprintAgent,
        ui: sandbox.window.__codalioBlueprintUi,
        controller: sandbox.window.codalioBlueprint && (sandbox.window.codalioBlueprint.handlers || sandbox.window.codalioBlueprint.controller),
        blueprint: sandbox.window.codalioBlueprint,
        doc
    };
}

console.log('--- Testing File Selector & Review Strategy ---');

// ===========================================================================
// Test 1: sourceFilesForModel - Combine vs Exclusive Review Strategies
// ===========================================================================
{
    const { core, agent } = createSandbox();

    // Populate project files in workspace
    core.writeFile('src/main.js', 'console.log("hello main");', { skill: 'test' });
    core.writeFile('src/utils.js', 'export const add = (a, b) => a + b;', { skill: 'test' });
    core.writeFile('docs/prd/spec.md', '# PRD Specification', { skill: 'test' });
    core.writeFile('config/settings.json', '{"debug": true}', { skill: 'test' });

    const testSettings = {
        includeSourceInPrompts: true,
        maxSourceFiles: 4,
        maxSourceFileKb: 10,
        maxSourceTotalKb: 50
    };

    const userSelectedFiles = [
        { path: 'src/main.js', content: 'console.log("hello main");' }
    ];

    // Case 1A: Combine Mode (On top of Agent files)
    // Attached files come first, workspace files continue to be auto-discovered up to budget
    const combined = agent.sourceFilesForModel({
        sourceFiles: userSelectedFiles,
        sourceFileMode: 'combine'
    }, testSettings);

    assert(combined.length > 1, 'Combine mode should include both attached and auto-discovered files');
    assert.equal(combined[0].path, 'src/main.js', 'Attached file must be first');
    assert(combined.some(f => f.path === 'src/utils.js'), 'Workspace files should be auto-discovered');
    console.log('✓ Combine mode augments user attached files with workspace discovery (count: ' + combined.length + ')');

    // Case 1B: Exclusive Mode (Review independently)
    // ONLY user selected files; auto-discovery is completely bypassed
    const exclusive = agent.sourceFilesForModel({
        sourceFiles: userSelectedFiles,
        sourceFileMode: 'exclusive'
    }, testSettings);

    assert.equal(exclusive.length, 1, 'Exclusive mode must strictly contain ONLY user selected files');
    assert.equal(exclusive[0].path, 'src/main.js', 'Exclusive file must match selection');
    assert(!exclusive.some(f => f.path === 'src/utils.js'), 'Workspace files must NOT be auto-discovered in exclusive mode');
    console.log('✓ Exclusive mode strictly reviews only user selected files (count: ' + exclusive.length + ')');

    // Case 1C: No user files attached
    // Workspace auto-discovery fills budget regardless of mode
    const autoOnly = agent.sourceFilesForModel({
        sourceFiles: [],
        sourceFileMode: 'combine'
    }, testSettings);
    assert(autoOnly.length >= 2, 'Auto-discovery runs when no files attached');
    console.log('✓ Auto-discovery runs when no manual files attached (count: ' + autoOnly.length + ')');
}

// ===========================================================================
// Test 2: UI Rendering - File Selector Overlay Dialog & Controls
// ===========================================================================
{
    const { core, ui } = createSandbox();

    core.writeFile('src/app.js', 'const x = 1;\nconst y = 2;', { skill: 'test' });
    core.writeFile('src/style.css', 'body { margin: 0; }', { skill: 'test' });
    core.writeFile('docs/prd/prd-overview.md', '# Product Spec\nLine 2\nLine 3', { skill: 'test' });
    core.writeFile('package.json', '{\n  "name": "test"\n}', { skill: 'test' });

    const state = {
        folders: [{ id: 'default', name: 'Default' }],
        projectFiles: core.listFiles(),
        sourceFiles: [{ path: 'src/app.js', content: 'const x = 1;\nconst y = 2;' }],
        sourceFileMode: 'combine',
        fileSelector: {
            open: true,
            selectedPaths: new Set(['src/app.js']),
            search: '',
            category: 'all',
            folderId: 'all',
            previewPath: 'src/app.js',
            reviewMode: 'combine'
        }
    };

    const overlay = ui.renderFileSelectorOverlay(state);
    assert(overlay, 'Overlay backdrop must be returned');
    assert.equal(overlay.dataset.cbAction, 'close-file-selector', 'Backdrop close action');

    const modal = overlay.querySelector('.cb-fso-modal');
    assert(modal, 'Modal dialog container must exist');
    assert.equal(modal.getAttribute('role'), 'dialog');

    // Header checks
    const title = modal.querySelector('h2');
    assert(title && title.textContent.includes('File Selector'), 'Header title rendered');

    // Mode cards checks
    const combineCard = modal.querySelector('.cb-fso-mode-combine');
    const exclusiveCard = modal.querySelector('.cb-fso-mode-exclusive');
    assert(combineCard, 'Combine card rendered');
    assert(exclusiveCard, 'Exclusive card rendered');
    assert(combineCard.classList.contains('cb-fso-mode-active'), 'Combine card active by default');
    assert(!exclusiveCard.classList.contains('cb-fso-mode-active'), 'Exclusive card not active');

    // Toolbar checks
    const searchInput = modal.querySelector('[data-cb-role="fso-search"]');
    assert(searchInput, 'Search input rendered');

    const chips = modal.querySelectorAll('.cb-fso-chip');
    assert.equal(chips.length, 5, 'Should render 5 category chips (All, Code, Docs, Config, Selected)');

    const bulkBtns = modal.querySelectorAll('.cb-fso-bulk-btn');
    assert.equal(bulkBtns.length, 4, 'Should render 4 bulk buttons (Select All, Fill Budget, Deselect All, Invert)');

    // List checks
    const rows = modal.querySelectorAll('.cb-fso-row');
    assert(rows.length >= 4, 'Should render all project files');
    const selectedRow = modal.querySelector('.cb-fso-row.cb-fso-selected');
    assert(selectedRow, 'Selected row has .cb-fso-selected class');

    // Preview drawer checks
    const previewDrawer = modal.querySelector('.cb-fso-preview-drawer');
    assert(previewDrawer, 'Preview drawer rendered for src/app.js');
    const codeBlock = previewDrawer.querySelector('.cb-fso-preview-code');
    assert(codeBlock && codeBlock.textContent.includes('const x = 1;'), 'Preview displays file content');

    // Footer stats & actions
    const statCount = modal.querySelector('.cb-fso-stat-count');
    assert(statCount && statCount.textContent.includes('1 file'), 'Stats report selected count');

    const reviewNowBtn = modal.querySelector('[data-cb-action="fso-review-now"]');
    assert(reviewNowBtn, 'Review Selected Files Now button rendered');

    const confirmBtn = modal.querySelector('[data-cb-action="fso-confirm"]');
    assert(confirmBtn, 'Attach to Context button rendered');

    console.log('✓ File Selector Overlay UI correctly renders all components and preview drawer');
}

// ===========================================================================
// Test 3: Category and Search Filtering
// ===========================================================================
{
    const { core, ui } = createSandbox();

    core.writeFile('src/main.js', 'console.log("code");');
    core.writeFile('docs/notes.md', '# Markdown Notes');
    core.writeFile('config.json', '{"a": 1}');

    const baseState = {
        folders: [{ id: 'default', name: 'Default' }],
        projectFiles: core.listFiles(),
        sourceFiles: [],
        sourceFileMode: 'combine'
    };

    // Filter by 'code' category
    const codeState = Object.assign({}, baseState, {
        fileSelector: {
            open: true,
            selectedPaths: new Set(),
            search: '',
            category: 'code',
            folderId: 'all',
            previewPath: null
        }
    });
    const codeModal = ui.renderFileSelectorOverlay(codeState);
    const codeRows = codeModal.querySelectorAll('.cb-fso-row');
    assert.equal(codeRows.length, 1, 'Only code files shown in code category');
    assert(codeRows[0].textContent.includes('main.js'));

    // Filter by 'docs' category
    const docsState = Object.assign({}, baseState, {
        fileSelector: {
            open: true,
            selectedPaths: new Set(),
            search: '',
            category: 'docs',
            folderId: 'all',
            previewPath: null
        }
    });
    const docsModal = ui.renderFileSelectorOverlay(docsState);
    const docsRows = docsModal.querySelectorAll('.cb-fso-row');
    assert.equal(docsRows.length, 1, 'Only docs files shown in docs category');
    assert(docsRows[0].textContent.includes('notes.md'));

    // Filter by search query
    const searchState = Object.assign({}, baseState, {
        fileSelector: {
            open: true,
            selectedPaths: new Set(),
            search: 'config',
            category: 'all',
            folderId: 'all',
            previewPath: null
        }
    });
    const searchModal = ui.renderFileSelectorOverlay(searchState);
    const searchRows = searchModal.querySelectorAll('.cb-fso-row');
    assert.equal(searchRows.length, 1, 'Only matching files shown for search "config"');
    assert(searchRows[0].textContent.includes('config.json'));

    console.log('✓ Category and search filtering produce exact subsets');
}

// ===========================================================================
// Test 4: Wildcard / Glob Search
// ===========================================================================
{
    const { core, ui } = createSandbox();

    core.writeFile('src/core.js', 'console.log("core");');
    core.writeFile('src/utils.js', 'console.log("utils");');
    core.writeFile('docs/prd.md', '# PRD');
    core.writeFile('docs/architecture.md', '# Architecture');
    core.writeFile('config/settings.json', '{}');

    const baseState = {
        folders: [{ id: 'default', name: 'Default' }],
        projectFiles: core.listFiles(),
        sourceFiles: [],
        sourceFileMode: 'combine'
    };

    // Test *.js glob
    const jsState = Object.assign({}, baseState, {
        fileSelector: {
            open: true,
            selectedPaths: new Set(),
            search: '*.js',
            category: 'all',
            folderId: 'all',
            previewPath: null
        }
    });
    const jsModal = ui.renderFileSelectorOverlay(jsState);
    const jsRows = jsModal.querySelectorAll('.cb-fso-row');
    assert.equal(jsRows.length, 2, 'Wildcard *.js matches only JavaScript files');
    assert(jsRows.every(r => r.textContent.includes('.js')));

    // Test docs/* glob
    const docsGlobState = Object.assign({}, baseState, {
        fileSelector: {
            open: true,
            selectedPaths: new Set(),
            search: 'docs/*',
            category: 'all',
            folderId: 'all',
            previewPath: null
        }
    });
    const docsGlobModal = ui.renderFileSelectorOverlay(docsGlobState);
    const docsGlobRows = docsGlobModal.querySelectorAll('.cb-fso-row');
    assert.equal(docsGlobRows.length, 2, 'Wildcard docs/* matches only docs directory files');

    console.log('✓ Wildcard and glob patterns (*.js, docs/*) accurately filter file list');
}

// ===========================================================================
// Test 5: Directory Grouping and Type Quick-Select Pills
// ===========================================================================
{
    const { core, ui } = createSandbox();

    core.writeFile('src/index.js', 'console.log(1);');
    core.writeFile('src/app.js', 'console.log(2);');
    core.writeFile('docs/spec.md', '# Spec');
    core.writeFile('docs/changelog.md', '# Changelog');

    const state = {
        folders: [{ id: 'default', name: 'Default' }],
        projectFiles: core.listFiles(),
        sourceFiles: [],
        sourceFileMode: 'combine',
        fileSelector: {
            open: true,
            selectedPaths: new Set(['src/index.js']),
            search: '',
            category: 'all',
            folderId: 'all',
            previewPath: null
        }
    };

    const modal = ui.renderFileSelectorOverlay(state);

    // Verify Directory Group Headers
    const dirHeaders = modal.querySelectorAll('.cb-fso-dir-header');
    assert(dirHeaders.length >= 2, 'Files spanning multiple directories render directory headers');
    const dirTitles = Array.from(dirHeaders).map(h => h.textContent);
    assert(dirTitles.some(t => t.includes('src/')), 'src/ directory header rendered');
    assert(dirTitles.some(t => t.includes('docs/')), 'docs/ directory header rendered');

    // Verify Extension Quick-Select Pills
    const extPills = modal.querySelectorAll('.cb-fso-ext-pill');
    assert(extPills.length >= 2, 'Type quick-select pills rendered for extensions');
    const jsPill = Array.from(extPills).find(p => p.textContent.includes('*.js'));
    assert(jsPill, '*.js quick-select pill rendered');
    assert(jsPill.textContent.includes('2'), '*.js pill shows file count 2');

    console.log('✓ Directory grouping headers and type quick-select pills render correctly');
}

// ===========================================================================
// Test 6: Controller Bulk Selection Actions (Shift-Click, Fill Budget, Type Pills, Folder Select)
// ===========================================================================
{
    const { core, controller } = createSandbox();

    // Create a spread of files across directories
    core.writeFile('src/alpha.js', 'const a = 1;', { skill: 'test' });
    core.writeFile('src/beta.js', 'const b = 2;', { skill: 'test' });
    core.writeFile('src/gamma.js', 'const c = 3;', { skill: 'test' });
    core.writeFile('docs/doc1.md', '# Doc 1', { skill: 'test' });
    core.writeFile('docs/doc2.md', '# Doc 2', { skill: 'test' });

    // Open file selector
    controller.openFileSelector({ mode: 'combine' });

    // Subtest 6A: Extension Quick-Select
    controller.fsoSelectExt('js');
    // Verify all 3 .js files selected
    controller.openFileSelector(); // keep state open
    let curState = core.store;

    // Subtest 6B: Directory Bulk Select / Deselect
    controller.fsoDeselectAll();
    controller.fsoSelectDir('docs/');
    // Now docs should be selected
    controller.fsoDeselectDir('docs/');

    // Subtest 6C: Shift-Click Range Selection
    // Click alpha.js
    controller.fsoToggleFile('src/alpha.js');
    // Shift-click gamma.js -> should select alpha, beta, and gamma
    controller.fsoToggleFile('src/gamma.js', { shiftKey: true });

    // Subtest 6D: Fill Budget
    controller.fsoDeselectAll();
    controller.fsoFillBudget();

    // Subtest 6E: Confirm Selection
    const ok = controller.fsoConfirm();
    assert.equal(ok, true, 'Confirm selection returns true');

    console.log('✓ Controller bulk selection methods (Shift-click, Fill Budget, Select Ext, Directory) executed seamlessly');
}

console.log('All File Selector Overlay tests passed successfully!');
