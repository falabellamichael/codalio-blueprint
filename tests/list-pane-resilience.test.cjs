'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Provide minimal globals needed by controller-core.js
global.window = global;
global.document = {
    createElement: () => ({
        style: {},
        classList: { add() {}, remove() {}, contains() { return false; } }
    })
};
const storageMap = new Map();
global.localStorage = {
    getItem(k) { return storageMap.has(String(k)) ? storageMap.get(String(k)) : null; },
    setItem(k, v) { storageMap.set(String(k), String(v)); },
    removeItem(k) { storageMap.delete(String(k)); }
};

const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'src', 'controller-core.js'));
require(path.join(ROOT, 'src', 'settings.js'));
const core = global.__codalioBlueprintCore;
const settingsSchema = global.__codalioBlueprintSettings;

console.log('--- Testing List Pane Resilience & Collapse Harmony ---');

// 1. Settings limits in controller-core
assert.equal(typeof core.DEFAULT_SETTINGS.listPaneWidth, 'number');

const s = core.readSettings();
s.listPaneWidth = 640;
core.writeSettings(s);
let saved = core.readSettings();
assert.equal(saved.listPaneWidth, 640, 'listPaneWidth should allow up to 640px to match host max');

s.listPaneWidth = 800;
core.writeSettings(s);
saved = core.readSettings();
assert.equal(saved.listPaneWidth, 640, 'listPaneWidth should clamp at 640px');

s.listPaneWidth = 100;
core.writeSettings(s);
saved = core.readSettings();
assert.equal(saved.listPaneWidth, 220, 'listPaneWidth should clamp at 220px');
console.log('PASS: controller-core clamps listPaneWidth cleanly between 220 and 640');

// 2. Schema field in settings.js
const field = settingsSchema.getField('listPaneWidth');
assert.ok(field, 'listPaneWidth field exists in settings schema');
assert.equal(field.min, 220, 'min is 220');
assert.equal(field.max, 640, 'max is 640');
console.log('PASS: settings schema defines listPaneWidth [220, 640]');

// 3. Static checks on controller.js
const controllerCode = fs.readFileSync(path.join(ROOT, 'src', 'controller.js'), 'utf8');

// Ensure commitWorkspaceMutation is NOT called on listPaneObserver resize
const observerMatch = controllerCode.match(/runtime\.listPaneObserver\s*=\s*new ResizeObserver\([\s\S]*?\n\s*\}\);/);
assert.ok(observerMatch, 'found runtime.listPaneObserver');
assert.ok(!observerMatch[0].includes('commitWorkspaceMutation'), 'ResizeObserver must NOT call commitWorkspaceMutation, which destroys the reading pane DOM');
console.log('PASS: ResizeObserver does not call commitWorkspaceMutation');

// Ensure releaseDivider preserves host inline collapse styles
assert.ok(controllerCode.includes('if (listPane && !hostToggle)'), 'releaseDivider only clears styles if no hostToggle');
console.log('PASS: releaseDivider preserves host styles when hostToggle is present');

// Ensure applyListPaneWidth checks list-pane-collapsed
assert.ok(controllerCode.includes("mainBody.classList.contains('list-pane-collapsed')"), 'applyListPaneWidth checks collapsed state');
console.log('PASS: applyListPaneWidth respects collapsed state');

// 4. CSS containment in codalio-blueprint.css
const css = fs.readFileSync(path.join(ROOT, 'src', 'codalio-blueprint.css'), 'utf8');
assert.ok(css.includes('.cb-settings-nav {') || css.includes('.cb-settings-nav,'), 'cb-settings-nav styled');
assert.ok(css.includes('.cb-settings-nav') && css.includes('overflow-x: hidden;'), 'cb-settings-nav contained with overflow-x hidden');
assert.ok(css.includes('.cb-skill-tagline') && css.includes('overflow-wrap: anywhere;'), 'skill tagline wraps anywhere');
assert.ok(css.includes('.cb-list-note') && css.includes('overflow-wrap: anywhere;'), 'list note wraps anywhere');
console.log('PASS: codalio-blueprint.css contains all list pane elements with overflow-wrap');

console.log('All List Pane Resilience tests passed successfully!');
