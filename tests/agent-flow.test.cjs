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

    // ---- 3b. Caller-supplied answers survive when questions are off ------
    //
    // Regression: runSkill() used to do `input.answers = answers` outright. With
    // clarifying questions OFF, askClarifyingQuestions() returns [], so a
    // caller-supplied answer (a resumed run, or a scope narrowing) was wiped and
    // the run proceeded as if the user had said nothing. Answers must MERGE, and
    // a fresh answer to the SAME question id must still win over a stale one.
    requests.length = 0;
    core.store.files = {};
    core.writeStore();
    let seenPrompt = '';
    const mergeRun = core.createRun(skill, 'A tool for tracking garden tools.');
    await agent.runSkill(mergeRun, skill, {
        idea: 'A tool for tracking garden tools.',
        // Supplied up front, with questions OFF, so nothing re-asks them.
        answers: [
            { id: 'user', question: 'Who is this for?', answer: 'community gardeners' },
            { id: 'problem', question: 'What problem?', answer: 'tools go missing' }
        ],
        signal: new AbortController().signal
    }, { onRender() {}, onStep() {}, onStream() {} });
    seenPrompt = requests[0].message;
    assert.ok(seenPrompt.indexOf('community gardeners') >= 0,
        'a caller-supplied clarifying answer was discarded before reaching the prompt');
    assert.ok(seenPrompt.indexOf('tools go missing') >= 0,
        'a second caller-supplied answer was discarded');

    // With questions ON, a freshly gathered answer to the same id must WIN over
    // a stale pre-supplied one — the user just typed the newer value.
    requests.length = 0;
    core.store.files = {};
    core.writeStore();
    core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, {
        concurrency: 'sequential', askClarifyingQuestions: true
    }));
    const freshRun = core.createRun(skill, 'A tool for tracking garden tools.');
    await agent.runSkill(freshRun, skill, {
        idea: 'A tool for tracking garden tools.',
        answers: [{ id: 'user', question: 'Who is this for?', answer: 'STALE answer' }],
        signal: new AbortController().signal
    }, {
        onRender() {}, onStep() {}, onStream() {},
        askQuestion: async (step, question) => question.id === 'user'
            ? 'FRESH answer from the user'
            : 'some other answer'
    });
    const freshPrompt = requests[0].message;
    assert.ok(freshPrompt.indexOf('FRESH answer from the user') >= 0,
        'a freshly gathered answer did not reach the prompt');
    assert.ok(freshPrompt.indexOf('STALE answer') < 0,
        'a stale pre-supplied answer overrode the one the user just gave');
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

    // ---- 11. Whole-codebase digest reaches the model, and scope narrows it --
    //
    // Groups 7-8 prove the ATTACHED path works. These prove the digest path
    // does, end to end: that the structural map lands in the real prompt, that
    // answering "one subsystem" actually narrows it (it used to be prose only),
    // and that a project with no verbatim picks still runs instead of being
    // refused as "no source".
    core.store.files = {};
    core.writeStore();
    core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, {
        concurrency: 'sequential',
        askClarifyingQuestions: false,
        sourceContextMode: 'digest',
        digestBudgetTokens: 4000
    }));

    // A small stand-in for the real project shape: two subsystems plus a hub,
    // a stylesheet, a vendored bundle and a generated doc.
    const makeLine = (n, body) => Array.from({ length: n }, (_, i) => `${body}_${i}`).join('\n');
    core.writeFile('router.py', [
        'import sqlite3',
        'from comfy_worker import run_workflow',
        '',
        '@app.get("/health")',
        'def health():',
        '    return {"ok": True}',
        ''
    ].join('\n'), { skill: 'source', origin: 'imported' });
    core.writeFile('comfy/worker.py', makeLine(60, 'def comfy_step'), { skill: 'source', origin: 'imported' });
    core.writeFile('comfy/runtime-config.js', makeLine(60, 'const comfyOption'), { skill: 'source', origin: 'imported' });
    core.writeFile('journal/service.py', makeLine(60, 'def journal_step'), { skill: 'source', origin: 'imported' });
    core.writeFile('theme.css', makeLine(80, '.selector'), { skill: 'source', origin: 'imported' });
    core.writeFile('vendor/bundle.min.js', 'x'.repeat(4000), { skill: 'source', origin: 'imported' });
    core.writeFile('docs/prd/older.md', '# Older PRD\n', { skill: 'prd-builder' });

    requests.length = 0;
    const digestRun = core.createRun(archSkill, 'Evaluate this codebase.');
    await agent.runSkill(digestRun, archSkill, {
        idea: 'Evaluate this codebase.',
        answers: [],
        requirementsText: 'Must support 10x current load.',
        signal: new AbortController().signal
    }, { onRender() {}, onStep() {}, onStream() {} });

    assert.ok(requests.length >= 3, `digest mode ran ${requests.length} turns, expected >= 3`);
    const digestPrompt = requests[0].message;

    // The structural map is in the prompt, labelled as a whole-project map.
    assert.match(digestPrompt, /Codebase map/, 'the digest map never reached the model prompt');
    assert.match(digestPrompt, /digest of every file in the project/,
        'the prompt did not tell the model the map covers the whole project');

    // Every first-party file is MAPPED, including the ones never attached
    // verbatim — this is the whole point of the feature.
    ['router.py', 'comfy/worker.py', 'journal/service.py', 'theme.css'].forEach(item => {
        assert.ok(digestPrompt.indexOf(item) >= 0,
            `digest mode omitted "${item}" from the map`);
    });

    // Real structure was extracted, not just file names. The skills forbid
    // evaluating architecture from file names alone, so the map must carry
    // signatures and routes.
    assert.match(digestPrompt, /GET \/health/, 'the extracted HTTP route did not reach the model');
    assert.match(digestPrompt, /comfy_step/, 'an extracted function signature did not reach the model');
    assert.match(digestPrompt, /imports: sqlite3/, 'extracted imports did not reach the model');

    // Vendored bundles are excluded from analysis but the model is TOLD they
    // exist, so it cannot assume the project has no dependencies.
    assert.ok(digestPrompt.indexOf('vendor/bundle.min.js') < 0,
        'a vendored minified bundle was mapped instead of excluded');
    assert.match(digestPrompt, /vendored\/minified bundle/,
        'the prompt did not disclose that bundles were excluded');

    // Blueprint's own generated documents are output, not codebase under test.
    assert.ok(digestPrompt.indexOf('docs/prd/older.md') < 0,
        'a generated Blueprint document was mapped as project source');

    // The run trace says what happened, in whole-codebase terms.
    const digestStep = digestRun.phases.find(step => /Mapped \d+ project files/.test(step.label));
    assert.ok(digestStep, 'no digest step was added to the run trace');
    assert.match(digestStep.text, /Whole-codebase digest/, 'the trace did not explain the digest');
    assert.match(digestStep.text, /token budget/, 'the trace did not report the budget used');
    assert.ok(Number(digestStep.summary.match(/([\d,]+) tokens/)[1].replace(/,/g, '')) <= 4000,
        'the digest exceeded the configured budget');

    // ---- 12. The clarifying "scope" answer now NARROWS the digest --------
    //
    // This is the user-visible bug: code-to-prd asks "whole codebase, or one
    // subsystem?" and the answer used to become prose only — the model was told
    // "one subsystem" while receiving whatever the cap allowed.
    const scopeFilter = agent.deriveScopeFilter([
        { id: 'scope', question: 'Which subsystem?', answer: 'just the comfy subsystem' }
    ]);
    assert.equal(scopeFilter.active, true, 'a subsystem answer did not activate the filter');
    assert.ok(scopeFilter.fragments.indexOf('comfy') >= 0,
        'the subsystem name was not extracted from the answer');
    assert.match(scopeFilter.note, /comfy/, 'the filter produced no human-readable note');

    // A "whole codebase" answer must NOT filter — that would silently hide files.
    ['whole codebase', 'the entire codebase', 'everything', 'all of it'].forEach(answer => {
        assert.equal(agent.deriveScopeFilter([{ id: 'scope', answer }]).active, false,
            `the answer "${answer}" was treated as a subsystem filter`);
    });
    // No scope question at all means no filtering.
    assert.equal(agent.deriveScopeFilter([]).active, false);
    assert.equal(agent.deriveScopeFilter(undefined).active, false);

    requests.length = 0;
    const narrowRun = core.createRun(archSkill, 'Evaluate the comfy subsystem.');
    await agent.runSkill(narrowRun, archSkill, {
        idea: 'Evaluate the comfy subsystem.',
        answers: [{ id: 'scope', question: 'Which subsystem?', answer: 'just the comfy subsystem' }],
        requirementsText: 'Must support 10x current load.',
        signal: new AbortController().signal
    }, { onRender() {}, onStep() {}, onStream() {} });

    const narrowPrompt = requests[0].message;
    assert.ok(narrowPrompt.indexOf('comfy/worker.py') >= 0,
        'the scoped run dropped the very subsystem it was asked about');
    assert.ok(narrowPrompt.indexOf('journal/service.py') < 0,
        'the scope answer did not exclude the other subsystem — it is still decorative');
    const narrowStep = narrowRun.phases.find(step => /Mapped \d+ project files/.test(step.label));
    assert.match(narrowStep.text, /Scope: \d+ file\(s\) matched/,
        'the run trace did not report that the scope answer narrowed the digest');

    // A scope answer that matches nothing must fall back to the whole project
    // and SAY SO, rather than producing an empty digest that looks like a
    // complete map of an empty codebase.
    requests.length = 0;
    const missRun = core.createRun(archSkill, 'Evaluate the billing subsystem.');
    await agent.runSkill(missRun, archSkill, {
        idea: 'Evaluate the billing subsystem.',
        answers: [{ id: 'scope', question: 'Which subsystem?', answer: 'only the billing module' }],
        requirementsText: 'Must support 10x current load.',
        signal: new AbortController().signal
    }, { onRender() {}, onStep() {}, onStream() {} });
    assert.ok(requests[0].message.indexOf('comfy/worker.py') >= 0,
        'a non-matching scope answer produced an empty digest instead of the whole project');
    const missStep = missRun.phases.find(step => /Mapped \d+ project files/.test(step.label));
    assert.match(missStep.text, /no project path matched it/,
        'the trace did not disclose that the scope filter matched nothing');

    // ---- 13. A structure-only project still runs -------------------------
    //
    // A project of only stylesheets and documents yields no verbatim picks.
    // Refusing it as "no source" would hide the map that does describe it.
    core.store.files = {};
    core.writeStore();
    core.writeFile('theme.css', makeLine(80, '.selector'), { skill: 'source', origin: 'imported' });
    core.writeFile('README.md', '# Project\n\n## Overview\n\nA thing.\n', { skill: 'source', origin: 'imported' });
    requests.length = 0;
    const styleOnlyRun = core.createRun(archSkill, 'Evaluate this project.');
    let styleOnlyDone = false;
    try {
        await agent.runSkill(styleOnlyRun, archSkill, {
            idea: 'Evaluate this project.',
            answers: [],
            requirementsText: 'Must support 10x current load.',
            signal: new AbortController().signal
        }, { onRender() {}, onStep() {}, onStream() {} });
        styleOnlyDone = true;
    } catch (error) {
        if (error.code !== 'aborted') throw error;
    }
    assert.ok(styleOnlyDone, 'a project with no verbatim picks was refused as having no source');
    assert.ok(requests.length > 0, 'the structure-only digest never reached the model');
    assert.match(requests[0].message, /theme\.css/, 'the stylesheet was not mapped');
    assert.match(requests[0].message, /# Project/, 'the README headings were not mapped');

    // ---- 14. Attached mode is unchanged (back-compat) --------------------
    //
    // The default must remain the old behaviour, so upgrading cannot silently
    // change what an existing user's runs send.
    core.store.files = {};
    core.writeStore();
    core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS, {
        concurrency: 'sequential',
        askClarifyingQuestions: false
    }));
    assert.equal(core.readSettings().sourceContextMode, 'attached',
        'the default source context mode is not "attached"');
    core.writeFile('src/only.py', 'def handle(request):\n    return request\n', { skill: 'source', origin: 'imported' });
    core.writeFile('src/never_attached.py', makeLine(200, 'def ignored'), { skill: 'source', origin: 'imported' });
    requests.length = 0;
    const attachedRun = core.createRun(archSkill, 'Evaluate this codebase.');
    const attachedFiles = agent.sourceFilesForModel({
        sourceFiles: [{ path: 'src/only.py', content: 'def handle(request):\n    return request\n' }]
    });
    assert.ok(!attachedFiles.digestText, 'attached mode produced a digest map');
    assert.ok(!attachedFiles.digestStats, 'attached mode produced digest stats');
    await agent.runSkill(attachedRun, archSkill, {
        idea: 'Evaluate this codebase.',
        answers: [],
        requirementsText: 'Must support 10x current load.',
        sourceFiles: attachedFiles,
        signal: new AbortController().signal
    }, { onRender() {}, onStep() {}, onStream() {} });
    const attachedPrompt = requests[0].message;
    assert.match(attachedPrompt, /## Attached source/, 'attached mode lost its original heading');
    assert.ok(attachedPrompt.indexOf('Codebase map') < 0, 'attached mode injected a digest map');
    assert.ok(attachedPrompt.indexOf('def handle(request):') >= 0, 'attached mode lost the attached file');
    assert.ok(attachedPrompt.indexOf('never_attached') < 0,
        'attached mode pulled in a project file the user never attached');
    assert.ok(attachedRun.phases.some(step => /^Reading 1 project source file$/.test(step.label)),
        'attached mode lost its original run-trace step');

    console.log('agent-flow.test.cjs: 14 run-flow groups passed');
    console.log(`  model turns exercised : ${requests.length + 20}+`);
    console.log('  paths verified        : docs/prd/, docs/backlog/, docs/onboarding/');
    console.log('  failure paths         : abort, no-endpoint, HTTP 500, missing source, missing PRD');
    console.log('  whole-codebase digest : map reaches the prompt, scope narrows it, attached mode intact');

    // The pending clarifying-question run from step 3 is still awaiting an
    // answer; exit explicitly so it cannot hold the loop open.
    process.exit(0);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
