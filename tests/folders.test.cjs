'use strict';

/*
 * Codalio Blueprint — project folders test.
 *
 * Covers the folder layer added on top of the flat v1 store:
 *
 *   1. v1/v2 -> v3 MIGRATION. The important one: an existing user upgrading must not
 *      lose documents. readStore() runs once at module load, so this test seeds a
 *      v1 payload into localStorage and loads controller-core.js in a FRESH vm
 *      context — the only honest way to exercise the migration path.
 *   2. Folder CRUD, including the invariants that protect data: the default
 *      folder cannot be deleted or renamed, ids are generated (not name-derived)
 *      so renaming never rewrites file records, and names de-duplicate.
 *   3. Scope: listFiles() with no argument still returns everything (the agent,
 *      viewer, metrics and export all depend on that), while a folder id scopes.
 *   4. The "Open folder" importer: budgets enforced, unsupported types and
 *      ignored directories skipped WITH a reason, binary rejected, one unreadable
 *      file not aborting the rest.
 *
 * Run: node tests/folders.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');
const { createDocument, createLocalStorage } = require('./dom-stub.cjs');

// ---------------------------------------------------------------------------
// Harness: a fresh core module over a supplied localStorage.
//
// readStore() runs at load time, so migration can only be tested by controlling
// what is in storage BEFORE controller-core.js is evaluated. Everything else
// could use one shared context, but a factory keeps the migration case and the
// CRUD case running against identical conditions.
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
        // The importer calls file.text() when present and falls back to
        // FileReader; tests supply the promise form so a rejection is expressible.
        FileReader: class { readAsText() {} },
        fetch: async () => { throw new Error('folders.test.cjs makes no network calls'); },
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

// ---------------------------------------------------------------------------

let boot = loadCore(null);
let core = boot.core;
let storage = boot.storage;

/** Wipe projects and folders, keeping the same module instance. */
function reset() {
    const cleared = core.clearAllData(core.DEFAULT_SETTINGS);
    assert.equal(cleared.ok, true, `test fixture reset failed: ${cleared.error || 'unknown error'}`);
}

// ---------------------------------------------------------------------------
// 1. A fresh install has exactly one folder, and it is the default
// ---------------------------------------------------------------------------

reset();
let folders = core.listFolders();
assert.equal(folders.length, 1, 'a fresh store should hold exactly one folder');
assert.equal(folders[0].id, core.DEFAULT_FOLDER_ID);
assert.equal(folders[0].origin, 'default', 'the default folder must report origin "default"');
assert.equal(core.activeFolder().id, core.DEFAULT_FOLDER_ID);

// ---------------------------------------------------------------------------
// 2. v1/v2 -> v3 migration: existing documents and runs survive
// ---------------------------------------------------------------------------
{
    const v1 = {
        version: 1,
        files: {
            'docs/prd/2026-01-01-old-prd.md': {
                path: 'docs/prd/2026-01-01-old-prd.md',
                content: '# Old PRD\n\nWritten before folders existed.',
                createdAt: '2026-01-01T10:00:00.000Z',
                updatedAt: '2026-01-02T10:00:00.000Z',
                runId: 'run-1',
                skill: 'prd-builder'
            },
            'src/main.py': {
                path: 'src/main.py',
                content: 'print("hello")\n',
                createdAt: '2026-01-01T11:00:00.000Z',
                updatedAt: '2026-01-01T11:00:00.000Z',
                runId: '',
                skill: 'manual'
            }
        },
        runs: [{ id: 'run-1', skillId: 'prd-builder', status: 'done', phases: [] }],
        openPath: 'docs/prd/2026-01-01-old-prd.md',
        activeRunId: 'run-1'
    };

    const migrated = loadCore({ [core.PROJECTS_KEY]: v1 });
    const mCore = migrated.core;

    assert.equal(mCore.store.version, 3, 'the migrated store did not report version 3');
    assert.equal(mCore.listFiles().length, 2, 'migration LOST documents');
    const prd = mCore.readFile('docs/prd/2026-01-01-old-prd.md');
    assert.ok(prd, 'the migrated PRD is missing');
    assert.equal(prd.content, '# Old PRD\n\nWritten before folders existed.', 'migration altered document content');
    assert.equal(prd.createdAt, '2026-01-01T10:00:00.000Z', 'migration lost createdAt');
    assert.equal(prd.runId, 'run-1', 'migration lost the run link');
    assert.equal(prd.skill, 'prd-builder', 'migration lost the skill link');

    // Every pre-existing document lands in the default folder.
    assert.equal(prd.folder, mCore.DEFAULT_FOLDER_ID, 'a migrated document has no folder');
    assert.equal(mCore.readFile('src/main.py').folder, mCore.DEFAULT_FOLDER_ID);
    assert.equal(mCore.listFiles(mCore.DEFAULT_FOLDER_ID).length, 2,
        'the default folder does not contain the migrated documents');

    // Runs and the open path carry over.
    assert.equal(mCore.store.runs.length, 1, 'migration lost run history');
    assert.equal(mCore.store.openPath, 'docs/prd/2026-01-01-old-prd.md', 'migration lost the open path');
    assert.equal(mCore.store.activeRunId, 'run-1', 'migration lost the active run');
    assert.equal(mCore.listFolders().length, 1, 'migration invented extra folders');

    // The migrated store re-persists as v3 without further change.
    mCore.writeFile('docs/prd/new.md', '# New', {});
    const roundTrip = JSON.parse(migrated.storage.getItem(mCore.PROJECTS_KEY));
    assert.equal(roundTrip.version, 3, 'the migrated store did not re-save as v3');
    assert.equal(roundTrip.files['docs/prd/2026-01-01-old-prd.md'].folder, mCore.DEFAULT_FOLDER_ID,
        'the migrated folder assignment did not persist');
}

// Accepted legacy paths are canonicalized before the graph becomes live, so an
// old leading slash cannot make every later v3 save fail schema validation.
{
    const legacy = {
        version: 1,
        files: {
            '/legacy.md': { path: '/legacy.md', content: '# Legacy' }
        },
        runs: [{
            id: 'legacy-run',
            status: 'done',
            phases: [{ reviewPath: '/legacy.md' }],
            reviews: [{ path: '/legacy.md' }],
            writtenFiles: [{ path: '/legacy.md' }]
        }],
        openPath: '/legacy.md',
        activeRunId: 'legacy-run'
    };
    const migrated = loadCore({ [core.PROJECTS_KEY]: legacy });
    assert.equal(migrated.core.store.openPath, 'legacy.md');
    assert.ok(migrated.core.readFile('legacy.md'));
    const legacyRun = migrated.core.findRun('legacy-run');
    assert.equal(legacyRun.writtenPaths[0], 'legacy.md');
    assert.equal(legacyRun.writtenFiles[0].path, 'legacy.md');
    assert.equal(legacyRun.reviews[0].path, 'legacy.md');
    assert.equal(legacyRun.phases[0].reviewPath, 'legacy.md');
    assert.ok(migrated.core.writeFile('new.md', '# New', {}),
        'canonicalized legacy graph could not be upgraded to a valid v3 write');
    const persisted = JSON.parse(migrated.storage.getItem(migrated.core.PROJECTS_KEY));
    assert.equal(persisted.version, 3);
    assert.equal(persisted.files['legacy.md'].path, 'legacy.md');
}

// A v2 store with real folders must not be flattened back into the default.
{
    const v2 = {
        version: 2,
        folders: {
            'folder-default': { id: 'folder-default', name: 'Blueprint project', origin: 'default', createdAt: 'x', updatedAt: 'x' },
            'folder-alpha': { id: 'folder-alpha', name: 'Alpha plan', origin: 'created', createdAt: 'x', updatedAt: 'x' }
        },
        files: {
            'docs/prd/alpha.md': { path: 'docs/prd/alpha.md', content: '# Alpha', folder: 'folder-alpha' },
            'docs/prd/base.md': { path: 'docs/prd/base.md', content: '# Base', folder: 'folder-default' }
        },
        runs: [],
        openPath: 'docs/prd/alpha.md',
        activeRunId: '',
        activeFolderId: 'folder-alpha'
    };
    const reloaded = loadCore({ [core.PROJECTS_KEY]: v2 });
    assert.equal(reloaded.core.listFolders().length, 2, 'a v2 store lost its folders on reload');
    assert.equal(reloaded.core.store.activeFolderId, 'folder-alpha', 'the active folder did not persist');
    assert.deepEqual(
        reloaded.core.listFiles('folder-alpha'),
        ['docs/prd/alpha.md'],
        'folder scoping did not survive a reload'
    );
}

{
    const legacyV2 = {
        version: 2,
        folders: {
            'folder-default': { id: 'folder-default', name: 'Blueprint project' }
        },
        files: {
            'a.md': { path: 'a.md', content: '# A', folder: 'folder-default' }
        },
        runs: [{
            id: 'v2-written-ref',
            status: 'done',
            folderId: 'folder-default',
            phases: [],
            writtenFiles: [{ path: '/a.md', folderId: 'folder-default' }]
        }],
        activeFolderId: 'folder-default'
    };
    const migrated = loadCore({ [core.PROJECTS_KEY]: legacyV2 });
    assert.equal(migrated.core.findRun('v2-written-ref').writtenFiles[0].path, 'a.md');
    assert.ok(migrated.core.writeFile('b.md', '# B', {}),
        'v2 written-file reference poisoned the v3 upgrade');
}

// A v2 store that lost a file owner is corrupt. Keep its original bytes for
// explicit recovery instead of silently re-homing source into another project.
{
    const broken = {
        version: 2,
        folders: {},
        files: { 'a.md': { path: 'a.md', content: 'x', folder: 'folder-ghost' } },
        runs: [], openPath: '', activeRunId: '', activeFolderId: 'folder-ghost'
    };
    const healed = loadCore({ [core.PROJECTS_KEY]: broken });
    assert.equal(healed.core.store.activeFolderId, healed.core.DEFAULT_FOLDER_ID,
        'a dangling activeFolderId was not healed');
    assert.ok(healed.core.listFolders().some(f => f.id === healed.core.DEFAULT_FOLDER_ID),
        'the default folder was not recreated when missing');
    assert.equal(healed.core.readFile('a.md'), null,
        'a file pointing at a missing folder was silently refiled');
    assert.match(healed.core.storageRecoveryState().projects, /missing project root/i,
        'the invalid owner was not exposed as recoverable corruption');
    assert.equal(healed.storage.getItem(core.PROJECTS_KEY), JSON.stringify(broken),
        'loading invalid owner data overwrote the original recovery bytes');
}

// ---------------------------------------------------------------------------
// 3. Folder CRUD
// ---------------------------------------------------------------------------

reset();

// Create.
let created = core.createFolder('ToolShare plan');
assert.equal(created.error, '', `createFolder failed: ${created.error}`);
assert.ok(created.folder.id, 'the new folder has no id');
assert.equal(created.folder.name, 'ToolShare plan');
assert.equal(created.folder.origin, 'created');
assert.equal(core.store.activeFolderId, created.folder.id, 'creating a folder did not make it active');
assert.equal(core.listFolders().length, 2);

// Ids are generated, not derived from the name — that is what lets a rename work
// without rewriting every file record that points at the folder.
assert.ok(!created.folder.id.includes('toolshare'),
    'the folder id is derived from its name, so renaming would orphan documents');

// Empty names are rejected with a message the UI can show.
assert.equal(core.createFolder('   ').folder, null, 'a blank folder name was accepted');
assert.match(core.createFolder('').error, /name/i, 'a blank name produced no usable error');
assert.match(core.createFolder('x'.repeat(81)).error, /80 characters/, 'an over-long name was not rejected');

// Duplicate names get a suffix rather than an error: two folders called the same
// thing are distinguishable, and a collision is not worth a dialog.
const dupe = core.createFolder('ToolShare plan');
assert.equal(dupe.error, '');
assert.equal(dupe.folder.name, 'ToolShare plan (2)', 'a duplicate name was not suffixed');
const dupe2 = core.createFolder('ToolShare plan');
assert.equal(dupe2.folder.name, 'ToolShare plan (3)');

// Rename.
const renamed = core.renameFolder(created.folder.id, 'Lending app');
assert.equal(renamed.error, '');
assert.equal(renamed.folder.name, 'Lending app');
assert.equal(core.getFolder(created.folder.id).name, 'Lending app', 'the rename did not persist');
// The id is unchanged, so documents stay attached.
assert.equal(renamed.folder.id, created.folder.id, 'renaming changed the folder id');

// Rename collisions are refused, because two folders with one name cannot be told
// apart in the sidebar.
assert.match(core.renameFolder(created.folder.id, 'ToolShare plan (2)').error, /already exists/i,
    'renaming onto an existing name was allowed');
assert.match(core.renameFolder(created.folder.id, '').error, /name/i);

// The default folder is protected: unfiled documents need a home.
const refuseRename = core.renameFolder(core.DEFAULT_FOLDER_ID, 'Something else');
assert.match(refuseRename.error, /cannot/i, 'renaming the default folder should be refused');
assert.equal(refuseRename.folder, null);
assert.equal(core.getFolder(core.DEFAULT_FOLDER_ID).name, 'Blueprint project',
    'the default folder was renamed');
// createFolder() makes the new folder active, so the last one created is current.
assert.equal(core.activeFolder().id, dupe2.folder.id,
    'creating a folder did not leave it active');

// ---------------------------------------------------------------------------
// 4. Documents are filed into the active folder, and scope correctly
// ---------------------------------------------------------------------------

reset();
const folderA = core.createFolder('Alpha').folder;
core.writeFile('docs/prd/alpha.md', '# Alpha', {});
assert.equal(core.readFile('docs/prd/alpha.md').folder, folderA.id,
    'a document did not land in the active folder');

// Switching folders scopes the listing but does not move anything.
const folderB = core.createFolder('Beta').folder;
core.writeFile('docs/prd/beta.md', '# Beta', {});
assert.equal(core.readFile('docs/prd/beta.md').folder, folderB.id);

assert.deepEqual(core.listFiles(folderA.id), ['docs/prd/alpha.md'], 'folder A listing is wrong');
assert.deepEqual(core.listFiles(folderB.id), ['docs/prd/beta.md'], 'folder B listing is wrong');
// No argument means EVERY file — the agent, viewer, export and storage metrics all
// depend on that contract.
assert.deepEqual(core.listFiles(), ['docs/prd/alpha.md', 'docs/prd/beta.md'],
    'unscoped listFiles() must return every document');

// Rewriting a document keeps its folder rather than adopting the active one, or
// editing a file while another folder is selected would silently move it.
core.setActiveFolder(folderB.id);
core.writeFile('docs/prd/alpha.md', '# Alpha v2', {});
assert.equal(core.readFile('docs/prd/alpha.md').folder, folderA.id,
    'rewriting a document moved it to the active folder');

// An explicit meta.folder wins (the importer relies on it).
core.writeFile('docs/prd/explicit.md', '# Explicit', { folder: folderA.id });
assert.equal(core.readFile('docs/prd/explicit.md').folder, folderA.id);

// An explicit root id is an integrity boundary. A delayed async write aimed at
// a deleted root must fail closed rather than drift into whichever root is active.
const refusedGhost = core.writeFile('docs/prd/ghost.md', '# Ghost', {
    folder: 'folder-does-not-exist'
});
assert.equal(refusedGhost, null, 'a write aimed at a missing root was accepted');
assert.equal(core.readFile('docs/prd/ghost.md'), null,
    'a write aimed at a missing root drifted into another project');

// The same relative path is a valid, independent file in two project roots.
// Folder identity must survive reads, tabs/history handles, persistence, export,
// collision checks, and deletion without ever selecting by path alone.
reset();
const duplicateA = core.createFolder('Duplicate Alpha').folder;
core.writeFile('src/shared.js', 'export const owner = "alpha";\n', {
    folder: duplicateA.id,
    origin: 'imported'
});
const duplicateB = core.createFolder('Duplicate Beta').folder;
core.writeFile('src/shared.js', 'export const owner = "beta";\n', {
    folder: duplicateB.id,
    origin: 'imported'
});
assert.equal(core.listFiles(duplicateA.id)[0], 'src/shared.js');
assert.equal(core.listFiles(duplicateB.id)[0], 'src/shared.js');
assert.equal(core.readFile('src/shared.js', duplicateA.id).content, 'export const owner = "alpha";\n');
assert.equal(core.readFile('src/shared.js', duplicateB.id).content, 'export const owner = "beta";\n');
assert.notEqual(core.fileRefKey('src/shared.js', duplicateA.id), core.fileRefKey('src/shared.js', duplicateB.id));
assert.equal(core.withCollisionHandling('src/shared.js', { overwriteExistingFile: 'version' }, duplicateA.id),
    'src/shared-2.js');

core.setOpenPath('src/shared.js', duplicateA.id);
assert.equal(core.store.openFolderId, duplicateA.id, 'the open file lost its root identity');
core.writeStore();
const duplicateSeed = storage.getItem(core.PROJECTS_KEY);
const duplicateReload = loadCore({ [core.PROJECTS_KEY]: duplicateSeed }).core;
assert.equal(duplicateReload.readFile('src/shared.js', duplicateA.id).content,
    'export const owner = "alpha";\n', 'root A content changed on reload');
assert.equal(duplicateReload.readFile('src/shared.js', duplicateB.id).content,
    'export const owner = "beta";\n', 'root B content changed on reload');
assert.equal(duplicateReload.store.openFolderId, duplicateA.id,
    'the open file root did not survive persistence');
const duplicateExport = duplicateReload.exportBundle();
assert.match(duplicateExport, /Duplicate Alpha\/src\/shared\.js/);
assert.match(duplicateExport, /Duplicate Beta\/src\/shared\.js/);
const duplicateManifestMatch = /```json\n([\s\S]*?)\n```/.exec(duplicateExport);
assert.ok(duplicateManifestMatch, 'project export omitted its identity manifest');
const duplicateManifest = JSON.parse(duplicateManifestMatch[1]);
assert.equal(duplicateManifest.format, 'codalio-blueprint-project-export');
assert.ok(duplicateManifest.documents.some(item =>
    item.folderId === duplicateA.id && item.path === 'src/shared.js'));
assert.ok(duplicateManifest.documents.some(item =>
    item.folderId === duplicateB.id && item.path === 'src/shared.js'));

// Slash-joined labels and paths can render identically; the manifest must still
// retain two distinct root-qualified identities.
const slashLabelRoot = duplicateReload.createFolder('A/B').folder;
duplicateReload.writeFile('c.md', 'slash label root', { folder: slashLabelRoot.id });
const nestedPathRoot = duplicateReload.createFolder('A').folder;
duplicateReload.writeFile('B/c.md', 'nested path root', { folder: nestedPathRoot.id });
const aliasExport = duplicateReload.exportBundle();
const aliasManifest = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(aliasExport)[1]);
const aliasDocuments = aliasManifest.documents.filter(item =>
    (item.folderId === slashLabelRoot.id && item.path === 'c.md')
    || (item.folderId === nestedPathRoot.id && item.path === 'B/c.md'));
assert.equal(aliasDocuments.length, 2, 'display-path aliases collapsed in export');
assert.equal(new Set(aliasDocuments.map(item => `${item.folderId}\u0000${item.path}`)).size, 2,
    'export manifest did not preserve root-qualified identities');
assert.equal(duplicateReload.deleteFile('src/shared.js', duplicateA.id), true);
assert.equal(duplicateReload.readFile('src/shared.js', duplicateA.id), null,
    'folder-qualified delete left the requested file behind');
assert.equal(duplicateReload.readFile('src/shared.js', duplicateB.id).content,
    'export const owner = "beta";\n', 'folder-qualified delete removed the sibling root file');

// Imported documents are immutable. Revising one must create a distinct,
// collision-safe document in the SAME root (and must never recurse forever when
// the protected path already lives under docs/).
reset();
const protectedRoot = core.createFolder('Protected docs').folder;
core.writeFile('docs/spec.md', '# Original imported spec\n', {
    folder: protectedRoot.id,
    origin: 'imported'
});
const unrelatedRoot = core.createFolder('Unrelated active root').folder;
core.setActiveFolder(unrelatedRoot.id);
const firstRevision = core.writeFile('docs/spec.md', '# Revised safely\n', {});
assert.ok(firstRevision, 'revising an imported docs file returned no record');
assert.equal(firstRevision.path, 'docs/spec.revised.md');
assert.equal(firstRevision.folder, protectedRoot.id,
    'the protected-file revision leaked into the active root');
assert.equal(core.readFile('docs/spec.md', protectedRoot.id).content, '# Original imported spec\n',
    'the imported document was overwritten');
const secondRevision = core.writeFile('docs/spec.md', '# Revised safely again\n', { folder: protectedRoot.id });
assert.equal(secondRevision.path, 'docs/spec.revised-2.md',
    'a second protected-file revision did not receive a collision-safe path');

// ---------------------------------------------------------------------------
// 5. Deleting a folder deletes its documents and protects the default
// ---------------------------------------------------------------------------

reset();
const doomed = core.createFolder('Doomed').folder;
core.writeFile('docs/prd/keep.md', '# Keep', {});          // in Doomed
core.setActiveFolder(core.DEFAULT_FOLDER_ID);
core.writeFile('docs/prd/survivor.md', '# Survivor', {});  // in default

assert.equal(core.folderFileCount(doomed.id), 1);
const deleted = core.deleteFolder(doomed.id);
assert.equal(deleted.deleted, true);
assert.equal(deleted.count, 1, 'the delete did not report how many documents went');
assert.equal(core.getFolder(doomed.id), null, 'the folder still exists');
assert.equal(core.readFile('docs/prd/keep.md'), null, 'the folder document survived its folder');
assert.ok(core.readFile('docs/prd/survivor.md'), 'deleting one folder touched another folder');
assert.equal(core.store.activeFolderId, core.DEFAULT_FOLDER_ID,
    'deleting the active folder did not fall back to the default');

// The default folder cannot be deleted.
const refuse = core.deleteFolder(core.DEFAULT_FOLDER_ID);
assert.equal(refuse.deleted, false);
assert.match(refuse.error, /cannot be deleted/i);
assert.ok(core.getFolder(core.DEFAULT_FOLDER_ID), 'the default folder was deleted');

// Deleting a folder that never existed is an error, not a silent success.
assert.equal(core.deleteFolder('folder-ghost').deleted, false);
assert.match(core.deleteFolder('folder-ghost').error, /no longer exists/i);

// Deleting the active folder while another document is open must not leave
// openPath pointing at a deleted file.
reset();
const scoped = core.createFolder('Scoped').folder;
core.writeFile('docs/prd/open-me.md', '# Open', {});
assert.equal(core.store.openPath, 'docs/prd/open-me.md');
core.deleteFolder(scoped.id);
assert.notEqual(core.store.openPath, 'docs/prd/open-me.md',
    'openPath still points at a deleted document');

// ---------------------------------------------------------------------------
// 6. "Open folder" importer
// ---------------------------------------------------------------------------

(async () => {
    reset();

    // A realistic directory pick: the leading segment is the folder the user
    // chose, which the importer strips so stored paths stay short.
    const picked = [
        fakeFile('my-app/README.md', '# my-app\n\nA demo project.\n'),
        fakeFile('my-app/src/main.py', 'print("hi")\n'),
        fakeFile('my-app/src/util.js', 'export const a = 1;\n'),
        fakeFile('my-app/package.json', '{"name":"my-app"}\n')
    ];

    let result = await core.importFolder(picked, null, {});
    assert.equal(result.error, '', `import failed: ${result.error}`);
    assert.equal(result.imported.length, 4, `expected 4 imports, got ${result.imported.length}`);
    assert.equal(result.skipped.length, 0, 'a clean folder reported skips');
    assert.equal(result.truncatedByBudget, false);
    // Folder name comes from the picked directory, not a generic label.
    assert.equal(result.folder.name, 'my-app', 'the importer did not name the folder after the directory');
    assert.equal(result.folder.origin, 'imported');
    // Leading directory stripped.
    assert.ok(core.readFile('README.md'), 'the importer kept the leading directory in the path');
    assert.ok(core.readFile('src/main.py'));
    assert.ok(core.readFile('src/util.js'));
    // Everything landed in the imported folder, and it became active.
    assert.equal(core.readFile('README.md').folder, result.folder.id);
    assert.equal(core.store.activeFolderId, result.folder.id);
    assert.equal(core.listFiles(result.folder.id).length, 4);

    // Ignored directories never come in, and say why.
    reset();
    result = await core.importFolder([
        fakeFile('repo/index.js', 'ok'),
        fakeFile('repo/node_modules/lib/index.js', 'dependency'),
        fakeFile('repo/.git/HEAD', 'ref: refs/heads/main'),
        fakeFile('repo/dist/bundle.js', 'built'),
        fakeFile('repo/src/__pycache__/mod.pyc', 'bytecode')
    ], 'repo', {});
    assert.equal(result.imported.length, 1, 'ignored directories were imported');
    const reasons = result.skipped.map(item => item.reason).join(' | ');
    assert.match(reasons, /ignored directory/, 'skipped directories were not explained');
    assert.equal(result.skipped.length, 4);

    // Unsupported types are skipped with their extension named.
    reset();
    result = await core.importFolder([
        fakeFile('app/main.py', 'code'),
        fakeFile('app/logo.png', 'binary-ish'),
        fakeFile('app/video.mp4', 'binary'),
        fakeFile('app/archive.zip', 'binary')
    ], 'app', {});
    assert.equal(result.imported.length, 1);
    assert.match(result.skipped.map(s => s.reason).join(' | '), /unsupported type \.png/);

    // Credential-bearing paths fail closed, while an intentionally shareable
    // environment template remains importable.
    reset();
    result = await core.importFolder([
        fakeFile('secure/.env', 'API_KEY=never-import-this'),
        fakeFile('secure/.npmrc', '//registry/:_authToken=never-import-this'),
        fakeFile('secure/.GIT/config.json', '{"password":"never-import-this"}'),
        fakeFile('secure/credentials.json', '{"token":"never-import-this"}'),
        fakeFile('secure/.env.example', 'API_KEY=replace-me'),
        fakeFile('secure/src/config.js', 'export const mode = "dev";')
    ], 'secure', {});
    assert.equal(result.imported.length, 2, 'sensitive paths were imported or safe templates were lost');
    assert.ok(core.readFile('.env.example', result.folder.id), 'the safe environment template was rejected');
    assert.ok(core.readFile('src/config.js', result.folder.id));
    assert.equal(core.readFile('.env', result.folder.id), null);
    assert.equal(core.readFile('.npmrc', result.folder.id), null);
    assert.equal(core.readFile('credentials.json', result.folder.id), null);
    assert.equal(result.skippedByReason['sensitive credential file'], 3);
    assert.equal(result.skippedByReason['ignored directory'], 1);

    // Per-file budget.
    reset();
    result = await core.importFolder([
        fakeFile('big/small.txt', 'tiny'),
        fakeFile('big/huge.txt', 'x'.repeat(3000))
    ], 'big', { maxFileKb: 2 });
    assert.equal(result.imported.length, 1, 'the per-file limit was not enforced');
    // The reason is deliberately stable text with no per-file byte size in it: skip
    // entries are now COUNTED BY REASON past the first 50, and a reason containing
    // each file's own size would make every entry its own group, defeating the cap.
    assert.match(result.skipped[0].reason, /over the 2 KB per-file limit/,
        'the per-file rejection did not name the limit');

    // File-count budget.
    reset();
    const many = Array.from({ length: 12 }, (_, i) => fakeFile(`many/f${i}.txt`, `content ${i}`));
    result = await core.importFolder(many, 'many', { maxFiles: 5, maxTotalKb: 4096 });
    assert.equal(result.imported.length, 5, 'the file-count limit was not enforced');
    assert.equal(result.truncatedByBudget, true, 'hitting the count limit did not flag truncation');
    // The count budget is a HARD STOP: it breaks instead of pushing a skip entry per
    // remaining file, and reports the remainder as a count. Pushing one entry per
    // file was what made a 100k-file directory allocate ~100k objects.
    assert.equal(result.notEnumerated, 7,
        `expected the 7 unexamined files to be counted, got ${result.notEnumerated}`);
    assert.equal(result.skipped.length, 0,
        'a hard-stop budget should not materialise per-file skip entries');

    // Total-size budget. The per-file limit must not be the binding constraint
    // here, or this asserts nothing about the total.
    reset();
    result = await core.importFolder([
        fakeFile('tot/a.txt', 'a'.repeat(900)),
        fakeFile('tot/b.txt', 'b'.repeat(900)),
        fakeFile('tot/c.txt', 'c'.repeat(900))
    ], 'tot', { maxFileKb: 64, maxFiles: 100, maxTotalKb: 2 });
    assert.equal(result.imported.length, 2, 'the total-size limit was not enforced');
    assert.equal(result.truncatedByBudget, true);
    assert.equal(result.notEnumerated, 1, 'the file past the total budget was not counted');

    // Binary content is rejected even when the extension is allowed.
    reset();
    result = await core.importFolder([
        fakeFile('bin/notes.txt', 'plain text'),
        fakeFile('bin/data.txt', 'has\u0000a NUL byte')
    ], 'bin', {});
    assert.equal(result.imported.length, 1, 'a binary file was stored as text');
    assert.match(result.skipped[0].reason, /binary file/);

    // One unreadable file must not abort the rest of the import.
    reset();
    result = await core.importFolder([
        fakeFile('mix/ok1.txt', 'first'),
        fakeFile('mix/locked.txt', 'never read', { unreadable: true }),
        fakeFile('mix/ok2.txt', 'second')
    ], 'mix', {});
    assert.equal(result.imported.length, 2, 'one locked file aborted the whole import');
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /could not be read/, 'a read failure was not reported');

    // An empty selection is a clean error, not an empty folder.
    reset();
    const before = core.listFolders().length;
    result = await core.importFolder([], 'nothing', {});
    assert.match(result.error, /No files were selected/);
    assert.equal(core.listFolders().length, before, 'an empty pick created a folder anyway');

    // Windows-style separators normalize to forward slashes.
    reset();
    result = await core.importFolder([
        { name: 'main.py', webkitRelativePath: 'proj\\src\\main.py', size: 10, text: async () => 'print(1)' }
    ], 'proj', {});
    assert.equal(result.imported.length, 1, 'a backslash path was not imported');
    assert.ok(core.readFile('src/main.py'), 'backslashes were not normalized to forward slashes');

    // Distinct picker paths can collapse to one safe VFS path. The importer
    // must never count the aliases and then silently overwrite the first file.
    reset();
    result = await core.importFolder([
        fakeFile('aliases/a.txt', 'FIRST'),
        fakeFile('aliases/ a.txt', 'SECOND'),
        fakeFile('aliases/./a.txt', 'THIRD'),
        fakeFile('aliases//a.txt', 'FOURTH')
    ], 'aliases', {});
    assert.equal(result.imported.length, 1, 'canonical aliases were reported as separate durable files');
    assert.equal(result.skippedTotal, 3, 'canonical aliases were not reported as skips');
    assert.equal(core.readFile('a.txt', result.folder.id).content, 'FIRST',
        'a later canonical alias overwrote the first imported source');
    assert.equal(core.folderFileCount(result.folder.id), 1);
    assert.equal(result.folder.importedCount, 1);
    assert.deepEqual(Array.from(result.imported, item => item.path), ['a.txt']);

    // Cancelling after some files were read removes both the partial files and
    // the import-created root, including from the persisted store.
    reset();
    const importAbort = new AbortController();
    const cancellingFiles = [
        fakeFile('cancelled/first.js', 'export const first = true;'),
        {
            name: 'second.js',
            webkitRelativePath: 'cancelled/second.js',
            size: 16,
            text: async () => {
                importAbort.abort();
                return 'export const second = true;';
            }
        }
    ];
    let cancelError = null;
    try {
        await core.importFolder(cancellingFiles, 'cancelled', { signal: importAbort.signal });
    } catch (error) {
        cancelError = error;
    }
    assert.ok(cancelError, 'the cancelled import resolved successfully');
    assert.equal(cancelError.code, 'aborted');
    assert.equal(cancelError.rolledBack, true, 'the cancelled import did not persist its rollback');
    assert.equal(cancelError.partialImported, 1);
    assert.ok(!core.listFolders().some(folder => folder.name === 'cancelled'),
        'the import-created root survived cancellation');
    assert.equal(core.readFile('first.js'), null, 'a partial imported file survived cancellation');
    const cancelledPersisted = JSON.parse(storage.getItem(core.PROJECTS_KEY));
    assert.ok(!Object.values(cancelledPersisted.folders).some(folder => folder.name === 'cancelled'));
    assert.ok(!Object.values(cancelledPersisted.files).some(file => file.path === 'first.js'));

    // Stop must also interrupt a file.text() promise that never settles; this
    // was otherwise a permanent busyImport/global-operation lock.
    reset();
    const blockedReadAbort = new AbortController();
    const blockedImport = core.importFolder([{
        name: 'blocked.js',
        webkitRelativePath: 'blocked/blocked.js',
        size: 10,
        text: () => new Promise(() => {})
    }], 'blocked', { signal: blockedReadAbort.signal, fileReadTimeoutMs: 5000 });
    setTimeout(() => blockedReadAbort.abort(), 0);
    const blockedError = await Promise.race([
        blockedImport.then(() => null, error => error),
        new Promise((_, reject) => setTimeout(() => reject(new Error('blocked file read ignored cancellation')), 250))
    ]);
    assert.ok(blockedError && blockedError.code === 'aborted');
    assert.equal(blockedError.rolledBack, true);
    assert.ok(!core.listFolders().some(folder => folder.name === 'blocked'));

    // -------------------------------------------------------------------
    // 7. File System Access API directory walker
    // -------------------------------------------------------------------

    // A FileSystemDirectoryHandle-shaped stub: values() yields entries whose
    // kind is 'file' (with getFile()) or 'directory' (with nested values()).
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
                return fakeFile(relativePath, content);
            }
        };
    }

    // Feature detection mirrors the controller: no showDirectoryPicker in the
    // test sandbox means the input fallback is what a browser without the API
    // would take.
    assert.equal(core.canPickDirectoryHandle(), false,
        'the test sandbox must not claim directory-handle support');

    // Pruning: ignored directories are never descended into, so their files
    // are neither collected nor reported as per-file skips.
    reset();
    let root = fakeHandle('repo', [
        fakeFileEntry('repo/README.md', '# repo'),
        { kind: 'directory', name: 'src', values: async function* () {
            yield fakeFileEntry('repo/src/main.py', 'print(1)');
        } },
        { kind: 'directory', name: 'node_modules', values: async function* () {
            yield fakeFileEntry('repo/node_modules/lib/index.js', 'dep');
        } },
        { kind: 'directory', name: '.git', values: async function* () {
            yield fakeFileEntry('repo/.git/HEAD', 'ref');
        } },
        fakeFileEntry('repo/locked.txt', 'gone', { locked: true })
    ]);
    let collected = await core.collectFilesFromDirectoryHandle(root);
    assert.equal(collected.error, '', `scan failed: ${collected.error}`);
    assert.equal(collected.files.length, 2, 'ignored dirs were descended into, or real files were lost');
    assert.equal(collected.prunedDirs, 2, 'pruned ignored directories were not counted');
    assert.equal(collected.unreadable, 1, 'a locked file aborted the scan instead of being counted');
    // The collected array is from the vm realm, so deepStrictEqual against a
    // host-realm literal fails on prototypes — compare serialized instead.
    assert.equal(JSON.stringify(collected.files.map(f => f.relativePath).sort()),
        JSON.stringify(['repo/README.md', 'repo/src/main.py']));
    const collectedRepo = collected;

    // The handle walker is bounded before File objects accumulate, and a
    // never-settling getFile() remains abortable.
    const cappedEntries = Array.from({ length: 12 }, (_, index) =>
        fakeFileEntry(`capped/f${index}.js`, String(index)));
    collected = await core.collectFilesFromDirectoryHandle(
        fakeHandle('capped', cappedEntries), { maxFiles: 3 });
    assert.equal(collected.files.length, 3);
    assert.equal(collected.truncated, true);
    assert.equal(collected.maxFiles, 3);

    let rejectedMetadataReads = 0;
    collected = await core.collectFilesFromDirectoryHandle({
        kind: 'directory',
        name: 'hostile',
        values: async function* () {
            for (let index = 0; index < 10000; index += 1) {
                yield {
                    kind: 'file',
                    name: `locked-${index}.js`,
                    getFile: async () => {
                        rejectedMetadataReads += 1;
                        throw new Error('locked');
                    }
                };
            }
        }
    }, { maxEntries: 100, operationTimeoutMs: 50, scanTimeoutMs: 5000 });
    assert.equal(rejectedMetadataReads, 100,
        'unreadable entries bypassed the total entry budget');
    assert.equal(collected.scannedEntries, 100);
    assert.equal(collected.entryLimitReached, true);
    assert.equal(collected.truncated, true);

    const deadlineScan = await Promise.race([
        core.collectFilesFromDirectoryHandle(fakeHandle('deadline-scan', [{
            kind: 'file',
            name: 'forever.js',
            getFile: () => new Promise(() => {})
        }]), { operationTimeoutMs: 5000, scanTimeoutMs: 50 }),
        new Promise((_, reject) => setTimeout(() => reject(
            new Error('global scan deadline did not stop blocked metadata')), 500))
    ]);
    assert.equal(deadlineScan.deadlineReached, true);
    assert.equal(deadlineScan.truncated, true);

    const scanAbort = new AbortController();
    const blockedScan = core.collectFilesFromDirectoryHandle(fakeHandle('blocked-scan', [{
        kind: 'file',
        name: 'forever.js',
        getFile: () => new Promise(() => {})
    }]), { signal: scanAbort.signal, operationTimeoutMs: 5000 });
    setTimeout(() => scanAbort.abort(), 0);
    const scanError = await Promise.race([
        blockedScan.then(() => null, error => error),
        new Promise((_, reject) => setTimeout(() => reject(new Error('blocked getFile ignored cancellation')), 250))
    ]);
    assert.ok(scanError && scanError.code === 'aborted');

    // The collected files feed importFolder() unchanged: same budgets, same
    // stored paths (leading directory stripped), folder named after the pick.
    result = await core.importFolder(collectedRepo.files, core.suggestedFolderName(collectedRepo.files), {
        incompleteReason: `The directory scan was incomplete: ${collectedRepo.unreadable} file(s) could not be opened.`
    });
    assert.equal(result.error, '', `handle-path import failed: ${result.error}`);
    assert.equal(result.folder.name, 'repo', 'the folder was not named after the picked directory');
    assert.equal(result.imported.length, 2);
    assert.ok(core.readFile('README.md'), 'the leading directory was not stripped for handle-path files');
    assert.ok(core.readFile('src/main.py'));
    assert.equal(result.folder.importState, 'incomplete',
        'a partial handle scan was persisted as a complete project import');
    assert.match(result.folder.importError, /1 file\(s\) could not be opened/);
    const partialFolderId = result.folder.id;
    const partialReload = loadCore({ [core.PROJECTS_KEY]: storage.getItem(core.PROJECTS_KEY) });
    assert.equal(partialReload.core.getFolder(partialFolderId).importState, 'incomplete',
        'reload lost the partial directory-scan marker');
    assert.match(partialReload.core.getFolder(partialFolderId).importError, /could not be opened/,
        'reload lost the durable partial-scan reason');

    // An empty folder is a clean error, not an empty import.
    reset();
    collected = await core.collectFilesFromDirectoryHandle(fakeHandle('empty-dir', []));
    assert.match(collected.error, /no files/);

    // RESILIENCE — the regression this fixes. A directory the running app holds
    // open (live SQLite DBs, mmap'd model weights) makes Chromium's iterator
    // reject with NoModificationAllowedError. The walker must skip THAT folder
    // and keep every file it already collected from its siblings, never abort
    // the whole scan. Before this fix, one locked subdir discarded all ~1400
    // files and leaked the raw engine string into the toast.
    reset();
    function nomodError() {
        const err = new Error('An attempt was made to write to a file or directory '
            + 'which could not be modified due to the state of the underlying filesystem.');
        err.name = 'NoModificationAllowedError';
        return err;
    }
    collected = await core.collectFilesFromDirectoryHandle(fakeHandle('GUI', [
        fakeFileEntry('GUI/README.md', '# GUI'),
        { kind: 'directory', name: 'ai_agents', values: async function* () {
            yield fakeFileEntry('GUI/ai_agents/ai_graph.js', 'x');
            yield fakeFileEntry('GUI/ai_agents/ai_tasks.js', 'y');
        } },
        { kind: 'directory', name: 'data', values: () => { throw nomodError(); } },
        { kind: 'directory', name: 'comfy', values: async function* () {
            yield fakeFileEntry('GUI/comfy/index.html', '<html>');
        } }
    ]));
    assert.equal(collected.error, '',
        `a locked subfolder aborted the whole scan: ${collected.error}`);
    assert.equal(collected.files.length, 4,
        'files from sibling folders were discarded because one folder was locked');
    assert.equal(collected.lockedDirs, 1, 'the locked directory was not counted');
    assert.equal(collected.lockedSample.length, 1);
    assert.equal(collected.lockedSample[0].path, 'GUI/data');
    assert.match(collected.lockedSample[0].reason, /locked or in use/,
        'the locked-directory reason was not human-readable');
    // The raw DOMException text must never reach the user.
    assert.ok(!/underlying filesystem/.test(collected.lockedSample[0].reason),
        'the raw engine error string leaked into the reported reason');
    result = await core.importFolder(collected.files, 'GUI partial', {
        incompleteReason: `The directory scan was incomplete: ${collected.lockedDirs} folder(s) could not be enumerated.`
    });
    assert.equal(result.folder.importState, 'incomplete');
    assert.match(result.folder.importError, /1 folder\(s\) could not be enumerated/);

    // A root handle that cannot list at all is the ONLY hard error — and even
    // that gets a human message, not the raw string.
    reset();
    collected = await core.collectFilesFromDirectoryHandle({
        kind: 'directory',
        name: 'broken',
        values: () => { throw nomodError(); }
    });
    assert.equal(collected.files.length, 0);
    assert.equal(collected.lockedDirs, 1);
    assert.match(collected.error, /Nothing could be imported/);
    assert.match(collected.error, /locked or in use/);
    assert.ok(!/underlying filesystem/.test(collected.error),
        'the raw engine error string leaked into the hard-error message');

    // describeFsError maps engine exception names to actionable sentences.
    assert.equal(core.describeFsError({ name: 'NoModificationAllowedError' }),
        'a folder is locked or in use by another program');
    assert.equal(core.describeFsError({ name: 'NotAllowedError' }),
        'permission to read the folder was not granted');
    assert.equal(core.describeFsError({ name: 'WhateverWeirdError' }),
        'the folder could not be read');

    console.log('folders.test.cjs: 7 groups passed');
    console.log('  migration     : v1/v2 -> v3 keeps documents, runs, timestamps, links');
    console.log('  healing       : missing/dangling folders fall back to the default');
    console.log('  folders       : create, rename, delete, duplicate-suffix, default protected');
    console.log('  scoping       : per-folder listings, unscoped still returns everything');
    console.log('  importer      : count / per-file / total budgets, skips explained, one bad file tolerated');
    console.log('  handle scan   : prunes ignored dirs, survives locked folders, never leaks raw errors');
    process.exit(0);
})().catch(error => {
    console.error(error);
    process.exit(1);
});
