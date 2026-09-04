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
    const PROJECTS_WRITE_LOCK_PREFIX = `${PLUGIN_ID}.projects-write-lock.`;
    const PENDING_CANCEL_PREFIX = `${PLUGIN_ID}.pending-cancel.`;
    const RUN_OWNER_PREFIX = `${PLUGIN_ID}.run-owner.`;
    const MODEL_OPERATION_OWNER_ID = '__codalio-blueprint-model-operation__';

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

    /**
     * Whether a provider fragment contains something a person can actually see.
     * String.trim() deliberately ignores several format controls (zero-width
     * space/joiners, BOM, NUL, bidi controls). Treating those as progress lets a
     * broken endpoint keep the idle timer alive forever and can turn an invisible
     * terminal response into a successful document.
     */
    function hasMeaningfulText(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/[\p{Z}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
            .length > 0;
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
        // Reliability guardrails. A "retry" is an additional attempt and is
        // only used before the model has emitted any text, so Blueprint never
        // silently splices two generations together.
        modelMaxRetries: 2,
        modelRequestTimeoutSeconds: 1200,
        modelIdleTimeoutSeconds: 300,
        modelRetryBaseDelayMs: 750,

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

    let settingsLoadError = '';
    const SETTINGS_RAW_SYMBOL = Symbol('codalioBlueprintSettingsRaw');

    function bindSettingsSnapshot(settings, raw) {
        if (!settings || typeof settings !== 'object') return settings;
        try {
            Object.defineProperty(settings, SETTINGS_RAW_SYMBOL, {
                value: raw,
                configurable: true,
                enumerable: false,
                writable: true
            });
        } catch (_) { /* plain settings objects are normally extensible */ }
        return settings;
    }

    function readSettingsRaw() {
        try {
            const raw = window.localStorage.getItem(SETTINGS_KEY);
            if (!raw) {
                settingsLoadError = '';
                return bindSettingsSnapshot({}, null);
            }
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                settingsLoadError = 'The saved settings are malformed.';
                return bindSettingsSnapshot({}, raw);
            }
            settingsLoadError = '';
            return bindSettingsSnapshot(parsed, raw);
        } catch (error) {
            settingsLoadError = `The saved settings could not be parsed (${String((error && error.message) || error)}).`;
            return bindSettingsSnapshot({}, undefined);
            // use defaults without overwriting the original bytes
        }
    }

    /**
     * Bound every setting to its documented range. When the schema engine
     * (settings.js) is loaded it owns the bounds, so the UI and the agent can
     * never disagree. Without it — headless tests, or a partially loaded page —
     * core applies the same limits itself.
     */
    function readSettings() {
        const raw = readSettingsRaw();
        const rawSnapshot = raw && raw[SETTINGS_RAW_SYMBOL];
        const schema = window.__codalioBlueprintSettings;
        if (schema && typeof schema.normalizeSettings === 'function') {
            try {
                return bindSettingsSnapshot(schema.normalizeSettings(raw), rawSnapshot);
            } catch (_) { /* fall through to the built-in bounds */ }
        }

        const settings = { ...DEFAULT_SETTINGS };
        Object.keys(DEFAULT_SETTINGS).forEach(key => {
            if (raw[key] !== undefined) settings[key] = raw[key];
        });

        settings.concurrency = settings.concurrency === 'sequential' ? 'sequential' : 'parallel';
        settings.temperature = boundedFloat(settings.temperature, 0, 1.5, DEFAULT_SETTINGS.temperature);
        settings.lensMaxOutputTokens = boundedInt(settings.lensMaxOutputTokens, 512, 32768, DEFAULT_SETTINGS.lensMaxOutputTokens);
        settings.documentMaxOutputTokens = boundedInt(settings.documentMaxOutputTokens, 512, 32768, DEFAULT_SETTINGS.documentMaxOutputTokens);
        settings.maxPromptChars = boundedInt(settings.maxPromptChars, 200, 8000, DEFAULT_SETTINGS.maxPromptChars);
        settings.modelMaxRetries = boundedInt(settings.modelMaxRetries, 0, 5, DEFAULT_SETTINGS.modelMaxRetries);
        settings.modelRequestTimeoutSeconds = boundedInt(settings.modelRequestTimeoutSeconds, 30, 3600, DEFAULT_SETTINGS.modelRequestTimeoutSeconds);
        settings.modelIdleTimeoutSeconds = boundedInt(settings.modelIdleTimeoutSeconds, 15, 900, DEFAULT_SETTINGS.modelIdleTimeoutSeconds);
        settings.modelRetryBaseDelayMs = boundedInt(settings.modelRetryBaseDelayMs, 100, 10000, DEFAULT_SETTINGS.modelRetryBaseDelayMs);
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

        return bindSettingsSnapshot(settings, rawSnapshot);
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

    function writeSettings(settings, options) {
        const opts = options && typeof options === 'object' ? options : {};
        const borrowedLease = opts.transactionLease || null;
        let lease = borrowedLease;
        try {
            if (!lease) lease = acquireStoreWriteLease();
            if (!lease.ok || !ownsStoreWriteIntent(lease) || hasPriorStoreWriter(lease)) return false;
            const rawBefore = window.localStorage.getItem(SETTINGS_KEY);
            const expectedRaw = opts.expectedRaw !== undefined
                ? opts.expectedRaw
                : (settings && Object.prototype.hasOwnProperty.call(settings, SETTINGS_RAW_SYMBOL)
                    ? settings[SETTINGS_RAW_SYMBOL] : undefined);
            if (expectedRaw !== undefined && rawBefore !== expectedRaw) {
                settingsLoadError = 'Settings changed in another Blueprint window. Reload before saving this change.';
                return false;
            }
            if (!(opts.allowCorruptReset === true)) {
                // A caller may save before the settings page has read the key.
                // Inspect it here too, so a routine toggle cannot silently
                // replace malformed data that the user may need to export.
                readSettingsRaw();
                if (settingsLoadError) {
                    console.warn('[codalio-blueprint] refusing to overwrite corrupt settings', settingsLoadError);
                    return false;
                }
            }
            const serialized = JSON.stringify(settings);
            if (!ownsStoreWriteIntent(lease) || hasPriorStoreWriter(lease)
                || window.localStorage.getItem(SETTINGS_KEY) !== rawBefore) return false;
            window.localStorage.setItem(SETTINGS_KEY, serialized);
            if (!ownsStoreWriteIntent(lease)
                || window.localStorage.getItem(SETTINGS_KEY) !== serialized) return false;
            bindSettingsSnapshot(settings, serialized);
            settingsLoadError = '';
            return true;
        } catch (error) {
            console.warn('[codalio-blueprint] unable to persist settings', error);
            return false;
        } finally {
            if (!borrowedLease && lease && lease.ok) releaseStoreWriteLease(lease);
        }
    }

    // ------------------------------------------------------------------
    // Persistence: projects, runs, and the virtual filesystem
    // ------------------------------------------------------------------

    /** Current persisted project-store schema. v3 permits duplicate paths across roots. */
    const STORE_VERSION = 3;

    /** Id of the folder that always exists and owns anything unfiled. */
    const DEFAULT_FOLDER_ID = 'folder-default';

    const hasOwn = (value, key) => Boolean(value)
        && Object.prototype.hasOwnProperty.call(value, key);

    /**
     * Folder and file dictionaries are populated from persisted JSON. Keeping
     * them prototype-free means ids such as "toString" can never masquerade as
     * records through Object.prototype, even before schema validation runs.
     */
    function safeRecordMap(source) {
        const result = Object.create(null);
        if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
        Object.keys(source).forEach(key => { result[key] = source[key]; });
        return result;
    }

    function hasRecord(map, key) {
        return typeof key === 'string' && Boolean(key) && hasOwn(map, key);
    }

    function emptyFolder(id, name, origin) {
        const now = new Date().toISOString();
        const normalizedOrigin = String(origin || 'created');
        return {
            id: String(id),
            name: String(name),
            origin: normalizedOrigin,
            createdAt: now,
            updatedAt: now,
            importState: normalizedOrigin === 'imported' ? 'importing' : 'complete',
            importedCount: 0,
            importError: ''
        };
    }

    function emptyStore() {
        const folders = safeRecordMap();
        folders[DEFAULT_FOLDER_ID] = emptyFolder(DEFAULT_FOLDER_ID, 'Blueprint project', 'default');
        return {
            version: STORE_VERSION,
            // Monotonic compare-and-swap token. Separate app windows can share
            // localStorage; refusing a stale write is safer than silently
            // replacing a newer project's files or run checkpoints.
            revision: 0,
            commitId: '',
            folders,
            files: safeRecordMap(),
            runs: [],
            openPath: '',
            openFolderId: '',
            activeRunId: '',
            activeFolderId: DEFAULT_FOLDER_ID
        };
    }

    /**
     * Bring older stores forward without rewriting their file bodies. v1 files
     * had no folder and land in the default root; v2 already had folders but used
     * paths as storage keys. v3 keeps those legacy keys and allocates a qualified
     * key only when two roots contain the same relative path.
     */
    function migrateStore(parsed, store) {
        const incomingFolders = parsed.folders && typeof parsed.folders === 'object' ? parsed.folders : null;
        if (incomingFolders) {
            Object.keys(incomingFolders).forEach(id => {
                const folder = incomingFolders[id];
                if (!folder || typeof folder !== 'object') return;
                const base = emptyFolder(id, folder.name || id, folder.origin);
                store.folders[id] = Object.assign(base, {
                    createdAt: typeof folder.createdAt === 'string' ? folder.createdAt : base.createdAt,
                    updatedAt: typeof folder.updatedAt === 'string' ? folder.updatedAt : base.updatedAt,
                    // A persisted "importing" marker belongs to an operation that
                    // did not reach its final commit (crash/reload). Never present
                    // that partial root as a completed import on the next load.
                    importState: folder.importState === 'importing'
                        ? 'incomplete'
                        : (folder.importState === 'incomplete' ? 'incomplete' : 'complete'),
                    importedCount: Math.max(0, Number(folder.importedCount) || 0),
                    importError: folder.importState === 'importing'
                        ? 'The prior folder import was interrupted before completion.'
                        : String(folder.importError || '')
                });
            });
        }
        // The default folder must always exist, even if a hand-edited store dropped it.
        if (!hasRecord(store.folders, DEFAULT_FOLDER_ID)) {
            store.folders[DEFAULT_FOLDER_ID] = emptyFolder(DEFAULT_FOLDER_ID, 'Blueprint project', 'default');
        }
        return store;
    }

    function normalizePersistedRun(rawRun, targetStore, fallbackFolderId, schemaVersion, runFolderById) {
        if (!rawRun || typeof rawRun !== 'object') return null;
        const run = Object.assign({}, rawRun);
        const records = Object.keys(targetStore.files)
            .map(key => targetStore.files[key])
            .filter(record => record && typeof record === 'object');
        const writtenPaths = Array.isArray(run.writtenPaths)
            ? run.writtenPaths.map(path => cleanFilePath(String(path))).filter(Boolean)
            : (Array.isArray(run.writtenFiles)
                ? run.writtenFiles.map(item => cleanFilePath(String((item && item.path) || ''))).filter(Boolean)
                : []);

        let folderId = typeof run.folderId === 'string' && run.folderId ? run.folderId : '';
        if (!folderId && Number(schemaVersion || 1) < 3) {
            const candidates = new Set();
            records.forEach(record => {
                if (run.id && record.runId === run.id && record.folder) candidates.add(record.folder);
            });
            writtenPaths.forEach(path => {
                const matches = records.filter(record => record.path === path);
                if (matches.length === 1 && matches[0].folder) candidates.add(matches[0].folder);
            });
            folderId = candidates.size === 1 ? [...candidates][0] : fallbackFolderId;
        }
        run.folderId = folderId || DEFAULT_FOLDER_ID;
        run.rootMissing = !targetStore.folders[run.folderId];

        const priorRefs = Array.isArray(run.writtenFiles)
            ? run.writtenFiles.map(item => item && typeof item === 'object'
                ? Object.assign({}, item, { path: cleanFilePath(String(item.path || '')) })
                : item)
            : [];
        const legacyCrossRootFiles = [];
        run.writtenFiles = writtenPaths.map(path => {
            const prior = priorRefs.find(item => item && item.path === path);
            const matches = records.filter(record => record.path === path);
            const inRunRoot = matches.find(record => record.folder === run.folderId);
            const resolvedOwner = String((inRunRoot && inRunRoot.folder)
                || (prior && prior.folderId)
                || (matches.length === 1 && matches[0].folder)
                || run.folderId);
            if (Number(schemaVersion || 1) < 3 && resolvedOwner !== run.folderId) {
                legacyCrossRootFiles.push({ path, folderId: resolvedOwner });
                return null;
            }
            return { path, folderId: run.folderId };
        }).filter(Boolean);
        run.writtenPaths = run.writtenFiles.map(ref => ref.path);
        if (legacyCrossRootFiles.length) {
            // Preserve the old ambiguous evidence as audit metadata without
            // advertising it as a mutable v3 artifact handle.
            run.legacyCrossRootFiles = legacyCrossRootFiles.slice(0, 100);
        }
        if (Array.isArray(run.reviews)) {
            run.reviews = run.reviews.map(review => {
                if (Number(schemaVersion || 1) < 3 && review && review.folderId
                    && String(review.folderId) !== run.folderId) return null;
                const path = cleanFilePath(String((review && review.path) || ''));
                if (!path) return null;
                return Object.assign({}, review, { path, folderId: run.folderId });
            }).filter(Boolean);
        }
        if (Array.isArray(run.phases)) {
            run.phases.forEach(step => {
                if (step && step.reviewPath) {
                    step.reviewPath = cleanFilePath(String(step.reviewPath));
                    step.reviewFolderId = run.folderId;
                }
            });
        }
        for (const field of ['messages', 'transcript']) {
            if (!Array.isArray(run[field])) continue;
            run[field] = run[field].filter(message => message && typeof message === 'object')
                .map(message => {
                    const copy = Object.assign({}, message);
                    const referencedFolderId = runFolderById && copy.runId
                        ? String(runFolderById.get(String(copy.runId)) || '') : '';
                    const explicitFolderId = typeof copy.folderId === 'string'
                        && targetStore.folders[copy.folderId] ? copy.folderId : '';
                    // A run transcript intentionally carries earlier assistant
                    // cards. Their artifacts still belong to the earlier run's
                    // root; coercing every card to the enclosing/new run corrupts
                    // links and makes a normal A -> B conversation fail v3.
                    const messageFolderId = referencedFolderId
                        || explicitFolderId
                        || run.folderId;
                    if (Array.isArray(copy.paths)) {
                        copy.paths = copy.paths.map(path => cleanFilePath(String(path || ''))).filter(Boolean);
                    }
                    if (Array.isArray(copy.writtenFiles)) {
                        copy.writtenFiles = copy.writtenFiles.map(ref => {
                            const path = cleanFilePath(String((ref && ref.path) || ''));
                            const refFolderId = ref && typeof ref.folderId === 'string'
                                && targetStore.folders[ref.folderId]
                                ? ref.folderId : messageFolderId;
                            return path ? { path, folderId: refFolderId } : null;
                        }).filter(Boolean);
                    }
                    if (copy.targetPath !== undefined) {
                        const targetPath = cleanFilePath(String(copy.targetPath || ''));
                        if (targetPath) {
                            copy.targetPath = targetPath;
                            copy.targetFolderId = typeof copy.targetFolderId === 'string'
                                && targetStore.folders[copy.targetFolderId]
                                ? copy.targetFolderId : messageFolderId;
                        } else {
                            delete copy.targetPath;
                            delete copy.targetFolderId;
                        }
                    }
                    if (copy.folderId !== undefined || copy.paths || copy.writtenFiles) {
                        copy.folderId = messageFolderId;
                    }
                    return copy;
                });
        }
        return run;
    }

    function persistedStoreValidationError(parsed, options) {
        const validationOptions = options && typeof options === 'object' ? options : {};
        const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
        const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
        const reservedIdentifierKeys = new Set([
            ...Object.getOwnPropertyNames(Object.prototype),
            '__proto__',
            'prototype'
        ]);
        const stack = [parsed];
        let inspectedNodes = 0;
        while (stack.length) {
            const node = stack.pop();
            if (!node || typeof node !== 'object') continue;
            inspectedNodes += 1;
            if (inspectedNodes > 50000) return 'The saved project store is too structurally complex to validate safely.';
            for (const key of Object.keys(node)) {
                if (dangerousKeys.has(key)) {
                    return `The saved project store contains unsafe object key "${key}".`;
                }
                const child = node[key];
                if (child && typeof child === 'object') stack.push(child);
            }
        }
        if (parsed.version !== undefined) {
            if (!Number.isSafeInteger(parsed.version) || parsed.version < 1) {
                return 'The saved project store has an invalid schema version.';
            }
            if (parsed.version > STORE_VERSION) {
                return `The saved project store uses newer unsupported schema version ${parsed.version}.`;
            }
        }
        const schemaVersion = Number.isSafeInteger(parsed.version) && parsed.version > 0
            ? parsed.version : 1;
        if (parsed.revision !== undefined
            && (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0)) {
            return 'The saved project store has an invalid revision.';
        }
        if (parsed.commitId !== undefined && typeof parsed.commitId !== 'string') {
            return 'The saved project store has an invalid commit identity.';
        }
        const folders = parsed.folders;
        if (folders !== undefined && !isRecord(folders)) return 'The saved project folder map is malformed.';
        const folderIds = new Set([DEFAULT_FOLDER_ID]);
        if (folders) {
            for (const id of Object.keys(folders)) {
                if (!id || reservedIdentifierKeys.has(id)) {
                    return `The saved project contains unsafe project-root id "${id}".`;
                }
                const folder = folders[id];
                if (!isRecord(folder)) return `The saved project folder "${id}" is malformed.`;
                if (folder.id !== undefined && typeof folder.id !== 'string') {
                    return `The saved project folder "${id}" has an invalid id.`;
                }
                if (folder.name !== undefined && typeof folder.name !== 'string') {
                    return `The saved project folder "${id}" has an invalid name.`;
                }
                folderIds.add(id);
            }
        }

        for (const field of ['activeFolderId', 'openFolderId']) {
            if (parsed[field] !== undefined && typeof parsed[field] !== 'string') {
                return `The saved project has an invalid ${field}.`;
            }
            if (parsed[field] && !folderIds.has(parsed[field])) {
                return `The saved project ${field} references a missing project root.`;
            }
        }
        for (const field of ['openPath', 'activeRunId']) {
            if (parsed[field] !== undefined && typeof parsed[field] !== 'string') {
                return `The saved project has an invalid ${field}.`;
            }
        }

        if (parsed.files !== undefined && !isRecord(parsed.files)) {
            return 'The saved project file map is malformed.';
        }
        const fileIdentities = new Set();
        const fileRunReferences = [];
        if (parsed.files) {
            for (const key of Object.keys(parsed.files)) {
                const record = parsed.files[key];
                if (!isRecord(record)) return `The saved project file record "${key}" is malformed.`;
                if (typeof record.content !== 'string') {
                    return `The saved project file record "${key}" has invalid content.`;
                }
                if (record.path !== undefined && typeof record.path !== 'string') {
                    return `The saved project file record "${key}" has an invalid path.`;
                }
                const rawPath = record.path !== undefined ? record.path : key;
                const canonicalPath = cleanFilePath(rawPath);
                if (!canonicalPath) return `The saved project file record "${key}" has an empty or unsafe path.`;
                if (schemaVersion >= 2 && canonicalPath !== rawPath) {
                    return `The saved project file record "${key}" has a non-canonical path.`;
                }
                if (schemaVersion >= 2 && typeof record.folder !== 'string') {
                    return `The saved project file record "${key}" has lost its project-root owner.`;
                }
                if (record.folder !== undefined) {
                    if (typeof record.folder !== 'string' || !folderIds.has(record.folder)) {
                        return `The saved project file record "${key}" references a missing project root.`;
                    }
                }
                if (record.runId !== undefined && typeof record.runId !== 'string') {
                    return `The saved project file record "${key}" has an invalid run owner.`;
                }
                if (record.runId) {
                    fileRunReferences.push({
                        key,
                        runId: record.runId,
                        folderId: String(record.folder || DEFAULT_FOLDER_ID)
                    });
                }
                const identity = `${String(record.folder || DEFAULT_FOLDER_ID)}\u0000${canonicalPath}`;
                if (fileIdentities.has(identity)) {
                    return `The saved project contains duplicate file identity "${canonicalPath}" in one project root.`;
                }
                fileIdentities.add(identity);
            }
        }
        if (schemaVersion >= 3) {
            const openPath = String(parsed.openPath || '');
            const openFolderId = String(parsed.openFolderId || '');
            if (Boolean(openPath) !== Boolean(openFolderId)) {
                return 'The saved project open file has lost part of its owner-qualified identity.';
            }
            if (openPath) {
                const canonicalOpenPath = cleanFilePath(openPath);
                if (canonicalOpenPath !== openPath
                    || !fileIdentities.has(`${openFolderId}\u0000${canonicalOpenPath}`)) {
                    return 'The saved project open file references a missing file identity.';
                }
            }
        }

        if (parsed.runs !== undefined && !Array.isArray(parsed.runs)) {
            return 'The saved project run history is malformed.';
        }
        const persistedRuns = Array.isArray(parsed.runs) ? parsed.runs : [];
        const runFolderById = new Map(persistedRuns
            .filter(run => isRecord(run) && typeof run.id === 'string' && run.id
                && typeof run.folderId === 'string' && run.folderId)
            .map(run => [run.id, run.folderId]));
        for (const reference of fileRunReferences) {
            const runFolderId = runFolderById.get(reference.runId);
            // Files may outlive a run removed by the 60-entry retention cap.
            // When the referenced run is still present, however, its root is an
            // immutable integrity boundary.
            if (runFolderId && runFolderId !== reference.folderId) {
                return `The saved project file record "${reference.key}" belongs to a run in another project root.`;
            }
        }
        const runIds = new Set();
        for (const run of persistedRuns) {
            if (!isRecord(run) || typeof run.id !== 'string' || !run.id) {
                return 'A saved project run record is malformed.';
            }
            if (runIds.has(run.id)) return `The saved project contains duplicate run id "${run.id}".`;
            runIds.add(run.id);
            if (run.folderId !== undefined && typeof run.folderId !== 'string') {
                return `The saved run "${run.id}" has an invalid project-root owner.`;
            }
            if (schemaVersion >= 3 && (!run.folderId || typeof run.folderId !== 'string')) {
                return `The saved run "${run.id}" has lost its project-root owner.`;
            }
            for (const field of ['phases', 'messages', 'answers', 'reviews', 'writtenPaths', 'pipeline', 'transcript']) {
                if (run[field] !== undefined && !Array.isArray(run[field])) {
                    return `The saved run "${run.id}" has malformed ${field}.`;
                }
            }
            if (run.selectedOptions !== undefined && run.selectedOptions !== null
                && !Array.isArray(run.selectedOptions)) {
                return `The saved run "${run.id}" has malformed selectedOptions.`;
            }
            if (run.transcriptMode !== undefined && run.transcriptMode !== 'run-local-v1') {
                return `The saved run "${run.id}" has an unknown transcript storage mode.`;
            }
            if (run.contextRunId !== undefined && typeof run.contextRunId !== 'string') {
                return `The saved run "${run.id}" has an invalid transcript parent.`;
            }
            for (const field of ['messages', 'transcript']) {
                for (const message of (Array.isArray(run[field]) ? run[field] : [])) {
                    if (!isRecord(message)) return `The saved run "${run.id}" has a malformed ${field} item.`;
                    const referencedFolderId = typeof message.runId === 'string'
                        ? String(runFolderById.get(message.runId) || '') : '';
                    for (const ownerField of ['folderId', 'targetFolderId']) {
                        if (message[ownerField] !== undefined
                            && typeof message[ownerField] !== 'string') {
                            return `The saved run "${run.id}" has invalid ${field} ${ownerField}.`;
                        }
                        if (schemaVersion >= 3 && message[ownerField]
                            && !folderIds.has(message[ownerField])
                            && message[ownerField] !== referencedFolderId) {
                            return `The saved run "${run.id}" has a ${field} reference to a missing project root.`;
                        }
                    }
                    const messageFolderId = String(message.folderId
                        || referencedFolderId
                        || run.folderId);
                    if (schemaVersion >= 3 && referencedFolderId
                        && messageFolderId !== referencedFolderId) {
                        return `The saved run "${run.id}" has a ${field} card whose run and root owners disagree.`;
                    }
                    if (schemaVersion >= 3 && message.runId === run.id
                        && messageFolderId !== run.folderId) {
                        return `The saved run "${run.id}" has a cross-root ${field} reference.`;
                    }
                    if (schemaVersion >= 3 && message.targetPath
                        && message.targetFolderId !== messageFolderId) {
                        return `The saved run "${run.id}" has a ${field} target outside its owning project root.`;
                    }
                    if (message.targetPath !== undefined && (typeof message.targetPath !== 'string'
                        || !cleanFilePath(message.targetPath)
                        || (schemaVersion >= 3 && cleanFilePath(message.targetPath) !== message.targetPath))) {
                        return `The saved run "${run.id}" has an invalid ${field} target path.`;
                    }
                    if (message.paths !== undefined && (!Array.isArray(message.paths)
                        || message.paths.some(path => typeof path !== 'string' || !cleanFilePath(path)
                            || (schemaVersion >= 3 && cleanFilePath(path) !== path)))) {
                        return `The saved run "${run.id}" has malformed ${field} paths.`;
                    }
                    if (message.writtenFiles !== undefined && !Array.isArray(message.writtenFiles)) {
                        return `The saved run "${run.id}" has malformed ${field} file references.`;
                    }
                    for (const ref of (Array.isArray(message.writtenFiles) ? message.writtenFiles : [])) {
                        if (!isRecord(ref) || typeof ref.path !== 'string' || !cleanFilePath(ref.path)
                            || (schemaVersion >= 3 && cleanFilePath(ref.path) !== ref.path)
                            || (schemaVersion >= 3 && ref.folderId !== messageFolderId)) {
                            return `The saved run "${run.id}" has an invalid ${field} file reference.`;
                        }
                    }
                    if (message.steps !== undefined && (!Array.isArray(message.steps)
                        || message.steps.some(step => !isRecord(step)))) {
                        return `The saved run "${run.id}" has malformed ${field} steps.`;
                    }
                }
            }
            for (const writtenPath of (Array.isArray(run.writtenPaths) ? run.writtenPaths : [])) {
                if (typeof writtenPath !== 'string' || !cleanFilePath(writtenPath)
                    || cleanFilePath(writtenPath) !== writtenPath) {
                    return `The saved run "${run.id}" has an invalid written path.`;
                }
            }
            if (run.writtenFiles !== undefined && !Array.isArray(run.writtenFiles)) {
                return `The saved run "${run.id}" has malformed file references.`;
            }
            for (const ref of (Array.isArray(run.writtenFiles) ? run.writtenFiles : [])) {
                if (!isRecord(ref) || typeof ref.path !== 'string'
                    || (ref.folderId !== undefined && typeof ref.folderId !== 'string')) {
                    return `The saved run "${run.id}" has an invalid file reference.`;
                }
                if (!cleanFilePath(ref.path)
                    || (schemaVersion >= 3 && cleanFilePath(ref.path) !== ref.path)) {
                    return `The saved run "${run.id}" has a non-canonical file reference.`;
                }
                if (schemaVersion >= 3 && (!ref.folderId || ref.folderId !== run.folderId)) {
                    return `The saved run "${run.id}" has a file reference outside its project root.`;
                }
            }
            for (const review of (Array.isArray(run.reviews) ? run.reviews : [])) {
                if (!isRecord(review) || typeof review.path !== 'string'
                    || !cleanFilePath(review.path)
                    || (schemaVersion >= 3 && cleanFilePath(review.path) !== review.path)
                    || (schemaVersion >= 3 && review.folderId !== run.folderId)) {
                    return `The saved run "${run.id}" has an invalid review reference.`;
                }
                if (review.ok !== undefined && typeof review.ok !== 'boolean') {
                    return `The saved run "${run.id}" has an invalid review result.`;
                }
                for (const field of ['requiredSections', 'required', 'missing', 'placeholders', 'thin']) {
                    if (review[field] !== undefined && (!Array.isArray(review[field])
                        || review[field].some(value => typeof value !== 'string'))) {
                        return `The saved run "${run.id}" has malformed review ${field}.`;
                    }
                }
            }
            for (const phase of (Array.isArray(run.phases) ? run.phases : [])) {
                if (!isRecord(phase)) return `The saved run "${run.id}" has a malformed phase.`;
                if (phase.reviewPath !== undefined && (typeof phase.reviewPath !== 'string'
                    || !cleanFilePath(phase.reviewPath)
                    || (schemaVersion >= 3 && cleanFilePath(phase.reviewPath) !== phase.reviewPath)
                    || (schemaVersion >= 3 && phase.reviewFolderId !== run.folderId))) {
                    return `The saved run "${run.id}" has an invalid phase review reference.`;
                }
                if (phase.requiredSections !== undefined && (!Array.isArray(phase.requiredSections)
                    || phase.requiredSections.some(value => typeof value !== 'string'))) {
                    return `The saved run "${run.id}" has malformed phase requiredSections.`;
                }
            }
            for (const item of (Array.isArray(run.pipeline) ? run.pipeline : [])) {
                if (!isRecord(item)) return `The saved run "${run.id}" has a malformed pipeline item.`;
            }
        }
        const persistedRunById = new Map(persistedRuns.map(run => [run.id, run]));
        for (const run of persistedRuns) {
            if (run.transcriptMode !== 'run-local-v1' || !run.contextRunId) continue;
            if (run.contextRunId === run.id) {
                return `The saved run "${run.id}" points its transcript at itself.`;
            }
            const parent = persistedRunById.get(run.contextRunId);
            // A missing parent is valid after explicit history deletion or the
            // 60-run retention cap. An existing parent must never cross roots.
            if (parent && String(parent.folderId || '') !== String(run.folderId || '')) {
                return `The saved run "${run.id}" has a cross-root transcript parent.`;
            }
            const visited = new Set([run.id]);
            let cursor = parent;
            while (cursor && cursor.transcriptMode === 'run-local-v1' && cursor.contextRunId) {
                if (visited.has(cursor.id)) {
                    return `The saved run "${run.id}" has a cyclic transcript chain.`;
                }
                visited.add(cursor.id);
                cursor = persistedRunById.get(cursor.contextRunId);
            }
        }
        if (validationOptions.requireSelectionOwnership && parsed.activeRunId) {
            const selectedRun = persistedRuns.find(run => run && run.id === parsed.activeRunId);
            const activeRunFolderId = selectedRun && runFolderById.get(parsed.activeRunId);
            if (!selectedRun || !activeRunFolderId) {
                return 'The saved project activeRunId references a missing run.';
            }
            // Runs outlive a deleted project root so their transcript remains
            // auditable. A terminal orphan may be selected read-only while the
            // live tree stays on a valid root; a still-existing foreign root may
            // never be paired with the selected transcript.
            const terminalOrphan = !folderIds.has(activeRunFolderId)
                && selectedRun.status !== 'running';
            if (activeRunFolderId !== parsed.activeFolderId && !terminalOrphan) {
                return 'The saved project active run belongs to a different project root.';
            }
        }
        return '';
    }

    let projectStoreLoadError = '';

    /**
     * Parse and validate persisted project bytes into a store. Shared by the
     * synchronous localStorage boot path and the asynchronous durable-tier
     * hydration so both interpret bytes identically — a divergence there would
     * silently drop or resurrect files depending on which tier answered first.
     * Returns { store, error }; error is '' on success. Callers decide whether
     * an error is fatal (boot) or merely a reason to prefer the other tier.
     */
    function parsePersistedStoreRaw(raw) {
        const store = emptyStore();
        try {
            if (!raw) return { store, error: '' };
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return { store, error: 'The saved project store is malformed.' };
            }
            const validationError = persistedStoreValidationError(parsed);
            if (validationError) {
                return { store, error: validationError };
            }

            store.revision = Number.isSafeInteger(parsed.revision) && parsed.revision >= 0
                ? parsed.revision : 0;
            store.commitId = typeof parsed.commitId === 'string' ? parsed.commitId : '';

            migrateStore(parsed, store);

            if (parsed.files && typeof parsed.files === 'object') {
                Object.keys(parsed.files).forEach(path => {
                    const record = parsed.files[path];
                    if (!record || typeof record !== 'object') return;
                    // v1 records have no folder: file them into the default folder.
                    const folder = typeof record.folder === 'string' && hasRecord(store.folders, record.folder)
                        ? record.folder
                        : DEFAULT_FOLDER_ID;
                    const canonicalPath = cleanFilePath(
                        typeof record.path === 'string' ? record.path : path);
                    let storageKey = canonicalPath;
                    if (hasRecord(store.files, storageKey)) {
                        const base = `${folder}::${canonicalPath}`;
                        storageKey = base;
                        let suffix = 2;
                        while (hasRecord(store.files, storageKey)) {
                            storageKey = `${base}::${suffix}`;
                            suffix += 1;
                        }
                    }
                    store.files[storageKey] = Object.assign({}, record, {
                        path: canonicalPath,
                        content: typeof record.content === 'string' ? record.content : '',
                        folder
                    });
                });
            }
            store.openPath = typeof parsed.openPath === 'string'
                ? cleanFilePath(parsed.openPath) : '';
            store.activeRunId = typeof parsed.activeRunId === 'string' ? parsed.activeRunId : '';
            const wantedFolder = typeof parsed.activeFolderId === 'string' ? parsed.activeFolderId : '';
            store.activeFolderId = hasRecord(store.folders, wantedFolder) ? wantedFolder : DEFAULT_FOLDER_ID;
            const wantedOpenFolder = typeof parsed.openFolderId === 'string' ? parsed.openFolderId : '';
            const openMatches = Object.keys(store.files)
                .map(key => store.files[key])
                .filter(record => record && record.path === store.openPath);
            const legacyOpen = openMatches.find(record => record.folder === store.activeFolderId)
                || (openMatches.length === 1 ? openMatches[0] : null);
            store.openFolderId = hasRecord(store.folders, wantedOpenFolder)
                && openMatches.some(record => record.folder === wantedOpenFolder)
                ? wantedOpenFolder
                : String((legacyOpen && legacyOpen.folder) || '');
            if (store.openPath && (!openMatches.length || !store.openFolderId)) {
                store.openPath = '';
                store.openFolderId = '';
            }
            if (Array.isArray(parsed.runs)) {
                const runFolderById = new Map(parsed.runs
                    .filter(run => run && typeof run === 'object'
                        && typeof run.id === 'string' && run.id
                        && typeof run.folderId === 'string' && run.folderId)
                    .map(run => [run.id, run.folderId]));
                store.runs = parsed.runs.slice(0, 60)
                    .map(run => normalizePersistedRun(
                        run, store, store.activeFolderId, Number(parsed.version) || 1, runFolderById
                    ))
                    .filter(Boolean);
            }
            if (store.activeRunId && !store.runs.some(run => run && run.id === store.activeRunId)) {
                store.activeRunId = '';
            }
            const selectedRun = store.activeRunId
                ? store.runs.find(run => run && run.id === store.activeRunId) : null;
            // Older builds could persist folder and run selection independently.
            // On migration the explicit root wins; never hydrate another root's
            // transcript merely because both identifiers are individually valid.
            if (selectedRun && hasRecord(store.folders, selectedRun.folderId)
                && String(selectedRun.folderId || '') !== String(store.activeFolderId || '')) {
                store.activeRunId = '';
            }
            return { store, error: '' };
        } catch (error) {
            return {
                store,
                error: `The saved project store could not be parsed (${String((error && error.message) || error)}).`
            };
        }
    }

    /**
     * Synchronous boot read from localStorage. Keeps its original signature and
     * its side effect on projectStoreLoadError so every existing caller (and
     * every test that asserts on it) behaves exactly as before; the durable tier
     * hydrates afterwards and may replace what this returned.
     */
    function readStore() {
        const parsed = parsePersistedStoreRaw(window.localStorage.getItem(PROJECTS_KEY));
        projectStoreLoadError = parsed.error;
        return parsed.store;
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

    function clonePersistable(value) {
        try {
            return JSON.parse(JSON.stringify(value, withoutDomNodes));
        } catch (_) {
            return null;
        }
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
        lastError: '',
        lastCode: ''
    };

    let knownStoreRevision = 0;
    let knownStoreCommitId = '';
    let lastGoodStoreSnapshot = null;
    let externalResetObserved = false;
    const storeWriterId = uid('writer');
    const RUN_LEASE_SYMBOL = Symbol('codalioBlueprintRunLease');
    const STORE_LOCK_LEASE_MS = 30000;

    /**
     * Snapshot live writer intents. Per-writer keys plus a two-stage Bakery-style
     * claim avoid the stale-read race of a single "check then set" lock: a writer
     * that has started choosing is visible before it calculates priority.
     */
    function storeWriteIntents(now) {
        const keys = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index);
            if (key && key.indexOf(PROJECTS_WRITE_LOCK_PREFIX) === 0) keys.push(key);
        }
        const intents = [];
        keys.forEach(key => {
            let value = null;
            try { value = JSON.parse(window.localStorage.getItem(key) || 'null'); } catch (_) { value = null; }
            if (!value || !value.token || Number(value.expiresAt) <= now) {
                try { window.localStorage.removeItem(key); } catch (_) { /* expiry is best-effort */ }
                return;
            }
            intents.push(Object.assign({ key }, value));
        });
        return intents;
    }

    function ownsStoreWriteIntent(lease) {
        try {
            const current = JSON.parse(window.localStorage.getItem(lease.key) || 'null');
            return Boolean(current && current.token === lease.token
                && current.stage === 'waiting'
                && Number(current.expiresAt) > Date.now());
        } catch (_) {
            return false;
        }
    }

    function hasPriorStoreWriter(lease) {
        const now = Date.now();
        return storeWriteIntents(now).some(intent => {
            if (intent.key === lease.key && intent.token === lease.token) return false;
            if (intent.stage === 'choosing') return true;
            if (intent.stage !== 'waiting') return false;
            const otherTicket = Number.isSafeInteger(intent.ticket) ? intent.ticket : 0;
            if (otherTicket !== lease.ticket) return otherTicket < lease.ticket;
            return String(intent.owner || '') < storeWriterId;
        });
    }

    /**
     * localStorage has no transaction primitive. This cooperative Bakery lease
     * serializes Blueprint windows while preserving the existing synchronous API.
     * A crashed writer cannot wedge the store because every intent expires.
     */
    function acquireStoreWriteLease() {
        const token = `${storeWriterId}:${uid('commit')}`;
        const key = `${PROJECTS_WRITE_LOCK_PREFIX}${encodeURIComponent(storeWriterId)}`;
        const now = Date.now();
        window.localStorage.setItem(key, JSON.stringify({
            token,
            owner: storeWriterId,
            stage: 'choosing',
            expiresAt: now + STORE_LOCK_LEASE_MS
        }));
        const maxTicket = storeWriteIntents(now).reduce((max, intent) => {
            const ticket = Number.isSafeInteger(intent.ticket) && intent.ticket > 0 ? intent.ticket : 0;
            return Math.max(max, ticket);
        }, 0);
        const ticket = Math.min(Number.MAX_SAFE_INTEGER - 1, maxTicket + 1);
        const lease = { key, token, ticket, expiresAt: now + STORE_LOCK_LEASE_MS };
        window.localStorage.setItem(key, JSON.stringify({
            token,
            owner: storeWriterId,
            stage: 'waiting',
            ticket,
            acquiredAt: now,
            expiresAt: lease.expiresAt
        }));
        if (!ownsStoreWriteIntent(lease) || hasPriorStoreWriter(lease)) {
            releaseStoreWriteLease(lease);
            return Object.assign(lease, {
                ok: false,
                reason: 'Another Blueprint window is currently saving project data.'
            });
        }
        lease.ok = true;
        return lease;
    }

    function releaseStoreWriteLease(lease) {
        if (!lease || !lease.key) return;
        try {
            const raw = window.localStorage.getItem(lease.key);
            if (!raw) return;
            const current = JSON.parse(raw);
            if (current && current.token === lease.token) {
                window.localStorage.removeItem(lease.key);
            }
        } catch (_) {
            // A stale intent expires. Never delete a claim whose ownership cannot
            // be established, because it may belong to another live window.
        }
    }

    function withStorageWriteLease(callback) {
        if (typeof callback !== 'function') return false;
        let lease = null;
        try {
            lease = acquireStoreWriteLease();
            if (!lease.ok) return false;
            return callback(lease);
        } catch (error) {
            console.warn('[codalio-blueprint] storage transaction failed', error);
            return false;
        } finally {
            if (lease && lease.ok) releaseStoreWriteLease(lease);
        }
    }

    let authoritativeReloadTimer = null;
    let authoritativeWorkspaceReloadTimer = null;
    function scheduleAuthoritativeStoreReload(reason) {
        if (authoritativeReloadTimer) return;
        authoritativeReloadTimer = setTimeout(() => {
            authoritativeReloadTimer = null;
            try {
                window.dispatchEvent(new CustomEvent('codalio-blueprint-store-change', {
                    detail: {
                        reason: String(reason || 'external-change'),
                        recovery: storageRecoveryState()
                    }
                }));
            } catch (_) { /* controller refresh is best-effort */ }
        }, 0);
    }

    function scheduleAuthoritativeWorkspaceReload(reason) {
        if (authoritativeWorkspaceReloadTimer) return;
        authoritativeWorkspaceReloadTimer = setTimeout(() => {
            authoritativeWorkspaceReloadTimer = null;
            try {
                window.dispatchEvent(new CustomEvent('codalio-blueprint-workspace-change', {
                    detail: {
                        reason: String(reason || 'external-workspace-update'),
                        recovery: storageRecoveryState()
                    }
                }));
            } catch (_) { /* controller refresh is best-effort */ }
        }, 0);
    }

    /** Reload only at a controller-approved safe point, never under a live run. */
    function reloadStoreFromStorage() {
        const authoritative = readStore();
        if (projectStoreLoadError) {
            persistence.ok = false;
            persistence.failedAt = Date.now();
            persistence.failureCount += 1;
            persistence.lastCode = 'corrupt-store';
            persistence.lastError = projectStoreLoadError;
            return false;
        }
        assignStoreState(authoritative);
        knownStoreRevision = store.revision;
        knownStoreCommitId = store.commitId;
        lastGoodStoreSnapshot = clonePersistable(store);
        // Reaching this controller-approved safe point means no live operation
        // can resurrect the pre-reset snapshot. New work may start from the now
        // authoritative empty store without requiring a full page reload.
        externalResetObserved = false;
        persistence.ok = true;
        persistence.lastCode = '';
        persistence.lastError = '';
        return true;
    }

    function recordPersistenceFailure(error, code) {
        persistence.ok = false;
        persistence.failedAt = Date.now();
        persistence.failureCount += 1;
        persistence.lastCode = String(code || 'storage-write-failed');
        persistence.lastError = String((error && error.message) || error || 'unknown storage error');
        console.warn('[codalio-blueprint] unable to persist project state', error);
    }

    /**
     * True when localStorage refused a write because the origin's quota is
     * exhausted. Browsers disagree on how they report it — QuotaExceededError is
     * the DOMException name, NS_ERROR_DOM_QUOTA_REACHED is Firefox, and legacy
     * builds use numeric codes 22/1014 — so match those. Message text is a
     * fallback only, and it must name quota *exceeded*: matching a bare "quota"
     * would swallow unrelated failures (a transient refusal must stay a refusal)
     * and claim a save succeeded when nothing was stored.
     */
    function isLocalStorageQuotaError(error) {
        if (!error) return false;
        const name = String(error.name || '');
        const code = String(error.code || '');
        if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
        if (code === '22' || code === '1014') return true;
        return /quota (exceeded|refused|limit)|exceeded the quota|storage is full|out of storage/i
            .test(String(error.message || ''));
    }

    function writeStore(store, options) {
        const borrowedLease = options && options.transactionLease
            ? options.transactionLease : null;
        let lease = borrowedLease;
        // Declared at function scope, NOT inside try: the quota-recovery path in
        // catch needs the validated bytes, and a const declared inside try is out
        // of scope there (a ReferenceError exactly when the store is full).
        let serialized = '';
        let serializedCandidate = null;
        let nextRevision = 0;
        let commitId = '';
        try {
            if (externalResetObserved && !(options && options.allowMissingReset === true)) {
                recordPersistenceFailure(new Error(
                    'Project data was erased in another window. Reload or use Clear all data before saving again.'
                ), 'external-reset');
                return false;
            }
            if (projectStoreLoadError && !(options && options.allowCorruptReset === true)) {
                recordPersistenceFailure(new Error(
                    `${projectStoreLoadError} Blueprint preserved the original data and will not overwrite it; use Clear all data to reset explicitly.`
                ), 'corrupt-store');
                return false;
            }
            if (!lease) lease = acquireStoreWriteLease();
            if (!lease.ok || !ownsStoreWriteIntent(lease) || hasPriorStoreWriter(lease)) {
                recordPersistenceFailure(new Error(lease.reason), 'store-busy');
                return false;
            }
            const raw = window.localStorage.getItem(PROJECTS_KEY);
            if (raw) {
                let currentRevision = 0;
                let currentCommitId = '';
                let current = null;
                let currentError = '';
                try {
                    current = JSON.parse(raw);
                    if (!current || typeof current !== 'object' || Array.isArray(current)) {
                        currentError = 'The saved project store is malformed.';
                    } else {
                        currentError = persistedStoreValidationError(current);
                    }
                    currentRevision = Number.isSafeInteger(current && current.revision)
                        && current.revision >= 0 ? current.revision : 0;
                    currentCommitId = typeof (current && current.commitId) === 'string'
                        ? current.commitId : '';
                } catch (error) {
                    currentError = `The saved project store could not be parsed (${String((error && error.message) || error)}).`;
                }
                if (currentError) {
                    projectStoreLoadError = currentError;
                    if (!(options && options.allowCorruptReset === true)) {
                        recordPersistenceFailure(new Error(
                            `${currentError} Blueprint preserved the original data and will not overwrite it; use Clear all data to reset explicitly.`
                        ), 'corrupt-store');
                        return false;
                    }
                    // Explicit recovery is authorized to replace bytes whose
                    // revision cannot be trusted. Continue from this window's
                    // last known valid revision rather than a malformed value.
                    currentRevision = knownStoreRevision;
                    currentCommitId = knownStoreCommitId;
                }
                if (currentRevision !== knownStoreRevision || currentCommitId !== knownStoreCommitId) {
                    const conflict = new Error('Project data changed in another window. Reload before making more changes.');
                    recordPersistenceFailure(conflict, 'concurrent-update');
                    return false;
                }
            } else if (knownStoreRevision !== 0) {
                if (options && options.allowMissingReset === true) {
                    knownStoreRevision = 0;
                    knownStoreCommitId = '';
                } else {
                    const conflict = new Error(
                        'Project data was deleted in another window. Blueprint will reload the empty authoritative store instead of restoring stale files.'
                    );
                    externalResetObserved = true;
                    recordPersistenceFailure(conflict, 'external-reset');
                    scheduleAuthoritativeStoreReload('external-reset');
                    return false;
                }
            }

            if (options && typeof options.validateUnderLease === 'function') {
                let valid = false;
                try { valid = options.validateUnderLease(lease) === true; } catch (_) { valid = false; }
                if (!valid) {
                    recordPersistenceFailure(new Error(
                        String(options.preconditionMessage
                            || 'The project mutation lost its ownership precondition before commit.')
                    ), String(options.preconditionCode || 'precondition-failed'));
                    return false;
                }
            }

            nextRevision = knownStoreRevision + 1;
            commitId = lease.token;
            const candidate = {
                version: STORE_VERSION,
                revision: nextRevision,
                commitId,
                folders: store.folders,
                files: store.files,
                runs: store.runs.slice(0, 60),
                openPath: store.openPath,
                openFolderId: store.openFolderId,
                activeRunId: store.activeRunId,
                activeFolderId: store.activeFolderId
            };
            serialized = JSON.stringify(candidate, withoutDomNodes);
            serializedCandidate = JSON.parse(serialized);
            const outgoingError = persistedStoreValidationError(serializedCandidate, {
                requireSelectionOwnership: true
            });
            if (outgoingError) {
                recordPersistenceFailure(new Error(
                    `${outgoingError} Blueprint refused to write an unreadable project store.`
                ), 'schema-invalid');
                if (lastGoodStoreSnapshot) assignStoreState(lastGoodStoreSnapshot);
                return false;
            }
            // JSON serialization is the longest synchronous part of a save. Re-
            // validate after it so an expired or contended lease never reaches
            // the project key.
            if (!ownsStoreWriteIntent(lease) || hasPriorStoreWriter(lease)) {
                recordPersistenceFailure(new Error(
                    'Another Blueprint window acquired project-write priority before this save committed.'
                ), 'store-busy');
                return false;
            }
            // Once the durable tier has advanced past localStorage (a quota
            // failure in an earlier session), localStorage's revision is stale
            // and comparing against it would reject every save as a concurrent
            // update. The newer tier becomes the fencing authority instead.
            let localCommitOk = false;
            if (!localStorageDegraded) {
                window.localStorage.setItem(PROJECTS_KEY, serialized);
                let committed = null;
                try { committed = JSON.parse(window.localStorage.getItem(PROJECTS_KEY) || 'null'); } catch (_) { committed = null; }
                if (!ownsStoreWriteIntent(lease) || !committed
                    || committed.revision !== nextRevision || committed.commitId !== commitId) {
                    recordPersistenceFailure(new Error(
                        'Project data was replaced by another writer before this save could be verified.'
                    ), 'concurrent-update');
                    return false;
                }
                localCommitOk = true;
            }
            // Mirror to disk under the lease we still hold, so the durable copy
            // carries the same commit identity the lease granted.
            mirrorToDurableTier(serialized, nextRevision, commitId);
            if (!localCommitOk && !ownsStoreWriteIntent(lease)) {
                recordPersistenceFailure(new Error(
                    'Another Blueprint window acquired project-write priority before this save committed.'
                ), 'store-busy');
                return false;
            }
            store.revision = nextRevision;
            store.commitId = commitId;
            knownStoreRevision = nextRevision;
            knownStoreCommitId = commitId;
            lastGoodStoreSnapshot = serializedCandidate;
            persistence.ok = true;
            persistence.lastError = '';
            persistence.lastCode = '';
            projectStoreLoadError = '';
            if (options && options.allowMissingReset === true) externalResetObserved = false;
            return true;
        } catch (error) {
            // localStorage refused the commit — almost always quota. The bytes
            // are already validated, so queue them to the durable tier to avoid
            // losing them, and mark localStorage degraded so later saves skip a
            // write that is doomed.
            //
            // We still report FAILURE. The durable mirror is asynchronous, so at
            // this point nothing is provably stored anywhere: claiming success
            // would tell the caller its checkpoint is safe when the queue may
            // still fail (no OPFS, no disk space). A reported failure keeps the
            // run's persistenceError and lets the existing retry path re-save,
            // which is the honest and recoverable outcome.
            if (!localStorageDegraded && isLocalStorageQuotaError(error)) {
                try {
                    mirrorToDurableTier(serialized, nextRevision, commitId);
                } catch (mirrorError) {
                    console.warn('[codalio-blueprint] durable mirror could not be queued', mirrorError);
                }
                // Only trust the durable tier once it has actually confirmed a
                // write; until then localStorage remains the authority of record.
                if (durableState.available) {
                    localStorageDegraded = true;
                    durableState.degraded = true;
                    console.info('[codalio-blueprint] localStorage refused a commit; project data is mirrored to disk');
                }
            }
            recordPersistenceFailure(error, 'storage-write-failed');
            return false;
        } finally {
            if (!borrowedLease && lease && lease.ok) releaseStoreWriteLease(lease);
        }
    }

    /** A copy of the persistence state, safe to hand to the renderer. */
    function persistenceState() {
        return Object.assign({}, persistence);
    }

    // ------------------------------------------------------------------
    // Durable storage tier (Origin Private File System)
    // ------------------------------------------------------------------
    //
    // localStorage is capped at roughly 5 MB per origin and Blueprint stores
    // full file content, so a large imported project exceeds it and every save
    // fails with "Browser storage filled before every selected file could be
    // imported." The Origin Private File System is real disk-backed storage in
    // the same origin: multi-GB quota, no user gesture, no permission prompt,
    // byte-exact reads. Measured on this machine: 10240 MB available, an 8 MB
    // write in 35.6 ms.
    //
    // It is ASYNCHRONOUS, and this module's persistence API is synchronous by
    // design — acquireStoreWriteLease exists precisely because "localStorage has
    // no transaction primitive" and its cooperative Bakery lease must stay sync
    // (24 writeStore call sites, none awaited; mount() is sync too). So the tier
    // is a MIRROR, not a replacement:
    //
    //   - the in-memory `store` stays synchronous and authoritative, so no
    //     caller changes and no lease guarantee is weakened;
    //   - every committed save is also queued to disk in revision order;
    //   - at boot whichever tier holds the HIGHER revision wins, and the
    //     controller re-renders through the existing authoritative-reload event.
    //
    // Writes are serialized through one promise chain and fenced on `revision`,
    // so neither a second window nor a slow write overtaking a fast one can land
    // an older snapshot on top of a newer one.

    const DURABLE_FILE = 'projects.json';
    const durableState = {
        available: false,
        revision: 0,
        commitId: '',
        lastError: '',
        pending: 0,
        degraded: false
    };
    let durableQueue = Promise.resolve();
    let durableRootPromise = null;
    // Set once the browser has proven it has no OPFS at all (test harnesses,
    // very old builds). Mirroring is then skipped silently instead of failing
    // and logging on every single save.
    let durableUnsupported = false;
    // Consecutive mirror failures. Once this passes DURABLE_FAILURE_BACKOFF the
    // tier stops being attempted: a permanently broken OPFS (policy-blocked,
    // unwritable profile) would otherwise log on every single save for the rest
    // of the session, burying real diagnostics in noise.
    let durableFailureStreak = 0;
    const DURABLE_FAILURE_BACKOFF = 3;
    // Set once localStorage has rejected a commit (quota). From then on the
    // durable tier's revision — not localStorage's — is the fencing authority.
    let localStorageDegraded = false;

    function durableRoot() {
        if (!durableRootPromise) {
            durableRootPromise = (async () => {
                if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
                    const error = new Error('This browser offers no origin-private file storage.');
                    // Distinguish "no such API" from a transient failure: only
                    // the former should permanently disable mirroring.
                    error.unsupported = true;
                    throw error;
                }
                return navigator.storage.getDirectory();
            })();
            // Never cache a rejected root: the failure may be transient, and a
            // later save should be allowed to retry.
            durableRootPromise.catch(() => { durableRootPromise = null; });
        }
        return durableRootPromise;
    }

    async function durableReadRaw() {
        const root = await durableRoot();
        let handle;
        try {
            handle = await root.getFileHandle(DURABLE_FILE);
        } catch (error) {
            // Never written yet. Distinct from a genuine failure so the caller
            // can seed the tier instead of reporting an error.
            if (error && error.name === 'NotFoundError') return null;
            throw error;
        }
        const text = await (await handle.getFile()).text();
        return text || null;
    }

    async function durableWriteRaw(serialized, revision, commitId) {
        // Fence before touching disk.
        if (Number(revision) < durableState.revision) return false;
        const root = await durableRoot();
        const tempName = `${DURABLE_FILE}.${commitId || revision}.tmp`;
        const handle = await root.getFileHandle(tempName, { create: true });
        const writable = await handle.createWritable();
        try {
            await writable.write(serialized);
            await writable.close();
        } catch (error) {
            // A failed write must not leave a half-written temp file behind.
            try { await root.removeEntry(tempName); } catch (_) { /* best effort */ }
            throw error;
        }
        if (typeof handle.move === 'function') {
            // Rename over the target: the only atomic replace OPFS offers, so a
            // crash mid-write leaves the previous good file intact.
            await handle.move(DURABLE_FILE);
        } else {
            // Older builds lack move(). Write straight to the target; the
            // revision fence still prevents an older snapshot from winning.
            const target = await root.getFileHandle(DURABLE_FILE, { create: true });
            const targetWritable = await target.createWritable();
            await targetWritable.write(serialized);
            await targetWritable.close();
            try { await root.removeEntry(tempName); } catch (_) { /* best effort */ }
        }
        durableState.revision = Number(revision) || 0;
        durableState.commitId = String(commitId || '');
        durableState.lastError = '';
        return true;
    }

    /**
     * Queue a durable mirror of already-committed bytes. Fire-and-forget by
     * necessity — writeStore is synchronous — but ordered and revision-fenced.
     * A failure is only escalated to the persistence channel when localStorage
     * is ALSO degraded, because that is the one state where neither tier holds
     * the data and losing it silently would be the worst possible outcome.
     */
    function mirrorToDurableTier(serialized, revision, commitId) {
        if (durableUnsupported) return durableQueue;
        durableState.pending += 1;
        durableQueue = durableQueue
            .then(() => durableWriteRaw(serialized, revision, commitId))
            .then(wrote => {
                if (wrote !== false) {
                    durableState.available = true;
                    // A success resets the streak so a later transient failure
                    // gets its own budget before backing off.
                    durableFailureStreak = 0;
                }
            })
            .catch(error => {
                if (error && error.unsupported) {
                    // No OPFS at all. Disable mirroring permanently and stay
                    // quiet: localStorage remains the store, exactly as before
                    // this tier existed.
                    durableUnsupported = true;
                    durableState.available = false;
                    return;
                }
                durableFailureStreak += 1;
                durableState.lastError = String((error && error.message) || error);
                if (localStorageDegraded) {
                    recordPersistenceFailure(new Error(
                        `Project data could not be saved to disk (${durableState.lastError}). `
                        + 'Export your work before closing this tab.'
                    ), 'durable-write-failed');
                    // In degraded mode localStorage is no longer the authority,
                    // so a failing disk tier is a genuine data-loss risk. Keep
                    // escalating — but the caller already has persistence.ok
                    // set false, so this does not spam the user.
                } else if (durableFailureStreak >= DURABLE_FAILURE_BACKOFF) {
                    // Repeatedly broken and localStorage is still authoritative:
                    // disable the tier. Log ONCE, then go quiet.
                    durableUnsupported = true;
                    durableState.available = false;
                    console.warn('[codalio-blueprint] durable storage unavailable after '
                        + `${durableFailureStreak} failed writes; continuing with browser storage only. `
                        + `Last error: ${durableState.lastError}`);
                } else {
                    // localStorage still holds the authoritative copy, so this
                    // is a lost mirror rather than lost data.
                    console.warn('[codalio-blueprint] durable storage mirror failed', error);
                }
            })
            .then(() => {
                durableState.pending = Math.max(0, durableState.pending - 1);
            });
        return durableQueue;
    }

    /**
     * Boot hydration. Runs after the synchronous localStorage read so nothing
     * depending on `store` existing at import time changes. If the durable tier
     * holds a STRICTLY newer revision it replaces the store in place and asks
     * the controller to re-render.
     */
    async function hydrateFromDurableTier() {
        if (durableUnsupported) return false;
        let raw = null;
        try {
            raw = await durableReadRaw();
        } catch (error) {
            if (error && error.unsupported) {
                // No OPFS in this browser. Behave exactly as before this tier
                // existed: localStorage is the store, and say nothing.
                durableUnsupported = true;
                durableState.available = false;
                return false;
            }
            durableState.available = false;
            durableState.lastError = String((error && error.message) || error);
            return false;
        }
        const localRevision = Number.isSafeInteger(store.revision) ? store.revision : 0;
        if (!raw) {
            // Nothing on disk yet: seed it from localStorage so the tiers agree
            // before the first save instead of diverging at the first quota hit.
            durableState.available = true;
            if (localRevision > 0) {
                mirrorToDurableTier(
                    JSON.stringify(clonePersistable(store), withoutDomNodes),
                    localRevision,
                    store.commitId
                );
            }
            return false;
        }
        durableState.available = true;
        const parsed = parsePersistedStoreRaw(raw);
        if (parsed.error) {
            // A corrupt durable copy must never displace a good localStorage one.
            durableState.lastError = parsed.error;
            return false;
        }
        const durableRevision = Number.isSafeInteger(parsed.store.revision) ? parsed.store.revision : 0;
        durableState.revision = durableRevision;
        durableState.commitId = String(parsed.store.commitId || '');
        // Only a strictly newer tier wins. Equal means both agree; LOWER means
        // another window already moved on, so rolling back would lose its work.
        if (durableRevision <= localRevision) return false;

        assignStoreState(parsed.store);
        store.revision = durableRevision;
        store.commitId = durableState.commitId;
        knownStoreRevision = durableRevision;
        knownStoreCommitId = durableState.commitId;
        lastGoodStoreSnapshot = clonePersistable(store);
        // The durable tier outran localStorage — typically a quota failure in an
        // earlier session. Treat localStorage as a cache from here on.
        localStorageDegraded = true;
        durableState.degraded = true;
        projectStoreLoadError = '';
        persistence.ok = true;
        persistence.lastError = '';
        persistence.lastCode = '';
        scheduleAuthoritativeStoreReload('durable-tier-hydration');
        return true;
    }

    /** A copy of the durable-tier state, safe to hand to the renderer. */
    function durableStorageState() {
        return Object.assign({}, durableState, {
            localStorageDegraded,
            // True only while a mirror is in flight and unconfirmed.
            mirroring: durableState.pending > 0
        });
    }

    const store = readStore();
    knownStoreRevision = store.revision;
    knownStoreCommitId = store.commitId;
    lastGoodStoreSnapshot = clonePersistable(store);
    if (projectStoreLoadError) {
        persistence.ok = false;
        persistence.failedAt = Date.now();
        persistence.failureCount = 1;
        persistence.lastCode = 'corrupt-store';
        persistence.lastError = projectStoreLoadError;
    }
    // Prefer whichever tier holds the newer revision. Deliberately NOT awaited:
    // every consumer of `store` expects it synchronously at import time, and
    // mount() is synchronous too. When the durable tier wins, hydration swaps
    // the store in place and asks the controller to re-render through the same
    // authoritative-reload path an external window edit already uses.
    hydrateFromDurableTier().catch(error => {
        console.warn('[codalio-blueprint] durable storage hydration failed', error);
    });
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('storage', event => {
            if (!event || !event.key) return;
            if (String(event.key).startsWith(RUN_OWNER_PREFIX)
                || String(event.key).startsWith(PENDING_CANCEL_PREFIX)) {
                try {
                    window.dispatchEvent(new CustomEvent('codalio-blueprint-run-lease-change', {
                        detail: { key: String(event.key) }
                    }));
                } catch (_) { /* controller reconciliation is best-effort */ }
                return;
            }
            if (event.key === WORKSPACE_KEY) {
                scheduleAuthoritativeWorkspaceReload(event.newValue === null
                    ? 'external-workspace-reset' : 'external-workspace-update');
                return;
            }
            if (event.key !== PROJECTS_KEY) return;
            if (event.newValue === null) externalResetObserved = true;
            scheduleAuthoritativeStoreReload(event.newValue === null ? 'external-reset' : 'external-update');
        });
    }

    // ------------------------------------------------------------------
    // Workspace (tab layout) persistence
    //
    // Kept in its OWN localStorage key, separate from projects and settings, so
    // clearing run history or documents never loses the tab layout and vice
    // versa. workspace.js owns normalization; core only stores the raw object.
    // ------------------------------------------------------------------

    let workspaceLoadError = '';
    let knownWorkspaceRevision = 0;
    let knownWorkspaceCommitId = '';
    let workspaceRevisionKnown = false;

    function persistedWorkspaceValidationError(parsed) {
        const version = parsed.version === undefined ? 1 : parsed.version;
        if (!Number.isSafeInteger(version) || version < 1) {
            return 'The saved tab layout has an invalid schema version.';
        }
        if (version > 2) {
            return `The saved tab layout uses newer unsupported schema version ${version}.`;
        }
        if (parsed.revision !== undefined
            && (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0)) {
            return 'The saved tab layout has an invalid revision.';
        }
        if (parsed.commitId !== undefined && typeof parsed.commitId !== 'string') {
            return 'The saved tab layout has an invalid commit identity.';
        }
        if (Number(parsed.revision) > 0 && !String(parsed.commitId || '')) {
            return 'The saved tab layout is missing its commit identity.';
        }
        if (parsed.tabs !== undefined && !Array.isArray(parsed.tabs)) {
            return 'The saved tab layout has a malformed tab collection.';
        }
        const tabs = Array.isArray(parsed.tabs) ? parsed.tabs : [];
        if (tabs.length > 1000) return 'The saved tab layout contains too many tabs to validate safely.';
        for (const tab of tabs) {
            if (!tab || typeof tab !== 'object' || Array.isArray(tab)) {
                return 'The saved tab layout contains a malformed tab.';
            }
            if (tab.kind === 'file') {
                if (typeof tab.path !== 'string' || !cleanFilePath(tab.path)) {
                    return 'The saved tab layout contains a file tab with an invalid path.';
                }
                if (version >= 2 && cleanFilePath(tab.path) !== tab.path) {
                    return 'The saved tab layout contains a file tab with a non-canonical path.';
                }
                if (version >= 2 && (typeof tab.folderId !== 'string' || !tab.folderId)) {
                    return 'The saved tab layout contains a file tab without its project-root owner.';
                }
            }
        }
        return '';
    }

    function readWorkspaceRaw() {
        try {
            const raw = window.localStorage.getItem(WORKSPACE_KEY);
            if (!raw) {
                workspaceLoadError = '';
                knownWorkspaceRevision = 0;
                knownWorkspaceCommitId = '';
                workspaceRevisionKnown = true;
                return null;
            }
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                workspaceLoadError = 'The saved tab layout is malformed.';
                return null;
            }
            const validationError = persistedWorkspaceValidationError(parsed);
            if (validationError) {
                workspaceLoadError = validationError;
                return null;
            }
            workspaceLoadError = '';
            knownWorkspaceRevision = Number.isSafeInteger(parsed.revision) ? parsed.revision : 0;
            knownWorkspaceCommitId = typeof parsed.commitId === 'string' ? parsed.commitId : '';
            workspaceRevisionKnown = true;
            return parsed;
        } catch (error) {
            workspaceLoadError = `The saved tab layout could not be parsed (${String((error && error.message) || error)}).`;
            return null;
        }
    }

    function saveWorkspace(workspace, options) {
        if (!workspace || typeof workspace !== 'object') return false;
        const borrowedLease = options && options.transactionLease
            ? options.transactionLease : null;
        let lease = borrowedLease;
        try {
            const rawBefore = window.localStorage.getItem(WORKSPACE_KEY);
            let current = null;
            let currentError = '';
            if (rawBefore) {
                try {
                    current = JSON.parse(rawBefore);
                    if (!current || typeof current !== 'object' || Array.isArray(current)) {
                        currentError = 'The saved tab layout is malformed.';
                    } else currentError = persistedWorkspaceValidationError(current);
                } catch (error) {
                    currentError = `The saved tab layout could not be parsed (${String((error && error.message) || error)}).`;
                }
            }
            if (currentError && !(options && options.allowCorruptReset === true)) {
                workspaceLoadError = currentError;
                console.warn('[codalio-blueprint] refusing to overwrite a corrupt tab layout', workspaceLoadError);
                return false;
            }
            const currentRevision = Number.isSafeInteger(current && current.revision)
                ? current.revision : 0;
            const currentCommitId = typeof (current && current.commitId) === 'string'
                ? current.commitId : '';
            if (!workspaceRevisionKnown) {
                knownWorkspaceRevision = currentRevision;
                knownWorkspaceCommitId = currentCommitId;
                workspaceRevisionKnown = true;
            } else if (!currentError && (currentRevision !== knownWorkspaceRevision
                || currentCommitId !== knownWorkspaceCommitId)) {
                workspaceLoadError = 'The tab layout changed in another Blueprint window. Reload before changing tabs again.';
                console.warn('[codalio-blueprint] refusing to overwrite a newer tab layout', workspaceLoadError);
                scheduleAuthoritativeWorkspaceReload('workspace-conflict');
                return false;
            }
            if (!lease) lease = acquireStoreWriteLease();
            if (!lease.ok || !ownsStoreWriteIntent(lease) || hasPriorStoreWriter(lease)) return false;
            // Persist only the shape workspace.js normalizes back, never DOM or
            // handler references that may have been attached to it.
            const tabs = (Array.isArray(workspace.tabs) ? workspace.tabs : []).map(tab => ({
                id: String(tab.id || ''),
                kind: tab.kind === 'file' ? 'file' : (tab.kind === 'section' ? 'section' : 'agent'),
                title: String(tab.title || ''),
                icon: String(tab.icon || ''),
                sectionId: String(tab.sectionId || ''),
                path: String(tab.path || ''),
                folderId: String(tab.folderId || ''),
                pinned: tab.pinned === true,
                openedAt: Number(tab.openedAt) || Date.now(),
                lastActiveAt: Number(tab.lastActiveAt) || Date.now()
            }));
            const candidate = {
                version: 2,
                revision: currentRevision + 1,
                commitId: lease.token,
                tabs,
                activeTabId: String(workspace.activeTabId || ''),
                settingsSection: String(workspace.settingsSection || ''),
                settingsPage: String(workspace.settingsPage || ''),
                viewerModeByPath: workspace.viewerModeByPath && typeof workspace.viewerModeByPath === 'object'
                    ? workspace.viewerModeByPath
                    : {},
                dividerPx: Number(workspace.dividerPx) || 0
            };
            const serialized = JSON.stringify(candidate, withoutDomNodes);
            const serializedCandidate = JSON.parse(serialized);
            const validationError = persistedWorkspaceValidationError(serializedCandidate);
            if (validationError) {
                console.warn('[codalio-blueprint] refusing to persist an unreadable tab layout', validationError);
                return false;
            }
            if (!ownsStoreWriteIntent(lease) || hasPriorStoreWriter(lease)
                || window.localStorage.getItem(WORKSPACE_KEY) !== rawBefore) {
                workspaceLoadError = 'The tab layout changed before this save could commit.';
                return false;
            }
            window.localStorage.setItem(WORKSPACE_KEY, serialized);
            let committed = null;
            try { committed = JSON.parse(window.localStorage.getItem(WORKSPACE_KEY) || 'null'); } catch (_) { committed = null; }
            if (!ownsStoreWriteIntent(lease) || !committed
                || committed.revision !== candidate.revision || committed.commitId !== candidate.commitId) {
                workspaceLoadError = 'The tab layout was replaced by another writer before this save could be verified.';
                scheduleAuthoritativeWorkspaceReload('workspace-conflict');
                return false;
            }
            knownWorkspaceRevision = candidate.revision;
            knownWorkspaceCommitId = candidate.commitId;
            workspaceRevisionKnown = true;
            workspaceLoadError = '';
            return true;
        } catch (error) {
            console.warn('[codalio-blueprint] unable to persist the tab layout', error);
            return false;
        } finally {
            if (!borrowedLease && lease && lease.ok) releaseStoreWriteLease(lease);
        }
    }

    function clearWorkspace(options) {
        const borrowedLease = options && options.transactionLease
            ? options.transactionLease : null;
        let lease = borrowedLease;
        try {
            const rawBefore = window.localStorage.getItem(WORKSPACE_KEY);
            let current = null;
            let currentError = '';
            if (rawBefore) {
                try {
                    current = JSON.parse(rawBefore);
                    currentError = (!current || typeof current !== 'object' || Array.isArray(current))
                        ? 'The saved tab layout is malformed.'
                        : persistedWorkspaceValidationError(current);
                } catch (error) {
                    currentError = `The saved tab layout could not be parsed (${String((error && error.message) || error)}).`;
                }
            }
            if (currentError && !(options && options.allowCorruptReset === true)) {
                workspaceLoadError = currentError;
                console.warn('[codalio-blueprint] refusing to erase a corrupt tab layout', workspaceLoadError);
                return false;
            }
            const currentRevision = Number.isSafeInteger(current && current.revision) ? current.revision : 0;
            const currentCommitId = typeof (current && current.commitId) === 'string' ? current.commitId : '';
            if (workspaceRevisionKnown && !currentError
                && (currentRevision !== knownWorkspaceRevision || currentCommitId !== knownWorkspaceCommitId)) {
                workspaceLoadError = 'The tab layout changed in another Blueprint window. Reload before clearing it.';
                scheduleAuthoritativeWorkspaceReload('workspace-conflict');
                return false;
            }
            if (!lease) lease = acquireStoreWriteLease();
            if (!lease.ok || !ownsStoreWriteIntent(lease) || hasPriorStoreWriter(lease)
                || window.localStorage.getItem(WORKSPACE_KEY) !== rawBefore) {
                scheduleAuthoritativeWorkspaceReload('workspace-conflict');
                return false;
            }
            window.localStorage.removeItem(WORKSPACE_KEY);
            if (window.localStorage.getItem(WORKSPACE_KEY) !== null) return false;
            knownWorkspaceRevision = 0;
            knownWorkspaceCommitId = '';
            workspaceRevisionKnown = true;
            workspaceLoadError = '';
            return true;
        } catch (error) {
            console.warn('[codalio-blueprint] unable to clear the tab layout', error);
            return false;
        } finally {
            if (!borrowedLease && lease && lease.ok) releaseStoreWriteLease(lease);
        }
    }

    /** Per-key corruption state for recovery UI and headless diagnostics. */
    function storageRecoveryState() {
        return {
            projects: String(projectStoreLoadError || (externalResetObserved
                ? 'Project data was erased in another window; this window is blocked from restoring stale data.' : '')),
            settings: String(settingsLoadError || ''),
            workspace: String(workspaceLoadError || '')
        };
    }

    /**
     * Export the exact owned localStorage bytes before a repair/reset. JSON string
     * escaping is reversible: parsing this file reproduces each `raw` value byte
     * for byte, including malformed JSON that the normal readers reject.
     */
    function exportRecoverySnapshot() {
        // Refresh per-key diagnostics without overwriting any raw value.
        readSettingsRaw();
        readWorkspaceRaw();
        const raw = {
            projects: window.localStorage.getItem(PROJECTS_KEY),
            settings: window.localStorage.getItem(SETTINGS_KEY),
            workspace: window.localStorage.getItem(WORKSPACE_KEY)
        };
        return JSON.stringify({
            format: 'codalio-blueprint-storage-recovery',
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            errors: storageRecoveryState(),
            raw
        }, null, 2);
    }

    function pendingCancelKey(cancelId) {
        return `${PENDING_CANCEL_PREFIX}${encodeURIComponent(String(cancelId || ''))}`;
    }

    const PENDING_CANCEL_LEASE_MS = 60000;
    const PENDING_CANCEL_HEARTBEAT_MS = 15000;

    function readPendingCancelRecord(key) {
        try {
            const parsed = JSON.parse(window.localStorage.getItem(key) || 'null');
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            const id = String(parsed.id || '').trim();
            if (!id) return null;
            return {
                id,
                ownerId: String(parsed.ownerId || ''),
                leaseId: String(parsed.leaseId || ''),
                runId: String(parsed.runId || ''),
                state: String(parsed.state || 'possibly-active'),
                createdAt: String(parsed.createdAt || ''),
                leaseExpiresAt: Number(parsed.leaseExpiresAt) || 0,
                key
            };
        } catch (_) {
            return null;
        }
    }

    function listPendingCancelRecords() {
        const records = [];
        try {
            const count = Number(window.localStorage.length) || 0;
            for (let index = 0; index < count; index += 1) {
                const key = window.localStorage.key(index);
                if (!key || !String(key).startsWith(PENDING_CANCEL_PREFIX)) continue;
                let record = readPendingCancelRecord(key);
                if (!record) {
                    let id = '';
                    try { id = decodeURIComponent(String(key).slice(PENDING_CANCEL_PREFIX.length)); } catch (_) { id = ''; }
                    if (id) record = {
                        id,
                        ownerId: '',
                        leaseId: '',
                        runId: '',
                        state: 'possibly-active',
                        createdAt: '',
                        leaseExpiresAt: 0,
                        key
                    };
                }
                if (record && !records.some(item => item.id === record.id)) records.push(record);
            }
        } catch (error) {
            console.warn('[codalio-blueprint] unable to read pending model cancellations', error);
        }
        return records;
    }

    /** Record a possibly active backend turn before its stream request is sent. */
    function rememberPendingCancel(cancelId, metadata) {
        const id = String(cancelId || '').trim();
        if (!id) return '';
        let lease = null;
        try {
            lease = acquireStoreWriteLease();
            if (!lease.ok) return '';
            const key = pendingCancelKey(id);
            const existing = readPendingCancelRecord(key);
            const now = Date.now();
            if (existing && existing.ownerId && existing.ownerId !== storeWriterId
                && existing.leaseExpiresAt > now) {
                return '';
            }
            const info = metadata && typeof metadata === 'object' ? metadata : {};
            const runId = String(info.runId || '');
            const runLeaseId = String(info.runLeaseId || '');
            if (runId) {
                const runOwner = readRunOwner(runId);
                if (!runLeaseId || !runOwner || !runOwner.owned || !runOwner.live
                    || runOwner.leaseId !== runLeaseId) return '';
                // Reserve dispatch and renew its run fence under the same
                // cooperative lease. A recovery/takeover cannot slip between
                // owner validation and cancellation-ledger creation.
                window.localStorage.setItem(runOwnerKey(runId), JSON.stringify({
                    runId,
                    ownerId: storeWriterId,
                    leaseId: runLeaseId,
                    leaseExpiresAt: now + PENDING_CANCEL_LEASE_MS
                }));
                const renewed = readRunOwner(runId);
                if (!renewed || !renewed.owned || !renewed.live
                    || renewed.leaseId !== runLeaseId) return '';
            }
            const leaseId = uid('cancel-lease');
            window.localStorage.setItem(key, JSON.stringify({
                id,
                ownerId: storeWriterId,
                leaseId,
                runId: String(runId || (existing && existing.runId) || ''),
                state: 'possibly-active',
                createdAt: (existing && existing.createdAt) || new Date(now).toISOString(),
                leaseExpiresAt: now + PENDING_CANCEL_LEASE_MS
            }));
            const verified = readPendingCancelRecord(key);
            return verified && verified.ownerId === storeWriterId
                && verified.leaseId === leaseId
                && verified.leaseExpiresAt > Date.now()
                ? leaseId : '';
        } catch (error) {
            console.warn('[codalio-blueprint] unable to persist pending model cancellation', error);
            return '';
        } finally {
            if (lease && lease.ok) releaseStoreWriteLease(lease);
        }
    }

    function refreshPendingCancel(cancelId, expectedLeaseId) {
        const id = String(cancelId || '').trim();
        const expected = String(expectedLeaseId || '');
        if (!id) return false;
        let lease = null;
        try {
            lease = acquireStoreWriteLease();
            if (!lease.ok) {
                const current = readPendingCancelRecord(pendingCancelKey(id));
                return Boolean(current && current.ownerId === storeWriterId
                    && current.leaseId && (!expected || current.leaseId === expected)
                    && current.leaseExpiresAt > Date.now());
            }
            const key = pendingCancelKey(id);
            const record = readPendingCancelRecord(key);
            if (!record || record.ownerId !== storeWriterId || !record.leaseId
                || (expected && record.leaseId !== expected)) return false;
            window.localStorage.setItem(key, JSON.stringify({
                id: record.id,
                ownerId: record.ownerId,
                leaseId: record.leaseId,
                runId: record.runId,
                state: record.state,
                createdAt: record.createdAt,
                leaseExpiresAt: Date.now() + PENDING_CANCEL_LEASE_MS
            }));
            const verified = readPendingCancelRecord(key);
            return Boolean(verified && verified.ownerId === storeWriterId
                && verified.leaseId === record.leaseId
                && verified.leaseExpiresAt > Date.now());
        } catch (_) {
            return false;
        } finally {
            if (lease && lease.ok) releaseStoreWriteLease(lease);
        }
    }

    /** Remove a ledger entry only after an authoritative terminal/cancel result. */
    function forgetPendingCancel(cancelId, expectedLeaseId) {
        const id = String(cancelId || '').trim();
        if (!id) return false;
        let lease = null;
        try {
            lease = acquireStoreWriteLease();
            if (!lease.ok) return false;
            const key = pendingCancelKey(id);
            const current = readPendingCancelRecord(key);
            const expected = String(expectedLeaseId || '');
            // A recovery window may have claimed an expired entry while the old
            // page was suspended. That old page must not erase the new owner's
            // cancellation barrier when it resumes.
            if (current && (current.ownerId !== storeWriterId
                || (expected && current.leaseId !== expected))) return false;
            window.localStorage.removeItem(key);
            return true;
        } catch (error) {
            console.warn('[codalio-blueprint] unable to clear pending model cancellation', error);
            return false;
        } finally {
            if (lease && lease.ok) releaseStoreWriteLease(lease);
        }
    }

    function listPendingCancels(options) {
        const recoverableOnly = options && options.recoverableOnly === true;
        const now = Date.now();
        return listPendingCancelRecords()
            .filter(record => !recoverableOnly || !record.ownerId
                || record.ownerId === storeWriterId || record.leaseExpiresAt <= now)
            .map(record => record.id);
    }

    function runOwnerKey(runId) {
        return `${RUN_OWNER_PREFIX}${encodeURIComponent(String(runId || ''))}`;
    }

    function readRunOwner(runId) {
        const id = String(runId || '').trim();
        if (!id) return null;
        try {
            const parsed = JSON.parse(window.localStorage.getItem(runOwnerKey(id)) || 'null');
            if (!parsed || typeof parsed !== 'object' || String(parsed.runId || '') !== id) return null;
            const ownerId = String(parsed.ownerId || '');
            const leaseId = String(parsed.leaseId || '');
            const leaseExpiresAt = Number(parsed.leaseExpiresAt) || 0;
            return {
                runId: id,
                ownerId,
                leaseId,
                leaseExpiresAt,
                owned: ownerId === storeWriterId,
                live: Boolean(ownerId) && leaseExpiresAt > Date.now()
            };
        } catch (_) {
            return null;
        }
    }

    /**
     * Destructive mutations must be fenced by the same cooperative storage
     * lease used to claim run owners. Merely checking controller state is not
     * sufficient: another window can claim an owner without changing the
     * project-store revision, leaving an already-open confirmation dialog stale.
     *
     * Unknown live run ids are treated as relevant. They can occur in the small
     * interval between claiming an execution owner and saving its run record.
     */
    function liveDestructiveOwner(folderId) {
        const scope = typeof folderId === 'string' && folderId ? folderId : '';
        const keys = [];
        try {
            for (let index = 0; index < window.localStorage.length; index += 1) {
                const key = window.localStorage.key(index);
                if (key && String(key).startsWith(RUN_OWNER_PREFIX)) keys.push(String(key));
            }
        } catch (_) {
            // If ownership state cannot be enumerated, fail closed. Destructive
            // operations can be retried after storage becomes readable.
            return { runId: '', live: true, unreadable: true };
        }
        for (const key of keys) {
            let runId = '';
            try { runId = decodeURIComponent(key.slice(RUN_OWNER_PREFIX.length)); } catch (_) { return { runId: '', live: true, unreadable: true }; }
            const owner = readRunOwner(runId);
            if (!owner || !owner.live) continue;
            if (!scope || runId === MODEL_OPERATION_OWNER_ID) return owner;
            const run = findRun(runId);
            if (!run || String(run.folderId || '') === scope) return owner;
        }
        return null;
    }

    function destructiveMutationAllowed(folderId) {
        return !liveDestructiveOwner(folderId);
    }

    function validateRunMutationUnderLease(runId, expectedLeaseId, running) {
        const id = String(runId || '').trim();
        const expected = String(expectedLeaseId || '');
        const owner = readRunOwner(id);
        if (expected) {
            if (!owner || !owner.owned || !owner.live || owner.leaseId !== expected) return false;
            window.localStorage.setItem(runOwnerKey(id), JSON.stringify({
                runId: id,
                ownerId: storeWriterId,
                leaseId: expected,
                leaseExpiresAt: Date.now() + PENDING_CANCEL_LEASE_MS
            }));
            const renewed = readRunOwner(id);
            return Boolean(renewed && renewed.owned && renewed.live
                && renewed.leaseId === expected);
        }
        // Running mutations always require a bound execution token. A detached
        // history object may update only while no live execution owns the id.
        return !running && !(owner && owner.live);
    }

    function claimRunOwnership(runId, options) {
        const id = String(runId || '').trim();
        if (!id) return false;
        const allowOwnedTakeover = !options || options.allowOwnedTakeover !== false;
        let lease = null;
        try {
            lease = acquireStoreWriteLease();
            if (!lease.ok) return false;
            const current = readRunOwner(id);
            if (current && current.live && (!current.owned || !allowOwnedTakeover)) return false;
            // Every acquisition receives a new fence, including re-entry from
            // this page. A newer local execution therefore invalidates stale
            // callbacks just as reliably as a takeover from another window.
            const leaseId = uid('run-lease');
            window.localStorage.setItem(runOwnerKey(id), JSON.stringify({
                runId: id,
                ownerId: storeWriterId,
                leaseId,
                leaseExpiresAt: Date.now() + PENDING_CANCEL_LEASE_MS
            }));
            const verified = readRunOwner(id);
            const claimed = Boolean(verified && verified.owned && verified.live && verified.leaseId === leaseId);
            if (claimed) {
                const run = store && Array.isArray(store.runs)
                    ? store.runs.find(item => item && String(item.id) === id)
                    : null;
                if (run) bindRunOwnership(run);
            }
            return claimed;
        } catch (error) {
            console.warn('[codalio-blueprint] unable to claim run ownership', error);
            return false;
        } finally {
            if (lease && lease.ok) releaseStoreWriteLease(lease);
        }
    }

    function refreshRunOwnership(runId, expectedLeaseId) {
        const id = String(runId || '').trim();
        const expected = String(expectedLeaseId || '');
        if (!id || !expected) return false;
        let lease = null;
        try {
            lease = acquireStoreWriteLease();
            if (!lease.ok) {
                const current = readRunOwner(id);
                return Boolean(current && current.owned && current.live
                    && current.leaseId === expected);
            }
            const current = readRunOwner(id);
            if (!current || !current.owned || !current.live || current.leaseId !== expected) return false;
            window.localStorage.setItem(runOwnerKey(id), JSON.stringify({
                runId: id,
                ownerId: storeWriterId,
                leaseId: current.leaseId,
                leaseExpiresAt: Date.now() + PENDING_CANCEL_LEASE_MS
            }));
            const verified = readRunOwner(id);
            return Boolean(verified && verified.owned && verified.live
                && verified.leaseId === current.leaseId);
        } catch (_) {
            return false;
        } finally {
            if (lease && lease.ok) releaseStoreWriteLease(lease);
        }
    }

    function releaseRunOwnership(runId, expectedLeaseId) {
        const id = String(runId || '').trim();
        if (!id) return false;
        let lease = null;
        try {
            lease = acquireStoreWriteLease();
            if (!lease.ok) return false;
            const current = readRunOwner(id);
            const expected = String(expectedLeaseId || '');
            if (current && (!current.owned || (expected && current.leaseId !== expected))) return false;
            window.localStorage.removeItem(runOwnerKey(id));
            const released = !readRunOwner(id);
            if (released) {
                const run = store.runs.find(item => item && String(item.id) === id);
                if (run && (!expected || run[RUN_LEASE_SYMBOL] === expected)) {
                    try { delete run[RUN_LEASE_SYMBOL]; } catch (_) { /* transient only */ }
                }
            }
            return released;
        } catch (_) {
            return false;
        } finally {
            if (lease && lease.ok) releaseStoreWriteLease(lease);
        }
    }

    function bindRunOwnership(run) {
        if (!run || !run.id) return '';
        const owner = readRunOwner(run.id);
        if (!owner || !owner.owned || !owner.live || !owner.leaseId) return '';
        try {
            Object.defineProperty(run, RUN_LEASE_SYMBOL, {
                value: owner.leaseId,
                configurable: true,
                enumerable: false,
                writable: false
            });
        } catch (_) {
            return '';
        }
        return owner.leaseId;
    }

    function runLeaseId(run) {
        return run && typeof run === 'object' ? String(run[RUN_LEASE_SYMBOL] || '') : '';
    }

    function expireOwnedPendingCancelLeases() {
        let lease = null;
        try {
            lease = acquireStoreWriteLease();
            if (!lease.ok) return;
            listPendingCancelRecords().forEach(snapshot => {
                if (snapshot.ownerId !== storeWriterId || !snapshot.leaseId) return;
                const record = readPendingCancelRecord(snapshot.key);
                if (!record || record.ownerId !== storeWriterId
                    || record.leaseId !== snapshot.leaseId) return;
                window.localStorage.setItem(record.key, JSON.stringify({
                    id: record.id,
                    ownerId: record.ownerId,
                    leaseId: record.leaseId,
                    runId: record.runId,
                    state: record.state,
                    createdAt: record.createdAt,
                    leaseExpiresAt: 0
                }));
            });
            const keys = [];
            for (let index = 0; index < window.localStorage.length; index += 1) {
                const key = window.localStorage.key(index);
                if (key && String(key).startsWith(RUN_OWNER_PREFIX)) keys.push(key);
            }
            keys.forEach(key => {
                const runId = decodeURIComponent(String(key).slice(RUN_OWNER_PREFIX.length));
                const owner = readRunOwner(runId);
                if (!owner || !owner.owned || !owner.leaseId) return;
                window.localStorage.setItem(key, JSON.stringify({
                    runId,
                    ownerId: storeWriterId,
                    leaseId: owner.leaseId,
                    leaseExpiresAt: 0
                }));
            });
        } catch (_) { /* natural expiry remains the fallback */ }
        finally {
            if (lease && lease.ok) releaseStoreWriteLease(lease);
        }
    }
    if (typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', expireOwnedPendingCancelLeases);
    }

    function storedFileEntries(folderId) {
        const scope = typeof folderId === 'string' && folderId ? folderId : '';
        return Object.keys(store.files)
            .map(key => ({ key, record: store.files[key] }))
            .filter(item => item.record && typeof item.record.content === 'string')
            .filter(item => !scope || item.record.folder === scope);
    }

    function cleanFilePath(path) {
        return String(path || '').replace(/^\/+/, '').trim();
    }

    function findFileEntry(path, folderId, allowFallback) {
        const cleanPath = cleanFilePath(path);
        if (!cleanPath) return null;
        const wantedFolder = typeof folderId === 'string' && folderId ? folderId : '';
        const matches = storedFileEntries().filter(item =>
            String(item.record.path || item.key) === cleanPath);
        if (wantedFolder) {
            const scoped = matches.find(item => item.record.folder === wantedFolder);
            if (scoped || allowFallback === false) return scoped || null;
        }
        // Falling back across roots is safe only while the path is globally
        // unique. Returning the first ambiguous match makes a caller mutate or
        // display whichever root happened to occupy the legacy storage key.
        return matches.length === 1 ? matches[0] : null;
    }

    function availableStorageKey(path, folderId) {
        const cleanPath = cleanFilePath(path);
        if (!store.files[cleanPath]) return cleanPath;
        const base = `${folderId}::${cleanPath}`;
        if (!store.files[base]) return base;
        let suffix = 2;
        while (store.files[`${base}::${suffix}`]) suffix += 1;
        return `${base}::${suffix}`;
    }

    /** Every stored document path, optionally scoped to one folder. */
    function listFiles(folderId) {
        return storedFileEntries(folderId)
            .map(item => String(item.record.path || item.key))
            .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    }

    function readFile(path, folderId) {
        const hasExplicitFolder = typeof folderId === 'string' && folderId;
        const wantedFolder = hasExplicitFolder
            ? folderId
            : (store.folders[store.activeFolderId] ? store.activeFolderId : '');
        const entry = findFileEntry(path, wantedFolder, !hasExplicitFolder);
        return entry ? entry.record : null;
    }

    /** Stable public identity for a file in a multi-root project. */
    function fileRef(path, folderId) {
        const cleanPath = cleanFilePath(path);
        const hasExplicitFolder = typeof folderId === 'string' && Boolean(folderId);
        if (hasExplicitFolder && !store.folders[folderId]) return null;
        const wantedFolder = hasExplicitFolder ? folderId : '';
        const entry = findFileEntry(cleanPath, wantedFolder, wantedFolder ? false : true);
        if (!entry) return null;
        return { path: String(entry.record.path || cleanPath), folderId: String(entry.record.folder || '') };
    }

    function fileRefKey(path, folderId) {
        const cleanPath = cleanFilePath(path);
        const cleanFolder = String(folderId || '');
        return `${encodeURIComponent(cleanFolder)}::${encodeURIComponent(cleanPath)}`;
    }

    const FILE_SNAPSHOT_FIELDS = Object.freeze([
        'path', 'content', 'createdAt', 'updatedAt', 'runId', 'skill',
        'folder', 'origin', 'createdBy'
    ]);

    /** Immutable record-level precondition for edit/delete confirmation dialogs. */
    function fileSnapshot(record) {
        if (!record || typeof record !== 'object') return null;
        const snapshot = {};
        FILE_SNAPSHOT_FIELDS.forEach(field => {
            snapshot[field] = String(record[field] === undefined ? '' : record[field]);
        });
        return snapshot;
    }

    function recordMatchesFileSnapshot(record, snapshot) {
        if (snapshot === null) return !record;
        if (!record || !snapshot || typeof snapshot !== 'object') return false;
        return FILE_SNAPSHOT_FIELDS.every(field => String(
            record[field] === undefined ? '' : record[field]
        ) === String(snapshot[field] === undefined ? '' : snapshot[field]));
    }

    function fileMatchesSnapshot(path, folderId, snapshot) {
        const wantedFolder = typeof folderId === 'string' && folderId ? folderId : '';
        const entry = findFileEntry(path, wantedFolder, false);
        return recordMatchesFileSnapshot(entry ? entry.record : null, snapshot);
    }

    function writeFile(path, content, meta) {
        const cleanPath = cleanFilePath(path);
        if (!cleanPath) return null;
        const mutationRunId = meta && typeof meta.runId === 'string' ? meta.runId : '';
        const mutationLeaseId = String((meta && meta.runLeaseId) || '');
        const requestedFolder = meta && typeof meta.folder === 'string' ? meta.folder : '';
        if (mutationRunId) {
            const owner = readRunOwner(mutationRunId);
            const mutationRun = findRun(mutationRunId);
            if (!owner || !owner.owned || !owner.live || !mutationLeaseId
                || owner.leaseId !== mutationLeaseId
                || !mutationRun || !requestedFolder
                || String(mutationRun.folderId || '') !== requestedFolder) {
                console.warn(`[codalio-blueprint] refusing stale run file write for ${mutationRunId}`);
                return null;
            }
        }
        // An async run/import carries an explicit root as an integrity boundary.
        // If that root vanished, never drift into whichever root is active now.
        if (requestedFolder && !store.folders[requestedFolder]) {
            console.warn(`[codalio-blueprint] refusing to write ${cleanPath}: project root ${requestedFolder} no longer exists`);
            return null;
        }
        const explicitFolder = requestedFolder;
        const activeFolderId = store.folders[store.activeFolderId]
            ? store.activeFolderId : DEFAULT_FOLDER_ID;
        let previousEntry = explicitFolder
            ? findFileEntry(cleanPath, explicitFolder, false)
            : findFileEntry(cleanPath, activeFolderId, false);
        // Preserve the historical edit contract: without an explicit folder, a
        // globally unique existing path is edited in place even if another root
        // is active. Explicit folder writes (imports and agent runs) can create
        // the same relative path independently in multiple roots.
        if (!previousEntry && !explicitFolder) {
            const matches = storedFileEntries().filter(item =>
                String(item.record.path || item.key) === cleanPath);
            if (matches.length === 1) previousEntry = matches[0];
        }
        const previous = previousEntry ? previousEntry.record : null;
        if (meta && hasOwn(meta, 'expectedFile')
            && !recordMatchesFileSnapshot(previous, meta.expectedFile)) {
            return null;
        }

        // Safety Policy:
        // Standalone project access can read and create files freely,
        // and edit/rewrite files it creates only.
        // User project files (origin === 'imported') are protected from in-place rewrites.
        if (previous && previous.origin === 'imported') {
            const isImportAction = Boolean(meta && meta.origin === 'imported');
            if (!isImportAction) {
                console.warn(`[codalio-blueprint] protected user source file: ${cleanPath}. Writing revision to docs/ instead.`);
                const lastSlash = cleanPath.lastIndexOf('/');
                const lastDot = cleanPath.lastIndexOf('.');
                const hasExtension = lastDot > lastSlash;
                const safeBase = cleanPath.startsWith('docs/')
                    ? `${hasExtension ? cleanPath.slice(0, lastDot) : cleanPath}.revised${hasExtension ? cleanPath.slice(lastDot) : '.md'}`
                    : `docs/${cleanPath}.revised.md`;
                const safePath = withCollisionHandling(safeBase, { overwriteExistingFile: 'version' }, previous.folder);
                return writeFile(safePath, content, Object.assign({}, meta, {
                    folder: previous.folder,
                    origin: 'blueprint',
                    createdBy: 'blueprint'
                }));
            }
        }

        const shouldPersist = !meta || meta.persist !== false;
        const previousOpenPath = store.openPath;
        const previousOpenFolderId = store.openFolderId;
        const now = new Date().toISOString();
        const inheritedFolder = (previous && typeof previous.folder === 'string' && store.folders[previous.folder])
            ? previous.folder
            : '';
        const folder = explicitFolder
            || inheritedFolder
            || activeFolderId;

        const origin = (meta && meta.origin)
            || (previous && previous.origin)
            || (cleanPath.startsWith('docs/') ? 'blueprint' : 'created');
        const createdBy = (meta && meta.createdBy)
            || (previous && previous.createdBy)
            || (origin === 'imported' ? 'user' : 'blueprint');

        const storageKey = previousEntry ? previousEntry.key : availableStorageKey(cleanPath, folder);
        const nextRecord = {
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
        const priorFolderUpdatedAt = store.folders[folder] && store.folders[folder].updatedAt;
        store.files[storageKey] = nextRecord;
        touchFolder(folder);
        store.openPath = cleanPath;
        store.openFolderId = folder;
        // Bulk callers (a folder import) pass persist:false and write the store
        // once at the end. Persisting here would JSON.stringify the ENTIRE store
        // per file, which is O(n^2): importing 255 files serialised the whole
        // project 255 times while it grew, and that was the import freeze.
        if (shouldPersist && !writeStore(store, mutationRunId ? {
            validateUnderLease: () => {
                const mutationRun = findRun(mutationRunId);
                return Boolean(mutationRun
                    && requestedFolder
                    && String(mutationRun.folderId || '') === requestedFolder
                    && validateRunMutationUnderLease(mutationRunId, mutationLeaseId, true));
            },
            preconditionCode: 'run-owner-lost',
            preconditionMessage: 'The file write lost its run execution lease or project-root owner before commit.'
        } : undefined)) {
            if (previousEntry) store.files[storageKey] = previous;
            else delete store.files[storageKey];
            if (store.folders[folder] && priorFolderUpdatedAt) {
                store.folders[folder].updatedAt = priorFolderUpdatedAt;
            }
            store.openPath = previousOpenPath;
            store.openFolderId = previousOpenFolderId;
            return null;
        }
        return nextRecord;
    }

    function isReadOnlyFile(path, folderId) {
        const rec = readFile(path, folderId);
        return Boolean(rec && rec.origin === 'imported');
    }

    function canEditFile(path, folderId) {
        const rec = readFile(path, folderId);
        if (!rec) return true;
        return rec.origin !== 'imported';
    }

    function deleteFile(path, folderId, expectedFile) {
        const wantedFolder = (typeof folderId === 'string' && folderId)
            ? folderId : (store.folders[store.activeFolderId] ? store.activeFolderId : '');
        const entry = findFileEntry(path, wantedFolder, false);
        if (!entry) return false;
        if (arguments.length >= 3 && !recordMatchesFileSnapshot(entry.record, expectedFile)) return false;
        const previousOpenPath = store.openPath;
        const previousOpenFolderId = store.openFolderId;
        delete store.files[entry.key];
        if (store.openPath === entry.record.path && store.openFolderId === entry.record.folder) {
            store.openPath = '';
            store.openFolderId = '';
        }
        if (!writeStore(store, {
            validateUnderLease: () => destructiveMutationAllowed(entry.record.folder),
            preconditionCode: 'operation-active',
            preconditionMessage: 'A Blueprint operation became active before the file deletion committed.'
        })) {
            store.files[entry.key] = entry.record;
            store.openPath = previousOpenPath;
            store.openFolderId = previousOpenFolderId;
            return false;
        }
        return true;
    }

    /** Delete every virtual file as one durable transaction. */
    function clearFiles() {
        const previousFiles = store.files;
        const previousOpenPath = store.openPath;
        const previousOpenFolderId = store.openFolderId;
        store.files = safeRecordMap();
        store.openPath = '';
        store.openFolderId = '';
        if (!writeStore(store, {
            validateUnderLease: () => destructiveMutationAllowed(),
            preconditionCode: 'operation-active',
            preconditionMessage: 'A Blueprint operation became active before all project files were cleared.'
        })) {
            store.files = previousFiles;
            store.openPath = previousOpenPath;
            store.openFolderId = previousOpenFolderId;
            return false;
        }
        return true;
    }

    function renameFile(fromPath, toPath, folderId, expectedFile) {
        const wantedFolder = (typeof folderId === 'string' && folderId)
            ? folderId : (store.folders[store.activeFolderId] ? store.activeFolderId : '');
        const entry = findFileEntry(fromPath, wantedFolder, false);
        if (!entry) return null;
        const snapshot = arguments.length >= 4 ? expectedFile : fileSnapshot(entry.record);
        // One atomic primitive owns every durable reference rewrite. Keeping a
        // second rename implementation here previously left run/review/message
        // handles pointing at the old path.
        return updateFile(fromPath, toPath, entry.record.content, wantedFolder, snapshot);
    }

    /**
     * Rename/move and edit one Blueprint-owned file as a single project-store
     * commit, including every durable run/review/message reference to its path.
     */
    function updateFile(fromPath, toPath, content, folderId, expectedFile) {
        const wantedFolder = (typeof folderId === 'string' && folderId)
            ? folderId : (store.folders[store.activeFolderId] ? store.activeFolderId : '');
        const entry = findFileEntry(fromPath, wantedFolder, false);
        if (!entry) return null;
        if (arguments.length >= 5 && !recordMatchesFileSnapshot(entry.record, expectedFile)) return null;
        const target = cleanFilePath(toPath);
        if (!target) return null;
        const record = entry.record;
        if (target !== record.path && findFileEntry(target, record.folder, false)) return null;
        const nextContent = String(content === undefined ? record.content : content);
        if (record.origin === 'imported' && nextContent !== record.content) return null;
        if (target === record.path && nextContent === record.content) return record;

        const before = clonePersistable(store);
        if (!before) return null;
        const originalOwners = new Set(storedFileEntries()
            .filter(item => item.record && item.record.path === record.path)
            .map(item => String(item.record.folder || ''))
            .filter(Boolean));
        const unambiguousOriginalOwner = originalOwners.size === 1 ? [...originalOwners][0] : '';
        const renamed = Object.assign({}, record, {
            path: target,
            content: nextContent,
            updatedAt: new Date().toISOString()
        });
        delete store.files[entry.key];
        store.files[availableStorageKey(target, record.folder)] = renamed;
        if (store.openPath === record.path && store.openFolderId === record.folder) {
            store.openPath = target;
        }
        touchFolder(record.folder);

        if (target !== record.path) {
            const replaceRefs = (holder, inheritedOwner) => {
                if (!holder || typeof holder !== 'object') return;
                const holderOwner = String(holder.folderId || inheritedOwner || '');
                if (Array.isArray(holder.writtenFiles)) {
                    holder.writtenFiles.forEach(ref => {
                        if (!ref || ref.path !== record.path) return;
                        const refOwner = String(ref.folderId || holderOwner || unambiguousOriginalOwner);
                        if (refOwner === record.folder) {
                            ref.path = target;
                            ref.folderId = record.folder;
                        }
                    });
                }
                if (String(holderOwner || unambiguousOriginalOwner) === record.folder) {
                    ['writtenPaths', 'paths'].forEach(key => {
                        if (Array.isArray(holder[key])) {
                            holder[key] = holder[key].map(item => item === record.path ? target : item);
                        }
                    });
                }
                if (holder.targetPath === record.path
                    && String(holder.targetFolderId || holderOwner || unambiguousOriginalOwner) === record.folder) {
                    holder.targetPath = target;
                }
                (Array.isArray(holder.reviews) ? holder.reviews : []).forEach(review => {
                    if (review && review.path === record.path
                        && String(review.folderId || holderOwner || unambiguousOriginalOwner) === record.folder) {
                        review.path = target;
                        review.folderId = record.folder;
                    }
                });
                (Array.isArray(holder.phases) ? holder.phases : []).forEach(step => {
                    if (step && step.reviewPath === record.path
                        && String(step.reviewFolderId || holderOwner || unambiguousOriginalOwner) === record.folder) {
                        step.reviewPath = target;
                        step.reviewFolderId = record.folder;
                    }
                });
            };
            store.runs.forEach(run => {
                const runOwner = String((run && run.folderId) || '');
                replaceRefs(run, runOwner);
                (Array.isArray(run && run.messages) ? run.messages : [])
                    .forEach(message => replaceRefs(message, runOwner));
            });
        }

        if (!writeStore(store, {
            validateUnderLease: () => destructiveMutationAllowed(record.folder),
            preconditionCode: 'operation-active',
            preconditionMessage: 'A Blueprint operation became active before the file update committed.'
        })) {
            assignStoreState(before);
            knownStoreRevision = store.revision;
            knownStoreCommitId = store.commitId;
            return null;
        }
        return renamed;
    }

    function setOpenPath(path, folderId) {
        const cleanPath = cleanFilePath(path);
        const previousOpenPath = store.openPath;
        const previousOpenFolderId = store.openFolderId;
        if (!cleanPath) {
            store.openPath = '';
            store.openFolderId = '';
            if (!writeStore(store)) {
                store.openPath = previousOpenPath;
                store.openFolderId = previousOpenFolderId;
                return false;
            }
            return true;
        }
        const hasExplicitFolder = typeof folderId === 'string' && Boolean(folderId);
        if (hasExplicitFolder && !store.folders[folderId]) {
            return false;
        }
        const explicitFolder = hasExplicitFolder ? folderId : '';
        const entry = findFileEntry(cleanPath, explicitFolder || store.activeFolderId, !explicitFolder);
        // Never persist a phantom or ambiguous selection. A stale host snapshot
        // can outlive a deleted file, and two roots may legitimately share path.
        store.openPath = entry ? cleanPath : '';
        store.openFolderId = entry ? String(entry.record.folder || '') : '';
        if (!writeStore(store)) {
            store.openPath = previousOpenPath;
            store.openFolderId = previousOpenFolderId;
            return false;
        }
        return Boolean(entry);
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

    function folderSnapshot(folderId) {
        const folder = getFolder(String(folderId || ''));
        if (!folder) return null;
        return {
            id: String(folder.id || folderId || ''),
            name: String(folder.name || ''),
            updatedAt: String(folder.updatedAt || ''),
            revision: Number(store.revision) || 0,
            commitId: String(store.commitId || ''),
            files: storedFileEntries(folder.id)
                .map(item => `${String(item.record.path || item.key)}\u0000${String(item.record.updatedAt || '')}\u0000${String(item.record.content || '').length}`)
                .sort()
        };
    }

    function folderMatchesSnapshot(folderId, snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return false;
        const current = folderSnapshot(folderId);
        return Boolean(current)
            && current.id === String(snapshot.id || '')
            && current.name === String(snapshot.name || '')
            && current.updatedAt === String(snapshot.updatedAt || '')
            && current.revision === Number(snapshot.revision)
            && current.commitId === String(snapshot.commitId || '')
            && JSON.stringify(current.files) === JSON.stringify(Array.isArray(snapshot.files) ? snapshot.files : []);
    }

    function setActiveFolder(folderId) {
        if (!store.folders[folderId]) return null;
        const previous = store.activeFolderId;
        const previousActiveRunId = store.activeRunId;
        store.activeFolderId = folderId;
        const selectedRun = findRun(store.activeRunId);
        if (selectedRun && String(selectedRun.folderId || '') !== String(folderId)) {
            store.activeRunId = '';
        }
        if (!writeStore(store)) {
            store.activeFolderId = previous;
            store.activeRunId = previousActiveRunId;
            return null;
        }
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
        const previousActiveFolderId = store.activeFolderId;
        const previousActiveRunId = store.activeRunId;
        store.folders[id] = folder;
        store.activeFolderId = id;
        // A newly-created project root has no run context. Keeping the prior
        // root's active run selected leaks its transcript/compaction across the
        // project boundary and leaves the persisted selection internally split.
        store.activeRunId = '';
        if (!writeStore(store)) {
            delete store.folders[id];
            store.activeFolderId = previousActiveFolderId;
            store.activeRunId = previousActiveRunId;
            return {
                folder: null,
                error: `The folder could not be saved (${persistence.lastError || 'browser storage unavailable'}).`
            };
        }
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
    function renameFolder(folderId, name, expectedFolder) {
        const folder = store.folders[folderId];
        if (!folder) return { folder: null, error: 'That folder no longer exists.' };
        if (arguments.length >= 3 && !folderMatchesSnapshot(folderId, expectedFolder)) {
            return { folder: null, error: 'That folder changed after this dialog opened. Reopen it before renaming.' };
        }
        if (folderId === DEFAULT_FOLDER_ID) {
            return { folder: null, error: 'The default project folder cannot be renamed.' };
        }
        const wanted = String(name || '').trim().replace(/\s+/g, ' ');
        if (!wanted) return { folder: null, error: 'Give the folder a name.' };
        if (wanted.length > 80) return { folder: null, error: 'Folder names are limited to 80 characters.' };
        const clash = listFolders().some(other => other.id !== folderId
            && other.name.toLowerCase() === wanted.toLowerCase());
        if (clash) return { folder: null, error: `A folder named "${wanted}" already exists.` };
        const previousName = folder.name;
        const previousUpdatedAt = folder.updatedAt;
        folder.name = wanted;
        touchFolder(folderId);
        if (!writeStore(store)) {
            folder.name = previousName;
            folder.updatedAt = previousUpdatedAt;
            return { folder: null, error: `The folder rename could not be saved (${persistence.lastError || 'browser storage unavailable'}).` };
        }
        return { folder, error: '' };
    }

    /**
     * Delete a folder and its documents. The default folder cannot be deleted —
     * it is where unfiled work lives, and removing it would orphan documents.
     * Returns the deleted document count so the UI can say what happened.
     */
    function deleteFolder(folderId, expectedFolder) {
        const folder = store.folders[folderId];
        if (!folder) return { deleted: false, count: 0, error: 'That folder no longer exists.' };
        if (arguments.length >= 2 && !folderMatchesSnapshot(folderId, expectedFolder)) {
            return { deleted: false, count: 0, error: 'That folder changed after this dialog opened. Reopen it before deleting.' };
        }
        if (folderId === DEFAULT_FOLDER_ID) {
            return { deleted: false, count: 0, error: 'The default project folder cannot be deleted.' };
        }
        const doomed = listFiles(folderId);
        const deletedOpenFile = store.openFolderId === folderId;
        const doomedEntries = storedFileEntries(folderId);
        const previousActiveFolderId = store.activeFolderId;
        const previousActiveRunId = store.activeRunId;
        const previousOpenPath = store.openPath;
        const previousOpenFolderId = store.openFolderId;
        doomedEntries.forEach(item => { delete store.files[item.key]; });
        delete store.folders[folderId];
        if (store.activeFolderId === folderId) store.activeFolderId = DEFAULT_FOLDER_ID;
        const selectedRun = findRun(store.activeRunId);
        if (selectedRun && String(selectedRun.folderId || '') === String(folderId)) {
            store.activeRunId = '';
        }
        if (deletedOpenFile) {
            store.openPath = '';
            store.openFolderId = '';
        }
        if (!writeStore(store, {
            validateUnderLease: () => destructiveMutationAllowed(folderId),
            preconditionCode: 'operation-active',
            preconditionMessage: 'A Blueprint operation became active in this project before its deletion committed.'
        })) {
            store.folders[folderId] = folder;
            doomedEntries.forEach(item => { store.files[item.key] = item.record; });
            store.activeFolderId = previousActiveFolderId;
            store.activeRunId = previousActiveRunId;
            store.openPath = previousOpenPath;
            store.openFolderId = previousOpenFolderId;
            return { deleted: false, count: 0, error: `The folder deletion could not be saved (${persistence.lastError || 'browser storage unavailable'}).` };
        }
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

    const SENSITIVE_SOURCE_DIRS = new Set([
        '.aws', '.azure', '.gnupg', '.ssh', '.kube', '.docker', '.terraform',
        '.git', '.hg', '.svn'
    ]);
    const SAFE_EXTENSIONLESS_SOURCE_NAMES = new Set([
        'dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile', 'vagrantfile',
        'license', 'readme', 'changelog', '.gitignore', '.dockerignore', '.editorconfig'
    ]);

    /** High-confidence credential paths that must never enter model context. */
    function isSensitiveSourcePath(path) {
        const normalized = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
        const parts = normalized.split('/').filter(Boolean);
        const base = parts[parts.length - 1] || '';
        if (parts.some(part => SENSITIVE_SOURCE_DIRS.has(part))) return true;
        if (base === '.env' || (base.startsWith('.env.')
            && !/\.(example|sample|template|dist)$/.test(base))) return true;
        if (['.npmrc', '.pypirc', '.netrc', '.dockercfg', 'id_rsa', 'id_dsa', 'id_ed25519',
            'credentials', 'credentials.json', 'service-account.json'].includes(base)) return true;
        if (/^(?:secrets?|credentials?|service[-_]?account|firebase[-_]?adminsdk)(?:\.|-|_)/.test(base)) return true;
        if (/\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/.test(base)) return true;
        return false;
    }

    /**
     * Redact high-confidence inline secrets at the final model boundary. This is
     * deliberately conservative: it preserves source structure while reducing
     * the chance that a token pasted into an ordinary config/source file is sent.
     * This is defense in depth, not a substitute for keeping secrets out of the
     * imported project in the first place.
     */
    function sanitizeSourceForModel(value) {
        let content = String(value || '');
        let redactions = 0;
        const replace = (pattern, replacer) => {
            content = content.replace(pattern, (...args) => {
                redactions += 1;
                return typeof replacer === 'function' ? replacer(...args) : replacer;
            });
        };
        replace(/-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY-----[\s\S]*?-----END (?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY-----/gi,
            '[REDACTED_PRIVATE_KEY]');
        replace(/-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?-----END PGP PRIVATE KEY BLOCK-----/gi,
            '[REDACTED_PRIVATE_KEY]');
        replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
            '[REDACTED_SECRET]');
        replace(/\b(?:xox[baprs]-[A-Za-z0-9-]{12,}|(?:sk|rk)_live_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g,
            '[REDACTED_SECRET]');
        replace(/\b(?:hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|whsec_[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{24,}|pypi-[A-Za-z0-9_-]{24,})\b/g,
            '[REDACTED_SECRET]');
        replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}\b/g,
            '[REDACTED_SECRET]');
        replace(/\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{25,40})\b/g,
            '[REDACTED_SECRET]');
        replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
            '[REDACTED_JWT]');
        replace(/\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi,
            (_match, prefix) => `${prefix}[REDACTED_SECRET]`);
        replace(/\b(Authorization\s*:\s*Basic\s+)[A-Za-z0-9+/=]{8,}/gi,
            (_match, prefix) => `${prefix}[REDACTED_SECRET]`);
        replace(/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret)["']?\s*[:=]\s*)(["'])([^\r\n"']{6,})(\2)/gi,
            (_match, prefix, quote) => `${prefix}${quote}[REDACTED_SECRET]${quote}`);
        replace(/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret)["']?\s*[:=]\s*)([^\s,;}"']{6,})/gi,
            (_match, prefix) => `${prefix}[REDACTED_SECRET]`);
        replace(/(["']?(?:[a-z][a-z0-9]*[_-])*(?:key|token|secret|password|passwd)["']?\s*[:=]\s*)(["'])([^\r\n"']{6,})(\2)/gi,
            (_match, prefix, quote) => `${prefix}${quote}[REDACTED_SECRET]${quote}`);
        replace(/(["']?(?:[a-z][a-z0-9]*[_-])*(?:key|token|secret|password|passwd)["']?\s*[:=]\s*)([^\s,;}"']{6,})/gi,
            (_match, prefix) => `${prefix}[REDACTED_SECRET]`);
        replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
            (_match, prefix, suffix) => `${prefix}[REDACTED_SECRET]${suffix}`);
        replace(/(--(?:password|passwd|api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|private[-_]?key|secret)(?:\s+|=))(["'])([^\r\n"']{6,})(\2)/gi,
            (_match, prefix, quote) => `${prefix}${quote}[REDACTED_SECRET]${quote}`);
        replace(/(--(?:password|passwd|api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|private[-_]?key|secret)(?:\s+|=))([^\s,;"']{6,})/gi,
            (_match, prefix) => `${prefix}[REDACTED_SECRET]`);
        replace(/(<((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret))\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
            (_match, open, _tag, body, close) => body.trim()
                ? `${open}[REDACTED_SECRET]${close}` : _match);

        // Unknown token families still tend to be long, quoted, mixed-alphabet
        // strings. Use entropy as a final conservative net, while deliberately
        // leaving ordinary hashes, UUIDs, prose, and identifiers alone.
        const entropyOf = token => {
            const counts = new Map();
            for (const char of token) counts.set(char, (counts.get(char) || 0) + 1);
            let entropy = 0;
            counts.forEach(count => {
                const probability = count / token.length;
                entropy -= probability * Math.log2(probability);
            });
            return entropy;
        };
        content = content.replace(/(["'`])([A-Za-z0-9+\/_=-]{32,})(\1)/g,
            (match, quote, token) => {
                if (/^[a-f0-9]+$/i.test(token) || /^[0-9a-f-]{32,}$/i.test(token)) return match;
                const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[+\/_=-]/]
                    .filter(pattern => pattern.test(token)).length;
                if (classes < 3 || entropyOf(token) < 3.75) return match;
                redactions += 1;
                return `${quote}[REDACTED_HIGH_ENTROPY_SECRET]${quote}`;
            });
        return { content, redactions };
    }

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
        const parts = String(relativePath || '').split('/').map(part => part.toLowerCase());
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
            maxTotalKb: 2048,
            skipBinary: true,
            incompleteReason: ''
        }, options || {});
        const upstreamIncompleteReason = clampText(String(cfg.incompleteReason || '').trim(), 500);

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
            scanIncomplete: Boolean(upstreamIncompleteReason),
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
        const openFolderBeforeImport = store.openFolderId;
        const activeFolderBeforeImport = store.activeFolderId;
        const storeBeforeImport = clonePersistable(store);
        if (!storeBeforeImport) {
            result.error = 'The current project could not be snapshotted safely before import.';
            return result;
        }
        const created = createFolder(folderName || suggestedFolderName(list), 'imported');
        if (created.error) {
            result.error = created.error;
            return result;
        }
        result.folder = created.folder;

        try {

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
        const importedPaths = new Set();

        const rollbackCancelledImport = () => {
            const folderId = result.folder && result.folder.id;
            const importedBeforeRollback = result.imported.length;
            const partialBeforeRollback = clonePersistable(store);
            if (!partialBeforeRollback) return false;
            if (folderId) {
                storedFileEntries(folderId).forEach(item => { delete store.files[item.key]; });
                delete store.folders[folderId];
            }
            store.activeFolderId = store.folders[activeFolderBeforeImport]
                ? activeFolderBeforeImport : DEFAULT_FOLDER_ID;
            store.openPath = openPathBeforeImport;
            store.openFolderId = openFolderBeforeImport;
            const persisted = writeStore(store);
            result.rolledBack = persisted;
            result.partialImported = importedBeforeRollback;
            if (persisted) {
                result.imported = [];
                result.persisted = 0;
                return true;
            }

            // The attempted deletion existed only in memory. Reconcile from the
            // durable winner before returning so a later save cannot erase the
            // successfully persisted partial import by accident.
            const reloaded = reloadStoreFromStorage();
            if (!reloaded) {
                assignStoreState(partialBeforeRollback);
                knownStoreRevision = store.revision;
                knownStoreCommitId = store.commitId;
            }
            const survived = new Set(folderId
                ? storedFileEntries(folderId).map(item => String(item.record.path || item.key))
                : []);
            result.imported = result.imported.filter(item => survived.has(item.path));
            result.persisted = result.imported.length;
            return persisted;
        };

        const assertImportActive = () => {
            if (cfg.signal && cfg.signal.aborted) {
                const rolledBack = rollbackCancelledImport();
                const error = new BlueprintAbort(rolledBack
                    ? 'Folder import was cancelled and its partial project was removed.'
                    : 'Folder import was cancelled, but its partial project could not be removed from storage. Reload before continuing.');
                error.rolledBack = rolledBack;
                error.partialImported = result.partialImported;
                throw error;
            }
            if (result.folder && !store.folders[result.folder.id]) {
                const error = new Error('The destination project root was removed while the folder import was running.');
                error.code = 'project-root-missing';
                throw error;
            }
        };

        // ---- chunked persistence -------------------------------------------
        // The previous shape wrote the whole store ONCE at the end. For a large
        // import that is a single synchronous JSON.stringify + setItem of
            // everything -- the freeze -- and once the origin quota is reached it throws
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
        const persistChunk = finalizing => {
            sincePersist = 0;
            const destination = result.folder && store.folders[result.folder.id];
            if (destination) {
                destination.importedCount = result.imported.length;
                if (!finalizing && destination.importState !== 'incomplete') destination.importState = 'importing';
                touchFolder(destination.id);
            }
            if (writeStore(store)) {
                result.persisted = result.imported.length;
                return true;
            }
            // localStorage refused the write. Reload only through the guarded
            // candidate path: malformed bytes must not replace the last good live
            // snapshot, and an external deletion must never be reinterpreted as a
            // quota failure with a phantom folder.
            const failureCode = String(persistence.lastCode || 'storage-write-failed');
            const reloaded = reloadStoreFromStorage();
            if (!reloaded) {
                assignStoreState(storeBeforeImport);
                knownStoreRevision = store.revision;
                knownStoreCommitId = store.commitId;
            }
            if (['concurrent-update', 'store-busy', 'external-reset', 'corrupt-store'].includes(failureCode)) {
                const descriptions = {
                    'store-busy': 'Another Blueprint window is saving project data. Wait for it to finish, then import again.',
                    'concurrent-update': 'Project data changed in another window during import. Reload and import again.',
                    'external-reset': 'Project data was erased in another window during import. The stale partial import was discarded.',
                    'corrupt-store': 'Project data from another window is malformed. The last good project remains available for export, but saving is blocked.'
                };
                const error = new BlueprintModelError(descriptions[failureCode], {
                    code: failureCode,
                    retryable: failureCode === 'store-busy'
                });
                throw error;
            }
            // Keep only the imports that genuinely survived, then recount, so
            // `persisted` never includes rolled-back files.
            const folderId = result.folder && result.folder.id;
            const survived = new Set(folderId
                ? storedFileEntries(folderId).map(item => String(item.record.path || item.key))
                : []);
            result.imported = result.imported.filter(item => survived.has(item.path));
            result.persisted = result.imported.length;
            result.storageFull = true;
            return false;
        };

        let sinceYield = 0;
        for (let index = 0; index < list.length; index += 1) {
            assertImportActive();
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
                assertImportActive();
            }

            const file = list[index];
            const relativePath = relativePathOf(file);
            if (!relativePath) continue;

            if (isSkippedPath(relativePath)) {
                noteSkip(relativePath, 'ignored directory');
                continue;
            }
            if (isSensitiveSourcePath(relativePath)) {
                noteSkip(relativePath, 'sensitive credential file');
                continue;
            }
            const ext = extensionOf(relativePath);
            const baseName = relativePath.split('/').pop().toLowerCase();
            const safeExtensionless = !ext && SAFE_EXTENSIONLESS_SOURCE_NAMES.has(baseName);
            const safeEnvironmentTemplate = /^\.env\.(?:example|sample|template|dist)$/.test(baseName);
            if ((!ext && !safeExtensionless)
                || (ext && !safeEnvironmentTemplate && IMPORTABLE_EXTENSIONS.indexOf(ext) < 0)) {
                noteSkip(relativePath, ext ? `unsupported type .${ext}` : 'unsupported extensionless file');
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
                content = await readAsText(file, cfg.signal, cfg.fileReadTimeoutMs);
                assertImportActive();
            } catch (error) {
                // Signal-driven read cancellation must pass through the central
                // import abort path so partial files and the temporary root are
                // rolled back before the rejection escapes.
                if (cfg.signal && cfg.signal.aborted) assertImportActive();
                if (error && error.code === 'project-root-missing') throw error;
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
            const storedPath = canonicalImportPath(relativePath);
            if (!storedPath) {
                noteSkip(relativePath, 'unsafe or empty path');
                continue;
            }
            if (importedPaths.has(storedPath)
                || findFileEntry(storedPath, result.folder.id, false)) {
                noteSkip(relativePath, `canonical path collision (${storedPath})`);
                continue;
            }
            const written = writeFile(storedPath, content, {
                folder: result.folder.id,
                origin: 'imported',
                persist: false,
                expectedFile: null
            });
            if (!written) {
                assertImportActive();
                noteSkip(relativePath, 'could not be stored');
                continue;
            }
            totalBytes += size;
            importedPaths.add(written.path);
            result.imported.push({ path: written.path, folderId: result.folder.id, bytes: size });

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
        const lastImported = result.imported[result.imported.length - 1];
        if (!lastImported || (store.openFolderId === result.folder.id && store.openPath === lastImported.path)) {
            store.openPath = openPathBeforeImport;
            store.openFolderId = openFolderBeforeImport;
        }

        const destination = result.folder && store.folders[result.folder.id];
        if (destination) {
            destination.importedCount = result.imported.length;
            destination.importState = result.storageFull || result.truncatedByBudget
                || result.scanIncomplete
                ? 'incomplete' : 'complete';
            destination.importError = result.storageFull
                ? 'Browser storage filled before every selected file could be imported.'
                : result.truncatedByBudget
                    ? 'The configured import budget was reached before every selected file was examined.'
                    : upstreamIncompleteReason;
            result.folder = destination;
        }
        // Flush the trailing partial chunk. openPath changed even if there is
        // nothing new to write, so the store is persisted either way.
        persistChunk(true);
        result.folder = (result.folder && store.folders[result.folder.id]) || result.folder;
        result.incomplete = Boolean(result.folder && result.folder.importState === 'incomplete');
        return result;
        } catch (error) {
            const code = String((error && error.code) || persistence.lastCode || 'import-failed');
            if (!(code === 'aborted' && error && error.rolledBack === true)) {
                const destination = result.folder && store.folders[result.folder.id];
                if (destination) {
                    destination.importState = 'incomplete';
                    destination.importedCount = storedFileEntries(destination.id).length;
                    destination.importError = clampText(
                        String((error && error.message) || 'The folder import stopped unexpectedly.'), 500);
                    if (!writeStore(store)) {
                        const reloaded = reloadStoreFromStorage();
                        if (!reloaded) {
                            assignStoreState(storeBeforeImport);
                            knownStoreRevision = store.revision;
                            knownStoreCommitId = store.commitId;
                        }
                    }
                }
            }
            throw error;
        }
    }

    function stripLeadingDirectory(relativePath) {
        const parts = relativePath.split('/');
        if (parts.length <= 1) return relativePath;
        return parts.slice(1).join('/');
    }

    function canonicalImportPath(relativePath) {
        const raw = stripLeadingDirectory(String(relativePath || '').replace(/\\/g, '/'));
        const parts = [];
        for (const value of raw.split('/')) {
            const segment = value.trim();
            if (!segment || segment === '.') continue;
            if (segment === '..' || /[\u0000-\u001f\u007f]/.test(segment)) return '';
            parts.push(segment);
        }
        return cleanFilePath(parts.join('/'));
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
        const cfg = Object.assign({
            onProgress: null,
            maxFiles: 10000,
            maxEntries: 50000,
            operationTimeoutMs: 30000,
            scanTimeoutMs: 120000
        }, options || {});
        const maxFiles = Number.isFinite(Number(cfg.maxFiles))
            ? Math.max(1, Math.min(50000, Math.floor(Number(cfg.maxFiles)))) : 10000;
        const maxEntries = Number.isFinite(Number(cfg.maxEntries))
            ? Math.max(1, Math.min(200000, Math.floor(Number(cfg.maxEntries)))) : 50000;
        const operationTimeoutMs = Number.isFinite(Number(cfg.operationTimeoutMs))
            ? Math.max(1, Math.min(120000, Number(cfg.operationTimeoutMs))) : 30000;
        const scanTimeoutMs = Number.isFinite(Number(cfg.scanTimeoutMs))
            ? Math.max(50, Math.min(600000, Number(cfg.scanTimeoutMs))) : 120000;
        const scanDeadline = Date.now() + scanTimeoutMs;
        const out = {
            files: [],
            prunedDirs: 0,
            unreadable: 0,
            lockedDirs: 0,
            lockedSample: [],
            truncated: false,
            maxFiles,
            maxEntries,
            scannedEntries: 0,
            entryLimitReached: false,
            deadlineReached: false,
            scanTimeoutMs,
            error: ''
        };
        // Symlink/junction loops would recurse forever; cap depth well past any
        // real project tree.
        const MAX_DEPTH = 64;
        const MAX_LOCKED_SAMPLE = 10;
        const assertScanActive = () => {
            if (cfg.signal && cfg.signal.aborted) {
                throw new BlueprintAbort('Folder scan was cancelled.');
            }
            if (Date.now() >= scanDeadline) {
                out.truncated = true;
                out.deadlineReached = true;
                const error = new Error('The folder scan reached its total time budget.');
                error.code = 'scan-budget';
                throw error;
            }
        };
        const awaitScanOperation = (operation, label) => new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                if (cfg.signal && typeof cfg.signal.removeEventListener === 'function') {
                    cfg.signal.removeEventListener('abort', onAbort);
                }
            };
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn(value);
            };
            const onAbort = () => finish(reject, new BlueprintAbort('Folder scan was cancelled.'));
            if (cfg.signal && cfg.signal.aborted) {
                onAbort();
                return;
            }
            if (cfg.signal && typeof cfg.signal.addEventListener === 'function') {
                cfg.signal.addEventListener('abort', onAbort, { once: true });
            }
            const remainingMs = Math.max(1, scanDeadline - Date.now());
            const timeoutMs = Math.min(operationTimeoutMs, remainingMs);
            timer = setTimeout(() => {
                const hitDeadline = timeoutMs >= remainingMs;
                if (hitDeadline) {
                    out.truncated = true;
                    out.deadlineReached = true;
                }
                const error = new Error(hitDeadline
                    ? 'The folder scan reached its total time budget.'
                    : `${label} exceeded ${Math.round(operationTimeoutMs / 1000)} seconds`);
                error.code = hitDeadline ? 'scan-budget' : 'scan-timeout';
                finish(reject, error);
            }, timeoutMs);
            Promise.resolve(operation).then(
                value => finish(resolve, value),
                error => finish(reject, error)
            );
        });

        if (!rootHandle || typeof rootHandle.values !== 'function') {
            out.error = 'The picked directory could not be read.';
            return out;
        }

        async function walk(dirHandle, prefix, depth) {
            assertScanActive();
            if (depth > MAX_DEPTH || out.truncated) return out.truncated;
            let sinceYield = 0;
            let iterator = null;
            try {
                const iterable = dirHandle.values();
                iterator = iterable && typeof iterable[Symbol.asyncIterator] === 'function'
                    ? iterable[Symbol.asyncIterator]() : null;
                if (!iterator || typeof iterator.next !== 'function') {
                    throw new Error('directory iterator is unavailable');
                }
                while (!out.truncated) {
                    const next = await awaitScanOperation(iterator.next(), 'directory listing');
                    if (!next || next.done) break;
                    const entry = next.value;
                    assertScanActive();
                    if (out.scannedEntries >= maxEntries) {
                        out.truncated = true;
                        out.entryLimitReached = true;
                        break;
                    }
                    out.scannedEntries += 1;
                    // Same repaint trick the importer uses: a directory listing
                    // can be long, and the scan must not freeze the page.
                    sinceYield += 1;
                    if (sinceYield >= 40) {
                        sinceYield = 0;
                        if (typeof cfg.onProgress === 'function') {
                            cfg.onProgress(out.files.length);
                        }
                        await new Promise(resolve => setTimeout(resolve, 0));
                        assertScanActive();
                    }

                    const name = String((entry && entry.name) || '');
                    if (!name) continue;
                    const relativePath = prefix + name;

                    if (entry.kind === 'directory') {
                        if (IMPORT_SKIP_DIRS.indexOf(name.toLowerCase()) >= 0) {
                            out.prunedDirs += 1;
                            continue;
                        }
                        if (await walk(entry, relativePath + '/', depth + 1)) break;
                    } else if (entry.kind === 'file') {
                        if (out.files.length >= maxFiles) {
                            out.truncated = true;
                            break;
                        }
                        // getFile() rejects when the OS file vanished or is
                        // exclusively locked; one such file must not abort the
                        // scan — importFolder() reports per-file failures the
                        // same way for the input path.
                        try {
                            const file = await awaitScanOperation(entry.getFile(), 'file metadata read');
                            assertScanActive();
                            file.relativePath = relativePath;
                            out.files.push(file);
                        } catch (_) {
                            out.unreadable += 1;
                        }
                    }
                }
                return out.truncated;
            } catch (error) {
                if (error && error.code === 'aborted') throw error;
                if (error && error.code === 'scan-budget') return true;
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
                return out.truncated;
            } finally {
                if (out.truncated && iterator && typeof iterator.return === 'function') {
                    try {
                        const closing = iterator.return();
                        if (closing && typeof closing.catch === 'function') closing.catch(() => {});
                    } catch (_) { /* iterator cleanup is best-effort */ }
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

    /** Read a File/Blob as UTF-8 text without letting one OS read wedge the app. */
    function readAsText(file, signal, timeoutMs) {
        return new Promise((resolve, reject) => {
            let reader = null;
            let settled = false;
            const limit = Number.isFinite(Number(timeoutMs))
                ? Math.max(1, Math.min(120000, Number(timeoutMs))) : 30000;
            let timer = null;
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                if (signal && typeof signal.removeEventListener === 'function') {
                    signal.removeEventListener('abort', onAbort);
                }
            };
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn(value);
            };
            const onAbort = () => {
                if (reader && typeof reader.abort === 'function') {
                    try { reader.abort(); } catch (_) { /* already completed */ }
                }
                finish(reject, new BlueprintAbort('Folder import was cancelled while reading a file.'));
            };
            if (signal && signal.aborted) {
                onAbort();
                return;
            }
            if (signal && typeof signal.addEventListener === 'function') {
                signal.addEventListener('abort', onAbort, { once: true });
            }
            timer = setTimeout(() => {
                if (reader && typeof reader.abort === 'function') {
                    try { reader.abort(); } catch (_) { /* already completed */ }
                }
                const error = new Error(`file read exceeded ${Math.round(limit / 1000)} seconds`);
                error.code = 'file-read-timeout';
                finish(reject, error);
            }, limit);
            try {
                if (file && typeof file.text === 'function') {
                    Promise.resolve(file.text()).then(
                        value => finish(resolve, String(value || '')),
                        error => finish(reject, error)
                    );
                    return;
                }
                reader = new FileReader();
                reader.onload = () => finish(resolve, String(reader.result || ''));
                reader.onerror = () => finish(reject, reader.error || new Error('read failed'));
                reader.onabort = () => {
                    if (!settled) finish(reject, new BlueprintAbort('Folder import file read was aborted.'));
                };
                reader.readAsText(file);
            } catch (error) {
                finish(reject, error);
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

    /** Text formats whose bodies can provide implementation/config evidence. */
    const IMPLEMENTATION_EXTENSIONS = CODE_EXTENSIONS.concat([
        'css', 'scss', 'sass', 'less', 'html', 'htm', 'json', 'jsonc',
        'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'properties'
    ]);

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
     * Tier 1 (structural, ~62% of budget): first-party files are digested while
     * room remains. Oversized projects degrade low-value entries to named stubs
     * and, if necessary, disclose omitted paths rather than overrunning context.
     * Adaptive depth spends the remaining Tier-1 room on the highest-scoring
     * files; if Tier 1 overflows, the LOWEST-scoring files degrade to a
     * one-line stub rather than being dropped, keeping coverage total.
     *
     * Tier 2 (verbatim, the rest): full text of the highest-scoring CODE files
     * that fit. Normally restricted to code and to files >= 40 lines, because in
     * calibration an unrestricted Tier 2 spent 32% of the whole budget on two
     * HTML files while the file that actually explained the system (router.py)
     * could never fit. If that would leave the model with signatures only, one
     * high-value implementation is sent in full or as a clearly marked excerpt.
     *
     * Returns { digestText, fullTextFiles, tokens, coverage, trimmed, deepened,
     * excluded, files } — `files` carries per-file digests for the UI to show
     * what the model was given.
     */
    function buildCodebaseDigest(records, options) {
        const cfg = Object.assign({ budgetTokens: 16000, minFullTextLines: 40 }, options || {});
        const budget = Math.max(512, Number(cfg.budgetTokens) || 16000);
        const minLines = Math.max(1, Number(cfg.minFullTextLines) || 40);
        const priorityPaths = new Set((Array.isArray(cfg.priorityFullTextPaths)
            ? cfg.priorityFullTextPaths : []).map(String));

        const input = (Array.isArray(records) ? records : [])
            .filter(record => record && typeof record.content === 'string' && record.path);
        const scored = scoreFilesForDigest(input);
        const real = scored.filter(file => file.score > -50 || priorityPaths.has(file.path));

        // Manual attachments are explicit user choices. Reserve room for them
        // before expanding the structural map, while retaining at least a small
        // map and fixed prompt-envelope allowance. Attachments that cannot fit
        // are reported instead of being appended outside the advertised budget.
        const fixedOverheadTokens = 200;
        // Mirror skills.sourceBlock's per-file framing, including collision-safe
        // fences and boundary tags. Counting only file bodies badly underpriced
        // projects made of many small files because each block adds metadata.
        const sourceEnvelopeTokens = file => {
            const content = String(file.content || '');
            const runs = content.match(/`+/g) || [];
            const longest = runs.reduce((max, item) => Math.max(max, item.length), 0);
            const fence = '`'.repeat(Math.max(3, longest + 1));
            const safePath = String(file.path || '').replace(/[\r\n]+/g, ' ');
            return estimateTokens([
                `### ${safePath} (${file.lines.toLocaleString()} lines)`,
                '',
                `<BLUEPRINT_SOURCE_9999 characters="${content.length}">`,
                fence,
                content,
                fence,
                '</BLUEPRINT_SOURCE_9999>'
            ].join('\n'));
        };
        const requestedPriorityTokens = real
            .filter(file => priorityPaths.has(file.path))
            .reduce((total, file) => total + sourceEnvelopeTokens(file), 0);
        const maxPriorityReserve = Math.max(0, budget - 512 - fixedOverheadTokens);
        const priorityReserve = Math.min(requestedPriorityTokens, maxPriorityReserve);
        const availableAfterOverhead = Math.max(0, budget - fixedOverheadTokens);
        const tier1Floor = Math.min(512, availableAfterOverhead);
        const tier1Budget = Math.max(
            tier1Floor,
            Math.min(Math.round(budget * 0.62), budget - priorityReserve - fixedOverheadTokens)
        );
        const tier2Budget = Math.max(0, budget - tier1Budget - fixedOverheadTokens);

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

        // Tier 2: verbatim text for explicit attachments first, then substantial
        // code files by score. A non-fitting candidate is skipped so a smaller
        // useful file later in the ranking still gets a chance.
        const fullTextFiles = [];
        const fullTextRecords = [];
        const rejectedPriorityFiles = [];
        let tier2Tokens = 0;
        // Use `real`, not only map entries: a priority attachment may be one of
        // the paths omitted from a very large structural map and still deserves
        // a chance to consume the space explicitly reserved for it.
        const tier2Candidates = real.slice().sort((left, right) => {
            const priorityDelta = Number(priorityPaths.has(right.path)) - Number(priorityPaths.has(left.path));
            return priorityDelta || right.score - left.score;
        });
        for (let i = 0; i < tier2Candidates.length; i += 1) {
            const item = tier2Candidates[i];
            const isPriority = priorityPaths.has(item.path);
            if (!isPriority && CODE_EXTENSIONS.indexOf(item.extension) < 0) continue;
            if (!isPriority && item.lines < minLines) continue;
            const tokens = sourceEnvelopeTokens(item);
            // A single file may not eat more than 75% of Tier 2, or one giant
            // heuristic module crowds out every other file the model might need.
            // Explicit attachments are exempt from that heuristic but never from
            // the total budget.
            if (!isPriority && tokens > tier2Budget * 0.75) continue;
            if (tier2Tokens + tokens > tier2Budget) {
                if (isPriority) rejectedPriorityFiles.push(item.path);
                continue;
            }
            tier2Tokens += tokens;
            fullTextFiles.push(item.path);
            fullTextRecords.push({ path: item.path, content: item.content, excerpted: false });
        }

        // A code-reading skill is not allowed to infer runtime behaviour from
        // signatures alone. If the normal size/length heuristic selected no
        // implementation, add the best non-priority code file in full when it
        // fits, otherwise use a deterministic head+tail excerpt. Explicit files
        // that exceeded the combined budget remain rejected rather than being
        // silently downgraded from "attached in full" to an excerpt.
        if (!fullTextRecords.length && tier2Budget > 0) {
            const fallback = tier2Candidates.find(item =>
                IMPLEMENTATION_EXTENSIONS.indexOf(item.extension) >= 0 && !priorityPaths.has(item.path));
            if (fallback) {
                const remaining = Math.max(0, tier2Budget - tier2Tokens);
                const fullTokens = sourceEnvelopeTokens(fallback);
                if (fullTokens <= remaining) {
                    tier2Tokens += fullTokens;
                    fullTextFiles.push(fallback.path);
                    fullTextRecords.push({ path: fallback.path, content: fallback.content, excerpted: false });
                } else {
                    const headingTokens = estimateTokens(`### ${fallback.path} (excerpt)\n\n`);
                    const availableContentTokens = Math.max(0, remaining - headingTokens - 8);
                    const maxChars = Math.floor(availableContentTokens * 3.8);
                    if (maxChars >= 240) {
                        const marker = '\n\n[... Blueprint omitted the middle of this file to stay within the source budget ...]\n\n';
                        const bodyBudget = Math.max(120, maxChars - marker.length);
                        const headChars = Math.floor(bodyBudget * 0.7);
                        const tailChars = Math.max(1, bodyBudget - headChars);
                        const excerpt = fallback.content.length <= bodyBudget
                            ? fallback.content
                            : fallback.content.slice(0, headChars) + marker + fallback.content.slice(-tailChars);
                        const excerptRecord = Object.assign({}, fallback, {
                            content: excerpt,
                            lines: excerpt.split('\n').length
                        });
                        const excerptTokens = sourceEnvelopeTokens(excerptRecord);
                        if (excerptTokens <= remaining) {
                            tier2Tokens += excerptTokens;
                            fullTextFiles.push(fallback.path);
                            fullTextRecords.push({ path: fallback.path, content: excerpt, excerpted: true });
                        }
                    }
                }
            }
        }

        priorityPaths.forEach(path => {
            if (real.some(item => item.path === path)
                && fullTextFiles.indexOf(path) < 0
                && rejectedPriorityFiles.indexOf(path) < 0) {
                rejectedPriorityFiles.push(path);
            }
        });

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
            while (tier1Tokens + noteTokens > tier1Budget && digests.length > 0) {
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
        const renderedSourceTokens = (digestText || fullTextRecords.length)
            ? tier1Tokens + tier2Tokens + fixedOverheadTokens
            : 0;

        return {
            digestText,
            fullTextFiles,
            fullTextRecords,
            rejectedPriorityFiles,
            tokens: renderedSourceTokens,
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

    /** Atomically select a run and its owning project root. */
    function selectRun(runId, folderId) {
        const run = findRun(String(runId || ''));
        if (!run) return false;
        const suppliedFolderId = typeof folderId === 'string' ? folderId : '';
        if (suppliedFolderId && run.folderId && suppliedFolderId !== run.folderId) {
            return false;
        }
        const requestedFolderId = String(folderId || run.folderId || '');
        // Historical runs survive project-root deletion for audit/transcript
        // access. Preserve their original missing owner on the run, but keep the
        // live workspace on a valid root so no artifact can drift into another
        // project with the same relative path.
        const targetFolderId = store.folders[requestedFolderId]
            ? requestedFolderId
            : (store.folders[store.activeFolderId] ? store.activeFolderId : DEFAULT_FOLDER_ID);
        const previousActiveRunId = store.activeRunId;
        const previousActiveFolderId = store.activeFolderId;
        store.activeRunId = run.id;
        store.activeFolderId = targetFolderId;
        if (!writeStore(store)) {
            store.activeRunId = previousActiveRunId;
            store.activeFolderId = previousActiveFolderId;
            return false;
        }
        return true;
    }

    /**
     * Restore the owner-qualified project selection in one project-store commit.
     * Host snapshots can carry folder, file and run fields from slightly
     * different moments; callers resolve precedence first, then this function
     * either persists the complete tuple or leaves the prior tuple untouched.
     */
    function restoreSelection(selection) {
        const value = selection && typeof selection === 'object' ? selection : {};
        const previous = {
            activeFolderId: store.activeFolderId,
            openPath: store.openPath,
            openFolderId: store.openFolderId,
            activeRunId: store.activeRunId
        };

        const hasExplicitActiveFolder = hasOwn(value, 'activeFolderId')
            && typeof value.activeFolderId === 'string'
            && hasRecord(store.folders, value.activeFolderId);
        let activeFolderId = hasExplicitActiveFolder ? value.activeFolderId : store.activeFolderId;
        let activeRunId = store.activeRunId;
        if (typeof value.activeRunId === 'string') {
            const requestedRun = findRun(value.activeRunId);
            // An explicit stale id is not permission to select an unrelated run.
            activeRunId = requestedRun ? requestedRun.id : '';
        }

        let openPath = store.openPath;
        let openFolderId = store.openFolderId;
        if (typeof value.openPath === 'string') {
            const cleanPath = cleanFilePath(value.openPath);
            const hasExplicitFolder = hasOwn(value, 'openFolderId');
            const explicitFolder = hasExplicitFolder && typeof value.openFolderId === 'string'
                && hasRecord(store.folders, value.openFolderId) ? value.openFolderId : '';
            // A present-but-invalid owner is stale/corrupt qualified state. Clear
            // it rather than falling across roots. Only truly ownerless legacy
            // snapshots may use the active-root/unique-path migration fallback.
            let entry = null;
            if (cleanPath && hasExplicitFolder && explicitFolder) {
                entry = findFileEntry(cleanPath, explicitFolder, false);
            } else if (cleanPath && !hasExplicitFolder && hasExplicitActiveFolder) {
                entry = findFileEntry(cleanPath, activeFolderId, false);
            } else if (cleanPath && !hasExplicitFolder) {
                entry = findFileEntry(cleanPath, '', true);
            }
            openPath = entry ? cleanPath : '';
            openFolderId = entry ? String(entry.record.folder || '') : '';
            if (entry && store.folders[openFolderId]) activeFolderId = openFolderId;
        }

        const selectedRun = findRun(activeRunId);
        const folderPinnedBySnapshot = hasExplicitActiveFolder
            || typeof value.openPath === 'string';
        if (selectedRun) {
            const runFolderId = String(selectedRun.folderId || '');
            const terminalOrphan = !store.folders[runFolderId]
                && selectedRun.status !== 'running';
            if (typeof value.activeRunId === 'string' && !folderPinnedBySnapshot
                && store.folders[runFolderId]) {
                // A run-only restore is an explicit request to reopen that run;
                // move the root with it, as selectRun() does.
                activeFolderId = runFolderId;
            } else if (!terminalOrphan
                && (!store.folders[runFolderId] || runFolderId !== activeFolderId)) {
                // Folder/file precedence wins. Never pair one root's tree and
                // source context with another live root's transcript/compaction.
                // A terminal orphan is intentionally read-only and may remain
                // selected while the live tree stays on a valid root.
                activeRunId = '';
            }
        }

        const unchanged = activeFolderId === previous.activeFolderId
            && openPath === previous.openPath
            && openFolderId === previous.openFolderId
            && activeRunId === previous.activeRunId;
        if (unchanged) return true;

        store.activeFolderId = activeFolderId;
        store.openPath = openPath;
        store.openFolderId = openFolderId;
        store.activeRunId = activeRunId;
        if (!writeStore(store)) {
            store.activeFolderId = previous.activeFolderId;
            store.openPath = previous.openPath;
            store.openFolderId = previous.openFolderId;
            store.activeRunId = previous.activeRunId;
            return false;
        }
        return true;
    }

    /**
     * Repair a crash-interrupted cross-key tab commit on cold load. Workspace
     * tabs and project selection live under separate localStorage keys; if the
     * process exits after the tab key commits, a valid active file tab is the
     * most recent user intent and therefore wins over the older project tuple.
     */
    function reconcileWorkspaceSelection(workspace) {
        if (!workspace || typeof workspace !== 'object'
            || !Array.isArray(workspace.tabs)) {
            return { ok: true, changed: false, error: '' };
        }
        const activeTabId = String(workspace.activeTabId || '');
        const tab = workspace.tabs.find(item => item && String(item.id || '') === activeTabId);
        if (!tab || tab.kind !== 'file') {
            return { ok: true, changed: false, error: '' };
        }
        const folderId = String(tab.folderId || '');
        const path = cleanFilePath(String(tab.path || ''));
        const record = folderId && path ? readFile(path, folderId) : null;
        if (!record || record.path !== path || record.folder !== folderId) {
            return {
                ok: false,
                changed: false,
                error: 'The active saved file tab no longer has an exact project-root file owner.'
            };
        }
        const selectedRun = activeRun();
        const alreadyAligned = store.activeFolderId === folderId
            && store.openPath === path
            && store.openFolderId === folderId
            && (!selectedRun || String(selectedRun.folderId || '') === folderId);
        if (alreadyAligned) return { ok: true, changed: false, error: '' };
        if (!restoreSelection({ activeFolderId: folderId, openPath: path, openFolderId: folderId })) {
            return {
                ok: false,
                changed: false,
                error: String(persistence.lastError || 'the reconciled project selection could not be saved')
            };
        }
        return { ok: true, changed: true, error: '' };
    }

    // Session-local tombstones prevent a late async checkpoint from resurrecting
    // a run the user deleted while cancellation acknowledgement was still in
    // flight. Reload clears them only after every old callback is gone.
    const deletedRunIds = new Set();
    /** Returns false when the in-memory change could not be persisted. */
    function saveRun(run) {
        if (!run || !run.id) return false;
        const executionOwner = readRunOwner(run.id);
        const running = run.status === 'running';
        const expectedLeaseId = runLeaseId(run);
        const fencedExecutionMutation = Boolean(expectedLeaseId);
        const ownerInvalid = fencedExecutionMutation
            ? (!executionOwner || !executionOwner.owned || !executionOwner.live
                || executionOwner.leaseId !== expectedLeaseId)
            : running
                ? true
                : Boolean(executionOwner && executionOwner.live && !executionOwner.owned);
        if (ownerInvalid) {
            recordPersistenceFailure(new Error(
                'This run is owned by another Blueprint window or its execution lease expired.'
            ), 'run-owner-lost');
            return false;
        }
        const index = store.runs.findIndex(item => item && item.id === run.id);
        const isNew = index < 0;
        if (isNew && deletedRunIds.has(run.id)) return false;
        const previousRuns = store.runs.slice();
        const previousActiveRunId = store.activeRunId;
        const previousActiveFolderId = store.activeFolderId;
        // persistenceError describes the current process's last attempted write;
        // it is not durable run state. Never serialize a stale failure after a
        // later checkpoint succeeds.
        delete run.persistenceError;
        if (!isNew) store.runs[index] = run;
        else store.runs.unshift(run);
        store.runs = store.runs.slice(0, 60);
        // Saving progress is not navigation. A late callback from an older
        // parallel run must never steal focus from the run the user opened (or
        // from a newer run). New runs still become active, and the currently
        // active run remains active while it checkpoints. An explicitly empty
        // selection stays empty; a late checkpoint must not undo Clear chat or
        // cross back into an older project root.
        if (isNew) {
            if (run.folderId && store.folders[run.folderId]) {
                store.activeFolderId = run.folderId;
            }
            store.activeRunId = run.id;
        } else if (store.activeRunId === run.id) {
            store.activeRunId = run.id;
        }
        if (!writeStore(store, {
            validateUnderLease: () => validateRunMutationUnderLease(
                run.id, expectedLeaseId, running),
            preconditionCode: 'run-owner-lost',
            preconditionMessage: 'This run lost its execution lease before its checkpoint committed.'
        })) {
            store.activeRunId = previousActiveRunId;
            store.activeFolderId = previousActiveFolderId;
            if (isNew) {
                store.runs = previousRuns;
            } else {
                // Preserve live object identity and the newest partial output for
                // recovery/export. Replacing the run from a snapshot here would
                // detach every step reference still held by the streaming UI.
                run.persistenceError = String(persistence.lastError || 'Project storage is unavailable.');
            }
            return false;
        }
        return true;
    }

    function deleteRun(runId, options) {
        const opts = options && typeof options === 'object' ? options : {};
        const expectedLeaseId = String(opts.expectedLeaseId || '');
        const ownerAtStart = readRunOwner(runId);
        const deletionOwnsLease = Boolean(expectedLeaseId && ownerAtStart
            && ownerAtStart.owned && ownerAtStart.live
            && ownerAtStart.leaseId === expectedLeaseId);
        if ((expectedLeaseId && !deletionOwnsLease)
            || (!expectedLeaseId && ownerAtStart && ownerAtStart.live)) {
            recordPersistenceFailure(new Error(
                'This run is actively owned by another execution and cannot be deleted.'
            ), 'run-owner-lost');
            return false;
        }
        const deletedRun = store.runs.find(run => run && run.id === runId) || null;
        const existed = Boolean(deletedRun);
        const previousRuns = store.runs.slice();
        const previousActiveRunId = store.activeRunId;
        store.runs = store.runs.filter(run => run && run.id !== runId);
        if (store.activeRunId === runId) {
            const sameRoot = store.runs.find(run => run && deletedRun
                && String(run.folderId || '') === String(deletedRun.folderId || ''));
            store.activeRunId = sameRoot ? sameRoot.id : '';
        }
        if (!writeStore(store, {
            validateUnderLease: () => {
                const current = readRunOwner(runId);
                if (expectedLeaseId) {
                    return Boolean(current && current.owned && current.live
                        && current.leaseId === expectedLeaseId);
                }
                return !current || !current.live;
            },
            preconditionCode: 'run-owner-lost',
            preconditionMessage: 'This run became active before its deletion committed.'
        })) {
            store.runs = previousRuns;
            store.activeRunId = previousActiveRunId;
            return false;
        }
        if (existed) deletedRunIds.add(runId);
        // Never perform an unfenced release after the durable delete. Another
        // execution could claim this id between the commit and cleanup.
        const ownedLeaseId = expectedLeaseId || String(
            (ownerAtStart && ownerAtStart.owned && ownerAtStart.leaseId) || ''
        );
        if (ownedLeaseId) releaseRunOwnership(runId, ownedLeaseId);
        return true;
    }

    function clearRuns() {
        const previousRuns = store.runs.slice();
        const previousActiveRunId = store.activeRunId;
        store.runs = [];
        store.activeRunId = '';
        if (!writeStore(store, {
            validateUnderLease: () => destructiveMutationAllowed(),
            preconditionCode: 'operation-active',
            preconditionMessage: 'A Blueprint operation became active before run history was cleared.'
        })) {
            store.runs = previousRuns;
            store.activeRunId = previousActiveRunId;
            return false;
        }
        previousRuns.forEach(run => {
            if (run && run.id) {
                deletedRunIds.add(run.id);
                releaseRunOwnership(run.id);
            }
        });
        return true;
    }

    function assignStoreState(next) {
        const source = next && typeof next === 'object' ? next : emptyStore();
        const restoreObjectInPlace = (target, incoming) => {
            if (!target || !incoming || target === incoming
                || typeof target !== 'object' || typeof incoming !== 'object'
                || Array.isArray(target) || Array.isArray(incoming)) return incoming;
            Object.keys(target).forEach(key => {
                if (!hasOwn(incoming, key)) delete target[key];
            });
            Object.keys(incoming).forEach(key => {
                const currentValue = target[key];
                const nextValue = incoming[key];
                if (Array.isArray(currentValue) && Array.isArray(nextValue)) {
                    const byId = new Map(currentValue
                        .filter(item => item && typeof item === 'object' && item.id)
                        .map(item => [String(item.id), item]));
                    const restored = nextValue.map(item => {
                        const existingItem = item && typeof item === 'object' && item.id
                            ? byId.get(String(item.id)) : null;
                        return existingItem
                            ? restoreObjectInPlace(existingItem, item)
                            : item;
                    });
                    currentValue.splice(0, currentValue.length, ...restored);
                    target[key] = currentValue;
                } else if (currentValue && nextValue
                    && typeof currentValue === 'object' && typeof nextValue === 'object'
                    && !Array.isArray(currentValue) && !Array.isArray(nextValue)) {
                    target[key] = restoreObjectInPlace(currentValue, nextValue);
                } else {
                    target[key] = nextValue;
                }
            });
            return target;
        };
        const existingRuns = new Map((Array.isArray(store.runs) ? store.runs : [])
            .filter(run => run && run.id)
            .map(run => [String(run.id), run]));
        const incomingRunIds = new Set((Array.isArray(source.runs) ? source.runs : [])
            .filter(run => run && run.id)
            .map(run => String(run.id)));
        existingRuns.forEach((_run, id) => {
            // An authoritative reload/rollback that no longer contains a run is
            // a durable deletion precondition. Keep stale async/history object
            // references from adding it back as if it were brand new.
            if (!incomingRunIds.has(id)) deletedRunIds.add(id);
        });
        store.version = STORE_VERSION;
        store.revision = Number.isSafeInteger(source.revision) && source.revision >= 0
            ? source.revision : 0;
        store.commitId = typeof source.commitId === 'string' ? source.commitId : '';
        store.folders = source.folders && typeof source.folders === 'object'
            ? safeRecordMap(source.folders) : emptyStore().folders;
        if (!hasRecord(store.folders, DEFAULT_FOLDER_ID)) {
            store.folders[DEFAULT_FOLDER_ID] = emptyFolder(DEFAULT_FOLDER_ID, 'Blueprint project', 'default');
        }
        store.files = source.files && typeof source.files === 'object'
            ? safeRecordMap(source.files) : safeRecordMap();
        store.runs = (Array.isArray(source.runs) ? source.runs : []).map(incoming => {
            if (!incoming || !incoming.id) return incoming;
            const existing = existingRuns.get(String(incoming.id));
            if (!existing || existing === incoming) return incoming;
            const boundLeaseId = String(existing[RUN_LEASE_SYMBOL] || '');
            restoreObjectInPlace(existing, incoming);
            const currentOwner = boundLeaseId ? readRunOwner(existing.id) : null;
            if (boundLeaseId && currentOwner && currentOwner.owned
                && currentOwner.live && currentOwner.leaseId === boundLeaseId) {
                try {
                    Object.defineProperty(existing, RUN_LEASE_SYMBOL, {
                        value: boundLeaseId,
                        configurable: true,
                        enumerable: false,
                        writable: false
                    });
                } catch (_) { /* the next ownership assertion still fails closed */ }
            } else {
                try { delete existing[RUN_LEASE_SYMBOL]; } catch (_) { /* transient only */ }
            }
            return existing;
        }).filter(Boolean);
        store.openPath = String(source.openPath || '');
        store.openFolderId = String(source.openFolderId || '');
        store.activeRunId = String(source.activeRunId || '');
        store.activeFolderId = hasRecord(store.folders, source.activeFolderId)
            ? source.activeFolderId : DEFAULT_FOLDER_ID;
    }

    function restoreStorageValues(values, expectedCurrent, keys) {
        let conflict = false;
        try {
            const targets = Array.isArray(keys) ? keys : Object.keys(values);
            // Validate the complete rollback set before changing any key. This
            // avoids a half-rollback when a later key has already been replaced
            // by another window.
            targets.forEach(key => {
                if (expectedCurrent && Object.prototype.hasOwnProperty.call(expectedCurrent, key)
                    && window.localStorage.getItem(key) !== expectedCurrent[key]) {
                    conflict = true;
                }
            });
            if (conflict) return { ok: false, conflict: true };
            targets.forEach(key => {
                if (expectedCurrent && Object.prototype.hasOwnProperty.call(expectedCurrent, key)
                    && window.localStorage.getItem(key) !== expectedCurrent[key]) {
                    conflict = true;
                    return;
                }
                if (values[key] === null) window.localStorage.removeItem(key);
                else window.localStorage.setItem(key, values[key]);
            });
            return { ok: !conflict, conflict };
        } catch (error) {
            console.warn('[codalio-blueprint] unable to roll back storage transaction', error);
            return { ok: false, conflict };
        }
    }

    /**
     * Reset project, settings and workspace keys as one recoverable transaction.
     * localStorage has no native transaction, so every raw value is snapshotted
     * and restored if any later key refuses the change.
     */
    function clearAllData(nextSettings) {
        let transactionLease = null;
        try {
        transactionLease = acquireStoreWriteLease();
        if (!transactionLease.ok) {
            return {
                ok: false,
                rolledBack: true,
                error: 'Another Blueprint window is saving data. Wait for it to finish, then try again.'
            };
        }
        if (!destructiveMutationAllowed()) {
            return {
                ok: false,
                rolledBack: true,
                error: 'A Blueprint operation is active. Stop it before clearing all data.'
            };
        }
        const keys = [PROJECTS_KEY, SETTINGS_KEY, WORKSPACE_KEY];
        const rawBefore = {};
        try {
            keys.forEach(key => { rawBefore[key] = window.localStorage.getItem(key); });
        } catch (error) {
            return { ok: false, rolledBack: true, error: String(error.message || error) };
        }

        let stateBefore = clonePersistable(store);
        if (!stateBefore || persistedStoreValidationError(stateBefore)) {
            stateBefore = clonePersistable(lastGoodStoreSnapshot);
        }
        if (!stateBefore) {
            return { ok: false, rolledBack: true, error: 'The current project state could not be snapshotted safely.' };
        }
        const recoveryBefore = storageRecoveryState();
        const projectLoadErrorBefore = projectStoreLoadError;
        const externalResetBefore = externalResetObserved;
        const priorRuns = store.runs.slice();
        const fresh = emptyStore();
        fresh.revision = store.revision;
        assignStoreState(fresh);

        let failedStage = '';
        const writtenKeys = [];
        const expectedCurrent = {};
        if (!writeStore(store, {
            allowCorruptReset: true,
            allowMissingReset: true,
            transactionLease
        })) failedStage = 'project data';
        else {
            writtenKeys.push(PROJECTS_KEY);
            expectedCurrent[PROJECTS_KEY] = window.localStorage.getItem(PROJECTS_KEY);
            if (!writeSettings(Object.assign({}, nextSettings || DEFAULT_SETTINGS), {
                allowCorruptReset: true,
                expectedRaw: rawBefore[SETTINGS_KEY],
                transactionLease
            })) failedStage = 'settings';
            else {
                writtenKeys.push(SETTINGS_KEY);
                expectedCurrent[SETTINGS_KEY] = window.localStorage.getItem(SETTINGS_KEY);
                if (!clearWorkspace({ allowCorruptReset: true, transactionLease })) failedStage = 'tab layout';
                else {
                    writtenKeys.push(WORKSPACE_KEY);
                    expectedCurrent[WORKSPACE_KEY] = null;
                }
            }
        }

        if (failedStage) {
            const rollback = restoreStorageValues(rawBefore, expectedCurrent, writtenKeys);
            const concurrent = persistence.lastCode === 'concurrent-update' || rollback.conflict;
            const rolledBack = rollback.ok;
            const authoritative = rolledBack && !concurrent ? stateBefore : readStore();
            assignStoreState(authoritative);
            knownStoreRevision = store.revision;
            knownStoreCommitId = store.commitId;
            lastGoodStoreSnapshot = clonePersistable(store);
            if (rolledBack && !concurrent) {
                projectStoreLoadError = projectLoadErrorBefore;
                externalResetObserved = externalResetBefore;
                settingsLoadError = recoveryBefore.settings;
                workspaceLoadError = recoveryBefore.workspace;
            } else {
                // Re-read the independent blobs too so the exposed recovery state
                // describes the authoritative bytes that won the transaction.
                readSettingsRaw();
                readWorkspaceRaw();
            }
            return {
                ok: false,
                rolledBack,
                error: concurrent
                    ? 'Project data changed in another window. This window reloaded the newer stored state; try again.'
                    : rolledBack
                    ? `Could not erase ${failedStage}; the previous Blueprint data was restored.`
                    : `Could not erase ${failedStage}, and rollback also failed. Reload before continuing.`
            };
        }

        priorRuns.forEach(run => {
            if (run && run.id) {
                deletedRunIds.add(run.id);
                releaseRunOwnership(run.id);
            }
        });
        return { ok: true, rolledBack: false, error: '' };
        } finally {
            if (transactionLease && transactionLease.ok) releaseStoreWriteLease(transactionLease);
        }
    }

    function createRun(skill, idea, options) {
        const opts = options && typeof options === 'object' ? options : {};
        const requestedFolderId = typeof opts.folderId === 'string' ? opts.folderId : '';
        const runFolderId = requestedFolderId && store.folders[requestedFolderId]
            ? requestedFolderId
            : (store.folders[store.activeFolderId] ? store.activeFolderId : DEFAULT_FOLDER_ID);
        const run = {
            id: uid('run'),
            skillId: skill.id,
            skillName: skill.name,
            title: skill.name,
            idea: String(idea || ''),
            createdAt: new Date().toISOString(),
            status: 'running',
            projectName: '',
            folderId: runFolderId,
            slug: '',
            phases: [],
            transcript: [],
            writtenPaths: [],
            writtenFiles: [],
            error: ''
        };
        if (requestedFolderId && !store.folders[requestedFolderId]) {
            run.persistenceError = 'The project root for this run no longer exists.';
            return run;
        }
        if (!claimRunOwnership(run.id)) {
            run.persistenceError = 'The run could not claim a durable execution owner.';
            return run;
        }
        if (!bindRunOwnership(run)) {
            run.persistenceError = 'The run could not bind its durable execution fence.';
            releaseRunOwnership(run.id);
            return run;
        }
        deletedRunIds.delete(run.id);
        if (!saveRun(run)) {
            run.persistenceError = String(persistence.lastError || 'Project storage is unavailable.');
            releaseRunOwnership(run.id);
        }
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
        // A compaction attached to a run must describe that run's root even if
        // the user is currently browsing another root in the workspace.
        const runFolderObj = run && run.folderId ? getFolder(run.folderId) : null;
        const activeFolderObj = runFolderObj || opts.activeFolder || activeFolder();
        const settings = opts.settings || readSettings();
        const priorCompactions = [];
        const priorIds = new Set();
        const rememberCompaction = candidate => {
            if (!candidate || typeof candidate !== 'object') return;
            const key = String(candidate.id || candidate.at || candidate.rawText || '');
            if (key && priorIds.has(key)) return;
            if (key) priorIds.add(key);
            priorCompactions.push(candidate);
        };
        messages.forEach(message => {
            if (message && message.role === 'compaction') rememberCompaction(message.compaction);
        });
        if (run && run.compaction) rememberCompaction(run.compaction);
        const latestPriorCompaction = priorCompactions[priorCompactions.length - 1] || null;

        // 1. Chronological User Requests
        let userRequests = [];
        const requestsByFingerprint = new Map();
        const MAX_REQUEST_CHARS = 1600;
        const MAX_REQUEST_TOTAL_CHARS = 12000;
        let requestSequence = 0;
        const requestFingerprint = value => {
            let hash = 2166136261;
            const text = String(value || '');
            for (let index = 0; index < text.length; index += 1) {
                hash ^= text.charCodeAt(index);
                hash = Math.imul(hash, 16777619);
            }
            return (hash >>> 0).toString(16).padStart(8, '0');
        };
        const boundedRequest = value => {
            const text = String(value || '').trim();
            if (text.length <= MAX_REQUEST_CHARS) return text;
            const constraints = [];
            const matcher = /\b(?:must|never|do not|don't|required|constraint|only|cannot|can't|shall)\b|hard[_ -]?constraint/ig;
            let match = null;
            while ((match = matcher.exec(text)) && constraints.length < 4) {
                const start = Math.max(0, match.index - 180);
                const end = Math.min(text.length, match.index + match[0].length + 260);
                constraints.push(text.slice(start, end).trim());
            }
            const marker = `… [${text.length.toLocaleString()} character request truncated; fingerprint ${requestFingerprint(text)}] …`;
            const joined = [text.slice(0, 420).trim(), marker, ...constraints, text.slice(-260).trim()]
                .filter(Boolean).join('\n');
            return joined.length <= MAX_REQUEST_CHARS
                ? joined : `${joined.slice(0, MAX_REQUEST_CHARS - 13).trimEnd()}… [truncated]`;
        };
        const rememberRequest = request => {
            const trimmed = String(request || '').trim();
            if (!trimmed || trimmed.startsWith('/clear') || trimmed.startsWith('/compact')) return;
            const key = trimmed.length > MAX_REQUEST_CHARS
                ? `${trimmed.length}:${requestFingerprint(trimmed)}` : trimmed.toLocaleLowerCase();
            // Keep the newest occurrence of a repeated instruction. A prior
            // compaction must never consume the whole budget before the current
            // user turn is considered.
            requestsByFingerprint.set(key, {
                text: boundedRequest(trimmed),
                order: requestSequence += 1
            });
        };
        priorCompactions.forEach(compaction => {
            (Array.isArray(compaction.userRequests) ? compaction.userRequests : []).forEach(rememberRequest);
        });
        messages.forEach(msg => {
            if (!msg) return;
            if (msg.role === 'user' && typeof msg.text === 'string') {
                rememberRequest(msg.text);
            }
        });
        if (!requestsByFingerprint.size && run && run.idea) rememberRequest(run.idea);
        const finalCandidates = [...requestsByFingerprint.values()]
            .sort((left, right) => left.order - right.order);
        if (!finalCandidates.length) {
            userRequests = ['Product requirements and architecture planning'];
        } else {
            // Fill newest-first, then reverse the retained slice for chronology.
            // Reserve room for a visible omission marker when older history does
            // not fit. The latest request is capped far below the total budget,
            // so it is always retained in full.
            const omissionReserve = finalCandidates.length > 1 ? 120 : 0;
            const retainedNewestFirst = [];
            let retainedChars = 0;
            for (let index = finalCandidates.length - 1; index >= 0; index -= 1) {
                const value = finalCandidates[index].text;
                const budget = MAX_REQUEST_TOTAL_CHARS - omissionReserve;
                if (retainedChars + value.length > budget) continue;
                retainedNewestFirst.push(value);
                retainedChars += value.length;
            }
            userRequests = retainedNewestFirst.reverse();
            const omitted = finalCandidates.length - userRequests.length;
            if (omitted > 0) {
                userRequests.unshift(`… [${omitted} earlier user request${omitted === 1 ? '' : 's'} omitted to preserve the newest instruction] …`);
            }
        }

        // 2. Tracked Documents & Artifacts
        const compactionFolderId = (activeFolderObj && activeFolderObj.id)
            || (run && run.folderId)
            || (store.folders[store.activeFolderId] ? store.activeFolderId : DEFAULT_FOLDER_ID);
        const writtenRefs = run && Array.isArray(run.writtenFiles) && run.writtenFiles.length
            ? run.writtenFiles.map(item => ({
                path: String((item && item.path) || ''),
                folderId: String((item && item.folderId) || run.folderId || compactionFolderId)
            })).filter(item => item.path)
            : (run && Array.isArray(run.writtenPaths) && run.writtenPaths.length
                ? run.writtenPaths.map(path => ({ path, folderId: run.folderId || compactionFolderId }))
                : listFiles(compactionFolderId).filter(p => p.startsWith('docs/'))
                    .map(path => ({ path, folderId: compactionFolderId })));

        const artifactMap = new Map();
        priorCompactions.forEach(compaction => {
            (Array.isArray(compaction.artifacts) ? compaction.artifacts : []).forEach(item => {
                if (!item || !item.path) return;
                const normalized = {
                    path: String(item.path),
                    folderId: String(item.folderId || ''),
                    size: Math.max(0, Number(item.size) || 0),
                    lines: Math.max(0, Number(item.lines) || 0)
                };
                artifactMap.set(`${normalized.folderId}\u0000${normalized.path}`, normalized);
            });
        });
        writtenRefs.forEach(ref => {
            const file = readFile(ref.path, ref.folderId);
            const size = file ? file.content.length : 0;
            const lines = file ? file.content.split('\n').length : 0;
            artifactMap.set(`${ref.folderId}\u0000${ref.path}`, {
                path: ref.path, folderId: ref.folderId, size, lines
            });
        });
        const artifacts = [...artifactMap.values()].slice(-100);

        // 3. Project & Source Context
        const folderName = (activeFolderObj && activeFolderObj.name) || 'Default Project';
        const folderFiles = listFiles(compactionFolderId);
        const sourceFileCount = folderFiles.filter(p => !p.startsWith('docs/')).length;

        // Clarifying answers and bounded canonical assistant decisions are state,
        // not decoration. Omitting them makes a resumed agent forget the user's
        // scope and repeat or contradict work after compaction.
        const clarificationLines = (run && Array.isArray(run.answers) ? run.answers : [])
            .filter(item => item && item.answer !== undefined)
            .slice(0, 20)
            .map(item => `- ${String(item.question || item.id || 'Clarification')}: ${clampText(item.answer, 600)}`);
        const factCandidates = new Map();
        let factSequence = 0;
        const MAX_REQUIRED_FACTS = 40;
        const MAX_REQUIRED_FACT_CHARS = 12000;
        const rememberFact = (fact, priority) => {
            const value = clampText(String(fact || '').trim(), 600);
            if (!value) return;
            const key = value.toLocaleLowerCase();
            const candidate = {
                value,
                priority: Number(priority) || 0,
                order: factSequence += 1
            };
            const prior = factCandidates.get(key);
            if (!prior || candidate.priority >= prior.priority) factCandidates.set(key, candidate);
        };
        priorCompactions.forEach(compaction => {
            (Array.isArray(compaction.requiredFacts) ? compaction.requiredFacts : [])
                .forEach(fact => rememberFact(fact, 0));
        });
        (run && Array.isArray(run.answers) ? run.answers : [])
            .filter(item => item && String(item.answer || '').trim())
            .slice(0, 20)
            .forEach(item => rememberFact(item.answer, 3));
        artifacts.forEach(item => rememberFact(item.path, 2));
        rememberFact(folderName, 2);
        (run && Array.isArray(run.selectedOptions) ? run.selectedOptions : []).forEach(option => {
            if (option && typeof option === 'object') {
                rememberFact(`${String(option.id || option.section || 'option')}: ${String(option.value || option.label || option.answer || '')}`, 3);
            } else rememberFact(option, 3);
        });
        const constraintPattern = /\b(?:must|never|do not|don't|required|constraint|only|cannot|can't|shall)\b|hard[_ -]?constraint/i;
        const constraintMatcher = /\b(?:must|never|do not|don't|required|constraint|only|cannot|can't|shall)\b|hard[_ -]?constraint/ig;
        const rememberConstraints = value => {
            const text = String(value || '');
            constraintMatcher.lastIndex = 0;
            let match = null;
            let retained = 0;
            while ((match = constraintMatcher.exec(text)) && retained < 20) {
                const mark = match.index;
                const priorBreaks = [
                    text.lastIndexOf('\n', mark - 1),
                    text.lastIndexOf('.', mark - 1),
                    text.lastIndexOf('!', mark - 1),
                    text.lastIndexOf('?', mark - 1)
                ];
                let start = Math.max(...priorBreaks) + 1;
                const nextBreaks = ['\n', '.', '!', '?']
                    .map(char => text.indexOf(char, mark + match[0].length))
                    .filter(index => index >= 0);
                let end = nextBreaks.length ? Math.min(...nextBreaks) + 1 : text.length;
                let fact = text.slice(start, end).trim();
                if (fact.length > 600) {
                    // Center the retained window on the matched commitment. The
                    // old prefix-only clamp could validate a summary while
                    // silently dropping a late "must/never/only" clause.
                    const markInFact = Math.max(0, mark - start);
                    start = Math.max(0, Math.min(markInFact - 180, fact.length - 600));
                    fact = fact.slice(start, start + 600).trim();
                }
                rememberFact(fact, 4);
                retained += 1;
                if (constraintMatcher.lastIndex === match.index) constraintMatcher.lastIndex += 1;
            }
        };
        const decisionCandidates = [];
        messages.forEach(message => {
            if (!message) return;
            const messageText = String(message.text || '').trim();
            if (messageText && constraintPattern.test(messageText)) rememberConstraints(messageText);
            if (message.role !== 'assistant') return;
            if (messageText) {
                decisionCandidates.push(`- Assistant: ${clampText(messageText, 600)}`);
            }
            (Array.isArray(message.steps) ? message.steps : []).forEach(step => {
                if (!step) return;
                const detail = String(step.text || step.summary || step.error || '').trim();
                if (!detail) return;
                decisionCandidates.push(`- ${String(step.label || 'Step')} [${String(step.status || 'unknown')}]: ${clampText(detail, 600)}`);
                if (constraintPattern.test(detail)) rememberConstraints(detail);
            });
        });
        (run && Array.isArray(run.phases) ? run.phases : []).forEach(phase => {
            if (!phase || (phase.status !== 'running' && phase.status !== 'pending')) return;
            rememberFact(`${String(phase.label || 'Phase')} [${String(phase.status)}]`, 3);
        });
        let requiredFactChars = 0;
        const requiredFacts = [...factCandidates.values()]
            .sort((left, right) => right.priority - left.priority || right.order - left.order)
            .filter(candidate => {
                if (requiredFactChars + candidate.value.length > MAX_REQUIRED_FACT_CHARS) return false;
                requiredFactChars += candidate.value.length;
                return true;
            })
            .slice(0, MAX_REQUIRED_FACTS)
            .sort((left, right) => left.order - right.order)
            .map(candidate => candidate.value);
        // The current tail is more useful than the oldest status prose. Preserve
        // chronology inside the retained window.
        const decisionLines = decisionCandidates.slice(-12);
        const priorContext = latestPriorCompaction
            ? clampText(latestPriorCompaction.summary || latestPriorCompaction.rawText || '', 12000)
            : '';

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
        const requiredFactLines = requiredFacts.length
            ? requiredFacts.map(fact => `- ${fact}`).join('\n')
            : '- No additional durable facts were recorded.';

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
            priorContext ? `**Prior compacted context (retained verbatim as data)**\n${priorContext}` : '',
            clarificationLines.length ? `**User clarifications**\n${clarificationLines.join('\n')}` : '- No clarifying answers were recorded.',
            decisionLines.length ? `**Assistant decisions and step evidence**\n${decisionLines.join('\n')}` : '- No assistant decisions were recorded.',
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
            `**Required facts retained verbatim**`,
            requiredFactLines,
            ``,
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
        priorCompactions.forEach(compaction => {
            originalChars += String(compaction.rawText || compaction.summary || '').length;
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
            mode: 'deterministic',
            fallbackReason: '',
            userRequests,
            requiredFacts,
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
        constructor(message, details) {
            super(message || 'Model request failed');
            this.name = 'BlueprintModelError';
            const info = details && typeof details === 'object' ? details : {};
            this.code = String(info.code || 'model-error');
            this.status = Number.isFinite(Number(info.status)) ? Number(info.status) : 0;
            this.retryable = info.retryable === true;
            this.retryAfterMs = Number.isFinite(Number(info.retryAfterMs))
                ? Math.max(0, Number(info.retryAfterMs)) : 0;
            this.partialText = String(info.partialText || '');
            this.partialThinking = String(info.partialThinking || '');
        }
    }

    function safeNotify(callback, payload) {
        if (typeof callback !== 'function') return;
        try { callback(payload); } catch (error) {
            console.warn('[codalio-blueprint] model lifecycle callback failed', error);
        }
    }

    function abortableDelay(ms, signal) {
        const delay = Math.max(0, Number(ms) || 0);
        if (!delay) return Promise.resolve();
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = callback => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', onAbort);
                callback();
            };
            const onAbort = () => finish(() => reject(new BlueprintAbort()));
            const timer = setTimeout(() => finish(resolve), delay);
            if (signal) {
                if (signal.aborted) onAbort();
                else signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    function retryAfterMs(response) {
        try {
            const raw = response && response.headers && typeof response.headers.get === 'function'
                ? response.headers.get('retry-after') : '';
            if (!raw) return 0;
            const seconds = Number(raw);
            if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
            const at = Date.parse(raw);
            return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
        } catch (_) {
            return 0;
        }
    }

    function timeoutMs(options, key, settingSeconds, fallbackSeconds) {
        const direct = Number(options && options[key]);
        if (Number.isFinite(direct) && direct >= 0) return direct;
        const seconds = Number(settingSeconds);
        return Math.max(0, (Number.isFinite(seconds) ? seconds : fallbackSeconds) * 1000);
    }

    const ENDPOINT_ENRICHMENT_FIELDS = Object.freeze(['endpoint_id', 'endpoint_url', 'model']);

    /**
     * Copy only inert endpoint-routing data from the host hook. Object.assign is
     * unsafe at this trust boundary: accessors execute during the copy and an own
     * or inherited toJSON can replace the complete safety envelope at stringify
     * time (including cancel_id). A null-prototype record plus data descriptors
     * makes the exact bytes sent to fetch auditable.
     */
    function safeEndpointEnrichment(value) {
        if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
        let descriptors;
        try { descriptors = Object.getOwnPropertyDescriptors(value); } catch (_) { return null; }
        const safe = Object.create(null);
        for (const key of ENDPOINT_ENRICHMENT_FIELDS) {
            const descriptor = descriptors[key];
            if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
            if (typeof descriptor.value !== 'string') continue;
            safe[key] = descriptor.value.slice(0, 4096);
        }
        return safe;
    }

    async function streamModelAttempt(options, attemptInfo) {
        const settings = attemptInfo.settings;
        const cancelId = attemptInfo.cancelId;
        const controller = new AbortController();
        const externalSignal = options.signal;
        // Resolve this dependency before recording/sending anything. Discovering
        // a missing stream parser after HTTP 2xx would leave a generation running
        // with no consumer and, historically, no cancellation barrier.
        const readJsonLineStream = streamReader();
        const requestLimit = timeoutMs(options, 'requestTimeoutMs', settings.modelRequestTimeoutSeconds, 1200);
        const idleLimit = timeoutMs(options, 'idleTimeoutMs', settings.modelIdleTimeoutSeconds, 300);
        const requestedOutputTokens = Number(options.maxOutputTokens);
        const effectiveOutputTokens = Number.isFinite(requestedOutputTokens) && requestedOutputTokens > 0
            ? Math.floor(requestedOutputTokens)
            : Math.max(1, Number(settings.lensMaxOutputTokens) || 4096);
        // Tokens are not characters, so use a deliberately generous multiplier,
        // but retain an absolute renderer-safety ceiling if an endpoint ignores
        // max_output_tokens. The combined visible + thinking stream is bounded.
        const outputCharLimit = Math.min(8 * 1024 * 1024,
            Math.max(64 * 1024, effectiveOutputTokens * 16));
        let abortKind = '';
        let requestTimer = null;
        let idleTimer = null;
        let cancelLeaseTimer = null;

        const abortFor = kind => {
            if (controller.signal.aborted) return;
            abortKind = kind;
            try { controller.abort(); } catch (_) { /* already settled */ }
        };
        const onExternalAbort = () => {
            abortFor('external');
        };
        if (externalSignal) {
            if (externalSignal.aborted) throw new BlueprintAbort();
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
        if (requestLimit > 0) requestTimer = setTimeout(() => abortFor('request-timeout'), requestLimit);

        // Do not rely on fetch/body-reader implementations to reject when their
        // signal is aborted. Provider shims and test doubles occasionally ignore
        // it; racing every awaited transport operation against the signal makes
        // local stop and timeout guarantees deterministic.
        const awaitAttempt = promise => {
            if (controller.signal.aborted) {
                const error = new Error('model request aborted');
                error.name = 'AbortError';
                return Promise.reject(error);
            }
            let onAbort = null;
            const aborted = new Promise((_, reject) => {
                onAbort = () => {
                    const error = new Error('model request aborted');
                    error.name = 'AbortError';
                    reject(error);
                };
                controller.signal.addEventListener('abort', onAbort, { once: true });
            });
            return Promise.race([Promise.resolve(promise), aborted]).finally(() => {
                if (onAbort) controller.signal.removeEventListener('abort', onAbort);
            });
        };

        const armIdleTimer = () => {
            if (idleTimer) clearTimeout(idleTimer);
            if (idleLimit > 0) idleTimer = setTimeout(() => abortFor('idle-timeout'), idleLimit);
        };

        let text = '';
        let thinking = '';
        let finishReason = '';
        let usage = null;
        let completed = false;
        let meaningfulOutput = false;
        const outputTooLarge = () => new BlueprintModelError(
            `The model response exceeded Blueprint's ${outputCharLimit.toLocaleString()} character safety limit.`,
            {
                code: 'output-too-large',
                retryable: false,
                partialText: text,
                partialThinking: thinking
            }
        );
        const appendBounded = (target, delta) => {
            const remaining = Math.max(0, outputCharLimit - text.length - thinking.length);
            const accepted = String(delta || '').slice(0, remaining);
            if (target === 'thinking') thinking += accepted;
            else text += accepted;
            if (String(delta || '').length > remaining) {
                abortFor('output-too-large');
                throw outputTooLarge();
            }
            return accepted;
        };
        const replaceTerminalOutput = (nextText, nextThinking) => {
            const responseText = String(nextText || '');
            const responseThinking = String(nextThinking || '');
            if (responseText.length + responseThinking.length > outputCharLimit) {
                text = responseText.slice(0, outputCharLimit);
                thinking = responseThinking.slice(0, Math.max(0, outputCharLimit - text.length));
                throw outputTooLarge();
            }
            text = responseText;
            thinking = responseThinking;
        };
        const abortWithPartial = message => {
            const error = new BlueprintAbort(message);
            error.partialText = text;
            error.partialThinking = thinking;
            return error;
        };

        const timeoutFailure = () => {
            const limit = abortKind === 'idle-timeout' ? idleLimit : requestLimit;
            return new BlueprintModelError(
                abortKind === 'idle-timeout'
                    ? `The model stream was silent for ${Math.round(limit / 1000)} seconds.`
                    : `The model request exceeded ${Math.round(limit / 1000)} seconds before completing.`,
                {
                    code: abortKind || 'request-timeout',
                    retryable: !meaningfulOutput,
                    partialText: text,
                    partialThinking: thinking
                }
            );
        };

        try {
            const sanitizedMessage = sanitizeSourceForModel(options.message).content;
            const sanitizedSystemPrompt = sanitizeSourceForModel(options.systemPrompt).content;
            const requestedTemperature = Number(options.temperature);
            const fixedPayload = Object.freeze({
                message: sanitizedMessage,
                system_prompt: sanitizedSystemPrompt,
                interaction_mode: 'chat',
                use_workspace_context: false,
                long_running: true,
                temperature: Number.isFinite(requestedTemperature) ? requestedTemperature : settings.temperature,
                max_output_tokens: effectiveOutputTokens,
                cancel_id: cancelId
            });
            let endpointEnrichment = Object.create(null);
            if (typeof window.withConfiguredModelEndpointPayload === 'function') {
                try {
                    // The host may enrich endpoint routing, but receives a clone:
                    // mutating its argument cannot alter Blueprint's fixed safety
                    // envelope or the sanitized source strings captured above.
                    endpointEnrichment = safeEndpointEnrichment(
                        window.withConfiguredModelEndpointPayload(Object.assign({}, fixedPayload))
                    );
                } catch (error) {
                    throw new BlueprintModelError(
                        `The selected model endpoint could not be prepared (${error && error.message ? error.message : 'configuration error'}).`,
                        { code: 'endpoint-configuration' }
                    );
                }
            }
            if (!endpointEnrichment) {
                throw new BlueprintModelError('The selected model endpoint returned an invalid request configuration.', {
                    code: 'endpoint-configuration'
                });
            }
            if (!String(endpointEnrichment.endpoint_id || '').trim()
                && !String(endpointEnrichment.endpoint_url || '').trim()) {
                throw new BlueprintModelError('Choose an active Local or API model endpoint in SimpleRAG Settings before running Blueprint.', {
                    code: 'missing-endpoint'
                });
            }
            // The host hook may add endpoint configuration, but it may not alter
            // the sanitized request or the cancellation identity Blueprint tracks.
            // Serialize before recording the ledger/dispatched state: circular
            // objects and BigInt must fail locally without creating a phantom
            // backend generation or a permanent cancellation barrier.
            const payload = Object.assign(Object.create(null), endpointEnrichment, fixedPayload);
            let serializedPayload = '';
            try {
                serializedPayload = JSON.stringify(payload);
            } catch (error) {
                throw new BlueprintModelError(
                    `The selected model endpoint produced an unserializable request (${String((error && error.message) || error)}).`,
                    { code: 'endpoint-configuration', retryable: false }
                );
            }
            if (!serializedPayload) {
                throw new BlueprintModelError('The selected model endpoint produced an empty request payload.', {
                    code: 'endpoint-configuration', retryable: false
                });
            }
            try {
                const serializedObject = JSON.parse(serializedPayload);
                const fixedMismatch = Object.keys(fixedPayload).some(key =>
                    serializedObject[key] !== fixedPayload[key]);
                if (fixedMismatch) throw new Error('fixed request fields changed during serialization');
            } catch (error) {
                throw new BlueprintModelError(
                    `The selected model endpoint produced an unsafe request (${String((error && error.message) || error)}).`,
                    { code: 'endpoint-configuration', retryable: false }
                );
            }

            let response;
            try {
                // From this point onward a transport failure is ambiguous: the
                // backend may have accepted the cancel id even if this page never
                // receives a response. streamModelTurn uses this bit to prevent an
                // overlapping retry without an explicit cancellation ack.
                if (options.runId) {
                    const runOwner = readRunOwner(String(options.runId));
                    const expectedRunLease = String(options.runLeaseId || '');
                    if (!runOwner || !runOwner.owned || !runOwner.live || !expectedRunLease
                        || runOwner.leaseId !== expectedRunLease) {
                        throw new BlueprintModelError(
                            'The model request was not sent because this window no longer owns the run.',
                            { code: 'run-owner-lost', retryable: false }
                        );
                    }
                }
                const cancelLeaseId = rememberPendingCancel(cancelId, {
                    runId: options.runId,
                    runLeaseId: options.runLeaseId
                });
                if (!cancelLeaseId) {
                    throw new BlueprintModelError(
                        'The model request was not sent because its crash-recovery cancellation record could not be saved.',
                        { code: 'cancel-ledger-failed', retryable: false }
                    );
                }
                attemptInfo.ledgerRecorded = true;
                attemptInfo.cancelLeaseId = cancelLeaseId;
                cancelLeaseTimer = setInterval(() => {
                    if (!refreshPendingCancel(cancelId, cancelLeaseId)) {
                        abortFor('cancel-ledger-lost');
                    }
                }, PENDING_CANCEL_HEARTBEAT_MS);
                if (typeof options.onAttemptDispatched === 'function') {
                    let permitted = false;
                    try { permitted = options.onAttemptDispatched(attemptInfo) !== false; } catch (_) { permitted = false; }
                    if (!permitted) {
                        forgetPendingCancel(cancelId, cancelLeaseId);
                        throw new BlueprintModelError(
                            'The model request was not sent because its cancellation recovery record could not be saved.',
                            { code: 'cancel-ledger-failed', retryable: false }
                        );
                    }
                }
                if (options.runId) {
                    const reservedOwner = readRunOwner(String(options.runId));
                    const reservedLease = String(options.runLeaseId || '');
                    if (!reservedOwner || !reservedOwner.owned || !reservedOwner.live
                        || reservedOwner.leaseId !== reservedLease) {
                        forgetPendingCancel(cancelId, cancelLeaseId);
                        throw new BlueprintModelError(
                            'The model request was not sent because this window lost the run after reserving dispatch.',
                            { code: 'run-owner-lost', retryable: false }
                        );
                    }
                }
                attemptInfo.dispatched = true;
                response = await awaitAttempt(fetch(`${API_BASE}/chat/stream`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: serializedPayload,
                    signal: controller.signal
                }));
            } catch (error) {
                // Configuration and pre-dispatch durability failures are already
                // classified. Re-wrapping them as a retryable network error could
                // make streamModelTurn retry even though no request was sent (most
                // critically when the crash-recovery cancellation ledger failed).
                if (error instanceof BlueprintModelError) throw error;
                if (externalSignal && externalSignal.aborted) {
                    throw new BlueprintAbort();
                }
                if (abortKind === 'request-timeout') {
                    throw new BlueprintModelError(`The model request exceeded ${Math.round(requestLimit / 1000)} seconds before completing.`, {
                        code: 'request-timeout', retryable: true
                    });
                }
                if (abortKind === 'idle-timeout') {
                    throw new BlueprintModelError(`The model stream was silent for ${Math.round(idleLimit / 1000)} seconds.`, {
                        code: 'idle-timeout', retryable: true
                    });
                }
                if (abortKind === 'cancel-ledger-lost') {
                    throw new BlueprintModelError(
                        'The model turn lost its durable cancellation lease and was stopped safely.',
                        { code: 'cancel-ledger-lost', retryable: false }
                    );
                }
                if (error && error.name === 'AbortError' && controller.signal.aborted) {
                    throw new BlueprintAbort();
                }
                throw new BlueprintModelError(
                    `Could not reach the SimpleRAG chat endpoint (${error && error.message ? error.message : 'network error'}).`,
                    { code: 'network', retryable: true }
                );
            }

            if (!response || typeof response.ok !== 'boolean') {
                throw new BlueprintModelError('The SimpleRAG chat endpoint returned an invalid response.', {
                    code: 'invalid-response', retryable: true
                });
            }
            if (!response.ok) {
                // Receiving a concrete HTTP error response is terminal for this
                // request at SimpleRAG's streaming route: it sends 200 before
                // entering the generator. There is no live stream to cancel, and
                // treating a validation/proxy rejection as ambiguous strands the
                // durable cancel ledger forever when no handle was registered.
                attemptInfo.backendTerminalAcknowledged = true;
                let detail = `The model request failed (HTTP ${response.status}).`;
                try {
                    const body = await awaitAttempt(response.json());
                    const raw = body && (body.detail || body.error || body.message);
                    if (typeof raw === 'string' && raw.trim()) detail = raw.trim();
                    else if (raw && typeof raw === 'object' && typeof raw.message === 'string') detail = raw.message;
                } catch (error) {
                    if (externalSignal && externalSignal.aborted) throw new BlueprintAbort();
                    if (abortKind === 'request-timeout' || abortKind === 'idle-timeout') {
                        throw timeoutFailure();
                    }
                    if (abortKind === 'cancel-ledger-lost') {
                        throw new BlueprintModelError(
                            'The model turn lost its durable cancellation lease and was stopped safely.',
                            {
                                code: 'cancel-ledger-lost',
                                retryable: false,
                                partialText: text,
                                partialThinking: thinking
                            }
                        );
                    }
                    // Keep the generic HTTP detail when the body is malformed.
                }
                const status = Number(response.status) || 0;
                throw new BlueprintModelError(detail, {
                    code: `http-${status || 'error'}`,
                    status,
                    retryable: [408, 425, 429, 500, 502, 503, 504].includes(status),
                    retryAfterMs: retryAfterMs(response)
                });
            }

            const onDelta = typeof options.onDelta === 'function' ? options.onDelta : null;
            const onThinking = typeof options.onThinking === 'function' ? options.onThinking : null;
            armIdleTimer();
            try {
                let resolveTerminal;
                const terminal = new Promise(resolve => { resolveTerminal = resolve; });
                const reading = Promise.resolve(readJsonLineStream(response, event => {
                    // A terminal event is authoritative. Ignore malformed
                    // trailing frames so they cannot mutate a completed answer.
                    if (completed) return;
                    // Ordering is observed at callback entry. A terminal frame
                    // delivered before an adjacent Stop remains authoritative;
                    // one delivered after a visible local abort/timeout cannot
                    // resurrect the turn as a success.
                    if ((externalSignal && externalSignal.aborted)
                        || (controller.signal.aborted && abortKind !== 'completed')) {
                        if (externalSignal && externalSignal.aborted && !abortKind) abortFor('external');
                        return;
                    }
                    const type = String((event && event.type) || '');
                    // Parse terminal frames BEFORE observing a local abort. A done
                    // frame already delivered by the backend cannot be downgraded
                    // merely because Stop won the adjacent event-loop tick.
                    if (type === 'error') {
                        attemptInfo.backendTerminalAcknowledged = true;
                        throw new BlueprintModelError(
                            String((event && (event.message || event.error || event.detail)) || 'The model stream reported an error.'),
                            {
                                code: String((event && event.code) || 'stream-error'),
                                retryable: event && event.retryable === true,
                                partialText: text,
                                partialThinking: thinking
                            }
                        );
                    }
                    if (type === 'done') {
                        attemptInfo.backendTerminalAcknowledged = true;
                        replaceTerminalOutput(
                            event && typeof event.response === 'string' ? event.response : text,
                            event && typeof event.thinking === 'string' ? event.thinking : thinking
                        );
                        completed = true;
                        finishReason = String((event && event.finish_reason) || '');
                        usage = (event && event.usage) || null;
                        resolveTerminal();
                        return;
                    }
                    if (type === 'cancelled' || type === 'canceled') {
                        attemptInfo.backendTerminalAcknowledged = true;
                        replaceTerminalOutput(
                            event && typeof event.response === 'string' ? event.response : text,
                            event && typeof event.thinking === 'string' ? event.thinking : thinking
                        );
                        completed = true;
                        finishReason = 'cancelled';
                        attemptInfo.backendCancellationAcknowledged = true;
                        resolveTerminal();
                        return;
                    }
                    if (controller.signal.aborted) return;
                    if (externalSignal && externalSignal.aborted) {
                        abortFor('external');
                        return;
                    }
                    if (type === 'content') {
                        const delta = String((event && event.delta) || '');
                        if (delta) {
                            // Preserve formatting whitespace, but do not let a
                            // provider keep a dead generation alive forever by
                            // trickling spaces or newlines without real progress.
                            if (hasMeaningfulText(delta)) {
                                meaningfulOutput = true;
                                armIdleTimer();
                            }
                            const accepted = appendBounded('text', delta);
                            if (onDelta && accepted) onDelta(accepted, text);
                        }
                    } else if (type === 'thinking') {
                        const delta = String((event && event.delta) || '');
                        if (delta) {
                            if (hasMeaningfulText(delta)) {
                                meaningfulOutput = true;
                                armIdleTimer();
                            }
                            const accepted = appendBounded('thinking', delta);
                            if (onThinking && accepted) onThinking(accepted, thinking);
                        }
                    }
                })).catch(error => {
                    // Once a valid terminal frame arrived, EOF and any trailing
                    // transport/parser failure are non-authoritative.
                    if (completed) return;
                    throw error;
                });
                // Some providers keep the HTTP connection open after their done
                // frame. Completion is defined by that terminal frame, not EOF.
                // Suppress the expected AbortError from closing the body after the
                // race so it cannot become an unhandled rejection.
                reading.catch(() => {});
                await Promise.race([awaitAttempt(reading), terminal]);
                if (completed) {
                    abortKind = 'completed';
                    if (!controller.signal.aborted) {
                        try { controller.abort(); } catch (_) { /* body already closed */ }
                    }
                }
            } catch (error) {
                if (!completed) {
                    if (externalSignal && externalSignal.aborted) {
                        throw abortWithPartial();
                    }
                    if (abortKind === 'request-timeout' || abortKind === 'idle-timeout') {
                        throw timeoutFailure();
                    }
                    if (abortKind === 'output-too-large') {
                        throw outputTooLarge();
                    }
                    if (error && error.name === 'AbortError' && controller.signal.aborted) {
                        throw abortWithPartial();
                    }
                    if (error instanceof BlueprintModelError) {
                        if (!error.partialText) error.partialText = text;
                        if (!error.partialThinking) error.partialThinking = thinking;
                        throw error;
                    }
                    throw new BlueprintModelError(
                        `The model stream failed (${error && error.message ? error.message : 'stream error'}).`,
                        {
                            code: 'stream-read',
                            retryable: !meaningfulOutput,
                            partialText: text,
                            partialThinking: thinking
                        }
                    );
                }
            }

            if (!completed && externalSignal && externalSignal.aborted) {
                throw abortWithPartial();
            }
            if (!completed) {
                throw new BlueprintModelError('The model stream ended before completion. Try the step again.', {
                    code: 'incomplete-stream',
                    retryable: !meaningfulOutput,
                    partialText: text,
                    partialThinking: thinking
                });
            }
            const normalizedFinish = finishReason.trim().toLowerCase();
            if (['cancelled', 'canceled', 'abort', 'aborted'].includes(normalizedFinish)) {
                const stopped = new BlueprintAbort('The model turn was cancelled.');
                stopped.cancelAcknowledged = true;
                stopped.partialText = text;
                stopped.partialThinking = thinking;
                throw stopped;
            }
            text = text.trim();
            thinking = thinking.trim();
            if (NO_ENDPOINT_PATTERN.test(text)) {
                throw new BlueprintModelError(text, {
                    code: 'missing-endpoint', partialText: text, partialThinking: thinking
                });
            }
            if (normalizedFinish === 'length' || normalizedFinish === 'max_tokens') {
                throw new BlueprintModelError(
                    'The model hit its output token limit before the step was complete. Raise the relevant token budget in Blueprint settings and retry.',
                    {
                        code: 'output-limit',
                        partialText: text,
                        partialThinking: thinking
                    }
                );
            }
            if (normalizedFinish && !['stop', 'end_turn', 'eos', 'eos_token', 'complete', 'completed'].includes(normalizedFinish)) {
                throw new BlueprintModelError(`The model stopped with finish reason "${finishReason}".`, {
                    code: 'unexpected-finish', partialText: text, partialThinking: thinking
                });
            }
            if (!hasMeaningfulText(text)) {
                throw new BlueprintModelError('The model completed without returning any document text.', {
                    code: 'empty-response', retryable: true, partialThinking: thinking
                });
            }
            return { text, thinking, finishReason, usage, cancelId };
        } finally {
            if (requestTimer) clearTimeout(requestTimer);
            if (idleTimer) clearTimeout(idleTimer);
            if (cancelLeaseTimer) clearInterval(cancelLeaseTimer);
            if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
        }
    }

    function streamReader() {
        const reader = window.RagChatStreaming && window.RagChatStreaming.readJsonLineStream;
        if (typeof reader !== 'function') {
            throw new BlueprintModelError('The SimpleRAG streaming runtime is unavailable. Reload the app and try again.', {
                code: 'stream-runtime-unavailable', retryable: false
            });
        }
        return reader;
    }

    /**
     * Run one model turn and stream deltas back through onDelta.
     * Resolves with { text, thinking, finishReason, usage }.
     */
    async function streamModelTurn(options) {
        const settings = readSettings();
        const opts = options && typeof options === 'object' ? options : {};
        const configuredRetries = Number(opts.maxRetries);
        const maxRetries = Number.isFinite(configuredRetries)
            ? Math.max(0, Math.min(5, Math.floor(configuredRetries)))
            : settings.modelMaxRetries;
        const maxAttempts = maxRetries + 1;
        const baseDelay = Number.isFinite(Number(opts.retryBaseDelayMs))
            ? Math.max(0, Number(opts.retryBaseDelayMs))
            : settings.modelRetryBaseDelayMs;
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (opts.signal && opts.signal.aborted) throw new BlueprintAbort();
            const cancelId = attempt === 1 && opts.cancelId ? String(opts.cancelId) : uid('cancel');
            const attemptInfo = {
                attempt,
                maxAttempts,
                cancelId,
                settings,
                dispatched: false,
                backendCancellationAcknowledged: false
            };
            safeNotify(opts.onAttemptStart, attemptInfo);
            try {
                const result = await streamModelAttempt(opts, attemptInfo);
                attemptInfo.ledgerCleared = forgetPendingCancel(cancelId, attemptInfo.cancelLeaseId);
                safeNotify(opts.onAttemptEnd, Object.assign({}, attemptInfo, { status: 'done' }));
                return Object.assign({}, result, { attempt, attempts: attempt });
            } catch (error) {
                lastError = error;
                const code = String((error && error.code) || '');
                const stopped = code === 'aborted';
                let cancelAcknowledged = attemptInfo.backendCancellationAcknowledged
                    || (error && error.cancelAcknowledged === true)
                    ? true : null;
                const needsCancellation = attemptInfo.dispatched
                    && attemptInfo.backendTerminalAcknowledged !== true
                    && cancelAcknowledged !== true;
                if (needsCancellation) {
                    cancelAcknowledged = await cancelTurn(cancelId, {
                        timeoutMs: Number.isFinite(Number(opts.cancelTimeoutMs))
                            ? Number(opts.cancelTimeoutMs) : 5000
                    });
                    error.cancelAcknowledged = cancelAcknowledged;
                    // A second generation may start only after the first one is
                    // known stopped. A local AbortController proves only that this
                    // page disconnected; it does not prove the backend stopped.
                    if (!stopped && !cancelAcknowledged) {
                        error.retryable = false;
                        error.message += ' The backend did not acknowledge cancellation, so Blueprint did not start an overlapping retry.';
                    }
                }
                const backendMayBeRunning = attemptInfo.dispatched
                    && attemptInfo.backendTerminalAcknowledged !== true
                    && cancelAcknowledged !== true;
                attemptInfo.backendMayBeRunning = backendMayBeRunning;
                if (!backendMayBeRunning) {
                    attemptInfo.ledgerCleared = forgetPendingCancel(cancelId, attemptInfo.cancelLeaseId);
                }
                // Stop is authoritative even if it arrived while an earlier
                // timeout/network failure was waiting on cancellation.
                if (stopped || (opts.signal && opts.signal.aborted)) {
                    const abortError = stopped ? error : new BlueprintAbort();
                    abortError.cancelAcknowledged = cancelAcknowledged;
                    safeNotify(opts.onAttemptEnd, Object.assign({}, attemptInfo, {
                        status: 'stopped',
                        error: abortError,
                        cancelAcknowledged
                    }));
                    throw abortError;
                }
                safeNotify(opts.onAttemptEnd, Object.assign({}, attemptInfo, {
                    status: 'error',
                    error,
                    cancelAcknowledged
                }));
                const hasPartial = Boolean(error && (
                    hasMeaningfulText(error.partialText)
                    || hasMeaningfulText(error.partialThinking)
                ));
                const canRetry = Boolean(error && error.retryable === true && !hasPartial && attempt < maxAttempts);
                if (!canRetry) throw error;
                const exponential = Math.min(30000, baseDelay * Math.pow(2, attempt - 1));
                const delayMs = Math.min(60000, Math.max(exponential, Number(error.retryAfterMs) || 0));
                safeNotify(opts.onRetry, {
                    attempt,
                    nextAttempt: attempt + 1,
                    maxAttempts,
                    delayMs,
                    error
                });
                await abortableDelay(delayMs, opts.signal);
            }
        }
        throw lastError || new BlueprintModelError('The model request failed.', { code: 'model-error' });
    }

    // Concurrent callers (the core attempt and the controller's Stop button)
    // must share one cancellation request. Keep the settled promise briefly so
    // a same-tick late caller observes the same acknowledgement instead of
    // issuing a second POST that may misleadingly return "nothing to cancel".
    const cancellationRequests = new Map();

    function cancelTurnOutcome(cancelId, options) {
        if (!cancelId) return Promise.resolve('unknown');
        const key = String(cancelId);
        if (cancellationRequests.has(key)) return cancellationRequests.get(key);
        const request = performCancelTurn(key, options);
        cancellationRequests.set(key, request);
        request.finally(() => {
            setTimeout(() => {
                if (cancellationRequests.get(key) === request) cancellationRequests.delete(key);
            }, 250);
        });
        return request;
    }

    function cancelTurn(cancelId, options) {
        return cancelTurnOutcome(cancelId, options).then(outcome => (
            outcome === 'cancelled' || outcome === 'already-terminal'
        ));
    }

    async function performCancelTurn(cancelId, options) {
        const opts = options || {};
        const limit = Number.isFinite(Number(opts.timeoutMs))
            ? Math.max(50, Number(opts.timeoutMs)) : 5000;
        const controller = new AbortController();
        let timer = null;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
                try { controller.abort(); } catch (_) { /* already settled */ }
                const error = new Error('cancel acknowledgement timed out');
                error.name = 'AbortError';
                reject(error);
            }, limit);
        });
        try {
            const response = await Promise.race([
                fetch(`${API_BASE}/chat/cancel/${encodeURIComponent(cancelId)}`, {
                    method: 'POST',
                    keepalive: true,
                    signal: controller.signal
                }),
                deadline
            ]);
            if (!response.ok) return 'unknown';
            const body = await Promise.race([response.json(), deadline]);
            const status = String((body && (body.status || body.state || body.result)) || '')
                .trim().toLowerCase().replace(/_/g, '-');
            if ((body && body.already_terminal === true)
                || (body && body.terminal === true)
                || [
                    'already-terminal', 'cancelled', 'canceled', 'stopped', 'aborted',
                    'completed', 'complete', 'done', 'terminal'
                ].includes(status)) {
                if (['cancelled', 'canceled', 'stopped', 'aborted'].includes(status)) {
                    return 'cancelled';
                }
                return 'already-terminal';
            }

            // SimpleRAG acknowledges cancellation asynchronously with
            // `{ cancelled: true, status: "requested" }`. Its request handle can
            // disappear before every worker event has settled, so neither that
            // acknowledgement nor a later `requested/false` proves terminality.
            // Fail closed and retain the durable recovery barrier until the
            // backend exposes an explicit terminal state (or the stream itself
            // supplies a terminal frame).
            if ([
                'requested', 'accepted', 'pending', 'cancelling', 'canceling',
                'stopping', 'in-progress', 'processing'
            ].includes(status)) return 'requested';

            // Retain compatibility with older backends that expose only the
            // boolean and synchronously stop before replying.
            if (body && body.cancelled === true) return 'cancelled';
            return 'unknown';
        } catch (_) {
            // A 2xx transport response without a parseable, explicit terminal
            // acknowledgement does not prove that generation stopped.
            return 'unknown';
        } finally {
            if (timer) clearTimeout(timer);
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
    function buildOutputPath(skill, phase, meta, settings, folderId) {
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
            if (custom) return withCollisionHandling(joinPath(folderFor(cfg, skillFolder, skill), custom), cfg, folderId);
            suffix = '-' + String(phase.optional);
        } else if (skill && typeof skill.outputFileName === 'function') {
            const custom = String(skill.outputFileName(info) || '');
            if (custom) return withCollisionHandling(joinPath(folderFor(cfg, skillFolder, skill), custom), cfg, folderId);
        } else if (skill && skill.fileSuffix) {
            suffix = String(skill.fileSuffix);
        }

        const base = cfg.fileNameStyle === 'slug'
            ? slug + suffix + flatTag
            : cfg.fileNameStyle === 'slug-date'
                ? slug + flatTag + suffix + '-' + date
                : date + '-' + slug + flatTag + suffix;

        return withCollisionHandling(joinPath(folderFor(cfg, skillFolder), base + '.md'), cfg, folderId);
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
    function withCollisionHandling(path, cfg, folderId) {
        const policy = cfg && cfg.overwriteExistingFile;
        if (policy === 'overwrite' || policy === 'ask') return path;
        if (!fileExists(path, folderId)) return path;

        const dot = path.lastIndexOf('.');
        const stem = dot > 0 ? path.slice(0, dot) : path;
        const extension = dot > 0 ? path.slice(dot) : '';
        for (let index = 2; index < 1000; index += 1) {
            const candidate = stem + '-' + index + extension;
            if (!fileExists(candidate, folderId)) return candidate;
        }
        return stem + '-' + Date.now().toString(36) + extension;
    }

    /** Does a path already hold a document? Used by the 'ask' policy. */
    function fileExists(path, folderId) {
        const hasExplicitFolder = typeof folderId === 'string' && Boolean(folderId);
        if (hasExplicitFolder && !store.folders[folderId]) return false;
        const wantedFolder = hasExplicitFolder
            ? folderId
            : (store.folders[store.activeFolderId] ? store.activeFolderId : '');
        return Boolean(findFileEntry(path, wantedFolder, false));
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
        const entries = storedFileEntries().sort((left, right) => {
            const leftFolder = String(left.record.folder || '');
            const rightFolder = String(right.record.folder || '');
            return (leftFolder + '\u0000' + left.record.path).localeCompare(
                rightFolder + '\u0000' + right.record.path, undefined, { numeric: true });
        });
        // Labels and slash-joined display paths are not identities. For example,
        // root label "A/B" + "c.md" aliases root label "A" + "B/c.md". Keep a
        // machine-readable manifest in every export (including a one-file
        // project) so each body can always be traced to its immutable root id.
        const manifest = {
            format: 'codalio-blueprint-project-export',
            schemaVersion: 1,
            projectName: String(store.projectName || 'Untitled'),
            folders: listFolders().map(folder => ({
                folderId: String(folder.id || ''),
                label: String(folder.name || ''),
                kind: String(folder.kind || '')
            })),
            documents: entries.map((item, index) => {
                const record = item.record;
                const folder = store.folders[record.folder];
                return {
                    document: index + 1,
                    folderId: String(record.folder || ''),
                    folderLabel: String((folder && folder.name) || ''),
                    path: String(record.path || item.key || '')
                };
            })
        };
        const parts = [
            '# Blueprint project export',
            '',
            'Exported ' + new Date().toISOString(),
            '',
            'Project: ' + (store.projectName || 'Untitled'),
            'Documents: ' + entries.length,
            '',
            '## Identity manifest',
            '',
            '```json',
            JSON.stringify(manifest, null, 2),
            '```',
            '',
            '---',
            ''
        ];
        entries.forEach((item, index) => {
            const record = item.record;
            const folder = store.folders[record.folder];
            const qualifiedPath = `${folder ? folder.name : '(missing root)'}/${record.path || item.key}`;
            parts.push(`## Document ${index + 1}: ${qualifiedPath}`, '');
            parts.push(`- Project root ID: \`${String(record.folder || '')}\``);
            parts.push(`- Project root label: ${String((folder && folder.name) || '')}`);
            parts.push(`- Relative path: \`${String(record.path || item.key || '')}\``, '');
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
        PROJECTS_WRITE_LOCK_PREFIX,
        PENDING_CANCEL_PREFIX,
        RUN_OWNER_PREFIX,
        sessionId: storeWriterId,
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
        withStorageWriteLease,
        listFiles,
        readFile,
        fileRef,
        fileRefKey,
        fileSnapshot,
        fileMatchesSnapshot,
        writeFile,
        isReadOnlyFile,
        canEditFile,
        deleteFile,
        clearFiles,
        renameFile,
        updateFile,
        setOpenPath,
        DEFAULT_FOLDER_ID,
        listFolders,
        getFolder,
        activeFolder,
        folderSnapshot,
        folderMatchesSnapshot,
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
        isSensitiveSourcePath,
        sanitizeSourceForModel,
        CODE_EXTENSIONS,
        IMPLEMENTATION_EXTENSIONS,
        IMPORTABLE_EXTENSIONS,
        IMPORT_SKIP_DIRS,
        relativePathOf,
        extensionOf,
        suggestedFolderName,
        readWorkspaceRaw,
        saveWorkspace,
        clearWorkspace,
        storageRecoveryState,
        exportRecoverySnapshot,
        rememberPendingCancel,
        refreshPendingCancel,
        forgetPendingCancel,
        listPendingCancels,
        listPendingCancelRecords,
        readRunOwner,
        claimRunOwnership,
        bindRunOwnership,
        runLeaseId,
        refreshRunOwnership,
        releaseRunOwnership,
        isDomNode,
        withoutDomNodes,
        persistenceState,
        durableStorageState,
        hydrateFromDurableTier,
        isLocalStorageQuotaError,
        reloadStoreFromStorage,
        findRun,
        activeRun,
        selectRun,
        restoreSelection,
        reconcileWorkspaceSelection,
        saveRun,
        deleteRun,
        clearRuns,
        clearAllData,
        createRun,
        estimateTokens,
        buildDeterministicCompaction,
        renderMarkdown,
        appendInline,
        streamModelTurn,
        cancelTurn,
        cancelTurnOutcome,
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
