'use strict';

/*
 * Codalio Blueprint — import pruning & walk ordering test.
 *
 * The bug this pins: a real project import produced ZERO project source.
 *
 *   work_on_rag-main  [TARGET] [INCOMPLETE]  154
 *     .agents  .codex_artifact_work  .github  .minnow
 *     .pytest_tmp  .runtime  .venv-gemma4
 *
 * Two independent defects caused it:
 *
 *   1. IMPORT_SKIP_DIRS matched directory names EXACTLY, so `.venv-gemma4`
 *      was not recognised as `.venv` and was walked instead of pruned. It
 *      held 36,050 files. The same machine carries `.venv`,
 *      `.venv-py314-backup-20260703-080727` and `.venv-snowfox-gemma4-rocm`,
 *      so no exact-name list could have covered it.
 *
 *   2. The walker processed entries in raw filesystem order. Dot-directories
 *      sort before letters, so all seven were consumed first, and the byte
 *      budget closed (2 MB -> 154 files) before `GUI`, `TrainingModel` or
 *      `tools` were ever reached.
 *
 * Group 1-3: pattern pruning, pyvenv.cfg marker detection, no false positives.
 * Group 4-5: walk ordering, so a budget cut costs noise rather than source.
 * Group 6:   the legacy <input webkitdirectory> path behaves the same.
 * Group 7-8: two regressions found while building this, both of which shipped
 *            broken code that the rest of the suite would NOT have caught.
 *
 * Run: node tests/import-pruning.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');
const { createDocument, createLocalStorage } = require('./dom-stub.cjs');

// ---------------------------------------------------------------------------
// Harness (same shape as folders.test.cjs so both run under identical
// conditions).
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
        fetch: async () => { throw new Error('import-pruning.test.cjs makes no network calls'); },
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

/** A File-ish object shaped like what <input webkitdirectory> produces. */
function fakeFile(relativePath, content, options) {
    const cfg = options || {};
    const bytes = new TextEncoder().encode(String(content)).length;
    return {
        name: relativePath.split('/').pop(),
        webkitRelativePath: relativePath,
        size: cfg.size === undefined ? bytes : cfg.size,
        text: async () => {
            if (cfg.unreadable) throw new Error('the file is locked');
            return String(content);
        }
    };
}

/** A FileSystemDirectoryHandle-ish tree, built from a nested descriptor. */
function fakeHandle(name, entries) {
    return {
        kind: 'directory',
        name,
        values: async function* () {
            for (const entry of entries) yield entry;
        }
    };
}

function fakeFileEntry(relativePath, content, options) {
    const cfg = options || {};
    return {
        kind: 'file',
        name: relativePath.split('/').pop(),
        getFile: async () => {
            if (cfg.locked) throw new Error('NotFoundError: file vanished');
            if (cfg.hangs) return new Promise(() => {});
            return fakeFile(relativePath, content);
        }
    };
}

/** Relative paths collected by a scan, sorted for stable comparison. */
function collectedPaths(scan) {
    return scan.files.map(file => String(file.relativePath || '')).sort();
}

// ---------------------------------------------------------------------------

const groups = [];
function group(name, fn) { groups.push({ name, fn }); }

// --- 1. Pattern pruning -----------------------------------------------------

group('virtualenv names are pruned by pattern, not exact match', () => {
    const { core } = loadCore();

    // The names that exist on a real machine, including the one that broke.
    const pruned = [
        '.venv',                       // exact list, the old behaviour
        '.venv-gemma4',                // THE BUG: 36,050 files, never pruned
        'venv-gemma4',                 // same venv without the leading dot
        '.venv-py314-backup-20260703-080727',
        '.venv-snowfox-gemma4-rocm',
        'virtualenv',
        '.virtualenvs',
        'env-local',
        '.env-prod',
        'pyenv',
        'node_modules',
        '__pycache__',
        '.mypy_cache',
        '.pytest_cache',
        '.pytest_tmp',
        '.pytest_tmp_setup_truly_final',
        '.ruff_cache',
        'ragworkspace-service.exe_extracted',
        'electron_dist',
        'electron_dist_unload_fix',
        'build',
        'dist',
        'tmp',
        'tmp_logs',
        '.tmp'
    ];
    pruned.forEach(name => {
        assert.equal(core.isSkippedDirName(name), true,
            `"${name}" was not pruned; a generated directory would consume the import budget`);
    });

    // Real source directories MUST survive. A false positive here is worse than
    // the original bug: it silently drops the user's own code.
    const kept = [
        'GUI', 'TrainingModel', 'tools', 'tests', 'src', 'scripts', 'skills',
        'examples', 'databases', 'SimpleUI', 'chat_backend', 'electron_app',
        'public', 'components', 'assets', 'docs', 'app', 'packaging', 'outputs',
        'scratch', 'TestCLI', 'PDF_parser', 'design-qa-assets', 'runtime_assets',
        '.github', '.vscode', '.agents', 'bin'
    ];
    kept.forEach(name => {
        assert.equal(core.isSkippedDirName(name), false,
            `"${name}" is real source but was pruned — a false positive`);
    });

    // Case-insensitive, as filesystems are on Windows.
    assert.equal(core.isSkippedDirName('.VENV-GEMMA4'), true, 'pruning was case-sensitive');
    assert.equal(core.isSkippedDirName('Node_Modules'), true, 'pruning was case-sensitive');
    // Empty and non-strings must not throw.
    assert.equal(core.isSkippedDirName(''), false);
    assert.equal(core.isSkippedDirName(null), false);
    assert.equal(core.isSkippedDirName(undefined), false);
});

group('isSkippedPath only applies directory rules to DIRECTORIES', () => {
    const { core } = loadCore();

    // Regression: the basename used to be tested as if it were a directory, so
    // these legitimate FILES were pruned.
    assert.equal(core.isSkippedPath('secure/.env.example'), false,
        'a shareable dotenv template was pruned because its FILENAME looks like a venv dir');
    assert.equal(core.isSkippedPath('proj/build.js'), false,
        'build.js was pruned by the "build" directory rule');
    assert.equal(core.isSkippedPath('proj/dist.py'), false, 'dist.py was pruned');
    assert.equal(core.isSkippedPath('proj/out.md'), false, 'out.md was pruned');
    assert.equal(core.isSkippedPath('proj/target.rs'), false, 'target.rs was pruned');
    assert.equal(core.isSkippedPath('README/build'), false, 'a file under a normal dir was pruned');
    assert.equal(core.isSkippedPath('.env.example'), false, 'a bare template filename was pruned');

    // Directories in the middle of a path are still pruned, at any depth.
    assert.equal(core.isSkippedPath('proj/node_modules/pkg/index.js'), true);
    assert.equal(core.isSkippedPath('proj/.venv-gemma4/Lib/site.py'), true,
        'a nested file inside a pattern-matched venv was not pruned');
    assert.equal(core.isSkippedPath('a/b/c/__pycache__/mod.pyc'), true);
    assert.equal(core.isSkippedPath('proj/tmp/x.log'), true);

    // Real source paths survive.
    assert.equal(core.isSkippedPath('proj/src/main.py'), false);
    assert.equal(core.isSkippedPath('GUI/app.js'), false);
    assert.equal(core.isSkippedPath('proj/electron_app/main.js'), false,
        'electron_app was pruned by the electron_dist pattern');
});

// --- 2. pyvenv.cfg marker ---------------------------------------------------

group('pyvenv.cfg identifies a virtualenv no matter what it is named', async () => {
    const { core } = loadCore();

    // A venv with a name NO pattern could anticipate: a bare model name, with no
    // "venv"/"env" token at all. Only the pyvenv.cfg marker gives it away.
    // The tree is built with real nested handles, because the walker derives
    // each file's relativePath from entry.name + the parent prefix.
    const oddlyNamedVenv = fakeHandle('repo', [
        fakeFileEntry('repo/README.md', '# Real project'),
        fakeHandle('snowfox-gemma4-rocm', [
            fakeFileEntry('repo/snowfox-gemma4-rocm/pyvenv.cfg', 'home = C:\\Python312'),
            fakeHandle('Lib', [
                fakeFileEntry('repo/snowfox-gemma4-rocm/Lib/site.py', 'import site')
            ]),
            fakeHandle('Scripts', [
                fakeFileEntry('repo/snowfox-gemma4-rocm/Scripts/activate.sh', 'export PATH=...')
            ])
        ]),
        fakeHandle('src', [
            fakeFileEntry('repo/src/main.py', 'print(1)')
        ])
    ]);

    const scan = await core.collectFilesFromDirectoryHandle(oddlyNamedVenv, {});
    const paths = collectedPaths(scan);
    assert.equal(scan.error, '', `the scan failed: ${scan.error}`);
    assert.ok(paths.includes('repo/README.md'), 'the real root file was lost');
    assert.ok(paths.includes('repo/src/main.py'), 'the real source file was lost');
    assert.ok(!paths.some(p => p.includes('snowfox-gemma4-rocm')),
        `a pyvenv.cfg-marked venv was imported: ${paths.join(', ')}`);
    assert.ok(scan.prunedDirs >= 1, 'the marker-pruned directory was not counted');

    // Picking a virtualenv DIRECTLY must say so, not "that folder has no files".
    const pickedVenv = fakeHandle('.venv-gemma4', [
        fakeFileEntry('.venv-gemma4/pyvenv.cfg', 'home = C:\\Python312'),
        fakeHandle('Lib', [
            fakeFileEntry('.venv-gemma4/Lib/site.py', 'import site')
        ])
    ]);
    const venvScan = await core.collectFilesFromDirectoryHandle(pickedVenv, {});
    assert.equal(venvScan.files.length, 0, 'a picked virtualenv produced importable files');
    assert.equal(venvScan.rootIsVenv, true, 'the root venv was not flagged');
    assert.match(String(venvScan.error), /virtual environment/i,
        `the error did not explain the situation: ${venvScan.error}`);
    assert.match(String(venvScan.error), /CONTAINS it/i,
        'the error did not tell the user what to do instead');
});

group('the flat input path detects venvs from pyvenv.cfg too', async () => {
    const { core } = loadCore();

    // Use a venv whose NAME matches no skip pattern (a bare model name), so the
    // detection is provably the pyvenv.cfg MARKER and not the name pattern. If
    // this used `.venv-gemma4`, the pattern would prune it first and the marker
    // counter would never be exercised.
    const roots = core.venvRootsFromFlatList([
        fakeFile('repo/README.md', '# doc'),
        fakeFile('repo/snowfox-gemma4-rocm/pyvenv.cfg', 'home = /usr/bin'),
        fakeFile('repo/snowfox-gemma4-rocm/Lib/site.py', 'import site'),
        fakeFile('repo/src/main.py', 'print(1)')
    ]);
    assert.ok(roots.has('repo/snowfox-gemma4-rocm/'),
        `the venv root was not derived from pyvenv.cfg: ${JSON.stringify([...roots])}`);
    // The marker-derived root is NOT caught by the name pattern alone.
    assert.equal(core.isSkippedPath('repo/snowfox-gemma4-rocm/Lib/site.py'), false,
        'this venv name matched a pattern, so the test would not exercise the marker');
    assert.equal(core.isUnderVenvRoot('repo/snowfox-gemma4-rocm/Lib/site.py', roots), true);
    assert.equal(core.isUnderVenvRoot('repo/src/main.py', roots), false,
        'a real source file was reported as inside the venv');

    // End to end through importFolder: the marker, not the name, does the work.
    const result = await core.importFolder([
        fakeFile('repo/README.md', '# doc'),
        fakeFile('repo/snowfox-gemma4-rocm/pyvenv.cfg', 'home = /usr/bin'),
        fakeFile('repo/snowfox-gemma4-rocm/Lib/site.py', 'import site'),
        fakeFile('repo/snowfox-gemma4-rocm/Scripts/activate.sh', 'export PATH=...'),
        fakeFile('repo/src/main.py', 'print(1)')
    ], 'repo', {});
    assert.equal(result.error, '', `import failed: ${result.error}`);
    const imported = result.imported.map(item => item.path);
    assert.ok(imported.includes('README.md'), 'the real doc was not imported');
    assert.ok(imported.includes('src/main.py'), 'the real source was not imported');
    assert.ok(!imported.some(p => p.includes('snowfox-gemma4-rocm')),
        `marker-detected venv files were imported: ${imported.join(', ')}`);
    assert.ok(result.generatedSkipped >= 2,
        `venv files were not counted via the marker: ${result.generatedSkipped}`);

    // Picking a venv root directly is reported as such.
    const direct = await core.importFolder([
        fakeFile('.venv-gemma4/pyvenv.cfg', 'home = /usr/bin'),
        fakeFile('.venv-gemma4/Lib/site.py', 'import site')
    ], '.venv-gemma4', {});
    assert.equal(direct.rootIsVenv, true, 'a directly-picked venv was not flagged');
});

group('a frozen PyInstaller bundle is pruned by base_library.zip', async () => {
    const { core } = loadCore();

    // The real-world shape: electron_app/backend/_internal held 6,882 files of
    // vendored interpreter and third-party .py, and its name says nothing about
    // being generated. Only the marker gives it away.
    const root = fakeHandle('electron_app', [
        fakeFileEntry('electron_app/main.js', 'const { app } = require("electron");'),
        fakeHandle('backend', [
            fakeFileEntry('electron_app/backend/service.py', 'import sys'),
            fakeHandle('_internal', [
                fakeFileEntry('electron_app/backend/_internal/base_library.zip', 'zip'),
                fakeFileEntry('electron_app/backend/_internal/python312.dll', 'binary'),
                fakeHandle('numpy', [
                    fakeFileEntry('electron_app/backend/_internal/numpy/core.py', 'vendored')
                ])
            ])
        ]),
        fakeHandle('src', [fakeFileEntry('electron_app/src/renderer.js', 'export const r = 1;')])
    ]);

    const scan = await core.collectFilesFromDirectoryHandle(root, {});
    const paths = collectedPaths(scan);
    assert.equal(scan.error, '', `the scan failed: ${scan.error}`);
    assert.ok(paths.includes('electron_app/main.js'), 'the real root file was lost');
    assert.ok(paths.includes('electron_app/backend/service.py'), 'real backend source was lost');
    assert.ok(paths.includes('electron_app/src/renderer.js'), 'real renderer source was lost');
    assert.ok(!paths.some(p => p.includes('_internal')),
        `a frozen bundle was imported: ${paths.join(', ')}`);

    // Marker predicate itself.
    assert.equal(core.isGeneratedTreeMarker(new Set(['base_library.zip', 'python312.dll'])), true);
    assert.equal(core.isGeneratedTreeMarker(new Set(['pyvenv.cfg'])), true);
    assert.equal(core.isGeneratedTreeMarker(new Set(['package.json', 'main.js'])), false,
        'an ordinary source directory was flagged as generated');
    assert.equal(core.isGeneratedTreeMarker(new Set([])), false);

    // Picking a frozen bundle directly must say what it is.
    const pickedBundle = fakeHandle('_internal', [
        fakeFileEntry('_internal/base_library.zip', 'zip'),
        fakeHandle('numpy', [fakeFileEntry('_internal/numpy/core.py', 'vendored')])
    ]);
    const bundleScan = await core.collectFilesFromDirectoryHandle(pickedBundle, {});
    assert.equal(bundleScan.files.length, 0, 'a picked frozen bundle produced importable files');
    assert.equal(bundleScan.rootIsFrozenBundle, true, 'the frozen bundle root was not flagged');
    assert.equal(bundleScan.rootIsVenv, false, 'a bundle was misreported as a virtualenv');
    assert.match(String(bundleScan.error), /frozen Python application bundle/i,
        `the error did not explain the situation: ${bundleScan.error}`);

    // Flat path parity.
    const generated = core.generatedRootsFromFlatList([
        fakeFile('app/backend/_internal/base_library.zip', 'zip'),
        fakeFile('app/backend/_internal/numpy/core.py', 'vendored'),
        fakeFile('app/backend/service.py', 'import sys')
    ]);
    assert.ok(generated.roots.has('app/backend/_internal/'),
        `the bundle root was not derived: ${JSON.stringify([...generated.roots])}`);
    assert.equal(generated.kinds.get('app/backend/_internal/'), 'bundle',
        'the bundle root was not classified as a bundle');

    const flatResult = await core.importFolder([
        fakeFile('app/backend/_internal/base_library.zip', 'zip'),
        fakeFile('app/backend/_internal/numpy/core.py', 'vendored'),
        fakeFile('app/backend/service.py', 'import sys'),
        fakeFile('app/README.md', '# app')
    ], 'app', {});
    assert.equal(flatResult.error, '', `flat import failed: ${flatResult.error}`);
    const flatImported = flatResult.imported.map(item => item.path).sort();
    assert.equal(JSON.stringify(flatImported), JSON.stringify(['README.md', 'backend/service.py']),
        `the flat path imported bundle files or dropped source: ${flatImported.join(', ')}`);
    assert.ok(flatResult.generatedSkipped >= 1,
        `bundle files were not counted: ${flatResult.generatedSkipped}`);
});

// --- 3. Walk ordering -------------------------------------------------------

group('real source is collected before dot-directories', async () => {
    const { core } = loadCore();

    // Reproduce the failing shape exactly: every heavy directory is a
    // dot-directory, and the real source sorts AFTER them alphabetically.
    // The walker builds relativePath from the ROOT HANDLE NAME + entry names,
    // so expectations use that prefix rather than the 'w/' in the fakeFileEntry
    // labels (those labels only supply the leaf name).
    const rootName = 'work_on_rag-main';
    const root = fakeHandle(rootName, [
        fakeHandle('.agents', [fakeFileEntry('x/config.md', 'agent config')]),
        fakeHandle('.codex_artifact_work', [fakeFileEntry('x/a.js', 'x')]),
        fakeHandle('.github', [fakeFileEntry('x/ci.yml', 'on: push')]),
        fakeHandle('.pytest_tmp', [fakeFileEntry('x/t.log', 'log')]),
        fakeHandle('.runtime', [fakeFileEntry('x/r.json', '{}')]),
        fakeHandle('zzz-last-alphabetically', [fakeFileEntry('x/late.py', 'print("late")')]),
        fakeHandle('GUI', [fakeFileEntry('x/app.js', 'export const app = 1;')]),
        fakeHandle('TrainingModel', [fakeFileEntry('x/train.py', 'import torch')]),
        fakeHandle('tools', [fakeFileEntry('x/build.py', 'import sys')])
    ]);

    const scan = await core.collectFilesFromDirectoryHandle(root, {});
    const order = scan.files.map(file => String(file.relativePath || ''));
    const paths = order.slice().sort();

    // Every real source file must be present, including the one that sorts last.
    ['GUI/app.js', 'TrainingModel/train.py', 'tools/build.py',
     'zzz-last-alphabetically/late.py'].forEach(expected => {
        assert.ok(paths.includes(`${rootName}/${expected}`),
            `real source "${expected}" was not collected: ${paths.join(', ')}`);
    });

    // The ORDER is the point: real source must come before hidden directories,
    // so a budget cut lands on the noise rather than on the user's code.
    const isHidden = relativePath => relativePath.split('/').some(core.isHiddenPathSegment);
    const firstHiddenIndex = order.findIndex(isHidden);
    let lastRealIndex = -1;
    order.forEach((relativePath, index) => {
        if (!isHidden(relativePath)) lastRealIndex = index;
    });
    assert.ok(firstHiddenIndex >= 0, 'no hidden directory was collected; the test cannot check ordering');
    assert.ok(lastRealIndex >= 0, 'no real source was collected; the test cannot check ordering');
    assert.ok(lastRealIndex < firstHiddenIndex,
        `a hidden directory was collected before real source: ${order.join(', ')}`);

    // And the five dot-directories the screenshot showed must still be
    // collected (they are tiny) — ordering is not pruning.
    ['.agents', '.github', '.runtime'].forEach(dirName => {
        assert.ok(paths.some(p => p.includes(`/${dirName}/`)),
            `${dirName} was pruned when it should merely be deferred`);
    });
});

group('a byte budget cut loses generated files, not project source', async () => {
    const { core } = loadCore();

    // 2 MB is the real import budget (IMPORT_MAX_TOTAL_KB). Build a project
    // where the dot-directories alone would exhaust it.
    const filler = 'x'.repeat(400 * 1024); // 400 KB each
    const files = [
        // Real source, small and valuable.
        fakeFile('repo/src/main.py', 'print(1)'),
        fakeFile('repo/src/util.py', 'def u(): pass'),
        fakeFile('repo/README.md', '# project'),
        // Generated noise, enormous. Listed FIRST, as a dot-directory sorts.
        fakeFile('repo/.runtime/dump1.txt', filler),
        fakeFile('repo/.runtime/dump2.txt', filler),
        fakeFile('repo/.runtime/dump3.txt', filler),
        fakeFile('repo/.runtime/dump4.txt', filler),
        fakeFile('repo/.runtime/dump5.txt', filler),
        fakeFile('repo/.runtime/dump6.txt', filler),
        // More real source, listed after the noise.
        fakeFile('repo/src/late.py', 'print("late")'),
        fakeFile('repo/tools/build.py', 'import sys')
    ];

    const result = await core.importFolder(files, 'repo', { maxTotalKb: 512 });
    assert.equal(result.error, '', `import failed: ${result.error}`);
    assert.equal(result.truncatedByBudget, true, 'the budget was never hit');

    const imported = result.imported.map(item => item.path);
    // Every real source file survived, because it was read first.
    ['src/main.py', 'src/util.py', 'README.md', 'src/late.py', 'tools/build.py'].forEach(expected => {
        assert.ok(imported.includes(expected),
            `real source "${expected}" was lost to the budget cut while noise was imported: ${imported.join(', ')}`);
    });
    // And the giant generated dumps did not crowd them out.
    const runtimeImported = imported.filter(p => p.startsWith('.runtime/'));
    assert.ok(runtimeImported.length < 2,
        `generated files consumed the budget: ${runtimeImported.join(', ')}`);
});

// --- 4. Legacy path parity --------------------------------------------------

group('the legacy input path prunes the same directories as the handle path', async () => {
    const { core } = loadCore();

    const result = await core.importFolder([
        fakeFile('repo/README.md', '# project'),
        fakeFile('repo/src/main.py', 'print(1)'),
        fakeFile('repo/.venv-gemma4/Lib/site.py', 'import site'),
        fakeFile('repo/.venv-gemma4/Scripts/activate.sh', 'export PATH'),
        fakeFile('repo/node_modules/pkg/index.js', 'module.exports = {}'),
        fakeFile('repo/.pytest_tmp/output.log', 'log'),
        fakeFile('repo/tmp/scratch.txt', 'temp'),
        fakeFile('repo/electron_dist/bundle.js', 'packed'),
        fakeFile('repo/ragworkspace-service.exe_extracted/a.dll', 'binary')
    ], 'repo', {});

    assert.equal(result.error, '', `import failed: ${result.error}`);
    const imported = result.imported.map(item => item.path).sort();
    // Compare SERIALIZED, not with deepEqual: `imported` is an Array built
    // inside the vm sandbox, so its prototype differs from this realm's and
    // strict deepEqual rejects two otherwise identical lists.
    assert.equal(JSON.stringify(imported), JSON.stringify(['README.md', 'src/main.py']),
        `the legacy path imported generated files or dropped source: ${imported.join(', ')}`);
    assert.match(result.skipped.map(s => s.reason).join(' | '), /ignored directory/,
        'pruned directories were not explained');
});

group('priority sort preserves enumeration order within a band', () => {
    const { core } = loadCore();

    // Array.prototype.sort is stable; the tiebreak must NOT alphabetize, or the
    // alias-collapse contract (first enumerated file wins) silently changes.
    const ordered = core.sortFlatListByPriority([
        fakeFile('repo/.hidden/zebra.txt', 'Z'),
        fakeFile('repo/src/main.py', 'M'),
        fakeFile('repo/.config/alpha.txt', 'A'),
        fakeFile('repo/README.md', 'R')
    ]).map(file => file.webkitRelativePath);

    assert.deepEqual(ordered, [
        'repo/src/main.py',
        'repo/README.md',
        'repo/.hidden/zebra.txt',
        'repo/.config/alpha.txt'
    ], `priority sort reordered within a band: ${ordered.join(', ')}`);

    // Navigation artifacts are not dotfiles.
    assert.deepEqual(
        core.sortFlatListByPriority([
            fakeFile('repo/./a.txt', 'A'),
            fakeFile('repo/../b.txt', 'B'),
            fakeFile('repo/.real/c.txt', 'C')
        ]).map(file => file.webkitRelativePath),
        ['repo/./a.txt', 'repo/../b.txt', 'repo/.real/c.txt'],
        'a "." or ".." segment was treated as hidden and demoted'
    );

    // Priority ordering itself.
    assert.equal(core.walkPriority('main.py', 'file'), 0);
    assert.equal(core.walkPriority('src', 'directory'), 1);
    assert.equal(core.walkPriority('.gitignore', 'file'), 2);
    assert.equal(core.walkPriority('.github', 'directory'), 3);
    assert.ok(core.walkPriority('src', 'directory') < core.walkPriority('.github', 'directory'),
        'a real directory was not preferred over a hidden one');
});

// --- 5. Regressions found while building this -------------------------------

group('cancelling a scan rejects instead of resolving as a partial success', async () => {
    const { core } = loadCore();

    const controller = new AbortController();
    const scan = core.collectFilesFromDirectoryHandle(fakeHandle('repo', [
        fakeFileEntry('repo/hangs.js', 'x', { hangs: true })
    ]), { signal: controller.signal, operationTimeoutMs: 5000 });
    setTimeout(() => controller.abort(), 0);

    const outcome = await Promise.race([
        scan.then(() => null, error => error),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('a cancelled scan hung instead of rejecting')), 400))
    ]);
    assert.ok(outcome && outcome.code === 'aborted',
        `a cancelled scan resolved instead of rejecting with code "aborted": ${outcome}`);

    // A slow SINGLE file must still not abort the whole scan: that is the
    // documented resilience contract, and it is why scan-timeout is not
    // propagated from getFile().
    const slow = await core.collectFilesFromDirectoryHandle(fakeHandle('repo', [
        fakeFileEntry('repo/locked.db', 'x', { locked: true }),
        fakeFileEntry('repo/good.py', 'print(1)')
    ]), { operationTimeoutMs: 5000 });
    assert.equal(slow.unreadable, 1, 'a locked file was not counted as unreadable');
    assert.equal(slow.files.length, 1, 'one locked file aborted the rest of the scan');
});

group('the entry cap does not discard an already-collected listing', async () => {
    const { core } = loadCore();

    // Build a root with more entries than the cap, all of them real files.
    const entries = [];
    for (let index = 0; index < 12; index += 1) {
        entries.push(fakeFileEntry(`repo/file${String(index).padStart(2, '0')}.py`, 'print(1)'));
    }
    const scan = await core.collectFilesFromDirectoryHandle(
        fakeHandle('repo', entries),
        { maxEntries: 8 }
    );
    assert.equal(scan.entryLimitReached, true, 'the entry cap was not reported');
    assert.ok(scan.files.length > 0,
        'the entry cap discarded the whole listing instead of returning what it collected');
    assert.ok(scan.files.length <= 8,
        `the entry cap was exceeded: ${scan.files.length} files`);
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
    console.log(`\nimport-pruning.test.cjs: ${passed} groups passed`);
    if (failures.length) {
        failures.forEach(({ name, error }) => {
            console.log(`\n--- ${name} ---`);
            console.log(error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : error);
        });
        process.exit(1);
    }
})();
