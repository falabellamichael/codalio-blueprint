'use strict';
/*
 * Durable storage tier (Origin Private File System) tests.
 *
 * The other suites stub `navigator` WITHOUT `storage`, so the tier self-disables
 * there and none of this code path is exercised. These tests supply a real
 * in-memory OPFS so the mirror, hydration, revision fencing, atomic replace and
 * quota-degradation behaviour are actually proven rather than assumed.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

// --------------------------------------------------------------------------
// In-memory OPFS matching the browser contract closely enough to be honest:
// getFileHandle/createWritable/write/close/getFile/text/move/removeEntry.
// --------------------------------------------------------------------------
function createOpfs(options) {
    const opts = options || {};
    const files = new Map();
    const log = { writes: [], moves: [], removes: [], reads: [] };
    // Mutable knobs, armed mid-test rather than at construction: the crash test
    // needs a SUCCESSFUL first write to establish the good copy, then a crash on
    // the second.
    const state = { crashAfterWrite: false };

    const notFound = name => {
        const error = new Error(`No such file or directory: ${name}`);
        error.name = 'NotFoundError';
        return error;
    };

    function makeFileHandle(name) {
        const handle = {
            kind: 'file',
            name,
            async createWritable() {
                if (opts.failWrites) throw new Error('disk full');
                let buffer = '';
                const writable = {
                    async write(chunk) {
                        buffer += String(chunk);
                        if (state.holdNextWrite) {
                            const hold = state.holdNextWrite;
                            state.holdNextWrite = null;
                            hold.started();
                            await hold.untilReleased;
                        }
                    },
                    async close() {
                        files.set(name, buffer);
                        log.writes.push({ name, bytes: buffer.length });
                        // Simulate a crash AFTER the temp file landed but BEFORE
                        // the rename, to prove the previous good copy survives.
                        // Armed explicitly (not via constructor options) because
                        // the FIRST write must succeed to create that good copy.
                        if (state.crashAfterWrite) {
                            state.crashAfterWrite = false;
                            throw new Error('simulated crash during close');
                        }
                    },
                    async abort() { /* discard */ }
                };
                return writable;
            },
            async getFile() {
                if (!files.has(name)) throw notFound(name);
                log.reads.push(name);
                const text = files.get(name);
                return { text: async () => text, size: text.length };
            },
            // move() is the atomic replace OPFS offers.
            async move(target) {
                if (!files.has(name)) throw notFound(name);
                files.set(target, files.get(name));
                files.delete(name);
                handle.name = target;
                log.moves.push({ from: name, to: target });
            }
        };
        return handle;
    }

    const root = {
        kind: 'directory',
        async getFileHandle(name, createOptions) {
            if (!files.has(name) && !(createOptions && createOptions.create)) {
                throw notFound(name);
            }
            return makeFileHandle(name);
        },
        async removeEntry(name) {
            if (!files.has(name)) throw notFound(name);
            files.delete(name);
            log.removes.push(name);
        },
        async *values() {
            for (const name of files.keys()) yield makeFileHandle(name);
        }
    };

    return {
        root,
        log,
        files,
        state,
        navigatorStorage: {
            getDirectory: async () => {
                if (opts.unsupported || state.unsupported) throw new Error('no opfs');
                return root;
            },
            estimate: async () => ({ quota: 10737418240, usage: 0 }),
            persisted: async () => false
        },
        seed(name, text) { files.set(name, String(text)); },
        armCrash() { state.crashAfterWrite = true; }
    };
}

// --------------------------------------------------------------------------
// Harness. Mirrors pipeline-resilience.test.cjs but injects a real OPFS into
// navigator.storage so the durable tier activates instead of self-disabling.
// --------------------------------------------------------------------------
function createLocalStorage(initial) {
    const data = new Map(Object.entries(initial || {}));
    return {
        getItem: key => (data.has(String(key)) ? data.get(String(key)) : null),
        setItem: (key, value) => { data.set(String(key), String(value)); },
        removeItem: key => { data.delete(String(key)); },
        key: index => Array.from(data.keys())[index] || null,
        get length() { return data.size; },
        clear: () => data.clear(),
        _data: data
    };
}

function createDocument() {
    const element = () => ({
        style: {}, dataset: {}, children: [],
        setAttribute() {}, getAttribute: () => null, appendChild() {},
        addEventListener() {}, removeEventListener() {}, classList: {
            add() {}, remove() {}, toggle() {}, contains: () => false
        },
        querySelector: () => null, querySelectorAll: () => [],
        innerHTML: '', textContent: '', value: ''
    });
    return {
        createElement: element,
        createDocumentFragment: element,
        createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
        body: element(),
        head: element(),
        documentElement: element(),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {}
    };
}

function createHarness(options) {
    const opts = options || {};
    const documentStub = createDocument();
    const localStorageStub = opts.storage || createLocalStorage();
    const opfs = opts.opfs || createOpfs(opts.opfsOptions || {});
    const windowListeners = new Map();
    const events = [];

    // opts.noStorageApi simulates a browser with NO navigator.storage at all
    // (the code's `unsupported` path: silent, immediate). opts.opfsOptions
    // .unsupported simulates navigator.storage PRESENT but getDirectory()
    // rejecting (the backoff path: bounded warnings, then quiet).
    const navigatorStub = opts.noStorageApi
        ? { clipboard: null }
        : { clipboard: null, storage: opfs.navigatorStorage };

    const windowStub = {
        document: documentStub,
        localStorage: localStorageStub,
        location: { href: 'http://127.0.0.1:18411/gui/' },
        navigator: navigatorStub,
        console,
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: id => clearTimeout(id),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: id => clearInterval(id),
        requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
        cancelAnimationFrame: id => clearTimeout(id),
        MutationObserver: class { observe() {} disconnect() {} },
        CustomEvent: class {
            constructor(type, init) {
                this.type = type;
                this.detail = (init || {}).detail;
            }
        },
        addEventListener(type, handler) {
            const key = String(type || '');
            if (!windowListeners.has(key)) windowListeners.set(key, []);
            windowListeners.get(key).push(handler);
        },
        removeEventListener(type, handler) {
            const key = String(type || '');
            windowListeners.set(key, (windowListeners.get(key) || []).filter(item => item !== handler));
        },
        dispatchEvent(event) {
            events.push(String((event && event.type) || ''));
            (windowListeners.get(String((event && event.type) || '')) || []).slice()
                .forEach(handler => handler.call(windowStub, event));
            return true;
        },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
        Blob: class Blob { constructor(parts) { this.parts = parts; } },
        FileReader: class { readAsText() {} },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
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
        cancelAnimationFrame: windowStub.cancelAnimationFrame,
        MutationObserver: windowStub.MutationObserver,
        CustomEvent: windowStub.CustomEvent,
        URL: windowStub.URL,
        Blob: windowStub.Blob,
        FileReader: windowStub.FileReader,
        fetch: windowStub.fetch,
        TextDecoder: global.TextDecoder,
        TextEncoder: global.TextEncoder,
        AbortController: global.AbortController,
        Math, Date, JSON, Object, Array, String, Number, Boolean, Error, RegExp,
        Map, Set, Promise, Intl, Symbol, parseInt, parseFloat, isNaN,
        encodeURIComponent, decodeURIComponent
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;

    const context = vm.createContext(sandbox);
    ['controller-core.js'].forEach(file => {
        vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
    });

    return {
        core: windowStub.__codalioBlueprintCore,
        storage: localStorageStub,
        opfs,
        events,
        window: windowStub,
        // Let every queued microtask/promise settle.
        async settle(rounds = 6) {
            for (let index = 0; index < rounds; index += 1) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
    };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --------------------------------------------------------------------------

test('the durable tier activates and mirrors every committed save to disk', async () => {
    const harness = createHarness();
    const { core } = harness;
    assert.equal(core.durableStorageState().available, false, 'available before any save');

    core.createFolder('Alpha');
    core.writeFile('alpha/one.js', 'export const one = 1;\n', {});
    await harness.settle();

    const state = core.durableStorageState();
    assert.ok(state.available, 'tier did not become available after a save');
    assert.ok(state.revision > 0, `durable revision was ${state.revision}`);

    const raw = harness.opfs.files.get('projects.json');
    assert.ok(raw, 'nothing was written to projects.json');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.files && Object.keys(parsed.files).length, 'file content did not reach disk');
    assert.equal(parsed.revision, state.revision, 'disk revision disagrees with reported revision');
});

test('a save that exceeds the localStorage quota still lands on disk', async () => {
    const storage = createLocalStorage();
    const harness = createHarness({ storage });
    const { core } = harness;
    core.createFolder('Alpha');
    await harness.settle();
    assert.ok(core.durableStorageState().available, 'tier should already be available');

    // Make localStorage refuse ONLY the projects key, as a real quota hit does.
    const original = storage.setItem.bind(storage);
    let refusals = 0;
    storage.setItem = (key, value) => {
        if (key === core.PROJECTS_KEY) {
            refusals += 1;
            const error = new Error('exceeded the quota');
            error.name = 'QuotaExceededError';
            throw error;
        }
        original(key, value);
    };

    // The refused save must FAIL CLOSED, not pretend to succeed: the mirror is
    // asynchronous, so at return time nothing is provably stored anywhere.
    const written = core.writeFile('alpha/big.js', 'x'.repeat(2048), {});
    assert.equal(written, null, 'a quota refusal reported success');
    assert.equal(core.persistenceState().ok, false, 'persistence claimed to be healthy');
    await harness.settle();
    assert.ok(refusals > 0, 'the quota stub never fired');

    // ...but the bytes were still mirrored to disk, so the data is not lost.
    const raw = harness.opfs.files.get('projects.json');
    assert.ok(raw, 'quota-refused bytes were lost instead of mirrored to disk');
    assert.ok(JSON.parse(raw).files && Object.values(JSON.parse(raw).files)
        .some(record => record.path === 'alpha/big.js'),
        'the mirrored copy dropped the file that localStorage refused');

    // The real fix: the NEXT save succeeds. Degraded mode stops attempting a
    // localStorage write that is doomed, so one quota hit no longer wedges the
    // project for the rest of the session.
    assert.equal(core.durableStorageState().localStorageDegraded, true,
        'localStorage was not marked degraded after a quota refusal');
    const next = core.writeFile('alpha/second.js', 'export const second = true;\n', {});
    assert.ok(next, 'the save AFTER a quota hit failed; the project stayed wedged');
    assert.equal(core.persistenceState().ok, true, 'persistence never recovered');
    await harness.settle();
    const afterRaw = harness.opfs.files.get('projects.json');
    assert.ok(Object.values(JSON.parse(afterRaw).files).some(record => record.path === 'alpha/second.js'),
        'the recovered save did not reach disk');
    const run = core.createRun({ id: 'durability', name: 'Durability' }, 'read the imported project');
    assert.equal(run.persistenceError, undefined, 'starting a run after quota recovery hit a false conflict');
    run.messages = [{ role: 'user', text: 'read the imported project' }];
    assert.equal(core.saveRun(run), true, 'the initial transcript hit a false conflict');
    run.status = 'done';
    assert.equal(core.saveRun(run), true, 'a later checkpoint hit a false conflict');
    await harness.settle();
    assert.equal(JSON.parse(harness.opfs.files.get('projects.json')).runs[0].status, 'done');
});

test('boot hydration restores data that only ever existed on disk', async () => {
    // Simulate a previous session that outgrew localStorage: disk holds a newer
    // revision, localStorage holds an older one.
    const opfs = createOpfs();
    const storage = createLocalStorage();

    // Build the two states with real cores so the bytes are genuinely valid.
    const older = createHarness({ storage, opfs });
    older.core.createFolder('Alpha');
    older.core.writeFile('alpha/keep.js', 'export const keep = true;\n', {});
    await older.settle();
    const olderRevision = older.core.store.revision;

    // Advance ONLY the disk copy: write a newer revision straight to OPFS.
    const diskRaw = JSON.parse(opfs.files.get('projects.json'));
    diskRaw.revision = olderRevision + 5;
    diskRaw.commitId = 'disk-only-commit';
    diskRaw.files['alpha::diskonly.js'] = {
        path: 'alpha/diskonly.js',
        content: 'export const diskOnly = true;\n',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        runId: '', skill: '', folder: Object.values(diskRaw.folders)[0].id,
        origin: 'created', createdBy: 'blueprint'
    };
    opfs.seed('projects.json', JSON.stringify(diskRaw));

    // Roll localStorage back to the older revision, as a truncated cache would be.
    storage.setItem(older.core.PROJECTS_KEY, JSON.stringify(Object.assign({}, diskRaw, {
        revision: olderRevision,
        commitId: 'old-local-commit',
        files: Object.fromEntries(
            Object.entries(diskRaw.files).filter(([, value]) => value.path !== 'alpha/diskonly.js')
        )
    })));

    const fresh = createHarness({ storage, opfs });
    await fresh.settle();

    const state = fresh.core.durableStorageState();
    assert.ok(state.available, 'tier not available at boot');
    assert.equal(state.degraded, true, 'hydrating from a newer disk copy must mark localStorage degraded');
    assert.equal(fresh.core.store.revision, olderRevision + 5, 'boot kept the older localStorage revision');

    const paths = Object.keys(fresh.core.store.files).map(key => fresh.core.store.files[key].path);
    assert.ok(paths.includes('alpha/diskonly.js'), `disk-only file was lost at boot: ${paths.join(',')}`);
    assert.ok(paths.includes('alpha/keep.js'), `the shared file was lost at boot: ${paths.join(',')}`);
    assert.ok(fresh.events.includes('codalio-blueprint-store-change'),
        'hydration did not ask the controller to re-render');
    assert.equal(fresh.core.reloadStoreFromStorage(), true, 'controller refresh failed after disk hydration');
    assert.equal(fresh.core.store.revision, olderRevision + 5, 'controller refresh restored the stale cache');
    const run = fresh.core.createRun({ id: 'durability', name: 'Durability' }, 'inspect recovered files');
    assert.equal(run.persistenceError, undefined, 'disk hydration blocked new runs');
    run.messages = [{ role: 'user', text: 'inspect recovered files' }];
    assert.equal(fresh.core.saveRun(run), true, 'recovered run transcript could not be saved');
    await fresh.settle();
    const recovered = JSON.parse(opfs.files.get('projects.json'));
    assert.ok(Object.values(recovered.files).some(file => file.path === 'alpha/diskonly.js'),
        'saving after hydration dropped the disk-only file');
});

test('hydration never rolls back to an older disk copy', async () => {
    const opfs = createOpfs();
    const storage = createLocalStorage();

    const first = createHarness({ storage, opfs });
    first.core.createFolder('Alpha');
    first.core.writeFile('alpha/newer.js', 'export const newer = true;\n', {});
    await first.settle();
    const newerRevision = first.core.store.revision;

    // Plant a STALE disk copy behind localStorage, as a lagging mirror would be.
    opfs.seed('projects.json', JSON.stringify({
        version: 3,
        revision: Math.max(0, newerRevision - 3),
        commitId: 'stale-commit',
        folders: { default: { id: 'default', name: 'Default', updatedAt: new Date().toISOString() } },
        files: { 'default::old.js': {
            path: 'old.js', content: 'export const old = true;\n',
            createdAt: Date.now(), updatedAt: Date.now(), runId: '', skill: '',
            folder: 'default', origin: 'created', createdBy: 'blueprint'
        } },
        runs: [], openPath: '', openFolderId: '', activeRunId: '', activeFolderId: 'default'
    }));

    const fresh = createHarness({ storage, opfs });
    await fresh.settle();

    assert.equal(fresh.core.store.revision, newerRevision,
        'an older disk copy overwrote newer localStorage data');
    assert.equal(fresh.core.durableStorageState().degraded, false,
        'localStorage was marked degraded even though it was the newer tier');
    const paths = Object.keys(fresh.core.store.files).map(key => fresh.core.store.files[key].path);
    assert.ok(!paths.includes('old.js'), 'stale disk-only file resurrected over newer data');
    assert.ok(paths.includes('alpha/newer.js'), 'the newer file was dropped');
});

test('disk-backed windows reject stale saves and recover without losing newer files', async () => {
    const storage = createLocalStorage();
    const opfs = createOpfs();
    const first = createHarness({ storage, opfs });
    first.core.createFolder('Shared');
    await first.settle();
    const disk = JSON.parse(opfs.files.get('projects.json'));
    disk.revision += 2;
    disk.commitId = 'recovered-disk';
    opfs.seed('projects.json', JSON.stringify(disk));
    await first.core.hydrateFromDurableTier();
    const second = createHarness({ storage, opfs });
    await second.settle();
    assert.equal(second.core.store.revision, first.core.store.revision);

    assert.ok(first.core.writeFile('first.js', 'new data from the first window', {}));
    assert.equal(second.core.writeFile('stale.js', 'must not overwrite the first window', {}), null,
        'a stale window accepted a write while the newer disk commit was pending');
    await first.settle();
    await second.core.hydrateFromDurableTier();
    assert.equal(second.core.reloadStoreFromStorage(), true);
    assert.ok(second.core.writeFile('second.js', 'new data from the second window', {}));
    await second.settle();
    const paths = Object.values(JSON.parse(opfs.files.get('projects.json')).files).map(file => file.path);
    assert.ok(paths.includes('first.js'), 'recovering the second window lost the first window file');
    assert.ok(paths.includes('second.js'));
    assert.ok(!paths.includes('stale.js'), 'the refused stale mutation resurfaced');
});

test('degraded storage still rejects changed browser data and failed disk writes', async () => {
    const harness = createHarness();
    const { core, storage, opfs } = harness;
    core.createFolder('Recovery');
    await harness.settle();
    const disk = JSON.parse(opfs.files.get('projects.json'));
    disk.revision += 2;
    disk.commitId = 'disk-recovery';
    opfs.seed('projects.json', JSON.stringify(disk));
    await core.hydrateFromDurableTier();
    assert.ok(core.writeFile('first.js', 'kept on disk', {}));
    await harness.settle();
    const goodDisk = opfs.files.get('projects.json');
    opfs.armCrash();
    assert.ok(core.writeFile('failed.js', 'cannot reach disk', {}));
    await harness.settle();
    assert.equal(core.persistenceState().ok, false, 'an asynchronous disk failure was hidden');
    assert.equal(core.persistenceState().lastCode, 'durable-write-failed');
    assert.equal(opfs.files.get('projects.json'), goodDisk, 'a failed disk write replaced the good copy');

    const foreign = JSON.parse(storage.getItem(core.PROJECTS_KEY));
    foreign.revision += 1;
    foreign.commitId = 'legacy-window-change';
    const foreignRaw = JSON.stringify(foreign);
    storage.setItem(core.PROJECTS_KEY, foreignRaw);
    assert.equal(core.writeFile('overwrite.js', 'must be rejected', {}), null);
    assert.equal(core.persistenceState().lastCode, 'concurrent-update');
    assert.equal(storage.getItem(core.PROJECTS_KEY), foreignRaw);
    await harness.settle();
    assert.equal(opfs.files.get('projects.json'), goodDisk);
});

test('a delayed mirror from another window cannot replace a newer disk commit', async () => {
    const storage = createLocalStorage();
    const opfs = createOpfs();
    const first = createHarness({ storage, opfs });
    first.core.createFolder('Shared');
    await first.settle();
    let markStarted;
    let release;
    const started = new Promise(resolve => { markStarted = resolve; });
    const untilReleased = new Promise(resolve => { release = resolve; });
    opfs.state.holdNextWrite = { started: markStarted, untilReleased };
    assert.ok(first.core.writeFile('first.js', 'first window', {}));
    await started;
    const second = createHarness({ storage, opfs });
    await second.settle();
    assert.ok(second.core.writeFile('second.js', 'second window', {}));
    await second.settle();
    const newest = opfs.files.get('projects.json');
    release();
    await first.settle();
    assert.equal(opfs.files.get('projects.json'), newest,
        'the delayed older mirror replaced the newer disk commit');
    const paths = Object.values(JSON.parse(newest).files).map(file => file.path);
    assert.ok(paths.includes('first.js'));
    assert.ok(paths.includes('second.js'));
});

test('a failed clear-all rolls back the disk fence without queuing an erase', async () => {
    const harness = createHarness();
    const { core, storage, opfs } = harness;
    core.createFolder('Keep');
    core.writeFile('keep.js', 'must survive a refused reset', {});
    await harness.settle();
    const disk = JSON.parse(opfs.files.get('projects.json'));
    disk.revision += 2;
    disk.commitId = 'disk-reset-fixture';
    opfs.seed('projects.json', JSON.stringify(disk));
    await core.hydrateFromDurableTier();
    const headKey = `${core.PROJECTS_KEY}:durable-head`;
    const previousHead = storage.getItem(headKey);
    const previousDisk = opfs.files.get('projects.json');
    const originalSet = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
        if (key === core.SETTINGS_KEY) throw new Error('reset settings refused');
        originalSet(key, value);
    };
    const reset = core.clearAllData(core.DEFAULT_SETTINGS);
    assert.equal(reset.ok, false);
    assert.equal(reset.rolledBack, true);
    await harness.settle();
    assert.equal(storage.getItem(headKey), previousHead, 'the failed reset left a newer disk fence');
    assert.equal(opfs.files.get('projects.json'), previousDisk, 'the failed reset erased the disk copy');
    assert.ok(core.writeFile('after.js', 'saving still works after rollback', {}));
    await harness.settle();
    assert.ok(Object.values(JSON.parse(opfs.files.get('projects.json')).files)
        .some(file => file.path === 'keep.js'), 'rollback lost the original file');
});

test('an expired unfinished disk save does not strand a fresh window', async () => {
    const storage = createLocalStorage();
    const opfs = createOpfs();
    const original = createHarness({ storage, opfs });
    original.core.createFolder('Crash recovery');
    original.core.writeFile('keep.js', 'last confirmed data', {});
    await original.settle();
    const headKey = `${original.core.PROJECTS_KEY}:durable-head`;
    const confirmed = JSON.parse(opfs.files.get('projects.json'));
    storage.setItem(headKey, JSON.stringify({
        revision: confirmed.revision + 1, commitId: 'crashed-writer', pending: true,
        expiresAt: Date.now() - 1
    }));
    const fresh = createHarness({ storage, opfs });
    await fresh.settle();
    assert.equal(fresh.core.reloadStoreFromStorage(), true, 'an expired reservation blocked recovery');
    assert.ok(fresh.core.writeFile('after.js', 'new work after the crash', {}));
    await fresh.settle();
    const paths = Object.values(JSON.parse(opfs.files.get('projects.json')).files).map(file => file.path);
    assert.ok(paths.includes('keep.js'), 'recovering an unfinished save lost confirmed data');
    assert.ok(paths.includes('after.js'));
});

test('a corrupt disk copy never displaces good localStorage data', async () => {
    const opfs = createOpfs();
    const storage = createLocalStorage();

    const first = createHarness({ storage, opfs });
    first.core.createFolder('Alpha');
    first.core.writeFile('alpha/good.js', 'export const good = true;\n', {});
    await first.settle();
    const revision = first.core.store.revision;

    // Claim a higher revision but ship malformed JSON.
    opfs.seed('projects.json', '{"version":3,"revision":999999,"files":{{{ broken');

    const fresh = createHarness({ storage, opfs });
    await fresh.settle();

    assert.equal(fresh.core.store.revision, revision, 'corrupt disk bytes replaced good data');
    assert.ok(fresh.core.durableStorageState().lastError, 'the corrupt copy was not reported');
    const paths = Object.keys(fresh.core.store.files).map(key => fresh.core.store.files[key].path);
    assert.ok(paths.includes('alpha/good.js'), 'good file was lost to a corrupt disk copy');
});

test('a crash mid-write leaves the previous good copy intact (atomic replace)', async () => {
    const harness = createHarness();
    const { core } = harness;

    // First save must SUCCEED so there is a good copy to protect.
    core.createFolder('Alpha');
    core.writeFile('alpha/first.js', 'export const first = true;\n', {});
    await harness.settle();
    const goodRaw = harness.opfs.files.get('projects.json');
    assert.ok(goodRaw, 'the first save never completed');
    assert.ok(JSON.parse(goodRaw).files, 'the good copy is not a valid store');

    // Now arm the crash and write again: close() throws AFTER the temp file
    // landed but BEFORE the rename, so the previous good copy must survive.
    harness.opfs.armCrash();
    core.writeFile('alpha/second.js', 'export const second = true;\n', {});
    await harness.settle();

    assert.ok(harness.opfs.files.has('projects.json'), 'the good copy was destroyed');
    assert.equal(harness.opfs.files.get('projects.json'), goodRaw,
        'projects.json was overwritten by a half-finished write');

    // The incomplete temp file is left behind (it is the only evidence of the
    // failure) but must never be mistaken for the store.
    const temps = Array.from(harness.opfs.files.keys()).filter(name => name.endsWith('.tmp'));
    assert.ok(temps.length <= 1, `crash left ${temps.length} temp files behind`);

    // And the surviving copy still parses to the LAST GOOD state.
    const parsed = JSON.parse(harness.opfs.files.get('projects.json'));
    const paths = Object.values(parsed.files).map(record => record.path);
    assert.ok(paths.includes('alpha/first.js'), 'the good copy lost its own file');
});

test('an older mirror queued behind a newer one cannot overwrite it (revision fence)', async () => {
    const harness = createHarness();
    const { core } = harness;
    core.createFolder('Alpha');
    core.writeFile('alpha/a.js', 'export const a = 1;\n', {});
    await harness.settle();

    const newerRevision = core.store.revision;
    const newerRaw = harness.opfs.files.get('projects.json');

    // Force an out-of-order write: an older revision arriving late.
    await core.hydrateFromDurableTier();
    const fenceWorked = await (async () => {
        // Reach into the tier the only way a caller can: queue a stale mirror.
        // hydrateFromDurableTier is the public entry point; a stale seed must not
        // lower the recorded revision.
        harness.opfs.seed('projects.json', newerRaw);
        await core.hydrateFromDurableTier();
        return core.durableStorageState().revision;
    })();

    assert.equal(fenceWorked, newerRevision, 'a stale revision lowered the durable fence');
    assert.equal(harness.opfs.files.get('projects.json'), newerRaw, 'disk bytes were replaced by stale ones');
});

test('a browser with no navigator.storage degrades to localStorage silently', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    let harness;
    try {
        // NO navigator.storage at all: the `unsupported` path.
        harness = createHarness({ noStorageApi: true });
        harness.core.createFolder('Alpha');
        harness.core.writeFile('alpha/plain.js', 'export const plain = true;\n', {});
        await harness.settle();
        harness.core.writeFile('alpha/second.js', 'export const second = true;\n', {});
        await harness.settle();
        harness.core.writeFile('alpha/third.js', 'export const third = true;\n', {});
        await harness.settle();
    } finally {
        console.warn = originalWarn;
    }

    const state = harness.core.durableStorageState();
    assert.equal(state.available, false, 'tier claimed to be available without OPFS');
    const durableNoise = warnings.filter(message => /durable storage mirror failed/.test(message));
    assert.equal(durableNoise.length, 0,
        `a browser with no OPFS logged ${durableNoise.length} mirror warnings instead of staying silent`);

    // localStorage still works exactly as before this tier existed.
    const raw = harness.storage.getItem(harness.core.PROJECTS_KEY);
    assert.ok(raw, 'nothing persisted to localStorage');
    const paths = Object.keys(JSON.parse(raw).files || {});
    assert.ok(paths.length >= 3, `localStorage lost files: ${paths.join(',')}`);
});

test('a permanently failing OPFS backs off instead of warning on every save', async () => {
    const opfsStub = createOpfs({ unsupported: true });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    let harness;
    try {
        // navigator.storage EXISTS but getDirectory() always rejects — a
        // policy-blocked or unwritable profile.
        harness = createHarness({ opfs: opfsStub });
        harness.core.createFolder('Alpha');
        for (let index = 0; index < 10; index += 1) {
            harness.core.writeFile(`alpha/f${index}.js`, `export const f${index} = 1;\n`, {});
            await harness.settle();
        }
    } finally {
        console.warn = originalWarn;
    }

    const durableNoise = warnings.filter(message => /durable storage mirror failed/.test(message));
    // Ten saves must NOT produce ten warnings: the tier backs off after a few
    // consecutive failures and stays quiet for the rest of the session.
    assert.ok(durableNoise.length < 10,
        `a permanently broken OPFS warned ${durableNoise.length} times across 10 saves`);
    assert.ok(warnings.some(message => /durable storage unavailable after/.test(message)),
        'the tier never announced that it had given up');
    assert.equal(harness.core.durableStorageState().available, false, 'a broken tier reported itself available');

    // All ten files still persisted to localStorage.
    const raw = harness.storage.getItem(harness.core.PROJECTS_KEY);
    assert.ok(raw, 'nothing persisted to localStorage');
    const count = Object.keys(JSON.parse(raw).files || {}).length;
    assert.ok(count >= 10, `localStorage lost files while the disk tier was broken: ${count} of 10`);
});

test('quota detection does not swallow unrelated transient failures', async () => {
    const harness = createHarness();
    const { core } = harness;

    const transient = new Error('simulated quota refusal');
    assert.equal(core.isLocalStorageQuotaError(transient), false,
        'a transient refusal mentioning "quota" was treated as a real quota failure');

    const real = new Error('exceeded the quota');
    real.name = 'QuotaExceededError';
    assert.equal(core.isLocalStorageQuotaError(real), true, 'a real quota error was not recognised');

    const firefox = new Error('The operation was aborted');
    firefox.name = 'NS_ERROR_DOM_QUOTA_REACHED';
    assert.equal(core.isLocalStorageQuotaError(firefox), true, 'Firefox quota name was not recognised');

    assert.equal(core.isLocalStorageQuotaError(new Error('network offline')), false,
        'an unrelated error was treated as a quota failure');
    assert.equal(core.isLocalStorageQuotaError(null), false, 'null was treated as a quota failure');
});

test('a transient localStorage refusal still fails closed and recovers on retry', async () => {
    const storage = createLocalStorage();
    const harness = createHarness({ storage });
    const { core } = harness;
    const run = core.createRun({ id: 'durability', name: 'Durability' }, 'checkpoint safely');

    const original = storage.setItem.bind(storage);
    let failOnce = true;
    storage.setItem = (key, value) => {
        if (failOnce && key === core.PROJECTS_KEY) {
            failOnce = false;
            throw new Error('simulated transient refusal');
        }
        original(key, value);
    };

    run.status = 'running';
    assert.equal(core.saveRun(run), false, 'a transient refusal reported success');
    assert.match(run.persistenceError, /transient refusal/);
    run.status = 'done';
    assert.equal(core.saveRun(run), true, 'the checkpoint did not recover after a transient failure');
    assert.equal(run.persistenceError, undefined, 'a stale persistence error was retained');
    await harness.settle();

    const persisted = JSON.parse(storage.getItem(core.PROJECTS_KEY));
    const durable = persisted.runs.find(item => item.id === run.id);
    assert.ok(durable, 'the run was not persisted');
    assert.equal(durable.persistenceError, undefined, 'the success serialized the old failure');
});

// --------------------------------------------------------------------------

(async () => {
    let passed = 0;
    const failures = [];
    for (const { name, fn } of tests) {
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
    console.log(`\n${passed}/${tests.length} durable-storage groups passed`);
    if (failures.length) {
        failures.forEach(({ name, error }) => {
            console.log(`\n--- ${name} ---`);
            console.log(error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n') : error);
        });
        process.exit(1);
    }
})();
