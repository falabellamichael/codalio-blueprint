/*
 * Codalio Blueprint — page controller entrypoint.
 *
 * Registers with SimpleRAG's public extension host (window.RAGWorkspaceExtensions)
 * using the same page-controller contract the bundled Calendar page uses, and
 * implements the whole Cursor-style planning agent page.
 *
 * Everything lives under the cb-* class prefix and the codalio-blueprint.*
 * storage keys. No SimpleRAG source file is modified and no SimpleRAG state is
 * written.
 */
(function registerCodalioBlueprint() {
    'use strict';

    const PLUGIN_ID = 'codalio-blueprint';
    const PAGE_ID = `${PLUGIN_ID}.blueprint-page`;
    const APP_ID = 'blueprint';
    const RECORD_MARKER = 'codalio-blueprint';
    const HOST_STORAGE_KEY = 'ragworkspace_plugins';

    const core = window.__codalioBlueprintCore;
    const skills = window.__codalioBlueprintSkills;
    const agent = window.__codalioBlueprintAgent;
    const ui = window.__codalioBlueprintUi;
    const MANIFEST = window.__codalioBlueprintManifest;

    /**
     * Say WHY Blueprint is not there, on the page itself.
     *
     * Both failure paths below used to log one console line and return, leaving a
     * blank Advanced page with no visible explanation. That is what a user sees
     * when SimpleRAG's own bundle fails to parse: the host never defines
     * window.RAGWorkspaceExtensions, so Blueprint cannot register — and the reason
     * is buried in DevTools.
     *
     * Styles are INLINE, not .cb- classes: if the host is broken the plug-in's own
     * stylesheet may not have loaded either, and a diagnostic that depends on the
     * thing it is reporting on would render unstyled. It appends to document.body
     * rather than any host element, because the host shell may not exist.
     */
    function showBootFailure(reason, detail) {
        try {
            if (typeof document === 'undefined' || !document.body) return;
            if (document.getElementById('codalio-blueprint-boot-failure')) return;

            const panel = document.createElement('div');
            panel.id = 'codalio-blueprint-boot-failure';
            panel.setAttribute('role', 'alert');
            panel.style.cssText = [
                'margin:18px', 'padding:14px 16px', 'max-width:720px',
                'border:1px solid #8a5a2b', 'border-left:4px solid #d08700',
                'border-radius:8px', 'background:#2a2118', 'color:#f2e6d4',
                "font:13px/1.55 'Segoe UI',system-ui,sans-serif",
                'box-shadow:0 6px 22px rgba(0,0,0,.35)'
            ].join(';');

            const title = document.createElement('strong');
            title.textContent = 'Codalio Blueprint did not load';
            title.style.cssText = 'display:block;margin-bottom:6px;font-size:13.5px;color:#ffd591';
            panel.appendChild(title);

            const body = document.createElement('div');
            body.textContent = reason;
            panel.appendChild(body);

            if (detail) {
                const hint = document.createElement('div');
                hint.textContent = detail;
                hint.style.cssText = 'margin-top:8px;color:#c9b89f;font-size:12.5px';
                panel.appendChild(hint);
            }

            document.body.appendChild(panel);
        } catch (err) {
            // A diagnostic must never become the failure it is reporting.
            console.error('[codalio-blueprint] could not render the boot-failure panel:', err);
        }
    }

    if (!core || !skills || !agent || !ui || !MANIFEST) {
        const missing = [
            !core && 'controller-core', !skills && 'skills', !agent && 'agent',
            !ui && 'ui', !MANIFEST && 'manifest'
        ].filter(Boolean);
        console.error('[codalio-blueprint] incomplete package: a required module did not load.', missing);
        showBootFailure(
            'The Blueprint package is incomplete, so the page cannot start.',
            `Missing module(s): ${missing.join(', ')}. Re-run the installer `
            + '(python tools/blueprint.py install), then reload this page.'
        );
        return;
    }

    const host = window.RAGWorkspaceExtensions;
    if (!host || typeof host.registerController !== 'function' || typeof host.registerManifest !== 'function') {
        console.error('[codalio-blueprint] the SimpleRAG extension host is unavailable.');
        // Distinguish the two causes, because they need different fixes: a host
        // that never loaded is usually SimpleRAG's own bundle failing to parse,
        // which the console will already have reported above this line.
        showBootFailure(
            'SimpleRAG\'s extension host (window.RAGWorkspaceExtensions) is not available, '
            + 'so Blueprint has nothing to register with.',
            'This usually means SimpleRAG\'s own app.bundle.js failed to load or parse. '
            + 'Check the console above for an earlier error in app.bundle.js, fix it, then '
            + 'reload. If the console is clean, reinstall Blueprint with '
            + '"python tools/blueprint.py install".'
        );
        return;
    }

    // ------------------------------------------------------------------
    // Runtime state (never persisted except through core's own keys)
    // ------------------------------------------------------------------

    const wsModule = () => window.__codalioBlueprintWorkspace;
    const schemaModule = () => window.__codalioBlueprintSettings;

    /**
     * Budgets for "Open folder". These are intentionally NOT the Settings
     * source-attachment budgets: those describe what fits in a model window, and
     * capping a whole imported project at 50 files would make the feature useless.
     */
    // There is deliberately NO file-count cap. The 1000-file ceiling was
    // arbitrary, and it masked the real limit: writeStore() targets localStorage,
    // which browsers cap at roughly 5 MB per origin, while IMPORT_MAX_TOTAL_KB
    // allowed 32 MB. The count always bound first, so the quota problem was
    // invisible until it threw.
    //
    // The import now stops on a REAL limit and reports which one it hit:
    //   * the byte budget below (what the user can raise in Settings), or
    //   * the storage quota (a hard browser limit, reported as "storage full").
    // Unlimited by default; Infinity keeps importFolder()'s arithmetic simple.
    const IMPORT_MAX_FILES = Infinity;
    const IMPORT_MAX_TOTAL_KB = 32768;

    const runtime = {
        context: null,
        mounted: false,
        active: false,
        folder: 'cb-agent',
        // The tab layout. Created on mount, persisted by workspace.js's key.
        workspace: null,
        settingsFocusKey: '',
        settingsQueryDraft: '',
        dividerDragging: false,
        dividerElement: null,
        dividerWidth: 0,
        dividerBound: false,
        busy: false,
        // True only while a directory import is reading files. Separate from
        // `busy` (a model run) so the two cannot mask each other.
        busyImport: false,
        draft: '',
        hint: '',
        showSettings: false,
        viewerMode: 'preview',
        expanded: new Set(['docs', 'docs/prd']),
        // Project folder roots are OPEN unless collapsed here, so the Project Files
        // pane shows files on arrival rather than a list of folder names.
        collapsedRoots: new Set(),
        selectedSkillId: 'prd-builder',
        messages: [],
        runs: [],
        runCount: 0,
        activeRunId: '',
        projectName: '',
        sourceFiles: [],
        modal: null,
        toast: null,
        toastTimer: null,
        pendingQuestion: null,
        isHistoryOpen: false,
        compaction: null,
        currentRun: null,
        currentController: null,
        generation: 0,
        streamAnchor: null
    };

    const handlers = {
        render: () => render(),
        newRun: () => startNewRun(),
        stopRun: () => stopRun(),
        focusComposer: () => focusComposer(),
        goSection: id => goToSection(id),
        addSourceFile: () => openAddSourceModal(),
        newFile: () => openNewFileModal(),
        exportProject: () => exportProject(),
        clearHistory: () => confirmClearHistory(),
        newFolder: () => openNewFolderModal(),
        openFolder: () => pickFolderFromDisk(),
        selectFolder: folderId => selectFolder(folderId),
        renameFolder: folderId => openRenameFolderModal(folderId),
        deleteFolder: folderId => confirmDeleteFolder(folderId),
        attachFile: path => attachExistingFile(path),
        detachFile: path => detachSourceFile(path),
        clearAttached: () => clearAttachedFiles(),
        compactContext: opts => compactContext(opts)
    };

    // ------------------------------------------------------------------
    // Workspace (tabs)
    // ------------------------------------------------------------------

    /**
     * Load or create the tab layout. Restores the persisted layout only when
     * Settings -> Workspace -> Tabs -> "Restore tabs on load" is on; otherwise
     * every visit starts on the Agent tab alone.
     */
    function ensureWorkspace() {
        const ws = wsModule();
        if (!ws) return;
        if (runtime.workspace) {
            ws.syncAgentPin(runtime.workspace, core.readSettings());
            return;
        }
        const settings = core.readSettings();
        const raw = settings.restoreTabsOnLoad === false ? null : core.readWorkspaceRaw();
        runtime.workspace = ws.normalizeWorkspace(raw, settings);
    }

    function persistWorkspace() {
        if (!runtime.workspace) return;
        core.saveWorkspace(runtime.workspace);
    }

    /** Keep runtime.folder (which drives nav/list/ribbon) aligned to the tab. */
    function syncFolderFromTab() {
        const ws = wsModule();
        if (!ws || !runtime.workspace) return;
        const section = ws.activeSectionId(runtime.workspace);
        runtime.folder = section;
        const context = runtime.context;
        if (context && context.state) context.state.folder = section;
    }

    function activateTabById(tabId) {
        const ws = wsModule();
        if (!ws || !runtime.workspace) return;
        ws.activateTab(runtime.workspace, tabId);
        afterWorkspaceChange();
    }

    function openSectionTab(sectionId) {
        const ws = wsModule();
        if (!ws || !runtime.workspace) {
            goToSection(sectionId);
            return;
        }
        ws.openSection(runtime.workspace, sectionId, core.readSettings());
        afterWorkspaceChange();
    }

    function openFileTab(path) {
        const ws = wsModule();
        if (!ws || !runtime.workspace) {
            core.setOpenPath(path);
            goToSection('cb-files');
            return;
        }
        ws.openFile(runtime.workspace, path, core.readSettings());
        core.setOpenPath(path);
        afterWorkspaceChange();
    }

    function closeTabById(tabId) {
        const ws = wsModule();
        if (!ws || !runtime.workspace) return;
        ws.closeTab(runtime.workspace, tabId, core.readSettings());
        afterWorkspaceChange();
    }

    /** One place every tab mutation lands: sync, persist, re-render. */
    function afterWorkspaceChange() {
        syncFolderFromTab();
        persistWorkspace();
        renderHostSurfaces();
        renderPage();
    }

    // ------------------------------------------------------------------
    // Host plugin record (gates page visibility)
    // ------------------------------------------------------------------

    function readHostRecords() {
        try {
            const raw = window.localStorage.getItem(HOST_STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }

    function writeHostRecords(records) {
        try {
            window.localStorage.setItem(HOST_STORAGE_KEY, JSON.stringify(records));
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Ensure the host's plugin store carries an enabled record for Blueprint.
     * Without it the extension host hides the contributed page. This writes
     * only Blueprint's own entry and never alters another plugin's record.
     */
    function ensureHostRecord() {
        const records = readHostRecords();
        const existing = records.find(record => record && record.id === PLUGIN_ID);
        if (existing) {
            let changed = false;
            if (existing.enabled === false) { existing.enabled = true; changed = true; }
            if (existing.status === 'stopped') { existing.status = 'running'; changed = true; }
            if (existing.runtimeBacked !== true) { existing.runtimeBacked = true; changed = true; }
            if (!existing.runtimePage) { existing.runtimePage = APP_ID; changed = true; }
            if (changed) writeHostRecords(records);
            return;
        }
        records.push({
            id: PLUGIN_ID,
            name: MANIFEST.name,
            publisher: (MANIFEST.publisher && MANIFEST.publisher.name) || 'Unknown publisher',
            author: (MANIFEST.publisher && MANIFEST.publisher.name) || 'Unknown publisher',
            version: MANIFEST.version,
            description: MANIFEST.description,
            longDescription: MANIFEST.description,
            icon: 'fa-compass-drafting',
            tone: 'accent',
            category: 'Planning',
            permissions: (MANIFEST.permissions || []).map(permission => ({
                id: permission.id,
                scope: permission.reason || '',
                mode: permission.required ? 'Required' : 'Optional',
                risk: 'Low'
            })),
            enabled: true,
            status: 'running',
            installedAt: new Date().toISOString(),
            installMethod: 'Local extension registry',
            source: 'local-file',
            sourceLabel: 'Local extension registry',
            repository: 'https://github.com/falabellamichael/codalio-blueprint-simplerag',
            isolation: 'inline',
            verified: false,
            signed: false,
            checksum: true,
            runtimeBacked: true,
            pluginType: 'assistant',
            runtimePage: APP_ID,
            contributions: {
                pages: [{
                    id: PAGE_ID,
                    title: MANIFEST.contributes.pages[0].title,
                    location: 'app-bar',
                    icon: MANIFEST.contributes.pages[0].icon,
                    offlineCapable: true
                }]
            }
        });
        writeHostRecords(records);
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function stateSnapshot() {
        const settings = core.readSettings();
        const folders = core.listFolders();
        const activeFolder = core.activeFolder();
        return {
            folder: runtime.folder,
            busy: runtime.busy,
            // Neither was in the snapshot, so the UI could not see that an import
            // was running at all — the busy state was set and rendered, then drawn
            // from a snapshot that did not carry it.
            busyImport: runtime.busyImport,
            importProgress: runtime.importProgress,
            draft: runtime.draft,
            hint: runtime.hint,
            settings,
            workspace: runtime.workspace,
            settingsSection: runtime.workspace ? runtime.workspace.settingsSection : 'agent',
            settingsPage: runtime.workspace ? runtime.workspace.settingsPage : 'planning',
            settingsQuery: runtime.workspace ? runtime.workspace.settingsQuery : '',
            settingsFocusKey: runtime.settingsFocusKey,
            pinAgentTab: settings.pinAgentTab !== false,
            treeIndentPx: settings.treeIndentPx,
            showFileMeta: settings.showFileMeta !== false,
            viewerMode: runtime.workspace && core.store.openPath
                ? wsViewerMode(core.store.openPath, settings)
                : runtime.viewerMode,
            expanded: runtime.expanded,
            collapsedRoots: runtime.collapsedRoots,
            selectedSkillId: runtime.selectedSkillId,
            messages: runtime.messages,
            runs: runtime.runs,
            runCount: runtime.runs.length,
            activeRunId: runtime.activeRunId,
            // Project folders. `projectName` stays for the tree header and now
            // reports the folder the user is actually looking at.
            folders,
            folderCount: folders.length,
            activeFolderId: activeFolder ? activeFolder.id : core.DEFAULT_FOLDER_ID,
            activeFolderName: activeFolder ? activeFolder.name : 'Blueprint project',
            // One pass for every folder's count. The per-folder reduce called
            // core.folderFileCount(), which is a full listFiles() scan plus a
            // localeCompare sort — O(folders x n log n) on every single render.
            folderFileCounts: core.folderFileCounts(),
            projectName: activeFolder ? activeFolder.name : runtime.projectName,
            projectFiles: core.listFiles(),
            sourceFiles: runtime.sourceFiles,
            openPath: core.store.openPath,
            pendingQuestion: runtime.pendingQuestion,
            isHistoryOpen: Boolean(runtime.isHistoryOpen),
            hasCompaction: Boolean(runtime.compaction || (runtime.currentRun && runtime.currentRun.compaction)),
            compaction: runtime.compaction || (runtime.currentRun && runtime.currentRun.compaction) || null,
            run: runtime.currentRun,
            modal: runtime.modal,
            toast: runtime.toast,
            handlers
        };
    }

    function hostElements() {
        return (runtime.context && runtime.context.elements) || null;
    }

    /** Escape a value for safe use inside a querySelector attribute string. */
    function cssEscape(value) {
        return String(value || '').replace(/["\\]/g, '\\$&');
    }

    /** Per-document viewer mode: the workspace remembers it per path. */
    function wsViewerMode(path, settings) {
        const ws = wsModule();
        if (ws && runtime.workspace) return ws.viewerModeFor(runtime.workspace, path, settings);
        return settings.defaultViewerMode === 'source' ? 'source' : 'preview';
    }

    function renderPage() {
        const elements = hostElements();
        if (!elements || !elements.settingsContainer) return;
        if (runtime.context && runtime.context.state && runtime.context.state.app !== APP_ID) return;

        const container = elements.settingsContainer;
        const previousScroll = captureScroll();
        container.innerHTML = '';

        ensureWorkspace();
        const snapshot = stateSnapshot();

        // The reading pane is the tabbed workspace: strip + active panel.
        container.appendChild(ui.renderWorkspace(snapshot));

        if (runtime.modal) container.appendChild(ui.renderModal(snapshot));
        if (runtime.toast) container.appendChild(ui.renderToast(snapshot));

        restoreScroll(previousScroll);
        bindDividerDrag(container);
        if (!runtime.busy && isAgentTabActive() && !runtime.modal) focusComposer(true);
    }

    /**
     * Expand every folder leading to a path, so a newly written document is
     * visible in the tree. Honours Settings -> Workspace -> Layout ->
     * "Expand folders a run writes to".
     */
    function expandFoldersFor(path) {
        const settings = core.readSettings();
        if (settings.autoExpandWrittenFolders === false) return;
        const parts = String(path || '').split('/');
        parts.pop();
        let walked = [];
        parts.forEach(part => {
            walked = walked.concat([part]);
            runtime.expanded.add(walked.join('/'));
        });
    }

    /** A document was written: open or refresh its tab per settings. */
    function noteFileWritten(path) {
        if (!path) return;
        const ws = wsModule();
        expandFoldersFor(path);
        if (ws && runtime.workspace) {
            ws.onFileWritten(runtime.workspace, path, core.readSettings());
            persistWorkspace();
        }
    }

    /** A document was deleted: drop its tab per settings. */
    function noteFileDeleted(path) {
        if (!path) return;
        const ws = wsModule();
        if (ws && runtime.workspace) {
            ws.onFileDeleted(runtime.workspace, path, core.readSettings());
            persistWorkspace();
        }
        if (core.store.openPath === path) core.setOpenPath('');
    }

    /** A document was renamed: move its tab and per-path viewer mode. */
    function noteFileRenamed(oldPath, newPath) {
        if (!oldPath || !newPath || oldPath === newPath) return;
        const ws = wsModule();
        if (ws && runtime.workspace) {
            ws.onFileRenamed(runtime.workspace, oldPath, newPath, core.readSettings());
            persistWorkspace();
        }
    }

    /**
     * Remove the divider and undo the inline width we set on the host list pane.
     * Must run whenever the page is left, or the drag handle leaks into other
     * apps (Journal, Settings, ...) and the pane keeps Blueprint's width.
     */
    function releaseDivider() {
        const elements = hostElements();
        const listPane = elements && elements.listPane
            ? elements.listPane
            : document.getElementById('list-pane');
        if (runtime.dividerElement) {
            try { runtime.dividerElement.remove(); } catch (_) { /* already gone */ }
            runtime.dividerElement = null;
        }
        runtime.dividerBound = false;
        runtime.dividerWidth = 0;
        if (listPane) {
            listPane.style.width = '';
            listPane.style.flex = '';
            delete listPane.dataset.cbWidthApplied;
        }
    }

    /**
     * Drag-to-resize the host list pane. The width is persisted to
     * Settings -> Workspace -> Layout -> Sidebar width so the two stay in sync:
     * dragging updates the setting, editing the setting moves the divider.
     */
    function bindDividerDrag(container) {
        if (!container) return;
        // Already bound and still attached to the DOM: nothing to do. The divider
        // sits beside the host listPane (outside settingsContainer), so a page
        // re-render does not wipe it — but leaving the page does remove it.
        if (runtime.dividerElement && runtime.dividerElement.isConnected) return;
        runtime.dividerBound = false;
        const settings = core.readSettings();
        // Use the host's own element map rather than a global lookup: the host
        // writes inline flex/width on this pane when it collapses the list pane,
        // so both sides must be touching the same node.
        const elements = hostElements();
        const listPane = elements && elements.listPane
            ? elements.listPane
            : document.getElementById('list-pane');
        if (!listPane || !listPane.parentNode) return;

        // Apply the stored width once, then let dragging own it.
        if (!listPane.dataset.cbWidthApplied) {
            listPane.style.width = `${settings.listPaneWidth}px`;
            listPane.style.flex = `0 0 ${settings.listPaneWidth}px`;
            listPane.dataset.cbWidthApplied = 'true';
        }

        const divider = document.createElement('div');
        divider.className = 'cb-divider';
        divider.dataset.cbRole = 'divider';
        divider.setAttribute('role', 'separator');
        divider.setAttribute('aria-orientation', 'vertical');
        divider.setAttribute('aria-label', 'Resize the Blueprint sidebar');
        divider.tabIndex = 0;
        listPane.parentNode.insertBefore(divider, listPane.nextSibling);
        runtime.dividerElement = divider;
        runtime.dividerBound = true;

        let dragging = false;

        const onMove = moveEvent => {
            if (!dragging) return;
            const rect = listPane.getBoundingClientRect();
            const width = Math.round(Math.min(520, Math.max(220, moveEvent.clientX - rect.left)));
            listPane.style.width = `${width}px`;
            listPane.style.flex = `0 0 ${width}px`;
            runtime.dividerWidth = width;
        };

        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            runtime.dividerDragging = false;
            divider.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            if (runtime.dividerWidth) {
                const settings = core.readSettings();
                settings.listPaneWidth = runtime.dividerWidth;
                core.writeSettings(settings);
                const ws = wsModule();
                if (ws && runtime.workspace) {
                    ws.setDivider(runtime.workspace, runtime.dividerWidth);
                    persistWorkspace();
                }
            }
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };

        const onDown = downEvent => {
            if (downEvent.button !== 0) return;
            dragging = true;
            runtime.dividerDragging = true;
            divider.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            downEvent.preventDefault();
        };

        // Keyboard resizing for accessibility: arrow keys move 10px, Shift 40px.
        const onKey = keyEvent => {
            if (keyEvent.key !== 'ArrowLeft' && keyEvent.key !== 'ArrowRight') return;
            keyEvent.preventDefault();
            const step = keyEvent.shiftKey ? 40 : 10;
            const current = listPane.getBoundingClientRect().width;
            const next = Math.round(Math.min(520, Math.max(220,
                current + (keyEvent.key === 'ArrowRight' ? step : -step))));
            listPane.style.width = `${next}px`;
            listPane.style.flex = `0 0 ${next}px`;
            const settings = core.readSettings();
            settings.listPaneWidth = next;
            core.writeSettings(settings);
        };

        divider.addEventListener('pointerdown', onDown);
        divider.addEventListener('keydown', onKey);
        divider.addEventListener('dblclick', () => {
            const settings = core.readSettings();
            settings.listPaneWidth = 300;
            core.writeSettings(settings);
            listPane.style.width = '300px';
            listPane.style.flex = '0 0 300px';
        });
        void container;
    }

    function isAgentTabActive() {
        const ws = wsModule();
        return !ws || !runtime.workspace || ws.isAgentActive(runtime.workspace);
    }

    /**
     * Shared confirm dialog. Follows the exact shape the existing confirm flows
     * use (kind 'confirm', onConfirm clears the modal and returns true to close),
     * so it behaves identically under the confirm-modal dispatcher.
     */
    function openConfirmModal(options) {
        const opts = options || {};
        runtime.modal = {
            kind: 'confirm',
            title: opts.title || 'Are you sure?',
            icon: opts.icon || 'fa-circle-question',
            message: opts.message || '',
            danger: opts.danger === true,
            confirmLabel: opts.confirmLabel || 'OK',
            confirmIcon: opts.confirmIcon || (opts.danger ? 'fa-triangle-exclamation' : 'fa-check'),
            onConfirm: () => {
                runtime.modal = null;
                try {
                    if (typeof opts.onConfirm === 'function') opts.onConfirm();
                } catch (error) {
                    console.warn('[codalio-blueprint] confirm action failed', error);
                    setToast('That action failed. See the console for details.', 'error');
                }
                return true;
            }
        };
        renderPage();
    }

    // ------------------------------------------------------------------
    // Settings -> Data -> Maintenance actions
    // ------------------------------------------------------------------

    /**
     * Every action here is destructive or writes a file, so each one either
     * reuses an existing confirm dialog or reports what it did. Keys match the
     * `actions` declared on the Maintenance group in settings.js.
     */
    function handleSettingsAction(key) {
        switch (key) {
            case 'export-project':
                exportProject();
                return;

            case 'export-settings': {
                const schema = schemaModule();
                if (!schema) return;
                const json = schema.exportSettings(core.readSettings());
                downloadText('codalio-blueprint-settings.json', json, 'application/json;charset=utf-8');
                setToast('Settings exported.', 'success');
                return;
            }

            case 'import-settings':
                openImportSettingsModal();
                return;

            case 'reset-settings': {
                const schema = schemaModule();
                const defaults = schema ? schema.SCHEMA_DEFAULTS : core.DEFAULT_SETTINGS;
                openConfirmModal({
                    title: 'Reset all Blueprint settings?',
                    icon: 'fa-rotate-left',
                    message: 'Every setting returns to its documented default. Your documents and run history are untouched.',
                    confirmLabel: 'Reset settings',
                    danger: true,
                    onConfirm: () => {
                        core.writeSettings(Object.assign({}, defaults));
                        ensureWorkspace();
                        renderHostSurfaces();
                        renderPage();
                        setToast('Settings reset to defaults.', 'success');
                    }
                });
                return;
            }

            case 'clear-runs':
                confirmClearHistory();
                return;

            case 'clear-files':
                confirmClearFiles();
                return;

            case 'clear-all': {
                openConfirmModal({
                    title: 'Erase all Blueprint data?',
                    icon: 'fa-trash-can',
                    message: 'Documents, run history, settings and the tab layout are all removed. The plug-in then behaves as if freshly installed. Your SimpleRAG workspace is never touched.',
                    confirmLabel: 'Erase everything',
                    danger: true,
                    onConfirm: () => {
                        core.store.files = {};
                        core.store.runs = [];
                        core.store.openPath = '';
                        core.store.activeRunId = '';
                        core.writeStore();
                        core.clearWorkspace();
                        core.writeSettings(Object.assign({}, core.DEFAULT_SETTINGS));
                        runtime.workspace = wsModule() ? wsModule().createWorkspace(core.readSettings()) : null;
                        runtime.messages = [];
                        runtime.currentRun = null;
                        runtime.activeRunId = '';
                        runtime.expanded = new Set(['docs', 'docs/prd']);
                        loadRuns();
                        renderHostSurfaces();
                        renderPage();
                        setToast('All Blueprint data erased.', 'success');
                    }
                });
                return;
            }

            default:
                setToast(`Unknown settings action: ${key}`, 'warn');
        }
    }

    /** Import settings from a JSON file chosen on disk. */
    function openImportSettingsModal() {
        runtime.modal = {
            // Reuses the 'file' modal kind so the existing upload picker, path
            // field and content textarea all work unchanged.
            kind: 'file',
            title: 'Import Blueprint settings',
            icon: 'fa-file-arrow-up',
            description: 'Choose a settings JSON you exported earlier. Recognised values are clamped to their documented bounds; unknown keys are ignored.',
            pathLabel: 'File (optional)',
            path: '',
            contentLabel: 'Settings JSON',
            allowUpload: true,
            accept: '.json,application/json',
            note: 'Paste the JSON below, or use Choose a file from disk to load an export.',
            confirmLabel: 'Import',
            confirmIcon: 'fa-file-arrow-up',
            onConfirm: payload => {
                const schema = schemaModule();
                if (!schema) return false;
                const text = String((payload && payload.content) || '').trim();
                if (!text) {
                    setToast('No settings JSON to import.', 'warn');
                    return false;
                }
                try {
                    const result = schema.parseSettingsFile(text);
                    core.writeSettings(result.settings);
                    ensureWorkspace();
                    renderHostSurfaces();
                    renderPage();
                    setToast(
                        `Imported ${result.applied} setting${result.applied === 1 ? '' : 's'}`
                        + (result.ignored ? `, ignored ${result.ignored} unknown.` : '.'),
                        'success'
                    );
                    return true;
                } catch (error) {
                    setToast(String(error.message || 'That file is not valid Blueprint settings.'), 'error');
                    return false;
                }
            }
        };
        renderPage();
    }

    function captureScroll() {
        const elements = hostElements();
        const transcript = elements && elements.settingsContainer
            ? elements.settingsContainer.querySelector('[data-cb-role="transcript"]')
            : null;
        return transcript ? { top: transcript.scrollTop, height: transcript.scrollHeight } : null;
    }

    function restoreScroll(previous) {
        if (!previous) return;
        const elements = hostElements();
        const transcript = elements && elements.settingsContainer
            ? elements.settingsContainer.querySelector('[data-cb-role="transcript"]')
            : null;
        if (!transcript) return;
        const wasAtEnd = previous.height - previous.top - transcript.clientHeight < 140;
        transcript.scrollTop = wasAtEnd ? transcript.scrollHeight : previous.top;
    }

    function isTranscriptNearBottom(transcript) {
        if (!transcript) return true;
        const threshold = 140;
        return (transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight) <= threshold;
    }

    function scrollTranscriptToEnd(force = false) {
        const elements = hostElements();
        const transcript = elements && elements.settingsContainer
            ? elements.settingsContainer.querySelector('[data-cb-role="transcript"]')
            : null;
        if (!transcript) return;
        // Do not hijack the scroll position if user has scrolled away from the bottom to read
        if (force || isTranscriptNearBottom(transcript)) {
            transcript.scrollTop = transcript.scrollHeight;
        }
    }

    function render() {
        if (!runtime.mounted) return;
        renderPage();
    }

    function renderHostSurfaces() {
        const render = runtime.context && runtime.context.render;
        if (!render) return;
        try {
            render.nav();
            render.list();
            render.ribbon();
        } catch (error) {
            console.warn('[codalio-blueprint] host surface refresh failed', error);
        }
    }

    /**
     * Open a sidebar section AS A TAB beside the pinned Agent tab, rather than
     * replacing the reading pane. That is the whole point of the workspace: the
     * conversation in progress stays open while you read files, runs or settings.
     */
    function goToSection(id) {
        const section = String(id || 'cb-agent');
        if (wsModule() && runtime.workspace) {
            openSectionTab(section);
            return;
        }
        runtime.folder = section;
        const context = runtime.context;
        if (context && context.state) context.state.folder = section;
        renderHostSurfaces();
        renderPage();
    }

    function focusComposer(onlyIfEmpty) {
        const elements = hostElements();
        const composer = elements && elements.settingsContainer
            ? elements.settingsContainer.querySelector('[data-cb-role="composer"]')
            : null;
        if (!composer || composer.disabled) return;
        if (onlyIfEmpty && String(composer.value || '').trim()) return;
        try { composer.focus({ preventScroll: true }); } catch (_) { composer.focus(); }
    }

    /**
     * Show a transient message. `durationMs` is optional; the default suits a
     * one-line confirmation, while an import summary (counts plus a reason for
     * skipped files) needs longer to read.
     */
    function setToast(text, tone, durationMs) {
        clearTimeout(runtime.toastTimer);
        runtime.toast = text ? { text, tone: tone || 'info' } : null;
        if (text) {
            const parsed = Number(durationMs);
            const ttl = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30000) : 4200;
            runtime.toastTimer = setTimeout(() => {
                runtime.toast = null;
                if (runtime.mounted) renderPage();
            }, ttl);
        }
        if (runtime.mounted) renderPage();
    }

    // ------------------------------------------------------------------
    // Runs
    // ------------------------------------------------------------------

    function loadRuns() {
        runtime.runs = core.store.runs.slice();
        runtime.activeRunId = core.store.activeRunId || (runtime.runs[0] && runtime.runs[0].id) || '';
        const run = core.findRun(runtime.activeRunId);
        runtime.currentRun = run;
        runtime.projectName = run ? run.projectName : deriveProjectNameFromFiles();
    }

    function deriveProjectNameFromFiles() {
        const paths = core.listFiles();
        const doc = paths.find(path => /^docs\//.test(path));
        if (!doc) return '';
        const record = core.readFile(doc);
        const title = record && /^\s*#\s+(.+)$/m.exec(record.content);
        return title ? title[1].replace(/\s*(?:—|-{1,2})\s*Product Requirements.*$/i, '').trim().slice(0, 60) : '';
    }

    function saveCurrentRunMessages() {
        if (!runtime.currentRun || !Array.isArray(runtime.messages) || !runtime.messages.length) return;
        try {
            runtime.currentRun.messages = runtime.messages.map(item => {
                const copy = Object.assign({}, item);
                if (Array.isArray(copy.steps)) {
                    copy.steps = copy.steps.map(step => {
                        const stepCopy = Object.assign({}, step);
                        delete stepCopy.liveThinkingElement;
                        return stepCopy;
                    });
                }
                return copy;
            });
            core.saveRun(runtime.currentRun);
        } catch (_) {
            // Safe fallback
        }
    }

    function rebuildMessagesFromRun(run) {
        runtime.messages = [];
        if (!run) {
            runtime.compaction = null;
            return;
        }
        runtime.compaction = run.compaction || null;
        if (Array.isArray(run.messages) && run.messages.length) {
            runtime.messages = run.messages.map(item => Object.assign({}, item));
            return;
        }
        if (run.compaction) {
            runtime.messages.push({
                id: core.uid('msg'),
                role: 'compaction',
                at: run.compaction.at,
                compaction: run.compaction,
                text: `⚡ Context Compacted (${run.compaction.savedPercent}% reduction • ${run.compaction.originalTokens} → ${run.compaction.compactedTokens} tokens)`
            });
        }
        if (run.idea) {
            runtime.messages.push({
                id: core.uid('msg'),
                role: 'user',
                at: run.createdAt,
                text: run.idea
            });
        }
        runtime.messages.push({
            id: core.uid('msg'),
            role: 'assistant',
            at: run.createdAt,
            skillName: run.skillName,
            steps: run.phases,
            paths: run.writtenPaths || [],
            text: run.status === 'done'
                ? 'Run complete. Open any document from the project tree, or tell me what to revise.'
                : run.status === 'running' ? '' : `Run ended (${run.status}).${run.error ? ` ${run.error}` : ''}`,
            canRetry: run.status !== 'done'
        });
    }

    function clearChat() {
        if (runtime.busy) {
            setToast('Stop the current run before clearing the chat.', 'warn');
            return;
        }
        if (runtime.currentRun && runtime.messages.length) {
            saveCurrentRunMessages();
        }
        runtime.currentRun = null;
        runtime.activeRunId = '';
        runtime.messages = [];
        runtime.compaction = null;
        runtime.pendingQuestion = null;
        runtime.isHistoryOpen = false;
        runtime.folder = 'cb-agent';
        const context = runtime.context;
        if (context && context.state) context.state.folder = 'cb-agent';
        runtime.draft = '';
        core.store.activeRunId = '';
        core.writeStore();
        setToast('Chat cleared. Ready for a new prompt.', 'info');
        renderHostSurfaces();
        renderPage();
        focusComposer();
    }

    async function compactContext(options) {
        if (runtime.busy) {
            setToast('Cannot compact context while agent is busy.', 'warn');
            return;
        }
        const opts = options || {};
        const nonCompactionMessages = (runtime.messages || []).filter(m => m.role !== 'compaction');
        if (nonCompactionMessages.length < 2 && !runtime.compaction) {
            if (!opts.silent) setToast('Conversation history is too brief to compact.', 'info');
            return;
        }

        const run = runtime.currentRun || (core.store && core.store.activeRunId && core.findRun(core.store.activeRunId));
        const settings = core.readSettings();
        const activeFolder = core.activeFolder();

        if (!opts.silent) setToast('⚡ Compacting context using Anti-gravity protocol…', 'info', 3000);

        const compaction = await agent.compressContext({
            messages: runtime.messages,
            run,
            activeFolder,
            settings,
            useModel: opts.useModel !== false
        });

        if (!compaction) return;

        if (run) {
            run.compaction = compaction;
            core.saveRun(run);
        }
        runtime.compaction = compaction;

        const compactionMessage = {
            id: core.uid('msg'),
            role: 'compaction',
            at: compaction.at,
            compaction,
            text: `⚡ Context Compacted (${compaction.savedPercent}% reduction • ${compaction.originalTokens} → ${compaction.compactedTokens} tokens)`
        };

        const recent = runtime.messages.slice(-1).filter(m => m.role !== 'compaction');
        runtime.messages = [compactionMessage, ...recent];

        saveCurrentRunMessages();
        renderPage();
        scrollTranscriptToEnd();

        setToast(`⚡ Context compacted: ${compaction.savedPercent}% tokens saved (${compaction.compactedTokens} tokens retained).`, 'success', 5000);
    }

    function checkAutoCompaction() {
        const settings = core.readSettings();
        if (settings.contextCompression === false) return;
        const threshold = Number(settings.autoCompactThreshold) || 6;
        const count = (runtime.messages || []).filter(m => m.role !== 'compaction').length;
        if (count >= threshold && !runtime.busy) {
            void compactContext({ silent: true, useModel: false });
        }
    }

    function startNewRun() {
        clearChat();
    }

    async function stopRun() {
        if (!runtime.busy) return;
        // Bump first, then capture. The bump is what tells the cancelled run to
        // stop rendering; capturing afterwards means the guard below only trips if
        // something ELSE invalidated us (an activate or unmount landing while the
        // cancel request was in flight), never on our own bump.
        runtime.generation += 1;
        const generation = runtime.generation;
        const cancelId = runtime.currentController && runtime.currentController.cancelId;
        if (runtime.currentController && runtime.currentController.abort) {
            try { runtime.currentController.abort.abort(); } catch (_) { /* already settled */ }
        }
        const acknowledged = await core.cancelTurn(cancelId);
        if (generation !== runtime.generation) return;
        runtime.busy = false;
        runtime.pendingQuestion = null;
        if (runtime.currentRun && runtime.currentRun.status === 'running') {
            runtime.currentRun.status = 'stopped';
            core.saveRun(runtime.currentRun);
        }
        loadRuns();
        const last = runtime.messages[runtime.messages.length - 1];
        if (last && last.role === 'assistant') {
            last.busy = false;
            last.canRetry = true;
            last.text = acknowledged
                ? 'Stopped. The backend acknowledged the cancel request. Tell me what to change and I will pick the run back up.'
                : 'Stopped locally. The backend did not acknowledge the cancel, so the model may still be finishing that turn.';
        }
        setToast(acknowledged ? 'Run stopped.' : 'Stopped locally.', 'info');
        renderHostSurfaces();
        renderPage();
    }

    function selectedSkill() {
        return skills.getSkill(runtime.selectedSkillId) || skills.SKILLS[0];
    }

    /**
     * Resolve the agent's current clarifying question from the UI. Returns a
     * promise the page settles when the user answers (or stops the run).
     */
    function waitForAnswer(signal) {
        return new Promise(resolve => {
            runtime.answerResolver = value => {
                runtime.answerResolver = null;
                resolve(value);
            };
            const onAbort = () => {
                if (runtime.answerResolver) runtime.answerResolver(null);
            };
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    function bindAssistantSteps() {
        const last = runtime.messages[runtime.messages.length - 1];
        if (last && last.role === 'assistant' && runtime.currentRun) {
            last.steps = runtime.currentRun.phases;
        }
    }

    function startLiveTicker() {
        if (runtime.liveTickerTimer) clearInterval(runtime.liveTickerTimer);
        runtime.liveTickerTimer = setInterval(() => {
            if (!runtime.busy || !runtime.currentRun) return;
            const activePhases = (runtime.currentRun.phases || []).filter(p => p.status === 'running');
            if (!activePhases.length) return;
            const now = Date.now();
            activePhases.forEach(phase => {
                if (phase.startedAt) phase.elapsedMs = now - phase.startedAt;
            });
            const elements = hostElements();
            const container = elements && elements.settingsContainer;
            if (container) {
                activePhases.forEach(matchingPhase => {
                    const stepEl = container.querySelector(`[data-step-id="${matchingPhase.id}"]`);
                    if (stepEl) {
                        const timeEl = stepEl.querySelector('.cb-step-time');
                        if (timeEl) {
                            timeEl.textContent = `${(matchingPhase.elapsedMs / 1000).toFixed(1)}s`;
                        }
                        const tpsEl = stepEl.querySelector('.cb-step-tps');
                        if (tpsEl && matchingPhase.tokensPerSec) {
                            tpsEl.textContent = `${matchingPhase.tokensPerSec} tok/s`;
                        }
                        const substatusEl = stepEl.querySelector('.cb-step-substatus');
                        if (substatusEl && matchingPhase.substatus) {
                            const span = substatusEl.querySelector('span');
                            if (span) span.textContent = matchingPhase.substatus;
                        }
                        const thinkingFlag = stepEl.querySelector('.cb-step-thinking .cb-step-flag');
                        if (thinkingFlag && matchingPhase.thinking) {
                            thinkingFlag.textContent = `${Math.round(matchingPhase.thinking.length / 3.8)} tokens`;
                        }
                    }
                });
            }
        }, 100);
    }

    function stopLiveTicker() {
        if (runtime.liveTickerTimer) {
            clearInterval(runtime.liveTickerTimer);
            runtime.liveTickerTimer = null;
        }
    }

    async function runGapRepair(run, path, review) {
        if (runtime.busy) return;
        runtime.busy = true;
        runtime.hint = `Repairing gaps in ${path.split('/').pop()}…`;
        startLiveTicker();
        renderHostSurfaces();
        renderPage();

        const abortController = new AbortController();
        runtime.currentController = { abort: abortController, signal: abortController.signal, cancelId: '' };

        try {
            await agent.reviseDocumentGaps(run, path, review, {
                onRender: () => { bindAssistantSteps(); renderPage(); },
                onStep: () => { bindAssistantSteps(); scrollTranscriptToEnd(); },
                onStream: () => { scrollTranscriptToEnd(); },
                onFileWritten: writtenPath => { noteFileWritten(writtenPath); }
            }, { signal: abortController.signal });

            setToast(`Gaps repaired in ${path.split('/').pop()}!`, 'success');
        } catch (error) {
            if (error && error.code !== 'aborted') {
                setToast(`Gap repair failed: ${error.message}`, 'error');
            }
        } finally {
            runtime.busy = false;
            runtime.hint = '';
            runtime.currentController = null;
            stopLiveTicker();
            loadRuns();
            bindAssistantSteps();
            renderHostSurfaces();
            renderPage();
        }
    }

    async function runSelectedSkill(idea) {
        const skill = selectedSkill();
        const run = core.createRun(skill, idea);
        runtime.currentRun = run;
        runtime.activeRunId = run.id;
        runtime.projectName = run.projectName || runtime.projectName;

        const assistantMessage = {
            id: core.uid('msg'),
            role: 'assistant',
            at: new Date().toISOString(),
            skillName: skill.name,
            steps: run.phases,
            paths: [],
            text: '',
            busy: true
        };
        runtime.messages.push(assistantMessage);

        const abortController = new AbortController();
        const controller = { abort: abortController, signal: abortController.signal, cancelId: '' };
        runtime.currentController = controller;
        runtime.busy = true;
        runtime.hint = `Running ${skill.name}…`;
        startLiveTicker();

        const generation = runtime.generation;
        const stale = () => generation !== runtime.generation;

        const input = {
            idea,
            answers: [],
            signal: abortController.signal,
            requirementsText: idea,
            activeFolderId: runtime.activeFolderId || (core.store && core.store.activeFolderId),
            sourceFiles: runtime.sourceFiles,
            compaction: runtime.compaction || (run && run.compaction) || null
        };

        try {
            const result = await agent.runSkill(run, skill, input, {
                onRender: () => { if (!stale()) { bindAssistantSteps(); renderPage(); } },
                onStep: step => {
                    if (stale()) return;
                    bindAssistantSteps();
                    if (step.status === 'running') scrollTranscriptToEnd();
                },
                onStream: () => { if (!stale()) scrollTranscriptToEnd(); },
                // Open an editor tab for each document the skill writes, per
                // Settings -> Agent -> Planning -> "Open written documents".
                onFileWritten: path => { if (!stale()) noteFileWritten(path); },
                // The agent owns the question sequence; the page only surfaces it.
                askQuestion: async (step, question) => {
                    runtime.pendingQuestion = {
                        stepId: step.id,
                        question: step.question,
                        id: step.label,
                        options: (question && question.multi) || step.options || []
                    };
                    bindAssistantSteps();
                    renderPage();
                    focusComposer();
                    const answer = await waitForAnswer(controller.signal);
                    runtime.pendingQuestion = null;
                    renderPage();
                    return answer;
                }
            });

            if (stale()) return;
            assistantMessage.paths = result.writtenPaths || run.writtenPaths || [];
            assistantMessage.text = (result.writtenPaths && result.writtenPaths.length)
                ? 'Run complete. Every document is in the project tree — review before treating it as final.'
                : 'Run complete.';
            if (result && result.status === 'gaps') {
                assistantMessage.status = 'gaps';
                assistantMessage.text = 'The document was written, but self-review found missing sections. You can click **Repair Gaps** on the review step above to complete them automatically.';
            }
            runtime.projectName = run.projectName || runtime.projectName;
            setToast(`${skill.name} finished.`, 'success');
        } catch (error) {
            if (stale()) return;
            if (error && (error.code === 'aborted' || error.code === 'waiting-for-source' || error.code === 'missing-prd')) {
                assistantMessage.text = error.code === 'aborted'
                    ? 'Stopped. Tell me what to change and I will pick this back up.'
                    : error.code === 'waiting-for-source'
                        ? 'This skill must read the actual code. Add the source files in Project Files, then run it again.'
                        : 'This skill needs an existing PRD. Run PRD Builder first, or add a PRD under docs/prd/.';
                assistantMessage.canRetry = true;
                if (error.code !== 'aborted') setToast(assistantMessage.text, 'warn');
                else setToast('Run stopped.', 'info');
            } else {
                const message = String((error && error.message) || 'The run failed.');
                run.status = 'error';
                run.error = message;
                core.saveRun(run);
                assistantMessage.text = `The run stopped: ${message}`;
                assistantMessage.canRetry = true;
                setToast(message, 'error');
            }
        } finally {
            stopLiveTicker();
            if (!stale()) {
                runtime.busy = false;
                assistantMessage.busy = false;
                runtime.hint = '';
                runtime.pendingQuestion = null;
                runtime.currentController = null;
                saveCurrentRunMessages();
                loadRuns();
                bindAssistantSteps();
                renderHostSurfaces();
                renderPage();
                scrollTranscriptToEnd();
                checkAutoCompaction();
            }
        }
    }

    async function sendMessage() {
        if (runtime.busy && !runtime.pendingQuestion) return;
        const elements = hostElements();
        const composer = elements && elements.settingsContainer
            ? elements.settingsContainer.querySelector('[data-cb-role="composer"]')
            : null;
        const text = String((composer && composer.value) || runtime.draft || '').trim();
        if (!text) {
            setToast(runtime.pendingQuestion ? 'Please enter an answer first.' : 'Describe your idea first.', 'warn');
            focusComposer();
            return;
        }
        runtime.draft = '';

        // A pending clarifying question consumes the message as an answer.
        if (runtime.pendingQuestion && runtime.answerResolver) {
            const resolver = runtime.answerResolver;
            runtime.pendingQuestion = null;
            if (composer) composer.value = '';
            renderPage();
            resolver(text);
            return;
        }

        // ---- Slash command routing ----
        const trimmed = text.trim();
        const COMMAND_MAP = {
            '/prd': 'prd-builder',
            '/mvp': 'mvp-checklist',
            '/gtm': 'gtm-plan',
            '/arch': 'arch-eval',
            '/docs': 'doc-gen',
            '/code2prd': 'code-to-prd'
        };
        const firstToken = trimmed.split(/\s+/)[0].toLowerCase();
        if (firstToken === '/clear') {
            clearChat();
            return;
        }
        if (firstToken === '/compact') {
            await compactContext({ useModel: true });
            return;
        }
        if (firstToken === '/help') {
            const helpText = [
                '**Anti-gravity Slash Commands:**',
                '- `/prd <idea>` — Build PRD with 3 concurrent lenses',
                '- `/mvp <idea>` — Generate MVP scope, candidate matrix & cut list',
                '- `/gtm <idea>` — Generate go-to-market plan & exit criteria',
                '- `/arch <idea>` — Evaluate codebase architecture against requirements',
                '- `/docs <idea>` — Generate backlog, API contract sketch, and onboarding docs',
                '- `/code2prd` — Reverse-engineer a PRD from attached codebase',
                '- `/compact` — Compact conversation context (Anti-gravity Protocol)',
                '- `/clear` — Clear the transcript'
            ].join('\n');
            runtime.messages.push({
                id: core.uid('msg'),
                role: 'assistant',
                at: new Date().toISOString(),
                text: helpText
            });
            renderPage();
            scrollTranscriptToEnd();
            return;
        }

        let ideaText = text;
        if (COMMAND_MAP[firstToken]) {
            const targetSkillId = COMMAND_MAP[firstToken];
            runtime.selectedSkillId = targetSkillId;
            ideaText = trimmed.slice(firstToken.length).trim();
            if (!ideaText) {
                const targetSkill = skills.getSkill(targetSkillId);
                setToast(`Selected ${targetSkill ? targetSkill.name : targetSkillId}. Now describe your idea.`, 'info');
                renderHostSurfaces();
                renderPage();
                focusComposer();
                return;
            }
        }

        runtime.messages.push({
            id: core.uid('msg'),
            role: 'user',
            at: new Date().toISOString(),
            text: ideaText
        });
        renderPage();
        scrollTranscriptToEnd();
        await runSelectedSkill(ideaText);
    }

    async function reviseDocument(messageId) {
        const message = runtime.messages.find(item => item.id === messageId);
        if (!message) return;
        const run = core.findRun(runtime.activeRunId);
        const paths = (run && run.writtenPaths) || [];
        const target = paths.find(path => core.readFile(path)) || core.store.openPath;
        if (!target) {
            setToast('No written document to revise yet.', 'warn');
            return;
        }
        const instruction = String(window.prompt(`Revise ${target}\n\nWhat should change?`) || '').trim();
        if (!instruction) return;

        runtime.messages.push({
            id: core.uid('msg'),
            role: 'user',
            at: new Date().toISOString(),
            text: `Revise \`${target}\`: ${instruction}`
        });

        const record = core.readFile(target);
        const reviseRun = run || core.createRun(selectedSkill(), instruction);
        const assistantMessage = {
            id: core.uid('msg'),
            role: 'assistant',
            at: new Date().toISOString(),
            skillName: 'Revision',
            steps: reviseRun.phases,
            paths: [],
            text: '',
            busy: true
        };
        runtime.messages.push(assistantMessage);

        const abortController = new AbortController();
        runtime.currentController = { abort: abortController, signal: abortController.signal, cancelId: '' };
        runtime.busy = true;
        runtime.currentRun = reviseRun;
        const generation = runtime.generation;
        const settings = core.readSettings();

        const step = agent.makeStep({
            kind: 'document',
            label: `Revise ${target}`,
            summary: instruction,
            status: 'pending',
            open: true
        });
        reviseRun.phases.push(step);
        core.saveRun(reviseRun);
        renderPage();

        try {
            const compactionPrefix = runtime.compaction ? (agent.formatCompactionPrompt(runtime.compaction) + '\n\n---\n\n') : '';
            await agent.runModelStep(step, {
                systemPrompt: 'You are a product planning analyst revising one document. Return only the complete revised Markdown document, with no preamble and no commentary.',
                prompt: [
                    compactionPrefix + 'Revise the document below according to the instruction, then return the COMPLETE revised document.',
                    '',
                    'Rules:',
                    '- Keep the existing section structure unless the instruction asks to change it.',
                    '- Preserve facts the instruction does not touch.',
                    '- Return only the Markdown document, starting at the `#` title line.',
                    '',
                    `## Instruction`,
                    '',
                    instruction,
                    '',
                    `## Current document (${target})`,
                    '',
                    '```markdown',
                    record ? record.content : '',
                    '```'
                ].join('\n'),
                maxOutputTokens: settings.documentMaxOutputTokens,
                signal: abortController.signal
            }, {
                onRender: () => { if (generation === runtime.generation) renderPage(); },
                onStream: () => { if (generation === runtime.generation) scrollTranscriptToEnd(); }
            });

            if (generation !== runtime.generation) return;
            const meta = {
                date: core.todayStamp(),
                slug: reviseRun.slug || core.slugify(reviseRun.projectName || 'project'),
                projectName: reviseRun.projectName || runtime.projectName || 'Project'
            };
            core.writeFile(target, agent.applyDocumentHeader(step.text, meta), {
                runId: reviseRun.id,
                skill: reviseRun.skillId
            });
            noteFileWritten(target);
            assistantMessage.paths = [target];
            assistantMessage.text = `Revised \`${target}\`. Review the changes in the project tree.`;
            setToast('Document revised.', 'success');
        } catch (error) {
            if (generation !== runtime.generation) return;
            assistantMessage.text = `Revision stopped: ${String((error && error.message) || 'failed')}`;
            assistantMessage.canRetry = true;
            setToast(assistantMessage.text, 'error');
        } finally {
            if (generation === runtime.generation) {
                assistantMessage.busy = false;
                runtime.busy = false;
                runtime.currentController = null;
                saveCurrentRunMessages();
                core.saveRun(reviseRun);
                loadRuns();
                renderHostSurfaces();
                renderPage();
                checkAutoCompaction();
            }
        }
    }

    // ------------------------------------------------------------------
    // Files
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // Project folders
    // ------------------------------------------------------------------

    /**
     * Scope the tree — and every document written from now on — to one folder.
     * Switching folders does not move existing documents; it changes which ones
     * are listed and where new ones land.
     */
    function selectFolder(folderId) {
        const folder = core.setActiveFolder(folderId);
        if (!folder) {
            setToast('That folder no longer exists.', 'error');
            return;
        }
        runtime.projectName = folder.name;
        renderHostSurfaces();
        renderPage();
    }

    function openNewFolderModal() {
        runtime.modal = {
            kind: 'folder',
            title: 'New project folder',
            icon: 'fa-folder-plus',
            description: 'Folders keep separate plans side by side. Documents Blueprint generates from here on land in the folder you create.',
            name: `${core.todayStamp()}-project`,
            nameLabel: 'Folder name',
            confirmLabel: 'Create folder',
            confirmIcon: 'fa-folder-plus',
            onConfirm: values => {
                const name = String(values.name || '').trim();
                const result = core.createFolder(name, 'created');
                if (result.error) {
                    setToast(result.error, 'error');
                    return false;
                }
                runtime.projectName = result.folder.name;
                runtime.modal = null;
                setToast(`Folder "${result.folder.name}" created.`, 'success');
                renderHostSurfaces();
                renderPage();
                return true;
            }
        };
        renderPage();
    }

    function openRenameFolderModal(folderId) {
        const folder = core.getFolder(folderId || core.store.activeFolderId);
        if (!folder) {
            setToast('That folder no longer exists.', 'error');
            return;
        }
        if (folder.id === core.DEFAULT_FOLDER_ID) {
            setToast('The default project folder cannot be renamed.', 'info');
            return;
        }
        runtime.modal = {
            kind: 'folder',
            title: 'Rename folder',
            icon: 'fa-pen',
            description: `Renaming "${folder.name}" does not move or rewrite its ${core.folderFileCount(folder.id)} document(s).`,
            name: folder.name,
            nameLabel: 'Folder name',
            confirmLabel: 'Rename',
            confirmIcon: 'fa-pen',
            onConfirm: values => {
                const result = core.renameFolder(folder.id, String(values.name || ''));
                if (result.error) {
                    setToast(result.error, 'error');
                    return false;
                }
                if (core.store.activeFolderId === folder.id) runtime.projectName = result.folder.name;
                runtime.modal = null;
                setToast(`Renamed to "${result.folder.name}".`, 'success');
                renderHostSurfaces();
                renderPage();
                return true;
            }
        };
        renderPage();
    }

    function confirmDeleteFolder(folderId) {
        const folder = core.getFolder(folderId || core.store.activeFolderId);
        if (!folder) {
            setToast('That folder no longer exists.', 'error');
            return;
        }
        if (folder.id === core.DEFAULT_FOLDER_ID) {
            setToast('The default project folder cannot be deleted.', 'info');
            return;
        }
        const count = core.folderFileCount(folder.id);
        runtime.modal = {
            kind: 'confirm',
            title: `Delete "${folder.name}"?`,
            icon: 'fa-triangle-exclamation',
            danger: true,
            description: count
                ? `This deletes the folder and its ${count} document(s). Runs are kept. This cannot be undone.`
                : 'This deletes the empty folder. This cannot be undone.',
            confirmLabel: count ? `Delete folder and ${count} file(s)` : 'Delete folder',
            confirmIcon: 'fa-trash',
            onConfirm: () => {
                // Capture the paths BEFORE deleting: their editor tabs have to be
                // closed, and afterwards there is nothing left to enumerate.
                const doomed = core.listFiles(folder.id);
                const result = core.deleteFolder(folder.id);
                runtime.modal = null;
                if (!result.deleted) {
                    setToast(result.error || 'The folder could not be deleted.', 'error');
                    renderPage();
                    return true;
                }
                runtime.projectName = core.activeFolder().name;
                // Any tab showing a deleted document must go, or it renders an
                // empty viewer for a path that no longer exists.
                doomed.forEach(path => noteFileDeleted(path));
                setToast(count
                    ? `Deleted "${folder.name}" and its ${result.count} file(s).`
                    : `Deleted "${folder.name}".`, 'info');
                renderHostSurfaces();
                renderPage();
                return true;
            }
        };
        renderPage();
    }

    /**
     * Import a directory from disk.
     *
     * Prefers the File System Access API (window.showDirectoryPicker) when the
     * browser has it — Chromium does, Firefox/Safari do not. That path walks
     * the directory lazily and PRUNES ignored directories (node_modules, .git,
     * …) instead of enumerating every file inside them, so importing a large
     * repo scans orders of magnitude fewer entries. Every other browser gets
     * the <input type="file" webkitdirectory> path, which is the only way
     * those browsers hand over a whole folder.
     *
     * Both paths converge on the same File[] shape and the same
     * runFolderImport() importer — budgets, skip reporting and persistence are
     * shared, so the two pickers cannot drift apart.
     *
     * Nothing is uploaded anywhere — the files are read in this page and stored in
     * the browser profile, exactly like the single-file attach path.
     */
    function pickFolderFromDisk() {
        if (core.canPickDirectoryHandle && core.canPickDirectoryHandle()) {
            void pickFolderWithDirectoryHandle();
            return;
        }
        pickFolderWithInput();
    }

    async function pickFolderWithDirectoryHandle() {
        const settings = core.readSettings();
        let rootHandle;
        try {
            rootHandle = await window.showDirectoryPicker({ mode: 'read' });
        } catch (error) {
            // AbortError is the user cancelling the picker — a normal outcome,
            // not a failure worth a toast.
            if (error && error.name === 'AbortError') return;
            // SecurityError (insecure origin, cross-origin iframe, …) or any
            // other refusal: fall back to the input path rather than dead-end.
            console.warn('[codalio-blueprint] showDirectoryPicker failed, falling back to <input webkitdirectory>:', error);
            pickFolderWithInput();
            return;
        }

        // The scan walks the directory tree before importing. It reports
        // through the same busy/progress state the importer uses, and yields
        // every 40 entries so the page repaints mid-scan.
        runtime.busyImport = true;
        setToast(`Scanning "${rootHandle.name}"…`, 'info');
        let collected;
        try {
            collected = await core.collectFilesFromDirectoryHandle(rootHandle, {
                onProgress: found => {
                    runtime.importProgress = { done: found, total: 0, imported: 0 };
                    setToast(`Scanning "${rootHandle.name}"… ${found.toLocaleString()} file(s) found`, 'info');
                }
            });
        } catch (error) {
            runtime.busyImport = false;
            runtime.importProgress = null;
            setToast(`Import failed: ${String((error && error.message) || error)}`, 'error');
            renderPage();
            return;
        }

        if (collected.error) {
            runtime.busyImport = false;
            runtime.importProgress = null;
            setToast(collected.error, 'warn');
            renderPage();
            return;
        }

        // runFolderImport() owns the busy state from here on; it also clears
        // the scan progress before the import phase sets its own. A partial
        // scan (some folders locked) reaches here with files populated and
        // error empty — the locked counts are reported in the final toast.
        void runFolderImport(collected.files, settings, {
            prunedDirs: collected.prunedDirs,
            unreadable: collected.unreadable,
            lockedDirs: collected.lockedDirs,
            lockedSample: collected.lockedSample
        });
    }

    function pickFolderWithInput() {
        const settings = core.readSettings();
        const input = document.createElement('input');
        input.type = 'file';
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
        input.multiple = true;
        input.style.display = 'none';
        input.setAttribute('aria-hidden', 'true');

        const cleanup = () => {
            if (input.parentNode) input.parentNode.removeChild(input);
        };

        input.addEventListener('change', () => {
            const files = Array.prototype.slice.call(input.files || []);
            cleanup();
            if (!files.length) {
                setToast('No folder was selected.', 'info');
                return;
            }
            void runFolderImport(files, settings);
        });

        // If the user dismisses the picker, `change` never fires. `cancel` is
        // supported in current Chromium and Firefox; without it the node is simply
        // left detached, which is harmless.
        input.addEventListener('cancel', () => { cleanup(); });

        const host = hostElements();
        const mount = (host && host.settingsContainer) || document.body;
        if (!mount) return;
        mount.appendChild(input);
        try {
            input.click();
        } catch (_) {
            cleanup();
            setToast('This browser blocked the folder picker.', 'error');
        }
    }

    async function runFolderImport(files, settings, scanInfo) {
        const scan = scanInfo || {};
        const pickedName = core.suggestedFolderName
            ? core.suggestedFolderName(files)
            : String((files[0] && (files[0].relativePath || files[0].webkitRelativePath || files[0].name)) || 'Imported folder').split('/')[0];

        setToast(`Importing ${files.length.toLocaleString()} file(s) from ${pickedName}…`, 'info');
        runtime.busyImport = true;
        runtime.importProgress = null;
        renderPage();

        let result;
        try {
            // Importing a project is deliberately more generous than attaching
            // sources to a prompt — the model-context budget (maxSourceFiles,
            // bounded 1..150, is about what fits in a context window, not about
            // what a project may contain). Those stay separate: lifting the import
            // cap must not mean stuffing 100k files into a prompt.
            //
            // The per-file limit IS shared, because a file too big to attach is too
            // big to be worth storing either.
            result = await core.importFolder(files, pickedName, {
                maxFileKb: Math.max(1024, Number(settings.maxSourceFileKb) || 512),
                maxFiles: IMPORT_MAX_FILES,
                maxTotalKb: IMPORT_MAX_TOTAL_KB,
                onProgress: (done, total, imported) => {
                    runtime.importProgress = { done, total, imported };
                }
            });
        } catch (error) {
            runtime.busyImport = false;
            setToast(`Import failed: ${String((error && error.message) || error)}`, 'error');
            renderPage();
            return;
        }
        runtime.busyImport = false;
        runtime.importProgress = null;

        if (result.error) {
            setToast(result.error, 'error');
            renderPage();
            return;
        }

        runtime.projectName = result.folder.name;
        result.imported.forEach(item => noteFileWritten(item.path));

        // skippedTotal is authoritative: result.skipped holds at most 50 detailed
        // entries, and a directory with hundreds of thousands of files skips nearly
        // all of them inside node_modules / .git / .venv.
        const skipped = result.skippedTotal || 0;
        const parts = [`${result.imported.length.toLocaleString()} file(s) imported into "${result.folder.name}".`];
        if (skipped) {
            const reasons = Object.keys(result.skippedByReason || {})
                .sort((a, b) => result.skippedByReason[b] - result.skippedByReason[a])
                .slice(0, 3)
                .map(reason => `${result.skippedByReason[reason].toLocaleString()} ${reason}`);
            parts.push(`${skipped.toLocaleString()} skipped`
                + (reasons.length ? ` (${reasons.join(', ')})` : '') + '.');
        }
        if (result.notEnumerated) {
            parts.push(`${result.notEnumerated.toLocaleString()} more file(s) were not examined `
                + 'because a limit was reached.');
        }
        if (result.truncatedByBudget) {
            parts.push('Raise the limits in Settings -> Source files to import more.');
        }
        // Handle-path only: pruned ignored directories were never enumerated,
        // so they appear in no skip list — report them separately, or the user
        // sees fewer files than the folder contains with no explanation.
        if (scan.prunedDirs) {
            parts.push(`${scan.prunedDirs.toLocaleString()} ignored folder(s) (node_modules, .git, …) were not scanned.`);
        }
        if (scan.unreadable) {
            parts.push(`${scan.unreadable.toLocaleString()} file(s) could not be opened and were skipped.`);
        }
        // A partial scan: some folders (live DBs, in-use files) refused to
        // list, so their contents were never seen. Say how many and why, with a
        // human reason — never the raw DOMException string.
        if (scan.lockedDirs) {
            const sample = Array.isArray(scan.lockedSample) ? scan.lockedSample : [];
            const reason = sample[0] ? sample[0].reason : 'they are in use by another program';
            const where = sample.length ? ` (e.g. ${sample[0].path})` : '';
            parts.push(`${scan.lockedDirs.toLocaleString()} folder(s) were skipped because ${reason}${where}.`);
        }
        setToast(parts.join(' '), skipped || scan.lockedDirs ? 'info' : 'success',
            skipped || scan.lockedDirs ? 12000 : 4200);

        renderHostSurfaces();
        renderPage();
    }

    function openAddSourceModal() {
        runtime.modal = {
            kind: 'file',
            title: 'Add a source file',
            icon: 'fa-file-circle-plus',
            description: 'Attached files are sent to the model with the code-reading skills (Architecture Evaluation, Code to PRD). They are stored only in this browser profile.',
            path: `src/${runtime.projectName ? core.slugify(runtime.projectName) + '/' : ''}main.py`,
            pathLabel: 'Project path',
            contentLabel: 'File content (or choose a file from disk)',
            allowUpload: true,
            accept: '.py,.js,.jsx,.ts,.tsx,.json,.md,.css,.html,.txt,.yaml,.yml,.toml,.sh,.ps1,.sql',
            confirmLabel: 'Add file',
            confirmIcon: 'fa-plus',
            onConfirm: values => commitSourceFile(values)
        };
        renderPage();
    }

    function commitSourceFile(values) {
        const path = String(values.path || '').replace(/^\/+/, '').trim();
        if (!path) {
            setToast('A project path is required.', 'error');
            return false;
        }
        const content = String(values.content || '');
        if (!content.trim()) {
            setToast('The file is empty — nothing to attach.', 'error');
            return false;
        }
        if (content.length > ui.MAX_SOURCE_FILE_BYTES) {
            setToast(`That file is ${Math.round(content.length / 1024)} KB; the limit is ${Math.round(ui.MAX_SOURCE_FILE_BYTES / 1024)} KB.`, 'error');
            return false;
        }
        if (runtime.sourceFiles.length >= ui.MAX_SOURCE_FILES) {
            setToast(`At most ${ui.MAX_SOURCE_FILES} files can be attached. Detach one first.`, 'error');
            return false;
        }
        const total = runtime.sourceFiles.reduce((sum, file) => sum + file.content.length, 0) + content.length;
        if (total > ui.MAX_SOURCE_TOTAL_BYTES) {
            setToast(`Attached source would exceed ${Math.round(ui.MAX_SOURCE_TOTAL_BYTES / 1024)} KB total.`, 'error');
            return false;
        }
        if (runtime.sourceFiles.some(file => file.path === path)) {
            setToast(`${path} is already attached.`, 'warn');
            return false;
        }
        core.writeFile(path, content, { skill: 'source' });
        runtime.sourceFiles.push({ path, content });
        noteFileWritten(path);
        runtime.modal = null;
        setToast(`Attached ${path}.`, 'success');
        renderHostSurfaces();
        renderPage();
        return true;
    }

    function removeSourceFile(path) {
        runtime.sourceFiles = runtime.sourceFiles.filter(file => file.path !== path);
        core.deleteFile(path);
        noteFileDeleted(path);
        setToast(`Detached ${path}.`, 'info');
        renderHostSurfaces();
        renderPage();
    }

    function attachExistingFile(path) {
        const cleanPath = String(path || '').replace(/^\/+/, '').trim();
        if (!cleanPath) return false;
        const record = core.readFile(cleanPath);
        if (!record || typeof record.content !== 'string') {
            setToast(`Could not read ${cleanPath}.`, 'error');
            return false;
        }
        if (!record.content.trim()) {
            setToast(`"${cleanPath}" is empty — nothing to attach.`, 'error');
            return false;
        }
        if (record.content.length > ui.MAX_SOURCE_FILE_BYTES) {
            setToast(`${cleanPath} is ${Math.round(record.content.length / 1024)} KB; the limit is ${Math.round(ui.MAX_SOURCE_FILE_BYTES / 1024)} KB.`, 'error');
            return false;
        }
        if (runtime.sourceFiles.length >= ui.MAX_SOURCE_FILES) {
            setToast(`At most ${ui.MAX_SOURCE_FILES} files can be attached. Detach one first.`, 'error');
            return false;
        }
        const total = runtime.sourceFiles.reduce((sum, file) => sum + file.content.length, 0) + record.content.length;
        if (total > ui.MAX_SOURCE_TOTAL_BYTES) {
            setToast(`Attached source would exceed ${Math.round(ui.MAX_SOURCE_TOTAL_BYTES / 1024)} KB total.`, 'error');
            return false;
        }
        if (runtime.sourceFiles.some(file => file.path === cleanPath)) {
            setToast(`${cleanPath} is already attached to prompt context.`, 'info');
            return false;
        }
        runtime.sourceFiles.push({ path: cleanPath, content: record.content });
        setToast(`Attached ${cleanPath} to context.`, 'success');
        renderHostSurfaces();
        renderPage();
        return true;
    }

    function detachSourceFile(path) {
        const cleanPath = String(path || '').trim();
        const initialLen = runtime.sourceFiles.length;
        runtime.sourceFiles = runtime.sourceFiles.filter(file => file.path !== cleanPath);
        if (runtime.sourceFiles.length < initialLen) {
            setToast(`Detached ${cleanPath} from prompt context.`, 'info');
            renderHostSurfaces();
            renderPage();
        }
    }

    function clearAttachedFiles() {
        if (!runtime.sourceFiles.length) return;
        runtime.sourceFiles = [];
        setToast('Detached all source files from prompt context.', 'info');
        renderHostSurfaces();
        renderPage();
    }

    function openNewFileModal() {
        runtime.modal = {
            kind: 'file',
            title: 'New Markdown file',
            icon: 'fa-file-pen',
            description: 'Create a document in the Blueprint project. Useful for pasting an existing PRD so Doc Generation can work from it.',
            path: `docs/prd/${core.todayStamp()}-notes.md`,
            contentLabel: 'Content',
            content: '',
            confirmLabel: 'Create file',
            confirmIcon: 'fa-plus',
            onConfirm: values => {
                const path = String(values.path || '').replace(/^\/+/, '').trim();
                if (!path) {
                    setToast('A project path is required.', 'error');
                    return false;
                }
                if (core.readFile(path)) {
                    setToast(`${path} already exists.`, 'error');
                    return false;
                }
                core.writeFile(path, String(values.content || ''), { skill: 'manual' });
                runtime.modal = null;
                // Open the new document in its own editor tab (and make sure the
                // Project Files section exists to browse from).
                noteFileWritten(path);
                openFileTab(path);
                setToast(`Created ${path}.`, 'success');
                renderHostSurfaces();
                renderPage();
                return true;
            }
        };
        renderPage();
    }

    function openRenameModal(path) {
        const record = core.readFile(path);
        if (!record) return;
        runtime.modal = {
            kind: 'file',
            title: 'Rename or move file',
            icon: 'fa-pen',
            path,
            pathLabel: 'New project path',
            contentLabel: 'Content',
            content: record.content,
            confirmLabel: 'Save',
            confirmIcon: 'fa-floppy-disk',
            onConfirm: values => {
                const target = String(values.path || '').replace(/^\/+/, '').trim();
                if (!target) {
                    setToast('A project path is required.', 'error');
                    return false;
                }
                if (target !== path && core.readFile(target)) {
                    setToast(`${target} already exists.`, 'error');
                    return false;
                }
                if (target !== path) core.renameFile(path, target);
                core.writeFile(target, String(values.content || ''), {});
                if (target !== path) noteFileRenamed(path, target);
                noteFileWritten(target);
                runtime.modal = null;
                setToast(`Saved ${target}.`, 'success');
                renderHostSurfaces();
                renderPage();
                return true;
            }
        };
        renderPage();
    }

    function confirmDeleteFile(path) {
        runtime.modal = {
            kind: 'confirm',
            title: 'Delete file',
            icon: 'fa-trash',
            message: `Delete ${path} from the Blueprint project? This cannot be undone.`,
            danger: true,
            confirmLabel: 'Delete',
            confirmIcon: 'fa-trash',
            onConfirm: () => {
                runtime.sourceFiles = runtime.sourceFiles.filter(file => file.path !== path);
                core.deleteFile(path);
                noteFileDeleted(path);
                runtime.modal = null;
                setToast(`Deleted ${path}.`, 'info');
                renderHostSurfaces();
                renderPage();
                return true;
            }
        };
        renderPage();
    }

    function confirmClearHistory() {
        runtime.modal = {
            kind: 'confirm',
            title: 'Clear run history',
            icon: 'fa-clock-rotate-left',
            message: 'Delete every recorded Blueprint run and its step trace? Project files are kept.',
            danger: true,
            confirmLabel: 'Clear runs',
            confirmIcon: 'fa-trash-can',
            onConfirm: () => {
                core.store.runs = [];
                core.store.activeRunId = '';
                core.writeStore();
                runtime.modal = null;
                loadRuns();
                runtime.messages = [];
                setToast('Run history cleared.', 'info');
                renderHostSurfaces();
                renderPage();
                return true;
            }
        };
        renderPage();
    }

    function confirmClearFiles() {
        runtime.modal = {
            kind: 'confirm',
            title: 'Delete all project files',
            icon: 'fa-trash-can',
            message: 'Delete every file in the Blueprint project, including generated documents and attached source? Run history is kept.',
            danger: true,
            confirmLabel: 'Delete all files',
            confirmIcon: 'fa-trash-can',
            onConfirm: () => {
                core.store.files = {};
                core.store.openPath = '';
                core.writeStore();
                runtime.sourceFiles = [];
                runtime.modal = null;
                setToast('Project files deleted.', 'info');
                renderHostSurfaces();
                renderPage();
                return true;
            }
        };
        renderPage();
    }

    function downloadText(filename, text, mime) {
        const blob = new Blob([String(text || '')], { type: mime || 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    function exportProject() {
        const paths = core.listFiles();
        if (!paths.length) {
            setToast('The project is empty — nothing to download.', 'warn');
            return;
        }
        if (paths.length === 1) {
            const record = core.readFile(paths[0]);
            downloadText(paths[0].split('/').pop(), record.content, 'text/markdown;charset=utf-8');
            setToast(`Downloaded ${paths[0]}.`, 'success');
            return;
        }
        const bundle = paths.map(path => {
            const record = core.readFile(path);
            return `================ ${path} ================\n\n${record.content}\n`;
        }).join('\n\n');
        downloadText(`${core.slugify(runtime.projectName || 'blueprint')}-project.md`, bundle, 'text/markdown;charset=utf-8');
        setToast(`Downloaded ${paths.length} files as one Markdown bundle.`, 'success');
    }

    async function copyText(text, label) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(String(text || ''));
            } else {
                const area = document.createElement('textarea');
                area.value = String(text || '');
                area.style.position = 'fixed';
                area.style.opacity = '0';
                document.body.appendChild(area);
                area.select();
                document.execCommand('copy');
                area.remove();
            }
            setToast(`${label} copied.`, 'success');
        } catch (_) {
            setToast('The clipboard is unavailable in this context.', 'error');
        }
    }

    // ------------------------------------------------------------------
    // Events (scoped to the Blueprint page only)
    // ------------------------------------------------------------------

    /**
     * The host calls every page hook as handler(context, ...args), so the context
     * object arrives FIRST and the real payload second. A direct call (tests, the
     * command dispatcher) passes the payload first instead.
     *
     * SimpleRAG's bundled Calendar controller handles this the same way. Accept
     * both shapes so neither call form can silently feed a context object into a
     * payload slot: if the first argument is a context, adopt it and return the
     * second; otherwise the first argument IS the payload.
     */
    function hookContext(first, second) {
        const isContext = value => Boolean(value && typeof value === 'object'
            && !Array.isArray(value)
            && (value.state !== undefined || value.elements !== undefined || typeof value.render === 'object'));
        if (isContext(first)) {
            runtime.context = first;
            return second;
        }
        return first;
    }

    function isBlueprintPage() {
        const context = runtime.context;
        return Boolean(context && context.state && context.state.app === APP_ID);
    }

    function findAction(target) {
        return target && target.closest ? target.closest('[data-cb-action]') : null;
    }

    function onClick(event) {
        if (!isBlueprintPage()) return;

        // Middle-click on a tab closes it (standard IDE behaviour). Checked
        // before findAction because the close affordance is the tab itself.
        if (event.button === 1) {
            const tabButton = event.target && event.target.closest
                ? event.target.closest('[data-cb-action="activate-tab"]')
                : null;
            if (tabButton && tabButton.dataset.tabId) {
                event.preventDefault();
                closeTabById(tabButton.dataset.tabId);
                return;
            }
        }

        const target = findAction(event.target);
        if (!target) {
            if (runtime.isHistoryOpen) {
                const inside = event.target && event.target.closest && event.target.closest('.cb-chat-history-popover');
                if (!inside) {
                    runtime.isHistoryOpen = false;
                    renderPage();
                }
            }
            return;
        }
        if (runtime.modal && !target.closest('.cb-modal') && target.dataset.cbAction !== 'close-modal') {
            return;
        }
        const action = target.dataset.cbAction;
        if (runtime.isHistoryOpen && action !== 'toggle-chat-history' && !target.closest('.cb-chat-history-popover')) {
            runtime.isHistoryOpen = false;
        }
        event.preventDefault();
        event.stopPropagation();

        // Settings -> Data -> Maintenance actions are dispatched by key.
        if (action.indexOf('settings-action:') === 0) {
            handleSettingsAction(action.slice('settings-action:'.length));
            return;
        }

        switch (action) {
            case 'toggle-chat-history':
                runtime.isHistoryOpen = !runtime.isHistoryOpen;
                renderPage();
                return;
            case 'clear-chat':
                clearChat();
                return;
            case 'compact-context':
                void compactContext({ useModel: true });
                return;
            case 'open-chat-run': {
                const runId = target.dataset.runId;
                const run = core.findRun(runId);
                if (!run) return;
                if (runtime.currentRun && runtime.currentRun.id !== runId && runtime.messages.length) {
                    saveCurrentRunMessages();
                }
                runtime.activeRunId = run.id;
                core.store.activeRunId = run.id;
                core.writeStore();
                runtime.currentRun = run;
                runtime.selectedSkillId = run.skillId || runtime.selectedSkillId;
                runtime.projectName = run.projectName || runtime.projectName;
                rebuildMessagesFromRun(run);
                runtime.isHistoryOpen = false;
                setToast(`Loaded chat: ${run.title || run.skillName}`, 'info');
                goToSection('cb-agent');
                renderHostSurfaces();
                renderPage();
                scrollTranscriptToEnd(true);
                return;
            }
            case 'delete-history-run': {
                const runId = target.dataset.runId;
                core.deleteRun(runId);
                loadRuns();
                if (runtime.currentRun && runtime.currentRun.id === runId) {
                    runtime.currentRun = null;
                    runtime.activeRunId = '';
                    runtime.messages = [];
                }
                setToast('Run deleted from history.', 'info');
                renderHostSurfaces();
                renderPage();
                return;
            }
            case 'clear-all-history':
                runtime.isHistoryOpen = false;
                confirmClearHistory();
                return;
            case 'open-runs-tab':
                runtime.isHistoryOpen = false;
                goToSection('cb-history');
                return;
            case 'pick-skill': {
                runtime.selectedSkillId = target.dataset.skillId || runtime.selectedSkillId;
                const skill = selectedSkill();
                setToast(`${skill.name} selected. Describe your idea and press Send.`, 'info');
                runtime.hint = skill.tagline;
                renderHostSurfaces();
                renderPage();
                focusComposer();
                return;
            }
            case 'use-example': {
                const elements = hostElements();
                const composer = elements && elements.settingsContainer
                    ? elements.settingsContainer.querySelector('[data-cb-role="composer"]')
                    : null;
                if (composer) composer.value = target.textContent;
                runtime.draft = target.textContent;
                focusComposer();
                return;
            }
            case 'send':
                void sendMessage();
                return;
            case 'stop-run':
                void stopRun();
                return;
            case 'new-run':
                startNewRun();
                return;
            case 'show-skills':
                goToSection('cb-agent');
                return;
            case 'show-settings':
            case 'go-settings-full':
                goToSection('cb-settings');
                return;
            case 'hide-settings':
                goToSection('cb-agent');
                return;
            case 'activate-tab':
                activateTabById(target.dataset.tabId || '');
                return;
            case 'close-tab':
                closeTabById(target.dataset.tabId || '');
                return;
            case 'close-file-tabs': {
                const ws = wsModule();
                if (ws && runtime.workspace) {
                    ws.closeFileTabs(runtime.workspace, core.readSettings());
                    afterWorkspaceChange();
                }
                return;
            }
            case 'settings-goto': {
                const ws = wsModule();
                const sectionId = target.dataset.sectionId || 'agent';
                const pageId = target.dataset.pageId || '';
                if (ws && runtime.workspace) {
                    ws.setSettingsLocation(runtime.workspace, sectionId, pageId);
                    persistWorkspace();
                }
                runtime.settingsFocusKey = '';
                renderHostSurfaces();
                renderPage();
                return;
            }
            case 'settings-focus': {
                const ws = wsModule();
                if (ws && runtime.workspace) {
                    ws.setSettingsLocation(runtime.workspace, target.dataset.sectionId || 'agent', target.dataset.pageId || '');
                    persistWorkspace();
                }
                runtime.settingsFocusKey = target.dataset.settingKey || '';
                runtime.settingsQueryDraft = '';
                renderHostSurfaces();
                renderPage();
                queueMicrotask(() => {
                    const container = hostElements()?.settingsContainer;
                    const row = container && runtime.settingsFocusKey
                        ? container.querySelector(`[data-cb-setting-key="${cssEscape(runtime.settingsFocusKey)}"]`)
                        : null;
                    if (row) {
                        try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { row.scrollIntoView(); }
                        const control = row.querySelector('input, select, textarea, button');
                        if (control) { try { control.focus({ preventScroll: true }); } catch (_) { control.focus(); } }
                    }
                    runtime.settingsFocusKey = '';
                });
                return;
            }
            case 'clear-settings-search': {
                const ws = wsModule();
                if (ws && runtime.workspace) {
                    ws.setSettingsQuery(runtime.workspace, '');
                    persistWorkspace();
                }
                renderHostSurfaces();
                renderPage();
                queueMicrotask(() => {
                    const input = hostElements()?.settingsContainer?.querySelector('[data-cb-role="settings-search"]');
                    if (input) { try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); } }
                });
                return;
            }
            case 'settings-range-jump': {
                const key = target.dataset.settingKey || '';
                const value = Number(target.dataset.value);
                if (key && Number.isFinite(value)) {
                    const settings = core.readSettings();
                    const field = schemaModule() ? schemaModule().getField(key) : null;
                    settings[key] = field ? schemaModule().coerceField(field, value, settings[key]) : value;
                    core.writeSettings(settings);
                    renderHostSurfaces();
                    renderPage();
                }
                return;
            }
            case 'settings-clear-text': {
                const key = target.dataset.settingKey || '';
                if (key) {
                    const settings = core.readSettings();
                    settings[key] = '';
                    core.writeSettings(settings);
                    renderHostSurfaces();
                    renderPage();
                }
                return;
            }
            case 'reset-settings-page': {
                const schema = schemaModule();
                if (!schema) return;
                const sectionId = target.dataset.sectionId || 'agent';
                const pageId = target.dataset.pageId || '';
                const page = schema.getPage(sectionId, pageId);
                const settings = core.readSettings();
                let changed = 0;
                (page.groups || []).forEach(group => {
                    (group.fields || []).forEach(field => {
                        const fallback = schema.defaultFor(field);
                        if (settings[field.key] !== fallback) {
                            settings[field.key] = fallback;
                            changed += 1;
                        }
                    });
                });
                core.writeSettings(settings);
                setToast(changed
                    ? `Reset ${changed} setting${changed === 1 ? '' : 's'} on ${page.label}.`
                    : `${page.label} was already at its defaults.`, changed ? 'success' : 'info');
                renderHostSurfaces();
                renderPage();
                return;
            }
            case 'toggle-step': {
                const step = findStep(target.dataset.stepId);
                if (step) { step.open = !step.open; renderPage(); }
                return;
            }
            case 'auto-repair-gaps': {
                const runId = target.dataset.runId;
                const path = target.dataset.path;
                const run = core.findRun(runId) || runtime.currentRun;
                if (!run || !path) return;
                const review = (run.reviews || []).find(r => r.path === path);
                if (!review) return;
                setToast('Agent is autonomously repairing gaps…', 'info');
                void runGapRepair(run, path, review);
                return;
            }
            case 'answer-question': {
                const answer = target.dataset.answer || '';
                if (runtime.answerResolver) {
                    const resolver = runtime.answerResolver;
                    runtime.pendingQuestion = null;
                    renderPage();
                    resolver(answer);
                }
                return;
            }
            case 'submit-inline-answer': {
                const container = target.closest('.cb-step-inline-answer');
                const input = container ? container.querySelector('[data-cb-role="inline-answer-input"]') : null;
                const answer = input ? String(input.value || '').trim() : '';
                if (!answer) {
                    setToast('Please enter an answer first.', 'warn');
                    if (input) input.focus();
                    return;
                }
                if (runtime.answerResolver) {
                    const resolver = runtime.answerResolver;
                    runtime.pendingQuestion = null;
                    renderPage();
                    resolver(answer);
                }
                return;
            }
            case 'toggle-folder': {
                const path = target.dataset.path || '';
                if (runtime.expanded.has(path)) runtime.expanded.delete(path);
                else runtime.expanded.add(path);
                renderHostSurfaces();
                renderPage();
                return;
            }
            // A PROJECT folder root. Roots default to open (see runtime.collapsedRoots),
            // so this toggles membership in the collapsed set rather than the expanded one.
            case 'toggle-folder-root': {
                const folderId = target.dataset.folderId || '';
                if (!folderId) return;
                const key = ui.folderRootKey(folderId);
                if (runtime.collapsedRoots.has(key)) runtime.collapsedRoots.delete(key);
                else runtime.collapsedRoots.add(key);
                renderHostSurfaces();
                renderPage();
                return;
            }
            // The tree is multi-root now, so both commands cover every project
            // folder and every directory inside it — not just the active one.
            case 'expand-all': {
                runtime.collapsedRoots.clear();
                core.listFiles().forEach(path => {
                    const parts = path.split('/');
                    parts.pop();
                    let walked = [];
                    parts.forEach(part => {
                        walked = walked.concat([part]);
                        runtime.expanded.add(walked.join('/'));
                    });
                });
                renderHostSurfaces();
                renderPage();
                return;
            }
            case 'collapse-all':
                runtime.expanded.clear();
                // Roots default to OPEN, so collapsing everything means adding every
                // root to the collapsed set — clearing it would leave them open.
                core.listFolders().forEach(folder => {
                    runtime.collapsedRoots.add(ui.folderRootKey(folder.id));
                });
                renderHostSurfaces();
                renderPage();
                return;
            // ---- project folders ------------------------------------
            case 'select-folder': {
                const folderId = target.dataset.folderId || '';
                if (!folderId) return;
                selectFolder(folderId);
                return;
            }
            case 'new-folder':
                openNewFolderModal();
                return;
            case 'open-folder':
                pickFolderFromDisk();
                return;
            case 'rename-folder':
                openRenameFolderModal(target.dataset.folderId || '');
                return;
            case 'delete-folder':
                confirmDeleteFolder(target.dataset.folderId || '');
                return;
            case 'open-file': {
                const path = target.dataset.path || '';
                if (!core.readFile(path)) {
                    setToast(`${path} is not in the project.`, 'warn');
                    return;
                }
                // A document opens in its OWN editor tab next to the Agent.
                openFileTab(path);
                return;
            }
            case 'viewer-toggle': {
                const ws = wsModule();
                const path = target.dataset.path || core.store.openPath;
                if (ws && runtime.workspace && path) {
                    const current = ws.viewerModeFor(runtime.workspace, path, core.readSettings());
                    ws.setViewerMode(runtime.workspace, path, current === 'source' ? 'preview' : 'source');
                    persistWorkspace();
                } else {
                    runtime.viewerMode = runtime.viewerMode === 'source' ? 'preview' : 'source';
                }
                renderPage();
                return;
            }
            // The previewer's own toolbar buttons. Each one flips the Settings ->
            // Workspace -> Editor field it controls, so the toolbar and the
            // settings page cannot disagree about what is on.
            case 'preview-color':
            case 'preview-wrap':
            case 'preview-gutter': {
                const KEYS = {
                    'preview-color': 'syntaxHighlighting',
                    'preview-wrap': 'wrapLongLines',
                    'preview-gutter': 'showLineNumbers'
                };
                const key = KEYS[target.dataset.cbAction];
                if (!key) return;
                const settings = core.readSettings();
                const schema = schemaModule();
                const field = schema ? schema.getField(key) : null;
                const next = !settings[key];
                settings[key] = field && schema
                    ? schema.coerceField(field, next, settings[key])
                    : next;
                core.writeSettings(settings);
                renderPage();
                return;
            }
            case 'copy-file': {
                const record = core.readFile(target.dataset.path || '');
                if (record) void copyText(record.content, record.path);
                return;
            }
            case 'download-file': {
                const record = core.readFile(target.dataset.path || '');
                if (record) {
                    downloadText(record.path.split('/').pop(), record.content, 'text/markdown;charset=utf-8');
                    setToast(`Downloaded ${record.path}.`, 'success');
                }
                return;
            }
            case 'rename-file':
                openRenameModal(target.dataset.path || '');
                return;
            case 'delete-file':
                confirmDeleteFile(target.dataset.path || '');
                return;
            case 'add-source-file':
                openAddSourceModal();
                return;
            case 'detach-source-file': {
                const path = target.dataset.path || (target.closest('[data-path]')?.dataset.path) || '';
                if (path) detachSourceFile(path);
                return;
            }
            case 'clear-attached-files':
                clearAttachedFiles();
                return;
            case 'go-files':
                goToSection('cb-files');
                return;
            case 'new-file':
                openNewFileModal();
                return;
            case 'pick-upload': {
                const container = hostElements()?.settingsContainer;
                const input = container && container.querySelector('[data-cb-field="file"]');
                if (input) input.click();
                return;
            }
            case 'export-project':
                exportProject();
                return;
            case 'clear-history':
                confirmClearHistory();
                return;
            case 'clear-files':
                confirmClearFiles();
                return;
            case 'copy-message': {
                const message = runtime.messages.find(item => item.id === target.dataset.messageId);
                if (message) void copyText(message.text, 'Response');
                return;
            }
            case 'revise-message':
                void reviseDocument(target.dataset.messageId);
                return;
            case 'retry-message': {
                const message = runtime.messages.find(item => item.id === target.dataset.messageId);
                if (!message) return;
                const lastUser = [...runtime.messages].reverse().find(item => item.role === 'user');
                if (!lastUser) return;
                runtime.messages = runtime.messages.filter(item => item.id !== message.id);
                renderPage();
                void runSelectedSkill(lastUser.text);
                return;
            }
            case 'open-run': {
                const run = core.findRun(target.dataset.runId || '');
                if (!run) return;
                runtime.activeRunId = run.id;
                core.store.activeRunId = run.id;
                core.writeStore();
                runtime.currentRun = run;
                runtime.selectedSkillId = run.skillId || runtime.selectedSkillId;
                runtime.projectName = run.projectName || runtime.projectName;
                rebuildMessagesFromRun(run);
                goToSection('cb-agent');
                return;
            }
            case 'delete-run': {
                const runId = target.dataset.runId || '';
                core.deleteRun(runId);
                loadRuns();
                if (runtime.currentRun && runtime.currentRun.id === runId) {
                    runtime.currentRun = null;
                    runtime.messages = [];
                }
                setToast('Run deleted.', 'info');
                renderHostSurfaces();
                renderPage();
                return;
            }
            case 'close-modal':
                if (runtime.busy && runtime.pendingQuestion) return;
                runtime.modal = null;
                renderPage();
                return;
            case 'confirm-modal': {
                const modal = runtime.modal;
                if (!modal || typeof modal.onConfirm !== 'function') {
                    runtime.modal = null;
                    renderPage();
                    return;
                }
                const container = hostElements()?.settingsContainer;
                const values = {};
                if (container) {
                    container.querySelectorAll('[data-cb-field]').forEach(field => {
                        values[field.dataset.cbField] = field.value;
                    });
                }
                const keepOpen = modal.onConfirm(values) === false;
                if (!keepOpen) runtime.modal = null;
                renderPage();
                return;
            }
            default:
                return;
        }
    }

    function findStep(stepId) {
        const run = runtime.currentRun;
        if (run) {
            const step = (run.phases || []).find(item => item.id === stepId);
            if (step) return step;
        }
        for (const message of runtime.messages) {
            const step = (message.steps || []).find(item => item.id === stepId);
            if (step) return step;
        }
        return null;
    }

    function onInput(event) {
        if (!isBlueprintPage()) return;
        const target = event.target;
        if (target && target.dataset && target.dataset.cbRole === 'composer') {
            runtime.draft = target.value;
            return;
        }
        if (target && target.dataset && target.dataset.cbSetting) {
            applySettingInput(target);
            return;
        }
        // Live settings search: filters the sidebar as you type.
        if (target && target.dataset && target.dataset.cbRole === 'settings-search') {
            const ws = wsModule();
            if (ws && runtime.workspace) {
                ws.setSettingsQuery(runtime.workspace, target.value);
                persistWorkspace();
            }
            renderHostSurfaces();
            return;
        }
    }

    /**
     * Write one control's value through the schema, so it is clamped to the
     * documented bounds before it is stored — an out-of-range number typed by
     * hand cannot leak into a prompt.
     */
    function applySettingInput(target) {
        const key = target.dataset.cbSetting;
        const schema = schemaModule();
        const settings = core.readSettings();
        let raw;

        if (target.type === 'checkbox') raw = target.checked;
        else if (target.type === 'radio') { if (!target.checked) return; raw = target.value; }
        else if (target.type === 'number' || target.type === 'range') raw = Number(target.value);
        else raw = target.value;

        const field = schema ? schema.getField(key) : null;
        settings[key] = field && schema
            ? schema.coerceField(field, raw, settings[key])
            : raw;

        core.writeSettings(settings);

        // Reflect the clamped value back into the control so the UI cannot show
        // a number the engine will not actually use.
        if (field && (target.type === 'number' || target.type === 'range')) {
            const clamped = settings[key];
            if (String(clamped) !== String(target.value)) target.value = String(clamped);
            const readout = hostElements()?.settingsContainer
                ?.querySelector(`[data-cb-role="range-value-${cssEscape(key)}"]`);
            if (readout) {
                readout.textContent = typeof field.format === 'function'
                    ? field.format(clamped)
                    : String(clamped);
            }
        }
        if (field && (field.type === 'textarea' || field.type === 'text')) {
            const counter = hostElements()?.settingsContainer
                ?.querySelector(`[data-cb-role="counter-${cssEscape(key)}"]`);
            if (counter) counter.textContent = `${String(settings[key] || '').length} / ${field.maxChars || 240}`;
        }

        // Some settings change layout immediately; refresh the host surfaces so
        // nav counts and ribbon state stay correct.
        renderHostSurfaces();
        if (key === 'pinAgentTab' || key === 'maxOpenTabs' || key === 'restoreTabsOnLoad') {
            ensureWorkspace();
            const ws = wsModule();
            if (ws && runtime.workspace) ws.syncAgentPin(runtime.workspace, settings);
            persistWorkspace();
            renderPage();
        }
    }

    function onChange(event) {
        if (!isBlueprintPage()) return;
        const target = event.target;
        if (!target) return;

        if (target.dataset.cbRole === 'composer-folder-select') {
            const val = target.value;
            if (val === '__new__') {
                target.value = runtime.activeFolderId || core.DEFAULT_FOLDER_ID;
                openNewFolderModal();
                return;
            }
            if (val === '__import__') {
                target.value = runtime.activeFolderId || core.DEFAULT_FOLDER_ID;
                pickFolderFromDisk();
                return;
            }
            if (val && val !== (runtime.activeFolderId || core.DEFAULT_FOLDER_ID)) {
                selectFolder(val);
            }
            return;
        }

        if (target.dataset.cbRole === 'composer-file-select') {
            const val = target.value;
            if (val === '__add__') {
                target.value = '';
                openAddSourceModal();
                return;
            }
            if (val) {
                attachExistingFile(val);
                target.value = '';
            }
            return;
        }

        if (!runtime.modal) return;
        if (target.dataset.cbField !== 'file') return;
        const file = target.files && target.files[0];
        if (!file) return;
        if (file.size > ui.MAX_SOURCE_FILE_BYTES) {
            setToast(`${file.name} is ${Math.round(file.size / 1024)} KB; the limit is ${Math.round(ui.MAX_SOURCE_FILE_BYTES / 1024)} KB.`, 'error');
            target.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const container = hostElements()?.settingsContainer;
            if (!container) return;
            const pathField = container.querySelector('[data-cb-field="path"]');
            const contentField = container.querySelector('[data-cb-field="content"]');
            const base = String(file.name || 'file.txt').replace(/[\\:*?"<>|]/g, '-').slice(0, 80);
            if (pathField && !pathField.value.trim()) pathField.value = `src/${base}`;
            if (contentField) contentField.value = String(reader.result || '');
            setToast(`Loaded ${file.name}.`, 'success');
        };
        reader.onerror = () => setToast(`Could not read ${file.name}.`, 'error');
        reader.readAsText(file);
    }

    function onKeydown(event) {
        if (!isBlueprintPage()) return;
        const target = event.target;

        if (runtime.isHistoryOpen && event.key === 'Escape') {
            event.preventDefault();
            runtime.isHistoryOpen = false;
            renderPage();
            return;
        }

        if (runtime.modal) {
            if (event.key === 'Escape') {
                if (runtime.busy && runtime.pendingQuestion) return;
                event.preventDefault();
                runtime.modal = null;
                renderPage();
                return;
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                const confirm = document.querySelector('[data-cb-action="confirm-modal"]');
                if (confirm) { event.preventDefault(); confirm.click(); }
                return;
            }
            if (event.key === 'Tab') {
                trapFocus(event, '.cb-modal');
                return;
            }
            return;
        }

        if (target && target.dataset && target.dataset.cbRole === 'inline-answer-input') {
            if (event.key === 'Enter') {
                event.preventDefault();
                const container = target.closest('.cb-step-inline-answer');
                const btn = container ? container.querySelector('[data-cb-action="submit-inline-answer"]') : null;
                if (btn) btn.click();
                return;
            }
        }

        if (target && target.dataset && target.dataset.cbRole === 'composer') {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
                return;
            }
            if (event.key === 'Escape' && runtime.busy) {
                event.preventDefault();
                void stopRun();
            }
            return;
        }

        if (target && target.classList && target.classList.contains('cb-tree-row')
            && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            target.click();
            return;
        }

        // ---- IDE workspace shortcuts (Ctrl+W, Ctrl+Tab, Ctrl+1..4, Ctrl+S,
        // Ctrl+F, Alt+Left). Handled by workspace.js so the keymap lives in one
        // place next to the tab model it drives.
        const ws = wsModule();
        if (ws && runtime.workspace) {
            const actions = {
                closeTab: tabId => closeTabById(tabId),
                cycleTab: direction => {
                    const nextId = ws.cycleIndex(runtime.workspace, direction);
                    if (nextId) activateTabById(nextId);
                },
                openSection: sectionId => openSectionTab(sectionId),
                downloadFile: path => {
                    const record = core.readFile(path);
                    if (record) {
                        downloadText(record.path.split('/').pop(), record.content, 'text/markdown;charset=utf-8');
                        setToast(`Downloaded ${record.path}.`, 'success');
                    }
                },
                focusSettingsSearch: () => {
                    const input = hostElements()?.settingsContainer?.querySelector('[data-cb-role="settings-search"]');
                    if (input) { try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); } }
                }
            };
            if (ws.handleShortcut(runtime.workspace, event, actions, core.readSettings())) {
                event.preventDefault();
            }
        }
    }

    function trapFocus(event, selector) {
        const scope = document.querySelector(selector);
        if (!scope) return;
        const focusable = [...scope.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
            .filter(node => node.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    // ------------------------------------------------------------------
    // Page controller lifecycle
    // ------------------------------------------------------------------

    const controller = {
        appId: APP_ID,

        mount(context) {
            runtime.context = context || runtime.context;
            if (runtime.mounted) return;
            runtime.mounted = true;
            ensureHostRecord();
            ensureWorkspace();
            loadRuns();
            if (runtime.currentRun) rebuildMessagesFromRun(runtime.currentRun);
            runtime.selectedSkillId = (runtime.currentRun && runtime.currentRun.skillId) || runtime.selectedSkillId;
        },

        activate(context) {
            runtime.context = context || runtime.context;
            runtime.active = true;
            runtime.generation += 1;
            ensureHostRecord();
            ensureWorkspace();
            loadRuns();
            if (!runtime.messages.length && runtime.currentRun) rebuildMessagesFromRun(runtime.currentRun);
            // Do NOT force the Agent tab: restoreTabsOnLoad keeps whatever the
            // user had open. The folder is derived from the active tab instead.
            syncFolderFromTab();
            runtime.hint = selectedSkill().tagline;
            // setApp() sets state.folder to 'all' before the page renders, so the
            // nav/list/ribbon surfaces must be refreshed once the section is known.
            renderHostSurfaces();
            renderPage();
        },

        deactivate() {
            runtime.active = false;
            const composer = hostElements()?.settingsContainer?.querySelector('[data-cb-role="composer"]');
            if (composer) runtime.draft = composer.value;
            persistWorkspace();
            // The divider lives beside the host list pane, outside our container,
            // so it must be removed explicitly when the page is left.
            releaseDivider();
        },

        unmount() {
            runtime.active = false;
            runtime.mounted = false;
            runtime.generation += 1;
            persistWorkspace();
            releaseDivider();
            clearTimeout(runtime.toastTimer);
            runtime.toastTimer = null;
            if (!runtime.busy) {
                runtime.modal = null;
                runtime.pendingQuestion = null;
            }
            runtime.context = null;
        },

        serializeState() {
            return {
                section: runtime.folder,
                skillId: runtime.selectedSkillId,
                viewerMode: runtime.viewerMode,
                openPath: core.store.openPath,
                expanded: [...runtime.expanded].slice(0, 60),
                activeRunId: runtime.activeRunId,
                // The host may snapshot/restore the page across app switches; the
                // tab layout rides along so a restore lands on the same tab.
                workspace: runtime.workspace ? JSON.parse(JSON.stringify(runtime.workspace)) : null
            };
        },

        restoreState(contextOrValue, maybeValue) {
            const value = hookContext(contextOrValue, maybeValue);
            if (!value || typeof value !== 'object' || Array.isArray(value)) return;
            if (typeof value.section === 'string' && ui.SECTIONS.some(section => section.id === value.section)) {
                runtime.folder = value.section;
            }
            if (skills.getSkill(value.skillId)) runtime.selectedSkillId = value.skillId;
            if (value.viewerMode === 'source' || value.viewerMode === 'preview') runtime.viewerMode = value.viewerMode;
            if (typeof value.openPath === 'string') core.setOpenPath(value.openPath);
            if (Array.isArray(value.expanded)) runtime.expanded = new Set(value.expanded.map(String));
            if (typeof value.activeRunId === 'string') runtime.activeRunId = value.activeRunId;
            if (value.workspace && wsModule()) {
                runtime.workspace = wsModule().normalizeWorkspace(value.workspace, core.readSettings());
                syncFolderFromTab();
            }
        },

        onThemeChanged(contextOrDetail, maybeDetail) {
            hookContext(contextOrDetail, maybeDetail);
            if (runtime.active) renderPage();
        },

        onAccentChanged() {
            if (runtime.active) renderPage();
        },

        onConnectivityChanged(contextOrDetail, maybeDetail) {
            const detail = hookContext(contextOrDetail, maybeDetail);
            if (!runtime.active) return;
            const online = !detail || detail.online !== false;
            runtime.hint = online
                ? selectedSkill().tagline
                : 'Offline — Blueprint needs the model endpoint, but your project files stay available.';
            renderPage();
        },

        onFolderChanged(contextOrId, maybeId) {
            // The host sets state.folder BEFORE dispatching this hook, and passes
            // its context as the first argument — so when the payload is missing or
            // is not a string, read the section the host already chose.
            const payload = hookContext(contextOrId, maybeId);
            const hostFolder = runtime.context && runtime.context.state
                ? runtime.context.state.folder
                : '';
            const section = typeof payload === 'string' && payload
                ? payload
                : (typeof hostFolder === 'string' && hostFolder ? hostFolder : 'cb-agent');

            // Clicking a sidebar section opens (or activates) its tab rather than
            // just repainting, so the Agent chat stays open beside it.
            if (wsModule() && runtime.workspace) {
                openSectionTab(section);
                return;
            }
            runtime.folder = section;
            renderPage();
        },

        renderNav(context, hostApi) {
            runtime.context = context || runtime.context;
            const elements = hostElements();
            if (elements && elements.navTitle) elements.navTitle.textContent = 'Blueprint';
            if (elements && elements.navFolderList) {
                elements.navFolderList.setAttribute('aria-label', 'Blueprint navigation');
            }
            ui.renderNav(stateSnapshot(), hostApi);
        },

        renderRibbon(context, hostApi) {
            runtime.context = context || runtime.context;
            ui.renderRibbon(stateSnapshot(), hostApi);
        },

        renderList(context) {
            runtime.context = context || runtime.context;
            const elements = hostElements();
            if (!elements) return;
            ui.renderList(stateSnapshot(), elements.listTitle, elements.listContent);
        },

        renderPage(context) {
            runtime.context = context || runtime.context;
            renderPage();
        }
    };

    // ------------------------------------------------------------------
    // Register with the host
    // ------------------------------------------------------------------

    host.registerController({
        pluginId: PLUGIN_ID,
        capabilities: MANIFEST.frontend.capabilities.slice(),
        extensionType: 'assistant',
        commandMeta: {
            'codalioBlueprint.openPage': { icon: 'fa-compass-drafting', contexts: ['blueprint'], featured: true, keywords: ['blueprint', 'prd', 'planning', 'agent'] },
            'codalioBlueprint.runPrdBuilder': { icon: 'fa-file-lines', contexts: ['blueprint'], keywords: ['prd', 'product requirements', 'mvp'] },
            'codalioBlueprint.exportOpenDocument': { icon: 'fa-file-export', contexts: ['blueprint'], keywords: ['export', 'download', 'markdown'] }
        },
        commands: {
            'codalioBlueprint.openPage': () => {
                if (typeof window.setApp === 'function') window.setApp(APP_ID);
            },
            'codalioBlueprint.runPrdBuilder': () => {
                runtime.selectedSkillId = 'prd-builder';
                if (typeof window.setApp === 'function') window.setApp(APP_ID);
                goToSection('cb-agent');
                focusComposer();
            },
            'codalioBlueprint.exportOpenDocument': () => {
                const path = core.store.openPath;
                const record = path ? core.readFile(path) : null;
                if (!record) {
                    setToast('Open a document first.', 'warn');
                    return;
                }
                downloadText(record.path.split('/').pop(), record.content, 'text/markdown;charset=utf-8');
                setToast(`Downloaded ${record.path}.`, 'success');
            }
        },
        exporters: {
            'codalioBlueprint.exportOpenDocument': () => {
                const path = core.store.openPath;
                const record = path ? core.readFile(path) : null;
                if (!record) return;
                downloadText(record.path.split('/').pop(), record.content, 'text/markdown;charset=utf-8');
            }
        },
        pages: { [PAGE_ID]: controller }
    });

    host.registerManifest(MANIFEST);

    // Seed the host plugin record NOW, at script-load time. app.bundle.js defers
    // its init() (and the loadPluginsFromStorage read) to DOMContentLoaded, which
    // fires after this injected script runs — so the record must already exist for
    // the extension host to treat the page as enabled and render its app-bar icon.
    ensureHostRecord();

    // Global Blueprint API for tests and for the host command dispatcher.
    window.codalioBlueprint = Object.freeze({
        pluginId: PLUGIN_ID,
        pageId: PAGE_ID,
        appId: APP_ID,
        recordMarker: RECORD_MARKER,
        openPage: () => { if (typeof window.setApp === 'function') window.setApp(APP_ID); },
        selectSkill(id) { if (skills.getSkill(id)) runtime.selectedSkillId = id; },
        listSkills: () => skills.SKILLS.map(skill => ({ id: skill.id, name: skill.name })),
        listFiles: () => core.listFiles(),
        readFile: path => core.readFile(path),
        listRuns: () => core.store.runs.map(run => ({ id: run.id, skill: run.skillId, status: run.status })),
        isBusy: () => runtime.busy
    });

    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', onKeydown);
}());
