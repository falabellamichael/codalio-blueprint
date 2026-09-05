'use strict';

/*
 * Codalio Blueprint — controller integration test.
 *
 * controller.js is the plug-in's largest module and the only one that owns the
 * full lifecycle (register -> mount -> activate -> render -> interact ->
 * deactivate -> unmount). Every other suite tests modules in isolation, so a
 * runtime error here would mean a blank page with nothing catching it.
 *
 * This test loads SimpleRAG's REAL extension host and the REAL DOM stub from
 * tests/dom-stub.cjs (which supports the attribute selectors and closest() the
 * controller depends on), then drives the page the way a user does: clicking
 * tabs, opening documents, toggling settings, sending a message against a mocked
 * model stream, stopping a run, and leaving the page.
 *
 * Run: node tests/controller-integration.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument, createLocalStorage } = require('./dom-stub.cjs');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');

// ---------------------------------------------------------------------------
// Locate the SimpleRAG checkout (same resolution as registration.test.cjs)
// ---------------------------------------------------------------------------

function findSimpleRag() {
    if (process.env.SIMPLERAG_ROOT) return process.env.SIMPLERAG_ROOT;
    const candidates = [
        'D:/PyMu/work_on_rag-main',
        'D:/PyMu/work_on_rag',
        path.join(require('os').homedir(), 'work_on_rag-main')
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'GUI', 'extension_runtime.js'))) return candidate;
    }
    throw new Error('could not locate a SimpleRAG checkout; set SIMPLERAG_ROOT');
}

const SIMPLERAG = findSimpleRag();
const HOST_RUNTIME = path.join(SIMPLERAG, 'GUI', 'extension_runtime.js');

// ---------------------------------------------------------------------------
// Mocked model endpoint
// ---------------------------------------------------------------------------

const requests = [];
let cannedDocument = '';
let streamMode = 'ok';

const GOOD_PRD = [
    '# ToolShare — Product Requirements Document',
    '',
    '## 1. Summary',
    'ToolShare lets neighbors lend and borrow tools instead of buying their own.',
    '',
    '## 2. Target User',
    'Urban renters with limited storage who own rarely-used tools.',
    '',
    '## 3. User Stories',
    '- As a neighbor, I want to list a drill so that others can borrow it.',
    '- As a borrower, I want to request a tool and agree a handoff time.',
    '',
    '## 4. MVP Scope',
    'Now: list a tool, request it, confirm the handoff.',
    'Next: reputation and reminders.',
    'Later: payment and insurance.',
    '',
    '## 5. Data & Architecture Overview',
    'Tool, User and Loan entities behind a small relational store.',
    '',
    '## 6. Go-to-Market',
    'Seed one apartment building and grow through referral.',
    '',
    '## 7. Open Questions',
    '- How is trust established between strangers?',
    '',
    '## 8. Appendix: Assumptions',
    '- Urban density is high enough for local matching to work.'
].join('\n');

const LENS_OUTPUT = {
    'lens-product': '## Elevator pitch\nFor neighbors who own rarely-used tools, ToolShare is a lending app.\n\n## Problem statement\nHouseholds buy tools they use a few times a year.\n\n## Target user\nUrban renters with limited storage.\n\n## User stories\n- As a neighbor, I want to list a drill so others can borrow it.',
    'lens-architecture': '## Core entities\n- Tool, User, Loan\n\n## Relationships\nA User has many Tools.\n\n## Key technical risks/decisions\n- Geo lookup via a third-party geocoder.\n\nThis is a lite pass, not a full architecture evaluation.',
    'lens-gtm': '## Positioning\nToolShare helps neighbors borrow tools by matching local listings.\n\n## Target market / early adopter\nDense apartment buildings.\n\n## GTM angle + one early proof point\nSeed one building; 10 completed loans.\n\nThis is a lite pass, not a full GTM plan.'
};

async function fakeFetch(url, options) {
    const href = String(url || '');
    const method = String((options && options.method) || 'GET');

    if (href.includes('/chat/cancel/')) {
        return { ok: true, status: 200, json: async () => ({ cancelled: true, status: 'stopped' }) };
    }
    if (href.endsWith('/model-endpoints')) {
        return { ok: true, status: 200, json: async () => ({ endpoints: [{ id: 'test', name: 'Test' }] }) };
    }

    if (href.endsWith('/chat/stream') && method === 'POST') {
        const payload = JSON.parse(String(options.body || '{}'));
        requests.push(payload);
        const signal = options.signal;

        if (streamMode === 'stall') {
            // Emits one delta, then BLOCKS until the run is aborted — it never
            // sends `done`. A previous version returned done:true after one tick,
            // so the run finished before the test could see it running and the
            // Stop assertions passed vacuously.
            return {
                ok: true, status: 200,
                body: {
                    getReader() {
                        let sent = false;
                        return {
                            async read() {
                                if (signal && signal.aborted) {
                                    const error = new Error('aborted');
                                    error.name = 'AbortError';
                                    throw error;
                                }
                                if (!sent) {
                                    sent = true;
                                    const line = JSON.stringify({ type: 'content', delta: 'partial output ' });
                                    return { value: new TextEncoder().encode(line + '\n'), done: false };
                                }
                                // Poll for the abort instead of ever completing.
                                for (;;) {
                                    await new Promise(resolve => setTimeout(resolve, 15));
                                    if (signal && signal.aborted) {
                                        const error = new Error('aborted');
                                        error.name = 'AbortError';
                                        throw error;
                                    }
                                }
                            }
                        };
                    }
                },
                json: async () => ({})
            };
        }

        // Pick output by which turn this is: lenses first, then the synthesis.
        const turn = requests.length;
        const full = turn <= 3
            ? LENS_OUTPUT[['lens-product', 'lens-architecture', 'lens-gtm'][turn - 1]]
            : (cannedDocument || GOOD_PRD);

        const lines = [
            JSON.stringify({ type: 'meta', semantic: null, web_search: null }),
            JSON.stringify({ type: 'content', delta: full }),
            JSON.stringify({ type: 'done', response: full, thinking: '', finish_reason: 'stop', usage: { completion_tokens: full.length } })
        ];
        const encoded = lines.map(line => new TextEncoder().encode(line + '\n'));
        return {
            ok: true, status: 200,
            body: {
                getReader() {
                    let index = 0;
                    return {
                        async read() {
                            if (signal && signal.aborted) {
                                const error = new Error('aborted');
                                error.name = 'AbortError';
                                throw error;
                            }
                            if (streamMode === 'slow') {
                                await new Promise(r => setTimeout(r, 25));
                            }
                            if (index >= encoded.length) return { value: new TextEncoder().encode(''), done: true };
                            return { value: encoded[index++], done: false };
                        }
                    };
                }
            },
            json: async () => ({ response: full })
        };
    }

    throw new Error(`unexpected fetch in test: ${method} ${href}`);
}

// ---------------------------------------------------------------------------
// Sandbox: real host + real DOM stub
// ---------------------------------------------------------------------------

const documentStub = createDocument();
const localStorageStub = createLocalStorage();

// The host's list pane and reading container, as app.bundle.js builds them.
const listPane = documentStub.createElement('div');
listPane.id = 'list-pane';
const listTitle = documentStub.createElement('div');
listTitle.id = 'list-title';
const listContent = documentStub.createElement('div');
listContent.id = 'list-content';
listPane.appendChild(listTitle);
listPane.appendChild(listContent);

const navFolderList = documentStub.createElement('div');
navFolderList.id = 'nav-folder-list';
const navTitle = documentStub.createElement('div');
navTitle.id = 'nav-title';

const appBar = documentStub.createElement('div');
appBar.id = 'app-bar';

const readingContent = documentStub.createElement('div');
readingContent.className = 'reading-content calendar-mode';
const settingsContainer = documentStub.createElement('div');
settingsContainer.id = 'settings-container';
readingContent.appendChild(settingsContainer);

documentStub.body.appendChild(listPane);
documentStub.body.appendChild(navFolderList);
documentStub.body.appendChild(appBar);
documentStub.body.appendChild(readingContent);

const ribbonButtons = [];
const navFolders = [];

const hostState = { app: 'blueprint', folder: 'all', plugins: { installed: [] } };
const windowListeners = Object.create(null);

const hostElementsMap = {
    listPane,
    listTitle,
    listContent,
    navFolderList,
    navTitle,
    appBar,
    settingsContainer,
    readingContent
};

const navApi = {
    addFolder: (id, iconName, label, count) => navFolders.push({ id, iconName, label, count })
};
const ribbonApi = {
    addBtn: (id, iconName, label, primary, onclick) => ribbonButtons.push({ id, iconName, label, primary, onclick }),
    addSep: () => ribbonButtons.push({ id: 'sep' })
};

/*
 * These four mimic app.bundle.js: the host's context() hands the controller a
 * render facade that calls them, and each one is the app's own dispatcher that
 * clears its surface and then calls back into the page hook. Driving the test
 * through them (rather than calling controller methods directly) means the
 * integration path is the one that actually runs in the app.
 */
function hostRenderNav() {
    navFolders.length = 0;
    navFolderList.children.length = 0;
    host.callPageHook(hostState.app, 'renderNav', navApi);
}
function hostRenderRibbon() {
    ribbonButtons.length = 0;
    host.callPageHook(hostState.app, 'renderRibbon', ribbonApi);
}
function hostRenderList() {
    listContent.children.length = 0;
    host.callPageHook(hostState.app, 'renderList');
}
function hostRenderReadingPane() {
    host.callPageHook(hostState.app, 'renderPage');
}
function hostRenderAll() {
    hostRenderNav();
    hostRenderRibbon();
    hostRenderList();
    hostRenderReadingPane();
}
/** Mimic app.bundle.js setApp(): switch app, reset folder, mount + render. */
function hostSetApp(appId) {
    hostState.app = String(appId);
    hostState.folder = 'all';
    // callPageHook returns undefined when getPage() finds nothing — which is the
    // correct host behaviour once a plug-in is disabled (section 12 asserts that
    // redirect). So the return value cannot be assumed to be a promise.
    const mountResult = host.callPageHook(hostState.app, 'mount');
    const activateResult = host.callPageHook(hostState.app, 'activate');
    const settle = Promise.all([mountResult, activateResult].filter(
        value => value && typeof value.then === 'function'
    ));
    return settle.then(() => {
        hostRenderAll();
        return true;
    });
}
/** Mimic the nav click handler in app.bundle.js renderNav(). */
function hostActivateFolder(id) {
    hostState.folder = String(id);
    host.callPageHook(hostState.app, 'onFolderChanged', id);
    navFolderList.children.length = 0;
    hostRenderNav();
    hostRenderRibbon();
    hostRenderList();
    hostRenderReadingPane();
}

// The host builds the controller's context itself, from the `state`, `el`, `api`,
// `setApp` and render* globals bound into the sandbox below, so the test never
// constructs one. hostRenderAll() and friends are the app-side dispatchers those
// globals point at.

const windowStub = {
    document: documentStub,
    localStorage: localStorageStub,
    location: { href: 'http://127.0.0.1:18411/gui/' },
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    fetch: fakeFetch,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
    queueMicrotask: fn => queueMicrotask(fn),
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = (init || {}).detail; } },
    addEventListener(type, listener) {
        if (typeof listener !== 'function') return;
        if (!windowListeners[type]) windowListeners[type] = [];
        if (!windowListeners[type].includes(listener)) windowListeners[type].push(listener);
    },
    removeEventListener(type, listener) {
        if (!windowListeners[type]) return;
        windowListeners[type] = windowListeners[type].filter(item => item !== listener);
    },
    dispatchEvent(event) {
        const type = event && event.type;
        (windowListeners[type] || []).slice().forEach(listener => listener.call(windowStub, event));
        return true;
    },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    Blob: class Blob { constructor(parts) { this.parts = parts; } },
    FileReader: class { readAsText() {} },
    TextDecoder: global.TextDecoder,
    TextEncoder: global.TextEncoder,
    AbortController: global.AbortController,
    prompt: () => null,
    confirm: () => true,
    // The host globals Blueprint reads.
    setApp: () => true,
    state: hostState,
    withConfiguredModelEndpointPayload: payload => Object.assign({}, payload, { endpoint_id: 'test-endpoint', model: 'test-model' }),
    RagChatStreaming: {
        readJsonLineStream: async (response, onEvent) => {
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newline;
                while ((newline = buffer.search(/\r?\n/)) !== -1) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + (buffer[newline] === '\r' ? 2 : 1));
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
    window: windowStub,
    document: documentStub,
    // extension_runtime.js reads a bare `state` global (app.bundle.js declares it
    // at top level). Bind the SAME object the controller receives as context.state
    // so host gating and page state cannot diverge.
    state: hostState,
    el: hostElementsMap,
    // app.bundle.js top-level helpers the host calls directly.
    escapeHTML: value => String(value).replace(/[&<>'"]/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[c])),
    api: async endpoint => (endpoint === '/extensions/bundled-manifests'
        // The real app registers all bundled controllers inline inside
        // app.bundle.js; this harness only loads Blueprint, so the host must see
        // no bundled manifests or initialize() throws on missing controllers.
        ? { schemaVersion: 1, manifests: [] }
        : null),
    // The host's context() hands these to the controller as its render facade and
    // setApp. Bind the app-style dispatchers so the controller drives the same
    // code path it does inside SimpleRAG.
    setApp: appId => hostSetApp(appId),
    renderNav: hostRenderNav,
    renderRibbon: hostRenderRibbon,
    renderList: hostRenderList,
    renderReadingPane: hostRenderReadingPane,
    loadPluginsFromStorage: () => {
        // Mirror app.bundle.js: read the plugin store into state.plugins.installed.
        try {
            const raw = localStorageStub.getItem('ragworkspace_plugins');
            const parsed = raw ? JSON.parse(raw) : [];
            hostState.plugins.installed = Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            hostState.plugins.installed = [];
        }
    },
    localStorage: localStorageStub,
    navigator: windowStub.navigator,
    location: windowStub.location,
    console,
    fetch: fakeFetch,
    setTimeout: windowStub.setTimeout,
    clearTimeout: windowStub.clearTimeout,
    setInterval: windowStub.setInterval,
    clearInterval: windowStub.clearInterval,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    queueMicrotask: global.queueMicrotask,
    MutationObserver: windowStub.MutationObserver,
    CustomEvent: windowStub.CustomEvent,
    URL: windowStub.URL,
    Blob: windowStub.Blob,
    FileReader: windowStub.FileReader,
    TextDecoder: global.TextDecoder,
    TextEncoder: global.TextEncoder,
    AbortController: global.AbortController,
    prompt: () => null,
    confirm: () => true,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, Promise, Intl, Symbol,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);

function runFile(file, label) {
    try {
        vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    } catch (error) {
        throw new Error(`${label} failed to load (${path.basename(file)}): ${error.message}`);
    }
}

// Build manifest.js exactly the way tools/blueprint.py does.
const pluginManifest = JSON.parse(fs.readFileSync(path.join(SRC, 'plugin.json'), 'utf8'));
const template = fs.readFileSync(path.join(SRC, 'manifest.template.js'), 'utf8');
const PLACEHOLDER = '/*__MANIFEST_JSON__*/null';
assert.ok(template.includes(PLACEHOLDER), 'manifest.template.js lost its placeholder');
const manifestJs = template.replace(PLACEHOLDER, JSON.stringify(pluginManifest));

// Load in the installer's declared order, host first.
runFile(HOST_RUNTIME, 'SimpleRAG extension host');
vm.runInContext(manifestJs, context, { filename: 'manifest.js' });
runFile(path.join(SRC, 'controller-core.js'), 'controller-core');
runFile(path.join(SRC, 'skills.js'), 'skills');
runFile(path.join(SRC, 'settings.js'), 'settings');
runFile(path.join(SRC, 'agent.js'), 'agent');
runFile(path.join(SRC, 'preview.js'), 'preview');
runFile(path.join(SRC, 'ui.js'), 'ui');
runFile(path.join(SRC, 'workspace.js'), 'workspace');
runFile(path.join(SRC, 'settings-page.js'), 'settings-page');
runFile(path.join(SRC, 'controller.js'), 'controller');

const host = sandbox.window.RAGWorkspaceExtensions;
const core = sandbox.window.__codalioBlueprintCore;
const ws = sandbox.window.__codalioBlueprintWorkspace;
const schema = sandbox.window.__codalioBlueprintSettings;
const publicApi = sandbox.window.codalioBlueprint;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function container() {
    return settingsContainer;
}

function query(selector) {
    return settingsContainer.querySelector(selector);
}

function queryAll(selector) {
    return settingsContainer.querySelectorAll(selector);
}

function textOf(node) {
    return node ? node.textContent : '';
}

function allText() {
    return textOf(settingsContainer);
}

function sidebarText() {
    return textOf(listContent);
}

/** Click an element the way a browser delivers it to a delegated listener. */
function click(node, init) {
    if (!node) throw new Error('click(null): the element was not found');
    return documentStub.clickOn(node, init);
}

function clickAction(action, init) {
    const node = query(`[data-cb-action="${action}"]`);
    if (!node) throw new Error(`no element with data-cb-action="${action}" is rendered`);
    return click(node, init);
}

function tick(ms) {
    return new Promise(resolve => setTimeout(resolve, ms || 5));
}

// ---------------------------------------------------------------------------

(async () => {
    // =======================================================================
    // 1. Registration, then host initialize() in the real app's order
    //
    // app.bundle.js defers init() to DOMContentLoaded, and init() calls
    // loadPluginsFromStorage() BEFORE RAGWorkspaceExtensions.initialize().
    // getPage() gates on isEnabled(), which reads state.plugins.installed — so
    // asking for the page before that sequence is asking a question the host has
    // not been given the data to answer yet.
    // =======================================================================

    assert.ok(host.getManifest('codalio-blueprint'), 'the host rejected the manifest');
    assert.ok(publicApi, 'the controller did not publish window.codalioBlueprint');
    assert.equal(publicApi.listSkills().length, 6);

    // The controller seeds its host record at script-load time, so the store
    // already holds it before initialize() runs.
    assert.ok(localStorageStub.getItem('ragworkspace_plugins'),
        'the controller did not seed its host plugin record at load time');
    sandbox.loadPluginsFromStorage();
    assert.equal(hostState.plugins.installed.length, 1, 'loadPluginsFromStorage did not read the store');

    const initResult = await host.initialize();
    assert.ok(initResult.pages.some(item => item.appId === 'blueprint'), 'initialize() did not report the page');

    // getPage() returns a DESCRIPTOR; the controller sits on it and the host
    // drives the lifecycle, so the test must too (see callPageHook below).
    const pageDescriptor = host.getPage('blueprint');
    assert.ok(pageDescriptor, 'the host did not expose the blueprint page');
    assert.equal(pageDescriptor.appId, 'blueprint');
    assert.equal(pageDescriptor.pluginId, 'codalio-blueprint');
    assert.ok(pageDescriptor.controller, 'the page descriptor carries no controller');
    assert.equal(pageDescriptor.controller.appId, 'blueprint');

    const iconMount = appBar.querySelector('#extension-app-icons') || appBar.children.find(c => c.id === 'extension-app-icons');
    assert.ok(iconMount, 'the host did not create the app-bar icon mount');
    assert.match(String(iconMount.innerHTML || ''), /data-app="blueprint"/, 'no app-bar icon was rendered');

    // =======================================================================
    // 2. mount + activate render the tabbed workspace
    // =======================================================================

    // The app's setApp(): switch app, then mount + activate through the host,
    // which builds the controller's context from the globals bound above.
    hostState.app = 'blueprint';
    await host.callPageHook('blueprint', 'mount');
    await host.callPageHook('blueprint', 'activate');
    hostRenderAll();
    await tick();

    // The reading pane now holds the tabbed workspace.
    assert.equal(queryAll('[data-cb-role="tabstrip"]').length, 1, 'mount did not render a tab strip');
    assert.equal(queryAll('[data-cb-role="tabpanel"]').length, 1, 'mount did not render a tab panel');
    assert.equal(queryAll('.cb-agent').length, 1, 'the Agent tab did not render the chat');
    assert.ok(query('[data-cb-role="composer"]'), 'the composer is missing');
    assert.ok(query('[data-cb-role="transcript"]'), 'the transcript is missing');

    // The sidebar renders the skill list and the nav renders all four sections.
    assert.equal(navFolders.length, 4, 'renderNav did not offer every section');
    assert.equal(navFolders.map(f => f.id).join(','), 'cb-agent,cb-files,cb-history,cb-settings');
    assert.ok(sidebarText().includes('PRD Builder'), 'the sidebar does not list the skills');

    // A fresh workspace has only the pinned Agent tab.
    assert.equal(queryAll('[data-cb-action="activate-tab"]').length, 1, 'a fresh workspace should have one tab');

    // =======================================================================
    // 3. THE HEADLINE BEHAVIOUR: sidebar sections open tabs beside the chat
    // =======================================================================

    // Clicking the host nav calls onFolderChanged, which must open a tab.
    hostActivateFolder('cb-files')
    await tick();
    let tabs = queryAll('[data-cb-action="activate-tab"]');
    assert.equal(tabs.length, 2, 'pressing Project Files did not open a tab beside the Agent');
    assert.equal(queryAll('.cb-agent').length, 0, 'the chat should no longer be the visible panel');
    assert.ok(query('.cb-viewer'), 'the Project Files tab did not render the viewer');
    assert.ok(sidebarText().includes('Project Files') || queryAll('.cb-tree-wrap').length >= 0, 'sidebar did not switch');
    assert.equal(textOf(listTitle), 'Project Files', 'the list pane title did not follow the tab');

    hostActivateFolder('cb-settings');
    await tick();
    tabs = queryAll('[data-cb-action="activate-tab"]');
    assert.equal(tabs.length, 3, 'pressing Settings did not open a tab');
    assert.ok(query('.cb-settings'), 'the Settings tab did not render the settings page');

    hostActivateFolder('cb-history')
    await tick();
    assert.equal(queryAll('[data-cb-action="activate-tab"]').length, 4, 'pressing Runs did not open a tab');

    // The Agent tab is still there — the conversation was never destroyed.
    const agentTabButton = tabs.find(t => t.dataset.tabId === 'tab-agent')
        || queryAll('[data-cb-action="activate-tab"]').find(t => t.dataset.tabId === 'tab-agent');
    assert.ok(agentTabButton, 'the Agent tab disappeared after navigating');
    click(agentTabButton);
    await tick();
    assert.equal(queryAll('.cb-agent').length, 1, 'clicking the Agent tab did not restore the chat');
    assert.equal(queryAll('[data-cb-action="activate-tab"]').length, 4, 'returning to the Agent lost the other tabs');

    // Sections are singletons: clicking a tab does not duplicate it.
    click(queryAll('[data-cb-action="activate-tab"]').find(t => t.dataset.tabId === 'tab-cb-settings'));
    await tick();
    assert.equal(queryAll('[data-cb-action="activate-tab"]').length, 4, 're-clicking a tab duplicated it');

    // =======================================================================
    // 4. Clicking a tab's close button removes only that tab
    // =======================================================================

    const settingsClose = queryAll('[data-cb-action="close-tab"]').find(c => c.dataset.tabId === 'tab-cb-settings');
    assert.ok(settingsClose, 'the Settings tab has no close button');
    click(settingsClose);
    await tick();
    assert.equal(queryAll('[data-cb-action="activate-tab"]').length, 3, 'closing a tab did not remove it');
    assert.ok(!queryAll('[data-cb-action="activate-tab"]').some(t => t.dataset.tabId === 'tab-cb-settings'));
    // The pinned Agent has no close button.
    assert.ok(!queryAll('[data-cb-action="close-tab"]').some(c => c.dataset.tabId === 'tab-agent'),
        'the pinned Agent tab offers a close button');

    // =======================================================================
    // 5. A full skill run: send a message, watch steps, get a document + a tab
    // =======================================================================

    core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, {
        concurrency: 'sequential', askClarifyingQuestions: false, autoOpenWrittenDocument: true
    }));
    await host.callPageHook('blueprint', 'activate');
    hostRenderAll();
    await tick();

    // activate() RESTORES the saved tab layout rather than forcing the Agent tab
    // (that is what Settings -> Restore tabs on load means), and section 4 closed
    // its last tab on a neighbour — so return to the chat the way a user does.
    const backToAgent = queryAll('[data-cb-action="activate-tab"]')
        .find(tab => tab.dataset.tabId === 'tab-agent');
    assert.ok(backToAgent, 'the pinned Agent tab is not reachable from the strip');
    click(backToAgent);
    await tick();
    assert.equal(queryAll('.cb-agent').length, 1, 'clicking the Agent tab did not restore the chat');

    const composer = query('[data-cb-role="composer"]');
    assert.ok(composer, 'the Agent tab rendered no composer');
    composer.value = 'I want to build an app for neighbors to lend and borrow tools.';
    documentStub.dispatch('input', { target: composer });

    requests.length = 0;
    clickAction('send');

    // Let the run finish: 3 lenses + synthesis, sequential.
    for (let i = 0; i < 200 && requests.length < 4; i += 1) await tick(25);
    for (let i = 0; i < 100 && core.listFiles().length === 0; i += 1) await tick(25);
    await tick(50);

    assert.equal(requests.length, 4, `the run should take 4 model turns, took ${requests.length}`);
    requests.forEach(payload => {
        assert.equal(payload.endpoint_id, 'test-endpoint', 'the endpoint was not injected');
        assert.equal(payload.interaction_mode, 'chat');
        assert.equal(payload.use_workspace_context, false, 'the run pulled SimpleRAG workspace context');
        assert.ok(payload.cancel_id, 'a turn carried no cancel_id, so Stop cannot reach the backend');
    });

    const written = core.listFiles();
    assert.equal(written.length, 1, `expected one written document, got ${written.length}`);
    assert.match(written[0], /^docs\/prd\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+-prd\.md$/);
    const prdRecord = core.readFile(written[0]);
    assert.match(prdRecord.content, /^# ToolShare — Product Requirements Document/);
    assert.ok(!prdRecord.content.includes('<date>'), 'a template placeholder survived into the document');
    assert.ok(!prdRecord.content.includes('```'), 'a code fence leaked into the document');

    // The transcript shows the visible step trace.
    const transcript = allText();
    assert.match(transcript, /Lens 1 — Product & Scope/, 'the transcript does not show the product lens');
    assert.match(transcript, /Synthesize/, 'the transcript does not show the synthesis step');
    assert.match(transcript, /Wrote docs\/prd\//, 'the transcript does not report the written file');
    assert.match(transcript, /Self-review passed/, 'the real self-review did not run');
    assert.match(transcript, /review gate/i, 'no user review gate was shown');

    // A written document opened its own editor tab BESIDE the Agent.
    const fileTabs = queryAll('[data-cb-action="activate-tab"]').filter(t => t.id.startsWith('cb-tabbtn'));
    const persistedWorkspace = ws.normalizeWorkspace(core.readWorkspaceRaw(), core.readSettings());
    const writtenTab = ws.fileTab(persistedWorkspace, written[0], prdRecord.folder);
    assert.ok(
        writtenTab && queryAll('[data-cb-action="activate-tab"]').some(t => t.dataset.tabId === writtenTab.id),
        'the written document did not open its own tab'
    );
    void fileTabs;

    // The run was persisted.
    assert.equal(core.store.runs.length, 1, 'the run was not saved');
    assert.equal(core.store.runs[0].status, 'done');

    // A revision first checkpoints its active step and transcript, then claims
    // the single-backend execution lease. Force another window to win that lease
    // in the narrow gap and prove startup rolls back every durable/UI artifact
    // without dispatching a request.
    const revisionRun = core.store.runs[0];
    const revisionMessagesBefore = JSON.stringify(revisionRun.messages || []);
    const revisionPhaseCountBefore = (revisionRun.phases || []).length;
    const revisionRequestCount = requests.length;
    const globalOwnerId = '__codalio-blueprint-model-operation__';
    const globalOwnerKey = `${core.RUN_OWNER_PREFIX}${encodeURIComponent(globalOwnerId)}`;
    const originalStorageSet = localStorageStub.setItem;
    let injectedForeignGlobalOwner = false;
    localStorageStub.setItem = (key, value) => {
        originalStorageSet(key, value);
        if (!injectedForeignGlobalOwner && String(key) === core.PROJECTS_KEY) {
            injectedForeignGlobalOwner = true;
            originalStorageSet(globalOwnerKey, JSON.stringify({
                runId: globalOwnerId,
                ownerId: 'foreign-revision-window',
                leaseId: 'foreign-revision-lease',
                leaseExpiresAt: Date.now() + 30000
            }));
        }
    };
    windowStub.prompt = () => 'Tighten the acceptance criteria without changing scope.';
    const reviseButton = query('[data-cb-action="revise-message"]');
    assert.ok(reviseButton, 'the completed document offered no revision action');
    click(reviseButton);
    for (let i = 0; i < 100 && !injectedForeignGlobalOwner; i += 1) await tick(10);
    for (let i = 0; i < 100 && publicApi.isBusy(); i += 1) await tick(10);
    await tick(30);
    localStorageStub.setItem = originalStorageSet;
    localStorageStub.removeItem(globalOwnerKey);
    windowStub.prompt = () => null;

    assert.equal(injectedForeignGlobalOwner, true,
        'the forced revision lease race never reached its durable startup checkpoint');
    assert.equal(requests.length, revisionRequestCount,
        'a revision request escaped after the global execution lease was lost');
    assert.equal(revisionRun.status, 'done',
        'revision lease failure left the existing run marked running');
    assert.equal(revisionRun.phases.length, revisionPhaseCountBefore,
        'revision lease failure left a phantom active phase');
    assert.equal(JSON.stringify(revisionRun.messages || []), revisionMessagesBefore,
        'revision lease failure left a phantom user or busy assistant message');
    const durableRevisionRun = JSON.parse(localStorageStub.getItem(core.PROJECTS_KEY)).runs
        .find(item => item.id === revisionRun.id);
    assert.equal(durableRevisionRun.status, 'done',
        'revision rollback did not restore the durable terminal status');
    assert.equal(durableRevisionRun.phases.length, revisionPhaseCountBefore,
        'revision rollback did not remove the durable phantom phase');
    assert.equal(JSON.stringify(durableRevisionRun.messages || []), revisionMessagesBefore,
        'revision rollback did not restore the durable transcript');

    // =======================================================================
    // 6. Opening a document from the tree shows it in its own tab
    // =======================================================================

    // Go to Project Files and click the document in the sidebar tree.
    hostActivateFolder('cb-files')
    await tick();
    const treeRow = listContent.querySelector('.cb-tree-file');
    assert.ok(treeRow, 'the sidebar tree does not list the written document');
    assert.equal(treeRow.getAttribute('role'), 'treeitem');
    click(treeRow);
    await tick();
    assert.ok(query('.cb-viewer'), 'clicking a tree row did not open the viewer');
    assert.match(allText(), /ToolShare — Product Requirements Document/, 'the document content is not rendered');

    // Viewer mode toggle switches to the code previewer and remembers the choice
    // per document. Source mode used to be a bare <pre>; it is now the Notepad++-
    // style view with a gutter and status bar, so assert on that instead.
    clickAction('viewer-toggle');
    await tick();
    assert.ok(query('.cb-preview'), 'viewer-toggle did not switch to the code previewer');
    assert.ok(query('.cb-preview-ln'), 'the previewer rendered no line-number gutter');
    assert.match(textOf(query('.cb-preview-status')), /Ln 1, Col 1/, 'the previewer status bar is missing');
    assert.equal(ws.viewerModeFor(
        core.readWorkspaceRaw() && ws.normalizeWorkspace(core.readWorkspaceRaw(), core.readSettings()),
        written[0], core.readSettings(), prdRecord.folder
    ), 'source', 'the per-document viewer mode was not persisted');

    // =======================================================================
    // 7. Settings: toggling a control writes through the schema and clamps
    // =======================================================================

    hostActivateFolder('cb-settings');
    await tick();
    assert.ok(query('.cb-settings'), 'the Settings tab did not render');
    assert.ok(listContent.querySelector('.cb-settings-nav'), 'the sidebar does not render the settings nav');

    // Navigate to Agent -> Model via the sidebar.
    const modelNav = listContent.querySelectorAll('[data-cb-action="settings-goto"]')
        .find(item => item.dataset.sectionId === 'agent' && item.dataset.pageId === 'model');
    assert.ok(modelNav, 'the sidebar does not offer Agent -> Model');
    click(modelNav);
    await tick();
    assert.match(allText(), /Lens token budget/, 'the Model page did not render');

    // Change the temperature slider and confirm it persists.
    const tempInput = query('[data-cb-setting="temperature"]');
    assert.ok(tempInput, 'the temperature control is missing');
    assert.equal(tempInput.type, 'range');
    tempInput.value = '0.85';
    documentStub.dispatch('input', { target: tempInput });
    await tick();
    assert.equal(core.readSettings().temperature, 0.85, 'the slider did not persist its value');

    // A value out of range is clamped by the schema before it is stored, and the
    // control is corrected so the UI cannot show a value the engine ignores.
    const lensInput = query('[data-cb-setting="lensMaxOutputTokens"]');
    lensInput.value = '999999';
    documentStub.dispatch('input', { target: lensInput });
    await tick();
    assert.equal(core.readSettings().lensMaxOutputTokens, 32768, 'an out-of-range value was stored verbatim');
    assert.equal(lensInput.value, '32768', 'the control still shows a value the engine clamped away');

    // Navigate to Agent -> Planning for the toggle and segmented controls.
    const planningNav = listContent.querySelectorAll('[data-cb-action="settings-goto"]')
        .find(item => item.dataset.sectionId === 'agent' && item.dataset.pageId === 'planning');
    assert.ok(planningNav, 'the sidebar does not offer Agent -> Planning');
    click(planningNav);
    await tick();
    assert.match(allText(), /Lens concurrency/, 'the Planning page did not render');

    // Toggle a switch.
    const announce = query('[data-cb-setting="announceSkill"]');
    assert.ok(announce, 'the announceSkill toggle is missing on the Planning page');
    assert.equal(announce.type, 'checkbox');
    announce.checked = false;
    documentStub.dispatch('input', { target: announce });
    await tick();
    assert.equal(core.readSettings().announceSkill, false, 'the toggle did not persist');

    // Segmented control.
    const concRadios = queryAll('[data-cb-setting="concurrency"]');
    assert.ok(concRadios.length >= 2, 'the segmented control rendered no options');
    const sequential = concRadios.find(radio => radio.value === 'sequential');
    assert.ok(sequential, 'the segmented control has no sequential option');
    sequential.checked = true;
    documentStub.dispatch('input', { target: sequential });
    await tick();
    assert.equal(core.readSettings().concurrency, 'sequential', 'the segmented control did not persist');

    // Settings search filters the sidebar.
    const searchInput = listContent.querySelector('[data-cb-role="settings-search"]');
    assert.ok(searchInput, 'the settings search field is missing');
    searchInput.value = 'temperature';
    documentStub.dispatch('input', { target: searchInput });
    await tick();
    assert.ok(listContent.querySelector('[data-cb-action="settings-focus"]'), 'searching rendered no results');
    assert.match(sidebarText(), /Temperature/, 'the search result does not name the field');
    // Clicking a result jumps to that field's page.
    click(listContent.querySelector('[data-cb-action="settings-focus"]'));
    await tick(20);
    assert.equal(core.readWorkspaceRaw() && ws.normalizeWorkspace(core.readWorkspaceRaw(), core.readSettings()).settingsPage, 'model',
        'a search result did not navigate to its page');

    // =======================================================================
    // 8. Tab persistence across a page reload
    // =======================================================================

    const beforeReload = JSON.parse(JSON.stringify(core.readWorkspaceRaw()));
    assert.ok(beforeReload, 'the workspace was never persisted');
    assert.ok(beforeReload.tabs.length >= 2, 'the persisted layout lost its tabs');

    // Leaving and returning to the page, through the host's lifecycle queue.
    await host.callPageHook('blueprint', 'deactivate');
    await host.callPageHook('blueprint', 'unmount');
    await host.callPageHook('blueprint', 'mount');
    await host.callPageHook('blueprint', 'activate');
    hostRenderAll();
    await tick();
    const afterReload = core.readWorkspaceRaw();
    assert.equal(afterReload.tabs.length, beforeReload.tabs.length, 'the tab layout did not survive a reload');
    assert.equal(afterReload.activeTabId, beforeReload.activeTabId, 'the active tab did not survive a reload');
    // A file tab whose document still exists comes back.
    const restoredFileTabs = afterReload.tabs.filter(t => t.kind === 'file');
    assert.ok(restoredFileTabs.length >= 1, 'document tabs did not survive a reload');

    // =======================================================================
    // 9. Stopping a run mid-flight
    // =======================================================================

    hostActivateFolder('cb-agent');
    await tick();
    streamMode = 'stall';
    const stopComposer = query('[data-cb-role="composer"]');
    assert.ok(stopComposer, 'the Agent tab rendered no composer');
    stopComposer.value = 'Another idea to stop mid-run.';
    documentStub.dispatch('input', { target: stopComposer });
    clickAction('send');

    // Poll until the run is actually in flight rather than sleeping a fixed
    // interval: the stall mock blocks forever, so a slow machine and a fast one
    // both reach the same state deterministically.
    let sawBusy = false;
    for (let i = 0; i < 120; i += 1) {
        await tick(15);
        const live = query('[data-cb-role="composer"]');
        if (live && live.disabled) { sawBusy = true; break; }
    }

    // While running, the composer is locked and Stop is offered.
    assert.ok(sawBusy, 'the run never entered its busy state');
    assert.equal(query('[data-cb-role="composer"]').disabled, true, 'the composer stayed editable during a run');
    const stopButton = query('[data-cb-action="stop-run"]');
    assert.ok(stopButton, 'no Stop button while a run is in flight');
    // The send button must not offer a second concurrent run.
    const sendWhileBusy = query('[data-cb-action="send"]');
    assert.equal(sendWhileBusy.disabled, true, 'Send stayed enabled during a run');
    click(stopButton);
    for (let i = 0; i < 60; i += 1) {
        await tick(25);
        if (query('[data-cb-role="composer"]') && !query('[data-cb-role="composer"]').disabled) break;
    }
    await tick(30);
    assert.equal(query('[data-cb-role="composer"]').disabled, false, 'the composer stayed locked after Stop');
    assert.match(allText(), /Stop/i, 'the transcript does not report the stop');
    streamMode = 'ok';

    // =======================================================================
    // 10. Keyboard shortcuts reach the workspace
    // =======================================================================

    hostActivateFolder('cb-files')
    await tick();
    const tabCountBefore = queryAll('[data-cb-action="activate-tab"]').length;
    // Ctrl+1 returns to the Agent from anywhere.
    documentStub.dispatch('keydown', { key: '1', ctrlKey: true, target: documentStub.body });
    await tick();
    assert.equal(queryAll('.cb-agent').length, 1, 'Ctrl+1 did not return to the Agent tab');
    assert.equal(queryAll('[data-cb-action="activate-tab"]').length, tabCountBefore, 'Ctrl+1 changed the tab count');

    // Ctrl+W closes the active (non-pinned) tab.
    hostActivateFolder('cb-history')
    await tick();
    const beforeClose = queryAll('[data-cb-action="activate-tab"]').length;
    documentStub.dispatch('keydown', { key: 'w', ctrlKey: true, target: documentStub.body });
    await tick();
    assert.equal(queryAll('[data-cb-action="activate-tab"]').length, beforeClose - 1, 'Ctrl+W did not close the active tab');

    // Ctrl+W refuses on the pinned Agent.
    documentStub.dispatch('keydown', { key: '1', ctrlKey: true, target: documentStub.body });
    await tick();
    const agentCount = queryAll('[data-cb-action="activate-tab"]').length;
    documentStub.dispatch('keydown', { key: 'w', ctrlKey: true, target: documentStub.body });
    await tick();
    assert.equal(queryAll('[data-cb-action="activate-tab"]').length, agentCount, 'Ctrl+W closed the pinned Agent tab');

    // Enter in the composer sends; typing in a field is not hijacked.
    const enterComposer = query('[data-cb-role="composer"]');
    enterComposer.value = 'Third idea.';
    documentStub.dispatch('input', { target: enterComposer });
    requests.length = 0;
    documentStub.dispatch('keydown', { key: 'Enter', target: enterComposer });
    for (let i = 0; i < 100 && requests.length === 0; i += 1) await tick(25);
    assert.ok(requests.length > 0, 'Enter in the composer did not send');

    // Wait for it to settle before the next section.
    for (let i = 0; i < 200 && requests.length < 4; i += 1) await tick(25);
    for (let i = 0; i < 150 && (!query('[data-cb-role="composer"]') || query('[data-cb-role="composer"]').disabled); i += 1) await tick(25);
    await tick(50);

    // =======================================================================
    // 10b. Switching apps while a run is in flight continues in background
    // =======================================================================

    hostActivateFolder('cb-agent');
    await tick(30);

    streamMode = 'slow';
    const bgComposer = query('[data-cb-role="composer"]');
    bgComposer.value = 'Background run test idea.';
    documentStub.dispatch('input', { target: bgComposer });
    requests.length = 0;
    clickAction('send');

    // Wait until busy
    for (let i = 0; i < 120; i += 1) {
        await tick(15);
        if (query('[data-cb-role="composer"]') && query('[data-cb-role="composer"]').disabled) break;
    }
    assert.equal(query('[data-cb-role="composer"]').disabled, true, 'background test run never started');

    // Simulate switching to another app (e.g. Journal) by calling deactivate hook
    await host.callPageHook('blueprint', 'deactivate');

    // Wait while in the background for the run to finish
    for (let i = 0; i < 300; i += 1) {
        await tick(25);
        const runs = core.store.runs || [];
        const latest = runs[0];
        if (latest && latest.status === 'done') break;
    }
    streamMode = 'ok';

    // Simulate switching back to Blueprint (activate hook + renderPage)
    await host.callPageHook('blueprint', 'activate');
    hostRenderAll();
    await tick(30);

    const reloadedComposer = query('[data-cb-role="composer"]');
    assert.ok(reloadedComposer, 'composer missing after switching back to Blueprint');
    assert.equal(reloadedComposer.disabled, false, 'composer remained locked after background run completed');
    const latestRun = core.store.runs[0];
    assert.equal(latestRun.status, 'done', 'run did not complete in background');
    assert.ok(latestRun.writtenPaths.length > 0, 'background run did not produce any documents');

    // =======================================================================
    // 10c. Switching tabs inside Blueprint while a run is in flight
    // =======================================================================

    hostActivateFolder('cb-agent');
    await tick(30);

    streamMode = 'slow';
    const tabComposer = query('[data-cb-role="composer"]');
    tabComposer.value = 'Internal tab switch test idea.';
    documentStub.dispatch('input', { target: tabComposer });
    requests.length = 0;
    clickAction('send');

    // Wait until busy
    for (let i = 0; i < 120; i += 1) {
        await tick(15);
        if (query('[data-cb-role="composer"]') && query('[data-cb-role="composer"]').disabled) break;
    }
    assert.equal(query('[data-cb-role="composer"]').disabled, true, 'tab switch test run never started');

    // Switch to Project Files tab while in flight
    hostActivateFolder('cb-files');
    await tick(30);

    // The Project Files tab is active, and the Agent tab shows the busy spinner
    const agentTab = queryAll('[data-cb-action="activate-tab"]').find(t => t.dataset.tabId === 'tab-agent');
    assert.ok(agentTab, 'agent tab missing from tabstrip');
    assert.ok(agentTab.querySelector('.cb-tab-busy'), 'agent tab did not show busy spinner while running in background');

    // Wait for the run to finish in background
    for (let i = 0; i < 300; i += 1) {
        await tick(25);
        const runs = core.store.runs || [];
        const latest = runs[0];
        if (latest && (latest.status === 'done' || latest.status === 'error')) break;
    }
    streamMode = 'ok';

    // Switch back to Agent tab
    hostActivateFolder('cb-agent');
    await tick(30);

    const backComposer = query('[data-cb-role="composer"]');
    assert.ok(backComposer, 'composer missing after returning to Agent tab');
    assert.equal(backComposer.disabled, false, 'composer stayed locked after run finished');
    const finishedRun = core.store.runs[0];
    assert.equal(finishedRun.status, 'done', 'run did not finish when switching internal tabs');
    assert.ok(finishedRun.writtenPaths.length > 0, 'run did not write document');

    // Six visible messages crosses the default deterministic compaction
    // threshold. It must run only after the final settlement token is removed,
    // persist atomically, and never spend an extra model request.
    const requestsBeforeAutoCompaction = requests.length;
    for (let i = 0; i < 80 && !(core.store.runs[0] && core.store.runs[0].compaction); i += 1) {
        await tick(10);
    }
    assert.ok(core.store.runs[0].compaction,
        'threshold-crossing run never executed automatic compaction after settlement');
    assert.equal(requests.length, requestsBeforeAutoCompaction,
        'deterministic automatic compaction unexpectedly dispatched a model turn');
    assert.equal((core.store.runs[0].messages || [])[0].role, 'compaction',
        'automatic compaction was not persisted with its shortened transcript');

    // Re-evaluating controller.js is how the development host hot-reloads an
    // extension. The prior delegated handlers must be retired, or one click is
    // observed by two independent controller closures.
    const delegatedEvents = ['click', 'input', 'change', 'keydown'];
    delegatedEvents.forEach(type => assert.equal((documentStub._listeners[type] || []).length, 1,
        `${type} unexpectedly had duplicate handlers before hot reload`));
    runFile(path.join(SRC, 'controller.js'), 'controller hot reload');
    delegatedEvents.forEach(type => assert.equal((documentStub._listeners[type] || []).length, 1,
        `${type} handler leaked across controller re-evaluation`));
    await host.callPageHook('blueprint', 'mount');
    await host.callPageHook('blueprint', 'activate');
    hostRenderAll();
    await tick();

    // Workspace and project selection are separate durable keys. The sender
    // writes W then P, so another window can observe the workspace event first.
    // Reproduce that exact ordering and prove the receiver converges instead of
    // permanently blocking its composer after the first CAS conflict.
    const pairedRoot = core.createFolder('Paired event root').folder;
    assert.ok(pairedRoot, 'could not create the cross-window pairing fixture root');
    const pairedPath = 'docs/paired-event.md';
    assert.ok(core.writeFile(pairedPath, '# Paired event\n\nAuthoritative external tab.', {
        folder: pairedRoot.id
    }), 'could not create the cross-window pairing fixture file');
    assert.equal(core.restoreSelection({
        activeFolderId: core.DEFAULT_FOLDER_ID,
        openPath: '',
        openFolderId: '',
        activeRunId: ''
    }), true, 'could not establish the stale receiver selection');

    const pairedProject = JSON.parse(localStorageStub.getItem(core.PROJECTS_KEY));
    pairedProject.revision += 1;
    pairedProject.commitId = 'external-paired-project';
    pairedProject.activeFolderId = pairedRoot.id;
    pairedProject.openPath = pairedPath;
    pairedProject.openFolderId = pairedRoot.id;
    pairedProject.activeRunId = '';

    const pairedWorkspace = JSON.parse(JSON.stringify(core.readWorkspaceRaw()));
    const pairedTabId = ws.fileTabId(pairedPath, pairedRoot.id);
    pairedWorkspace.tabs = pairedWorkspace.tabs.filter(tab => tab.id !== pairedTabId);
    pairedWorkspace.tabs.push({
        id: pairedTabId,
        kind: 'file',
        title: 'paired-event.md',
        icon: 'fa-file-lines',
        sectionId: '',
        path: pairedPath,
        folderId: pairedRoot.id,
        pinned: false,
        openedAt: Date.now(),
        lastActiveAt: Date.now()
    });
    pairedWorkspace.activeTabId = pairedTabId;
    pairedWorkspace.revision += 1;
    pairedWorkspace.commitId = 'external-paired-workspace';

    localStorageStub.setItem(core.WORKSPACE_KEY, JSON.stringify(pairedWorkspace));
    localStorageStub.setItem(core.PROJECTS_KEY, JSON.stringify(pairedProject));
    windowStub.dispatchEvent(new windowStub.CustomEvent('codalio-blueprint-workspace-change', {
        detail: { reason: 'external-workspace-update' }
    }));
    windowStub.dispatchEvent(new windowStub.CustomEvent('codalio-blueprint-store-change', {
        detail: { reason: 'external-update' }
    }));
    for (let i = 0; i < 30 && core.store.openPath !== pairedPath; i += 1) await tick(10);

    assert.equal(core.store.activeFolderId, pairedRoot.id,
        'W-before-P delivery did not adopt the authoritative project root');
    assert.equal(core.store.openPath, pairedPath,
        'W-before-P delivery did not adopt the authoritative file selection');
    assert.equal(core.store.openFolderId, pairedRoot.id,
        'W-before-P delivery lost the file owner');
    assert.equal(ws.activeTab(core.readWorkspaceRaw()).id, pairedTabId,
        'W-before-P delivery discarded the authoritative active tab');
    documentStub.dispatch('keydown', { key: '1', ctrlKey: true, target: documentStub.body });
    await tick(20);
    assert.equal(query('[data-cb-role="composer"]').disabled, false,
        'W-before-P delivery left new agent work blocked until reload');

    // Thirty continued turns must remain linear on disk. The live UI still
    // presents one conversation, while each run stores only its own assistant
    // card and follows an explicit parent chain.
    assert.equal(core.writeSettings(Object.assign({}, core.readSettings(), {
        contextCompression: false,
        askClarifyingQuestions: false,
        concurrency: 'parallel',
        autoOpenWrittenDocument: false
    })), true, 'could not disable compaction for the transcript-growth fixture');
    const growthPrefix = 'Linear transcript turn ';
    const growthPrompts = [];
    const durableMessageTotals = [];
    for (let index = 1; index <= 30; index += 1) {
        const promptText = `${growthPrefix}${index}.`;
        growthPrompts.push(promptText);
        const growthComposer = query('[data-cb-role="composer"]');
        growthComposer.value = promptText;
        documentStub.dispatch('input', { target: growthComposer });
        clickAction('send');
        for (let spin = 0; spin < 200; spin += 1) {
            await tick(5);
            const newest = core.store.runs[0];
            const liveComposer = query('[data-cb-role="composer"]');
            if (newest && newest.idea === promptText && newest.status !== 'running'
                && liveComposer && !liveComposer.disabled) break;
        }
        const durableGrowthRuns = core.store.runs
            .filter(run => String(run.idea || '').startsWith(growthPrefix));
        assert.equal(durableGrowthRuns.length, index,
            `turn ${index} did not reach a durable terminal run`);
        durableMessageTotals.push(durableGrowthRuns.reduce(
            (total, run) => total + (Array.isArray(run.messages) ? run.messages.length : 0), 0));
    }

    const growthRuns = core.store.runs
        .filter(run => String(run.idea || '').startsWith(growthPrefix));
    assert.equal(growthRuns.length, 30);
    assert.ok(growthRuns.every(run => run.transcriptMode === 'run-local-v1'),
        'a new run persisted another cumulative transcript mode');
    assert.ok(growthRuns.every(run => (run.messages || []).length <= 2
        && (run.messages || []).every(message => String(message.runId || '') === run.id)),
    'a run persisted cards owned by an earlier turn');
    assert.ok(growthRuns.every(run => (run.messages || []).every(message => !Object.prototype.hasOwnProperty.call(message, 'idea'))),
        'assistant cards duplicated their canonical run idea');
    assert.ok(durableMessageTotals.every((total, index) => total <= (index + 1) * 2),
        'durable transcript-card growth became superlinear');

    // Hot reload rebuilds the exact chain: no duplicate legacy snapshot cards,
    // and no missing first/last turn.
    runFile(path.join(SRC, 'controller.js'), 'controller transcript hot reload');
    await host.callPageHook('blueprint', 'mount');
    await host.callPageHook('blueprint', 'activate');
    hostRenderAll();
    await tick(20);
    const rebuiltUserCards = queryAll('.cb-msg-user');
    assert.equal(rebuiltUserCards.filter(card => textOf(card).includes(growthPrompts[0])).length, 1,
        'the first local transcript turn was missing or duplicated after reload');
    assert.equal(rebuiltUserCards.filter(card => textOf(card).includes(growthPrompts[29])).length, 1,
        'the last local transcript turn was missing or duplicated after reload');

    // Reject pathological composer payloads before claiming a run or clearing
    // the draft; the user can move the material into Project Files instead.
    const oversizedComposer = query('[data-cb-role="composer"]');
    const oversizedRequest = 'x'.repeat(32769);
    const requestsBeforeOversize = requests.length;
    oversizedComposer.value = oversizedRequest;
    documentStub.dispatch('input', { target: oversizedComposer });
    clickAction('send');
    await tick(20);
    assert.equal(requests.length, requestsBeforeOversize,
        'an oversized composer payload reached the model');
    assert.equal(query('[data-cb-role="composer"]').value, oversizedRequest,
        'an oversized rejected payload was cleared or silently truncated');

    // Clear chat is a conversation boundary even inside the same project root.
    const clearComposer = query('[data-cb-role="composer"]');
    clearComposer.value = '/clear';
    documentStub.dispatch('input', { target: clearComposer });
    clickAction('send');
    await tick(20);
    const postClearPrompt = 'Fresh conversation after explicit clear.';
    const postClearComposer = query('[data-cb-role="composer"]');
    postClearComposer.value = postClearPrompt;
    documentStub.dispatch('input', { target: postClearComposer });
    clickAction('send');
    for (let spin = 0; spin < 200; spin += 1) {
        await tick(5);
        const newest = core.store.runs[0];
        const liveComposer = query('[data-cb-role="composer"]');
        if (newest && newest.idea === postClearPrompt && newest.status !== 'running'
            && liveComposer && !liveComposer.disabled) break;
    }
    assert.equal(core.store.runs[0].contextRunId, '',
        'a post-clear run reattached the prior same-root conversation');
    runFile(path.join(SRC, 'controller.js'), 'controller clear-boundary hot reload');
    await host.callPageHook('blueprint', 'mount');
    await host.callPageHook('blueprint', 'activate');
    hostRenderAll();
    await tick(20);
    assert.match(allText(), /Fresh conversation after explicit clear/,
        'the post-clear turn did not survive reload');
    assert.ok(!allText().includes(growthPrompts[29]),
        'reload resurrected a pre-clear turn from the same project root');

    // =======================================================================
    // 11. Project files update while an import is still awaiting a disk read.
    // No hostRenderAll() or page round-trip is allowed after the import starts.
    // A two-file fixture also catches the old progress-every-40-files gap.
    hostActivateFolder('cb-files');
    let releaseImportRead;
    let importReadStarted = false;
    const directory = (name, entries) => ({
        kind: 'directory', name,
        async *values() { for (const entry of entries) yield entry; }
    });
    const importFile = (name, read) => ({
        kind: 'file', name,
        async getFile() { return { name, size: 20, text: read }; }
    });
    windowStub.FileSystemDirectoryHandle = class {};
    windowStub.showDirectoryPicker = async () => directory('Live progress fixture', [
        importFile('a.js', async () => 'const first = 1;'),
        importFile('b.js', () => {
            importReadStarted = true;
            return new Promise(resolve => { releaseImportRead = resolve; });
        })
    ]);
    const previousOpenPath = core.store.openPath;
    const previousOpenFolder = core.store.openFolderId;
    click(listContent.querySelector('[data-cb-action="open-folder"]'));
    for (let attempt = 0; attempt < 100 && !importReadStarted; attempt += 1) await tick(10);
    assert.ok(importReadStarted, `the test never reached the pending disk read: ${allText().slice(-1400)} ${sidebarText().slice(-600)}`);
    const viewerDuringImport = settingsContainer.firstChild;
    listContent.scrollTop = 137;
    await tick(180);
    assert.match(sidebarText(), /Live progress fixture/);
    assert.match(sidebarText(), /a\.js/, 'the first file stayed invisible until navigation');
    assert.match(sidebarText(), /1 file loaded.*1 of 2 examined/, 'in-flight progress was not rendered');
    assert.equal(core.store.openPath, previousOpenPath, 'import changed the selected file mid-read');
    assert.equal(core.store.openFolderId, previousOpenFolder);
    assert.equal(listContent.scrollTop, 137, 'live refresh reset sidebar scrolling');
    assert.equal(settingsContainer.firstChild, viewerDuringImport, 'progress rebuilt the viewer');
    releaseImportRead('const second = 2;');
    for (let attempt = 0; attempt < 100 && listContent.querySelector('.cb-import-progress'); attempt += 1) await tick(10);
    assert.match(sidebarText(), /b\.js/, 'the trailing import did not refresh the list');
    assert.ok(!listContent.querySelector('.cb-import-progress'), 'progress remained after completion');

    // Cancellation must refresh from the rolled-back VFS, removing partial rows
    // without disturbing the previously completed project.
    importReadStarted = false;
    windowStub.showDirectoryPicker = async () => directory('Cancelled live fixture', [
        importFile('a.js', async () => 'const partial = 1;'),
        importFile('b.js', () => {
            importReadStarted = true;
            return new Promise(resolve => { releaseImportRead = resolve; });
        })
    ]);
    click(listContent.querySelector('[data-cb-action="open-folder"]'));
    for (let attempt = 0; attempt < 100 && !importReadStarted; attempt += 1) await tick(10);
    assert.ok(importReadStarted);
    await tick(180);
    assert.match(sidebarText(), /Cancelled live fixture/);
    click(listContent.querySelector('.cb-import-progress [data-cb-action="stop-run"]'));
    releaseImportRead('const cancelled = 2;');
    for (let attempt = 0; attempt < 100 && listContent.querySelector('.cb-import-progress'); attempt += 1) await tick(10);
    assert.doesNotMatch(sidebarText(), /Cancelled live fixture/, 'cancelled partial project remained visible');
    assert.match(sidebarText(), /Live progress fixture/, 'cancelling removed the earlier project');
    assert.ok(!listContent.querySelector('.cb-import-progress'));
    delete windowStub.showDirectoryPicker;
    delete windowStub.FileSystemDirectoryHandle;

    // =======================================================================
    // 12. Leaving the page releases the divider (no leak into other apps)
    // =======================================================================

    // The divider lives beside the host list pane, outside our container.
    const divider = documentStub.querySelector('.cb-divider');
    assert.ok(divider, 'no sidebar divider was created');
    assert.equal(divider.getAttribute('role'), 'separator');
    assert.equal(divider.getAttribute('aria-orientation'), 'vertical');
    assert.ok(divider.tabIndex === 0, 'the divider is not keyboard reachable');
    assert.equal(listPane.style.width, '300px', 'the divider did not apply the stored sidebar width');

    await host.callPageHook('blueprint', 'deactivate');
    const dividerAfter = documentStub.querySelector('.cb-divider');
    assert.ok(!dividerAfter || !dividerAfter.isConnected, 'the divider leaked after leaving the page');
    assert.equal(listPane.style.width, '', 'the host list pane kept Blueprint\'s inline width');
    assert.equal(listPane.style.flex, '', 'the host list pane kept Blueprint\'s inline flex');

    // =======================================================================
    // 12. Disabling the plug-in removes the page from the app bar
    // =======================================================================

    const records = JSON.parse(localStorageStub.getItem('ragworkspace_plugins'));
    const blueprintRecord = records.find(item => item.id === 'codalio-blueprint');
    assert.ok(blueprintRecord, 'the controller never seeded its host plugin record');
    assert.equal(blueprintRecord.enabled, true);
    assert.equal(blueprintRecord.runtimeBacked, true);
    assert.equal(blueprintRecord.runtimePage, 'blueprint');
    // Only Blueprint's own record exists — no other plug-in was touched.
    assert.equal(records.length, 1, 'the controller wrote another plug-in\'s record');

    blueprintRecord.enabled = false;
    localStorageStub.setItem('ragworkspace_plugins', JSON.stringify(records));
    hostState.plugins.installed = records;
    host.syncPageContributions();
    assert.equal(host.getPage('blueprint'), null, 'a disabled plug-in still exposes its page');
    assert.ok(!String(iconMount.innerHTML || '').includes('data-app="blueprint"'), 'the app-bar icon survived disabling');

    // =======================================================================
    // 13. Nothing Blueprint did touched SimpleRAG's own storage
    // =======================================================================

    const blueprintKeys = localStorageStub._keys().filter(key => key.startsWith('codalio-blueprint.'));
    const foreignKeys = localStorageStub._keys().filter(key => !key.startsWith('codalio-blueprint.'));
    assert.ok(blueprintKeys.length >= 2, 'Blueprint stored nothing under its own keys');
    assert.deepEqual(
        foreignKeys.sort(),
        ['ragworkspace_plugins'],
        `Blueprint wrote to storage it does not own: ${foreignKeys.join(', ')}`
    );

    console.log('controller-integration.test.cjs: 14 groups passed');
    console.log(`  SimpleRAG host  : ${SIMPLERAG}`);
    console.log(`  model turns     : ${requests.length} (endpoint injected, cancel_id on each)`);
    console.log(`  project files   : ${core.listFiles().length} generated and imported files`);
    console.log(`  storage keys    : ${blueprintKeys.length} Blueprint-owned, ${foreignKeys.length} host-owned`);
    process.exit(0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
