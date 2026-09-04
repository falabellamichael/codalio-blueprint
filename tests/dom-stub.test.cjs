'use strict';

/*
 * Codalio Blueprint — DOM stub self-test.
 *
 * The controller integration test depends entirely on this stub being faithful.
 * If querySelector lies, every controller assertion passes vacuously — which is
 * worse than not testing at all. So the stub gets its own test, checked against
 * the exact selectors src/ actually uses.
 *
 * Run: node tests/dom-stub.test.cjs
 */

const assert = require('node:assert/strict');
const { createDocument, createLocalStorage, createElement } = require('./dom-stub.cjs');

const doc = createDocument();

// ---------------------------------------------------------------------------
// 1. Every selector Blueprint actually uses must parse
// ---------------------------------------------------------------------------

// Collected from src/*.js — if a new selector appears in product code it must be
// added here, and this test fails until the stub supports it.
const REAL_SELECTORS = [
    '[data-cb-role="transcript"]',
    '[data-cb-role="composer"]',
    '[data-cb-role="settings-search"]',
    '[data-cb-action]',
    '[data-cb-action="activate-tab"]',
    '[data-cb-action="confirm-modal"]',
    '[data-cb-field]',
    '[data-cb-field="path"]',
    '[data-cb-field="content"]',
    '[data-cb-field="file"]',
    '.cb-modal',
    '.cb-tree-row',
    '.cb-divider',
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    'input, select, textarea, button'
];

REAL_SELECTORS.forEach(selector => {
    assert.doesNotThrow(() => doc.querySelectorAll(selector), `failed to parse: ${selector}`);
});

// Unsupported syntax must THROW, never silently return null — a silent null is
// how an untested code path ships.
[
    'a > b',          // child combinator
    'a + b',          // adjacent sibling
    'a ~ b',          // general sibling
    '[data-x^="pre"]',// prefix match
    'div::before'     // pseudo-element
].forEach(selector => {
    assert.throws(() => doc.querySelectorAll(selector), /unsupported/, `should reject: ${selector}`);
});

// ---------------------------------------------------------------------------
// 2. Attribute selectors match elements built with dataset
// ---------------------------------------------------------------------------

const root = doc.createElement('div');
doc.body.appendChild(root);

const transcript = doc.createElement('div');
transcript.dataset.cbRole = 'transcript';
root.appendChild(transcript);
assert.equal(doc.querySelector('[data-cb-role="transcript"]'), transcript,
    'a dataset write was not visible to an attribute selector');

const composer = doc.createElement('textarea');
composer.dataset.cbRole = 'composer';
composer.value = 'an idea';
root.appendChild(composer);
assert.equal(doc.querySelector('[data-cb-role="composer"]'), composer);
assert.equal(doc.querySelector('[data-cb-role="composer"]').value, 'an idea');

// Attribute presence (no value) works too.
const actionable = doc.createElement('button');
actionable.dataset.cbAction = 'send';
root.appendChild(actionable);
assert.equal(doc.querySelectorAll('[data-cb-action]').length, 1);
assert.equal(doc.querySelector('[data-cb-action]').dataset.cbAction, 'send');

// dataset reads back what setAttribute wrote, in both directions.
const both = doc.createElement('div');
both.setAttribute('data-cb-field', 'path');
root.appendChild(both);
assert.equal(both.dataset.cbField, 'path', 'setAttribute was not reflected into dataset');
const other = doc.createElement('div');
other.dataset.cbField = 'content';
root.appendChild(other);
assert.equal(other.getAttribute('data-cb-field'), 'content', 'dataset was not reflected into an attribute');
assert.equal(doc.querySelectorAll('[data-cb-field]').length, 2);
assert.equal(doc.querySelector('[data-cb-field="content"]'), other);

// ---------------------------------------------------------------------------
// 3. closest() walks ancestors — this is how findAction resolves a click
// ---------------------------------------------------------------------------

const outer = doc.createElement('div');
outer.dataset.cbAction = 'toggle-step';
const middle = doc.createElement('div');
const inner = doc.createElement('i');
middle.appendChild(inner);
outer.appendChild(middle);
root.appendChild(outer);

assert.equal(inner.closest('[data-cb-action]'), outer, 'closest() did not find the ancestor action');
assert.equal(middle.closest('[data-cb-action]'), outer);
assert.equal(outer.closest('[data-cb-action]'), outer, 'closest() should match the node itself');
assert.equal(inner.closest('[data-cb-action="toggle-step"]'), outer);
assert.equal(inner.closest('[data-cb-action="send"]'), null, 'closest() matched the wrong action value');
assert.equal(inner.closest('.does-not-exist'), null);

// The middle-click path uses a valued action selector via closest().
const tabButton = doc.createElement('button');
tabButton.dataset.cbAction = 'activate-tab';
tabButton.dataset.tabId = 'tab-agent';
const tabLabel = doc.createElement('span');
tabButton.appendChild(tabLabel);
root.appendChild(tabButton);
assert.equal(tabLabel.closest('[data-cb-action="activate-tab"]'), tabButton);

// ---------------------------------------------------------------------------
// 4. Class and tag selectors, plus descendant combinators
// ---------------------------------------------------------------------------

const tree = doc.createElement('div');
tree.className = 'cb-tree-wrap';
const row1 = doc.createElement('div');
row1.className = 'cb-tree-row cb-tree-folder';
const row2 = doc.createElement('div');
row2.className = 'cb-tree-row cb-tree-file selected';
tree.appendChild(row1);
tree.appendChild(row2);
root.appendChild(tree);

assert.equal(doc.querySelectorAll('.cb-tree-row').length, 2, 'class selector did not match both rows');
assert.equal(doc.querySelector('.cb-tree-folder'), row1);
assert.equal(doc.querySelector('.cb-tree-file.selected'), row2, 'compound class selector failed');
assert.equal(doc.querySelector('.cb-tree-wrap .cb-tree-row'), row1, 'descendant combinator failed');
assert.equal(doc.querySelectorAll('.cb-tree-wrap .cb-tree-row').length, 2);
assert.equal(doc.querySelectorAll('div.cb-tree-row').length, 2, 'tag+class compound failed');
assert.equal(doc.querySelectorAll('span.cb-tree-row').length, 0);

// Comma-separated lists union their results.
assert.equal(doc.querySelectorAll('.cb-tree-folder, .cb-tree-file').length, 2, 'selector list did not union');

// ---------------------------------------------------------------------------
// 5. :not([attr]) focus-trap selector
// ---------------------------------------------------------------------------

const modal = doc.createElement('div');
modal.className = 'cb-modal';
const enabledBtn = doc.createElement('button');
const disabledBtn = doc.createElement('button');
disabledBtn.disabled = true;
const inputEl = doc.createElement('input');
const tabindexed = doc.createElement('div');
tabindexed.tabIndex = 0;
const negativeTabindex = doc.createElement('div');
negativeTabindex.tabIndex = -1;
[enabledBtn, disabledBtn, inputEl, tabindexed, negativeTabindex].forEach(child => modal.appendChild(child));
root.appendChild(modal);

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const focusable = modal.querySelectorAll(FOCUSABLE);
assert.ok(focusable.includes(enabledBtn), 'an enabled button was excluded from the focus trap');
assert.ok(!focusable.includes(disabledBtn), 'a disabled button was included in the focus trap');
assert.ok(focusable.includes(inputEl), 'an input was excluded from the focus trap');
assert.ok(focusable.includes(tabindexed), 'a tabindex=0 element was excluded');
assert.ok(!focusable.includes(negativeTabindex), 'a tabindex=-1 element was included in the focus trap');

// ---------------------------------------------------------------------------
// 6. id lookup, textContent, and tree bookkeeping
// ---------------------------------------------------------------------------

const named = doc.createElement('section');
named.id = 'cb-tabpanel';
root.appendChild(named);
assert.equal(doc.getElementById('cb-tabpanel'), named, 'getElementById did not find a dynamically assigned id');

const texty = doc.createElement('p');
texty.appendChild(doc.createTextNode('hello '));
const nested = doc.createElement('strong');
nested.appendChild(doc.createTextNode('world'));
texty.appendChild(nested);
assert.equal(texty.textContent, 'hello world', 'textContent did not concatenate descendants');

// Assigning textContent replaces children, like the real DOM.
texty.textContent = 'replaced';
assert.equal(texty.children.length, 1);
assert.equal(texty.textContent, 'replaced');

// innerHTML = '' clears children — Blueprint and the host both re-render this
// way, so a stub that ignored it would stack a copy of the page per render.
const clearable = doc.createElement('div');
const childA = doc.createElement('span');
const childB = doc.createElement('span');
clearable.appendChild(childA);
clearable.appendChild(childB);
assert.equal(clearable.childElementCount, 2);
clearable.innerHTML = '';
assert.equal(clearable.children.length, 0, 'innerHTML = "" did not clear children');
assert.equal(clearable.childElementCount, 0);
assert.equal(childA.parentNode, null, 'cleared children kept a parent');
assert.equal(childA.isConnected, false, 'cleared children still claimed to be connected');
// A non-empty assignment is recorded, not parsed into children.
clearable.innerHTML = '<div class="x"></div>';
assert.equal(clearable.children.length, 0, 'innerHTML should not parse markup into children');
assert.equal(clearable.innerHTML, '<div class="x"></div>', 'innerHTML was not readable back');
assert.deepEqual(clearable._htmlAssignments, ['', '<div class="x"></div>'], 'assignments were not logged');

const container = doc.createElement('div');
const a = doc.createElement('span');
const b = doc.createElement('span');
container.appendChild(a);
container.appendChild(b);
assert.equal(container.childElementCount, 2);
assert.equal(container.firstElementChild, a);
assert.equal(container.lastElementChild, b);
a.remove();
assert.equal(container.childElementCount, 1, 'remove() did not update child bookkeeping');
assert.equal(container.firstElementChild, b);

// ---------------------------------------------------------------------------
// 7. <select> derives .value from the selected option
// ---------------------------------------------------------------------------

const select = doc.createElement('select');
const opt1 = doc.createElement('option');
opt1.value = 'parallel';
const opt2 = doc.createElement('option');
opt2.value = 'sequential';
opt2.selected = true;
select.appendChild(opt1);
select.appendChild(opt2);
assert.equal(select.value, 'sequential', 'select.value did not follow the selected option');
opt2.selected = false;
opt1.selected = true;
assert.equal(select.value, 'parallel', 'select.value did not update when the selection moved');

// ---------------------------------------------------------------------------
// 8. title reflects to an attribute
// ---------------------------------------------------------------------------

const titled = doc.createElement('button');
titled.title = 'Close Project Files';
assert.equal(titled.getAttribute('title'), 'Close Project Files', '.title did not reflect to the attribute');

// ---------------------------------------------------------------------------
// 9. Event dispatch reaches document-level delegated listeners
// ---------------------------------------------------------------------------

const clicks = [];
doc.addEventListener('click', event => clicks.push(event.target));
doc.clickOn(enabledBtn);
assert.equal(clicks.length, 1, 'the delegated document click listener did not fire');
assert.equal(clicks[0], enabledBtn, 'the event target was not the clicked node');

const event = doc.clickOn(disabledBtn, { button: 1 });
assert.equal(event.button, 1, 'a middle-click was not reported');
assert.equal(event._prevented, false);
event.preventDefault();
assert.equal(event._prevented, true, 'preventDefault was not recorded');

// ---------------------------------------------------------------------------
// 10. localStorage isolation
// ---------------------------------------------------------------------------

const store = createLocalStorage();
store.setItem('a', '1');
store.setItem('b', '2');
assert.equal(store.getItem('a'), '1');
assert.equal(store.getItem('missing'), null);
assert.equal(store.length, 2);
store.removeItem('a');
assert.equal(store.getItem('a'), null);
assert.equal(store._has('b'), true);
store.clear();
assert.equal(store.length, 0);

// ---------------------------------------------------------------------------
// 11. isConnected tracks attachment
// ---------------------------------------------------------------------------

const attachable = doc.createElement('div');
assert.equal(attachable.isConnected, false, 'a detached element claimed to be connected');
root.appendChild(attachable);
assert.equal(attachable.isConnected, true, 'an attached element was not marked connected');
const grandchild = doc.createElement('span');
attachable.appendChild(grandchild);
assert.equal(grandchild.isConnected, true, 'a nested element was not marked connected');
attachable.remove();
assert.equal(attachable.isConnected, false, 'a removed element stayed connected');

// A standalone element (no document) still works.
const orphan = createElement('div', null);
orphan.appendChild(createElement('span', null));
assert.equal(orphan.childElementCount, 1);
assert.equal(orphan.isConnected, false);

console.log('dom-stub.test.cjs: 11 groups passed');
console.log(`  selectors parsed : ${REAL_SELECTORS.length} real + 5 unsupported rejected`);
console.log('  faithful to      : dataset<->attr, closest, :not([x]), select.value, title, isConnected');
