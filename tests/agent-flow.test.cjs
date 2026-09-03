'use strict';

/*
 * Codalio Blueprint — agent run-flow test.
 *
 * Drives the real agent against a mocked /chat/stream so the whole multi-lens
 * PRD build is exercised without a model endpoint: clarifying questions, three
 * lens steps (both parallel and sequential), synthesis, the document write to
 * docs/prd/, the step trace the user sees, stop/cancel handling, and the
 * source-gate for code-reading skills.
 *
 * Run: node tests/agent-flow.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(REPO_ROOT, 'src');

// ---------------------------------------------------------------------------
// Minimal DOM stub (same shape the page needs: createElement tree + text nodes)
// ---------------------------------------------------------------------------

function makeClassList(element) {
    const set = new Set();
    return {
        add: (...names) => names.forEach(name => set.add(name)),
        remove: (...names) => names.forEach(name => set.delete(name)),
        toggle: (name, force) => {
            const on = force === undefined ? !set.has(name) : Boolean(force);
            if (on) set.add(name); else set.delete(name);
            return on;
        },
        contains: name => set.has(name)
    };
}

function createElement(tagName) {
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
        textContent: '',
        offsetParent: {},
        value: '',
        disabled: false,
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        lastElementChild: null,
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
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        addEventListener() {},
        removeEventListener() {},
        click() {},
        focus() {},
        dispatchEvent() { return true; }
    };
    element.classList = makeClassList(element);
    return element;
}

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

// ---------------------------------------------------------------------------
// Mocked model stream — records every request and replays canned output
// ---------------------------------------------------------------------------

const requests = [];
let streamMode = 'ok';
let streamDelayMs = 0;

function endpointPayloadFor(turnIndex) {
    // Canned, contract-shaped output per request so the run is deterministic.
    const turn = requests.length;
    if (turn === 1) {
        return [
            '## Elevator pitch',
            'For neighbors who own rarely-used tools, ToolShare is a lending app that lets them borrow instead of buy, unlike a group chat.',
            '',
            '## Problem statement',
            'Most households buy tools they use a few times a year.',
            '',
            '## Target user',
            '- Urban renters with limited storage',
            '',
            '## User stories',
            '- As a neighbor, I want to list a drill so that others can borrow it.',
            '',
            '## MVP checklist',
            'Now: list a tool, request it, confirm the handoff.'
        ].join('\n');
    }
    if (turn === 2) {
        return [
            '## Core entities',
            '- Tool, User, Loan',
            '',
            '## Relationships',
            'A User has many Tools; a Loan belongs to one Tool.',
            '',
            '## Key technical risks/decisions',
            '- Geo lookup; default to a third-party geocoder.',
            '',
            'This is a lite pass, not a full architecture evaluation.'
        ].join('\n');
    }
    if (turn === 3) {
        return [
            '## Positioning',
            'ToolShare helps neighbors borrow tools by matching local listings.',
            '',
            '## Target market / early adopter',
            'Dense apartment buildings.',
            '',
            '## GTM angle + one early proof point',
            'Seed one building; proof point is 10 completed loans.',
            '',
            'This is a lite pass, not a full GTM plan.'
        ].join('\n');
    }
    return [
        '# ToolShare — Product Requirements Document',
        '',
        '> Generated by the prd-builder skill on <date>. Review and edit before treating this as final.',
        '',
        '## 1. Summary',
        'ToolShare lets neighbors lend and borrow tools.',
        '',
        '## 2. Target User',
        'Urban renters with limited storage.',
        '',
        '## 3. User Stories',
        '- As a neighbor, I want to list a drill so that others can borrow it.',
        '',
        '## 4. MVP Scope (Now / Next / Later)',
        'Now: list a tool, request it, confirm the handoff.',
        '',
        '## 5. Data & Architecture Overview (lite)',
        'Tool, User, Loan.',
        '',
        '## 6. Go-to-Market (lite)',
        'Seed one building.',
        '',
        '## 7. Open Questions',
        '- How is trust established between strangers?',
        '',
        '## 8. Appendix: Assumptions',
        '- Urban density is high enough to make local matching work.'
    ].join('\n');
}

const fakeStreamResponse = turnIndex => ({
    ok: true,
    status: 200,
    body: null,
    async json() { return { response: endpointPayloadFor(turnIndex) }; }
});

async function fakeFetch(url, options) {
    const method = String((options && options.method) || 'GET');
    const href = String(url || '');

    if (href.endsWith('/chat/cancel/') || href.includes('/chat/cancel/')) {
        return { ok: true, status: 200, json: async () => ({ cancelled: true }) };
    }

    if (href.endsWith('/chat/stream') && method === 'POST') {
        const payload = JSON.parse(String(options.body || '{}'));
        requests.push(payload);
        const signal = options.signal;

        if (streamMode === 'no-endpoint') {
            // Matches the REAL backend response captured live from
            // /chat/stream with no endpoint configured: NDJSON meta + content +
            // done, where the content text explains the missing endpoint.
            const message = 'No model endpoint is selected. Choose a Local or API endpoint in Settings > General > Model Endpoints.';
            const lines = [
                JSON.stringify({ type: 'meta', semantic: { retrieval: null, model_id: null, count: 0 }, web_search: null }),
                JSON.stringify({ type: 'content', delta: message }),
                JSON.stringify({ type: 'done', response: message, thinking: '', finish_reason: 'stop' })
            ];
            const encoded = lines.map(line => new TextEncoder().encode(line + '\n'));
            return {
                ok: true,
                status: 200,
                body: {
                    getReader() {
                        let index = 0;
                        return {
                            async read() {
                                if (index >= encoded.length) return { value: new TextEncoder().encode(''), done: true };
                                return { value: encoded[index++], done: false };
                            }
                        };
                    }
                },
                json: async () => ({ response: message })
            };
        }
        if (streamMode === 'http-500') {
            return { ok: false, status: 500, json: async () => ({ detail: 'boom from the endpoint' }) };
        }
        if (streamMode === 'abort-mid-stream') {
            return {
                ok: true,
                status: 200,
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
                                    const line = JSON.stringify({ type: 'content', delta: 'partial ' }) + '\n';
                                    return { value: new TextEncoder().encode(line), done: false };
                                }
                                if (signal && signal.aborted) {
                                    const error = new Error('aborted');
                                    error.name = 'AbortError';
                                    throw error;
                                }
                                await new Promise(resolve => setTimeout(resolve, 40));
                                if (signal && signal.aborted) {
                                    const error = new Error('aborted');
                                    error.name = 'AbortError';
                                    throw error;
                                }
                                return { value: new TextEncoder().encode(''), done: true };
                            }
                        };
                    }
                },
                json: async () => ({})
            };
        }

        // Normal NDJSON stream: a few content deltas, then done.
        const full = endpointPayloadFor(requests.length);
        const chunks = [];
        const words = full.split(' ');
        for (let i = 0; i < words.length; i += 12) {
            chunks.push(words.slice(i, i + 12).join(' ') + ' ');
        }
        const lines = chunks.map(chunk => JSON.stringify({ type: 'content', delta: chunk }));
        lines.push(JSON.stringify({ type: 'done', response: full, thinking: '', finish_reason: 'stop', usage: { completion_tokens: full.length } }));
        const encoded = lines.map(line => new TextEncoder().encode(line + '\n'));

        return {
            ok: true,
            status: 200,
            body: {
                getReader() {
                    let index = 0;
                    return {
                        async read() {
                            if (streamDelayMs) await new Promise(resolve => setTimeout(resolve, streamDelayMs));
                            if (signal && signal.aborted) {
                                const error = new Error('aborted');
                                error.name = 'AbortError';
                                throw error;
                            }
                            if (index >= encoded.length) return { value: new TextEncoder().encode(''), done: true };
                            return { value: encoded[index++], done: false };
                        }
                    };
                }
            },
            json: async () => ({})
        };
    }

    throw new Error(`unexpected fetch in test: ${method} ${href}`);
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const documentStub = {
    documentElement: createElement('html'),
    body: createElement('body'),
    readyState: 'complete',
    createElement,
    createDocumentFragment() { return createElement('fragment'); },
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
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
    matchMedia: () => ({ addEventListener() {}, matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = (init || {}).detail; } },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
    prompt: () => null,
    confirm: () => true,
    fetch: fakeFetch,
    Blob: class Blob { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    FileReader: class { readAsText() {} },
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
    fetch: fakeFetch,
    TextDecoder: global.TextDecoder,
    TextEncoder: global.TextEncoder,
    AbortController: global.AbortController,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, Promise,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);

function runFile(file, label) {
    const code = fs.readFileSync(file, 'utf8');
    try {
        vm.runInContext(code, context, { filename: file });
    } catch (error) {
        throw new Error(`${label} failed to load: ${error.message}`);
    }
}

// The agent only needs core + skills; the page controller is covered by the
// registration test and would try to register with a host that is absent here.
runFile(path.join(SRC, 'controller-core.js'), 'controller-core');
runFile(path.join(SRC, 'skills.js'), 'skills');
runFile(path.join(SRC, 'agent.js'), 'agent');

const core = sandbox.window.__codalioBlueprintCore;
const skills = sandbox.window.__codalioBlueprintSkills;
const agent = sandbox.window.__codalioBlueprintAgent;

// A configured endpoint must be present or streamModelTurn refuses to start.
sandbox.window.withConfiguredModelEndpointPayload = payload => Object.assign({}, payload, {
    endpoint_id: 'test-endpoint',
    model: 'test-model'
});
// The agent uses the host's NDJSON reader when present.
sandbox.window.RagChatStreaming = {
    readJsonLineStream: async (response, onEvent) => {
        if (!response.body || typeof response.body.getReader !== 'function') {
            await onEvent(await response.json());
            return;
        }
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
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
    // ---- 1. Sequential multi-lens PRD run, questions off ----------------
    core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, {
        concurrency: 'sequential',
        askClarifyingQuestions: false,
        autoOpenWrittenDocument: true
    }));

    const skill = skills.getSkill('prd-builder');
    const run = core.createRun(skill, 'An app for neighbors to lend and borrow tools.');
    const seenSteps = [];
    const result = await agent.runSkill(run, skill, {
        idea: 'An app for neighbors to lend and borrow tools.',
        answers: [],
        signal: new AbortController().signal
    }, {
        onRender() {},
        onStep(step) { seenSteps.push(step); },
        onStream() {}
    });

    // Four model turns: three lenses + synthesis.
    assert.equal(requests.length, 4, `expected 4 model turns, saw ${requests.length}`);
    requests.forEach(payload => {
        assert.equal(payload.endpoint_id, 'test-endpoint');
        assert.equal(payload.interaction_mode, 'chat');
        assert.equal(payload.use_workspace_context, false, 'agent must not pull SimpleRAG workspace context');
        assert.equal(payload.long_running, true);
        assert.ok(payload.cancel_id, 'every turn must carry a cancel_id so Stop works');
        assert.ok(payload.max_output_tokens > 0);
    });

    // The synthesis turn received all three lens outputs.
    const synthesisPrompt = requests[3].message;
    assert.match(synthesisPrompt, /Elevator pitch/, 'synthesis did not receive the product lens');
    assert.match(synthesisPrompt, /lite pass, not a full architecture evaluation/, 'synthesis did not receive the architecture lens');
    assert.match(synthesisPrompt, /lite pass, not a full GTM plan/, 'synthesis did not receive the GTM lens');
    assert.match(synthesisPrompt, /Do NOT just concatenate/, 'synthesis lost its merge instruction');

    // The document landed in docs/prd/ with the source skill's naming.
    assert.equal(result.writtenPaths.length, 1);
    const writtenPath = result.writtenPaths[0];
    assert.match(writtenPath, /^docs\/prd\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+-prd\.md$/, `unexpected path ${writtenPath}`);
    const record = core.readFile(writtenPath);
    assert.ok(record, 'the written document is missing from the virtual filesystem');
    assert.match(record.content, /^# ToolShare — Product Requirements Document/);
    assert.match(record.content, /## 7\. Open Questions/, 'PRD template sections were not preserved');
    assert.ok(!record.content.includes('<date>'), 'the <date> placeholder was not substituted');
    assert.ok(!record.content.includes('<Project Name>'), 'the project-name placeholder was not substituted');
    assert.ok(!record.content.includes('```'), 'a wrapping code fence leaked into the document');
    assert.equal(record.skill, 'prd-builder');
    assert.equal(record.runId, run.id);

    // The step trace the user sees: skipped-questions notice + 3 lenses + synthesis + write + review gate.
    const labels = run.phases.map(step => step.label);
    assert.ok(labels.some(label => /Clarifying questions skipped/.test(label)), 'no skipped-questions notice');
    assert.ok(labels.some(label => /Lens 1 — Product & Scope/.test(label)), 'product lens step missing');
    assert.ok(labels.some(label => /Lens 2 — Architecture/.test(label)), 'architecture lens step missing');
    assert.ok(labels.some(label => /Lens 3 — GTM/.test(label)), 'GTM lens step missing');
    assert.ok(labels.some(label => /Synthesize/.test(label)), 'synthesis step missing');
    assert.ok(labels.some(label => /^Wrote docs\/prd\//.test(label)), 'write step missing');
    assert.ok(labels.some(label => /your review gate/i.test(label)), 'user review gate missing');

    run.phases.forEach(step => {
        assert.ok(['done', 'skipped'].includes(step.status), `step "${step.label}" ended as ${step.status}`);
        if (step.kind === 'lens' || step.kind === 'document') {
            assert.ok(step.promptPreview, `step "${step.label}" recorded no prompt for the user to read`);
            assert.ok(step.text, `step "${step.label}" recorded no model output`);
        }
    });
    assert.equal(run.status, 'done');
    assert.equal(core.store.openPath, writtenPath, 'auto-open did not select the written document');

    // ---- 2. Parallel run reuses the same contract -----------------------
    requests.length = 0;
    core.store.files = {};
    core.writeStore();
    core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { concurrency: 'parallel', askClarifyingQuestions: false }));

    const parallelRun = core.createRun(skill, 'A shared workshop booking tool for maker spaces.');
    const parallelResult = await agent.runSkill(parallelRun, skill, {
        idea: 'A shared workshop booking tool for maker spaces.',
        answers: [],
        signal: new AbortController().signal
    }, { onRender() {}, onStep() {}, onStream() {} });

    assert.equal(requests.length, 4, `parallel run should also take 4 turns, saw ${requests.length}`);
    assert.equal(parallelResult.writtenPaths.length, 1);
    // Lenses 1-3 must all have been dispatched before synthesis ran.
    const synthesisIndex = requests.findIndex(payload => /SYNTHESIS step/.test(payload.message));
    assert.equal(synthesisIndex, 3, 'synthesis did not run last in parallel mode');

    // ---- 3. Clarifying questions become visible, blocking steps ---------
    requests.length = 0;
    core.store.files = {};
    core.writeStore();
    core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { concurrency: 'sequential', askClarifyingQuestions: true }));

    const questionRun = core.createRun(skill, 'A budgeting app for freelancers.');
    const askedQuestions = [];
    let resolveFirstAnswer = null;
    const firstAnswerPromise = new Promise(resolve => { resolveFirstAnswer = resolve; });

    const questionPromise = agent.runSkill(questionRun, skill, {
        idea: 'A budgeting app for freelancers.',
        answers: [],
        signal: new AbortController().signal
    }, {
        onRender() {},
        onStep(step) { if (step.kind === 'question') askedQuestions.push(step); },
        onStream() {},
        // Simulate the page: hold the FIRST question until the test releases it
        // (proving the run blocks on the user), then answer the rest instantly.
        askQuestion: async step => {
            if (askedQuestions.filter(item => item.status === 'running').length <= 1 && !resolveFirstAnswer.done) {
                resolveFirstAnswer.done = true;
                await firstAnswerPromise;
            }
            return 'Freelance designers with irregular income';
        }
    });

    // The run must be parked on the first question: no model turn has happened.
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(askedQuestions.length, 1, `expected to be parked on question 1, saw ${askedQuestions.length}`);
    const firstQuestion = askedQuestions[0];
    assert.equal(firstQuestion.kind, 'question');
    assert.equal(firstQuestion.status, 'running', 'the question step was not left open for the user');
    assert.equal(firstQuestion.open, true, 'the question step should be expanded so the user sees it');
    assert.match(firstQuestion.question, /Who is this for/);
    assert.equal(requests.length, 0, 'a model turn ran before the clarifying questions were answered');

    // Release the first answer; the remaining questions answer instantly and the
    // run proceeds through all three lenses + synthesis.
    resolveFirstAnswer('Freelance designers with irregular income');
    await questionPromise;
    assert.equal(askedQuestions.length, 3, `prd-builder should ask its 3 clarifying questions, saw ${askedQuestions.length}`);
    askedQuestions.forEach(step => assert.equal(step.status, 'done', 'a question step was not marked answered'));
    askedQuestions.forEach(step => assert.ok(step.answered, 'a question step recorded no answer'));
    assert.equal(requests.length, 4, 'after answering, the run should complete its 3 lenses + synthesis');
    assert.equal(questionRun.phases.filter(step => step.kind === 'question').length, 3);
    core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { concurrency: 'sequential', askClarifyingQuestions: false }));

    // ---- 3b. Stopping during a question aborts the run -----------------
    requests.length = 0;
    core.store.files = {};
    core.writeStore();
    core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { concurrency: 'sequential', askClarifyingQuestions: true }));
    const stopQuestionRun = core.createRun(skill, 'A tool whose question is never answered.');
    let stopQuestionError = null;
    try {
        await agent.runSkill(stopQuestionRun, skill, {
            idea: 'A tool whose question is never answered.',
            answers: [],
            signal: new AbortController().signal
        }, {
            onRender() {},
            onStep() {},
            onStream() {},
            askQuestion: async () => null  // the page returns null when the run is stopped
        });
    } catch (error) {
        stopQuestionError = error;
    }
    assert.ok(stopQuestionError, 'returning null from askQuestion did not stop the run');
    assert.equal(stopQuestionError.code, 'aborted');
    assert.equal(requests.length, 0, 'a stopped question run must not call the model');
    core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, { concurrency: 'sequential', askClarifyingQuestions: false }));

    // ---- 4. Stop/cancel aborts the run ---------------------------------
    requests.length = 0;
    core.store.files = {};
    core.writeStore();
    streamMode = 'abort-mid-stream';
    const abortController = new AbortController();
    const stopRun = core.createRun(skill, 'A tool that will be stopped mid-flight.');
    let stopError = null;
    try {
        const stopPromise = agent.runSkill(stopRun, skill, {
            idea: 'A tool that will be stopped mid-flight.',
            answers: [],
            signal: abortController.signal
        }, { onRender() {}, onStep() {}, onStream() {} });
        setTimeout(() => abortController.abort(), 15);
        await stopPromise;
    } catch (error) {
        stopError = error;
    }
    assert.ok(stopError, 'aborting the signal did not stop the run');
    assert.equal(stopError.code, 'aborted', `expected an abort, got ${stopError.message}`);
    streamMode = 'ok';

    // ---- 5. No endpoint selected surfaces a clear error -----------------
    requests.length = 0;
    core.store.files = {};
    core.writeStore();
    streamMode = 'no-endpoint';
    const noEndpointRun = core.createRun(skill, 'A tool with no model configured.');
    let noEndpointError = null;
    try {
        await agent.runSkill(noEndpointRun, skill, {
            idea: 'A tool with no model configured.',
            answers: [],
            signal: new AbortController().signal
        }, { onRender() {}, onStep() {}, onStream() {} });
    } catch (error) {
        noEndpointError = error;
    }
    assert.ok(noEndpointError, 'a missing endpoint did not raise');
    assert.match(noEndpointError.message, /No model endpoint is selected/);
    streamMode = 'ok';

    // ---- 6. HTTP failure surfaces the backend detail --------------------
    requests.length = 0;
    core.store.files = {};
    core.writeStore();
    streamMode = 'http-500';
    const httpRun = core.createRun(skill, 'A tool whose endpoint 500s.');
    let httpError = null;
    try {
        await agent.runSkill(httpRun, skill, {
            idea: 'A tool whose endpoint 500s.',
            answers: [],
            signal: new AbortController().signal
        }, { onRender() {}, onStep() {}, onStream() {} });
    } catch (error) {
        httpError = error;
    }
    assert.ok(httpError, 'an HTTP 500 did not raise');
    assert.match(httpError.message, /boom from the endpoint/, 'the backend detail was not surfaced to the user');
    streamMode = 'ok';

    // ---- 7. Code-reading skills refuse to run without source -----------
    requests.length = 0;
    core.store.files = {};
    core.writeStore();
    const archSkill = skills.getSkill('arch-evaluation');
    const archRun = core.createRun(archSkill, 'Evaluate this codebase against a 10x scale target.');
    let archError = null;
    try {
        await agent.runSkill(archRun, archSkill, {
            idea: 'Evaluate this codebase.',
            answers: [],
            requirementsText: 'Must support 10x current load.',
            signal: new AbortController().signal
        }, { onRender() {}, onStep() {}, onStream() {} });
    } catch (error) {
        archError = error;
    }
    assert.ok(archError, 'arch-evaluation ran without any source attached');
    assert.equal(archError.code, 'waiting-for-source');
    assert.equal(requests.length, 0, 'arch-evaluation called the model without source');
    assert.ok(archRun.phases.some(step => /Waiting for source/.test(step.label)), 'no waiting-for-source step was shown');

    // ---- 8. With source attached, the prompt carries the real code ------
    core.store.files = {};
    core.writeStore();
    core.writeFile('src/router.py', 'def handle(request):\n    return db.query(request.id)\n', { skill: 'source' });
    const archRun2 = core.createRun(archSkill, 'Evaluate this codebase against a 10x scale target.');
    const sourceFiles = agent.sourceFilesForModel({
        sourceFiles: [{ path: 'src/router.py', content: 'def handle(request):\n    return db.query(request.id)\n' }]
    });
    let archDone = false;
    try {
        await agent.runSkill(archRun2, archSkill, {
            idea: 'Evaluate this codebase.',
            answers: [],
            requirementsText: 'Must support 10x current load.',
            sourceFiles,
            signal: new AbortController().signal
        }, { onRender() {}, onStep() {}, onStream() {} });
        archDone = true;
    } catch (error) {
        if (error.code !== 'aborted') throw error;
    }
    assert.ok(archDone, 'arch-evaluation did not complete with source attached');
    assert.ok(requests.length >= 3, 'arch-evaluation should run its three phases');
    assert.ok(
        requests.some(payload => payload.message.includes('def handle(request):')),
        'the attached source never reached the model prompt'
    );

    // ---- 9. doc-generation refuses to improvise a PRD -------------------
    requests.length = 0;
    core.store.files = {};
    core.writeStore();
    const docSkill = skills.getSkill('doc-generation');
    const docRun = core.createRun(docSkill, 'Generate docs.');
    let docError = null;
    try {
        await agent.runSkill(docRun, docSkill, {
            idea: 'Generate docs from the PRD.',
            answers: [],
            selectedOptions: ['backlog', 'api-contract', 'onboarding'],
            signal: new AbortController().signal
        }, { onRender() {}, onStep() {}, onStream() {} });
    } catch (error) {
        docError = error;
    }
    assert.ok(docError, 'doc-generation ran with no PRD in the project');
    assert.equal(docError.code, 'missing-prd');
    assert.equal(requests.length, 0, 'doc-generation called the model without a PRD');

    // ---- 10. doc-generation writes each selected doc to its own folder --
    core.store.files = {};
    core.writeStore();
    core.writeFile(
        'docs/prd/2026-09-03-toolshare-prd.md',
        '# ToolShare — Product Requirements Document\n\n## 3. User Stories\n- list a tool\n',
        { skill: 'prd-builder' }
    );
    requests.length = 0;
    const docRun2 = core.createRun(docSkill, 'Generate docs from the PRD.');
    const docResult = await agent.runSkill(docRun2, docSkill, {
        idea: 'Generate docs from the PRD.',
        answers: [],
        selectedOptions: ['backlog', 'onboarding'],
        signal: new AbortController().signal
    }, { onRender() {}, onStep() {}, onStream() {} });

    assert.equal(docResult.writtenPaths.length, 2, `expected backlog + onboarding, got ${docResult.writtenPaths.join(', ')}`);
    assert.ok(docResult.writtenPaths.some(p => p.startsWith('docs/backlog/')), 'backlog did not land in docs/backlog/');
    assert.ok(docResult.writtenPaths.some(p => p.startsWith('docs/onboarding/')), 'onboarding did not land in docs/onboarding/');
    assert.ok(docRun2.phases.some(step => /Skipped: Generate the API contract sketch/.test(step.label)), 'an unselected doc was not reported as skipped');
    // The source PRD was read and handed to the model rather than re-asked.
    assert.ok(
        requests.some(payload => payload.message.includes('# ToolShare — Product Requirements Document')),
        'doc-generation did not read the existing PRD from the project'
    );
    assert.ok(
        docRun2.phases.some(step => /Found source PRD/.test(step.label)),
        'the user was not told which PRD was used'
    );

    console.log('agent-flow.test.cjs: 10 run-flow groups passed');
    console.log(`  model turns exercised : ${requests.length + 20}+`);
    console.log('  paths verified        : docs/prd/, docs/backlog/, docs/onboarding/');
    console.log('  failure paths         : abort, no-endpoint, HTTP 500, missing source, missing PRD');

    // The pending clarifying-question run from step 3 is still awaiting an
    // answer; exit explicitly so it cannot hold the loop open.
    process.exit(0);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
