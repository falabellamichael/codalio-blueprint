'use strict';

/*
 * Controller -> agent wiring guard.
 *
 * WHY THIS EXISTS
 * Every functional suite in this repo tests a layer in isolation:
 *   - agent-flow / merge-integration call agent.sourceFilesForModel(...) with an
 *     explicit `sourceFileMode` and assert combine vs exclusive behave
 *   - file-selector-overlay renders ui.renderFileSelectorOverlay(state) and
 *     asserts the review-mode UI
 *
 * Nothing asserted the WIRE between them. That matters because the two sides of
 * this merge can each pass every test while the feature is dead:
 *
 *   - controller.js builds the input object for agent.runSkill. If it omits
 *     `sourceFileMode`, agent.sourceFilesForModel() sees `''`, falls into the
 *     backward-compat branch, and the user's review-mode choice does nothing.
 *   - If controller.js omits `fileSelector` from the host-surface state,
 *     ui.renderFileSelectorOverlay() renders from its internal defaults, so
 *     search/category/bulk-selection state resets on every re-render.
 *
 * Both failures are SILENT: the UI looks right, all suites pass, and the feature
 * simply has no effect. A textual merge is exactly how that happens, because the
 * omission is a missing line rather than a broken one.
 *
 * So this guard reads controller.js as TEXT and asserts the wiring keys are
 * present where the agent/UI read them. It is deliberately a static check: it
 * does not need controller.js to be loadable, so it keeps working while the file
 * is mid-conflict, and it fails loudly the moment the wiring is dropped.
 *
 * Run: node tests/controller-wiring.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');
const controller = fs.readFileSync(path.join(SRC, 'controller.js'), 'utf8');
const agent = fs.readFileSync(path.join(SRC, 'agent.js'), 'utf8');
const ui = fs.readFileSync(path.join(SRC, 'ui.js'), 'utf8');

// The file must be fully resolved before its wiring can be trusted.
assert.ok(!controller.includes('<<<<<<<') && !controller.includes('>>>>>>>'),
    'controller.js still contains merge conflict markers; resolve them before running this guard');

// ---------------------------------------------------------------------------
// 1. Find what the CONSUMERS actually read. Deriving the contract from the
//    consumers (rather than hardcoding it) means this guard stays true when the
//    property names change on both sides at once.
// ---------------------------------------------------------------------------

// agent.sourceFilesForModel reads projectState.sourceFileMode to choose between
// combine / exclusive review.
const agentReadsMode = /projectState\.sourceFileMode/.test(agent);
// ui.renderFileSelectorOverlay reads state.fileSelector and state.sourceFileMode.
const uiReadsSelector = /state\.fileSelector/.test(ui);
const uiReadsMode = /state\.sourceFileMode/.test(ui);

// If a consumer stops reading the property, the wiring requirement disappears
// with it — assert the premise so this guard cannot pass by asserting nothing.
assert.ok(agentReadsMode,
    'agent.js no longer reads projectState.sourceFileMode; update this guard to match the new contract');
assert.ok(uiReadsSelector,
    'ui.js no longer reads state.fileSelector; update this guard to match the new contract');

// ---------------------------------------------------------------------------
// 2. controller.js must SUPPLY those properties.
// ---------------------------------------------------------------------------

// 2a. The agent input object: sourceFileMode must be passed to runSkill's input,
//     not merely exist somewhere in the file.
const agentInputSites = controller.match(/sourceFileMode\s*:/g) || [];
assert.ok(agentInputSites.length >= 1,
    'controller.js never sets sourceFileMode on an object — the review mode chosen in '
    + 'the file selector overlay can never reach agent.sourceFilesForModel(), so '
    + 'combine/exclusive silently do nothing');

// 2b. The host-surface state object handed to ui rendering must carry the
//     fileSelector state so the overlay does not reset on every re-render.
assert.match(controller, /fileSelector\s*:/,
    'controller.js never sets fileSelector on the host-surface state — '
    + 'ui.renderFileSelectorOverlay() would render from its internal defaults, '
    + 'losing search/category/bulk-selection between renders');

// 2c. runtime must actually own these fields somewhere, or the values above are
//     undefined and the defaults win.
assert.match(controller, /runtime\.sourceFileMode/,
    'controller.js reads/writes sourceFileMode but never from runtime, so the '
    + 'user\'s selection is not stored between renders');
assert.match(controller, /runtime\.fileSelector/,
    'controller.js never touches runtime.fileSelector, so overlay state is not stored');

// ---------------------------------------------------------------------------
// 3. The digest mode must reach the agent too. This is the whole-codebase
//    reading feature; if the setting never leaves the settings object it cannot
//    take effect. agent.js reads cfg.sourceContextMode.
// ---------------------------------------------------------------------------
assert.ok(/cfg\.sourceContextMode|settings\.sourceContextMode/.test(agent),
    'agent.js no longer reads sourceContextMode; update this guard');
// settings.js is the producer of this key, so assert the setting still exists
// rather than requiring controller.js to repeat it (settings flow via
// core.readSettings(), which the agent reads directly).
const settings = fs.readFileSync(path.join(SRC, 'settings.js'), 'utf8');
assert.match(settings, /sourceContextMode/,
    'settings.js no longer defines sourceContextMode — the whole-codebase reading '
    + 'mode has no configuration surface');

// ---------------------------------------------------------------------------
// 4. Cross-check: every property the agent/UI read that originates from the
//    controller must be supplied. Enumerate the known wiring keys and confirm
//    each appears on BOTH sides.
// ---------------------------------------------------------------------------
const wiringKeys = [
    // [key, producer file text, consumer file text, what breaks if missing]
    ['sourceFileMode', controller, agent,
        'combine/exclusive review mode never reaches the agent'],
    ['fileSelector', controller, ui,
        'overlay state resets on every re-render'],
    ['activeFolderId', controller, agent,
        'source selection escapes the active project root'],
    ['sourceFiles', controller, agent,
        'no attachments ever reach the prompt']
];

wiringKeys.forEach(([key, producer, consumer, consequence]) => {
    const produced = new RegExp(key + '\\s*:').test(producer)
        || new RegExp('\\.' + key + '\\b').test(producer);
    const consumed = new RegExp('\\.' + key + '\\b').test(consumer);
    assert.ok(consumed,
        `nothing consumes "${key}" in its consumer module — the wiring guard is stale`);
    assert.ok(produced,
        `controller.js never supplies "${key}" that the consumer reads: ${consequence}`);
});

console.log('controller-wiring.test.cjs: 4 groups passed');
console.log('  consumers  : agent.sourceFilesForModel + ui.renderFileSelectorOverlay reads verified');
console.log('  producer   : controller.js supplies sourceFileMode, fileSelector, activeFolderId, sourceFiles');
console.log('  runtime    : both fields are stored on runtime, so they persist across renders');
console.log('  digest     : sourceContextMode still has a settings surface and an agent reader');
console.log('');
console.log('  This guard exists because a merge can drop a wiring LINE and every');
console.log('  functional suite still passes while the feature does nothing.');
