'use strict';

/*
 * Codalio Blueprint — Standalone Folder & Permissions Test
 *
 * Verifies:
 * 1. Folder import handles > 12 files (e.g. 25 files) without truncation.
 * 2. Strict Permissions Model:
 *    - Imported user source files (origin: 'imported') are strictly read-only.
 *    - Attempts to rewrite imported files divert safely to docs/<path>.revised.md.
 *    - Blueprint created files (origin: 'created') can be freely edited and rewritten.
 *    - core.isReadOnlyFile and core.canEditFile reflect the true permissions.
 * 3. Standalone Direct Project Access:
 *    - agent.runSkill and sourceFilesForModel automatically discover and read
 *      source files directly from the active project folder when no manual
 *      editor source chips are attached.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
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
    const fs = require('node:fs');

    const coreSrc = fs.readFileSync(path.join(SRC, 'controller-core.js'), 'utf8');
    vm.runInContext(coreSrc, context, { filename: 'controller-core.js' });

    const settingsSrc = fs.readFileSync(path.join(SRC, 'settings.js'), 'utf8');
    vm.runInContext(settingsSrc, context, { filename: 'settings.js' });

    const agentSrc = fs.readFileSync(path.join(SRC, 'agent.js'), 'utf8');
    vm.runInContext(agentSrc, context, { filename: 'agent.js' });

    return {
        core: windowStub.__codalioBlueprintCore,
        agent: windowStub.__codalioBlueprintAgent,
        settings: windowStub.__codalioBlueprintSettings,
        window: windowStub
    };
}

async function run() {
    console.log('--- Testing Standalone Project Folder & Permissions ---');

    const { core, agent } = createHarness();

    // Generate 25 files simulating work_on_rag-main folder
    const mockFiles = [];
    for (let i = 1; i <= 25; i++) {
        const content = `# Python module ${i}\ndef func_${i}():\n    return ${i}\n`;
        mockFiles.push({
            name: `module_${i}.py`,
            webkitRelativePath: `work_on_rag-main/src/module_${i}.py`,
            size: 1024,
            type: 'text/x-python',
            text: async () => content
        });
    }

    const folderResult = await core.importFolder(mockFiles, 'work_on_rag-main');
    assert.equal(folderResult.imported.length, 25, `Should import all 25 files, got ${folderResult.imported.length}`);
    assert.equal(folderResult.skipped.length, 0, 'No files should be skipped');
    console.log('✓ Folder import successfully loaded all 25 files (no 12-file truncation)');

    // Check active folder
    const activeFolderId = core.activeFolder().id;
    const listedFiles = core.listFiles(activeFolderId);
    assert.equal(listedFiles.length, 25, `Active folder should contain 25 files, got ${listedFiles.length}`);
    console.log('✓ core.listFiles(activeFolderId) lists all 25 files');

    // ---------------------------------------------------------------------------
    // Test 2: File permissions and safety model
    // ---------------------------------------------------------------------------
    const importedPath = listedFiles[0];
    const isReadOnly = core.isReadOnlyFile(importedPath);
    const canEdit = core.canEditFile(importedPath);
    assert.equal(isReadOnly, true, 'Imported file must be read-only');
    assert.equal(canEdit, false, 'Imported file cannot be edited');

    // Read imported file
    const readRecord = core.readFile(importedPath);
    assert.ok(readRecord && typeof readRecord.content === 'string');
    assert.match(readRecord.content, /# Python module 1/, 'Can read imported user source file freely');
    console.log('✓ Agent/core can freely read imported user source files');

    // Attempting to overwrite imported file should NOT mutate original file
    const blockedPath = importedPath;
    const revisedRecord = core.writeFile(blockedPath, '# HACKED OR OVERWRITTEN CONTENT');

    // Check original file was preserved
    const afterRecord = core.readFile(blockedPath);
    assert.match(afterRecord.content, /# Python module 1/, 'Original user source file must NOT be overwritten');
    assert.notEqual(afterRecord.content, '# HACKED OR OVERWRITTEN CONTENT', 'Original file content must stay intact');

    // Check that rewrite was safely diverted to docs/
    assert.ok(revisedRecord.path.startsWith('docs/'), `Diverted path should be in docs/, got ${revisedRecord.path}`);
    assert.ok(revisedRecord.path.endsWith('.revised.md'), `Diverted path should end with .revised.md, got ${revisedRecord.path}`);
    console.log(`✓ Overwrite attempt on imported source safely redirected to ${revisedRecord.path}`);

    // Blueprint created files can be freely edited and rewritten
    const createdDoc = core.writeFile('docs/prd/my-blueprint-plan.md', '# Initial Blueprint Plan', {
        origin: 'created',
        createdBy: 'blueprint'
    });
    assert.equal(createdDoc.origin, 'created', 'Created document has origin="created"');
    assert.equal(core.isReadOnlyFile(createdDoc.path), false, 'Created document is not read-only');
    assert.equal(core.canEditFile(createdDoc.path), true, 'Created document can be edited');

    // Rewrite created document
    core.writeFile(createdDoc.path, '# Updated Blueprint Plan V2');
    const updatedRecord = core.readFile(createdDoc.path);
    assert.equal(updatedRecord.content, '# Updated Blueprint Plan V2', 'Blueprint-created files can be rewritten freely');
    console.log('✓ Blueprint-created files can be freely rewritten and updated');

    // ---------------------------------------------------------------------------
    // Test 3: Standalone Direct Project Access
    // ---------------------------------------------------------------------------
    // When input.sourceFiles is empty (no manual editor selection),
    // sourceFilesForModel must automatically inspect the active project folder!
    const emptyInput = {
        sourceFiles: [],
        activeFolderId: activeFolderId
    };
    const settings = core.readSettings();

    const modelSources = agent.sourceFilesForModel(emptyInput, settings);
    assert.ok(modelSources.length > 0, `Model sources should automatically include files from active folder, got ${modelSources.length}`);
    assert.equal(modelSources.length, 25, `Model sources should include all 25 files from folder, got ${modelSources.length}`);
    assert.equal(modelSources[0].path, 'src/module_1.py', 'Source file path should match stripped relative path');
    console.log(`✓ Standalone access verified: ${modelSources.length} source files automatically fed to agent from active project folder`);

    console.log('\nAll Standalone Project Folder and Permissions tests PASSED successfully!\n');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
