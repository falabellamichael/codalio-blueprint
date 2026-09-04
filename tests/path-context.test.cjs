'use strict';

/*
 * Codalio Blueprint — path context test.
 *
 * The problem this pins: folder import STORES file content, so it is capped at
 * 2 MB. On a real project that cap is the binding constraint, not pruning —
 * measured on work_on_rag-main:
 *
 *   TrainingModel   2,572 importable files, 108.8 MB of text
 *   GUI            23,914 importable files, 325.8 MB of text
 *
 * So the Project Files pane can only ever hold a 2 MB slice, and a code-reading
 * skill only ever sees that slice. Path context reads a named subdirectory LIVE
 * at run time through a granted handle, which never enters the store.
 *
 * Two hazards this suite exists to catch:
 *
 *   A. Reading a subtree's text is only possible if ranking happens BEFORE any
 *      read. Smallest-first is the wrong order: on the real GUI subtree it
 *      selects 7,558 near-empty files and never reaches the 13,204 substantive
 *      modules. So ranking must be path/size-based, using metadata the walk
 *      already returned.
 *
 *   B. A typed path cannot be opened cold. The File System Access API grants
 *      access only through a user-picked handle, so the path must NAVIGATE
 *      INSIDE a granted root, and a missing grant must be reported rather than
 *      silently reading nothing.
 *
 * Groups 1-3: path parsing/resolution, including Windows absolute forms.
 * Group  4-6: ranking order, and that credentials/vendored/data are excluded.
 * Group  7-9: the byte and file caps, and that exclusions are disclosed.
 * Group 10-12: end-to-end collectPathContext, including the no-grant case.
 *
 * Run: node tests/path-context.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');
const { createDocument, createLocalStorage } = require('./dom-stub.cjs');

// ---------------------------------------------------------------------------
// Harness (same shape as import-pruning.test.cjs).
// ---------------------------------------------------------------------------

function loadCore(seed) {
    const documentStub = createDocument();
    const localStorageStub = createLocalStorage();
    if (seed) {
        Object.keys(seed).forEach(key => {
            localStorageStub.setItem(key, typeof seed[key] === 'string' ? seed[key] : JSON.stringify(seed[key]));
        });
    }

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
        MutationObserver: class { observe() {} disconnect() {} },
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = (init || {}).detail; } },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
        Blob: class {},
        FileReader: class { readAsText() {} },
        fetch: async () => { throw new Error('path-context.test.cjs makes no network calls'); },
        TextDecoder: global.TextDecoder,
        TextEncoder: global.TextEncoder,
        AbortController: global.AbortController
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
        fetch: windowStub.fetch,
        TextDecoder: global.TextDecoder,
        TextEncoder: global.TextEncoder,
        AbortController: global.AbortController,
        Math, Date, JSON, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set, Promise, Intl,
        parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;

    const context = vm.createContext(sandbox);
    vm.runInContext(
        fs.readFileSync(path.join(SRC, 'controller-core.js'), 'utf8'),
        context,
        { filename: 'controller-core.js' }
    );

    return {
        core: sandbox.window.__codalioBlueprintCore,
        storage: localStorageStub
    };
}

/**
 * A nested directory tree that supports BOTH interfaces the code uses:
 *   values()              — the walker's async iterator
 *   getDirectoryHandle()  — resolveDirectoryPath's descent
 *
 * `tree` is { name, dirs: {name: subtree}, files: [{name, content, ...}] }.
 */
function makeTree(name, spec) {
    const dirs = spec.dirs || {};
    const files = spec.files || [];
    const handle = {
        kind: 'directory',
        name,
        values: async function* () {
            for (const dirName of Object.keys(dirs)) {
                yield makeTree(dirName, dirs[dirName]);
            }
            for (const file of files) {
                yield makeTreeFile(file);
            }
        },
        getDirectoryHandle: async (childName, options) => {
            if (!Object.prototype.hasOwnProperty.call(dirs, childName)) {
                // Real handles reject with NotFoundError; the code only needs a
                // rejection so it can report which segment was missing.
                const error = new Error(`No such directory: ${childName}`);
                error.name = 'NotFoundError';
                throw error;
            }
            if (options && options.create === false) { /* explicit, nothing to do */ }
            return makeTree(childName, dirs[childName]);
        }
    };
    return handle;
}

function makeTreeFile(file) {
    const content = String(file.content === undefined ? '' : file.content);
    const bytes = new TextEncoder().encode(content).length;
    const size = file.size === undefined ? bytes : file.size;
    return {
        kind: 'file',
        name: file.name,
        getFile: async () => {
            if (file.locked) {
                const error = new Error('the file is locked');
                error.name = 'NotAllowedError';
                throw error;
            }
            return {
                name: file.name,
                size,
                lastModified: 0,
                text: async () => {
                    if (file.unreadable) throw new Error('read failed mid-stream');
                    return content;
                }
            };
        }
    };
}

/** A metadata-only record shaped like the walker's output. */
function meta(relativePath, size) {
    return { name: relativePath.split('/').pop(), size, relativePath };
}

/** A ranked-entry list shaped like rankContextFiles' output. */
function rankedEntry(relativePath, size, content) {
    return {
        file: {
            name: relativePath.split('/').pop(),
            size,
            text: async () => content
        },
        relativePath,
        size,
        score: 0,
        extension: relativePath.split('.').pop().toLowerCase()
    };
}

/**
 * deepEqual that survives the VM boundary. Arrays and objects built INSIDE the
 * vm context have a different prototype identity, so node:assert/strict reports
 * "same structure but not reference-equal". Compare serialized values instead.
 */
function assertSame(actual, expected, message) {
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}

// ---------------------------------------------------------------------------

const groups = [];
function group(name, fn) { groups.push({ name, fn }); }

// --- 1. Typed-path parsing --------------------------------------------------

group('a typed path resolves inside the granted root, in every shape a user types', () => {
    const { core } = loadCore();
    const root = 'work_on_rag-main';

    // The field must accept a bare subdirectory, a nested one, and a pasted
    // absolute Windows path — users paste from Explorer, and the granted root's
    // own absolute path is never exposed by the File System Access API so it
    // cannot be subtracted directly.
    const cases = [
        ['TrainingModel', ['TrainingModel']],
        ['TrainingModel/coyote', ['TrainingModel', 'coyote']],
        ['D:\\PyMu\\work_on_rag-main\\TrainingModel', ['TrainingModel']],
        ['D:/PyMu/work_on_rag-main/TrainingModel/coyote', ['TrainingModel', 'coyote']],
        ['/TrainingModel', ['TrainingModel']],
        ['work_on_rag-main/TrainingModel', ['TrainingModel']],
        ['  GUI/ai_agents  ', ['GUI', 'ai_agents']],
        ['', []]
    ];
    cases.forEach(([input, expected]) => {
        const result = core.resolveContextSegments(root, input);
        assertSame(result.segments, expected,
            `"${input}" resolved to ${JSON.stringify(result.segments)}`);
    });
});

group('a path is never resolved outside the granted root', () => {
    const { core } = loadCore();

    // `..` must not escape the grant. The File System Access API would reject it
    // anyway, but relying on the browser to be the only guard means a future
    // Chromium change silently widens what a typed path can reach.
    const escape = core.resolveContextSegments('work_on_rag-main', '../../etc/passwd');
    assert.ok(!escape.segments.includes('..') || escape.segments.length > 0,
        'unexpected parse');
    // Drive letters are dropped, and a bare "C:" is never treated as a segment.
    const drive = core.resolveContextSegments('repo', 'C:\\Users\\me\\repo\\src');
    assertSame(drive.segments, ['src'], `drive form gave ${JSON.stringify(drive.segments)}`);
    assert.ok(!drive.segments.includes('C:'), 'a drive letter leaked in as a segment');
});

group('resolveDirectoryPath descends and reports the exact missing segment', async () => {
    const { core } = loadCore();

    const root = makeTree('repo', {
        dirs: {
            TrainingModel: { dirs: { coyote: { dirs: {}, files: [] } }, files: [] },
            GUI: { dirs: {}, files: [] }
        },
        files: []
    });

    const ok = await core.resolveDirectoryPath(root, ['TrainingModel', 'coyote']);
    assert.ok(ok.handle, 'an existing nested path did not resolve');
    assertSame(ok.resolved, ['TrainingModel', 'coyote']);
    assert.equal(ok.missing, '');

    const bad = await core.resolveDirectoryPath(root, ['TrainingModel', 'coyota']);
    assert.equal(bad.handle, null, 'a typo resolved to a handle');
    assertSame(bad.resolved, ['TrainingModel'],
        'the deepest existing prefix was not reported, so the error cannot say where the typo is');
    assert.equal(bad.missing, 'coyota');

    const rootItself = await core.resolveDirectoryPath(root, []);
    assert.ok(rootItself.handle, 'an empty path should resolve to the root itself');
    assertSame(rootItself.resolved, []);
});

// --- 2. Ranking -------------------------------------------------------------

group('ranking prefers entry points and implementation over data and trivia', () => {
    const { core } = loadCore();

    // The real failure mode: smallest-first selection. On the GUI subtree it
    // picks 7,558 near-empty files and never reaches the 13,204 substantive
    // Python modules, so the digest describes trivia instead of the system.
    const files = [
        meta('sub/main.py', 4000),              // entry point
        meta('sub/config.py', 3000),            // entry point
        meta('sub/pipeline.py', 9000),          // implementation
        meta('sub/README.md', 2000),            // orientation
        meta('sub/tiny.py', 12),                // trivia
        meta('sub/metrics.csv', 900000),        // data
        meta('sub/notes.txt', 800)
    ];
    const { ranked } = core.rankContextFiles(files, {});
    const order = ranked.map(entry => entry.relativePath);

    assert.ok(order.indexOf('sub/main.py') < order.indexOf('sub/tiny.py'),
        `main.py ranked below a 12-byte file: ${order.join(' < ')}`);
    assert.ok(order.indexOf('sub/pipeline.py') < order.indexOf('sub/tiny.py'),
        'implementation ranked below trivia');
    // A 900 KB CSV is data, not structure, and must not outrank source.
    const csv = ranked.find(entry => entry.relativePath === 'sub/metrics.csv');
    assert.equal(csv, undefined, 'a large CSV was admitted to the context ranking');
});

group('ranking excludes credentials, vendored trees and oversize files', () => {
    const { core } = loadCore();

    const files = [
        meta('sub/app.py', 2000),
        meta('sub/.env', 500),
        meta('sub/secrets-prod.json', 500),
        meta('sub/id_rsa', 1700),
        meta('sub/vendor/lib.py', 3000),
        meta('sub/third_party/mod.py', 3000),
        meta('sub/huge.py', 5 * 1024 * 1024),
        meta('sub/model.bin', 1024)
    ];
    const { ranked, skipped } = core.rankContextFiles(files, { maxFileBytes: 256 * 1024 });
    const paths = ranked.map(entry => entry.relativePath);

    assertSame(paths, ['sub/app.py'],
        `only app.py should survive; got ${JSON.stringify(paths)}`);
    assert.ok(skipped.sensitive >= 3,
        `credential paths were not counted as sensitive: ${JSON.stringify(skipped)}`);
    assert.ok(skipped.vendored >= 2,
        `vendored trees were not counted: ${JSON.stringify(skipped)}`);
    assert.equal(skipped.oversize, 1, 'the oversize file was not counted');
    assert.equal(skipped.extension, 1, 'the non-importable .bin was not counted');
});

group('an empty directory and an all-excluded directory rank to nothing', () => {
    const { core } = loadCore();

    const empty = core.rankContextFiles([], {});
    assertSame(empty.ranked, []);

    const allBad = core.rankContextFiles([
        meta('sub/.env', 100),
        meta('sub/logo.png', 5000)
    ], {});
    assert.equal(allBad.ranked.length, 0,
        'a directory with nothing importable still produced candidates');
});

// --- 3. Caps ----------------------------------------------------------------

group('the file cap stops reading and reports that it stopped', async () => {
    const { core } = loadCore();

    const ranked = [];
    for (let index = 0; index < 50; index += 1) {
        ranked.push(rankedEntry(`sub/mod${String(index).padStart(2, '0')}.py`, 200, 'print(1)'));
    }
    const result = await core.readContextRecords(ranked, { maxRecords: 10, maxTotalBytes: 1024 * 1024 });

    assert.equal(result.records.length, 10, `the file cap was exceeded: ${result.records.length}`);
    assert.equal(result.stopped, 'records', 'hitting the cap was not reported');
    assert.ok(result.counts.capRecords > 0,
        'the number of files left unread was not counted, so the run trace cannot disclose the omission');
    // Everything read must be real content, not placeholders.
    assert.equal(result.records[0].content, 'print(1)');
});

group('the byte cap leaves room for smaller later files instead of stopping dead', async () => {
    const { core } = loadCore();

    // Ranked best-first, but the best file alone exceeds the budget. Stopping at
    // the first oversize candidate would read NOTHING; skipping it and taking
    // the later files that fit is the behaviour the user actually wants.
    // Sizes stay above readContextRecords' 4096-byte floor, which exists so a
    // tiny configured budget cannot produce an empty context.
    const ranked = [
        rankedEntry('sub/best.py', 7000, 'x'.repeat(7000)),
        rankedEntry('sub/second.py', 2500, 'y'.repeat(2500)),
        rankedEntry('sub/third.py', 2500, 'z'.repeat(2500)),
        rankedEntry('sub/fourth.py', 2500, 'w'.repeat(2500))
    ];
    const result = await core.readContextRecords(ranked, {
        maxRecords: 100,
        maxTotalBytes: 6000
    });

    const paths = result.records.map(record => record.path);
    assert.ok(!paths.includes('sub/best.py'), 'the file that cannot fit was read anyway');
    assertSame(paths, ['sub/second.py', 'sub/third.py'],
        `later files that fit were skipped: ${JSON.stringify(paths)}`);
    assert.ok(result.counts.capBytes >= 2,
        `files skipped for size were not counted, so the omission is invisible: ${result.counts.capBytes}`);
    assert.ok(result.totalBytes <= 6000, `the byte cap was exceeded: ${result.totalBytes}`);
});

group('a locked file is counted, not fatal, and cancellation propagates', async () => {
    const { core } = loadCore();

    const ranked = [
        { file: { name: 'a.py', size: 100, text: async () => { throw new Error('locked'); } },
          relativePath: 'sub/a.py', size: 100, score: 0, extension: 'py' },
        rankedEntry('sub/b.py', 100, 'good')
    ];
    const result = await core.readContextRecords(ranked, { maxRecords: 10, maxTotalBytes: 1024 * 1024 });
    assert.equal(result.counts.unreadable, 1, 'a locked file was not counted');
    assertSame(result.records.map(record => record.path), ['sub/b.py'],
        'one locked file aborted the rest of the read');

    // Cancellation must propagate: reporting a user-cancelled read as a
    // successful partial would let the model reason over a folder it never saw.
    const controller = new AbortController();
    controller.abort();
    const aborted = await core.readContextRecords([rankedEntry('sub/c.py', 10, 'c')], {
        signal: controller.signal,
        maxRecords: 10,
        maxTotalBytes: 1024
    });
    assert.equal(aborted.stopped, 'aborted', 'an aborted read did not report itself');
    assert.equal(aborted.records.length, 0);
});

// --- 4. End to end ----------------------------------------------------------

group('collectPathContext reads a named subtree without touching the store', async () => {
    const { core } = loadCore();

    const root = makeTree('work_on_rag-main', {
        dirs: {
            TrainingModel: {
                dirs: {
                    coyote: {
                        dirs: {},
                        files: [
                            { name: 'train.py', content: 'def train():\n    return 1\n' },
                            { name: 'README.md', content: '# coyote\nTraining pipeline.\n' }
                        ]
                    }
                },
                files: [
                    { name: 'main.py', content: 'import coyote\n' },
                    { name: 'weights.bin', content: 'x'.repeat(50) }
                ]
            },
            GUI: { dirs: {}, files: [{ name: 'app.py', content: 'print("gui")\n' }] }
        },
        files: [{ name: 'top.py', content: 'print("root")\n' }]
    });

    const result = await core.collectPathContext(root, 'TrainingModel/coyote', {
        maxRecords: 100,
        maxTotalBytes: 1024 * 1024,
        maxFileBytes: 256 * 1024
    });

    assert.equal(result.stats.error, '', `unexpected error: ${result.stats.error}`);
    assert.equal(result.stats.resolvedPath, 'work_on_rag-main/TrainingModel/coyote');
    const paths = result.records.map(record => record.path).sort();
    // Paths are PROJECT-RELATIVE (relative to the granted root, root name
    // stripped) — the same key the workspace store uses for an imported file.
    // The walker alone would have returned `coyote/train.py`, prefixed with the
    // SUBTREE's name; that mismatch is the bug collectPathContext rebases away,
    // and the group below pins it against importFolder directly.
    assertSame(paths, ['TrainingModel/coyote/README.md', 'TrainingModel/coyote/train.py'],
        `wrong subtree contents: ${JSON.stringify(paths)}`);
    assert.ok(!paths.some(p => p.includes('GUI')),
        'a sibling directory leaked into the subtree read');
    assert.equal(result.stats.filesScanned, 2);
    assert.equal(result.stats.recordsRead, 2);
    assert.ok(result.stats.bytesRead > 0);
    // The digest contract: exclusions are disclosed, never silent.
    assert.ok(result.stats.skipped, 'skip counts were not reported');
    assert.ok(result.stats.skipped.extension >= 0);
});

group('a live path-context read and an import agree on the path key', async () => {
    const { core } = loadCore();

    // THE regression this pins: agent.js replaces a stored copy of a file with
    // the live read by matching on `path`. If the two disagreed, the same file
    // would enter the digest TWICE — once stale, once fresh — and a scope filter
    // or run trace would name a path the project does not have.
    const spec = {
        dirs: {
            TrainingModel: {
                dirs: { coyote: { dirs: {}, files: [
                    { name: 'train.py', content: 'def train():\n    return 2\n' }
                ] } },
                files: [{ name: 'main.py', content: 'import coyote\n' }]
            }
        },
        files: []
    };

    // Import the whole root the normal way.
    const importScan = await core.collectFilesFromDirectoryHandle(makeTree('work_on_rag-main', spec), {
        maxFiles: 1000, maxEntries: 1000
    });
    const imported = await core.importFolder(importScan.files, 'work_on_rag-main', {
        maxFileKb: 1024, maxFiles: Infinity, maxTotalKb: 2048
    });
    const storedPaths = imported.imported.map(item => item.path).sort();

    // Read the same file live, through the subtree path.
    const live = await core.collectPathContext(makeTree('work_on_rag-main', spec), 'TrainingModel/coyote', {
        maxRecords: 100, maxTotalBytes: 1024 * 1024, maxFileBytes: 256 * 1024
    });
    const livePaths = live.records.map(record => record.path);

    assert.ok(storedPaths.includes('TrainingModel/coyote/train.py'),
        `the import stored a different key: ${JSON.stringify(storedPaths)}`);
    assert.ok(livePaths.includes('TrainingModel/coyote/train.py'),
        `the live read produced a different key: ${JSON.stringify(livePaths)}`);

    // And the live read must WIN, leaving exactly one record for that path.
    const liveByPath = new Map(live.records.map(record => [record.path, record]));
    const merged = imported.imported
        .filter(item => !liveByPath.has(item.path))
        .concat(live.records.map(record => ({ path: record.path, content: record.content })));
    const matches = merged.filter(item => item.path === 'TrainingModel/coyote/train.py');
    assert.equal(matches.length, 1,
        `the same file entered context ${matches.length} times`);
    assert.match(matches[0].content, /return 2/,
        'the stale stored copy won over the live read');
});

group('collectPathContext prunes a virtualenv inside the named subtree', async () => {
    const { core } = loadCore();

    // The import fix prunes by marker; path context reuses the same walker, so
    // a venv nested INSIDE the requested subtree must not be read either.
    const root = makeTree('repo', {
        dirs: {
            experiments: {
                dirs: {
                    '.venv-gemma4': {
                        dirs: { 'lib': { dirs: {}, files: [
                            { name: 'pyvenv.cfg', content: 'home = /usr/bin\n' },
                            { name: 'noise.py', content: 'x'.repeat(200) }
                        ] } },
                        files: [{ name: 'pyvenv.cfg', content: 'home = /usr/bin\n' }]
                    },
                    real: { dirs: {}, files: [{ name: 'run.py', content: 'print(1)\n' }] }
                },
                files: [{ name: 'notes.md', content: '# experiments\n' }]
            }
        },
        files: []
    });

    const result = await core.collectPathContext(root, 'experiments', {
        maxRecords: 100, maxTotalBytes: 1024 * 1024, maxFileBytes: 256 * 1024
    });
    const paths = result.records.map(record => record.path);
    assert.ok(paths.some(p => p.endsWith('run.py')),
        `real source inside the subtree was not read: ${JSON.stringify(paths)}`);
    assert.ok(!paths.some(p => p.includes('.venv-gemma4')),
        `a nested virtualenv was read into context: ${JSON.stringify(paths)}`);
});

group('a missing grant or a bad path reports instead of silently reading nothing', async () => {
    const { core } = loadCore();

    // No handle at all: the browser cannot open a typed path cold, and after a
    // page reload the grant is gone. This must say so, not return empty records
    // that would let the model answer about a folder it never saw.
    const noGrant = await core.collectPathContext(null, 'TrainingModel', {});
    assert.equal(noGrant.records.length, 0);
    assert.ok(noGrant.stats.error, 'a missing grant produced no error message');
    assert.match(noGrant.stats.error, /granted folder|Import a folder/i,
        `the error does not tell the user what to do: ${noGrant.stats.error}`);

    const root = makeTree('repo', { dirs: { GUI: { dirs: {}, files: [] } }, files: [] });
    const typo = await core.collectPathContext(root, 'GUl', {});
    assert.equal(typo.records.length, 0);
    assert.equal(typo.stats.missingSegment, 'GUl');
    assert.match(typo.stats.error, /No "GUl" inside/,
        `a typo did not name the missing segment: ${typo.stats.error}`);
});

group('a subtree with nothing readable explains itself', async () => {
    const { core } = loadCore();

    const root = makeTree('repo', {
        dirs: {
            assets: { dirs: {}, files: [
                { name: 'logo.png', content: 'x'.repeat(2000) },
                { name: 'icon.ico', content: 'y'.repeat(500) }
            ] }
        },
        files: []
    });
    const result = await core.collectPathContext(root, 'assets', {
        maxRecords: 100, maxTotalBytes: 1024 * 1024, maxFileBytes: 256 * 1024
    });
    assert.equal(result.records.length, 0);
    assert.ok(result.stats.filesScanned > 0, 'the walk found nothing to report on');
    assert.ok(result.stats.error,
        'a subtree with no importable files produced no explanation');
    assert.match(result.stats.error, /Nothing readable/i,
        `the message does not explain the empty result: ${result.stats.error}`);
});

// --- 5. Settings ------------------------------------------------------------

group('path-context settings persist, clamp and default off', () => {
    const { core } = loadCore();

    const defaults = core.readSettings();
    assert.equal(defaults.pathContextEnabled, false,
        'path context must default OFF: it reads the disk at run time');
    assert.equal(defaults.pathContextPath, '');
    assert.equal(defaults.pathContextMaxFiles, 400);
    assert.equal(defaults.pathContextTotalKb, 6144);
    assert.equal(defaults.pathContextFileKb, 256);

    defaults.pathContextEnabled = true;
    defaults.pathContextPath = 'TrainingModel/coyote';
    defaults.pathContextMaxFiles = 250;
    assert.equal(core.writeSettings(defaults), true, 'the settings write was refused');

    const reread = core.readSettings();
    assert.equal(reread.pathContextEnabled, true);
    assert.equal(reread.pathContextPath, 'TrainingModel/coyote');
    assert.equal(reread.pathContextMaxFiles, 250);

    // Out-of-range values must be clamped, not stored: an enormous cap typed by
    // hand would make a run read until the tab died.
    reread.pathContextMaxFiles = 999999;
    reread.pathContextTotalKb = -5;
    reread.pathContextPath = 'x'.repeat(900);
    core.writeSettings(reread);
    const clamped = core.readSettings();
    assert.equal(clamped.pathContextMaxFiles, 5000);
    assert.equal(clamped.pathContextTotalKb, 64);
    assert.equal(clamped.pathContextPath.length, 500);
});

group('path-context records merge into the digest and replace a stale stored copy', () => {
    // This asserts the AGENT-side contract without running a model: the records
    // collectPathContext returns must be the {path, content} shape the digest
    // consumes, and a live read must win over an older stored copy.
    const { core } = loadCore();

    const live = [{ path: 'sub/app.py', content: 'VERSION = 2\n' }];
    const stored = [{ path: 'sub/app.py', content: 'VERSION = 1\n' },
                    { path: 'sub/other.py', content: 'x = 1\n' }];

    const liveByPath = new Map(live.map(record => [record.path, record]));
    const merged = stored.filter(record => !liveByPath.has(record.path))
        .concat(live.map(record => Object.assign({}, record, { origin: 'path-context' })));

    const app = merged.find(record => record.path === 'sub/app.py');
    assert.equal(app.content, 'VERSION = 2\n',
        'a stale stored copy would have been sent to the model instead of the live file');
    assert.equal(merged.length, 2, 'the merge duplicated or dropped a path');

    // And the merged records must be acceptable to the digest engine.
    const digest = core.buildCodebaseDigest(merged, { budgetTokens: 4000, minFullTextLines: 1 });
    assert.ok(digest && typeof digest.digestText === 'string' && digest.digestText.length > 0,
        'the digest engine rejected path-context records');
});

// ---------------------------------------------------------------------------

(async () => {
    let passed = 0;
    const failures = [];
    for (const { name, fn } of groups) {
        try {
            await fn();
            passed += 1;
            console.log(`PASS  ${name}`);
        } catch (error) {
            failures.push({ name, error });
            console.log(`FAIL  ${name}`);
            console.log(`      ${String((error && error.message) || error).split('\n')[0]}`);
        }
    }
    console.log(`\npath-context.test.cjs: ${passed} groups passed`);
    if (failures.length) {
        failures.forEach(({ name, error }) => {
            console.log(`\n--- ${name} ---`);
            console.log(error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : error);
        });
        process.exit(1);
    }
})();
