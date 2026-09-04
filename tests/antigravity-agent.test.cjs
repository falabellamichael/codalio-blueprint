'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'src');

// Minimal DOM stub
function createElement(tagName) {
    const classes = new Set();
    const element = {
        tagName: String(tagName).toUpperCase(),
        nodeType: 1,
        className: '',
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
        value: '',
        disabled: false,
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
        querySelector(selector) {
            return this.querySelectorAll(selector)[0] || null;
        },
        querySelectorAll(selector) {
            const results = [];
            const check = (node) => {
                if (!node || node.nodeType !== 1) return;
                if (selector.startsWith('.')) {
                    const cls = selector.slice(1);
                    if (node.classList.contains(cls) || (node.className && node.className.split(' ').includes(cls))) {
                        results.push(node);
                    }
                } else if (selector.startsWith('[data-')) {
                    const match = selector.match(/\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/);
                    if (match) {
                        const attr = match[1];
                        const val = match[2];
                        const actual = node.dataset[attr.replace('data-', '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())] || node.getAttribute(attr);
                        if (actual !== undefined && (val === undefined || actual === val)) {
                            results.push(node);
                        }
                    }
                } else if (node.tagName.toLowerCase() === selector.toLowerCase()) {
                    results.push(node);
                }
                (node.children || []).forEach(check);
            };
            (this.children || []).forEach(check);
            return results;
        }
    };
    Object.defineProperty(element, 'className', {
        get: () => [...classes].join(' '),
        set: val => { classes.clear(); String(val || '').split(/\s+/).filter(Boolean).forEach(n => classes.add(n)); },
        configurable: true
    });
    return element;
}

const localStorageStub = (() => {
    const map = new Map();
    return {
        getItem: k => map.has(String(k)) ? map.get(String(k)) : null,
        setItem: (k, v) => { map.set(String(k), String(v)); },
        removeItem: k => { map.delete(String(k)); },
        clear: () => { map.clear(); }
    };
})();

const sandbox = {
    window: {},
    document: {
        documentElement: createElement('html'),
        body: createElement('body'),
        createElement,
        createDocumentFragment() { return createElement('fragment'); },
        createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
        getElementById() { return null; },
        addEventListener() {},
        removeEventListener() {}
    },
    localStorage: localStorageStub,
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
    AbortController: global.AbortController,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, Promise
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);

function runFile(file) {
    const code = fs.readFileSync(path.join(SRC, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
}

// Load modules in order
const pluginManifest = JSON.parse(fs.readFileSync(path.join(SRC, 'plugin.json'), 'utf8'));
const manifestTemplate = fs.readFileSync(path.join(SRC, 'manifest.template.js'), 'utf8');
const manifestJs = manifestTemplate.replace('/*__MANIFEST_JSON__*/null', JSON.stringify(pluginManifest));
vm.runInContext(manifestJs, context, { filename: 'manifest.js' });

runFile('controller-core.js');
runFile('skills.js');
runFile('settings.js');
runFile('agent.js');
runFile('ui.js');

const core = sandbox.window.__codalioBlueprintCore;
const skills = sandbox.window.__codalioBlueprintSkills;
const agent = sandbox.window.__codalioBlueprintAgent;
const ui = sandbox.window.__codalioBlueprintUi;

console.log('--- Testing Anti-gravity Agent Enhancements ---');

// Test 1: Step creation with Anti-gravity fields
const step = agent.makeStep({
    label: 'Test Step',
    summary: 'Analyzing architecture',
    substatus: 'Connecting to model endpoint…',
    thinking: 'First consider modular dependencies…'
});
assert.equal(step.substatus, 'Connecting to model endpoint…');
assert.equal(step.thinking, 'First consider modular dependencies…');
assert.equal(step.tokenCount, 0);
assert.equal(step.tokensPerSec, 0);
console.log('✓ makeStep includes substatus, thinking, and token metrics');

// Test 2: renderStep with live timer, pulse dot, thinking drawer and stream cursor
step.kind = 'phase';
step.status = 'running';
step.streaming = true;
step.open = true;
step.tokensPerSec = 45;
step.elapsedMs = 2400;
const liveEl = sandbox.document.createElement('div');
liveEl.className = 'cb-markdown cb-streaming';
step.liveElement = liveEl;

const renderedNode = ui.renderStep(step);
assert.ok(renderedNode.className.includes('cb-step-active'), 'active step missing cb-step-active class');
const pulse = renderedNode.querySelector('.cb-step-pulse');
assert.ok(pulse, 'active step missing pulsing indicator');
const timeEl = renderedNode.querySelector('.cb-step-time-live');
assert.ok(timeEl, 'active step missing live time element');
assert.equal(timeEl.textContent, '2.4s');
const tpsEl = renderedNode.querySelector('.cb-step-tps');
assert.ok(tpsEl, 'active step missing tok/s indicator');
assert.equal(tpsEl.textContent, '45 tok/s');

const thinkingDrawer = renderedNode.querySelector('.cb-step-thinking');
assert.ok(thinkingDrawer, 'missing thinking process drawer');
const cursor = renderedNode.querySelector('.cb-stream-cursor');
assert.ok(cursor, 'missing streaming typing cursor');
console.log('✓ renderStep renders live timer, pulse dot, tok/s, thinking drawer, and typing cursor');

// Test 3: Pipeline stepper rendering
const pipeline = [
    { id: 'plan', label: 'Plan & Scope', status: 'done' },
    { id: 'lenses', label: 'Analytical Lenses', status: 'running' },
    { id: 'synthesis', label: 'Synthesis', status: 'pending' },
    { id: 'review', label: 'Quality Check', status: 'pending' },
    { id: 'artifacts', label: 'Artifacts', status: 'pending' }
];
const agentPage = ui.renderAgentPage({
    folder: 'cb-agent',
    busy: true,
    selectedSkillId: 'prd-builder',
    messages: [],
    run: { id: 'run-1', title: 'Test Run', status: 'running', pipeline },
    handlers: {}
});
const pipelineEl = agentPage.querySelector('.cb-pipeline');
assert.ok(pipelineEl, 'missing pipeline stepper on agent page');
const pipelineSteps = pipelineEl.querySelectorAll('.cb-pipeline-step');
assert.equal(pipelineSteps.length, 5, 'expected 5 pipeline steps');
assert.ok(pipelineSteps[0].className.includes('cb-pipeline-done'), 'step 1 not marked done');
assert.ok(pipelineSteps[1].className.includes('active'), 'step 2 not active');
console.log('✓ Pipeline stepper renders complete agent execution lifecycle');

// Test 4: Quick slash skills chips in composer
const idleAgentPage = ui.renderAgentPage({
    folder: 'cb-agent',
    busy: false,
    selectedSkillId: 'prd-builder',
    messages: [],
    run: null,
    handlers: {}
});
const quickBar = idleAgentPage.querySelector('.cb-quick-bar');
assert.ok(quickBar, 'missing quick skills bar in composer');
const quickChips = quickBar.querySelectorAll('.cb-quick-chip');
assert.equal(quickChips.length, 6, 'expected 6 quick slash skill chips');
assert.equal(quickChips[0].textContent, '/prd');
console.log('✓ Quick slash commands chips present in composer');

// Test 5: Artifact Cards in message
const msg = {
    id: 'msg-1',
    role: 'assistant',
    at: new Date().toISOString(),
    text: 'Run complete.',
    paths: ['docs/prd/2026-09-03-test-prd.md']
};
core.writeFile('docs/prd/2026-09-03-test-prd.md', '# Test PRD\n\nContent here.');
const msgNode = ui.renderMessage(msg);
const artifactCard = msgNode.querySelector('.cb-artifact-card');
assert.ok(artifactCard, 'missing artifact card for generated document');
const pathChip = msgNode.querySelector('.cb-path-chip');
assert.ok(pathChip, 'path chip missing for 1-click open');
assert.equal(pathChip.dataset.path, 'docs/prd/2026-09-03-test-prd.md');
console.log('✓ Generated documents render rich artifact cards with 1-click open');

// Test 6: Autonomous Gap Repair capability export
assert.equal(typeof agent.reviseDocumentGaps, 'function', 'reviseDocumentGaps not exported');
console.log('✓ Autonomous gap repair capability is exposed on agent runtime');

// Test 7: Question step renders inline answer input when running
const questionStep = agent.makeStep({
    kind: 'question',
    label: 'Clarifying question — user',
    question: 'Who is this for? (role, context, what they do instead)',
    status: 'running',
    open: true
});
const renderedQuestion = ui.renderStep(questionStep);
const inlineAnswerBox = renderedQuestion.querySelector('.cb-step-inline-answer');
assert.ok(inlineAnswerBox, 'missing inline answer box in running question step');
const inlineInput = inlineAnswerBox.querySelector('[data-cb-role="inline-answer-input"]');
assert.ok(inlineInput, 'missing inline answer input in running question step');
const inlineBtn = inlineAnswerBox.querySelector('[data-cb-action="submit-inline-answer"]');
assert.ok(inlineBtn, 'missing inline answer submit button in running question step');
console.log('✓ Running question steps render inline answer input and action button');

// Test 8: Composer stays enabled and surfaces question when pendingQuestion is active
const questionAgentPage = ui.renderAgentPage({
    folder: 'cb-agent',
    busy: true,
    selectedSkillId: 'prd-builder',
    messages: [],
    run: { id: 'run-1', title: 'Test Run', status: 'running' },
    pendingQuestion: {
        stepId: 'step-q1',
        question: 'Who is this for?',
        options: ['Developers', 'Product Managers', 'Designers']
    },
    handlers: {}
});
const questionBar = questionAgentPage.querySelector('.cb-composer-question');
assert.ok(questionBar, 'missing .cb-composer-question bar in composer');
assert.ok(questionBar.textContent.includes('Who is this for?'), 'question text not rendered in composer');
const optionChips = questionBar.querySelectorAll('[data-cb-action="answer-question"]');
assert.equal(optionChips.length, 3, 'expected 3 option chips in composer question bar');

const composerTextarea = questionAgentPage.querySelector('[data-cb-role="composer"]');
assert.ok(composerTextarea, 'missing composer textarea');
assert.equal(composerTextarea.disabled, false, 'composer textarea must NOT be disabled when pendingQuestion is active');
assert.ok(composerTextarea.placeholder.includes('Type your answer'), 'placeholder should prompt user to answer question');

const sendBtn = questionAgentPage.querySelector('[data-cb-action="send"]');
assert.ok(sendBtn, 'missing send button');
assert.equal(sendBtn.disabled, false, 'send button must NOT be disabled when pendingQuestion is active');
assert.equal(sendBtn.textContent.trim(), 'Send Answer', 'send button should display "Send Answer"');
assert.ok(sendBtn.className.includes('cb-send-answer'), 'send button should have cb-send-answer class');
console.log('✓ Composer enables textarea, option chips, and Send Answer button when question is pending');

// Test 9: Live thinking element rendered in running step with brain pulse icon
const thinkingStep = agent.makeStep({
    kind: 'phase',
    label: 'Analytical Lens — Product',
    status: 'running',
    thinking: 'Analyzing target audience requirements…',
    open: true
});
thinkingStep.liveThinkingElement = sandbox.document.createElement('pre');
thinkingStep.liveThinkingElement.className = 'cb-pre cb-thinking-pre';

const liveThinkingNode = ui.renderStep(thinkingStep);
const thinkingBox = liveThinkingNode.querySelector('.cb-step-thinking');
assert.ok(thinkingBox, 'missing thinking box in running step');
const brainIcon = thinkingBox.querySelector('.cb-brain-pulse');
assert.ok(brainIcon, 'missing glowing brain icon in running thinking step');
const liveThinkingEl = thinkingBox.querySelector('.cb-thinking-pre');
assert.ok(liveThinkingEl, 'missing live thinking element in running step');
console.log('✓ Running step renders liveThinkingElement and glowing brain icon');

// Test 10: Agent header renders subtle action icons for Chat History and Clear Chat
const headerAgentPage = ui.renderAgentPage({
    messages: [],
    selectedSkillId: 'prd-builder',
    runs: []
});
const headerActions = headerAgentPage.querySelector('.cb-agent-header-actions');
assert.ok(headerActions, 'missing .cb-agent-header-actions in header');
const historyBtn = headerActions.querySelector('[data-cb-action="toggle-chat-history"]');
assert.ok(historyBtn, 'missing toggle-chat-history button in header');
assert.ok(historyBtn.className.includes('cb-header-icon-btn'), 'history button should have cb-header-icon-btn class');
const clearBtn = headerActions.querySelector('[data-cb-action="clear-chat"]');
assert.ok(clearBtn, 'missing clear-chat button in header');
assert.ok(clearBtn.className.includes('cb-header-icon-btn'), 'clear button should have cb-header-icon-btn class');
console.log('✓ Agent header renders subtle action icons for Chat History and Clear Chat');

// Test 11: Chat History popover renders with runs, items, and actions
const sampleRuns = [
    {
        id: 'run-1',
        skillId: 'prd-builder',
        skillName: 'PRD Builder',
        title: 'ToolShare PRD',
        idea: 'Community tool lending library app',
        createdAt: new Date().toISOString(),
        status: 'done',
        writtenPaths: ['docs/prd/toolshare-prd.md']
    },
    {
        id: 'run-2',
        skillId: 'mvp-checklist',
        skillName: 'MVP Scope',
        title: 'MVP Scope',
        idea: 'Minimal tool sharing MVP',
        createdAt: new Date().toISOString(),
        status: 'running'
    }
];
const historyAgentPage = ui.renderAgentPage({
    messages: [],
    selectedSkillId: 'prd-builder',
    runs: sampleRuns,
    activeRunId: 'run-1',
    isHistoryOpen: true
});
const historyPopover = historyAgentPage.querySelector('.cb-chat-history-popover');
assert.ok(historyPopover, 'missing .cb-chat-history-popover when isHistoryOpen is true');
const newChatInHistory = historyPopover.querySelector('[data-cb-action="clear-chat"]');
assert.ok(newChatInHistory, 'missing New Chat button inside history popover');
const runItems = historyPopover.querySelectorAll('.cb-chat-history-item');
assert.equal(runItems.length, 2, 'expected 2 history run items');
assert.ok(runItems[0].className.includes('active'), 'active run item should have active class');
const deleteBtns = historyPopover.querySelectorAll('[data-cb-action="delete-history-run"]');
assert.equal(deleteBtns.length, 2, 'expected delete button for each run item');
const clearAllBtn = historyPopover.querySelector('[data-cb-action="clear-all-history"]');
assert.ok(clearAllBtn, 'missing clear-all-history button in popover footer');
console.log('✓ Chat History popover renders active runs, New Chat button, delete actions, and footer controls');

console.log('\nAll Anti-gravity agent capabilities verified successfully!');
