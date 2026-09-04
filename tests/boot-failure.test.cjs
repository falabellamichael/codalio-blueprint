'use strict';

/*
 * Codalio Blueprint — boot failure diagnostics.
 *
 * registration.test.cjs loads the SimpleRAG host BEFORE the plug-in, so it can
 * never reach the two failure paths in controller.js. This suite does the
 * opposite: it loads the plug-in into a world with no host, and with an
 * incomplete package, and asserts that Blueprint EXPLAINS ITSELF ON THE PAGE.
 *
 * This is the exact situation in the reported bug: SimpleRAG's own app.bundle.js
 * failed to parse, so window.RAGWorkspaceExtensions never existed, and Blueprint
 * logged one console line and vanished — leaving a blank Advanced page with the
 * reason buried in DevTools.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument } = require('./dom-stub.cjs');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');
const PANEL_ID = 'codalio-blueprint-boot-failure';

function readSource(name) {
    return fs.readFileSync(path.join(SRC, name), 'utf8');
}

/**
 * Build a minimal world and load the plug-in modules named in `modules`.
 *
 * `withHost` controls whether window.RAGWorkspaceExtensions exists, which is the
 * variable under test. document is a real (stubbed) DOM, because the failure panel
 * appends to document.body.
 */
function boot({ modules, withHost, document: injectedDocument }) {
    const documentStub = injectedDocument || createDocument();
    const errors = [];

    const sandbox = {
        window: null,
        document: documentStub,
        localStorage: {
            _d: new Map(),
            getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
            setItem(k, v) { this._d.set(k, String(v)); },
            removeItem(k) { this._d.delete(k); },
            get length() { return this._d.size; },
            key(i) { return [...this._d.keys()][i] ?? null; }
        },
        console: {
            log: () => {}, warn: () => {},
            error: (...args) => { errors.push(args.map(String).join(' ')); }
        },
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
        setTimeout: (fn) => { try { fn(); } catch (err) { errors.push(String(err)); } return 0; },
        clearTimeout: () => {},
        requestAnimationFrame: fn => { fn(0); return 0; },
        cancelAnimationFrame: () => {},
        navigator: { clipboard: { writeText: async () => {} } },
        Blob: function Blob() {},
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
        location: { origin: 'http://127.0.0.1:18411', hostname: '127.0.0.1' },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;

    // The host object is deliberately ABSENT when withHost is false — that is the
    // condition being tested. A partial host (present but missing methods) is also
    // exercised below, since the controller checks specific method types.
    if (withHost === 'partial') {
        sandbox.RAGWorkspaceExtensions = { registerController() {} };
    } else if (withHost) {
        sandbox.RAGWorkspaceExtensions = {
            registerController() {},
            registerManifest() {},
            getPage: () => null,
            getManifest: () => null
        };
    }

    const context = vm.createContext(sandbox);

    if (modules.includes('manifest')) {
        const pluginManifest = JSON.parse(readSource('plugin.json'));
        const template = readSource('manifest.template.js');
        const PLACEHOLDER = '/*__MANIFEST_JSON__*/null';
        assert.ok(template.includes(PLACEHOLDER), 'manifest.template.js lost its placeholder');
        vm.runInContext(
            template.replace(PLACEHOLDER, JSON.stringify(pluginManifest)),
            context, { filename: 'manifest.js' }
        );
    }
    for (const name of modules) {
        if (name === 'manifest') continue;
        vm.runInContext(readSource(name), context, { filename: name });
    }
    return { sandbox, documentStub, errors };
}

// Every module the installer ships, in installer order. controller.js LAST, since
// it is the module that performs the boot checks under test — omitting it (as an
// earlier draft of this file did) means the failure path never runs and every
// assertion below passes vacuously against a null panel.
const FULL = [
    'manifest', 'controller-core.js', 'skills.js', 'settings.js', 'agent.js',
    'preview.js', 'ui.js', 'workspace.js', 'settings-page.js', 'controller.js'
];

function panelOf(documentStub) {
    return documentStub.getElementById(PANEL_ID);
}

function textOf(node) {
    const parts = [];
    (function walk(current) {
        if (!current) return;
        if (current.nodeType === 3) parts.push(current.textContent);
        (current.children || []).forEach(walk);
    })(node);
    return parts.join(' ');
}

// ---------------------------------------------------------------------------
// 1. No host at all — the reported scenario
// ---------------------------------------------------------------------------

{
    const { documentStub, errors } = boot({ modules: FULL, withHost: false });
    const panel = panelOf(documentStub);
    assert.ok(panel, 'no host: Blueprint logged an error but rendered nothing on the page');
    assert.equal(panel.getAttribute('role'), 'alert', 'the panel is not announced as an alert');

    const text = textOf(panel);
    assert.match(text, /Codalio Blueprint did not load/, 'the panel does not say what failed');
    assert.match(text, /RAGWorkspaceExtensions/, 'the panel does not name the missing host object');
    assert.match(text, /app\.bundle\.js/, 'the panel does not point at the likely real cause');

    // Actionable: it must tell the user what to do next.
    assert.match(text, /reload|reinstall|install/i, 'the panel offers no way forward');

    assert.ok(errors.some(line => line.includes('extension host is unavailable')),
        'the console line that DevTools users rely on was dropped');

    // Inline styles, not .cb- classes: the plug-in stylesheet may itself have
    // failed to load, and a diagnostic depending on it would render unstyled.
    assert.ok(String(panel.style.cssText || panel.getAttribute('style') || '').length > 0,
        'the panel has no inline styling, so it would render unstyled if the CSS also failed');
    assert.ok(!String(panel.className || '').includes('cb-'),
        'the panel depends on cb- classes it cannot count on');

    // It appends to document.body, not to a host element that may not exist.
    assert.equal(panel.parentNode, documentStub.body, 'the panel was not appended to document.body');
}

// ---------------------------------------------------------------------------
// 2. A partial host (present but missing registerManifest)
// ---------------------------------------------------------------------------

{
    const { documentStub } = boot({ modules: FULL, withHost: 'partial' });
    const panel = panelOf(documentStub);
    assert.ok(panel, 'a host missing registerManifest was accepted silently');
    assert.match(textOf(panel), /RAGWorkspaceExtensions/, 'the partial-host panel does not name the host');
}

// ---------------------------------------------------------------------------
// 3. Incomplete package — names exactly what is missing
// ---------------------------------------------------------------------------

{
    // The incomplete-package check lives IN controller.js, so it must be loaded
    // while skills/agent/ui are deliberately withheld.
    const { documentStub, errors } = boot({
        modules: ['manifest', 'controller-core.js', 'controller.js'],
        withHost: true
    });
    const panel = panelOf(documentStub);
    assert.ok(panel, 'an incomplete package rendered no diagnostic');
    const text = textOf(panel);
    assert.match(text, /incomplete/i, 'the panel does not say the package is incomplete');
    ['skills', 'agent', 'ui'].forEach(name => {
        assert.ok(text.includes(name), `the panel does not name the missing module "${name}"`);
    });
    assert.ok(!text.includes('controller-core'), 'controller-core loaded fine but is reported missing');
    assert.ok(!text.includes('manifest'), 'manifest loaded fine but is reported missing');
    assert.match(text, /install/i, 'the panel offers no way forward');
    assert.ok(errors.some(line => line.includes('incomplete package')),
        'the console line for an incomplete package was dropped');
}

// ---------------------------------------------------------------------------
// 4. The panel renders exactly once
// ---------------------------------------------------------------------------

{
    const { documentStub } = boot({ modules: FULL, withHost: false });
    const before = documentStub.body.children.filter(c => c.id === PANEL_ID).length;
    assert.equal(before, 1, 'the first boot did not render exactly one panel');

    // The guard that makes that true: showBootFailure returns early when the id is
    // already present, so a second controller load cannot stack a second panel.
    const source = readSource('controller.js');
    assert.ok(source.includes(`document.getElementById('${PANEL_ID}')`),
        'controller.js lost its duplicate-panel guard');
}

// ---------------------------------------------------------------------------
// 5. A healthy boot renders NO panel
// ---------------------------------------------------------------------------

{
    const { documentStub } = boot({ modules: FULL, withHost: true });
    assert.equal(panelOf(documentStub), null,
        'a healthy boot rendered the failure panel — it would cover the real page');
}

// ---------------------------------------------------------------------------
// 6. The diagnostic cannot throw
// ---------------------------------------------------------------------------

{
    // document.body missing entirely (a very early failure): showBootFailure must
    // swallow it rather than become the error it is reporting.
    const documentStub = createDocument();
    Object.defineProperty(documentStub, 'body', { value: null, configurable: true });

    let threw = null;
    let errors = [];
    try {
        ({ errors } = boot({ modules: FULL, withHost: false, document: documentStub }));
    } catch (err) {
        threw = err;
    }
    assert.equal(threw, null, `boot threw when document.body was unavailable: ${threw && threw.message}`);

    // The console diagnosis must still land even though the panel could not render.
    assert.ok(errors.some(line => line.includes('extension host is unavailable')),
        'with no document.body the console diagnosis was lost too');
    // And the panel's own failure must not be silently swallowed as a boot failure.
    assert.ok(!errors.some(line => line.includes('could not render the boot-failure panel')),
        'a missing document.body should be handled gracefully, not reported as a render error');
}

console.log('boot-failure.test.cjs: 6 groups passed');
console.log('  no host        : panel names RAGWorkspaceExtensions and points at app.bundle.js');
console.log('  partial host   : panel still renders');
console.log('  bad package    : panel names each missing module');
console.log('  healthy boot   : no panel');
console.log('  styling        : inline, cb- free, appended to document.body');
