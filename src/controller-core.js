/*
 * Codalio Blueprint for SimpleRAG — core runtime.
 *
 * Standalone module: state, virtual project filesystem, safe Markdown
 * renderer, model streaming against the host's existing chat endpoint, and
 * the visible step engine that drives each Blueprint skill.
 *
 * This file never touches SimpleRAG internals. It only reads the public host
 * globals (window.RagChatStreaming, window.withConfiguredModelEndpointPayload)
 * and the public /api/extensions/rag-workspace routes the host already serves.
 */
(function defineBlueprintCore() {
    'use strict';

    if (window.__codalioBlueprintCore) return;

    const API_BASE = '/api/extensions/rag-workspace';
    const PLUGIN_ID = 'codalio-blueprint';

    /**
     * Every storage key Blueprint owns, composed from the plug-in id so a key can
     * never be misspelled in one place and right in another — and so nothing
     * Blueprint writes can collide with a SimpleRAG key.
     *
     * Deliberately built by concatenation rather than written as long literals:
     * a truncated literal here fails silently, because the plug-in would read and
     * write the same wrong key and every test would still pass.
     */
    const keyFor = suffix => PLUGIN_ID + '.' + suffix + '.v1';
    const PROJECTS_KEY = keyFor('projects');
    const SETTINGS_KEY = keyFor('settings');
    const REMOVED_KEY = keyFor('removed');
    const WORKSPACE_KEY = keyFor('workspace');

    // ------------------------------------------------------------------
    // Text helpers
    // ------------------------------------------------------------------

    function esc(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function clampText(value, max) {
        const text = String(value === null || value === undefined ? '' : value);
        return text.length > max ? text.slice(0, max) : text;
    }

    function slugify(value) {
        const slug = String(value || '')
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48);
        return slug || 'project';
    }

    function todayStamp() {
        const now = new Date();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${now.getFullYear()}-${month}-${day}`;
    }

    function formatClock(value) {
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        });
    }

    function uid(prefix) {
        const random = Math.random().toString(36).slice(2, 8);
        return `${prefix || 'id'}-${Date.now().toString(36)}-${random}`;
    }

    // ------------------------------------------------------------------
    // Settings
    // ------------------------------------------------------------------

    /**
     * Documented defaults for every Blueprint setting. settings.js derives its
     * own schema defaults from here where the two overlap, so a headless run
     * (agent tests, no UI layer loaded) and a UI run always agree.
     *
     * Each key is wired to real behaviour — see settings.js for where.
     */
    const DEFAULT_SETTINGS = {
        // Agent -> Planning
        concurrency: 'parallel',
        askClarifyingQuestions: true,
        announceSkill: true,
        selfReviewPass: true,
        requireReviewGate: true,
        autoOpenWrittenDocument: true,

        // Agent -> Context Compression (Anti-gravity Protocol)
        contextCompression: true,
        autoCompactThreshold: 6,

        // Agent -> Model
        temperature: 0.3,
        lensMaxOutputTokens: 4096,
        documentMaxOutputTokens: 8192,
        maxPromptChars: 2400,
        confirmStop: false,

        // Agent -> Step detail
        streamLive: true,
        showPromptPreview: true,
        stepElapsed: true,
        expandRunningSteps: true,
        autoScrollTranscript: true,

        // Documents -> Naming & folders
        fileNameStyle: 'date-slug',
        overwriteExistingFile: 'version',
        folderLayout: 'skill-folders',

        // Documents -> Content handling
        unwrapCodeFences: true,
        substitutePlaceholders: true,
        applyDocumentHeader: false,
        trimPreamble: true,
        extraGuidance: '',

        // Workspace -> Tabs
        pinAgentTab: true,
        maxOpenTabs: 8,
        restoreTabsOnLoad: true,
        closeTabOnDelete: true,

        // Workspace -> Layout
        listPaneWidth: 300,
        treeIndentPx: 13,
        autoExpandWrittenFolders: true,
        showFileMeta: true,

        // Workspace -> Editor
        defaultViewerMode: 'preview',
        wrapLongLines: true,
        showLineNumbers: true,
        syntaxHighlighting: true,
        readingWidth: 'wide',

        // Source files -> Attach limits
        maxSourceFiles: 50,
        maxSourceFileKb: 500,
        maxSourceTotalKb: 2048,
        includeSourceInPrompts: true,

        // Source files -> Whole-codebase digest
        // 'attached' = only the manually attached files, capped by the limits
        //   above (the v1 behaviour).
        // 'digest'   = the whole project folder, as a structural digest plus
        //   verbatim text for the highest-value code files.
        sourceContextMode: 'attached',
        // 16,000 tokens measured at ~2.7 min of prompt evaluation on the
        // target GPU (95 tok/s at long prompts). 32K was ~5 min, which is where
        // a planning step stops feeling responsive.
        digestBudgetTokens: 16000,
        digestMinFullTextLines: 40,

        // Data -> Storage & privacy
        showStorageUsage: true
    };

    function readSettingsRaw() {
        try {
            const raw = window.localStorage.getItem(SETTINGS_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (_) {
            return {};   // corrupt settings fall back to defaults
        }
    }

    /**
     * Bound every setting to its documented range. When the schema engine
     * (settings.js) is loaded it owns the bounds, so the UI and the agent can
     * never disagree. Without it — headless tests, or a partially loaded page —
     * core applies the same limits itself.
     */
    function readSettings() {
        const schema = window.__codalioBlueprintSettings;
        if (schema && typeof schema.normalizeSettings === 'function') {
            try {
                return schema.normalizeSettings(readSettingsRaw());
            } catch (_) { /* fall through to the built-in bounds */ }
        }

        const raw = readSettingsRaw();
        const settings = { ...DEFAULT_SETTINGS };
        Object.keys(DEFAULT_SETTINGS).forEach(key => {
            if (raw[key] !== undefined) settings[key] = raw[key];
        });

        settings.concurrency = settings.concurrency === 'sequential' ? 'sequential' : 'parallel';
        settings.temperature = boundedFloat(settings.temperature, 0, 1.5, DEFAULT_SETTINGS.temperature);
        settings.lensMaxOutputTokens = boundedInt(settings.lensMaxOutputTokens, 512, 32768, DEFAULT_SETTINGS.lensMaxOutputTokens);
        settings.documentMaxOutputTokens = boundedInt(settings.documentMaxOutputTokens, 512, 32768, DEFAULT_SETTINGS.documentMaxOutputTokens);
        settings.maxPromptChars = boundedInt(settings.maxPromptChars, 200, 8000, DEFAULT_SETTINGS.maxPromptChars);
        settings.maxOpenTabs = boundedInt(settings.maxOpenTabs, 2, 24, DEFAULT_SETTINGS.maxOpenTabs);
        settings.listPaneWidth = boundedInt(settings.listPaneWidth, 220, 520, DEFAULT_SETTINGS.listPaneWidth);
        settings.treeIndentPx = boundedInt(settings.treeIndentPx, 8, 28, DEFAULT_SETTINGS.treeIndentPx);
        settings.maxSourceFiles = boundedInt(settings.maxSourceFiles, 1, 150, DEFAULT_SETTINGS.maxSourceFiles);
        settings.maxSourceFileKb = boundedInt(settings.maxSourceFileKb, 8, 2048, DEFAULT_SETTINGS.maxSourceFileKb);
        settings.maxSourceTotalKb = boundedInt(settings.maxSourceTotalKb, 32, 16384, DEFAULT_SETTINGS.maxSourceTotalKb);
        settings.autoCompactThreshold = boundedInt(settings.autoCompactThreshold, 2, 20, DEFAULT_SETTINGS.autoCompactThreshold);
        // Upper bound 65536: at the measured 95 tok/s for long prompts, ~16K is
        // ~2.7 min of prompt evaluation and 65K is ~11 min. Allowing more would
        // let a user configure a step that looks hung. The lower bound 2048
        // keeps room for a usable digest of a small project.
        settings.digestBudgetTokens = boundedInt(settings.digestBudgetTokens, 2048, 65536, DEFAULT_SETTINGS.digestBudgetTokens);
        settings.digestMinFullTextLines = boundedInt(settings.digestMinFullTextLines, 1, 2000, DEFAULT_SETTINGS.digestMinFullTextLines);

        const enums = {
            fileNameStyle: ['date-slug', 'slug-date', 'slug'],
            overwriteExistingFile: ['ask', 'version', 'overwrite'],
            folderLayout: ['skill-folders', 'flat'],
            defaultViewerMode: ['preview', 'source'],
            readingWidth: ['narrow', 'wide', 'full'],
            sourceContextMode: ['attached', 'digest']
        };
        Object.keys(enums).forEach(key => {
            if (!enums[key].includes(settings[key])) settings[key] = DEFAULT_SETTINGS[key];
        });

        // Booleans whose default is true stay true unless explicitly set false;
        // booleans whose default is false stay false unless explicitly set true.
        Object.keys(DEFAULT_SETTINGS).forEach(key => {
            if (typeof DEFAULT_SETTINGS[key] !== 'boolean') return;
            settings[key] = DEFAULT_SETTINGS[key] === true
                ? settings[key] !== false
                : settings[key] === true;
        });
        settings.extraGuidance = typeof settings.extraGuidance === 'string'
            ? settings.extraGuidance.slice(0, 1200)
            : '';

        return settings;
    }

    function boundedInt(value, min, max, fallback) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
    }

    function boundedFloat(value, min, max, fallback) {
        const parsed = Number.parseFloat(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
    }

    function writeSettings(settings) {
        try {
            window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (_) { /* storage full or unavailable */ }
    }

    // ------------------------------------------------------------------
    // Persistence: projects, runs, and the virtual filesystem
    // ------------------------------------------------------------------

    /** Id of the folder that always exists and owns anything unfiled. */
    const DEFAULT_FOLDER_ID = 'folder-default';

    function emptyFolder(id, name, origin) {
        const now = new Date().toISOString();
        return {
            id: String(id),
            name: String(name),
            origin: String(origin || 'created'),
            createdAt: now,
            updatedAt: now
        };
    }

    function emptyStore() {
        const folders = {};
        folders[DEFAULT_FOLDER_ID] = emptyFolder(DEFAULT_FOLDER_ID, 'Blueprint project', 'default');
        return {
            version: 2,
            folders,
            files: {},
            runs: [],
            openPath: '',
            activeRunId: '',
            activeFolderId: DEFAULT_FOLDER_ID
        };
    }

    /**
     * Bring a v1 store (flat files, no folders) forward to v2. Existing documents
     * and runs land in the default folder, so upgrading cannot lose work. Runs are
     * not folder-scoped: a run describes work on an idea, and its documents carry
     * their own folder.
     */
    function migrateStore(parsed, store) {
        const incomingFolders = parsed.folders && typeof parsed.folders === 'object' ? parsed.folders : null;
        if (incomingFolders) {
            Object.keys(incomingFolders).forEach(id => {
                const folder = incomingFolders[id];
                if (!folder || typeof folder !== 'object') return;
                store.folders[id] = Object.assign(emptyFolder(id, folder.name || id, folder.origin), {
                    createdAt: typeof folder.createdAt === 'string' ? folder.createdAt : store.folders[id].createdAt,
                    updatedAt: typeof folder.updatedAt === 'string' ? folder.updatedAt : store.folders[id].updatedAt
                });
            });
        }
        // The default folder must always exist, even if a hand-edited store dropped it.
        if (!store.folders[DEFAULT_FOLDER_ID]) {
            store.folders[DEFAULT_FOLDER_ID] = emptyFolder(DEFAULT_FOLDER_ID, 'Blueprint project', 'default');
        }
        return store;
    }

    function readStore() {
        const store = emptyStore();
        try {
            const raw = window.localStorage.getItem(PROJECTS_KEY);
            if (!raw) return store;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return store;

            migrateStore(parsed, store);

            if (parsed.files && typeof parsed.files === 'object') {
                Object.keys(parsed.files).forEach(path => {
                    const record = parsed.files[path];
                    if (!record || typeof record !== 'object') return;
                    // v1 records have no folder: file them into the default folder.
                    const folder = typeof record.folder === 'string' && store.folders[record.folder]
                        ? record.folder
                        : DEFAULT_FOLDER_ID;
                    store.files[path] = Object.assign({}, record, {
                        path: typeof record.path === 'string' ? record.path : path,
                        content: typeof record.content === 'string' ? record.content : '',
                        folder
                    });
                });
            }
            if (Array.isArray(parsed.runs)) store.runs = parsed.runs.slice(0, 60);
            store.openPath = typeof parsed.openPath === 'string' ? parsed.openPath : '';
            store.activeRunId = typeof parsed.activeRunId === 'string' ? parsed.activeRunId : '';
            const wantedFolder = typeof parsed.activeFolderId === 'string' ? parsed.activeFolderId : '';
            store.activeFolderId = store.folders[wantedFolder] ? wantedFolder : DEFAULT_FOLDER_ID;
        } catch (_) { /* corrupt store starts empty */ }
        return store;
    }

    /**
     * True for anything that belongs to the DOM rather than to the data model.
     * Agent steps hold a `liveElement` while streaming so tokens paint into one
     * node instead of re-rendering; that handle must never reach storage.
     */
    function isDomNode(value) {
        return Boolean(value)
            && typeof value === 'object'
            && typeof value.nodeType === 'number';
    }

    /**
     * JSON.stringify replacer that drops DOM nodes. Needed because nodes are
     * cyclic (node.ownerDocument -> document.activeElement -> node), so leaving
     * one in place makes the whole write throw and the run is not persisted at
     * all — which, while a step was streaming, meant every saveRun() silently
     * failed. Dropping at this boundary also covers any transient handle added
     * later, so it cannot be forgotten at a new call site.
     */
    function withoutDomNodes(_key, value) {
        return isDomNode(value) ? undefined : value;
    }

    /**
     * Outcome of the most recent persistence attempt, so a failed write is
     * visible to the UI without changing what any mutator returns.
     *
     * localStorage writes really do fail: the quota is typically ~5 MB per origin,
     * a step keeps up to MAX_STEP_TEXT characters of model output, up to 60 runs
     * are retained, and attached source defaults to 420 KB. Before this existed a
     * failed write only logged to the console, so the in-memory store moved on
     * while nothing reached disk and the user found out on reload.
     */
    const persistence = {
        ok: true,
        failedAt: 0,
        failureCount: 0,
        lastError: ''
    };

    function writeStore(store) {
        try {
            window.localStorage.setItem(PROJECTS_KEY, JSON.stringify({
                version: 2,
                folders: store.folders,
                files: store.files,
                runs: store.runs.slice(0, 60),
                openPath: store.openPath,
                activeRunId: store.activeRunId,
                activeFolderId: store.activeFolderId
            }, withoutDomNodes));
            persistence.ok = true;
            persistence.lastError = '';
            return true;
        } catch (error) {
            persistence.ok = false;
            persistence.failedAt = Date.now();
            persistence.failureCount += 1;
            persistence.lastError = String((error && error.message) || error || 'unknown storage error');
            console.warn('[codalio-blueprint] unable to persist project state', error);
            return false;
        }
    }

    /** A copy of the persistence state, safe to hand to the renderer. */
    function persistenceState() {
        return Object.assign({}, persistence);
    }

    const store = readStore();

    // ------------------------------------------------------------------
    // Workspace (tab layout) persistence
    //
    // Kept in its OWN localStorage key, separate from projects and settings, so
    // clearing run history or documents never loses the tab layout and vice
    // versa. workspace.js owns normalization; core only stores the raw object.
    // ------------------------------------------------------------------

    function readWorkspaceRaw() {
        try {
            const raw = window.localStorage.getItem(WORKSPACE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    function saveWorkspace(workspace) {
        if (!workspace || typeof workspace !== 'object') return false;
        try {
            // Persist only the shape workspace.js normalizes back, never DOM or
            // handler references that may have been attached to it.
            const tabs = (Array.isArray(workspace.tabs) ? workspace.tabs : []).map(tab => ({
                id: String(tab.id || ''),
                kind: tab.kind === 'file' ? 'file' : (tab.kind === 'section' ? 'section' : 'agent'),
                title: String(tab.title || ''),
                icon: String(tab.icon || ''),
                sectionId: String(tab.sectionId || ''),
                path: String(tab.path || ''),
                pinned: tab.pinned === true,
                openedAt: Number(tab.openedAt) || Date.now(),
                lastActiveAt: Number(tab.lastActiveAt) || Date.now()
            }));
            window.localStorage.setItem(WORKSPACE_KEY, JSON.stringify({
                version: 1,
                tabs,
                activeTabId: String(workspace.activeTabId || ''),
                settingsSection: String(workspace.settingsSection || ''),
                settingsPage: String(workspace.settingsPage || ''),
                viewerModeByPath: workspace.viewerModeByPath && typeof workspace.viewerModeByPath === 'object'
                    ? workspace.viewerModeByPath
                    : {},
                dividerPx: Number(workspace.dividerPx) || 0
            }, withoutDomNodes));
            return true;
        } catch (error) {
            console.warn('[codalio-blueprint] unable to persist the tab layout', error);
            return false;
        }
    }

    function clearWorkspace() {
        try {
            window.localStorage.removeItem(WORKSPACE_KEY);
        } catch (_) { /* nothing to clear */ }
    }

    /**
     * Every stored document, optionally scoped to one folder.
     *
     * The folder argument is optional on purpose: agent.js, the viewer, the tree
     * and the storage metrics all call listFiles() with no argument and want every
     * file. Only the folder-scoped sidebar view passes an id.
     */
    function listFiles(folderId) {
        const scope = typeof folderId === 'string' && folderId ? folderId : '';
        return Object.keys(store.files)
            .filter(path => store.files[path] && typeof store.files[path].content === 'string')
            .filter(path => !scope || store.files[path].folder === scope)
            .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    }

    function readFile(path) {
        return store.files[path] || null;
    }

    function writeFile(path, content, meta) {
        const cleanPath = String(path || '').replace(/^\/+/, '').trim();
        if (!cleanPath) return null;
        const previous = store.files[cleanPath] || null;

        // Safety Policy:
        // Standalone project access can read and create files freely,
        // and edit/rewrite files it creates only.
        // User project files (origin === 'imported') are protected from in-place rewrites.
        if (previous && previous.origin === 'imported') {
            const isImportAction = Boolean(meta && meta.origin === 'imported');
            if (!isImportAction) {
                console.warn(`[codalio-blueprint] protected user source file: ${cleanPath}. Writing revision to docs/ instead.`);
                const safePath = cleanPath.startsWith('docs/') ? cleanPath : `docs/${cleanPath}.revised.md`;
                return writeFile(safePath, content, Object.assign({}, meta, { origin: 'blueprint', createdBy: 'blueprint' }));
            }
        }

        const now = new Date().toISOString();
        const wantedFolder = (meta && typeof meta.folder === 'string' && store.folders[meta.folder])
            ? meta.folder
            : '';
        const inheritedFolder = (previous && typeof previous.folder === 'string' && store.folders[previous.folder])
            ? previous.folder
            : '';
        const folder = wantedFolder
            || inheritedFolder
            || (store.folders[store.activeFolderId] ? store.activeFolderId : DEFAULT_FOLDER_ID);

        const origin = (meta && meta.origin)
            || (previous && previous.origin)
            || (cleanPath.startsWith('docs/') ? 'blueprint' : 'created');
        const createdBy = (meta && meta.createdBy)
            || (previous && previous.createdBy)
            || (origin === 'imported' ? 'user' : 'blueprint');

        store.files[cleanPath] = {
            path: cleanPath,
            content: String(content === null || content === undefined ? '' : content),
            createdAt: previous ? previous.createdAt : now,
            updatedAt: now,
            runId: (meta && meta.runId) || (previous && previous.runId) || '',
            skill: (meta && meta.skill) || (previous && previous.skill) || '',
            folder,
            origin,
            createdBy
        };
        touchFolder(folder);
        store.openPath = cleanPath;
        // Bulk callers (a folder import) pass persist:false and write the store
        // once at the end. Persisting here would JSON.stringify the ENTIRE store
        // per file, which is O(n^2): importing 255 files serialised the whole
        // project 255 times while it grew, and that was the import freeze.
        if (!meta || meta.persist !== false) writeStore(store);
        return store.files[cleanPath];
    }

    function isReadOnlyFile(path) {
        const rec = readFile(path);
        return Boolean(rec && rec.origin === 'imported');
    }

    function canEditFile(path) {
        const rec = readFile(path);
        if (!rec) return true;
        return rec.origin !== 'imported';
    }

    function deleteFile(path) {
        if (!store.files[path]) return false;
        delete store.files[path];
        if (store.openPath === path) store.openPath = listFiles()[0] || '';
        writeStore(store);
        return true;
    }

    function renameFile(fromPath, toPath) {
        const record = store.files[fromPath];
        if (!record) return null;
        const target = String(toPath || '').replace(/^\/+/, '').trim();
        if (!target || store.files[target]) return null;
        delete store.files[fromPath];
        record.path = target;
        record.updatedAt = new Date().toISOString();
        store.files[target] = record;
        if (store.openPath === fromPath) store.openPath = target;
        writeStore(store);
        return record;
    }

    function setOpenPath(path) {
        store.openPath = String(path || '');
        writeStore(store);
    }

    // ------------------------------------------------------------------
    // Folders
    // ------------------------------------------------------------------

    function touchFolder(folderId) {
        const folder = store.folders[folderId];
        if (!folder) return;
        folder.updatedAt = new Date().toISOString();
    }

    function listFolders() {
        return Object.keys(store.folders)
            .map(id => store.folders[id])
            .filter(folder => folder && typeof folder === 'object')
            // The default folder first, then by name, so the sidebar is stable.
            .sort((left, right) => {
                if (left.id === DEFAULT_FOLDER_ID) return -1;
                if (right.id === DEFAULT_FOLDER_ID) return 1;
                return String(left.name).localeCompare(String(right.name), undefined, { numeric: true });
            });
    }

    function getFolder(folderId) {
        return store.folders[folderId] || null;
    }

    function activeFolder() {
        return getFolder(store.activeFolderId) || getFolder(DEFAULT_FOLDER_ID);
    }

    function setActiveFolder(folderId) {
        if (!store.folders[folderId]) return null;
        store.activeFolderId = folderId;
        writeStore(store);
        return store.folders[folderId];
    }

    /**
     * Create a project folder. Names are trimmed and de-duplicated with a numeric
     * suffix rather than rejected, because a name collision is not worth an error
     * dialog — but an empty name is, since the sidebar would show a blank row.
     */
    function createFolder(name, origin) {
        const wanted = String(name || '').trim().replace(/\s+/g, ' ');
        if (!wanted) return { folder: null, error: 'Give the folder a name.' };
        if (wanted.length > 80) {
            return { folder: null, error: 'Folder names are limited to 80 characters.' };
        }
        // Folder ids are generated, not derived from the name, so renaming a folder
        // never has to rewrite every file record that points at it.
        let id = '';
        let attempt = 0;
        do {
            attempt += 1;
            id = 'folder-' + Date.now().toString(36) + '-' + attempt.toString(36)
                + Math.random().toString(36).slice(2, 6);
        } while (store.folders[id]);

        let unique = wanted;
        let suffix = 2;
        const taken = listFolders().map(folder => folder.name.toLowerCase());
        while (taken.indexOf(unique.toLowerCase()) >= 0) {
            unique = `${wanted} (${suffix})`;
            suffix += 1;
        }

        const folder = emptyFolder(id, unique, origin || 'created');
        store.folders[id] = folder;
        store.activeFolderId = id;
        writeStore(store);
        return { folder, error: '' };
    }

    /**
     * Rename a folder. Renaming is a LABEL change only — folder ids are generated,
     * never derived from the name, so no document record has to be rewritten and
     * nothing can be orphaned.
     *
     * The default folder is refused here as well as in the UI, so hiding its
     * rename button is backed by the engine rather than being decoration: a caller
     * that reaches past the UI still cannot rename it.
     */
    function renameFolder(folderId, name) {
        const folder = store.folders[folderId];
        if (!folder) return { folder: null, error: 'That folder no longer exists.' };
        if (folderId === DEFAULT_FOLDER_ID) {
            return { folder: null, error: 'The default project folder cannot be renamed.' };
        }
        const wanted = String(name || '').trim().replace(/\s+/g, ' ');
        if (!wanted) return { folder: null, error: 'Give the folder a name.' };
        if (wanted.length > 80) return { folder: null, error: 'Folder names are limited to 80 characters.' };
        const clash = listFolders().some(other => other.id !== folderId
            && other.name.toLowerCase() === wanted.toLowerCase());
        if (clash) return { folder: null, error: `A folder named "${wanted}" already exists.` };
        folder.name = wanted;
        touchFolder(folderId);
        writeStore(store);
        return { folder, error: '' };
    }

    /**
     * Delete a folder and its documents. The default folder cannot be deleted —
     * it is where unfiled work lives, and removing it would orphan documents.
     * Returns the deleted document count so the UI can say what happened.
     */
    function deleteFolder(folderId) {
        const folder = store.folders[folderId];
        if (!folder) return { deleted: false, count: 0, error: 'That folder no longer exists.' };
        if (folderId === DEFAULT_FOLDER_ID) {
            return { deleted: false, count: 0, error: 'The default project folder cannot be deleted.' };
        }
        const doomed = listFiles(folderId);
        doomed.forEach(path => { delete store.files[path]; });
        delete store.folders[folderId];
        if (store.activeFolderId === folderId) store.activeFolderId = DEFAULT_FOLDER_ID;
        if (doomed.indexOf(store.openPath) >= 0) store.openPath = listFiles()[0] || '';
        writeStore(store);
        return { deleted: true, count: doomed.length, error: '' };
    }

    function folderFileCount(folderId) {
        return listFiles(folderId).length;
    }

    /**
     * File count for every folder, in ONE pass over store.files.
     *
     * The sidebar needs a count per folder on every render. Calling
     * folderFileCount() per folder made each render O(folders x n log n), because
     * listFiles() scans AND sorts the whole project each time — and the sort is
     * wasted work when only the length is wanted. This is O(n) with no sort.
     *
     * Folders with no files are included with a count of 0, so an empty project
     * folder still renders its badge.
     */
    function folderFileCounts() {
        const counts = {};
        Object.keys(store.folders).forEach(id => { counts[id] = 0; });
        Object.keys(store.files).forEach(path => {
            const record = store.files[path];
            if (!record || typeof record.content !== 'string') return;
            const id = typeof record.folder === 'string' && counts[record.folder] !== undefined
                ? record.folder
                : '';
            if (id) counts[id] += 1;
        });
        return counts;
    }

    // ------------------------------------------------------------------
    // "Open folder" import
    // ------------------------------------------------------------------

    /** Text extensions worth importing; everything else is reported as skipped. */
    const IMPORTABLE_EXTENSIONS = [
        'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'csv', 'tsv',
        'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h',
        'cpp', 'cc', 'hpp', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql',
        'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'xml', 'svg'
    ];

    /** Directories that are never worth importing into a planning workspace. */
    const IMPORT_SKIP_DIRS = [
        'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
        '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
        'vendor', 'bower_components', '.next', '.nuxt', '.cache', 'coverage', '.gradle'
    ];

    function extensionOf(name) {
        const clean = String(name || '');
        const dot = clean.lastIndexOf('.');
        if (dot <= 0 || dot === clean.length - 1) return '';
        return clean.slice(dot + 1).toLowerCase();
    }

    /**
     * The relative path the browser reports for a picked directory entry.
     * `webkitRelativePath` is the standard property; `relativePath` covers the
     * DataTransferItem.getAsFileSystemHandle() shape some browsers now expose.
     */
    function relativePathOf(file) {
        const raw = String((file && (file.webkitRelativePath || file.relativePath || file.name)) || '');
        return raw.replace(/\\/g, '/').replace(/^\/+/, '');
    }

    function isSkippedPath(relativePath) {
        const parts = relativePath.split('/');
        // Drop the leading directory (the folder the user picked) for the check,
        // but still catch a skipped dir at any depth.
        return parts.some(part => IMPORT_SKIP_DIRS.indexOf(part) >= 0);
    }

    /**
     * Import a directory the user picked, into a folder.
     *
     * `files` is the FileList (or array) from an <input webkitdirectory>. Each
     * entry is read as text; the importer enforces the same per-file, count and
     * total budgets that the source-attachment path uses, so a large repo cannot
     * exhaust localStorage. Every rejection is reported with a reason.
     *
     * Returns { folder, imported, skipped, truncatedByBudget } — never throws for
     * an individual unreadable file, because one locked file should not abort a
     * 500-file import.
     */
    async function importFolder(files, folderName, options) {
        const cfg = Object.assign({
            maxFileKb: 1024,
            maxFiles: 1000,
            maxTotalKb: 32768,
            skipBinary: true
        }, options || {});

        const list = Array.prototype.slice.call(files || []);
        // `notEnumerated` counts files past the point where a budget was hit. They
        // are deliberately NOT pushed into `skipped`: doing that built an array of
        // one entry per remaining file, so a directory with hundreds of thousands
        // of files allocated ~100k objects after the budget closed at file 255.
        const result = {
            folder: null,
            imported: [],
            skipped: [],
            // Count per reason for skips past MAX_SKIP_ENTRIES. A directory with
            // hundreds of thousands of files spends nearly all of them inside
            // node_modules / .git / .venv, and pushing one object + one string per
            // file allocated ~100k entries before the loop reached anything
            // importable. Capping keeps the report useful and the cost O(1).
            skippedByReason: {},
            skippedTotal: 0,
            notEnumerated: 0,
            truncatedByBudget: false,
            // Set when localStorage refused a chunk. Distinct from
            // truncatedByBudget: that is a configured limit the user can raise in
            // Settings, this is a hard browser limit they cannot.
            storageFull: false,
            // How many imported files are safely on disk. Equals imported.length
            // unless storage filled, in which case the tail was rolled back.
            persisted: 0,
            error: ''
        };

        const MAX_SKIP_ENTRIES = 50;
        const noteSkip = (path, reason) => {
            result.skippedTotal += 1;
            result.skippedByReason[reason] = (result.skippedByReason[reason] || 0) + 1;
            if (result.skipped.length < MAX_SKIP_ENTRIES) {
                result.skipped.push({ path, reason });
            }
        };

        if (!list.length) {
            result.error = 'No files were selected.';
            return result;
        }

        const openPathBeforeImport = store.openPath;
        const created = createFolder(folderName || suggestedFolderName(list), 'imported');
        if (created.error) {
            result.error = created.error;
            return result;
        }
        result.folder = created.folder;

        // Convert each budget once, then enforce BOTH independently — exactly as
        // sourceFilesForModel() does. An earlier version mixed units here
        // (Math.max(perFileLimitBytes, maxTotalKb) compares bytes to kilobytes),
        // which silently raised any smaller total budget to the per-file limit so
        // the total cap never applied.
        //
        // The budgets are deliberately NOT clamped against each other: a large
        // per-file allowance with a small total budget is a legitimate
        // configuration ("accept big files, but not many of them"), and Settings
        // permits it.
        const perFileLimit = Math.max(1, Number(cfg.maxFileKb) || 256) * 1024;
        const totalLimit = Math.max(1, Number(cfg.maxTotalKb) || 4096) * 1024;
        // Math.max(1, Infinity) is Infinity, so an unlimited count budget flows
        // through here unchanged and the `>= maxFiles` test simply never fires.
        const maxFiles = Math.max(1, Number(cfg.maxFiles) || 400);
        let totalBytes = 0;

        // ---- chunked persistence -------------------------------------------
        // The previous shape wrote the whole store ONCE at the end. For a large
        // import that is a single synchronous JSON.stringify + setItem of
        // everything -- the freeze -- and at ~32 MB it throws
        // QuotaExceededError, which writeStore() catches and turns into `false`,
        // discarding every file that was read.
        //
        // Persisting every CHUNK_FILES files bounds each synchronous block, so the
        // page stays responsive, and a quota failure costs one chunk.
        const CHUNK_FILES = 40;
        let sincePersist = 0;

        /**
         * Persist the store. On refusal, recover from the last good state.
         *
         * Returns false once storage is full, so the caller stops reading files it
         * can no longer store.
         */
        const persistChunk = () => {
            sincePersist = 0;
            if (writeStore(store)) {
                result.persisted = result.imported.length;
                return true;
            }
            // localStorage refused the write but still holds the LAST GOOD state,
            // so re-reading it is authoritative. This cannot clobber an earlier
            // persisted copy of a path this chunk reused.
            const good = readStore();
            store.files = good.files;
            // Keep only the imports that genuinely survived, then recount, so
            // `persisted` never includes rolled-back files.
            result.imported = result.imported.filter(item => good.files[item.path]);
            result.persisted = result.imported.length;
            result.storageFull = true;
            return false;
        };

        let sinceYield = 0;
        for (let index = 0; index < list.length; index += 1) {
            // Walking a huge FileList is one long synchronous block, so the page
            // cannot paint the busy state the caller just set and the tab looks
            // hung. Yield every 40 files: enough to stay fast on a small import,
            // often enough that a 100k-file directory still repaints.
            sinceYield += 1;
            if (sinceYield >= 40) {
                sinceYield = 0;
                if (typeof cfg.onProgress === 'function') {
                    cfg.onProgress(index, list.length, result.imported.length);
                }
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            const file = list[index];
            const relativePath = relativePathOf(file);
            if (!relativePath) continue;

            if (isSkippedPath(relativePath)) {
                noteSkip(relativePath, 'ignored directory');
                continue;
            }
            const ext = extensionOf(relativePath);
            if (ext && IMPORTABLE_EXTENSIONS.indexOf(ext) < 0) {
                noteSkip(relativePath, `unsupported type .${ext}`);
                continue;
            }
            if (result.imported.length >= maxFiles) {
                result.truncatedByBudget = true;
                result.notEnumerated = list.length - index;
                break;
            }
            const size = Number(file.size) || 0;
            if (size > perFileLimit) {
                noteSkip(relativePath, `over the ${cfg.maxFileKb} KB per-file limit`);
                continue;
            }
            if (totalBytes + size > totalLimit) {
                result.truncatedByBudget = true;
                result.notEnumerated = list.length - index;
                break;
            }

            let content = '';
            try {
                content = await readAsText(file);
            } catch (error) {
                noteSkip(relativePath, 'could not be read');
                continue;
            }

            // A NUL byte means binary; storing it would produce garbage in the
            // previewer and waste quota.
            if (cfg.skipBinary && content.indexOf('\u0000') >= 0) {
                noteSkip(relativePath, 'binary file');
                continue;
            }

            // Store under a path that keeps the picked folder's internal structure
            // but drops its leading directory name, so paths stay short and stable.
            const storedPath = stripLeadingDirectory(relativePath);
            writeFile(storedPath, content, {
                folder: result.folder.id,
                origin: 'imported',
                persist: false
            });
            totalBytes += size;
            result.imported.push({ path: storedPath, bytes: size });

            sincePersist += 1;
            if (sincePersist >= CHUNK_FILES && !persistChunk()) {
                // persistChunk already truncated `imported` to what survived.
                result.notEnumerated = list.length - index - 1;
                break;
            }
        }

        // writeFile() moves openPath to whatever it last wrote; putting the user's
        // previously open document back means importing a folder does not silently
        // switch the viewer to some arbitrary file from it.
        store.openPath = openPathBeforeImport;

        // Flush the trailing partial chunk. openPath changed even if there is
        // nothing new to write, so the store is persisted either way.
        if (!persistChunk()) {
            writeStore(store);
        }
        return result;
    }

    function stripLeadingDirectory(relativePath) {
        const parts = relativePath.split('/');
        if (parts.length <= 1) return relativePath;
        return parts.slice(1).join('/');
    }

    /** "my-app/src/main.js" -> "my-app", used to name an imported folder. */
    function suggestedFolderName(files) {
        const first = relativePathOf(files[0]);
        const parts = first.split('/');
        const candidate = parts.length > 1 ? parts[0] : '';
        return candidate || 'Imported folder';
    }

    /**
     * True when this browser exposes the File System Access API directory
     * picker. Feature-detected at call time, never at load time: the plug-in
     * is one bundle served to whatever browser opens the page, and a Firefox
     * or Safari user must silently get the <input webkitdirectory> path.
     */
    function canPickDirectoryHandle() {
        return typeof window.showDirectoryPicker === 'function'
            && typeof window.FileSystemDirectoryHandle === 'function';
    }

    /**
     * Map a File System Access DOMException to a sentence a person can act on.
     * Raw engine strings ("An attempt was made to write to a file or directory
     * which could not be modified due to the state of the underlying
     * filesystem.") are meaningless to a user and must never reach a toast.
     */
    function describeFsError(error) {
        const name = String((error && error.name) || '');
        switch (name) {
            case 'NoModificationAllowedError':
                return 'a folder is locked or in use by another program';
            case 'NotAllowedError':
                return 'permission to read the folder was not granted';
            case 'NotFoundError':
                return 'a file or folder no longer exists';
            case 'NotReadableError':
                return 'a file or folder could not be read';
            case 'SecurityError':
                return 'this page is not allowed to access the filesystem';
            case 'AbortError':
                return 'the picker was cancelled';
            default:
                return 'the folder could not be read';
        }
    }

    /**
     * Walk a FileSystemDirectoryHandle into the File[] shape importFolder()
     * already consumes, so both picker paths share one importer (budgets,
     * skip reasons, chunked persistence).
     *
     * Two real advantages over <input webkitdirectory>, which is why the
     * controller prefers this path when it exists:
     *   1. IMPORT_SKIP_DIRS are PRUNED — the walker never descends into
     *      node_modules/.git/.venv, so a huge repo costs a directory listing
     *      per pruned folder instead of enumerating (and later skipping)
     *      hundreds of thousands of File objects the input path would build.
     *   2. Files arrive lazily; nothing is read until importFolder() decides
     *      a file is worth storing.
     *
     * RESILIENCE (the part that must match or beat the input path): a folder
     * the running app holds open — live SQLite DBs, mmap'd model weights — makes
     * Chromium's directory iterator reject with NoModificationAllowedError. The
     * <input webkitdirectory> path tolerates that per-file (readAsText fails,
     * the file is skipped, the import continues). An earlier handle-path walker
     * let ONE unreadable directory reject the whole recursive walk, and the
     * controller then discarded every file already collected — strictly worse
     * than the path it replaced. Each directory listing is now wrapped: a
     * failure counts that directory, keeps the files already gathered, and the
     * walk moves on to its siblings.
     *
     * Extensions are deliberately NOT filtered here: importFolder() owns that
     * decision and reports it as a skip reason, and both picker paths must
     * produce the same report.
     *
     * Returns { files, prunedDirs, unreadable, lockedDirs, lockedSample,
     * error }. `error` is set ONLY when nothing at all could be collected; a
     * partial scan returns its files with `error` empty and the locked/unreadable
     * counts populated so the caller can report them and still import. `files`
     * entries carry a `relativePath` property ("root/sub/file.js"), which
     * relativePathOf() already understands, keeping suggestedFolderName() and
     * stripLeadingDirectory() working unchanged.
     */
    async function collectFilesFromDirectoryHandle(rootHandle, options) {
        const cfg = Object.assign({ onProgress: null }, options || {});
        const out = {
            files: [],
            prunedDirs: 0,
            unreadable: 0,
            lockedDirs: 0,
            lockedSample: [],
            error: ''
        };
        // Symlink/junction loops would recurse forever; cap depth well past any
        // real project tree.
        const MAX_DEPTH = 64;
        const MAX_LOCKED_SAMPLE = 10;

        if (!rootHandle || typeof rootHandle.values !== 'function') {
            out.error = 'The picked directory could not be read.';
            return out;
        }

        async function walk(dirHandle, prefix, depth) {
            if (depth > MAX_DEPTH) return;
            let sinceYield = 0;
            try {
                for await (const entry of dirHandle.values()) {
                    // Same repaint trick the importer uses: a directory listing
                    // can be long, and the scan must not freeze the page.
                    sinceYield += 1;
                    if (sinceYield >= 40) {
                        sinceYield = 0;
                        if (typeof cfg.onProgress === 'function') {
                            cfg.onProgress(out.files.length);
                        }
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }

                    const name = String((entry && entry.name) || '');
                    if (!name) continue;
                    const relativePath = prefix + name;

                    if (entry.kind === 'directory') {
                        if (IMPORT_SKIP_DIRS.indexOf(name) >= 0) {
                            out.prunedDirs += 1;
                            continue;
                        }
                        await walk(entry, relativePath + '/', depth + 1);
                    } else if (entry.kind === 'file') {
                        // getFile() rejects when the OS file vanished or is
                        // exclusively locked; one such file must not abort the
                        // scan — importFolder() reports per-file failures the
                        // same way for the input path.
                        try {
                            const file = await entry.getFile();
                            file.relativePath = relativePath;
                            out.files.push(file);
                        } catch (_) {
                            out.unreadable += 1;
                        }
                    }
                }
            } catch (error) {
                // Listing THIS directory failed (locked DB dir, revoked
                // permission, transient filesystem state). Count it, keep a
                // short human sample, and return so the parent's loop moves on
                // to the next sibling — never re-throw, or one bad directory
                // discards the whole scan.
                out.lockedDirs += 1;
                const label = prefix.replace(/\/$/, '');
                if (out.lockedSample.length < MAX_LOCKED_SAMPLE) {
                    out.lockedSample.push({ path: label, reason: describeFsError(error) });
                }
            }
        }

        await walk(rootHandle, String(rootHandle.name || 'Imported folder') + '/', 0);

        // Only a totally empty scan is a hard error — and it gets a human
        // message. If ANY file was collected, return the partial result with
        // `error` empty so the caller imports what it has and reports the rest.
        if (!out.files.length) {
            if (out.lockedDirs && !out.unreadable) {
                const first = out.lockedSample[0];
                out.error = `Nothing could be imported: ${first ? first.reason : 'the folder could not be read'}.`
                    + (out.lockedDirs > 1 ? ` (${out.lockedDirs} folders were inaccessible.)` : '');
            } else {
                out.error = 'That folder has no files in it.';
            }
        }
        return out;
    }

    /** Read a File/Blob as UTF-8 text, promisified. */
    function readAsText(file) {
        if (file && typeof file.text === 'function') return file.text();
        return new Promise((resolve, reject) => {
            try {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(reader.error || new Error('read failed'));
                reader.readAsText(file);
            } catch (error) {
                reject(error);
            }
        });
    }

    // ------------------------------------------------------------------
    // Codebase digest (whole-project structural map)
    //
    // WHY THIS EXISTS
    // The code-reading skills (Architecture Evaluation, Code to PRD) ask the
    // user "whole codebase, or one subsystem?" — but the answer only became
    // prose in the prompt while the attachment path physically capped at
    // maxSourceFiles. Answering "whole codebase" therefore changed nothing.
    //
    // A whole codebase cannot be attached verbatim: measured on a real 6 MB /
    // 118-file project that is ~1.6M tokens, against a practical prompt budget
    // of ~16K tokens (prompt eval measured at 95-192 tok/s on the target GPU,
    // so 16K is ~2-3 min and 113K would be ~20 min).
    //
    // What DOES fit is structure. Digesting every file to its imports, classes,
    // function signatures, HTTP routes, host-extension registrations and
    // slash-command tables compresses ~19.5x with no model and no GPU cost, and
    // covers 100% of first-party files. Tier 2 then spends what is left on the
    // FULL TEXT of the highest-value files, so the model reads real code, not
    // only names — the skills explicitly forbid inferring architecture from
    // file names alone.
    // ------------------------------------------------------------------

    /** Extensions whose content is code worth full-text attachment in Tier 2. */
    const CODE_EXTENSIONS = [
        'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java',
        'kt', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'php', 'swift', 'sh', 'sql',
        'vue', 'svelte'
    ];

    /** Symbol caps tried, cheapest first, when deepening Tier 1. */
    const DEPTH_LADDER = [25, 60, 120];

    /** Directory names that mark third-party code, at any depth. */
    const VENDOR_DIR_PATTERN = /^(vendor|vendors|third[-_]?party|bower_components|external)$/i;

    /** File names that read like an entry point and deserve priority. */
    const ENTRY_FILE_NAMES = [
        'main.py', 'app.py', 'router.py', 'settings.py', 'config.py', '__init__.py',
        'app.js', 'main.js', 'index.js', 'index.ts', 'package.json', 'README.md'
    ];

    function uniqueInOrder(list) {
        const seen = [];
        list.forEach(item => { if (seen.indexOf(item) < 0) seen.push(item); });
        return seen;
    }

    function isVendoredPath(relativePath) {
        return String(relativePath).split('/').some(part => VENDOR_DIR_PATTERN.test(part));
    }

    /**
     * Minified bundles are generated artifacts: thousands of tokens of
     * unreadable noise that crowd real source out of the budget. Detected by a
     * `.min.` name or by absurd average line length.
     */
    function isMinifiedSource(relativePath, content) {
        if (/\.min\.[a-z0-9]+$/i.test(String(relativePath))) return true;
        const text = String(content || '');
        if (!text) return false;
        const lines = Math.max(1, text.split('\n').length);
        return text.length / lines > 600;
    }

    function extractPythonStructure(content) {
        const text = String(content || '');
        const out = { classes: [], functions: [], routes: [], imports: [] };
        const re = /^class\s+(\w+)\s*(?:\(([^)]*)\))?:|^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)|^(\s+)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm;
        let match;
        while ((match = re.exec(text)) !== null) {
            if (match[1]) {
                out.classes.push(match[1] + (match[2] ? '(' + String(match[2]).trim().slice(0, 40) + ')' : ''));
            } else if (match[3]) {
                out.functions.push(match[3] + '(' + String(match[4] || '').trim().slice(0, 50) + ')');
            } else if (match[6]) {
                // An indented def: a method. Keep the leading dot so a reader
                // can tell methods from module-level functions.
                out.functions.push('.' + match[6] + '(' + String(match[7] || '').trim().slice(0, 50) + ')');
            }
        }
        out.routes = extractRoutes(text);
        out.imports = Array.prototype.map.call(
            text.match(/^(?:from\s+[\w.]+\s+import|import\s+[\w.]+)/gm) || [],
            line => line.replace(/^from\s+/, '').replace(/^import\s+/, '').split(/\s+/)[0]
        ).slice(0, 14);
        return out;
    }

    /**
     * HTTP routes, as "GET /path". The METHOD is uppercased but the path is
     * preserved exactly — an earlier chained-replace version uppercased the
     * whole match and produced "ROUTER.GET /TASKS", which cannot be matched
     * against a real endpoint.
     *
     * Handles both decorator style (Python: `@router.get("/tasks")`) and call
     * style (JS/Express: `router.get('/tasks', handler)`), so the leading `@`
     * is optional.
     */
    function extractRoutes(text) {
        const routes = [];
        const re = /@?\s*\b(?:app|router|api|\w*[rR]outer)\s*\.\s*(get|post|put|delete|patch|head|options)\s*\(\s*['"`](\/[^'"`]*)['"`]/g;
        let match;
        while ((match = re.exec(String(text || ''))) !== null) {
            routes.push(match[1].toUpperCase() + ' ' + match[2]);
        }
        return routes;
    }

    function extractJsStructure(content) {
        const text = String(content || '');
        const out = { classes: [], functions: [], routes: [], imports: [], registers: [], commands: [] };
        const re = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>|^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([\w$.]+))?/gm;
        let match;
        while ((match = re.exec(text)) !== null) {
            if (match[1]) out.functions.push(match[1] + '(' + String(match[2] || '').trim().slice(0, 50) + ')');
            else if (match[3]) out.functions.push(match[3] + '(' + String(match[4] || match[5] || '').trim().slice(0, 50) + ')');
            else if (match[6]) out.classes.push(match[6] + (match[7] ? ' extends ' + match[7] : ''));
        }
        // Declarative slash-command tables carry real product behaviour and are
        // invisible to a function/class-only scan. NOT line-anchored: the real
        // shape is `{ command: "/help", title: … }`, so a `{` precedes the key.
        const slash = Array.prototype.map.call(
            text.match(/(?:^|[{,\s])command:\s*['"`][^'"`]+['"`]/g) || [],
            item => {
                const m = /command:\s*['"`]([^'"`]+)['"`]/.exec(item);
                return m ? m[1] : '';
            }
        ).filter(Boolean);
        if (slash.length) {
            const uniq = uniqueInOrder(slash);
            out.commands.push(uniq.length + ' slash commands: ' + uniq.slice(0, 8).join(', ')
                + (uniq.length > 8 ? ', …' : ''));
        }
        // Host extension registrations describe capabilities and handlers.
        const registerStarts = [];
        const regRe = /register(?:Controller|Manifest)\s*\(\s*\{/g;
        let rm;
        while ((rm = regRe.exec(text)) !== null) registerStarts.push(rm.index);
        registerStarts.forEach(start => {
            const slice = text.slice(start, start + 2000);
            const pluginId = /pluginId:\s*['"`]([^'"`]+)['"`]/.exec(slice);
            const caps = /capabilities:\s*\[([^\]]*)\]/.exec(slice);
            const handlers = uniqueInOrder(Array.prototype.map.call(
                slice.match(/^\s*['"][\w.]+['"]\s*:\s*(?:context|ctx|\()/gm) || [],
                line => line.replace(/^\s*['"]/, '').replace(/['"]\s*:.*$/, '')
            ));
            out.registers.push({
                pluginId: pluginId ? pluginId[1] : '',
                capabilities: caps
                    ? caps[1].split(',').map(item => item.trim().replace(/['"]/g, '')).filter(Boolean)
                    : [],
                handlers
            });
        });
        out.routes = extractRoutes(text);
        out.imports = Array.prototype.map.call(
            text.match(/(?:^|\n)\s*(?:import\s+[^'"]*from\s+|const\s+\w+\s*=\s*require\(\s*)['"][^'"]+['"]/g) || [],
            line => {
                const m = /['"]([^'"]+)['"]\s*$/.exec(line);
                return m ? m[1] : '';
            }
        ).filter(Boolean).slice(0, 14);
        return out;
    }

    function extractCssStructure(content) {
        const text = String(content || '');
        const selectors = Array.prototype.map.call(
            text.match(/(^|\})\s*[^{}@][^{}]*\{/g) || [],
            chunk => chunk.replace(/^\}/, '').replace(/\{$/, '').trim().replace(/\s+/g, ' ')
        ).filter(item => item && item.length < 200);
        const vars = Array.prototype.map.call(
            text.match(/(--[\w-]+)\s*:/g) || [], m => m.replace(/\s*:$/, '')
        );
        const atRules = Array.prototype.map.call(
            text.match(/@(?:media|supports|keyframes|font-face|import)/g) || [], m => m
        );
        return { selectors, vars, atRules: uniqueInOrder(atRules) };
    }

    function extractHtmlStructure(content) {
        const text = String(content || '');
        const grab = pattern => Array.prototype.map.call(text.match(pattern) || [], m => {
            const inner = /["']([^"']+)["']/.exec(m);
            return inner ? inner[1] : '';
        }).filter(Boolean);
        return {
            scripts: grab(/<script[^>]*src=["'][^"']+["']/g),
            styles: grab(/<link[^>]*href=["'][^"']+["']/g),
            ids: uniqueInOrder(grab(/\sid=["'][\w-]+["']/g).map(item => '#' + item)).slice(0, 20),
            actions: uniqueInOrder(grab(/data-(?:cb-action|action)=["'][\w-]+["']/g)).slice(0, 20)
        };
    }

    function extractMarkdownStructure(content) {
        const text = String(content || '');
        return Array.prototype.map.call(
            text.match(/^#{1,4}\s+.+$/gm) || [], line => line.trim()
        );
    }

    function extractJsonStructure(content) {
        try {
            const parsed = JSON.parse(String(content || ''));
            if (Array.isArray(parsed)) return ['array of ' + parsed.length];
            if (parsed && typeof parsed === 'object') return Object.keys(parsed);
            return [];
        } catch (_) {
            return [];
        }
    }

    /**
     * Digest one file to a structural summary.
     *
     * `depth` is the symbol cap: adaptive depth lets high-value files (entry
     * points, heavily referenced, large) list more symbols than a leaf file,
     * which is how 100% coverage fits a fixed budget without flattening the
     * files that actually explain the architecture.
     */
    function digestFileStructure(relativePath, content, depth) {
        const text = String(content || '');
        const lines = text.split('\n').length;
        const extension = String(relativePath).split('.').pop().toLowerCase();
        const head = `### ${relativePath} (${lines.toLocaleString()} lines)`;
        const cap = Math.max(6, Math.round(Number(depth) || 8));

        if (isVendoredPath(relativePath)) {
            return { text: head + '\n[vendored third-party library — excluded from analysis]', value: 0, excluded: true };
        }
        if (isMinifiedSource(relativePath, text)) {
            return { text: head + '\n[generated or minified bundle — excluded from analysis]', value: 0, excluded: true };
        }
        if (/^(css|scss|sass|less)$/.test(extension)) {
            const css = extractCssStructure(text);
            const parts = [head];
            parts.push('[stylesheet] ' + css.selectors.length + ' selectors'
                + (css.vars.length ? ', ' + css.vars.length + ' vars (' + css.vars.slice(0, 6).join(', ') + ')' : '')
                + (css.atRules.length ? ', ' + css.atRules.join(', ') : ''));
            if (css.selectors.length) {
                parts.push('key selectors: ' + uniqueInOrder(css.selectors).slice(0, Math.round(cap / 2)).join(', '));
            }
            return { text: parts.join('\n'), value: 1, excluded: false };
        }

        const parts = [head];
        let value = 0;

        /** Append a deduped, capped symbol list. Symbols repeat in real files
         *  (router.py declared the same request models twice) — deduping keeps
         *  the digest honest and shorter. */
        const addList = (label, symbols, weight) => {
            const uniq = uniqueInOrder(Array.isArray(symbols) ? symbols : []);
            if (!uniq.length) return;
            value += weight;
            parts.push(label + ' (' + uniq.length + '): '
                + uniq.slice(0, cap).join('; ') + (uniq.length > cap ? '; …' : ''));
        };

        if (extension === 'py') {
            const py = extractPythonStructure(text);
            if (py.imports.length) { parts.push('imports: ' + uniqueInOrder(py.imports).join(', ')); value += 1; }
            addList('ROUTES', py.routes, 3);
            addList('classes', py.classes, 2);
            addList('functions', py.functions, 2);
        } else if (CODE_EXTENSIONS.indexOf(extension) >= 0
            || ['jsx', 'tsx', 'vue', 'svelte', 'html', 'htm'].indexOf(extension) >= 0
            || /^(js|mjs|cjs)$/.test(extension)) {
            if (/^(html|htm)$/.test(extension)) {
                const html = extractHtmlStructure(text);
                if (html.scripts.length) { parts.push('scripts: ' + uniqueInOrder(html.scripts).join(', ')); value += 2; }
                if (html.styles.length) { parts.push('stylesheets: ' + uniqueInOrder(html.styles).join(', ')); value += 1; }
                if (html.ids.length) { parts.push('ids: ' + html.ids.join(', ')); value += 1; }
                if (html.actions.length) { parts.push('UI actions: ' + html.actions.join(', ')); value += 2; }
            } else {
                const js = extractJsStructure(text);
                if (js.imports.length) { parts.push('imports: ' + uniqueInOrder(js.imports).join(', ')); value += 1; }
                js.registers.forEach(register => {
                    value += 3;
                    const bits = [];
                    if (register.pluginId) bits.push('pluginId=' + register.pluginId);
                    if (register.capabilities.length) bits.push('capabilities=' + register.capabilities.join('+'));
                    if (register.handlers.length) bits.push('handlers=' + register.handlers.slice(0, 10).join(','));
                    parts.push('HOST EXTENSION: ' + bits.join(' '));
                });
                if (js.commands.length) { parts.push('COMMANDS: ' + js.commands.join(' | ')); value += 2; }
                addList('ROUTES', js.routes, 3);
                addList('classes', js.classes, 2);
                addList('functions', js.functions, 2);
            }
        } else if (extension === 'json') {
            addList('keys', extractJsonStructure(text), 1);
        } else if (/^(md|txt)$/.test(extension)) {
            const headings = extractMarkdownStructure(text);
            if (headings.length) {
                value += 1;
                parts.push(headings.slice(0, cap).join('\n') + (headings.length > cap ? '\n…' : ''));
            } else {
                value += 1;
                parts.push('[prose document, no headings]');
            }
        } else {
            value += 1;
            parts.push('[' + (extension || 'unknown') + ' file — no structural extractor]');
        }

        if (!value) {
            value = 1;
            parts.push('[no extractable structure — data or config]');
        }
        return { text: parts.join('\n'), value, excluded: false };
    }

    /**
     * Score files so the budget goes where the architecture is explained.
     *
     * Signals, each chosen because it was observed to matter on a real project:
     *   - entry-point file names and module roots (router.py, app.js, main.py)
     *   - how many OTHER files in the project import this one — the strongest
     *     signal available without running anything, and the one that surfaces a
     *     hub like router.py above 60 leaf controllers
     *   - file size, weakly, since bigger modules carry more behaviour
     *   - stylesheets and vendor/minified are pushed DOWN, not merely excluded:
     *     223K tokens of CSS was the single biggest waste measured
     */
    function scoreFilesForDigest(records) {
        const byBase = {};
        records.forEach(record => {
            const path = String(record.path || '');
            const noExt = path.replace(/\.(?:js|mjs|cjs|jsx|ts|tsx|py|vue|svelte)$/, '');
            if (!(noExt in byBase)) byBase[noExt] = path;
            const base = noExt.split('/').pop();
            if (!(base in byBase)) byBase[base] = path;
            const leaf = path.split('/').pop();
            if (!(leaf in byBase)) byBase[leaf] = path;
        });

        const references = {};
        records.forEach(record => {
            const path = String(record.path || '');
            const extension = path.split('.').pop().toLowerCase();
            const structure = extension === 'py'
                ? extractPythonStructure(record.content)
                : extractJsStructure(record.content);
            (structure.imports || []).forEach(specifier => {
                const normalized = String(specifier)
                    .replace(/^\.\.?\//, '')
                    .replace(/\.(?:js|py|ts|mjs|cjs)$/, '');
                const hit = byBase[normalized] || byBase[normalized.split('/').pop()];
                if (hit && hit !== path) references[hit] = (references[hit] || 0) + 1;
            });
        });

        return records.map(record => {
            const path = String(record.path || '');
            const leaf = path.split('/').pop();
            const extension = leaf.split('.').pop().toLowerCase();
            const lines = String(record.content || '').split('\n').length;
            let score = 0;
            if (isVendoredPath(path) || isMinifiedSource(path, record.content)) score -= 100;
            if (ENTRY_FILE_NAMES.indexOf(leaf) >= 0) score += 6;
            if (/^(router|main|app|index|controller|core|server|agent)\b/i.test(leaf)) score += 4;
            score += Math.min(8, (references[path] || 0) * 2);
            score += Math.min(2, lines / 1500);
            if (/^(css|scss|sass|less)$/.test(extension)) score -= 2;
            return {
                path,
                content: String(record.content || ''),
                lines,
                extension,
                references: references[path] || 0,
                score
            };
        }).sort((left, right) => right.score - left.score);
    }

    /**
     * Build a whole-codebase digest that fits a token budget.
     *
     * Tier 1 (structural, ~62% of budget): every first-party file is digested,
     * so coverage is 100% and the model can name any file it wants to read.
     * Adaptive depth spends the remaining Tier-1 room on the highest-scoring
     * files; if Tier 1 overflows, the LOWEST-scoring files degrade to a
     * one-line stub rather than being dropped, keeping coverage total.
     *
     * Tier 2 (verbatim, the rest): full text of the highest-scoring CODE files
     * that fit. Restricted to code and to files >= 40 lines, because in
     * calibration an unrestricted Tier 2 spent 32% of the whole budget on two
     * HTML files while the file that actually explained the system (router.py)
     * could never fit.
     *
     * Returns { digestText, fullTextFiles, tokens, coverage, trimmed, deepened,
     * excluded, files } — `files` carries per-file digests for the UI to show
     * what the model was given.
     */
    function buildCodebaseDigest(records, options) {
        const cfg = Object.assign({ budgetTokens: 16000, minFullTextLines: 40 }, options || {});
        const budget = Math.max(512, Number(cfg.budgetTokens) || 16000);
        const tier1Budget = Math.round(budget * 0.62);
        const tier2Budget = Math.max(0, budget - tier1Budget - 200);
        const minLines = Math.max(1, Number(cfg.minFullTextLines) || 40);

        const input = (Array.isArray(records) ? records : [])
            .filter(record => record && typeof record.content === 'string' && record.path);
        const scored = scoreFilesForDigest(input);
        const real = scored.filter(file => file.score > -50);

        const digests = real.map(file => Object.assign({}, file, {
            digest: digestFileStructure(file.path, file.content, 8),
            trimmed: false
        }));

        let tier1Tokens = digests.reduce((total, item) => total + estimateTokens(item.digest.text), 0);

        // Files dropped from the map entirely because even one-line stubs did
        // not fit. Named in the digest so the model (and the user) knows the map
        // is incomplete rather than trusting it as whole.
        const omitted = [];

        // Adaptive depth: deepen the highest-scoring files while room remains.
        let deepened = 0;
        if (tier1Tokens < tier1Budget) {
            for (let i = 0; i < digests.length && tier1Tokens < tier1Budget; i += 1) {
                const item = digests[i];
                for (let d = 0; d < DEPTH_LADDER.length; d += 1) {
                    const candidate = digestFileStructure(item.path, item.content, DEPTH_LADDER[d]);
                    const added = estimateTokens(candidate.text) - estimateTokens(item.digest.text);
                    if (added <= 0 || tier1Tokens + added > tier1Budget) break;
                    tier1Tokens += added;
                    item.digest = candidate;
                    deepened += 1;
                }
            }
        } else {
            // Over budget: degrade the LOWEST-scoring files to a stub, from the
            // bottom up, so nothing disappears from the map entirely.
            for (let i = digests.length - 1; i >= 0 && tier1Tokens > tier1Budget; i -= 1) {
                const item = digests[i];
                const stub = `### ${item.path} (${item.lines.toLocaleString()} lines) [digest trimmed to fit budget]`;
                tier1Tokens += estimateTokens(stub) - estimateTokens(item.digest.text);
                item.digest = { text: stub, value: item.digest.value, excluded: item.digest.excluded };
                item.trimmed = true;
            }
            // A large project can exceed the budget even after EVERY file is a
            // one-line stub (400 files x ~20 tokens is already ~8,000). The
            // budget is a hard guarantee — it exists because prompt evaluation
            // is the real wall-clock cost — so the remaining overflow drops the
            // lowest-scoring entries outright and the digest says how many.
            // Silently overrunning would turn a 2-minute step into a 20-minute
            // one, which is exactly the failure the budget was added to prevent.
            while (tier1Tokens > tier1Budget && digests.length > 1) {
                const dropped = digests.pop();
                tier1Tokens -= estimateTokens(dropped.digest.text);
                omitted.push(dropped.path);
            }
        }

        // Tier 2: verbatim text for substantial code files, highest score first.
        const fullTextFiles = [];
        let tier2Tokens = 0;
        for (let i = 0; i < digests.length; i += 1) {
            const item = digests[i];
            if (CODE_EXTENSIONS.indexOf(item.extension) < 0) continue;
            if (item.lines < minLines) continue;
            const tokens = estimateTokens(item.content);
            // A single file may not eat more than 75% of Tier 2, or one giant
            // module crowds out every other file the model might need.
            if (tokens > tier2Budget * 0.75) continue;
            if (tier2Tokens + tokens > tier2Budget) break;
            tier2Tokens += tokens;
            fullTextFiles.push(item.path);
        }

        const excluded = scored.length - real.length;

        // Tell the reader the map is incomplete, and name what is missing.
        // Bounded to a handful of paths so the note itself cannot blow the
        // budget on a project that omitted hundreds of files; its token cost is
        // charged against Tier 1, dropping more entries if that overflows.
        let omissionNote = '';
        if (omitted.length) {
            const named = omitted.slice(0, 8).map(item => '`' + item + '`').join(', ');
            omissionNote = `[${omitted.length.toLocaleString()} further file(s) were left out of this map `
                + `to stay within the ${budget.toLocaleString()}-token budget: ${named}`
                + (omitted.length > 8 ? `, and ${(omitted.length - 8).toLocaleString()} more` : '')
                + '. They exist in the project but were not examined — do not assume their contents.]';
            let noteTokens = estimateTokens(omissionNote);
            while (tier1Tokens + noteTokens > tier1Budget && digests.length > 1) {
                const dropped = digests.pop();
                tier1Tokens -= estimateTokens(dropped.digest.text);
                omitted.unshift(dropped.path);
                const renamed = omitted.slice(0, 8).map(item => '`' + item + '`').join(', ');
                omissionNote = `[${omitted.length.toLocaleString()} further file(s) were left out of this map `
                    + `to stay within the ${budget.toLocaleString()}-token budget: ${renamed}`
                    + (omitted.length > 8 ? `, and ${(omitted.length - 8).toLocaleString()} more` : '')
                    + '. They exist in the project but were not examined — do not assume their contents.]';
                noteTokens = estimateTokens(omissionNote);
            }
            tier1Tokens += noteTokens;
        }

        const digestText = (omissionNote
            ? digests.map(item => item.digest.text).concat([omissionNote])
            : digests.map(item => item.digest.text)
        ).join('\n\n');
        // Coverage counts only files present in the map with full structural
        // detail. Trimmed stubs and omitted files both reduce it, so a digest
        // that had to give up on a large project cannot claim to be complete.
        const coverage = real.length
            ? digests.filter(item => !item.trimmed).length / real.length
            : 0;

        return {
            digestText,
            fullTextFiles,
            tokens: tier1Tokens + tier2Tokens,
            tier1Tokens,
            tier2Tokens,
            budget,
            coverage,
            trimmed: digests.filter(item => item.trimmed).length,
            deepened,
            excluded,
            // Files that made it into the map at all (full or stubbed).
            fileCount: digests.length,
            // Files dropped entirely because the budget could not hold even a
            // one-line entry for them.
            omitted: omitted.slice(),
            omittedCount: omitted.length,
            // Everything scanned before exclusions and budget cuts.
            scannedCount: scored.length,
            files: digests.map(item => ({
                path: item.path,
                lines: item.lines,
                references: item.references,
                score: item.score,
                tokens: estimateTokens(item.digest.text),
                trimmed: item.trimmed,
                includedInFull: fullTextFiles.indexOf(item.path) >= 0
            }))
        };
    }

    // ------------------------------------------------------------------
    // Runs
    // ------------------------------------------------------------------

    function findRun(runId) {
        return store.runs.find(run => run && run.id === runId) || null;
    }

    function activeRun() {
        return findRun(store.activeRunId);
    }

    /** Returns false when the in-memory change could not be persisted. */
    function saveRun(run) {
        const index = store.runs.findIndex(item => item && item.id === run.id);
        if (index >= 0) store.runs[index] = run;
        else store.runs.unshift(run);
        store.runs = store.runs.slice(0, 60);
        store.activeRunId = run.id;
        return writeStore(store);
    }

    function deleteRun(runId) {
        store.runs = store.runs.filter(run => run && run.id !== runId);
        if (store.activeRunId === runId) store.activeRunId = store.runs[0]?.id || '';
        return writeStore(store);
    }

    function createRun(skill, idea) {
        const run = {
            id: uid('run'),
            skillId: skill.id,
            skillName: skill.name,
            title: skill.name,
            idea: String(idea || ''),
            createdAt: new Date().toISOString(),
            status: 'running',
            projectName: '',
            slug: '',
            phases: [],
            transcript: [],
            writtenPaths: [],
            error: ''
        };
        saveRun(run);
        return run;
    }

    // ------------------------------------------------------------------
    // Context Compression (Anti-gravity Protocol)
    // ------------------------------------------------------------------

    function estimateTokens(text) {
        if (!text) return 0;
        const str = typeof text === 'string' ? text : JSON.stringify(text);
        return Math.max(1, Math.round(str.length / 3.8));
    }

    /**
     * Anti-gravity Context Compactor (Deterministic Engine)
     *
     * Constructs a high-density, structured compaction summary adhering strictly
     * to the Anti-gravity compaction schema. Compresses lengthy chat transcripts,
     * intermediate thinking steps, and model turns while faithfully preserving:
     * 1. Chronological user requests
     * 2. Task Overview
     * 3. Progress (Completed & In-Progress)
     * 4. Key Findings & Decisions
     * 5. Active Context (project folder, created documents, source context)
     * 6. Next Steps
     * 7. Commitments & Constraints
     */
    function buildDeterministicCompaction(options) {
        const opts = options || {};
        const messages = Array.isArray(opts.messages) ? opts.messages : [];
        const run = opts.run || null;
        const activeFolderObj = opts.activeFolder || activeFolder();
        const settings = opts.settings || readSettings();

        // 1. Chronological User Requests
        const userRequests = [];
        messages.forEach(msg => {
            if (!msg) return;
            if (msg.role === 'user' && typeof msg.text === 'string') {
                const trimmed = msg.text.trim();
                if (trimmed && !trimmed.startsWith('/clear') && !trimmed.startsWith('/compact')) {
                    userRequests.push(trimmed);
                }
            }
        });
        if (!userRequests.length && run && run.idea) {
            userRequests.push(run.idea);
        }
        if (!userRequests.length) {
            userRequests.push('Product requirements and architecture planning');
        }

        // 2. Tracked Documents & Artifacts
        const writtenPaths = (run && Array.isArray(run.writtenPaths) && run.writtenPaths.length)
            ? run.writtenPaths
            : listFiles().filter(p => p.startsWith('docs/'));

        const artifacts = writtenPaths.map(p => {
            const file = readFile(p);
            const size = file ? file.content.length : 0;
            const lines = file ? file.content.split('\n').length : 0;
            return { path: p, size, lines };
        });

        // 3. Project & Source Context
        const folderName = (activeFolderObj && activeFolderObj.name) || 'Default Project';
        const folderFiles = (activeFolderObj && activeFolderObj.id) ? listFiles(activeFolderObj.id) : listFiles();
        const sourceFileCount = folderFiles.filter(p => !p.startsWith('docs/')).length;

        // 4. Progress items
        const completedMilestones = [];
        const inProgressItems = [];

        if (run) {
            if (run.skillName) {
                completedMilestones.push(`Skill executed: **${run.skillName}** (Status: ${run.status})`);
            }
            if (Array.isArray(run.phases)) {
                run.phases.forEach(ph => {
                    if (ph.status === 'done') {
                        completedMilestones.push(`${ph.label || 'Phase'} completed${ph.summary ? ` (${ph.summary})` : ''}`);
                    } else if (ph.status === 'running' || ph.status === 'pending') {
                        inProgressItems.push(`${ph.label || 'Phase'} (${ph.status})`);
                    }
                });
            }
        }
        artifacts.forEach(art => {
            completedMilestones.push(`Document created: \`${art.path}\` (${formatBytes(art.size)}, ${art.lines} lines)`);
        });

        if (!inProgressItems.length) {
            inProgressItems.push('Awaiting user follow-up questions or subsequent skill trigger (/mvp, /gtm, /arch, /code2prd)');
        }

        // 5. Synthesize Anti-gravity Compaction Block
        const userReqLines = userRequests.map((req, idx) => `${idx + 1}. ${req}`).join('\n');
        const completedLines = completedMilestones.length
            ? completedMilestones.map(m => `  - ${m}`).join('\n')
            : '  - Initialized planning session';
        const inProgressLines = inProgressItems.map(m => `  - ${m}`).join('\n');

        const projectName = (run && run.projectName) || 'Blueprint Project';
        const skillName = (run && run.skillName) || 'Product Planning';

        const summaryBody = [
            `### 1. Task Overview`,
            `- **Objective**: Architectural planning, specifications, and requirements synthesis for "${projectName}".`,
            `- **Active Skill**: ${skillName}`,
            `- **Primary Focus**: Delivering complete, verifiable blueprints aligned with user goals.`,
            ``,
            `### 2. Progress`,
            `- **Completed**:`,
            completedLines,
            `- **In Progress / Remaining**:`,
            inProgressLines,
            ``,
            `### 3. Key Findings & Decisions`,
            `- Standalone folder access established: agent interfaces directly with project codebase without requiring editor file chips.`,
            `- Safety boundaries strictly enforced: imported user source files are read-only; revisions are cleanly diverted to docs/.`,
            `- Blueprint document generation follows zero-innerHTML, modular markdown standards.`,
            ``,
            `### 4. Active Context`,
            `- **Active Folder**: \`${folderName}\` (${folderFiles.length} total files, ${sourceFileCount} source modules)`,
            `- **Tracked Artifacts**: ${artifacts.length ? artifacts.map(a => `\`${a.path}\``).join(', ') : 'None yet'}`,
            ``,
            `### 5. Next Steps`,
            `1. Review and refine any generated documents in the project tree.`,
            `2. Run companion planning skills (/mvp, /arch, /gtm) or execute document revisions.`,
            ``,
            `### 6. Commitments & Constraints`,
            `- Preserve documentation and source integrity at all times.`,
            `- Adhere to Anti-gravity agent protocols: structured steps, live execution feedback, zero data loss.`
        ].join('\n');

        const rawCompaction = [
            `# Resuming from a compaction`,
            ``,
            `You are continuing work on the task described above, but you have lost access to the full conversation history, and need to resume work efficiently using the progress summary below:`,
            ``,
            `# User Requests`,
            `The following were user requests from the truncated conversation in chronological order:`,
            userReqLines,
            ``,
            `<summary>`,
            summaryBody,
            `</summary>`
        ].join('\n');

        // 6. Token metrics
        let originalChars = 0;
        messages.forEach(m => {
            originalChars += (m.text ? m.text.length : 0);
            if (Array.isArray(m.steps)) {
                m.steps.forEach(s => {
                    originalChars += (s.text ? s.text.length : 0);
                    originalChars += (s.promptPreview ? s.promptPreview.length : 0);
                    originalChars += (s.thinking ? s.thinking.length : 0);
                });
            }
        });
        if (run && run.idea) originalChars += run.idea.length;
        if (!originalChars) originalChars = 1200;

        const originalTokens = Math.max(1, Math.round(originalChars / 3.8));
        const compactedTokens = Math.max(1, Math.round(rawCompaction.length / 3.8));
        const savedTokens = Math.max(0, originalTokens - compactedTokens);
        const savedPercent = originalTokens > 0 ? Math.min(95, Math.max(0, Math.round((savedTokens / originalTokens) * 100))) : 0;

        return {
            id: uid('compact'),
            at: new Date().toISOString(),
            userRequests,
            summary: summaryBody,
            rawText: rawCompaction,
            artifacts,
            folderName,
            originalTokens,
            compactedTokens,
            savedTokens,
            savedPercent
        };
    }

    // ------------------------------------------------------------------
    // Safe Markdown rendering (produces DOM nodes, never innerHTML)
    // ------------------------------------------------------------------

    // The pattern source is module-level, but a FRESH RegExp is built per call:
    // a shared /g instance keeps lastIndex across calls, so the recursive calls
    // below (bold inside bold, link text with emphasis) would reset each other's
    // position and loop forever on the same match.
    const INLINE_PATTERN_SOURCE = '(`[^`]+`)|(\\*\\*[\\s\\S]+?\\*\\*)|(\\*[\\s\\S]+?\\*)|(\\[[^\\]\\n]+\\]\\([^)\\n]+\\))';

    function appendInline(text, parent) {
        const source = String(text || '');
        const inlinePattern = new RegExp(INLINE_PATTERN_SOURCE, 'g');
        let cursor = 0;
        let match = null;
        while ((match = inlinePattern.exec(source)) !== null) {
            // Never allow a zero-length match to stall the scan.
            if (match[0].length === 0) {
                inlinePattern.lastIndex += 1;
                continue;
            }
            const token = match[0];
            if (match.index > cursor) {
                parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
            }
            if (token.charAt(0) === '`') {
                const code = document.createElement('code');
                code.textContent = token.slice(1, -1);
                parent.appendChild(code);
            } else if (token.startsWith('**')) {
                const strong = document.createElement('strong');
                appendInline(token.slice(2, -2), strong);
                parent.appendChild(strong);
            } else if (token.charAt(0) === '*') {
                const emphasis = document.createElement('em');
                appendInline(token.slice(1, -1), emphasis);
                parent.appendChild(emphasis);
            } else {
                const link = /^\[([^\]\n]+)\]\(([^)\n]+)\)$/.exec(token);
                const anchor = document.createElement('a');
                anchor.textContent = link ? link[1] : token;
                const href = link ? link[2].trim() : '';
                if (/^https?:\/\//i.test(href)) {
                    anchor.href = href;
                    anchor.target = '_blank';
                    anchor.rel = 'noopener noreferrer';
                } else {
                    anchor.className = 'cb-plain-link';
                    anchor.title = href;
                }
                parent.appendChild(anchor);
            }
            cursor = match.index + token.length;
        }
        if (cursor < source.length) {
            parent.appendChild(document.createTextNode(source.slice(cursor)));
        }
        return parent;
    }

    function listIndentWidth(line) {
        const match = /^(\s*)/.exec(line);
        return match ? match[1].replace(/\t/g, '    ').length : 0;
    }

    function appendListBlock(lines, startIndex, parent, ordered) {
        const stack = [{ indent: -1, node: parent }];
        let index = startIndex;
        const itemPattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        while (index < lines.length) {
            const line = lines[index];
            if (!line.trim()) {
                const next = lines[index + 1];
                if (next && itemPattern.test(next)) { index += 1; continue; }
                break;
            }
            const match = itemPattern.exec(line);
            if (!match) break;
            const indent = listIndentWidth(line);
            while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
            let current = stack[stack.length - 1];
            if (indent > current.indent) {
                const nested = document.createElement(ordered ? 'ol' : 'ul');
                nested.className = 'cb-nested';
                const lastItem = current.node.lastElementChild;
                if (lastItem && lastItem.tagName === 'LI') lastItem.appendChild(nested);
                else current.node.appendChild(nested);
                current = { indent, node: nested };
                stack.push(current);
            }
            const item = document.createElement('li');
            appendInline(match[1], item);
            current.node.appendChild(item);
            index += 1;
        }
        return index;
    }

    function appendTableBlock(lines, startIndex, parent) {
        const rows = [];
        let index = startIndex;
        while (index < lines.length && lines[index].trim().charAt(0) === '|') {
            rows.push(lines[index].trim());
            index += 1;
        }
        if (rows.length < 2) return startIndex;
        const splitRow = row => row
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map(cell => cell.trim());
        const headerCells = splitRow(rows[0]);
        const isSeparator = /^[\s|:-]+$/.test(rows[1]) && rows[1].includes('-');
        const table = document.createElement('table');
        table.className = 'cb-table';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        headerCells.forEach(cell => {
            const th = document.createElement('th');
            appendInline(cell, th);
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        rows.slice(isSeparator ? 2 : 1).forEach(row => {
            const tr = document.createElement('tr');
            splitRow(row).forEach(cell => {
                const td = document.createElement('td');
                appendInline(cell, td);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        parent.appendChild(table);
        return index;
    }

    function renderMarkdown(source) {
        const root = document.createElement('div');
        root.className = 'cb-markdown';
        const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
        let index = 0;
        while (index < lines.length) {
            const line = lines[index];
            if (!line.trim()) { index += 1; continue; }

            const fence = /^\s*(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
            if (fence) {
                const closing = fence[1];
                const body = [];
                index += 1;
                while (index < lines.length && !new RegExp(`^\\s*${closing}\\s*$`).test(lines[index])) {
                    body.push(lines[index]);
                    index += 1;
                }
                index += 1;
                const pre = document.createElement('pre');
                pre.className = 'cb-code-block';
                if (fence[2]) pre.dataset.language = fence[2];
                const code = document.createElement('code');
                code.textContent = body.join('\n');
                pre.appendChild(code);
                root.appendChild(pre);
                continue;
            }

            const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
            if (heading) {
                const level = Math.min(6, heading[1].length + 2);
                const element = document.createElement(`h${level}`);
                appendInline(heading[2].replace(/\s+#+\s*$/, ''), element);
                root.appendChild(element);
                index += 1;
                continue;
            }

            if (/^\s{0,3}([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
                root.appendChild(document.createElement('hr'));
                index += 1;
                continue;
            }

            if (/^\s{0,3}>/.test(line)) {
                const quote = document.createElement('blockquote');
                const body = [];
                while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
                    body.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
                    index += 1;
                }
                quote.appendChild(renderMarkdown(body.join('\n')));
                root.appendChild(quote);
                continue;
            }

            if (line.trim().charAt(0) === '|' && (lines[index + 1] || '').includes('|')) {
                const next = appendTableBlock(lines, index, root);
                if (next > index) { index = next; continue; }
            }

            if (/^\s*[-*+]\s+/.test(line)) {
                const list = document.createElement('ul');
                index = appendListBlock(lines, index, list, false);
                root.appendChild(list);
                continue;
            }

            if (/^\s*\d+[.)]\s+/.test(line)) {
                const list = document.createElement('ol');
                index = appendListBlock(lines, index, list, true);
                root.appendChild(list);
                continue;
            }

            const paragraph = [];
            while (
                index < lines.length
                && lines[index].trim()
                && !/^\s{0,3}(#{1,6}\s|>|```|~~~)/.test(lines[index])
                && !/^\s*[-*+]\s+/.test(lines[index])
                && !/^\s*\d+[.)]\s+/.test(lines[index])
                && lines[index].trim().charAt(0) !== '|'
            ) {
                paragraph.push(lines[index]);
                index += 1;
            }
            if (paragraph.length) {
                const element = document.createElement('p');
                appendInline(paragraph.join('\n'), element);
                root.appendChild(element);
            } else {
                index += 1;
            }
        }
        return root;
    }

    // ------------------------------------------------------------------
    // Model streaming through the host's existing chat endpoint
    // ------------------------------------------------------------------

    const NO_ENDPOINT_PATTERN = /^No model endpoint is selected\b/i;

    class BlueprintAbort extends Error {
        constructor(message) {
            super(message || 'Stopped');
            this.name = 'BlueprintAbort';
            this.code = 'aborted';
        }
    }

    class BlueprintModelError extends Error {
        constructor(message) {
            super(message || 'Model request failed');
            this.name = 'BlueprintModelError';
        }
    }

    function streamReader() {
        const reader = window.RagChatStreaming && window.RagChatStreaming.readJsonLineStream;
        if (typeof reader !== 'function') {
            throw new BlueprintModelError('The SimpleRAG streaming runtime is unavailable. Reload the app and try again.');
        }
        return reader;
    }

    /**
     * Run one model turn and stream deltas back through onDelta.
     * Resolves with { text, thinking, finishReason, usage }.
     */
    async function streamModelTurn(options) {
        const settings = readSettings();
        const cancelId = options.cancelId || uid('cancel');
        const controller = new AbortController();
        const payloadBase = {
            message: String(options.message || ''),
            system_prompt: String(options.systemPrompt || ''),
            interaction_mode: 'chat',
            use_workspace_context: false,
            long_running: true,
            temperature: Number.isFinite(options.temperature) ? options.temperature : settings.temperature,
            max_output_tokens: options.maxOutputTokens || settings.lensMaxOutputTokens,
            cancel_id: cancelId
        };
        const payload = typeof window.withConfiguredModelEndpointPayload === 'function'
            ? window.withConfiguredModelEndpointPayload(payloadBase)
            : payloadBase;

        if (!String(payload.endpoint_id || '').trim() && !String(payload.endpoint_url || '').trim()) {
            throw new BlueprintModelError('Choose an active Local or API model endpoint in SimpleRAG Settings before running Blueprint.');
        }

        let response;
        try {
            response = await fetch(`${API_BASE}/chat/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        } catch (error) {
            if (error && error.name === 'AbortError') throw new BlueprintAbort();
            throw new BlueprintModelError(`Could not reach the SimpleRAG chat endpoint (${error && error.message ? error.message : 'network error'}).`);
        }

        if (!response.ok) {
            let detail = `The model request failed (HTTP ${response.status}).`;
            try {
                const body = await response.json();
                const raw = body && (body.detail || body.error || body.message);
                if (typeof raw === 'string' && raw.trim()) detail = raw.trim();
                else if (raw && typeof raw === 'object' && typeof raw.message === 'string') detail = raw.message;
            } catch (_) { /* keep the generic detail */ }
            throw new BlueprintModelError(detail);
        }

        let text = '';
        let thinking = '';
        let finishReason = '';
        let usage = null;
        let completed = false;
        let aborted = false;

        const onDelta = typeof options.onDelta === 'function' ? options.onDelta : null;
        const onThinking = typeof options.onThinking === 'function' ? options.onThinking : null;
        const tokenLimitNotice = 'output token limit';

        await streamReader()(response, event => {
            if (options.signal && options.signal.aborted) { aborted = true; return; }
            const type = String((event && event.type) || '');
            if (type === 'content') {
                const delta = String((event && event.delta) || '');
                if (delta) {
                    text += delta;
                    if (onDelta) onDelta(delta, text);
                }
            } else if (type === 'thinking') {
                const delta = String((event && event.delta) || '');
                if (delta) {
                    thinking += delta;
                    if (onThinking) onThinking(delta, thinking);
                }
            } else if (type === 'error') {
                throw new BlueprintModelError(String((event && (event.message || event.error || event.detail)) || 'The model stream reported an error.'));
            } else if (type === 'done') {
                completed = true;
                if (!text && event && event.response) text = String(event.response);
                if (!thinking && event && event.thinking) thinking = String(event.thinking);
                finishReason = String((event && event.finish_reason) || '');
                usage = (event && event.usage) || null;
            }
        });

        if (aborted) throw new BlueprintAbort();
        if (options.signal && options.signal.aborted) throw new BlueprintAbort();
        if (!completed) {
            throw new BlueprintModelError('The model stream ended before completion. Try the step again.');
        }
        text = text.trim();
        if (NO_ENDPOINT_PATTERN.test(text)) {
            throw new BlueprintModelError(text);
        }
        if (finishReason === 'length' && text.toLowerCase().includes(tokenLimitNotice)) {
            throw new BlueprintModelError(`The model hit its ${tokenLimitNotice}. Raise the token budget in Blueprint settings and retry.`);
        }
        return { text, thinking, finishReason, usage, cancelId };
    }

    async function cancelTurn(cancelId) {
        if (!cancelId) return false;
        try {
            const response = await fetch(`${API_BASE}/chat/cancel/${encodeURIComponent(cancelId)}`, {
                method: 'POST',
                keepalive: true
            });
            if (!response.ok) return false;
            const body = await response.json();
            return Boolean(body && body.cancelled);
        } catch (_) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // Model output parsing
    // ------------------------------------------------------------------

    function extractJsonObject(text) {
        const source = String(text || '');
        const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
        const candidates = [];
        if (fenced && fenced[1]) candidates.push(fenced[1]);
        candidates.push(source);
        for (const candidate of candidates) {
            const start = candidate.indexOf('{');
            const end = candidate.lastIndexOf('}');
            if (start < 0 || end <= start) continue;
            const slice = candidate.slice(start, end + 1);
            try {
                const parsed = JSON.parse(slice);
                if (parsed && typeof parsed === 'object') return parsed;
            } catch (_) { /* try the next candidate */ }
        }
        return null;
    }

    /**
     * Strip a leading code fence the model may wrap a whole document in, so the
     * written file contains the document rather than a fence around it.
     */
    function unwrapDocument(text) {
        let body = String(text || '').trim();
        const fence = /^```[A-Za-z0-9_+-]*\s*\n([\s\S]*?)\n?```$/.exec(body);
        if (fence) body = fence[1].trim();
        return body;
    }

    /**
     * Drop the model's conversational lead-in so the file starts at the actual
     * document. Only strips text that appears BEFORE the first Markdown heading
     * and only when that preamble is short — a document that genuinely opens
     * with prose is left alone.
     */
    function trimPreamble(text) {
        const body = String(text || '');
        const heading = body.search(/^#{1,6}\s+\S/m);
        if (heading <= 0) return body.trim();
        const preamble = body.slice(0, heading);
        // Long "preambles" are usually the document's own introduction.
        if (preamble.length > 400) return body.trim();
        // Never strip a YAML front matter block or a blockquote provenance line.
        if (/^\s*(---|>)/.test(preamble)) return body.trim();
        return body.slice(heading).trim();
    }

    /**
     * The deterministic cleanup pipeline applied before a document is written.
     * No model turn is spent on any of this. Each stage is independently
     * switchable from Settings -> Documents -> Content handling.
     */
    function prepareDocument(text, meta, settings) {
        const cfg = settings || readSettings();
        const info = meta || {};
        let body = String(text || '');

        if (cfg.unwrapCodeFences !== false) body = unwrapDocument(body);
        if (cfg.trimPreamble !== false) body = trimPreamble(body);

        if (cfg.substitutePlaceholders !== false) {
            const projectName = String(info.projectName || 'Project');
            const date = String(info.date || todayStamp());
            body = body
                .replace(/<Project Name>/g, projectName)
                .replace(/<date>/g, date);
            if (info.sourcePrdPath) {
                const fileName = String(info.sourcePrdPath).split('/').pop();
                body = body
                    .replace(/`docs\/prd\/<source-prd-filename>`/g, '`' + info.sourcePrdPath + '`')
                    .replace(/<source-prd-filename>/g, fileName);
            }
        }

        body = body.trim();

        if (cfg.applyDocumentHeader === true) {
            const skillName = String(info.skillName || 'Blueprint');
            const date = String(info.date || todayStamp());
            const header = '> Generated by the ' + skillName + ' skill on ' + date
                + '. Review and edit before treating this as final.';
            // Do not stack a second header on a document that already has one.
            if (!/^>\s*Generated by /m.test(body)) body = header + '\n\n' + body;
        }

        return body;
    }

    // ------------------------------------------------------------------
    // Output paths — honour the naming and folder-layout settings
    // ------------------------------------------------------------------

    /**
     * Resolve where a generated document lands and what it is called.
     *
     * folderLayout 'skill-folders' uses the upstream per-skill folders
     * (docs/prd, docs/mvp, ...). 'flat' puts everything in docs/ and carries the
     * skill in the file name instead.
     *
     * fileNameStyle controls the ordering of the date and the project slug.
     */
    function buildOutputPath(skill, phase, meta, settings) {
        const cfg = settings || readSettings();
        const info = meta || {};
        const date = String(info.date || todayStamp());
        const slug = String(info.slug || 'project');

        const perPhase = skill && skill.perPhaseOutput && phase && phase.optional;
        const skillFolder = perPhase
            ? ((skill.outputFolders || {})[phase.optional] || skill.outputFolder || 'docs')
            : ((skill && skill.outputFolder) || 'docs');

        // A skill may declare its own suffix ('-prd', '-backlog', ...). Honour it.
        let suffix = '';
        const flatTag = flatTagFor(cfg, skillFolder);
        if (perPhase) {
            const nameFn = (skill.outputFileNames || {})[phase.optional];
            const custom = typeof nameFn === 'function' ? String(nameFn(info) || '') : '';
            if (custom) return withCollisionHandling(joinPath(folderFor(cfg, skillFolder, skill), custom), cfg);
            suffix = '-' + String(phase.optional);
        } else if (skill && typeof skill.outputFileName === 'function') {
            const custom = String(skill.outputFileName(info) || '');
            if (custom) return withCollisionHandling(joinPath(folderFor(cfg, skillFolder, skill), custom), cfg);
        } else if (skill && skill.fileSuffix) {
            suffix = String(skill.fileSuffix);
        }

        const base = cfg.fileNameStyle === 'slug'
            ? slug + suffix + flatTag
            : cfg.fileNameStyle === 'slug-date'
                ? slug + flatTag + suffix + '-' + date
                : date + '-' + slug + flatTag + suffix;

        return withCollisionHandling(joinPath(folderFor(cfg, skillFolder), base + '.md'), cfg);
    }

    /**
     * 'skill-folders' keeps the upstream per-skill folders (docs/prd, docs/mvp,
     * ...). 'flat' collapses everything into docs/ — and so the skill's own
     * folder name is folded into the file name to keep documents distinguishable.
     */
    function folderFor(cfg, skillFolder) {
        return cfg.folderLayout === 'flat' ? 'docs' : (skillFolder || 'docs');
    }

    /** In flat layout, the leaf folder name becomes part of the file name. */
    function flatTagFor(cfg, skillFolder) {
        if (cfg.folderLayout !== 'flat') return '';
        const leaf = String(skillFolder || '').split('/').filter(Boolean).pop() || '';
        return leaf && leaf !== 'docs' ? '-' + leaf : '';
    }

    function joinPath(folder, fileName) {
        const cleanFolder = String(folder || 'docs').replace(/^\/+|\/+$/g, '');
        const cleanName = String(fileName || 'document.md').replace(/^\/+/, '');
        return cleanFolder + '/' + cleanName;
    }

    /**
     * Apply the collision policy. 'version' appends -2, -3 ... so nothing is
     * ever lost; 'overwrite' returns the path unchanged; 'ask' is resolved by
     * the controller (it returns the path and the caller prompts).
     */
    function withCollisionHandling(path, cfg) {
        const policy = cfg && cfg.overwriteExistingFile;
        if (policy === 'overwrite' || policy === 'ask') return path;
        if (!store.files[path]) return path;

        const dot = path.lastIndexOf('.');
        const stem = dot > 0 ? path.slice(0, dot) : path;
        const extension = dot > 0 ? path.slice(dot) : '';
        for (let index = 2; index < 1000; index += 1) {
            const candidate = stem + '-' + index + extension;
            if (!store.files[candidate]) return candidate;
        }
        return stem + '-' + Date.now().toString(36) + extension;
    }

    /** Does a path already hold a document? Used by the 'ask' policy. */
    function fileExists(path) {
        return Boolean(store.files[String(path || '')]);
    }

    // ------------------------------------------------------------------
    // Data page helpers
    // ------------------------------------------------------------------

    /** Approximate bytes Blueprint occupies in this browser profile. */
    function storageUsage() {
        const measure = key => {
            try {
                const raw = window.localStorage.getItem(key);
                return raw ? raw.length * 2 : 0;   // UTF-16: 2 bytes per char
            } catch (_) {
                return 0;
            }
        };
        const projects = measure(PROJECTS_KEY);
        const settings = measure(SETTINGS_KEY);
        const workspace = measure(WORKSPACE_KEY);
        const removed = measure(REMOVED_KEY);
        return {
            projects,
            settings,
            workspace,
            removed,
            total: projects + settings + workspace + removed,
            fileCount: listFiles().length,
            runCount: Array.isArray(store.runs) ? store.runs.length : 0
        };
    }

    /**
     * Browser localStorage is typically ~5 MB per origin. This is not a precise
     * quota probe — there is no standard API for one — but it is enough to warn
     * before a write starts failing, and to say how much room is left when it
     * does.
     */
    const STORAGE_SOFT_LIMIT_BYTES = 5 * 1024 * 1024;

    function storageHeadroom() {
        const usage = storageUsage();
        const limit = STORAGE_SOFT_LIMIT_BYTES;
        return {
            used: usage.total,
            limit,
            remaining: Math.max(0, limit - usage.total),
            percentUsed: Math.min(100, Math.round((usage.total / limit) * 100))
        };
    }

    /**
     * The largest single consumer of Blueprint storage, so a quota warning can
     * tell the user what to clear rather than only that something is full.
     *
     * Runs dominate in practice: each step keeps up to MAX_STEP_TEXT characters of
     * model output and up to 60 runs are retained, so measure them directly
     * instead of assuming.
     */
    function largestStorageConsumer() {
        let runBytes = 0;
        let fileBytes = 0;
        try {
            runBytes = JSON.stringify(store.runs || [], withoutDomNodes).length * 2;
        } catch (_) { runBytes = 0; }
        try {
            fileBytes = JSON.stringify(store.files || {}).length * 2;
        } catch (_) { fileBytes = 0; }
        return runBytes >= fileBytes
            ? { label: 'run history', bytes: runBytes, action: 'Clear run history' }
            : { label: 'project documents', bytes: fileBytes, action: 'Clear project files' };
    }

    function formatBytes(bytes) {
        const value = Number(bytes) || 0;
        if (value < 1024) return value + ' B';
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
        return (value / (1024 * 1024)).toFixed(2) + ' MB';
    }

    /**
     * One Markdown bundle of the whole project, for Settings -> Data -> Export.
     * Deliberately not a zip: no archiver dependency, and the result is readable
     * in any editor.
     */
    function exportBundle() {
        const paths = listFiles();
        const parts = [
            '# Blueprint project export',
            '',
            'Exported ' + new Date().toISOString(),
            '',
            'Project: ' + (store.projectName || 'Untitled'),
            'Documents: ' + paths.length,
            '',
            '---',
            ''
        ];
        paths.forEach(path => {
            const record = store.files[path];
            parts.push('## ' + path, '');
            parts.push(String(record && record.content ? record.content : ''), '');
            parts.push('---', '');
        });
        return parts.join('\n');
    }

    // ------------------------------------------------------------------
    // Public surface
    // ------------------------------------------------------------------

    window.__codalioBlueprintCore = Object.freeze({
        API_BASE,
        PLUGIN_ID,
        PROJECTS_KEY,
        SETTINGS_KEY,
        REMOVED_KEY,
        WORKSPACE_KEY,
        DEFAULT_SETTINGS,
        BlueprintAbort,
        BlueprintModelError,
        store,
        esc,
        clampText,
        slugify,
        todayStamp,
        formatClock,
        uid,
        readSettings,
        readSettingsRaw,
        writeSettings,
        listFiles,
        readFile,
        writeFile,
        isReadOnlyFile,
        canEditFile,
        deleteFile,
        renameFile,
        setOpenPath,
        DEFAULT_FOLDER_ID,
        listFolders,
        getFolder,
        activeFolder,
        setActiveFolder,
        createFolder,
        renameFolder,
        deleteFolder,
        folderFileCount,
        folderFileCounts,
        importFolder,
        canPickDirectoryHandle,
        collectFilesFromDirectoryHandle,
        describeFsError,
        buildCodebaseDigest,
        digestFileStructure,
        scoreFilesForDigest,
        isVendoredPath,
        isMinifiedSource,
        CODE_EXTENSIONS,
        IMPORTABLE_EXTENSIONS,
        IMPORT_SKIP_DIRS,
        relativePathOf,
        extensionOf,
        suggestedFolderName,
        readWorkspaceRaw,
        saveWorkspace,
        clearWorkspace,
        isDomNode,
        withoutDomNodes,
        persistenceState,
        findRun,
        activeRun,
        saveRun,
        deleteRun,
        createRun,
        estimateTokens,
        buildDeterministicCompaction,
        renderMarkdown,
        appendInline,
        streamModelTurn,
        cancelTurn,
        extractJsonObject,
        unwrapDocument,
        trimPreamble,
        prepareDocument,
        buildOutputPath,
        folderFor,
        flatTagFor,
        joinPath,
        withCollisionHandling,
        fileExists,
        storageUsage,
        storageHeadroom,
        largestStorageConsumer,
        STORAGE_SOFT_LIMIT_BYTES,
        formatBytes,
        exportBundle,
        writeStore: () => writeStore(store)
    });
}());
