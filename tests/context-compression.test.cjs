'use strict';

/*
 * Codalio Blueprint — Real Anti-gravity Context Compression Test
 *
 * Verifies:
 * 1. Token estimation utility (core.estimateTokens).
 * 2. Deterministic Compaction Engine (core.buildDeterministicCompaction):
 *    - Extracts chronological user requests.
 *    - Follows strict Anti-gravity compaction schema:
 *      # Resuming from a compaction
 *      # User Requests
 *      <summary>
 *      ### 1. Task Overview
 *      ### 2. Progress
 *      ### 3. Key Findings & Decisions
 *      ### 4. Active Context
 *      ### 5. Next Steps
 *      ### 6. Commitments & Constraints
 *      </summary>
 *    - Calculates compression savings and token metrics.
 * 3. Prompt Injection (agent.injectCompactionIntoPrompt):
 *    - Correctly injects the compaction block into subsequent model prompts.
 * 4. Model & Offline Compaction (agent.compressContext).
 * 5. UI Integration:
 *    - ui.renderMessage handles role: 'compaction' and renders rich Anti-gravity card.
 *    - ui.renderAgentPage includes compact-context button.
 *    - ui.renderComposer includes /compact quick chip.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createDocument, createLocalStorage } = require('./dom-stub.cjs');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');

function createHarness() {
    const documentStub = createDocument();
    const localStorageStub = createLocalStorage();
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
        cancelAnimationFrame: () => {},
        CustomEvent: class CustomEvent { constructor(name, d) { this.type = name; this.detail = d && d.detail; } }
    };
    windowStub.window = windowStub;
    windowStub.globalThis = windowStub;
    const context = vm.createContext(windowStub);

    const coreSrc = fs.readFileSync(path.join(SRC, 'controller-core.js'), 'utf8');
    vm.runInContext(coreSrc, context, { filename: 'controller-core.js' });

    const skillsSrc = fs.readFileSync(path.join(SRC, 'skills.js'), 'utf8');
    vm.runInContext(skillsSrc, context, { filename: 'skills.js' });

    const settingsSrc = fs.readFileSync(path.join(SRC, 'settings.js'), 'utf8');
    vm.runInContext(settingsSrc, context, { filename: 'settings.js' });

    const agentSrc = fs.readFileSync(path.join(SRC, 'agent.js'), 'utf8');
    vm.runInContext(agentSrc, context, { filename: 'agent.js' });

    const uiSrc = fs.readFileSync(path.join(SRC, 'ui.js'), 'utf8');
    vm.runInContext(uiSrc, context, { filename: 'ui.js' });

    return {
        core: windowStub.__codalioBlueprintCore,
        skills: windowStub.__codalioBlueprintSkills,
        settings: windowStub.__codalioBlueprintSettings,
        agent: windowStub.__codalioBlueprintAgent,
        ui: windowStub.__codalioBlueprintUi,
        window: windowStub
    };
}

async function run() {
    console.log('--- Testing Anti-gravity Context Compression ---');

    const { core, agent, ui } = createHarness();

    // 1. Token Estimation
    const sampleText = 'The quick brown fox jumps over the lazy dog.';
    const est = core.estimateTokens(sampleText);
    assert.ok(est > 0 && est < sampleText.length, 'estimateTokens returns sensible token count');
    assert.equal(core.estimateTokens(''), 0, 'empty string is 0 tokens');
    console.log('✓ core.estimateTokens calculated accurately');

    // 2. Deterministic Compaction
    const mockMessages = [
        { id: 'm1', role: 'user', text: 'Build a high-performance RAG pipeline for local documents' },
        { id: 'm2', role: 'assistant', text: 'I will evaluate your architecture and generate a PRD.', steps: [
            { id: 's1', label: 'Analysis', text: 'Examined 12 source files across models/ and storage/' }
        ]},
        { id: 'm3', role: 'user', text: 'Make sure it includes hybrid BM25 and vector search' },
        { id: 'm4', role: 'assistant', text: 'Updated requirements to specify hybrid retrieval with reciprocal rank fusion.' },
        { id: 'm5', role: 'user', text: 'Generate the complete PRD document' },
        { id: 'm6', role: 'assistant', text: 'Synthesizing PRD…', paths: ['docs/prd/rag-pipeline.md'] }
    ];

    // Seed mock document
    core.writeFile('docs/prd/rag-pipeline.md', '# RAG Pipeline PRD\n\n## Overview\nHybrid BM25 and vector search system.', {
        origin: 'created',
        createdBy: 'blueprint'
    });

    const runObj = {
        id: 'run-test-1',
        skillId: 'prd-builder',
        skillName: 'PRD Builder',
        projectName: 'Local RAG Pipeline',
        status: 'done',
        writtenPaths: ['docs/prd/rag-pipeline.md'],
        phases: [
            { id: 'p1', label: 'User Lens', status: 'done', summary: 'Target persona analysis' },
            { id: 'p2', label: 'Technical Lens', status: 'done', summary: 'Architecture constraints' }
        ]
    };

    const compaction = core.buildDeterministicCompaction({
        messages: mockMessages,
        run: runObj,
        settings: core.readSettings()
    });

    assert.ok(compaction, 'Compaction object generated');
    assert.equal(compaction.userRequests.length, 3, `Should extract 3 user requests, got ${compaction.userRequests.length}`);
    assert.equal(compaction.userRequests[0], 'Build a high-performance RAG pipeline for local documents');
    assert.equal(compaction.userRequests[1], 'Make sure it includes hybrid BM25 and vector search');
    assert.equal(compaction.userRequests[2], 'Generate the complete PRD document');

    // Verify Anti-gravity Schema
    assert.match(compaction.rawText, /# Resuming from a compaction/, 'Compaction header matches Anti-gravity schema');
    assert.match(compaction.rawText, /# User Requests/, 'Includes # User Requests header');
    assert.match(compaction.rawText, /1\. Build a high-performance RAG pipeline/, 'Lists chronological request 1');
    assert.match(compaction.rawText, /2\. Make sure it includes hybrid BM25/, 'Lists chronological request 2');
    assert.match(compaction.rawText, /3\. Generate the complete PRD document/, 'Lists chronological request 3');
    assert.match(compaction.rawText, /<summary>/, 'Includes <summary> tag');
    assert.match(compaction.rawText, /### 1\. Task Overview/, 'Includes ### 1. Task Overview');
    assert.match(compaction.rawText, /### 2\. Progress/, 'Includes ### 2. Progress');
    assert.match(compaction.rawText, /### 3\. Key Findings & Decisions/, 'Includes ### 3. Key Findings & Decisions');
    assert.match(compaction.rawText, /### 4\. Active Context/, 'Includes ### 4. Active Context');
    assert.match(compaction.rawText, /### 5\. Next Steps/, 'Includes ### 5. Next Steps');
    assert.match(compaction.rawText, /### 6\. Commitments & Constraints/, 'Includes ### 6. Commitments & Constraints');
    assert.match(compaction.rawText, /<\/summary>/, 'Includes </summary> tag');

    assert.ok(compaction.originalTokens > 0, 'Calculates originalTokens');
    assert.ok(compaction.compactedTokens > 0, 'Calculates compactedTokens');
    assert.ok(compaction.savedPercent >= 0, 'Calculates savedPercent');
    console.log(`✓ Deterministic compaction generated adhering strictly to Anti-gravity schema (${compaction.savedPercent}% saved)`);

    // 3. Prompt Injection
    const originalPrompt = 'Write a technical specification for the vector indexer module.';
    const injected = agent.injectCompactionIntoPrompt(originalPrompt, compaction);
    assert.ok(injected.startsWith('# Resuming from a compaction'), 'Injected prompt starts with compaction header');
    assert.ok(injected.includes('Write a technical specification for the vector indexer module.'), 'Injected prompt preserves current turn prompt');
    assert.ok(injected.includes('---'), 'Compaction separated from prompt with divider');
    console.log('✓ agent.injectCompactionIntoPrompt injects compaction block cleanly');

    // 4. agent.compressContext
    const agentCompaction = await agent.compressContext({
        messages: mockMessages,
        run: runObj,
        useModel: false
    });
    assert.ok(agentCompaction && agentCompaction.rawText, 'agent.compressContext returns valid compaction');
    assert.equal(agentCompaction.userRequests.length, 3, 'Preserves all user requests');
    console.log('✓ agent.compressContext operates reliably in standalone/offline mode');

    // 5. UI Rendering
    const compactionMsg = {
        id: 'msg-compact-1',
        role: 'compaction',
        at: new Date().toISOString(),
        compaction: compaction,
        text: `⚡ Context Compacted (${compaction.savedPercent}% reduction)`
    };

    const renderedCard = ui.renderMessage(compactionMsg);
    assert.ok(renderedCard.classList.contains('cb-msg-compaction'), 'Renders with cb-msg-compaction class');
    const titleEl = renderedCard.querySelector('.cb-compaction-title strong');
    assert.match(titleEl.textContent, /Context Compacted \(Anti-gravity Protocol\)/, 'Title shows Anti-gravity protocol');
    const pills = renderedCard.querySelectorAll('.cb-compaction-pill');
    assert.equal(pills.length, 2, 'Renders request count and savings pills');
    const summaryBtn = renderedCard.querySelector('.cb-compaction-summary-btn');
    assert.ok(summaryBtn, 'Renders summary toggle button');
    console.log('✓ ui.renderMessage renders rich Anti-gravity compaction card with collapsible summary');

    // UI Header & Quick Chip
    const state = {
        run: runObj,
        messages: mockMessages,
        selectedSkillId: 'prd-builder',
        hasCompaction: true,
        compaction: compaction,
        folders: [{ id: 'default', name: 'Default Project' }],
        folderFileCounts: { default: 1 },
        activeFolderId: 'default'
    };
    const agentPage = ui.renderAgentPage(state);
    const compactHeaderBtn = agentPage.querySelector('[data-cb-action="compact-context"]');
    assert.ok(compactHeaderBtn, 'Agent header includes Compact Context button');
    assert.ok(compactHeaderBtn.classList.contains('active'), 'Active state set when compaction exists');

    const compactChip = agentPage.querySelector('.cb-quick-chip-compact');
    assert.ok(compactChip, 'Composer quick bar contains /compact chip');
    console.log('✓ UI agent header and composer render compact controls');

    console.log('\nAll Anti-gravity Context Compression tests PASSED successfully!\n');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
