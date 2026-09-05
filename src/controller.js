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
    const CONTROLLER_DISPOSE_KEY = '__codalioBlueprintControllerDispose';
    // One backend can only safely service one Blueprint generation at a time.
    // Per-run leases fence callbacks that mutate a particular run, while this
    // synthetic owner also covers model compaction (including a chat with no
    // persisted run) and simultaneous starts for different runs/windows.
    const MODEL_OPERATION_OWNER_ID = '__codalio-blueprint-model-operation__';
    // Composer text is durable run metadata and can be copied into several model
    // prompts. Refuse pathological pastes before claiming a run lease or touching
    // storage; large source/spec material belongs in Project Files.
    const MAX_USER_REQUEST_CHARS = 32768;

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

    // The host intentionally rejects duplicate controller ids and does not expose
    // an unregister primitive. Make script injection idempotent: a development
    // re-evaluation keeps the already-registered live controller instead of first
    // detaching its handlers and then failing registration (or accumulating a
    // second delegated-listener closure).
    const priorControllerDispose = window[CONTROLLER_DISPOSE_KEY];
    if (typeof priorControllerDispose === 'function'
        || (window.codalioBlueprint && window.codalioBlueprint.pluginId === PLUGIN_ID)) {
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
    // which browsers commonly cap near 5 MB per origin. A 32 MB allowance could
    // never be honored and guaranteed a late quota failure after needless reads.
    //
    // The import now stops on a REAL limit and reports which one it hit:
    //   * the byte budget below (what the user can raise in Settings), or
    //   * the storage quota (a hard browser limit, reported as "storage full").
    // Unlimited by default; Infinity keeps importFolder()'s arithmetic simple.
    const IMPORT_MAX_FILES = Infinity;
    // Leave headroom for UTF-16/JSON overhead, run checkpoints, settings, and the
    // host's other origin data. Quota detection still remains the final authority.
    const IMPORT_MAX_TOTAL_KB = 2048;

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
        listPaneObserver: null,
        busy: false,
        // True only while a directory import is reading files. Separate from
        // `busy` (a model run) so the two cannot mask each other.
        busyImport: false,
        importController: null,
        importSettlement: null,
        importRenderTimer: null,
        draft: '',
        hint: '',
        showSettings: false,
        viewerMode: 'preview',
        editingPath: null,
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
        // Path context. A FileSystemDirectoryHandle CANNOT be persisted in the
        // workspace store (it is a live browser object, not data), so it lives
        // here for the session only. `pathContextRootName` mirrors the granted
        // root's name so the UI can still say which folder it needs re-picking
        // after a page reload, instead of showing a blank field.
        pathContextRoot: null,
        pathContextRootName: '',
        pathContextBusy: false,
        // Uncommitted text in the path field. Kept separate from settings so
        // typing does not re-render the composer on every keystroke (which would
        // reset the caret and lose focus mid-word).
        pathContextDraft: null,
        sourceFileMode: 'combine',
        fileSelector: {
            open: false,
            selectedPaths: new Set(),
            search: '',
            category: 'all',
            folderId: 'all',
            previewPath: null,
            reviewMode: 'combine'
        },
        modal: null,
        toast: null,
        toastTimer: null,
        pendingQuestion: null,
        isHistoryOpen: false,
        compaction: null,
        currentRun: null,
        currentController: null,
        // A model promise remains a potential writer until its complete catch /
        // finally chain settles, even after Stop or unmount has aborted it.
        executionSettlements: new Set(),
        runSelectionRestored: false,
        explicitNoRun: false,
        unacknowledgedCancelIds: new Set(typeof core.listPendingCancels === 'function'
            ? core.listPendingCancels({ recoverableOnly: true }) : []),
        foreignLiveRunIds: new Set(),
        foreignRecoveryTimer: null,
        foreignRecoveryPending: false,
        cancellationBarrierPromise: null,
        cancellationCheckBusy: false,
        recoveryPersistenceBlocked: false,
        externalRecoveryBlocked: false,
        workspaceRecoveryBlocked: false,
        // Host snapshots may arrive while an operation is streaming. Applying one
        // immediately would replace the active transcript beneath its callbacks,
        // so the latest sanitized snapshot waits until the owner has settled.
        pendingRestoreState: null,
        pendingExternalStoreChange: null,
        pendingExternalWorkspaceChange: null,
        generation: 0,
        streamAnchor: null
    };

    function createExecutionController(ownerRun, options) {
        const abort = new AbortController();
        const ownerRunId = ownerRun && ownerRun.id ? String(ownerRun.id) : '';
        const ownershipApi = typeof core.claimRunOwnership === 'function'
            && typeof core.readRunOwner === 'function';
        let globalOwnershipClaimed = !ownershipApi
            || core.claimRunOwnership(MODEL_OPERATION_OWNER_ID, { allowOwnedTakeover: false });
        const globalOwner = globalOwnershipClaimed && ownershipApi
            ? core.readRunOwner(MODEL_OPERATION_OWNER_ID) : null;
        const globalLeaseId = ownershipApi
            ? String((globalOwner && globalOwner.owned && globalOwner.live && globalOwner.leaseId) || '')
            : 'legacy';
        if (ownershipApi && !globalLeaseId) globalOwnershipClaimed = false;
        const reuseClaimed = Boolean(options && options.reuseClaimedOwnership);
        const boundLeaseId = reuseClaimed && ownerRun && typeof core.runLeaseId === 'function'
            ? core.runLeaseId(ownerRun) : '';
        const boundOwner = boundLeaseId && typeof core.readRunOwner === 'function'
            ? core.readRunOwner(ownerRunId) : null;
        const canReuseClaim = Boolean(boundLeaseId && boundOwner && boundOwner.owned
            && boundOwner.live && boundOwner.leaseId === boundLeaseId);
        const claimedFreshRun = Boolean(globalOwnershipClaimed && ownerRunId && !canReuseClaim
            && ownershipApi && core.claimRunOwnership(ownerRunId));
        let runOwnershipClaimed = globalOwnershipClaimed && (!ownerRunId || canReuseClaim
            || !ownershipApi || claimedFreshRun);
        const ownerLeaseId = ownerRunId && runOwnershipClaimed
            ? (canReuseClaim
                ? boundLeaseId
                : typeof core.bindRunOwnership === 'function'
                ? core.bindRunOwnership(ownerRun)
                : ((core.readRunOwner(ownerRunId) || {}).leaseId || 'legacy'))
            : '';
        if (ownerRunId && !ownerLeaseId) runOwnershipClaimed = false;
        let ownershipClaimed = Boolean(globalOwnershipClaimed && runOwnershipClaimed);
        if (!ownershipClaimed && claimedFreshRun && typeof core.releaseRunOwnership === 'function') {
            const claimedOwner = core.readRunOwner(ownerRunId);
            core.releaseRunOwnership(ownerRunId, String((claimedOwner && claimedOwner.leaseId) || ''));
        }
        if (!ownershipClaimed && globalOwnershipClaimed && ownershipApi
            && typeof core.releaseRunOwnership === 'function') {
            core.releaseRunOwnership(MODEL_OPERATION_OWNER_ID, globalLeaseId);
            globalOwnershipClaimed = false;
        }
        const execution = {
            abort,
            signal: abort.signal,
            ownerRun: ownerRun || null,
            ownerRunId,
            ownerLeaseId,
            globalOwnerId: MODEL_OPERATION_OWNER_ID,
            globalLeaseId,
            globalOwnershipClaimed,
            ownershipClaimed,
            ownershipTimer: null,
            cancelIds: new Set(),
            cancelLeases: new Map(),
            lastCancelId: '',
            stopping: false
        };
        if (ownershipClaimed && typeof core.refreshRunOwnership === 'function') {
            execution.ownershipTimer = setInterval(() => {
                const globalAlive = core.refreshRunOwnership(
                    MODEL_OPERATION_OWNER_ID, globalLeaseId
                );
                const runAlive = !ownerRunId
                    || core.refreshRunOwnership(ownerRunId, ownerLeaseId);
                if (globalAlive && runAlive) return;
                execution.persistenceFailure = new core.BlueprintModelError(
                    'This model operation lost its cross-window execution lease and was stopped before another window could take ownership.',
                    { code: 'run-owner-lost', retryable: false }
                );
                try { abort.abort(); } catch (_) { /* already stopped */ }
            }, 15000);
        }
        return execution;
    }

    function operationBusy() {
        return Boolean(runtime.busy || runtime.busyImport || runtime.cancellationCheckBusy
            || runtime.executionSettlements.size || runtime.foreignLiveRunIds.size
            || hasForeignPendingCancellation()
            || runtime.foreignRecoveryPending || recoveryBlocked());
    }

    function hasForeignPendingCancellation() {
        if (typeof core.listPendingCancelRecords !== 'function') return false;
        const now = Date.now();
        return core.listPendingCancelRecords().some(record => record.ownerId
            && record.ownerId !== core.sessionId && record.leaseExpiresAt > now);
    }

    function recoveryBlocked() {
        return Boolean(runtime.recoveryPersistenceBlocked || runtime.externalRecoveryBlocked
            || runtime.workspaceRecoveryBlocked);
    }

    function refreshForeignRunOwners() {
        const foreign = new Set();
        if (typeof core.readRunOwner === 'function') {
            const globalOwner = core.readRunOwner(MODEL_OPERATION_OWNER_ID);
            if (globalOwner && globalOwner.live && !globalOwner.owned) {
                foreign.add(MODEL_OPERATION_OWNER_ID);
            }
            (core.store.runs || []).forEach(run => {
                if (!run || !run.id || run.status !== 'running') return;
                const owner = core.readRunOwner(run.id);
                if (owner && owner.live && !owner.owned) foreign.add(String(run.id));
            });
        }
        runtime.foreignLiveRunIds = foreign;
        return foreign;
    }

    function hasRecoverableLeaseWork() {
        const orphanedRun = (core.store.runs || []).some(run => {
            if (!run || run.status !== 'running' || !run.id) return false;
            const owner = typeof core.readRunOwner === 'function'
                ? core.readRunOwner(run.id) : null;
            return !owner || !owner.live;
        });
        if (orphanedRun) return true;
        if (typeof core.listPendingCancelRecords !== 'function') return false;
        const now = Date.now();
        return core.listPendingCancelRecords().some(record => !record.ownerId
            || record.leaseExpiresAt <= now);
    }

    function scheduleForeignRunRecovery(forcePending) {
        if (runtime.foreignRecoveryTimer) {
            clearTimeout(runtime.foreignRecoveryTimer);
            runtime.foreignRecoveryTimer = null;
        }
        // Close the start gate synchronously. Without this assignment, a Send
        // click in the one-second recovery debounce could claim the just-expired
        // global lease while the old backend turn was still winding down.
        if (forcePending) runtime.foreignRecoveryPending = true;
        const expiries = [];
        if (typeof core.readRunOwner === 'function') {
            const globalOwner = core.readRunOwner(MODEL_OPERATION_OWNER_ID);
            if (globalOwner && globalOwner.live && !globalOwner.owned) {
                expiries.push(globalOwner.leaseExpiresAt);
            }
            (core.store.runs || []).forEach(run => {
                if (!run || run.status !== 'running') return;
                const owner = core.readRunOwner(run.id);
                if (owner && owner.live && !owner.owned) expiries.push(owner.leaseExpiresAt);
            });
        }
        if (typeof core.listPendingCancelRecords === 'function') {
            core.listPendingCancelRecords().forEach(record => {
                if (record.ownerId && record.ownerId !== core.sessionId
                    && record.leaseExpiresAt > Date.now()) expiries.push(record.leaseExpiresAt);
            });
        }
        if (!expiries.length && !forcePending && !runtime.foreignRecoveryPending) return;
        const delay = (forcePending || runtime.foreignRecoveryPending)
            ? 1000
            : Math.max(1, Math.min(...expiries) - Date.now() + 25);
        runtime.foreignRecoveryTimer = setTimeout(() => {
            runtime.foreignRecoveryTimer = null;
            if (runtime.busy || runtime.busyImport || runtime.cancellationCheckBusy
                || runtime.executionSettlements.size) {
                // The lease may already be expired, so a fresh expiry scan would
                // find nothing and silently lose recovery. Keep an independent
                // bounded retry armed until this window reaches an idle point.
                runtime.foreignRecoveryPending = true;
                scheduleForeignRunRecovery(true);
                return;
            }
            runtime.foreignRecoveryPending = false;
            recoverInterruptedRuns();
            refreshForeignRunOwners();
            if (runtime.mounted) {
                renderHostSurfaces();
                renderPage();
            }
            scheduleForeignRunRecovery();
        }, delay);
    }

    function onRunLeaseChange() {
        refreshForeignRunOwners();
        // pagehide expires leases immediately. That change removes them from the
        // future-expiry list, so explicitly queue recovery instead of cancelling
        // the old timer and leaving a durable "running" marker wedged forever.
        scheduleForeignRunRecovery(hasRecoverableLeaseWork());
        if (runtime.modal && runtime.modal.conflictSensitive && operationBusy()) {
            runtime.modal = null;
            setToast('That dialog closed because a Blueprint operation became active in another window.', 'warn');
        }
        if (runtime.mounted && !runtime.busy && !runtime.executionSettlements.size) {
            renderHostSurfaces();
            renderPage();
        }
    }

    function beginExecutionSettlement(execution, generation) {
        const token = { execution, generation };
        if (execution) execution.generation = generation;
        runtime.executionSettlements.add(token);
        return token;
    }

    function ownershipFenceReleased(ownerId, leaseId) {
        if (!ownerId || !leaseId || typeof core.readRunOwner !== 'function') return true;
        const current = core.readRunOwner(ownerId);
        // Missing or superseded is already fenced from this execution. Only an
        // exact still-owned token needs another cooperative release attempt.
        return !current || !current.owned || current.leaseId !== leaseId;
    }

    function releaseExecutionOwnership(execution, retriesLeft) {
        if (!execution || typeof core.releaseRunOwnership !== 'function') return;
        const remaining = Number.isFinite(retriesLeft) ? retriesLeft : 100;
        let pending = false;
        if (execution.ownerRunId && execution.ownershipClaimed) {
            const released = core.releaseRunOwnership(
                execution.ownerRunId, execution.ownerLeaseId
            );
            if (!released && !ownershipFenceReleased(
                execution.ownerRunId, execution.ownerLeaseId
            )) pending = true;
        }
        if (execution.globalOwnershipClaimed) {
            const released = core.releaseRunOwnership(
                execution.globalOwnerId, execution.globalLeaseId
            );
            if (!released && !ownershipFenceReleased(
                execution.globalOwnerId, execution.globalLeaseId
            )) pending = true;
        }
        if (!pending) {
            execution.ownershipClaimed = false;
            execution.globalOwnershipClaimed = false;
            execution.ownershipReleaseTimer = null;
            return;
        }
        if (remaining <= 0) return; // natural expiry remains the final fail-safe
        execution.ownershipReleaseTimer = setTimeout(() => {
            execution.ownershipReleaseTimer = null;
            releaseExecutionOwnership(execution, remaining - 1);
        }, 100);
    }

    function finishExecutionSettlement(token) {
        if (!token) return;
        const hadSettlements = runtime.executionSettlements.size > 0;
        runtime.executionSettlements.delete(token);
        const becameIdle = hadSettlements && runtime.executionSettlements.size === 0;
        const execution = token.execution;
        if (execution && execution.ownershipTimer) {
            clearInterval(execution.ownershipTimer);
            execution.ownershipTimer = null;
        }
        releaseExecutionOwnership(execution);
        if (!runtime.executionSettlements.size && execution
            && runtime.currentController === execution
            && token.generation !== runtime.generation) {
            runtime.busy = false;
            runtime.currentController = null;
            runtime.hint = '';
            stopLiveTicker();
        }
        // Let the owning async function finish its final transcript bookkeeping
        // before an external reload or host restore installs a different graph.
        setTimeout(() => {
            flushPendingRestoreState();
            // Stop/unmount may already have detached currentController before the
            // final writer settles. The busy snapshot still included this token,
            // so repaint once the last token is gone even when there was no
            // pending external reload to trigger a render for us.
            if (becameIdle && runtime.mounted) {
                renderHostSurfaces();
                renderPage();
            }
        }, 0);
    }

    function assertExecutionOwner(execution, generation) {
        const localOwner = generation === runtime.generation && runtime.currentController === execution;
        const durableGlobalOwner = !execution
            || typeof core.readRunOwner !== 'function'
            || (() => {
                const owner = core.readRunOwner(execution.globalOwnerId);
                return Boolean(owner && owner.owned && owner.live
                    && owner.leaseId === execution.globalLeaseId);
            })();
        const durableRunOwner = !execution || !execution.ownerRunId
            || typeof core.readRunOwner !== 'function'
            || (() => {
                const owner = core.readRunOwner(execution.ownerRunId);
                return Boolean(owner && owner.owned && owner.live
                    && owner.leaseId === execution.ownerLeaseId);
            })();
        if (localOwner && durableGlobalOwner && durableRunOwner) return;
        throw new core.BlueprintAbort('This execution no longer owns the active project state.');
    }

    function clearPendingCancelRecord(cancelId, expectedLeaseId) {
        if (typeof core.forgetPendingCancel !== 'function') return true;
        const id = String(cancelId || '');
        let leaseId = String(expectedLeaseId || '');
        if (!leaseId && typeof core.listPendingCancelRecords === 'function') {
            const record = core.listPendingCancelRecords().find(item => item
                && String(item.id) === id
                && (!item.ownerId || item.ownerId === core.sessionId));
            leaseId = String((record && record.leaseId) || '');
        }
        return core.forgetPendingCancel(id, leaseId);
    }

    function cancellationOutcomeTerminal(outcome) {
        return outcome === 'cancelled' || outcome === 'already-terminal';
    }

    async function ensureBackendIdle() {
        if (hasRecoverableLeaseWork()) {
            if (typeof core.listPendingCancels === 'function') {
                core.listPendingCancels({ recoverableOnly: true })
                    .forEach(id => runtime.unacknowledgedCancelIds.add(String(id)));
            }
            scheduleForeignRunRecovery(true);
            setToast('Recovering an interrupted Blueprint model turn before starting another one…', 'warn', 10000);
            return false;
        }
        const foreignRuns = refreshForeignRunOwners();
        const foreignCancels = typeof core.listPendingCancelRecords === 'function'
            ? core.listPendingCancelRecords().filter(record => record.ownerId
                && record.ownerId !== core.sessionId && record.leaseExpiresAt > Date.now())
            : [];
        if (foreignRuns.size || foreignCancels.length) {
            setToast('A Blueprint model run is active in another window. Wait for it to finish or close that window before starting another backend turn.', 'warn', 10000);
            return false;
        }
        const pending = [...runtime.unacknowledgedCancelIds];
        if (!pending.length) return true;
        if (runtime.cancellationBarrierPromise) return runtime.cancellationBarrierPromise;

        runtime.cancellationCheckBusy = true;
        runtime.hint = `Confirming ${pending.length} previous model turn${pending.length === 1 ? '' : 's'} stopped…`;
        renderHostSurfaces();
        renderPage();
        const check = Promise.all(pending.map(id => (typeof core.cancelTurnOutcome === 'function'
            ? core.cancelTurnOutcome(id, { timeoutMs: 5000 })
            : core.cancelTurn(id, { timeoutMs: 5000 }).then(ok => ok ? 'cancelled' : 'unknown'))))
            .then(results => {
                let durable = true;
                results.forEach((outcome, index) => {
                    if (cancellationOutcomeTerminal(outcome)) {
                        const id = pending[index];
                        if (!clearPendingCancelRecord(id)) {
                            durable = false;
                            return;
                        }
                        runtime.unacknowledgedCancelIds.delete(id);
                    }
                });
                const clear = runtime.unacknowledgedCancelIds.size === 0 && durable;
                if (!clear) {
                    setToast('The backend still has not acknowledged an earlier cancellation. Blueprint did not start another model turn; try again after the backend settles.', 'warn', 10000);
                }
                return clear;
            })
            .finally(() => {
                runtime.cancellationCheckBusy = false;
                runtime.cancellationBarrierPromise = null;
                if (!runtime.busy) runtime.hint = '';
                flushPendingRestoreState();
                renderHostSurfaces();
                renderPage();
            });
        runtime.cancellationBarrierPromise = check;
        return check;
    }

    function finishImportOperation(operation) {
        if (operation && runtime.importController !== operation) return;
        clearTimeout(runtime.importRenderTimer);
        runtime.importRenderTimer = null;
        runtime.busyImport = false;
        runtime.importProgress = null;
        runtime.importController = null;
        refreshImportList();
        // Let the import caller finish its final toast/tree bookkeeping first,
        // then apply the newest host snapshot that arrived during the import.
        void Promise.resolve().then(() => flushPendingRestoreState());
    }

    function refreshImportList() {
        if (!runtime.mounted || !runtime.active || runtime.folder !== 'cb-files') return;
        if (runtime.context && runtime.context.state && runtime.context.state.app !== APP_ID) return;
        const elements = hostElements();
        const list = elements && elements.listContent;
        if (!list) return;
        const scrollTop = list.scrollTop;
        const scrollLeft = list.scrollLeft;
        const render = runtime.context && runtime.context.render;
        try {
            if (render && typeof render.list === 'function') render.list();
            else ui.renderList(stateSnapshot(), elements.listTitle, list);
        } catch (error) {
            console.warn('[codalio-blueprint] import list refresh failed', error);
        }
        list.scrollTop = scrollTop;
        list.scrollLeft = scrollLeft;
    }

    function updateImportProgress(operation, progress) {
        if (runtime.importController !== operation || operation.signal.aborted) return;
        runtime.importProgress = progress;
        // Batch rapid discoveries without rebuilding the viewer, resetting its
        // editor, stealing composer focus, or opening a tab for every file.
        if (runtime.importRenderTimer !== null || !runtime.active) return;
        runtime.importRenderTimer = setTimeout(() => {
            runtime.importRenderTimer = null;
            if (runtime.importController === operation && runtime.busyImport) refreshImportList();
        }, 120);
    }

    function requestLifecycleHooks(controller) {
        return {
            onRequestStart(cancelId) {
                if (!controller || !cancelId) return;
                controller.cancelIds.add(cancelId);
                controller.lastCancelId = cancelId;
                // Kept for compatibility with older controller integrations.
                controller.cancelId = cancelId;
            },
            onRequestDispatched(cancelId, _step, info) {
                if (!controller || !cancelId) return false;
                try {
                    assertExecutionOwner(controller, controller.generation);
                } catch (_) {
                    return false;
                }
                const leaseId = String((info && info.cancelLeaseId) || '');
                if (leaseId) controller.cancelLeases.set(String(cancelId), leaseId);
                runtime.unacknowledgedCancelIds.add(String(cancelId));
                return true;
            },
            onRequestEnd(cancelId, _step, info) {
                if (!controller || !cancelId) return;
                controller.cancelIds.delete(cancelId);
                const detail = info && typeof info === 'object' ? info : {};
                if (detail.cancelAcknowledged === true
                    || detail.backendCancellationAcknowledged === true
                    || detail.backendTerminalAcknowledged === true
                    || detail.status === 'done') {
                    if (clearPendingCancelRecord(cancelId, detail.cancelLeaseId
                        || controller.cancelLeases.get(String(cancelId)))) {
                        runtime.unacknowledgedCancelIds.delete(cancelId);
                        controller.cancelLeases.delete(String(cancelId));
                    }
                    return;
                }
                // streamModelTurn owns the backend-liveness decision. Do not
                // duplicate an error-code allowlist here: a persistence hook,
                // parser, or future post-dispatch failure can also leave work
                // running remotely. Missing detail from an older core is treated
                // conservatively whenever the request was dispatched.
                if (detail.backendMayBeRunning === true
                    || (detail.dispatched === true && detail.backendMayBeRunning !== false)) {
                    runtime.unacknowledgedCancelIds.add(String(cancelId));
                    return;
                }
                // A definitive HTTP/provider terminal failure cannot still be
                // generating. Clear its pre-dispatch ledger entry as well.
                if (clearPendingCancelRecord(cancelId, detail.cancelLeaseId
                    || controller.cancelLeases.get(String(cancelId)))) {
                    runtime.unacknowledgedCancelIds.delete(cancelId);
                    controller.cancelLeases.delete(String(cancelId));
                }
            }
        };
    }

    function settleRunLocally(run, status, message) {
        if (!run) return false;
        (run.phases || []).forEach(step => {
            if (!step) return;
            if (step.status === 'pending') {
                step.status = 'skipped';
                step.streaming = false;
                step.substatus = '';
                return;
            }
            if (step.status !== 'running') return;
            step.status = status;
            step.streaming = false;
            step.substatus = '';
            step.liveElement = null;
            step.liveThinkingElement = null;
            if (!step.error && message) step.error = message;
            if (step.startedAt) step.elapsedMs = Date.now() - step.startedAt;
        });
        (run.pipeline || []).forEach(item => {
            if (!item) return;
            if (item.status === 'running') item.status = status;
            else if (item.status === 'pending') item.status = 'skipped';
        });
        run.status = status;
        run.error = message || '';
        run.completedAt = new Date().toISOString();
        return core.saveRun(run);
    }

    function recoverInterruptedRuns() {
        if (runtime.busy) return;
        let recoveryDurable = true;
        const recoveryCancelIds = new Set();
        const reservedRecoveryCancelLeases = new Map();
        const cancelRecords = typeof core.listPendingCancelRecords === 'function'
            ? core.listPendingCancelRecords() : [];
        const foreignLiveCancelIds = new Set(cancelRecords
            .filter(record => record.ownerId && record.ownerId !== core.sessionId
                && record.leaseExpiresAt > Date.now())
            .map(record => String(record.id)));
        cancelRecords.forEach(record => {
            if (!foreignLiveCancelIds.has(String(record.id))) recoveryCancelIds.add(String(record.id));
        });
        runtime.foreignLiveRunIds = new Set();
        if (typeof core.readRunOwner === 'function') {
            const globalOwner = core.readRunOwner(MODEL_OPERATION_OWNER_ID);
            if (globalOwner && globalOwner.live && !globalOwner.owned) {
                runtime.foreignLiveRunIds.add(MODEL_OPERATION_OWNER_ID);
            }
        }
        (core.store.runs || []).forEach(run => {
            if (!run || run.status !== 'running') return;
            const owner = typeof core.readRunOwner === 'function' ? core.readRunOwner(run.id) : null;
            const runCancelIds = (run.phases || [])
                .filter(step => step && step.status === 'running' && step.cancelId)
                .map(step => String(step.cancelId));
            if ((owner && owner.live && !owner.owned)
                || runCancelIds.some(id => foreignLiveCancelIds.has(id))) {
                runtime.foreignLiveRunIds.add(String(run.id));
                runCancelIds.forEach(id => recoveryCancelIds.delete(id));
                return;
            }
            if (typeof core.claimRunOwnership === 'function' && !core.claimRunOwnership(run.id)) {
                const currentOwner = typeof core.readRunOwner === 'function'
                    ? core.readRunOwner(run.id) : null;
                if (currentOwner && currentOwner.live && !currentOwner.owned) {
                    runtime.foreignLiveRunIds.add(String(run.id));
                    runCancelIds.forEach(id => recoveryCancelIds.delete(id));
                } else {
                    // A short-lived storage transaction can prevent the claim
                    // even when no foreign run owns it. Keep the global start
                    // gate closed and retry; classifying this as a foreign live
                    // run would leave it wedged forever with no future expiry.
                    runtime.foreignRecoveryPending = true;
                    runCancelIds.forEach(id => recoveryCancelIds.add(id));
                }
                return;
            }
            const recoveryRunLeaseId = typeof core.runLeaseId === 'function'
                ? core.runLeaseId(run) : String(((typeof core.readRunOwner === 'function'
                    && core.readRunOwner(run.id)) || {}).leaseId || '');
            // Establish the backend-cancellation ledger before changing the run
            // from running to interrupted or releasing its execution fence. This
            // preserves one continuous cross-window exclusion signal: a second
            // window sees either the running run owner or the pending cancel.
            let cancellationHandoffDurable = true;
            runCancelIds.forEach(id => {
                const cancelLeaseId = typeof core.rememberPendingCancel === 'function'
                    ? core.rememberPendingCancel(id, {
                        runId: run.id,
                        runLeaseId: recoveryRunLeaseId
                    }) : '';
                if (!cancelLeaseId) {
                    cancellationHandoffDurable = false;
                    return;
                }
                reservedRecoveryCancelLeases.set(id, cancelLeaseId);
                recoveryCancelIds.add(id);
            });
            if (!cancellationHandoffDurable) {
                // Do not terminalize or release the run: its live exact lease is
                // still the only durable barrier for any id whose ledger write
                // was contended. The forced retry renews/rebuilds the handoff.
                runtime.foreignRecoveryPending = true;
                runCancelIds.forEach(id => recoveryCancelIds.add(id));
                return;
            }
            (run.phases || []).forEach(step => {
                if (step && step.status === 'running' && step.cancelId) {
                    recoveryCancelIds.add(String(step.cancelId));
                }
            });
            const settled = settleRunLocally(
                run, 'interrupted', 'The app closed or reloaded before this run completed.'
            );
            recoveryDurable = settled && recoveryDurable;
            if (settled && typeof core.releaseRunOwnership === 'function') {
                core.releaseRunOwnership(run.id, recoveryRunLeaseId);
            }
        });
        runtime.recoveryPersistenceBlocked = !recoveryDurable;
        if (!recoveryDurable) {
            runtime.hint = 'Recovery could not be saved. Export any visible partial output, then reload before starting another run.';
            setToast(runtime.hint, 'error', 12000);
        }
        if (recoveryCancelIds.size) {
            recoveryCancelIds.forEach(id => {
                runtime.unacknowledgedCancelIds.add(id);
                const alreadyReserved = reservedRecoveryCancelLeases.has(id);
                if (!alreadyReserved && typeof core.rememberPendingCancel === 'function'
                    && !core.rememberPendingCancel(id)) {
                    runtime.foreignRecoveryPending = true;
                }
            });
            void ensureBackendIdle();
        }
        scheduleForeignRunRecovery();
    }

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
        compactContext: opts => compactContext(opts),
        openFileSelector: opts => openFileSelectorOverlay(opts),
        closeFileSelector: () => closeFileSelectorOverlay(),
        toggleAttachedMode: () => toggleAttachedMode(),
        fsoSetMode: mode => fsoSetMode(mode),
        fsoToggleFile: (path, opts) => fsoToggleFile(path, opts),
        fsoSelectAll: () => fsoSelectAllFiltered(),
        fsoDeselectAll: () => fsoDeselectAll(),
        fsoInvert: () => fsoInvertSelection(),
        fsoFillBudget: () => fsoFillBudget(),
        fsoSelectExt: ext => fsoSelectExt(ext),
        fsoSelectDir: dir => fsoSelectDir(dir),
        fsoDeselectDir: dir => fsoDeselectDir(dir),
        fsoHandleBulkFiles: files => fsoHandleBulkFiles(files),
        fsoConfirm: () => fsoConfirmSelection(),
        fsoReviewNow: () => fsoReviewNow()
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
        if (raw && typeof core.reconcileWorkspaceSelection === 'function') {
            const reconciliation = core.reconcileWorkspaceSelection(runtime.workspace);
            if (!reconciliation || reconciliation.ok !== true) {
                // Keep the live surface internally coherent even if storage is
                // unavailable: fall back to the root-neutral Agent tab and block
                // new work until reload can retry the durable reconciliation.
                ws.activateTab(runtime.workspace, ws.AGENT_TAB_ID);
                runtime.recoveryPersistenceBlocked = true;
                runtime.hint = `A crash-interrupted tab change could not be reconciled (${String(
                    (reconciliation && reconciliation.error) || 'project storage unavailable'
                )}). Reload before starting more work.`;
            }
        }
    }

    function persistWorkspace() {
        if (!runtime.workspace) return false;
        return core.saveWorkspace(runtime.workspace);
    }

    function cloneWorkspaceState(workspace) {
        if (!workspace) return null;
        try { return JSON.parse(JSON.stringify(workspace)); } catch (_) { return null; }
    }

    function projectSelectionSnapshot() {
        return {
            activeFolderId: String(core.store.activeFolderId || ''),
            openPath: String(core.store.openPath || ''),
            openFolderId: String(core.store.openFolderId || ''),
            activeRunId: String(core.store.activeRunId || '')
        };
    }

    function restoreWorkspaceRuntime(snapshot) {
        if (snapshot) runtime.workspace = snapshot;
        syncFolderFromTab();
    }

    /**
     * Mutate the tab graph with enough state to roll the entire graph back when
     * either persistence key refuses the change. A single previousTabId is not
     * sufficient because opening a tab can evict an LRU sibling.
     */
    function commitWorkspaceMutation(mutator, options) {
        if (!runtime.workspace || typeof mutator !== 'function') return false;
        const beforeWorkspace = cloneWorkspaceState(runtime.workspace);
        const beforeSelection = projectSelectionSnapshot();
        if (!beforeWorkspace) {
            setToast('The current tab layout could not be snapshotted safely.', 'error', 8000);
            return false;
        }
        try { mutator(runtime.workspace); } catch (error) {
            restoreWorkspaceRuntime(beforeWorkspace);
            setToast(`The tab change failed: ${String((error && error.message) || error)}`, 'error', 8000);
            return false;
        }
        return afterWorkspaceChange(beforeWorkspace, beforeSelection, options);
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
        commitWorkspaceMutation(workspace => ws.activateTab(workspace, tabId));
    }

    function openSectionTab(sectionId) {
        const ws = wsModule();
        if (!ws || !runtime.workspace) {
            goToSection(sectionId);
            return;
        }
        commitWorkspaceMutation(workspace => ws.openSection(workspace, sectionId, core.readSettings()));
    }

    function openFileTab(path, folderId) {
        const owner = folderId || currentFolderId();
        const ws = wsModule();
        if (!ws || !runtime.workspace) {
            core.restoreSelection({ activeFolderId: owner, openPath: path, openFolderId: owner });
            goToSection('cb-files');
            return;
        }
        commitWorkspaceMutation(workspace => ws.openFile(workspace, path, core.readSettings(), true, owner));
    }

    function closeTabById(tabId) {
        const ws = wsModule();
        if (!ws || !runtime.workspace) return;
        commitWorkspaceMutation(workspace => ws.closeTab(workspace, tabId, core.readSettings()));
    }

    /** One place every tab mutation lands: sync, persist, re-render. */
    function afterWorkspaceChange(beforeWorkspace, beforeSelection, options) {
        syncFolderFromTab();
        const ws = wsModule();
        const tab = ws && runtime.workspace ? ws.activeTab(runtime.workspace) : null;
        if (tab && tab.kind === 'file') {
            const owner = String(tab.folderId || '');
            if (!owner || !core.readFile(tab.path, owner)) {
                restoreWorkspaceRuntime(beforeWorkspace);
                setToast('That file tab no longer belongs to an available project file.', 'error', 8000);
                renderHostSurfaces();
                renderPage();
                return false;
            }
        }
        // Commit the workspace first. If it fails, the project selection has not
        // moved yet, so both durable keys and the complete runtime graph remain at
        // the prior tab. This is the common quota/corruption failure path.
        if (!persistWorkspace()) {
            if (!(options && options.retainOnWorkspaceFailure === true)) {
                restoreWorkspaceRuntime(beforeWorkspace);
            }
            setToast(options && options.retainOnWorkspaceFailure === true
                ? 'The project change was saved, but its tab update was not. The current view was kept and reload will discard stale saved tabs.'
                : 'The tab change could not be saved, so the previous tab layout was restored.', 'error', 10000);
            renderHostSurfaces();
            renderPage();
            return false;
        }
        if (tab && tab.kind === 'file') {
            const owner = String(tab.folderId || '');
            if (!core.restoreSelection({
                activeFolderId: owner,
                openPath: tab.path,
                openFolderId: owner
            })) {
                const workspaceRolledBack = beforeWorkspace
                    ? core.saveWorkspace(beforeWorkspace)
                    : false;
                restoreWorkspaceRuntime(beforeWorkspace);
                // restoreSelection is itself transactional and already restored
                // its live tuple. Re-assert the snapshot only if a caller changed
                // selection before entering this helper.
                const selectionRolledBack = beforeSelection
                    ? core.restoreSelection(beforeSelection)
                    : true;
                if (!workspaceRolledBack || !selectionRolledBack) {
                    runtime.recoveryPersistenceBlocked = true;
                    runtime.hint = 'A tab change was only partly saved. Reload before starting more work so the two persisted views can be reconciled safely.';
                }
                setToast(runtime.recoveryPersistenceBlocked
                    ? runtime.hint
                    : 'That file tab could not save its project selection, so the previous tab layout was restored.', 'error', 10000);
                renderHostSurfaces();
                renderPage();
                return false;
            }
        }
        renderHostSurfaces();
        renderPage();
        return true;
    }

    // ------------------------------------------------------------------
    // Host plugin record (gates page visibility)
    // ------------------------------------------------------------------

    function readHostRecords() {
        try {
            const raw = window.localStorage.getItem(HOST_STORAGE_KEY);
            if (!raw) return { raw: null, records: [], error: '' };
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                return { raw, records: null, error: 'The host plug-in registry is malformed.' };
            }
            return { raw, records: parsed, error: '' };
        } catch (error) {
            return {
                raw: null,
                records: null,
                error: `The host plug-in registry could not be parsed (${String((error && error.message) || error)}).`
            };
        }
    }

    function writeHostRecords(records, expectedRaw) {
        try {
            if (window.localStorage.getItem(HOST_STORAGE_KEY) !== expectedRaw) return false;
            const serialized = JSON.stringify(records);
            window.localStorage.setItem(HOST_STORAGE_KEY, serialized);
            return window.localStorage.getItem(HOST_STORAGE_KEY) === serialized;
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
        const mutate = () => {
            const snapshot = readHostRecords();
            if (snapshot.error || !snapshot.records) {
                console.warn('[codalio-blueprint] refusing to overwrite the host plug-in registry:', snapshot.error);
                return false;
            }
            const records = snapshot.records.map(record => record && typeof record === 'object'
                ? Object.assign({}, record) : record);
            const existing = records.find(record => record && record.id === PLUGIN_ID);
            if (existing) {
                let changed = false;
                // Explicit host/user disablement is authoritative. Only repair
                // metadata that is absent; never self-reactivate on reload.
                if (!Object.prototype.hasOwnProperty.call(existing, 'enabled')) {
                    existing.enabled = true;
                    changed = true;
                }
                if (!Object.prototype.hasOwnProperty.call(existing, 'status')) {
                    existing.status = 'running';
                    changed = true;
                }
                if (existing.runtimeBacked !== true) { existing.runtimeBacked = true; changed = true; }
                if (!existing.runtimePage) { existing.runtimePage = APP_ID; changed = true; }
                return !changed || writeHostRecords(records, snapshot.raw);
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
            return writeHostRecords(records, snapshot.raw);
        };
        return typeof core.withStorageWriteLease === 'function'
            ? core.withStorageWriteLease(mutate)
            : mutate();
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function currentFolderId() {
        return (core.store && core.store.activeFolderId) || core.DEFAULT_FOLDER_ID;
    }

    function activeSourceFiles(folderOverride) {
        const folderId = String(folderOverride || currentFolderId());
        return (runtime.sourceFiles || []).map(file => {
            if (!file) return false;
            const requestedOwner = String(file.folderId || file.folder || folderId);
            const stored = file.path ? core.readFile(file.path, requestedOwner) : null;
            if (!stored) return null;
            const owner = String(stored.folder || requestedOwner);
            // Legacy transient attachments had no owner. Keep them visible in
            // the current folder rather than deleting user state on upgrade.
            if (owner && owner !== folderId) return null;
            // The VFS record is authoritative. Transient attachment bodies can
            // become stale after an edit, rename, deletion, or host-state restore.
            return Object.assign({}, file, {
                path: String(stored.path || file.path || ''),
                content: String(stored.content || ''),
                folderId: owner || folderId
            });
        }).filter(Boolean);
    }

    /**
     * The path-context instruction for a run: { enabled, path, rootHandle }.
     *
     * Enabled + a non-empty path + a live granted handle are all required. A
     * handle is lost on page reload (it cannot be persisted), so this returns
     * `rootHandle: null` in that case and the source gate reports the missing
     * grant instead of silently reading nothing. The typed path itself IS
     * persisted in settings, so only the grant needs re-picking.
     */
    function pathContextForRun() {
        const settings = core.readSettings();
        const enabled = settings.pathContextEnabled === true;
        const path = String(settings.pathContextPath || '').trim();
        if (!enabled || !path) return { enabled: false, path: '', rootHandle: null, rootName: '' };
        return {
            enabled: true,
            path,
            rootHandle: runtime.pathContextRoot || null,
            rootName: String(runtime.pathContextRootName || '')
        };
    }

    function stateSnapshot() {
        // v1/v2 workspace state keyed expanded directories only by relative path.
        // Expand that intent into one independent key per root exactly once.
        const legacyExpanded = [...runtime.expanded].filter(key => !String(key).startsWith('path:'));
        if (legacyExpanded.length && ui.folderPathKey) {
            legacyExpanded.forEach(path => {
                runtime.expanded.delete(path);
                core.listFolders().forEach(folder => {
                    runtime.expanded.add(ui.folderPathKey(folder.id, path));
                });
            });
        }
        const settings = core.readSettings();
        const folders = core.listFolders();
        const activeFolder = core.activeFolder();
        return {
            folder: runtime.folder,
            busy: Boolean(runtime.busy || runtime.executionSettlements.size || runtime.foreignLiveRunIds.size),
            // Neither was in the snapshot, so the UI could not see that an import
            // was running at all — the busy state was set and rendered, then drawn
            // from a snapshot that did not carry it.
            busyImport: runtime.busyImport,
            cancellationCheckBusy: runtime.cancellationCheckBusy,
            recoveryPersistenceBlocked: recoveryBlocked(),
            pendingBackendCancellations: runtime.unacknowledgedCancelIds.size,
            importProgress: runtime.importProgress,
            draft: runtime.draft,
            maxUserRequestChars: MAX_USER_REQUEST_CHARS,
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
                ? wsViewerMode(core.store.openPath, settings, core.store.openFolderId)
                : runtime.viewerMode,
            editingPath: runtime.editingPath || null,
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
            projectFiles: core.listFiles(activeFolder ? activeFolder.id : undefined),
            sourceFiles: activeSourceFiles(),
            // Path context for the Agent-page bar. `hasGrant` distinguishes
            // "you have not picked a folder yet" from "the page reloaded and the
            // grant was lost" — the two need different instructions, and a lost
            // grant must never look like a silently empty context.
            pathContextEnabled: settings.pathContextEnabled === true,
            pathContextPath: String(settings.pathContextPath || ''),
            pathContextRootName: String(runtime.pathContextRootName || ''),
            pathContextHasGrant: Boolean(runtime.pathContextRoot),
            pathContextBusy: Boolean(runtime.pathContextBusy),
            // The uncommitted field text, so a re-render triggered by something
            // else cannot wipe what the user is mid-way through typing.
            pathContextDraft: runtime.pathContextDraft,
            // Gemini's file selector overlay reads these two keys straight off the
            // host-surface state (ui.renderFileSelectorOverlay at src/ui.js).
            // Sol already owns runtime.fileSelector / runtime.sourceFileMode and
            // every handler for them; only this snapshot handoff was missing, so
            // without these keys the overlay renders from its internal defaults
            // and search/category/bulk-selection state resets on every re-render.
            sourceFileMode: runtime.sourceFileMode || 'combine',
            fileSelector: runtime.fileSelector || null,
            openPath: core.store.openPath,
            openFolderId: core.store.openFolderId,
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
    function wsViewerMode(path, settings, folderId) {
        const ws = wsModule();
        if (ws && runtime.workspace) return ws.viewerModeFor(runtime.workspace, path, settings, folderId);
        return settings.defaultViewerMode === 'source' ? 'source' : 'preview';
    }

    function renderPage() {
        const elements = hostElements();
        if (!elements || !elements.settingsContainer) return;
        if (!runtime.active) return;
        if (runtime.context && runtime.context.state && runtime.context.state.app !== APP_ID) return;

        const container = elements.settingsContainer;
        let searchFocusPos = null;
        if (runtime.fileSelector && runtime.fileSelector.open) {
            const currentSearch = container.querySelector('[data-cb-role="fso-search"]');
            if (currentSearch && document.activeElement === currentSearch) {
                searchFocusPos = typeof currentSearch.selectionStart === 'number' ? currentSearch.selectionStart : currentSearch.value.length;
            }
        }

        const previousScroll = captureScroll();
        container.innerHTML = '';

        ensureWorkspace();
        const snapshot = stateSnapshot();

        // The reading pane is the tabbed workspace: strip + active panel.
        container.appendChild(ui.renderWorkspace(snapshot));

        if (runtime.fileSelector && runtime.fileSelector.open) {
            container.appendChild(ui.renderFileSelectorOverlay(snapshot));
            if (searchFocusPos !== null) {
                const newSearch = container.querySelector('[data-cb-role="fso-search"]');
                if (newSearch) {
                    newSearch.focus();
                    try { newSearch.setSelectionRange(searchFocusPos, searchFocusPos); } catch (_) {}
                }
            }
        }
        if (runtime.modal) container.appendChild(ui.renderModal(snapshot));
        if (runtime.toast) container.appendChild(ui.renderToast(snapshot));

        restoreScroll(previousScroll);
        bindDividerDrag(container);
        if (!runtime.busy && isAgentTabActive() && !runtime.modal && (!runtime.fileSelector || !runtime.fileSelector.open)) {
            focusComposer(true);
        }
    }

    /**
     * Expand every folder leading to a path, so a newly written document is
     * visible in the tree. Honours Settings -> Workspace -> Layout ->
     * "Expand folders a run writes to".
     */
    function expandFoldersFor(path, folderId) {
        const settings = core.readSettings();
        if (settings.autoExpandWrittenFolders === false) return;
        const parts = String(path || '').split('/');
        parts.pop();
        let walked = [];
        parts.forEach(part => {
            walked = walked.concat([part]);
            const directory = walked.join('/');
            runtime.expanded.add(ui.folderPathKey
                ? ui.folderPathKey(folderId || currentFolderId(), directory)
                : directory);
        });
    }

    /** A document was written: open or refresh its tab per settings. */
    function noteFileWritten(path, folderId) {
        if (!path) return;
        const owner = folderId || currentFolderId();
        const ws = wsModule();
        expandFoldersFor(path, owner);
        if (ws && runtime.workspace) {
            commitWorkspaceMutation(
                workspace => ws.onFileWritten(workspace, path, core.readSettings(), owner),
                { retainOnWorkspaceFailure: true }
            );
        }
    }

    /** A document was deleted: drop its tab per settings. */
    function noteFileDeleted(path, folderId) {
        if (!path) return;
        const owner = folderId || currentFolderId();
        const ws = wsModule();
        if (ws && runtime.workspace) {
            commitWorkspaceMutation(
                workspace => ws.onFileDeleted(workspace, path, core.readSettings(), owner),
                { retainOnWorkspaceFailure: true }
            );
        }
        if (core.store.openPath === path && core.store.openFolderId === owner) core.setOpenPath('');
    }

    /** A document was renamed: move its tab and per-path viewer mode. */
    function noteFileRenamed(oldPath, newPath, folderId) {
        if (!oldPath || !newPath || oldPath === newPath) return;
        const owner = String(folderId || currentFolderId());
        runtime.sourceFiles = (runtime.sourceFiles || []).map(file => {
            if (!file || file.path !== oldPath) return file;
            const fileOwner = String(file.folderId || file.folder || owner);
            return fileOwner === owner
                ? Object.assign({}, file, { path: newPath, folderId: owner })
                : file;
        });

        const originalOwners = core.listFolders()
            .filter(folder => core.readFile(oldPath, folder.id))
            .map(folder => folder.id);
        // updateFile has already moved the selected owner, so add it back to the
        // pre-rename identity set before deciding whether an ownerless reference
        // is unambiguous.
        if (!originalOwners.includes(owner)) originalOwners.push(owner);
        const unambiguousOriginalOwner = originalOwners.length === 1 ? owner : '';
        const replaceRefs = (holder, inheritedOwner) => {
            if (!holder || typeof holder !== 'object') return false;
            let changed = false;
            const holderOwner = String(holder.folderId || inheritedOwner || '');
            if (Array.isArray(holder.writtenFiles)) {
                holder.writtenFiles.forEach(ref => {
                    if (!ref || ref.path !== oldPath) return;
                    const refOwner = String(ref.folderId || holderOwner || unambiguousOriginalOwner);
                    if (refOwner !== owner) return;
                    ref.path = newPath;
                    ref.folderId = owner;
                    changed = true;
                });
            }
            if (String(holderOwner || unambiguousOriginalOwner) === owner && Array.isArray(holder.writtenPaths)) {
                holder.writtenPaths = holder.writtenPaths.map(item => {
                    if (item !== oldPath) return item;
                    changed = true;
                    return newPath;
                });
            }
            if (String(holderOwner || unambiguousOriginalOwner) === owner && Array.isArray(holder.paths)) {
                holder.paths = holder.paths.map(item => {
                    if (item !== oldPath) return item;
                    changed = true;
                    return newPath;
                });
            }
            if (holder.targetPath === oldPath
                && String(holder.targetFolderId || holderOwner || unambiguousOriginalOwner) === owner) {
                holder.targetPath = newPath;
                changed = true;
            }
            if (Array.isArray(holder.reviews)) {
                holder.reviews.forEach(review => {
                    if (review && review.path === oldPath
                        && String(review.folderId || holderOwner || unambiguousOriginalOwner) === owner) {
                        review.path = newPath;
                        review.folderId = owner;
                        changed = true;
                    }
                });
            }
            if (Array.isArray(holder.phases)) {
                holder.phases.forEach(step => {
                    if (step && step.reviewPath === oldPath
                        && String(step.reviewFolderId || holderOwner || unambiguousOriginalOwner) === owner) {
                        step.reviewPath = newPath;
                        step.reviewFolderId = owner;
                        changed = true;
                    }
                });
            }
            return changed;
        };

        // Durable run references were already rewritten in updateFile's single
        // project-store transaction. Only the detached live transcript needs a
        // matching in-memory update here; a second store write would reintroduce
        // a split commit.
        (runtime.messages || []).forEach(message => {
            const messageRun = message && message.runId ? core.findRun(String(message.runId)) : null;
            replaceRefs(message, (messageRun && messageRun.folderId)
                || (runtime.currentRun && runtime.currentRun.folderId) || '');
        });

        const ws = wsModule();
        if (ws && runtime.workspace) {
            commitWorkspaceMutation(
                workspace => ws.onFileRenamed(workspace, oldPath, newPath, core.readSettings(), owner),
                { retainOnWorkspaceFailure: true }
            );
        }
    }

    /**
     * Apply sidebar width to host list pane. If host uses CSS variables
     * (--list-pane-width), update the variable; otherwise set inline styles.
     * When host list pane is collapsed (.list-pane-collapsed), this function
     * leaves the collapsed inline styles and CSS variables untouched.
     */
    function applyListPaneWidth(width) {
        const elements = hostElements();
        const listPane = (elements && elements.listPane) || document.getElementById('list-pane');
        if (!listPane) return;
        const hostToggle = (elements && elements.listPaneToggle) || document.getElementById('list-pane-toggle');
        const mainBody = (elements && elements.mainBody) || document.querySelector('.main-body');
        if (mainBody && mainBody.classList.contains('list-pane-collapsed')) {
            return;
        }
        const numeric = Number(width);
        const clamped = Math.min(640, Math.max(220, Number.isFinite(numeric) ? Math.round(numeric) : 320));
        if (hostToggle) {
            listPane.style.setProperty('--list-pane-width', `${clamped}px`);
            if (mainBody) mainBody.style.setProperty('--list-pane-width', `${clamped}px`);
        } else {
            listPane.style.width = `${clamped}px`;
            listPane.style.flex = `0 0 ${clamped}px`;
        }
    }

    /**
     * Remove the divider and undo the inline width we set on the host list pane.
     * Must run whenever the page is left, or the drag handle leaks into other
     * apps (Journal, Settings, ...) and the pane keeps Blueprint's width.
     * In environments with host #list-pane-toggle, we NEVER clear inline styles,
     * so host's collapse state (width: 0px, flex: 0 0 0px) remains intact.
     */
    function releaseDivider() {
        const elements = hostElements();
        const listPane = elements && elements.listPane
            ? elements.listPane
            : document.getElementById('list-pane');
        const hostToggle = (elements && elements.listPaneToggle) || document.getElementById('list-pane-toggle');
        if (runtime.listPaneObserver) {
            try { runtime.listPaneObserver.disconnect(); } catch (_) { /* already gone */ }
            runtime.listPaneObserver = null;
        }
        if (runtime.dividerElement) {
            try { runtime.dividerElement.remove(); } catch (_) { /* already gone */ }
            runtime.dividerElement = null;
        }
        runtime.dividerBound = false;
        runtime.dividerWidth = 0;
        if (listPane && !hostToggle) {
            listPane.style.width = '';
            listPane.style.flex = '';
            delete listPane.dataset.cbWidthApplied;
        }
    }

    /**
     * Drag-to-resize the host list pane.
     * In SimpleRAG, #list-pane-toggle already acts as the draggable resize handle
     * and collapse button. In that environment, injecting a duplicate .cb-divider
     * or hardcoding inline style.width/style.flex breaks host resizing and collapse!
     * When hostToggle is present, we harmonize with the host's CSS variable and
     * observe width changes without triggering destructive workspace re-renders.
     * When absent (test harnesses/standalone), we provide the fallback .cb-divider.
     */
    function bindDividerDrag(container) {
        if (!container) return;
        const settings = core.readSettings();
        const elements = hostElements();
        const listPane = elements && elements.listPane
            ? elements.listPane
            : document.getElementById('list-pane');
        if (!listPane || !listPane.parentNode) return;

        const hostToggle = (elements && elements.listPaneToggle) || document.getElementById('list-pane-toggle');
        const mainBody = (elements && elements.mainBody) || document.querySelector('.main-body');
        if (hostToggle) {
            // Remove any obsolete .cb-divider that may have been previously injected
            if (runtime.dividerElement) {
                try { runtime.dividerElement.remove(); } catch (_) {}
                runtime.dividerElement = null;
            }
            runtime.dividerBound = false;

            const isCollapsed = Boolean(mainBody && mainBody.classList.contains('list-pane-collapsed'));
            if (!isCollapsed) {
                let hostWidth = 0;
                try {
                    const saved = Number.parseInt(localStorage.getItem('signalLifeListPaneWidth'), 10);
                    if (Number.isFinite(saved) && saved >= 220 && saved <= 640) hostWidth = saved;
                } catch (_) {}
                const targetWidth = hostWidth || settings.listPaneWidth || 320;
                // Clear any leftover fallback-divider inline styles on listPane, but ONLY when not collapsed
                listPane.style.width = '';
                listPane.style.flex = '';
                delete listPane.dataset.cbWidthApplied;
                applyListPaneWidth(targetWidth);
                if (settings.listPaneWidth !== targetWidth) {
                    settings.listPaneWidth = targetWidth;
                    core.writeSettings(settings);
                }
            }

            if (!runtime.listPaneObserver && typeof ResizeObserver !== 'undefined') {
                let resizeDebounce = null;
                runtime.listPaneObserver = new ResizeObserver(entries => {
                    for (const entry of entries) {
                        const width = Math.round(entry.contentRect?.width || entry.target?.getBoundingClientRect().width || 0);
                        if (width < 80) return; // ignore collapsed states
                        const bounded = Math.round(Math.min(640, Math.max(220, width)));
                        runtime.dividerWidth = bounded;
                        if (resizeDebounce) clearTimeout(resizeDebounce);
                        resizeDebounce = setTimeout(() => {
                            const current = core.readSettings();
                            if (current.listPaneWidth !== bounded) {
                                current.listPaneWidth = bounded;
                                core.writeSettings(current);
                                const ws = wsModule();
                                if (ws && runtime.workspace) {
                                    ws.setDivider(runtime.workspace, bounded);
                                    core.saveWorkspace(runtime.workspace);
                                }
                            }
                        }, 250);
                    }
                });
                runtime.listPaneObserver.observe(listPane);
            }
            return;
        }

        // Fallback divider for environments without host #list-pane-toggle:
        if (runtime.dividerElement && runtime.dividerElement.isConnected) return;
        runtime.dividerBound = false;

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
            const width = Math.round(Math.min(640, Math.max(220, moveEvent.clientX - rect.left)));
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
                const previousWidth = settings.listPaneWidth;
                settings.listPaneWidth = runtime.dividerWidth;
                if (!core.writeSettings(settings)) {
                    runtime.dividerWidth = previousWidth;
                    listPane.style.width = `${previousWidth}px`;
                    listPane.style.flex = `0 0 ${previousWidth}px`;
                    setToast('The sidebar width could not be saved.', 'error', 8000);
                } else {
                    const ws = wsModule();
                    if (ws && runtime.workspace) {
                        commitWorkspaceMutation(
                            workspace => ws.setDivider(workspace, runtime.dividerWidth),
                            { retainOnWorkspaceFailure: true }
                        );
                    }
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
            const next = Math.round(Math.min(640, Math.max(220,
                current + (keyEvent.key === 'ArrowRight' ? step : -step))));
            listPane.style.width = `${next}px`;
            listPane.style.flex = `0 0 ${next}px`;
            const settings = core.readSettings();
            const previousWidth = settings.listPaneWidth;
            settings.listPaneWidth = next;
            if (!core.writeSettings(settings)) {
                listPane.style.width = `${previousWidth}px`;
                listPane.style.flex = `0 0 ${previousWidth}px`;
                setToast('The sidebar width could not be saved.', 'error', 8000);
            }
        };

        divider.addEventListener('pointerdown', onDown);
        divider.addEventListener('keydown', onKey);
        divider.addEventListener('dblclick', () => {
            const settings = core.readSettings();
            const previousWidth = settings.listPaneWidth;
            settings.listPaneWidth = 300;
            if (!core.writeSettings(settings)) {
                listPane.style.width = `${previousWidth}px`;
                listPane.style.flex = `0 0 ${previousWidth}px`;
                setToast('The sidebar width could not be saved.', 'error', 8000);
                return;
            }
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
            conflictSensitive: opts.conflictSensitive === true,
            title: opts.title || 'Are you sure?',
            icon: opts.icon || 'fa-circle-question',
            message: opts.message || '',
            danger: opts.danger === true,
            confirmLabel: opts.confirmLabel || 'OK',
            confirmIcon: opts.confirmIcon || (opts.danger ? 'fa-triangle-exclamation' : 'fa-check'),
            onConfirm: values => {
                try {
                    if (typeof opts.onConfirm === 'function' && opts.onConfirm(values) === false) {
                        return false;
                    }
                    runtime.modal = null;
                    return true;
                } catch (error) {
                    console.warn('[codalio-blueprint] confirm action failed', error);
                    setToast('That action failed. See the console for details.', 'error');
                    return false;
                }
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
        const exportOnly = key === 'export-project' || key === 'export-settings'
            || key === 'export-recovery';
        const activeWork = runtime.busy || runtime.busyImport || runtime.cancellationCheckBusy;
        const recoveryReset = key === 'clear-all' && recoveryBlocked() && !activeWork;
        if (operationBusy() && !exportOnly && !recoveryReset) {
            setToast('Finish the active operation before changing stored Blueprint data.', 'warn');
            return;
        }
        switch (key) {
            case 'export-project':
                exportProject();
                return;

            case 'export-settings': {
                const schema = schemaModule();
                if (!schema) return;
                const settings = core.readSettings();
                const recovery = typeof core.storageRecoveryState === 'function'
                    ? core.storageRecoveryState() : {};
                if (recovery.settings && typeof core.exportRecoverySnapshot === 'function') {
                    downloadText('codalio-blueprint-settings-recovery.json',
                        core.exportRecoverySnapshot(), 'application/json;charset=utf-8');
                    setToast('The saved settings are malformed, so their exact raw bytes were exported for recovery instead of exporting misleading defaults.', 'warn', 10000);
                    return;
                }
                const json = schema.exportSettings(settings);
                downloadText('codalio-blueprint-settings.json', json, 'application/json;charset=utf-8');
                setToast('Settings exported.', 'success');
                return;
            }

            case 'export-recovery':
                if (typeof core.exportRecoverySnapshot !== 'function') return;
                downloadText('codalio-blueprint-storage-recovery.json',
                    core.exportRecoverySnapshot(), 'application/json;charset=utf-8');
                setToast('Exact Blueprint storage bytes exported for recovery.', 'success');
                return;

            case 'import-settings':
                openImportSettingsModal();
                return;

            case 'reset-settings': {
                const schema = schemaModule();
                const defaults = schema ? schema.SCHEMA_DEFAULTS : core.DEFAULT_SETTINGS;
                openConfirmModal({
                    title: 'Reset all Codalio Blueprint settings?',
                    icon: 'fa-rotate-left',
                    message: 'Every setting returns to its documented default. Your documents and run history are untouched.',
                    confirmLabel: 'Reset settings',
                    danger: true,
                    onConfirm: () => {
                        const recovery = typeof core.storageRecoveryState === 'function'
                            ? core.storageRecoveryState() : {};
                        if (!core.writeSettings(Object.assign({}, defaults), {
                            allowCorruptReset: Boolean(recovery.settings)
                        })) {
                            setToast('Settings could not be reset because browser storage is unavailable.', 'error', 8000);
                            return false;
                        }
                        ensureWorkspace();
                        renderHostSurfaces();
                        renderPage();
                        setToast('Settings reset to defaults.', 'success');
                    }
                });
                return;
            }

            case 'reset-workspace': {
                openConfirmModal({
                    title: 'Reset the saved tab layout?',
                    icon: 'fa-window-restore',
                    message: 'Only Blueprint\'s saved tabs are removed. Projects, files, run history and settings are untouched.',
                    confirmLabel: 'Reset tabs',
                    danger: true,
                    onConfirm: () => {
                        const recovery = typeof core.storageRecoveryState === 'function'
                            ? core.storageRecoveryState() : {};
                        if (!core.clearWorkspace({ allowCorruptReset: Boolean(recovery.workspace) })) {
                            setToast('The saved tab layout could not be reset.', 'error', 8000);
                            return false;
                        }
                        runtime.workspace = wsModule()
                            ? wsModule().createWorkspace(core.readSettings()) : null;
                        runtime.workspaceRecoveryBlocked = false;
                        syncFolderFromTab();
                        renderHostSurfaces();
                        renderPage();
                        setToast('Saved tab layout reset. Projects and run history were preserved.', 'success');
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
                    conflictSensitive: true,
                    title: 'Erase all Codalio Blueprint data?',
                    icon: 'fa-trash-can',
                    message: 'Documents, run history, settings and the tab layout are all removed. The plug-in then behaves as if freshly installed. Your SimpleRAG workspace is never touched.',
                    confirmLabel: 'Erase everything',
                    danger: true,
                    onConfirm: () => {
                        const cleared = core.clearAllData(Object.assign({}, core.DEFAULT_SETTINGS));
                        if (!cleared.ok) {
                            setToast(cleared.error || 'Blueprint data could not be erased safely.', 'error', 10000);
                            return false;
                        }
                        runtime.workspace = wsModule() ? wsModule().createWorkspace(core.readSettings()) : null;
                        runtime.messages = [];
                        runtime.currentRun = null;
                        runtime.explicitNoRun = true;
                        runtime.activeRunId = '';
                        runtime.recoveryPersistenceBlocked = false;
                        runtime.externalRecoveryBlocked = false;
                        runtime.workspaceRecoveryBlocked = false;
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
            title: 'Import Codalio Blueprint settings',
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
                    const recovery = typeof core.storageRecoveryState === 'function'
                        ? core.storageRecoveryState() : {};
                    if (!core.writeSettings(result.settings, {
                        allowCorruptReset: Boolean(recovery.settings)
                    })) {
                        setToast('The imported settings could not be saved. No settings were changed.', 'error', 8000);
                        return false;
                    }
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

    let scrollRaf = null;
    function scrollTranscriptToEnd(force = false) {
        if (!runtime.active) return;
        const doScroll = () => {
            scrollRaf = null;
            const elements = hostElements();
            const transcript = elements && elements.settingsContainer
                ? elements.settingsContainer.querySelector('[data-cb-role="transcript"]')
                : null;
            if (!transcript) return;
            if (force || isTranscriptNearBottom(transcript)) {
                transcript.scrollTop = transcript.scrollHeight;
            }
        };
        if (typeof requestAnimationFrame === 'function') {
            if (scrollRaf) return;
            scrollRaf = requestAnimationFrame(doScroll);
        } else {
            doScroll();
        }
    }

    function render() {
        if (!runtime.mounted) return;
        renderPage();
    }

    function renderHostSurfaces() {
        if (!runtime.active) return;
        const render = runtime.context && runtime.context.render;
        const elements = hostElements();
        if (render) {
            try { render.nav(); } catch (error) { console.warn('[codalio-blueprint] host nav refresh failed', error); }
            try { render.list(); } catch (error) { console.warn('[codalio-blueprint] host list refresh failed', error); }
            try { render.ribbon(); } catch (error) { console.warn('[codalio-blueprint] host ribbon refresh failed', error); }
        } else if (elements && elements.listContent) {
            try {
                ui.renderList(stateSnapshot(), elements.listTitle, elements.listContent);
            } catch (error) {
                console.warn('[codalio-blueprint] direct list refresh failed', error);
            }
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

    function userRequestFits(value, label) {
        const text = String(value || '');
        if (text.length <= MAX_USER_REQUEST_CHARS) return true;
        setToast(`${String(label || 'That request')} is ${text.length.toLocaleString()} characters. Blueprint accepts up to ${MAX_USER_REQUEST_CHARS.toLocaleString()} characters in the composer; attach larger material as a project file so it can be budgeted safely.`, 'warn', 10000);
        focusComposer();
        return false;
    }

    // ------------------------------------------------------------------
    // Runs
    // ------------------------------------------------------------------

    function loadRuns() {
        runtime.runs = core.store.runs.slice();
        if (runtime.explicitNoRun) {
            runtime.activeRunId = '';
            runtime.currentRun = null;
            runtime.projectName = deriveProjectNameFromFiles();
            return;
        }
        // Durable empty selection is intentional (Clear chat or a new project
        // root), not an invitation to resurrect the newest run from another root.
        runtime.activeRunId = String(core.store.activeRunId || '');
        const run = core.findRun(runtime.activeRunId);
        runtime.currentRun = run;
        runtime.projectName = run ? run.projectName : deriveProjectNameFromFiles();
    }

    /** Install one project root's conversation without carrying another root's data. */
    function installFolderRunContext(folderId, run) {
        const owner = String(folderId || currentFolderId());
        const selected = run && String(run.folderId || '') === owner ? run : null;
        runtime.runs = core.store.runs.slice();
        runtime.activeRunId = selected ? selected.id : '';
        runtime.currentRun = selected;
        runtime.explicitNoRun = !selected;
        runtime.messages = [];
        runtime.compaction = null;
        if (selected) {
            runtime.selectedSkillId = selected.skillId || runtime.selectedSkillId;
            rebuildMessagesFromRun(selected);
        }
        const folder = core.getFolder(owner);
        runtime.projectName = (folder && folder.name)
            || (selected && selected.projectName)
            || deriveProjectNameFromFiles();
    }

    function hydrateRestoredRunSelection(runId, alreadyPersisted) {
        const runs = core.store.runs.slice();
        const requested = String(runId || '');
        let run = alreadyPersisted
            ? core.findRun(core.store.activeRunId)
            : (requested ? core.findRun(requested) : null);
        if (!alreadyPersisted) {
            if (requested && !run) {
                run = core.findRun(core.store.activeRunId) || runs[0] || null;
            }
            const previousActiveRunId = core.store.activeRunId;
            core.store.activeRunId = run ? run.id : '';
            if (!core.writeStore()) {
                core.store.activeRunId = previousActiveRunId;
                setToast('The restored run selection could not be saved. Reload before switching runs.', 'error', 8000);
                return false;
            }
        }
        runtime.runs = runs;
        runtime.activeRunId = run ? run.id : '';
        runtime.currentRun = run;
        runtime.explicitNoRun = !requested;
        runtime.compaction = run && run.compaction ? run.compaction : null;
        runtime.messages = [];
        if (run) {
            runtime.selectedSkillId = run.skillId || runtime.selectedSkillId;
            runtime.projectName = run.projectName || runtime.projectName;
            rebuildMessagesFromRun(run);
        }
        runtime.runSelectionRestored = true;
        return true;
    }

    function openStoredRun(runId, closeHistory) {
        if (operationBusy()) {
            setToast('Stop the active operation before switching runs.', 'warn');
            return false;
        }
        const run = core.findRun(String(runId || ''));
        if (!run) return false;
        if (runtime.currentRun && runtime.currentRun.id !== run.id && runtime.messages.length) {
            if (!saveCurrentRunMessages()) {
                setToast('The current transcript could not be saved, so Blueprint did not switch runs.', 'error', 8000);
                return false;
            }
        }
        if (!core.selectRun(run.id, run.folderId)) {
            setToast('The run selection could not be saved, so Blueprint kept the current run open.', 'error', 8000);
            return false;
        }
        runtime.activeRunId = run.id;
        runtime.explicitNoRun = false;
        runtime.currentRun = run;
        runtime.selectedSkillId = run.skillId || runtime.selectedSkillId;
        runtime.projectName = run.projectName || runtime.projectName;
        rebuildMessagesFromRun(run);
        if (closeHistory) runtime.isHistoryOpen = false;
        return true;
    }

    function deleteStoredRun(runId) {
        if (operationBusy()) {
            setToast('Stop the active operation before deleting a run.', 'warn');
            return false;
        }
        const id = String(runId || '');
        if (!id || !core.findRun(id)) return false;
        const deletingCurrent = Boolean(runtime.currentRun && runtime.currentRun.id === id);
        if (!core.deleteRun(id)) {
            setToast('The run could not be deleted because the updated history was not saved.', 'error', 8000);
            return false;
        }
        loadRuns();
        if (deletingCurrent) {
            runtime.messages = [];
            if (runtime.currentRun) rebuildMessagesFromRun(runtime.currentRun);
            else runtime.compaction = null;
        }
        return true;
    }

    function deriveProjectNameFromFiles() {
        const folderId = currentFolderId();
        const paths = core.listFiles(folderId);
        const doc = paths.find(path => /^docs\//.test(path));
        if (!doc) return '';
        const record = core.readFile(doc, folderId);
        const title = record && /^\s*#\s+(.+)$/m.exec(record.content);
        return title ? title[1].replace(/\s*(?:—|-{1,2})\s*Product Requirements.*$/i, '').trim().slice(0, 60) : '';
    }

    function saveCurrentRunMessages(runOverride, messagesOverride) {
        const targetRun = runOverride || runtime.currentRun;
        const transcript = Array.isArray(messagesOverride) ? messagesOverride : runtime.messages;
        if (!targetRun || !Array.isArray(transcript)) return false;
        const previousMessages = targetRun.messages;
        try {
            targetRun.messages = persistableMessages(
                transcript,
                targetRun.transcriptMode === 'run-local-v1' ? targetRun : null
            );
            if (!core.saveRun(targetRun)) {
                targetRun.messages = previousMessages;
                return false;
            }
            return true;
        } catch (_) {
            targetRun.messages = previousMessages;
            return false;
        }
    }

    function sameCompaction(left, right) {
        if (!left || !right) return false;
        if (left.id && right.id) return String(left.id) === String(right.id);
        return String(left.at || '') === String(right.at || '')
            && String(left.rawText || '') === String(right.rawText || '');
    }

    /**
     * Attach otherwise-legacy user cards to the assistant/run that immediately
     * follows them. Modern cards are created with explicit owners; this inference
     * exists so opening an older cumulative transcript can migrate it safely.
     */
    function ownedTranscriptCopies(transcript, enclosingRun) {
        const copies = (Array.isArray(transcript) ? transcript : [])
            .filter(item => item && typeof item === 'object')
            .map(item => Object.assign({}, item));
        copies.forEach((copy, index) => {
            if (copy.role === 'assistant' && !copy.runId && enclosingRun) {
                copy.runId = enclosingRun.id;
            }
            if (copy.role === 'compaction' && !copy.runId && enclosingRun
                && sameCompaction(copy.compaction, enclosingRun.compaction)) {
                copy.runId = enclosingRun.id;
            }
            if (copy.role !== 'user' || copy.runId) return;
            let following = null;
            for (let cursor = index + 1; cursor < copies.length; cursor += 1) {
                const candidate = copies[cursor];
                if (!candidate) continue;
                if (candidate.role === 'user' || candidate.role === 'compaction') break;
                if (candidate.role === 'assistant') {
                    following = candidate;
                    break;
                }
            }
            const ownerId = String((following && following.runId) || '');
            const ownerRun = ownerId ? core.findRun(ownerId) : null;
            if (ownerRun) {
                copy.runId = ownerRun.id;
                copy.folderId = ownerRun.folderId || copy.folderId || '';
                const createdAt = Date.parse(String(ownerRun.createdAt || ''));
                const messageAt = Date.parse(String(copy.at || ''));
                if (String(copy.text || '').trim() === String(ownerRun.idea || '').trim()
                    && Number.isFinite(createdAt) && Number.isFinite(messageAt)
                    && Math.abs(messageAt - createdAt) <= 60000) {
                    copy.messageKind = 'run-prompt';
                }
            }
        });
        return copies;
    }

    /**
     * Build one run's durable transcript shape without mutating live cards.
     *
     * The UI intentionally shows the whole same-root conversation, but each run
     * stores only cards it owns. Persisting that cumulative view in every run was
     * quadratic (2 + 4 + ... + 2N cards) and eventually exhausted localStorage.
     * The initial user request already has one canonical copy in run.idea, so its
     * renderer card is reconstructed rather than stored a second time.
     */
    function persistableMessages(transcript, targetRun) {
        const targetId = String((targetRun && targetRun.id) || '');
        return ownedTranscriptCopies(transcript, targetRun).filter(copy => {
            if (!targetId) return true;
            if (copy.role === 'compaction') {
                return String(copy.runId || '') === targetId
                    || sameCompaction(copy.compaction, targetRun.compaction);
            }
            return String(copy.runId || '') === targetId;
        }).filter(copy => !(targetId && copy.role === 'user'
            && copy.messageKind === 'run-prompt'
            && String(copy.runId || '') === targetId))
        .map(copy => {
            // Retry spinners are renderer-only locks. Persisting them makes a
            // settled historical card look permanently busy after reload.
            delete copy.retryStarting;
            delete copy.retrying;
            const canonicalAssistant = copy.role === 'assistant' && copy.runId
                && core.findRun(String(copy.runId));
            if (canonicalAssistant) {
                // Every run owns its canonical phase objects. Persist only the
                // run id and card-specific UI text/actions. Skill data, idea and
                // artifacts are rehydrated from that canonical run.
                delete copy.steps;
                delete copy.idea;
                delete copy.skillId;
                delete copy.skillName;
                delete copy.paths;
                delete copy.writtenFiles;
                delete copy.folderId;
                delete copy.status;
            } else if (Array.isArray(copy.steps)) {
                copy.steps = copy.steps.map(step => {
                    const stepCopy = Object.assign({}, step);
                    delete stepCopy.liveThinkingElement;
                    return stepCopy;
                });
            }
            return copy;
        });
    }

    function createDurableRunCheckpoint(run, execution) {
        let lastSavedAt = 0;
        let timer = null;
        let failure = null;
        const persist = () => {
            if (failure) return false;
            lastSavedAt = Date.now();
            if (core.saveRun(run)) return true;
            const state = core.persistenceState();
            failure = new core.BlueprintModelError(
                `The active model step could not be checkpointed (${state.lastError || 'project storage unavailable'}).`,
                { code: 'storage-failure', retryable: false }
            );
            execution.persistenceFailure = failure;
            try { execution.abort.abort(); } catch (_) { /* already stopping */ }
            return false;
        };
        return {
            checkpoint(force) {
                const now = Date.now();
                if (force) {
                    if (timer) clearTimeout(timer);
                    timer = null;
                    const saved = persist();
                    if (!saved && failure) throw failure;
                    return saved;
                }
                if (now - lastSavedAt >= 750) {
                    const saved = persist();
                    if (!saved && failure) throw failure;
                    return saved;
                }
                if (!timer) {
                    timer = setTimeout(() => {
                        timer = null;
                        persist();
                    }, Math.max(1, 750 - (now - lastSavedAt)));
                }
                return true;
            },
            finish() {
                if (timer) clearTimeout(timer);
                timer = null;
                return failure ? false : persist();
            },
            cancel() {
                if (timer) clearTimeout(timer);
                timer = null;
            },
            failure: () => failure
        };
    }

    function syntheticCompactionMessage(run, compaction) {
        return {
            id: `synthetic:${String((run && run.id) || 'run')}:compaction`,
            role: 'compaction',
            at: compaction.at,
            compaction,
            runId: String(compaction.sourceRunId || (run && run.id) || ''),
            folderId: String(compaction.folderId || (run && run.folderId) || ''),
            text: `⚡ Context Compacted (${compaction.savedPercent}% reduction • ${compaction.originalTokens} → ${compaction.compactedTokens} tokens)`
        };
    }

    function syntheticRunPrompt(run) {
        return {
            id: `synthetic:${run.id}:user`,
            role: 'user',
            at: run.createdAt,
            runId: run.id,
            folderId: run.folderId || '',
            messageKind: 'run-prompt',
            text: run.idea
        };
    }

    function syntheticAssistantMessage(run) {
        return {
            id: `synthetic:${run.id}:assistant`,
            role: 'assistant',
            at: run.createdAt,
            runId: run.id,
            text: run.status === 'done'
                ? 'Run complete. Open any document from the project tree, or tell me what to revise.'
                : run.status === 'running' ? '' : `Run ended (${run.status}).${run.error ? ` ${run.error}` : ''}`,
            canRetry: run.status !== 'done'
        };
    }

    function transcriptBatchForRun(run) {
        const batch = ownedTranscriptCopies(run.messages, run);
        const runId = String(run.id || '');
        const hasPrompt = batch.some(message => message.role === 'user'
            && String(message.runId || '') === runId
            && (message.messageKind === 'run-prompt'
                || String(message.text || '').trim() === String(run.idea || '').trim()));
        if (run.idea && !hasPrompt) {
            const assistantIndex = batch.findIndex(message => message.role === 'assistant'
                && String(message.runId || '') === runId);
            batch.splice(assistantIndex < 0 ? batch.length : assistantIndex, 0, syntheticRunPrompt(run));
        }
        if (!batch.some(message => message.role === 'assistant'
            && String(message.runId || '') === runId)) {
            batch.push(syntheticAssistantMessage(run));
        }
        if (run.compaction && !batch.some(message => message.role === 'compaction'
            && sameCompaction(message.compaction, run.compaction))
            && (!run.compaction.sourceRunId
                || String(run.compaction.sourceRunId) === runId)) {
            batch.unshift(syntheticCompactionMessage(run, run.compaction));
        }
        return batch;
    }

    function stableMessageOrder(entries) {
        return entries.slice().sort((left, right) => {
            const leftAt = Date.parse(String(left.message.at || ''));
            const rightAt = Date.parse(String(right.message.at || ''));
            if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) {
                return leftAt - rightAt;
            }
            return left.sequence - right.sequence;
        });
    }

    /** Rebuild one explicit conversation chain, never every run in the root. */
    function rebuildMessagesFromRun(run) {
        runtime.messages = [];
        if (!run) {
            runtime.compaction = null;
            return;
        }

        // A local-v1 run points to the exact prior conversation it continued.
        // Stop at the first legacy cumulative snapshot, an intentional clear-chat
        // boundary, a pruned parent, a cycle, or a cross-root pointer.
        const chain = [];
        const visited = new Set();
        let cursor = run;
        while (cursor && chain.length < 60 && !visited.has(String(cursor.id || ''))) {
            const cursorId = String(cursor.id || '');
            visited.add(cursorId);
            chain.push(cursor);
            if (cursor.transcriptMode !== 'run-local-v1') break;
            const parentId = String(cursor.contextRunId || '');
            if (!parentId) break;
            const parent = core.findRun(parentId);
            if (!parent || String(parent.folderId || '') !== String(run.folderId || '')) break;
            cursor = parent;
        }
        chain.reverse();

        let sequence = 0;
        const entries = [];
        chain.forEach(chainRun => {
            transcriptBatchForRun(chainRun).forEach(message => {
                entries.push({ message, sequence: sequence += 1 });
            });
        });

        // A newer legacy snapshot can contain the same message id with fresher
        // terminal text. Keep the last occurrence without disturbing id-less
        // historical evidence.
        const lastById = new Map();
        entries.forEach((entry, index) => {
            if (entry.message && entry.message.id) lastById.set(String(entry.message.id), index);
        });
        let unique = entries.filter((entry, index) => !entry.message.id
            || lastById.get(String(entry.message.id)) === index);

        let latestCompactionIndex = -1;
        unique.forEach((entry, index) => {
            if (entry.message.role === 'compaction') latestCompactionIndex = index;
        });
        const inheritedCompaction = run.compaction || [...chain].reverse()
            .map(item => item.compaction).find(Boolean) || null;
        if (latestCompactionIndex < 0 && inheritedCompaction) {
            unique.unshift({
                message: syntheticCompactionMessage(run, inheritedCompaction),
                sequence: 0
            });
            latestCompactionIndex = 0;
        }

        if (latestCompactionIndex >= 0) {
            const boundary = unique[latestCompactionIndex];
            // The compactor deliberately retains one pre-boundary assistant card.
            // Pin the boundary first, then chronologically merge revisions/child
            // turns that are explicitly stored after it.
            unique = [boundary, ...stableMessageOrder(unique.slice(latestCompactionIndex + 1))];
        } else {
            unique = stableMessageOrder(unique);
        }

        runtime.messages = unique.map(entry => {
            const copy = Object.assign({}, entry.message);
            const cardRun = copy.role === 'assistant' && copy.runId
                ? core.findRun(String(copy.runId)) : null;
            if (cardRun) {
                copy.skillName = cardRun.skillName;
                copy.skillId = cardRun.skillId;
                copy.idea = cardRun.idea;
                copy.steps = cardRun.phases || [];
                copy.paths = (cardRun.writtenPaths || []).slice();
                copy.writtenFiles = (cardRun.writtenFiles || []).map(ref => Object.assign({}, ref));
                copy.folderId = cardRun.folderId || copy.folderId || '';
                copy.status = cardRun.status;
                copy.busy = false;
                if (String(copy.runId) === String(run.id)) {
                    copy.canRetry = cardRun.status !== 'done';
                }
            }
            return copy;
        });
        const latestCompactionMessage = [...runtime.messages].reverse()
            .find(message => message.role === 'compaction' && message.compaction);
        runtime.compaction = latestCompactionMessage
            ? latestCompactionMessage.compaction : inheritedCompaction;
    }

    function sanitizeRestoredState(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const clean = {};
        if (typeof value.section === 'string' && ui.SECTIONS.some(section => section.id === value.section)) {
            clean.section = value.section;
        }
        if (typeof value.skillId === 'string' && skills.getSkill(value.skillId)) clean.skillId = value.skillId;
        if (value.viewerMode === 'source' || value.viewerMode === 'preview') clean.viewerMode = value.viewerMode;
        ['activeFolderId', 'openPath', 'openFolderId', 'activeRunId'].forEach(key => {
            if (typeof value[key] === 'string') clean[key] = value[key];
        });
        if (Array.isArray(value.expanded)) {
            clean.expanded = value.expanded.slice(0, 500).map(item => String(item).slice(0, 500));
        }
        if (value.workspace && typeof value.workspace === 'object' && !Array.isArray(value.workspace)) {
            try { clean.workspace = JSON.parse(JSON.stringify(value.workspace)); } catch (_) { /* ignore corrupt host state */ }
        }
        return clean;
    }

    function applyRestoredState(value) {
        if (!value) return false;
        const workspaceModule = value.workspace && wsModule() ? wsModule() : null;
        const restoredWorkspace = workspaceModule
            ? workspaceModule.normalizeWorkspace(value.workspace, core.readSettings())
            : null;
        const activeTab = restoredWorkspace && workspaceModule.activeTab(restoredWorkspace);
        const activeFileTab = activeTab && activeTab.kind === 'file'
            && core.readFile(activeTab.path, activeTab.folderId)
            ? activeTab : null;
        const selection = {};
        if (typeof value.activeFolderId === 'string') selection.activeFolderId = value.activeFolderId;
        if (typeof value.openPath === 'string') {
            selection.openPath = value.openPath;
            // Absence means legacy ownerless state and may use the core's guarded
            // migration fallback. An explicitly supplied stale owner must remain
            // distinguishable so it cannot open an identically named file in a
            // different project root.
            if (Object.prototype.hasOwnProperty.call(value, 'openFolderId')) {
                selection.openFolderId = value.openFolderId;
            }
        }
        if (typeof value.activeRunId === 'string') selection.activeRunId = value.activeRunId;
        if (activeFileTab) {
            selection.activeFolderId = activeFileTab.folderId;
            selection.openPath = activeFileTab.path;
            selection.openFolderId = activeFileTab.folderId;
        }
        if (Object.keys(selection).length && !core.restoreSelection(selection)) {
            setToast('The restored project selection could not be saved, so Blueprint kept the current state.', 'error', 8000);
            return false;
        }

        // Only mutate runtime state after the complete owner-qualified selection
        // is durable. A storage refusal therefore cannot leave the UI showing a
        // folder/file/run tuple that will disappear on reload.
        if (value.section) runtime.folder = value.section;
        if (value.skillId) runtime.selectedSkillId = value.skillId;
        if (value.viewerMode) runtime.viewerMode = value.viewerMode;
        if (Array.isArray(value.expanded)) runtime.expanded = new Set(value.expanded);
        if (Object.keys(selection).length) {
            const restoredRun = core.store.activeRunId
                ? core.findRun(core.store.activeRunId) : null;
            if (restoredRun && String(restoredRun.folderId || '')
                === String(core.store.activeFolderId || '')) {
                hydrateRestoredRunSelection(restoredRun.id, true);
            } else {
                installFolderRunContext(core.store.activeFolderId, null);
            }
        }
        if (restoredWorkspace && workspaceModule) {
            const ws = workspaceModule;
            runtime.workspace = restoredWorkspace;
            // A restored active file tab is the most specific owner-qualified
            // selection. Make it authoritative over stale top-level openPath data,
            // especially when two project roots contain the same relative path.
            if (activeFileTab) {
                runtime.viewerMode = ws.viewerModeFor(
                    runtime.workspace, activeFileTab.path, core.readSettings(), activeFileTab.folderId);
            }
            syncFolderFromTab();
        }
        return true;
    }

    function flushExternalStoreChange() {
        if (!runtime.pendingExternalStoreChange
            || runtime.busy || runtime.busyImport || runtime.cancellationCheckBusy
            || runtime.executionSettlements.size) return false;
        const detail = runtime.pendingExternalStoreChange;
        runtime.pendingExternalStoreChange = null;
        const reloaded = typeof core.reloadStoreFromStorage === 'function'
            ? core.reloadStoreFromStorage() : false;
        if (!reloaded) {
            // The core deliberately retains the last good in-memory snapshot when
            // external bytes are malformed. Keep the matching runtime intact too,
            // so the user can still inspect/export it before an explicit reset.
            runtime.externalRecoveryBlocked = true;
            if (runtime.mounted) {
                const recovery = typeof core.storageRecoveryState === 'function'
                    ? core.storageRecoveryState() : {};
                setToast(recovery.projects
                    || 'Project data from another window is malformed. Blueprint kept the last good in-memory copy and blocked further saves.',
                'error', 12000);
                renderHostSurfaces();
                renderPage();
            }
            return false;
        }
        runtime.externalRecoveryBlocked = false;
        const closedConflictModal = Boolean(runtime.modal && runtime.modal.conflictSensitive);
        if (closedConflictModal) runtime.modal = null;
        runtime.sourceFiles = runtime.sourceFiles.filter(file => file && file.path
            && core.readFile(file.path, file.folderId || file.folder));
        runtime.explicitNoRun = !core.store.activeRunId;
        loadRuns();
        refreshForeignRunOwners();
        // The owner-key event can precede this project-store event. Re-arm the
        // expiry timer after the run record is visible so a silent foreign crash
        // is recovered even when no later heartbeat/storage event arrives.
        scheduleForeignRunRecovery(hasRecoverableLeaseWork());
        if (runtime.currentRun) rebuildMessagesFromRun(runtime.currentRun);
        else runtime.messages = [];
        runtime.projectName = runtime.currentRun
            ? runtime.currentRun.projectName : deriveProjectNameFromFiles();
        if (runtime.mounted) {
            const reloadMessage = detail.reason === 'external-reset'
                ? 'Project data was erased in another window. This page reloaded the empty state and will not restore stale files.'
                : 'Project data changed in another window and was reloaded safely.';
            setToast(`${reloadMessage}${closedConflictModal
                ? ' The open file edit or delete dialog was closed to prevent a stale overwrite.' : ''}`,
            reloaded ? 'info' : 'warn', 10000);
            renderHostSurfaces();
            renderPage();
        }
        return true;
    }

    function onExternalStoreChange(event) {
        const detail = event && event.detail && typeof event.detail === 'object'
            ? event.detail : { reason: 'external-change' };
        runtime.pendingExternalStoreChange = detail;
        const failure = new core.BlueprintModelError(
            'Project data changed in another window while this operation was active. The model turn was stopped before reloading the authoritative state.',
            { code: 'concurrent-update', retryable: false }
        );
        if (runtime.currentController) {
            runtime.currentController.persistenceFailure = failure;
            try { runtime.currentController.abort.abort(); } catch (_) { /* already stopped */ }
        }
        if (runtime.importController) {
            try { runtime.importController.abort(); } catch (_) { /* already stopped */ }
        }
        if (runtime.busy || runtime.busyImport || runtime.executionSettlements.size) {
            runtime.hint = 'Project data changed in another window; stopping safely before reload…';
            renderHostSurfaces();
            renderPage();
            return;
        }
        flushExternalStoreChange();
    }

    function flushExternalWorkspaceChange() {
        if (!runtime.pendingExternalWorkspaceChange
            || runtime.busy || runtime.busyImport || runtime.cancellationCheckBusy
            || runtime.executionSettlements.size) return false;
        const detail = runtime.pendingExternalWorkspaceChange;
        // Workspace and project selection are separate keys. A normal file-tab
        // mutation writes workspace first and project selection second, so the
        // paired project event must be adopted before reconciling the tab graph.
        if (runtime.pendingExternalStoreChange) {
            flushExternalStoreChange();
            if (runtime.pendingExternalStoreChange || runtime.externalRecoveryBlocked) return false;
        }
        const raw = typeof core.readWorkspaceRaw === 'function'
            ? core.readWorkspaceRaw() : null;
        const recovery = typeof core.storageRecoveryState === 'function'
            ? core.storageRecoveryState() : {};
        if (recovery.workspace) {
            runtime.pendingExternalWorkspaceChange = null;
            runtime.workspaceRecoveryBlocked = true;
            if (runtime.mounted) {
                setToast(`${recovery.workspace} Blueprint kept the last good live tab layout and blocked new work until reload.`, 'error', 12000);
                renderHostSurfaces();
                renderPage();
            }
            return false;
        }
        const ws = wsModule();
        if (!ws) return false;
        const nextWorkspace = ws.normalizeWorkspace(raw, core.readSettings());
        const reconciliation = typeof core.reconcileWorkspaceSelection === 'function'
            ? core.reconcileWorkspaceSelection(nextWorkspace)
            : { ok: true, changed: false, error: '' };
        if (!reconciliation || reconciliation.ok !== true) {
            const persistence = typeof core.persistenceState === 'function'
                ? core.persistenceState() : {};
            const retryablePairingFailure = ['concurrent-update', 'store-busy', 'external-reset']
                .includes(String(persistence.lastCode || ''));
            if (retryablePairingFailure) {
                // Keep the exact workspace event queued. Even if the browser's
                // paired project storage event is delayed or coalesced, force one
                // authoritative project reload, then retry workspace reconciliation
                // from that revision at the next safe point.
                runtime.workspaceRecoveryBlocked = false;
                if (!runtime.pendingExternalStoreChange) {
                    runtime.pendingExternalStoreChange = {
                        reason: 'workspace-project-reconcile'
                    };
                }
                runtime.hint = 'The tab layout arrived before its project selection; reconciling both saved revisions…';
                setTimeout(() => { flushPendingRestoreState(); }, 0);
                return false;
            }
            runtime.pendingExternalWorkspaceChange = null;
            runtime.workspaceRecoveryBlocked = true;
            if (runtime.mounted) {
                setToast(`The tab layout changed in another window but its project selection could not be reconciled (${String(
                    (reconciliation && reconciliation.error) || 'project storage unavailable'
                )}). Reload before starting more work.`, 'error', 12000);
                renderHostSurfaces();
                renderPage();
            }
            return false;
        }

        runtime.pendingExternalWorkspaceChange = null;
        runtime.workspace = nextWorkspace;
        runtime.workspaceRecoveryBlocked = false;
        const activeTab = ws.activeTab(runtime.workspace);
        if (activeTab && activeTab.kind === 'file') {
            const selected = core.store.activeRunId ? core.findRun(core.store.activeRunId) : null;
            installFolderRunContext(activeTab.folderId, selected);
            runtime.viewerMode = ws.viewerModeFor(
                runtime.workspace, activeTab.path, core.readSettings(), activeTab.folderId);
            if (runtime.modal && runtime.modal.conflictSensitive) runtime.modal = null;
        }
        syncFolderFromTab();
        if (runtime.mounted) {
            setToast(detail.reason === 'external-workspace-reset'
                ? 'The saved tab layout was reset in another window.'
                : 'The tab layout changed in another window and was reloaded safely.', 'info', 7000);
            renderHostSurfaces();
            renderPage();
        }
        return true;
    }

    function onExternalWorkspaceChange(event) {
        runtime.pendingExternalWorkspaceChange = event && event.detail
            && typeof event.detail === 'object'
            ? event.detail : { reason: 'external-workspace-update' };
        if (runtime.busy || runtime.busyImport || runtime.cancellationCheckBusy
            || runtime.executionSettlements.size) {
            runtime.hint = 'The tab layout changed in another window; it will reload after the active operation settles.';
            renderHostSurfaces();
            renderPage();
            return;
        }
        flushPendingRestoreState();
    }

    function flushPendingRestoreState() {
        if (runtime.busy || runtime.busyImport || runtime.cancellationCheckBusy
            || runtime.executionSettlements.size) return false;
        const externalReloaded = flushExternalStoreChange();
        const workspaceReloaded = runtime.externalRecoveryBlocked
            ? false : flushExternalWorkspaceChange();
        if (recoveryBlocked() || !runtime.pendingRestoreState) {
            return externalReloaded || workspaceReloaded;
        }
        const pending = runtime.pendingRestoreState;
        runtime.pendingRestoreState = null;
        applyRestoredState(pending);
        if (runtime.mounted) {
            renderHostSurfaces();
            renderPage();
        }
        return true;
    }

    function clearChat() {
        if (operationBusy()) {
            setToast('Stop the current run before clearing the chat.', 'warn');
            return;
        }
        if (runtime.currentRun && runtime.messages.length) {
            if (!saveCurrentRunMessages()) {
                setToast('The transcript could not be saved, so Blueprint did not clear it.', 'error', 8000);
                return false;
            }
        }
        // Persist navigation first. If storage is unavailable, every runtime and
        // composer field stays intact and the chat cannot reappear after reload.
        if (!core.restoreSelection({ activeRunId: '' })) {
            setToast('The active chat could not be cleared because the empty selection was not saved.', 'error', 8000);
            return false;
        }
        runtime.currentRun = null;
        runtime.explicitNoRun = true;
        runtime.activeRunId = '';
        runtime.messages = [];
        runtime.compaction = null;
        runtime.pendingQuestion = null;
        runtime.isHistoryOpen = false;
        runtime.folder = 'cb-agent';
        const context = runtime.context;
        if (context && context.state) context.state.folder = 'cb-agent';
        runtime.draft = '';
        setToast('Chat cleared. Ready for a new prompt.', 'info');
        renderHostSurfaces();
        renderPage();
        focusComposer();
        return true;
    }

    async function compactContext(options) {
        if (operationBusy()) {
            setToast('Cannot compact context while agent is busy.', 'warn');
            return;
        }
        if (!await ensureBackendIdle() || operationBusy()) return;
        const opts = options || {};
        if (runtime.busy && !opts.allowBusy && opts.reason !== 'overflow-recovery') {
            setToast('Cannot compact context while agent is busy.', 'warn');
            return null;
        }
        const nonCompactionMessages = (runtime.messages || []).filter(m => m.role !== 'compaction');
        if (nonCompactionMessages.length < 2 && !runtime.compaction && !opts.force) {
            if (!opts.silent) setToast('Conversation history is too brief to compact.', 'info');
            return null;
        }

        const run = runtime.currentRun || (core.store && core.store.activeRunId && core.findRun(core.store.activeRunId));
        const settings = core.readSettings();
        const activeFolder = core.activeFolder();
        const useModel = opts.useModel !== false;
        const messagesAtStart = runtime.messages;
        let execution = null;
        let settlementToken = null;
        let generation = runtime.generation;

        if (!opts.silent) setToast('⚡ Compacting context using Anti-gravity protocol…', 'info', 3000);

        if (useModel) {
            runtime.generation += 1;
            generation = runtime.generation;
            execution = createExecutionController(run);
            if (!execution.ownershipClaimed) {
                setToast('This run is active in another Blueprint window, so context compaction did not start.', 'warn', 10000);
                return false;
            }
            runtime.currentController = execution;
            runtime.busy = true;
            settlementToken = beginExecutionSettlement(execution, generation);
            runtime.hint = 'Compacting conversation context…';
            renderHostSurfaces();
            renderPage();
        }

        try {
            const lifecycle = requestLifecycleHooks(execution);
            let compaction = await agent.compressContext({
                messages: messagesAtStart,
                run,
                activeFolder,
                settings,
                useModel,
                signal: execution ? execution.signal : undefined,
                onRequestStart: lifecycle.onRequestStart,
                onRequestDispatched: lifecycle.onRequestDispatched,
                onRequestEnd: lifecycle.onRequestEnd
            });

            // A run may have started while a deterministic auto-compaction was
            // yielding, or Stop may have invalidated a model compaction.
            if (!compaction || generation !== runtime.generation
                || (!useModel && (runtime.busy || runtime.messages !== messagesAtStart))) return;
            compaction = Object.assign({}, compaction, {
                folderId: String((run && run.folderId)
                    || (activeFolder && activeFolder.id)
                    || currentFolderId()),
                sourceRunId: String((run && run.id) || '')
            });

            const compactionMessage = {
                id: core.uid('msg'),
                role: 'compaction',
                at: compaction.at,
                compaction,
                runId: String((run && run.id) || ''),
                folderId: compaction.folderId,
                text: `⚡ Context Compacted (${compaction.savedPercent}% reduction • ${compaction.originalTokens} → ${compaction.compactedTokens} tokens)`
            };

            const recent = messagesAtStart.slice(-1).filter(m => m.role !== 'compaction');
            const compactedMessages = [compactionMessage, ...recent];

            // Compaction and its shortened transcript are one logical mutation.
            // Save both in one store commit, then install the matching runtime
            // state. A quota/conflict failure restores the live run exactly.
            if (run) {
                const previousCompaction = run.compaction;
                const previousMessages = run.messages;
                const previousTranscriptMode = run.transcriptMode;
                const previousContextRunId = run.contextRunId;
                try {
                    run.compaction = compaction;
                    run.transcriptMode = 'run-local-v1';
                    // The summary is now the complete base context. Do not walk
                    // behind it and resurrect the cards it intentionally replaced.
                    run.contextRunId = '';
                    run.messages = persistableMessages(compactedMessages, run);
                    if (!core.saveRun(run)) {
                        throw new Error('The compacted context and transcript could not be saved.');
                    }
                } catch (error) {
                    run.compaction = previousCompaction;
                    run.messages = previousMessages;
                    if (previousTranscriptMode === undefined) delete run.transcriptMode;
                    else run.transcriptMode = previousTranscriptMode;
                    if (previousContextRunId === undefined) delete run.contextRunId;
                    else run.contextRunId = previousContextRunId;
                    throw error;
                }
            }
            runtime.compaction = compaction;
            runtime.messages = compactedMessages;
            renderPage();
            scrollTranscriptToEnd();

            if (!opts.silent) {
                setToast(`⚡ Context compacted: ${compaction.savedPercent}% tokens saved (${compaction.compactedTokens} tokens retained).`, 'success', 5000);
            }
        } catch (error) {
            if (generation !== runtime.generation || (error && error.code === 'aborted')) return;
            setToast(`Context compaction failed: ${String((error && error.message) || error)}`, 'error');
        } finally {
            if (useModel && generation === runtime.generation && runtime.currentController === execution) {
                runtime.busy = false;
                runtime.currentController = null;
                runtime.hint = '';
                flushPendingRestoreState();
                renderHostSurfaces();
                renderPage();
            }
            finishExecutionSettlement(settlementToken);
        }
    }

    async function checkAutoCompaction(options) {
        const opts = options || {};
        const settings = core.readSettings();
        if (settings.contextCompression === false && !opts.force) return null;

        const threshold = Number(settings.autoCompactThreshold) || 6;
        const msgs = runtime.messages || [];

        // Count uncompacted user/assistant messages AND tokens since the last
        // compaction. Walking BACKWARDS to the compaction boundary matters:
        // counting every non-compaction message in the whole transcript keeps
        // rising after the first compaction, so the threshold would re-trigger
        // forever and never reset. Sol's `operationBusy()` guard is kept for the
        // automatic path because it also fences imports, not just model turns.
        let uncompactedCount = 0;
        let uncompactedTokens = 0;
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
            const m = msgs[i];
            if (!m) continue;
            if (m.role === 'compaction' || m.compaction) break;
            if (m.role === 'user' || m.role === 'assistant') {
                uncompactedCount += 1;
                uncompactedTokens += core.estimateTokens(m.text || '')
                    + (Array.isArray(m.paths) ? m.paths.length * 80 : 0);
            }
        }

        const tokenBudgetExceeded = uncompactedTokens >= 2000;
        const countThresholdExceeded = uncompactedCount >= threshold;

        if (opts.force || tokenBudgetExceeded || countThresholdExceeded) {
            if (!operationBusy() || opts.allowBusy || opts.reason === 'overflow-recovery') {
                return await compactContext({
                    silent: opts.silent !== undefined ? opts.silent : !opts.force,
                    useModel: false,
                    allowBusy: opts.allowBusy || opts.reason === 'overflow-recovery',
                    reason: opts.reason || (tokenBudgetExceeded ? 'token-budget' : 'auto-threshold')
                });
            }
        }
        return null;
    }

    function scheduleAutoCompaction(run, expectedMessages, expectedGeneration) {
        const expectedRunId = String((run && run.id) || '');
        setTimeout(() => {
            // finishExecutionSettlement queues authoritative reloads first. Flush
            // once more defensively, then compact only the exact graph that just
            // settled; a new send, tab restore, or cross-window update wins.
            flushPendingRestoreState();
            if (runtime.pendingExternalStoreChange || runtime.pendingExternalWorkspaceChange
                || runtime.pendingRestoreState || recoveryBlocked()
                || expectedGeneration !== runtime.generation
                || runtime.messages !== expectedMessages
                || String((runtime.currentRun && runtime.currentRun.id) || '') !== expectedRunId
                || String((core.store && core.store.activeRunId) || '') !== expectedRunId) return;
            checkAutoCompaction();
        }, 0);
    }

    function startNewRun() {
        clearChat();
    }

    async function stopRun() {
        if (runtime.busyImport) {
            const importing = runtime.importController;
            if (importing) {
                runtime.hint = 'Cancelling folder import and rolling back partial files…';
                try { importing.abort(); } catch (_) { /* already settling */ }
                renderHostSurfaces();
                renderPage();
            }
            return;
        }
        if (!runtime.busy) return;
        const settings = core.readSettings();
        if (settings.confirmStop === true && typeof window.confirm === 'function'
            && !window.confirm('Stop the current Blueprint run? Partial model output will be kept in the step trace.')) {
            return;
        }
        const execution = runtime.currentController;
        if (execution && execution.stopping) return execution.stopPromise;
        if (execution) execution.stopping = true;

        const stoppedRun = (execution && execution.ownerRun) || runtime.currentRun;
        const stoppedRunId = String((stoppedRun && stoppedRun.id) || (execution && execution.ownerRunId) || '');
        const stoppedMessage = [...runtime.messages].reverse().find(item => item.role === 'assistant'
            && item.busy
            && (!stoppedRunId || String(item.runId || '') === stoppedRunId));
        const cancelIds = execution && execution.cancelIds
            ? [...execution.cancelIds]
            : [];

        // Invalidate UI callbacks first, then abort the exact fetch signals. Keep
        // the operation locked until cancellation acknowledgements settle so a
        // new Send cannot overlap a generation the backend may still be running.
        runtime.generation += 1;
        if (execution && execution.abort) {
            try { execution.abort.abort(); } catch (_) { /* already settled */ }
        }
        runtime.pendingQuestion = null;
        runtime.hint = cancelIds.length
            ? `Stopping ${cancelIds.length} active model turn${cancelIds.length === 1 ? '' : 's'}…`
            : 'Stopping the active operation…';
        stopLiveTicker();
        let stopStateDurable = true;
        if (stoppedRun && stoppedRun.status === 'running') {
            stopStateDurable = settleRunLocally(stoppedRun, 'stopped', 'Stopped by the user.');
        }
        if (stoppedMessage) {
            stoppedMessage.busy = false;
            stoppedMessage.canRetry = true;
            stoppedMessage.text = cancelIds.length
                ? `Stopping ${cancelIds.length} active model turn${cancelIds.length === 1 ? '' : 's'}…`
                : 'Stopped locally before a model turn was registered.';
        }
        if (stoppedRun) stopStateDurable = saveCurrentRunMessages(stoppedRun) && stopStateDurable;
        renderHostSurfaces();
        renderPage();

        const cancellation = Promise.all(cancelIds.map(cancelId => (typeof core.cancelTurnOutcome === 'function'
            ? core.cancelTurnOutcome(cancelId, { timeoutMs: 5000 })
            : core.cancelTurn(cancelId, { timeoutMs: 5000 }).then(ok => ok ? 'cancelled' : 'unknown'))));
        if (execution) execution.stopPromise = cancellation;
        const results = await cancellation;
        const acknowledged = results.filter(cancellationOutcomeTerminal).length;
        results.forEach((outcome, index) => {
            const id = cancelIds[index];
            if (cancellationOutcomeTerminal(outcome)
                && clearPendingCancelRecord(id, execution
                    && execution.cancelLeases.get(String(id)))) {
                runtime.unacknowledgedCancelIds.delete(id);
                if (execution) execution.cancelLeases.delete(String(id));
            } else {
                runtime.unacknowledgedCancelIds.add(id);
            }
        });
        if (stoppedMessage) {
            stoppedMessage.text = cancelIds.length && acknowledged === cancelIds.length
                ? `Stopped. The backend acknowledged all ${acknowledged} active turn${acknowledged === 1 ? '' : 's'}. Tell me what to change and I will pick the run back up.`
                : cancelIds.length
                    ? `Stopped locally. The backend acknowledged ${acknowledged}/${cancelIds.length} active turns; any unacknowledged request was still aborted in this page.`
                    : 'Stopped locally before the backend turn was registered.';
        }
        if (stoppedRun && core.findRun(stoppedRun.id)
            && stoppedMessage && Array.isArray(stoppedRun.messages)) {
            const persistedMessage = stoppedRun.messages.find(item => item && item.id === stoppedMessage.id);
            if (persistedMessage) {
                persistedMessage.text = stoppedMessage.text;
                persistedMessage.busy = false;
                persistedMessage.canRetry = true;
            }
            stopStateDurable = core.saveRun(stoppedRun) && stopStateDurable;
        }
        if (runtime.currentController === execution) {
            runtime.busy = false;
            runtime.currentController = null;
            runtime.hint = '';
        }
        if (!runtime.busy && runtime.currentRun === stoppedRun) {
            stopStateDurable = saveCurrentRunMessages(stoppedRun) && stopStateDurable;
            loadRuns();
            bindAssistantSteps(stoppedRun);
            setToast(!stopStateDurable
                ? 'The run stopped locally, but that stopped state could not be saved. Export any partial output and reload before starting more work.'
                : runtime.unacknowledgedCancelIds.size
                ? 'Run stopped locally; Blueprint will re-check backend cancellation before another model turn.'
                : 'Run stopped.', !stopStateDurable ? 'error' : (runtime.unacknowledgedCancelIds.size ? 'warn' : 'info'), 10000);
            flushPendingRestoreState();
            renderHostSurfaces();
            renderPage();
        }
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
            const settle = value => {
                if (signal) signal.removeEventListener('abort', onAbort);
                runtime.answerResolver = null;
                if (value === null || value === undefined) {
                    resolve(null);
                    return Promise.resolve(false);
                }
                let acknowledged = false;
                let acknowledgeCommit;
                const committed = new Promise(commitResolve => { acknowledgeCommit = commitResolve; });
                resolve({
                    answer: String(value),
                    acknowledge(ok) {
                        if (acknowledged) return;
                        acknowledged = true;
                        acknowledgeCommit(Boolean(ok));
                    }
                });
                // sendMessage waits for this before consuming the draft. The
                // agent resolves it only after the answer is part of a durable
                // run checkpoint.
                return committed;
            };
            const onAbort = () => {
                if (runtime.answerResolver) settle(null);
            };
            runtime.answerResolver = settle;
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    function bindAssistantSteps(runOverride) {
        const run = runOverride || runtime.currentRun;
        if (!run) return null;
        const message = [...runtime.messages].reverse().find(item => item
            && item.role === 'assistant'
            && String(item.runId || run.id) === String(run.id));
        if (!message) return null;
        message.runId = run.id;
        message.steps = run.phases || [];
        message.paths = (run.writtenPaths || []).slice();
        message.writtenFiles = (run.writtenFiles || []).map(ref => Object.assign({}, ref));
        message.folderId = run.folderId || message.folderId || '';
        message.status = run.status;
        return message;
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
            if (!runtime.active || !isAgentTabActive()) return;
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
        }, 200);
    }

    function stopLiveTicker() {
        if (runtime.liveTickerTimer) {
            clearInterval(runtime.liveTickerTimer);
            runtime.liveTickerTimer = null;
        }
    }

    async function runGapRepair(run, path, review) {
        if (operationBusy()) return false;
        if (!await ensureBackendIdle() || operationBusy()) return false;
        if (!run || !run.id) return false;
        if (!runtime.currentRun || runtime.currentRun.id !== run.id) {
            if (!openStoredRun(run.id, true)) return false;
            run = runtime.currentRun;
        }
        const ownerMessages = runtime.messages;
        const folderId = String((review && review.folderId) || (run && run.folderId) || currentFolderId());
        if (typeof core.claimRunOwnership === 'function' && !core.claimRunOwnership(run.id)) {
            setToast('This run is active in another Blueprint window, so gap repair did not start.', 'warn', 10000);
            return false;
        }
        runtime.generation += 1;
        const generation = runtime.generation;
        runtime.busy = true;
        runtime.hint = `Repairing gaps in ${path.split('/').pop()}…`;
        const previousStatus = run.status;
        const previousError = run.error;
        run.status = 'running';
        run.error = '';
        if (!core.saveRun(run)) {
            run.status = previousStatus;
            run.error = previousError;
            runtime.busy = false;
            runtime.hint = '';
            if (typeof core.releaseRunOwnership === 'function') core.releaseRunOwnership(run.id);
            setToast('Gap repair did not start because its active state could not be saved.', 'error', 8000);
            flushPendingRestoreState();
            renderHostSurfaces();
            renderPage();
            return false;
        }
        startLiveTicker();
        renderHostSurfaces();
        renderPage();

        const execution = createExecutionController(run, { reuseClaimedOwnership: true });
        if (!execution.ownershipClaimed) {
            run.status = previousStatus;
            run.error = previousError;
            core.saveRun(run);
            if (typeof core.releaseRunOwnership === 'function') core.releaseRunOwnership(run.id);
            runtime.busy = false;
            runtime.hint = '';
            setToast('This run is active in another Blueprint window, so gap repair did not start.', 'warn', 10000);
            return false;
        }
        const lifecycle = requestLifecycleHooks(execution);
        const durableCheckpoint = createDurableRunCheckpoint(run, execution);
        runtime.currentController = execution;
        const settlementToken = beginExecutionSettlement(execution, generation);

        try {
            const result = await agent.reviseDocumentGaps(run, path, review, {
                onRender: () => { if (generation === runtime.generation) { bindAssistantSteps(run); renderPage(); } },
                onStep: () => { if (generation === runtime.generation) { bindAssistantSteps(run); scrollTranscriptToEnd(); } },
                onStream: () => {
                    assertExecutionOwner(execution, generation);
                    durableCheckpoint.checkpoint(false);
                    if (generation === runtime.generation) scrollTranscriptToEnd();
                },
                onState: () => {
                    assertExecutionOwner(execution, generation);
                    durableCheckpoint.checkpoint(true);
                },
                onFileWritten: (writtenPath, writtenFolderId) => {
                    if (generation === runtime.generation) noteFileWritten(writtenPath, writtenFolderId || folderId);
                },
                onRequestStart: lifecycle.onRequestStart,
                onRequestDispatched: lifecycle.onRequestDispatched,
                onRequestEnd: lifecycle.onRequestEnd
            }, { signal: execution.signal, folderId });
            assertExecutionOwner(execution, generation);

            const requiredSections = review && Array.isArray(review.requiredSections)
                ? review.requiredSections
                : (review && Array.isArray(review.required) ? review.required : []);
            const nextReview = {
                path,
                folderId,
                ok: result.review.ok,
                requiredSections: requiredSections.slice(),
                missing: result.review.missing,
                placeholders: result.review.placeholders,
                thin: result.review.thin
            };
            const reviews = Array.isArray(run.reviews) ? run.reviews.slice() : [];
            const reviewIndex = reviews.findIndex(item => item && item.path === path
                && String(item.folderId || run.folderId || '') === folderId);
            if (reviewIndex >= 0) reviews[reviewIndex] = nextReview;
            else reviews.push(nextReview);
            run.reviews = reviews;
            const reviewStep = (run.phases || []).find(step => step && step.reviewPath === path
                && String(step.reviewFolderId || run.folderId || '') === folderId);
            if (reviewStep) {
                reviewStep.status = result.review.ok ? 'done' : 'error';
                reviewStep.canRepair = !result.review.ok;
                reviewStep.summary = result.review.ok
                    ? 'All required sections are now present'
                    : `${result.review.missing.length} required section(s) still missing`;
                reviewStep.error = result.review.ok
                    ? '' : 'The repaired document still does not satisfy its required-section contract.';
            }
            run.status = reviews.some(item => item && item.ok === false) ? 'gaps' : 'done';
            run.error = '';
            if (!core.saveRun(run)) {
                throw new Error('The repaired document is in memory, but its terminal run state could not be saved.');
            }

            setToast(result.review.ok
                ? `Gaps repaired in ${path.split('/').pop()}!`
                : `${result.review.missing.length} required section(s) still need work.`,
            result.review.ok ? 'success' : 'warn');
        } catch (error) {
            if (generation !== runtime.generation) return false;
            if (execution.persistenceFailure) error = execution.persistenceFailure;
            run.status = error && error.code === 'aborted' ? 'stopped' : 'gaps';
            run.repairError = String((error && error.message) || error || 'Gap repair failed.');
            const durable = core.saveRun(run);
            setToast(durable
                ? `Gap repair ${run.status === 'stopped' ? 'stopped' : 'failed'}: ${run.repairError}`
                : `Gap repair stopped and its terminal state could not be saved: ${run.repairError}`, 'error', 10000);
        } finally {
            if (generation === runtime.generation) {
                const checkpointDurable = durableCheckpoint.finish();
                runtime.busy = false;
                runtime.hint = '';
                runtime.currentController = null;
                stopLiveTicker();
                bindAssistantSteps(run);
                const transcriptDurable = saveCurrentRunMessages(run, ownerMessages);
                loadRuns();
                if (!checkpointDurable || !transcriptDurable) {
                    setToast('Gap repair settled in memory, but its transcript could not be saved. Export the document before reloading.', 'error', 10000);
                }
                flushPendingRestoreState();
                renderHostSurfaces();
                renderPage();
            } else durableCheckpoint.cancel();
            finishExecutionSettlement(settlementToken);
        }
        return true;
    }

    async function runSelectedSkill(idea, runOptions) {
        const opts = runOptions || {};
        if (!userRequestFits(idea, 'That request')) return false;
        if (operationBusy()) {
            setToast(runtime.busyImport
                ? 'Wait for the folder import to finish before starting an agent run.'
                : 'Stop the active operation before starting another run.', 'warn');
            return false;
        }
        if (!await ensureBackendIdle() || operationBusy()) return false;
        const skill = (opts.skillId && skills.getSkill(opts.skillId)) || selectedSkill();
        const contextRun = runtime.currentRun;
        const previousActiveRunId = String(core.store.activeRunId || '');
        const run = core.createRun(skill, idea, { folderId: opts.folderId });
        if (run.persistenceError || !core.findRun(run.id)) {
            setToast(`Could not start the run: ${run.persistenceError || 'the initial run state was not saved.'}`, 'error', 8000);
            return false;
        }
        const runFolderId = run.folderId || currentFolderId();

        const assistantMessage = {
            id: core.uid('msg'),
            role: 'assistant',
            at: new Date().toISOString(),
            skillName: skill.name,
            steps: run.phases,
            paths: [],
            text: '',
            busy: true,
            runId: run.id,
            skillId: skill.id,
            folderId: runFolderId,
            idea: String(idea || '')
        };
        const sameRootContext = Boolean(contextRun
            && String(contextRun.folderId || '') === String(runFolderId));
        run.transcriptMode = 'run-local-v1';
        run.contextRunId = sameRootContext ? String(contextRun.id || '') : '';
        if (sameRootContext && runtime.compaction
            && (!runtime.compaction.folderId
                || String(runtime.compaction.folderId) === String(runFolderId))) {
            // Retain the bounded summary on the child so a 60-run history prune
            // cannot strand the newest run without the context it was given.
            run.compaction = Object.assign({}, runtime.compaction);
        }
        const ownerMessages = sameRootContext ? runtime.messages : [];
        if (!sameRootContext) {
            runtime.messages = ownerMessages;
            runtime.compaction = null;
        }
        const initialMessageCount = ownerMessages.length;
        if (typeof opts.userMessageText === 'string') {
            ownerMessages.push({
                id: core.uid('msg'),
                role: 'user',
                at: new Date().toISOString(),
                runId: run.id,
                folderId: runFolderId,
                messageKind: 'run-prompt',
                text: opts.userMessageText
            });
        }
        ownerMessages.push(assistantMessage);
        if (typeof opts.onBeforeStart === 'function') {
            try { opts.onBeforeStart(run, assistantMessage); } catch (_) { /* caller state is optional */ }
        }
        if (!saveCurrentRunMessages(run, ownerMessages)) {
            ownerMessages.splice(initialMessageCount);
            const cleaned = core.deleteRun(run.id, {
                expectedLeaseId: typeof core.runLeaseId === 'function' ? core.runLeaseId(run) : ''
            });
            if (!cleaned) {
                runtime.recoveryPersistenceBlocked = true;
                runtime.hint = 'Run startup failed and its durable running marker could not be cleaned up. Reload to recover before starting more work.';
            }
            setToast(cleaned
                ? 'Could not start the run because its initial transcript was not saved. Your prompt was left in the composer.'
                : runtime.hint, 'error', 10000);
            return false;
        }

        runtime.explicitNoRun = false;
        runtime.currentRun = run;
        runtime.activeRunId = run.id;
        runtime.projectName = run.projectName || runtime.projectName;

        const controller = createExecutionController(run, { reuseClaimedOwnership: true });
        if (!controller.ownershipClaimed) {
            // createRun saved a durable running marker before the execution lease
            // is refreshed here. If another window won that lease (or storage
            // failed), do not enter busy state and never dispatch a model turn.
            // Remove only a marker that is not actively owned elsewhere.
            ownerMessages.splice(initialMessageCount);
            const owner = typeof core.readRunOwner === 'function' ? core.readRunOwner(run.id) : null;
            const foreignLive = Boolean(owner && owner.live && !owner.owned);
            let cleaned = foreignLive ? false : core.deleteRun(run.id, {
                expectedLeaseId: typeof core.runLeaseId === 'function' ? core.runLeaseId(run) : ''
            });
            if (foreignLive && typeof core.restoreSelection === 'function') {
                core.restoreSelection({ activeRunId: previousActiveRunId });
            }
            if (!cleaned && !foreignLive) {
                runtime.recoveryPersistenceBlocked = true;
                runtime.hint = 'Run startup lost its execution lease and its durable running marker could not be cleaned up. Reload to recover before starting more work.';
            }
            refreshForeignRunOwners();
            scheduleForeignRunRecovery();
            loadRuns();
            setToast(foreignLive
                ? 'This run became active in another Blueprint window before it started here. No model request was sent.'
                : cleaned
                    ? 'The run could not secure its execution lease, so it was cancelled before any model request was sent. Your prompt was left in the composer.'
                    : runtime.hint, foreignLive ? 'warn' : 'error', 10000);
            renderHostSurfaces();
            renderPage();
            return false;
        }
        runtime.currentController = controller;
        runtime.busy = true;
        runtime.hint = `Running ${skill.name}…`;
        startLiveTicker();
        if (typeof opts.onStarted === 'function') {
            try { opts.onStarted(run, assistantMessage); } catch (_) { /* UI acknowledgement is best-effort */ }
        }

        runtime.generation += 1;
        const generation = runtime.generation;
        const stale = () => generation !== runtime.generation;
        const settlementToken = beginExecutionSettlement(controller, generation);

        const input = {
            idea,
            answers: Array.isArray(opts.answers) ? opts.answers.slice() : [],
            reuseSuppliedAnswers: opts.reuseSuppliedAnswers === true,
            signal: controller.signal,
            requirementsText: idea,
            activeFolderId: runFolderId,
            sourceFiles: activeSourceFiles(runFolderId),
            // Path context: the live handle is passed by reference and read at
            // the source gate. It is deliberately NOT written into `run` —
            // checkpointing saves `run` only, and a live FileSystemDirectoryHandle
            // cannot survive serialization anyway.
            pathContext: pathContextForRun(),
            selectedOptions: Array.isArray(opts.selectedOptions) ? opts.selectedOptions.slice() : null,
            compaction: sameRootContext && runtime.compaction
                && (!runtime.compaction.folderId
                    || String(runtime.compaction.folderId) === String(runFolderId))
                ? runtime.compaction
                : null
        };

        try {
            const lifecycle = requestLifecycleHooks(controller);
            const result = await agent.runSkill(run, skill, input, {
                onRender: () => { if (!stale()) { bindAssistantSteps(run); renderPage(); } },
                onStep: step => {
                    if (stale()) return;
                    bindAssistantSteps(run);
                    if (step.status === 'running') scrollTranscriptToEnd();
                },
                // The merge left a SECOND onStep key here from Gemini's side of the
                // conflict. Duplicate keys in one object literal are legal JS, so
                // the later one silently won — and it called isCancelled(), the
                // cancellation helper Sol replaced with the generation counter.
                // That threw a ReferenceError on every step. Sol's onStep above is
                // the one to keep; onStream keeps Gemini's tab-visibility guard but
                // uses stale() for cancellation.
                onStream: () => {
                    if (stale()) return;
                    if (runtime.active && isAgentTabActive()) scrollTranscriptToEnd();
                },
                // Open an editor tab for each document the skill writes, per
                // Settings -> Agent -> Planning -> "Open written documents".
                onFileWritten: (path, folderId) => {
                    if (!stale()) noteFileWritten(path, folderId || runFolderId);
                },
                onRequestStart: lifecycle.onRequestStart,
                onRequestDispatched: lifecycle.onRequestDispatched,
                onRequestEnd: lifecycle.onRequestEnd,
                onPersistenceError: error => {
                    controller.persistenceFailure = error;
                    try { controller.abort.abort(); } catch (_) { /* already stopped */ }
                },
                confirmOverwrite: path => {
                    if (typeof window.confirm !== 'function') return false;
                    return window.confirm(`${path} already exists. Replace it?\n\nChoose Cancel to keep it and write a versioned copy instead.`);
                },
                // The agent owns the question sequence; the page only surfaces it.
                askQuestion: async (step, question) => {
                    const pending = {
                        stepId: step.id,
                        question: step.question,
                        section: (question && question.section) || step.section || '',
                        id: step.label,
                        options: (question && question.multi) || step.options || [],
                        submitting: false
                    };
                    runtime.pendingQuestion = pending;
                    bindAssistantSteps(run);
                    renderPage();
                    focusComposer();
                    const submission = await waitForAnswer(controller.signal);
                    if (!submission && runtime.pendingQuestion === pending) {
                        runtime.pendingQuestion = null;
                        renderPage();
                    }
                    return submission;
                }
            });

            if (stale()) return;
            assistantMessage.paths = result.writtenPaths || run.writtenPaths || [];
            assistantMessage.writtenFiles = result.writtenFiles || run.writtenFiles || [];
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
            if (controller.persistenceFailure) error = controller.persistenceFailure;
            if (error && (error.code === 'aborted'
                || error.code === 'waiting-for-source'
                || error.code === 'missing-prd'
                || error.code === 'scope-not-found')) {
                assistantMessage.text = error.code === 'aborted'
                    ? 'Stopped. Tell me what to change and I will pick this back up.'
                    : error.code === 'waiting-for-source'
                        ? 'This skill must read the actual code. Add the source files in Project Files, then run it again.'
                        : error.code === 'scope-not-found'
                            ? 'That subsystem did not match a project path. Name a listed folder/module, or choose the whole codebase.'
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
            let shouldAutoCompact = false;
            let autoCompactMessages = null;
            if (!stale()) {
                stopLiveTicker();
                runtime.busy = false;
                assistantMessage.busy = false;
                runtime.hint = '';
                runtime.pendingQuestion = null;
                runtime.currentController = null;
                const transcriptDurable = saveCurrentRunMessages(run, ownerMessages);
                loadRuns();
                bindAssistantSteps(run);
                if (!transcriptDurable) {
                    setToast('The run settled in memory, but its final transcript could not be saved. Export any useful output before reloading.', 'error', 10000);
                }
                renderHostSurfaces();
                renderPage();
                scrollTranscriptToEnd();
                shouldAutoCompact = transcriptDurable && core.persistenceState().ok;
                autoCompactMessages = runtime.messages;
                flushPendingRestoreState();
            }
            finishExecutionSettlement(settlementToken);
            if (shouldAutoCompact) {
                scheduleAutoCompaction(run, autoCompactMessages, generation);
            }
            checkAutoCompaction();
        }
        return true;
    }

    async function sendMessage() {
        if (runtime.busy && !runtime.pendingQuestion) return;
        if (runtime.busyImport || runtime.cancellationCheckBusy) {
            setToast('Finish the active operation before sending another request.', 'warn');
            return;
        }
        const elements = hostElements();
        const composer = elements && elements.settingsContainer
            ? elements.settingsContainer.querySelector('[data-cb-role="composer"]')
            : null;
        const composerText = String((composer && composer.value) || runtime.draft || '');
        const text = composerText.trim();
        if (!text) {
            setToast(runtime.pendingQuestion ? 'Please enter an answer first.' : 'Describe your idea first.', 'warn');
            focusComposer();
            return;
        }
        if (!userRequestFits(text, runtime.pendingQuestion ? 'That answer' : 'That request')) return;
        const consumeComposer = () => {
            runtime.draft = '';
            if (composer) composer.value = '';
        };

        // A pending clarifying question consumes the message as an answer.
        if (runtime.pendingQuestion) {
            await submitPendingAnswer(text, runtime.pendingQuestion.stepId, consumeComposer);
            return;
        }

        // ---- Slash command routing ----
        const trimmed = text.trim();
        const COMMAND_MAP = {
            '/prd': 'prd-builder',
            '/mvp': 'mvp-checklist',
            '/gtm': 'gtm-plan',
            '/arch': 'arch-evaluation',
            '/docs': 'doc-generation',
            '/code2prd': 'code-to-prd'
        };
        const firstToken = trimmed.split(/\s+/)[0].toLowerCase();
        if (firstToken === '/clear') {
            consumeComposer();
            clearChat();
            return;
        }
        if (firstToken === '/compact') {
            consumeComposer();
            await compactContext({ useModel: true });
            return;
        }
        if (firstToken === '/files' || firstToken === '/selector') {
            openFileSelectorOverlay();
            return;
        }
        if (firstToken === '/review') {
            const focusPrompt = trimmed.slice(firstToken.length).trim();
            runtime.selectedSkillId = 'arch-eval';
            if (!runtime.sourceFiles.length) {
                openFileSelectorOverlay({ search: focusPrompt });
                setToast('Select the files you want to review.', 'info');
                return;
            }
            const reviewText = focusPrompt || 'Conduct a comprehensive architecture and code quality review of the attached source files.';
            runtime.messages.push({
                id: core.uid('msg'),
                role: 'user',
                at: new Date().toISOString(),
                text: trimmed
            });
            renderPage();
            scrollTranscriptToEnd();
            await runSelectedSkill(reviewText);
            return;
        }
        if (firstToken === '/help') {
            consumeComposer();
            const helpText = [
                '**Anti-gravity Slash Commands:**',
                '- `/prd <idea>` — Build PRD with 3 concurrent lenses',
                '- `/mvp <idea>` — Generate MVP scope, candidate matrix & cut list',
                '- `/gtm <idea>` — Generate go-to-market plan & exit criteria',
                '- `/arch <idea>` — Evaluate codebase architecture against requirements',
                '- `/docs <idea>` — Generate backlog, API contract sketch, and onboarding docs',
                '- `/code2prd` — Reverse-engineer a PRD from attached codebase',
                '- `/files` — Open File Selector & Review Manager overlay',
                '- `/review <focus>` — Review attached files with Architecture Evaluation',
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
                consumeComposer();
                const targetSkill = skills.getSkill(targetSkillId);
                setToast(`Selected ${targetSkill ? targetSkill.name : targetSkillId}. Now describe your idea.`, 'info');
                renderHostSurfaces();
                renderPage();
                focusComposer();
                return;
            }
        }

        await runSelectedSkill(ideaText, {
            userMessageText: ideaText,
            onStarted: () => {
                consumeComposer();
                renderPage();
                scrollTranscriptToEnd();
            }
        });
    }

    /**
     * Submit any clarifying-answer surface through one durable, step-qualified
     * handshake. A historical chip cannot answer the current question, a double
     * click cannot resolve twice, and the text remains available after failure.
     */
    async function submitPendingAnswer(answer, stepId, onCommit) {
        const text = String(answer || '').trim();
        const pending = runtime.pendingQuestion;
        if (!text || !pending) return false;
        if (!userRequestFits(text, 'That answer')) return false;
        if (stepId && String(stepId) !== String(pending.stepId || '')) return false;
        if (!runtime.answerResolver || pending.submitting) {
            setToast('That answer is still being saved. Please wait before sending another.', 'info');
            return false;
        }

        const resolver = runtime.answerResolver;
        const step = findStep(pending.stepId);
        pending.submitting = true;
        runtime.draft = text;
        if (step) step.answerDraft = text;
        renderPage();

        let committed = false;
        try {
            committed = await resolver(text);
        } catch (_) {
            committed = false;
        }
        if (committed) {
            if (typeof onCommit === 'function') onCommit();
            else runtime.draft = '';
            if (step) delete step.answerDraft;
            if (runtime.pendingQuestion === pending) runtime.pendingQuestion = null;
            renderPage();
            return true;
        }

        if (runtime.pendingQuestion === pending) pending.submitting = false;
        // runtime.draft and step.answerDraft deliberately retain the exact value.
        setToast('The answer could not be saved. Your text is still here; try again after freeing browser storage.', 'error', 10000);
        renderPage();
        focusComposer();
        return false;
    }

    async function reviseDocument(messageId, retryOptions) {
        const opts = retryOptions || {};
        if (operationBusy()) {
            setToast('Stop the active operation before starting a revision.', 'warn');
            return false;
        }
        if (!await ensureBackendIdle() || operationBusy()) return false;
        const message = runtime.messages.find(item => item.id === messageId);
        if (!message) return false;
        const run = (opts.runId && core.findRun(opts.runId))
            || (message.runId && core.findRun(message.runId))
            || core.findRun(runtime.activeRunId);
        const requestedFolderId = String(opts.targetFolderId
            || message.targetFolderId
            || message.folderId
            || '');
        if (run && requestedFolderId && requestedFolderId !== String(run.folderId || '')) {
            setToast('That revision reference belongs to a different project root, so Blueprint refused it.', 'error', 10000);
            return false;
        }
        const folderId = String((run && run.folderId)
            || requestedFolderId
            || core.store.openFolderId
            || currentFolderId());
        const paths = (run && run.writtenPaths) || [];
        const explicitTarget = String(opts.targetPath || message.targetPath || '');
        const target = explicitTarget
            || paths.find(path => core.readFile(path, folderId))
            || (core.store.openFolderId === folderId ? core.store.openPath : '');
        if (explicitTarget && !core.readFile(explicitTarget, folderId)) {
            setToast(`Cannot revise ${explicitTarget}: it no longer exists in the original project root.`, 'warn');
            return false;
        }
        if (!target) {
            setToast('No written document to revise yet.', 'warn');
            return false;
        }
        const instruction = String(opts.instruction
            || window.prompt(`Revise ${target}\n\nWhat should change?`)
            || '').trim();
        if (!instruction) return false;
        if (!userRequestFits(instruction, 'That revision instruction')) return false;

        const record = core.readFile(target, folderId);
        const createdRevisionRun = !run;
        const reviseRun = run || core.createRun(selectedSkill(), instruction, { folderId });
        if (reviseRun.persistenceError || !core.findRun(reviseRun.id)) {
            setToast(`Could not start the revision: ${reviseRun.persistenceError || 'the initial run state was not saved.'}`, 'error', 8000);
            return false;
        }
        if (createdRevisionRun) {
            reviseRun.transcriptMode = 'run-local-v1';
            reviseRun.contextRunId = '';
        }
        if (!createdRevisionRun && typeof core.claimRunOwnership === 'function'
            && !core.claimRunOwnership(reviseRun.id)) {
            setToast('This run is active in another Blueprint window, so the revision did not start.', 'warn', 10000);
            return false;
        }
        const revisionLeaseId = typeof core.runLeaseId === 'function'
            ? core.runLeaseId(reviseRun) : String(((typeof core.readRunOwner === 'function'
                && core.readRunOwner(reviseRun.id)) || {}).leaseId || '');
        const previousFolderId = reviseRun.folderId;
        reviseRun.folderId = folderId;
        const ownerMessages = runtime.messages;
        const initialMessageCount = ownerMessages.length;
        const assistantMessage = {
            id: core.uid('msg'),
            role: 'assistant',
            at: new Date().toISOString(),
            skillName: 'Revision',
            steps: reviseRun.phases,
            paths: [],
            text: '',
            busy: true,
            runId: reviseRun.id,
            skillId: reviseRun.skillId,
            idea: instruction,
            retryKind: 'revision',
            targetPath: target,
            targetFolderId: folderId,
            folderId,
            revisionInstruction: instruction
        };
        const previousStatus = reviseRun.status;
        const previousError = reviseRun.error;
        const previousPhaseCount = reviseRun.phases.length;
        const previousRunMessages = reviseRun.messages;
        const rollbackRevisionStartup = () => {
            ownerMessages.splice(initialMessageCount);
            reviseRun.phases.splice(previousPhaseCount);
            reviseRun.status = previousStatus;
            reviseRun.error = previousError;
            reviseRun.folderId = previousFolderId;
            if (previousRunMessages === undefined) delete reviseRun.messages;
            else reviseRun.messages = previousRunMessages;

            const cleaned = createdRevisionRun
                ? core.deleteRun(reviseRun.id, { expectedLeaseId: revisionLeaseId })
                : core.saveRun(reviseRun);
            // Keep a failed cleanup fenced until expiry/reload recovery. Releasing
            // first would expose a durable running transcript to another window.
            if (cleaned && !createdRevisionRun
                && typeof core.releaseRunOwnership === 'function') {
                core.releaseRunOwnership(reviseRun.id, revisionLeaseId);
            }
            if (!cleaned) {
                runtime.recoveryPersistenceBlocked = true;
                runtime.hint = 'Revision startup failed and its durable running marker could not be cleaned up. Reload to recover before starting more work.';
            }
            return cleaned;
        };
        reviseRun.status = 'running';
        reviseRun.error = '';

        const step = agent.makeStep({
            kind: 'document',
            label: `Revise ${target}`,
            summary: instruction,
            status: 'pending',
            open: true
        });
        reviseRun.phases.push(step);
        if (!core.saveRun(reviseRun)) {
            const cleaned = rollbackRevisionStartup();
            setToast(cleaned
                ? 'The revision did not start because its active step could not be saved.'
                : runtime.hint, 'error', 10000);
            return false;
        }

        ownerMessages.push({
            id: core.uid('msg'),
            role: 'user',
            at: new Date().toISOString(),
            runId: reviseRun.id,
            folderId,
            messageKind: 'revision',
            text: `Revise \`${target}\`: ${instruction}`
        });
        ownerMessages.push(assistantMessage);
        if (typeof opts.onBeforeStart === 'function') {
            try { opts.onBeforeStart(reviseRun, assistantMessage); } catch (_) { /* caller state is optional */ }
        }
        if (!saveCurrentRunMessages(reviseRun, ownerMessages)) {
            const cleaned = rollbackRevisionStartup();
            setToast(cleaned
                ? 'The revision did not start because its initial transcript was not saved.'
                : runtime.hint, 'error', 10000);
            return false;
        }

        const execution = createExecutionController(reviseRun, { reuseClaimedOwnership: true });
        if (!execution.ownershipClaimed) {
            const cleaned = rollbackRevisionStartup();
            setToast(cleaned
                ? 'The revision could not secure the model execution lease, so no request was sent.'
                : runtime.hint, cleaned ? 'warn' : 'error', 10000);
            return false;
        }
        const lifecycle = requestLifecycleHooks(execution);
        const durableCheckpoint = createDurableRunCheckpoint(reviseRun, execution);
        runtime.currentController = execution;
        runtime.busy = true;
        runtime.currentRun = reviseRun;
        runtime.activeRunId = reviseRun.id;
        runtime.explicitNoRun = false;
        runtime.generation += 1;
        const generation = runtime.generation;
        const settlementToken = beginExecutionSettlement(execution, generation);
        const settings = core.readSettings();
        if (typeof opts.onStarted === 'function') {
            try { opts.onStarted(reviseRun, assistantMessage); } catch (_) { /* UI acknowledgement is best-effort */ }
        }
        renderPage();

        try {
            const compactionPrefix = runtime.compaction ? (agent.formatCompactionPrompt(runtime.compaction) + '\n\n---\n\n') : '';
            const existingContent = String((record && record.content) || '');
            const existingBackticks = existingContent.match(/`+/g) || [];
            const existingFence = '`'.repeat(Math.max(
                3,
                existingBackticks.reduce((max, item) => Math.max(max, item.length), 0) + 1
            ));
            await agent.runModelStep(step, {
                systemPrompt: agent.systemPromptWith(
                    'You are a product planning analyst revising one document. Return only the complete revised Markdown document, with no preamble and no commentary.',
                    settings
                ),
                prompt: [
                    compactionPrefix + `You are revising ${target} for ${reviseRun.projectName || 'the project'}.`,
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
                    existingFence,
                    existingContent,
                    existingFence
                ].join('\n'),
                maxOutputTokens: settings.documentMaxOutputTokens,
                signal: execution.signal,
                runId: reviseRun.id,
                runLeaseId: execution.ownerLeaseId
            }, {
                onRender: () => { if (generation === runtime.generation) renderPage(); },
                onStream: () => {
                    assertExecutionOwner(execution, generation);
                    durableCheckpoint.checkpoint(false);
                    if (generation === runtime.generation) scrollTranscriptToEnd();
                },
                onState: () => {
                    assertExecutionOwner(execution, generation);
                    durableCheckpoint.checkpoint(true);
                },
                onRequestStart: lifecycle.onRequestStart,
                onRequestDispatched: lifecycle.onRequestDispatched,
                onRequestEnd: lifecycle.onRequestEnd
            });

            assertExecutionOwner(execution, generation);
            const meta = {
                date: core.todayStamp(),
                slug: reviseRun.slug || core.slugify(reviseRun.projectName || 'project'),
                projectName: reviseRun.projectName || runtime.projectName || 'Project'
            };
            const revisedContent = agent.applyDocumentHeader(step.completeText || step.text, meta, '', settings, reviseRun.skillName);
            const written = core.writeFile(target, revisedContent, {
                runId: reviseRun.id,
                runLeaseId: execution.ownerLeaseId,
                skill: reviseRun.skillId,
                folder: folderId
            });
            if (!written) throw new Error(`Could not save ${target}.`);
            const persistence = core.persistenceState();
            if (!persistence.ok) {
                const failure = new Error(`The revision could not be saved to browser storage (${persistence.lastError || 'storage unavailable'}).`);
                failure.code = 'storage-failure';
                throw failure;
            }
            const writtenPath = written.path || target;
            noteFileWritten(writtenPath, folderId);
            assistantMessage.paths = [writtenPath];
            assistantMessage.writtenFiles = [{ path: writtenPath, folderId }];
            assistantMessage.text = `Revised \`${writtenPath}\`. Review the changes in the project tree.`;
            reviseRun.writtenPaths = Array.from(new Set([...(reviseRun.writtenPaths || []), writtenPath]));
            const writtenRefs = Array.isArray(reviseRun.writtenFiles) ? reviseRun.writtenFiles.slice() : [];
            if (!writtenRefs.some(item => item && item.path === writtenPath && item.folderId === folderId)) {
                writtenRefs.push({ path: writtenPath, folderId });
            }
            reviseRun.writtenFiles = writtenRefs;
            const priorReview = (Array.isArray(reviseRun.reviews) ? reviseRun.reviews : [])
                .find(item => item && item.path === target
                    && String(item.folderId || reviseRun.folderId || '') === folderId);
            const requiredSections = priorReview && Array.isArray(priorReview.requiredSections)
                ? priorReview.requiredSections
                : (priorReview && Array.isArray(priorReview.required) ? priorReview.required : []);
            if (requiredSections.length) {
                const nextReviewResult = agent.reviewDocument(revisedContent, requiredSections);
                const nextReview = {
                    path: writtenPath,
                    folderId,
                    ok: nextReviewResult.ok,
                    requiredSections: requiredSections.slice(),
                    missing: nextReviewResult.missing,
                    placeholders: nextReviewResult.placeholders,
                    thin: nextReviewResult.thin
                };
                const reviews = (reviseRun.reviews || []).filter(item => item !== priorReview);
                reviews.push(nextReview);
                reviseRun.reviews = reviews;
                const reviewStep = agent.makeStep({
                    kind: 'notice',
                    label: `Re-checked ${writtenPath}`,
                    summary: nextReviewResult.ok
                        ? 'Required-section contract satisfied'
                        : `${nextReviewResult.missing.length} missing · ${nextReviewResult.thin.length} thin`,
                    status: nextReviewResult.ok ? 'done' : 'error',
                    text: nextReviewResult.ok
                        ? 'The revised document satisfies every required section with substantive content.'
                        : 'The revision was saved, but it still does not satisfy the document contract. Use Repair Gaps or revise it again.',
                    reviewPath: writtenPath,
                    reviewFolderId: folderId,
                    canRepair: !nextReviewResult.ok,
                    open: !nextReviewResult.ok
                });
                reviseRun.phases.push(reviewStep);
            }
            reviseRun.status = (reviseRun.reviews || []).some(item => item && item.ok === false)
                ? 'gaps' : 'done';
            assistantMessage.status = reviseRun.status;
            if (reviseRun.status === 'gaps') {
                assistantMessage.text = `Revised \`${writtenPath}\`, but the required-section check still found gaps.`;
            }
            reviseRun.completedAt = new Date().toISOString();
            setToast(reviseRun.status === 'gaps'
                ? 'Document revised, but structural gaps remain.'
                : 'Document revised.', reviseRun.status === 'gaps' ? 'warn' : 'success');
        } catch (error) {
            if (generation !== runtime.generation) return;
            if (execution.persistenceFailure) error = execution.persistenceFailure;
            assistantMessage.text = `Revision stopped: ${String((error && error.message) || 'failed')}`;
            assistantMessage.canRetry = true;
            reviseRun.status = error && error.code === 'aborted' ? 'stopped' : 'error';
            reviseRun.error = String((error && error.message) || 'Revision failed.');
            reviseRun.completedAt = new Date().toISOString();
            setToast(assistantMessage.text, 'error');
        } finally {
            let shouldAutoCompact = false;
            let autoCompactMessages = null;
            if (generation === runtime.generation) {
                const checkpointDurable = durableCheckpoint.finish();
                assistantMessage.busy = false;
                runtime.busy = false;
                runtime.currentController = null;
                const transcriptDurable = saveCurrentRunMessages(reviseRun, ownerMessages);
                if (!checkpointDurable || !transcriptDurable) {
                    setToast('The revision finished in memory, but its final transcript could not be saved. Reload only after exporting or retrying the save.', 'error', 10000);
                }
                loadRuns();
                renderHostSurfaces();
                renderPage();
                shouldAutoCompact = checkpointDurable && transcriptDurable
                    && core.persistenceState().ok;
                autoCompactMessages = runtime.messages;
                flushPendingRestoreState();
            }
            else durableCheckpoint.cancel();
            finishExecutionSettlement(settlementToken);
            if (shouldAutoCompact) {
                scheduleAutoCompaction(reviseRun, autoCompactMessages, generation);
            }
        }
        return true;
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
        if (operationBusy()) {
            setToast(runtime.busyImport
                ? 'Wait for the folder import to finish before changing project roots.'
                : 'Stop the active operation before changing its project folder.', 'warn');
            return;
        }
        const folder = core.getFolder(folderId);
        if (!folder) {
            setToast('That folder no longer exists.', 'error');
            return;
        }
        if (String(folder.id) === String(currentFolderId())) return;
        if (runtime.currentRun && runtime.messages.length && !saveCurrentRunMessages()) {
            setToast('The current transcript could not be saved, so Blueprint kept its project root open.', 'error', 8000);
            return;
        }
        const nextRun = (core.store.runs || []).find(run => run
            && String(run.folderId || '') === String(folder.id)) || null;
        if (!core.restoreSelection({
            activeFolderId: folder.id,
            activeRunId: nextRun ? nextRun.id : ''
        })) {
            setToast('The project-root selection could not be saved, so Blueprint kept the current root open.', 'error', 8000);
            return;
        }
        installFolderRunContext(folder.id, nextRun);
        renderHostSurfaces();
        renderPage();
    }

    function openNewFolderModal() {
        if (operationBusy()) {
            setToast('Finish the active operation before creating a project folder.', 'warn');
            return;
        }
        runtime.modal = {
            kind: 'folder',
            conflictSensitive: true,
            title: 'New project folder',
            icon: 'fa-folder-plus',
            description: 'Folders keep separate plans side by side. Documents Blueprint generates from here on land in the folder you create.',
            name: `${core.todayStamp()}-project`,
            nameLabel: 'Folder name',
            confirmLabel: 'Create folder',
            confirmIcon: 'fa-folder-plus',
            onConfirm: values => {
                const name = String(values.name || '').trim();
                if (runtime.currentRun && runtime.messages.length && !saveCurrentRunMessages()) {
                    setToast('The current transcript could not be saved, so Blueprint did not create a new project root.', 'error', 8000);
                    return false;
                }
                const result = core.createFolder(name, 'created');
                if (result.error) {
                    setToast(result.error, 'error');
                    return false;
                }
                installFolderRunContext(result.folder.id, null);
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
        if (operationBusy()) {
            setToast('Finish the active operation before renaming a project folder.', 'warn');
            return;
        }
        const folder = core.getFolder(folderId || core.store.activeFolderId);
        if (!folder) {
            setToast('That folder no longer exists.', 'error');
            return;
        }
        if (folder.id === core.DEFAULT_FOLDER_ID) {
            setToast('The default project folder cannot be renamed.', 'info');
            return;
        }
        const expectedFolder = core.folderSnapshot(folder.id);
        runtime.modal = {
            kind: 'folder',
            conflictSensitive: true,
            title: 'Rename folder',
            icon: 'fa-pen',
            description: `Renaming "${folder.name}" does not move or rewrite its ${core.folderFileCount(folder.id)} document(s).`,
            name: folder.name,
            nameLabel: 'Folder name',
            confirmLabel: 'Rename',
            confirmIcon: 'fa-pen',
            onConfirm: values => {
                const result = core.renameFolder(folder.id, String(values.name || ''), expectedFolder);
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
        if (operationBusy()) {
            setToast('Finish the active operation before deleting a project folder.', 'warn');
            return;
        }
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
        const expectedFolder = core.folderSnapshot(folder.id);
        runtime.modal = {
            kind: 'confirm',
            conflictSensitive: true,
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
                const result = core.deleteFolder(folder.id, expectedFolder);
                runtime.modal = null;
                if (!result.deleted) {
                    setToast(result.error || 'The folder could not be deleted.', 'error');
                    renderPage();
                    return true;
                }
                runtime.projectName = core.activeFolder().name;
                runtime.sourceFiles = runtime.sourceFiles.filter(file => {
                    const owner = String((file && (file.folderId || file.folder)) || '');
                    return owner !== folder.id;
                });
                // Any tab showing a deleted document must go, or it renders an
                // empty viewer for a path that no longer exists.
                doomed.forEach(path => noteFileDeleted(path, folder.id));
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
        if (operationBusy()) {
            setToast('Finish the active operation before importing another folder.', 'warn');
            return;
        }
        if (core.canPickDirectoryHandle && core.canPickDirectoryHandle()) {
            void pickFolderWithDirectoryHandle();
            return;
        }
        pickFolderWithInput();
    }

    async function pickFolderWithDirectoryHandle() {
        const settings = core.readSettings();
        const operation = new AbortController();
        runtime.importController = operation;
        runtime.busyImport = true;
        renderPage();
        let rootHandle;
        try {
            rootHandle = await window.showDirectoryPicker({ mode: 'read' });
        } catch (error) {
            finishImportOperation(operation);
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
        setToast(`Scanning "${rootHandle.name}"…`, 'info');
        // Keep the granted root for Path context. Importing a folder already
        // required the user to grant access to exactly the tree they want read,
        // so reusing this handle means the context path needs no second picker
        // trip. A later explicit pick overwrites it.
        runtime.pathContextRoot = rootHandle;
        runtime.pathContextRootName = String(rootHandle.name || '');
        updateImportProgress(operation, { phase: 'scan', name: rootHandle.name, done: 0, total: 0, imported: 0 });
        let collected;
        try {
            collected = await core.collectFilesFromDirectoryHandle(rootHandle, {
                signal: operation.signal,
                onProgress: found => {
                    updateImportProgress(operation, { phase: 'scan', name: rootHandle.name, done: found, total: 0, imported: 0 });
                }
            });
        } catch (error) {
            finishImportOperation(operation);
            if (error && error.code === 'aborted') {
                setToast('Folder scan cancelled.', 'info');
            } else {
                setToast(`Import failed: ${String((error && error.message) || error)}`, 'error');
            }
            renderPage();
            return;
        }

        if (collected.error) {
            finishImportOperation(operation);
            setToast(collected.error, 'warn');
            renderPage();
            return;
        }

        // runFolderImport() owns the busy state from here on; it also clears
        // the scan progress before the import phase sets its own. A partial
        // scan (some folders locked) reaches here with files populated and
        // error empty — the locked counts are reported in the final toast.
        void launchFolderImport(collected.files, settings, {
            prunedDirs: collected.prunedDirs,
            unreadable: collected.unreadable,
            lockedDirs: collected.lockedDirs,
            lockedSample: collected.lockedSample,
            truncated: collected.truncated,
            maxFiles: collected.maxFiles,
            maxEntries: collected.maxEntries,
            scannedEntries: collected.scannedEntries,
            entryLimitReached: collected.entryLimitReached,
            deadlineReached: collected.deadlineReached,
            scanTimeoutMs: collected.scanTimeoutMs
        }, operation);
    }

    function pickFolderWithInput() {
        if (operationBusy()) {
            setToast('Finish the active operation before importing another folder.', 'warn');
            return;
        }
        const settings = core.readSettings();
        const operation = new AbortController();
        runtime.importController = operation;
        runtime.busyImport = true;
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
                finishImportOperation(operation);
                setToast('No folder was selected.', 'info');
                return;
            }
            void launchFolderImport(files, settings, null, operation);
        });

        // If the user dismisses the picker, `change` never fires. `cancel` is
        // supported in current Chromium and Firefox; without it the node is simply
        // left detached, which is harmless.
        input.addEventListener('cancel', () => {
            cleanup();
            finishImportOperation(operation);
            renderPage();
        });

        const host = hostElements();
        const mount = (host && host.settingsContainer) || document.body;
        if (!mount) return;
        mount.appendChild(input);
        try {
            input.click();
        } catch (_) {
            cleanup();
            finishImportOperation(operation);
            setToast('This browser blocked the folder picker.', 'error');
        }
    }

    function launchFolderImport(files, settings, scanInfo, existingOperation) {
        const settlement = runFolderImport(files, settings, scanInfo, existingOperation);
        runtime.importSettlement = settlement;
        void settlement.then(() => {
            if (runtime.importSettlement === settlement) runtime.importSettlement = null;
        }, () => {
            if (runtime.importSettlement === settlement) runtime.importSettlement = null;
        });
        return settlement;
    }

    async function runFolderImport(files, settings, scanInfo, existingOperation) {
        const scan = scanInfo || {};
        const scanIncompleteDetails = [];
        if (scan.unreadable) {
            scanIncompleteDetails.push(`${Number(scan.unreadable).toLocaleString()} file(s) could not be opened`);
        }
        if (scan.lockedDirs) {
            scanIncompleteDetails.push(`${Number(scan.lockedDirs).toLocaleString()} folder(s) could not be enumerated`);
        }
        if (scan.truncated) {
            scanIncompleteDetails.push(scan.deadlineReached
                ? 'the directory scan time budget elapsed'
                : scan.entryLimitReached
                    ? 'the directory entry safety limit was reached'
                    : 'the readable-file safety limit was reached');
        }
        const scanIncompleteReason = scanIncompleteDetails.length
            ? `The directory scan was incomplete: ${scanIncompleteDetails.join('; ')}.`
            : '';
        const operation = existingOperation || new AbortController();
        runtime.importController = operation;
        const pickedName = core.suggestedFolderName
            ? core.suggestedFolderName(files)
            : String((files[0] && (files[0].relativePath || files[0].webkitRelativePath || files[0].name)) || 'Imported folder').split('/')[0];

        setToast(`Importing ${files.length.toLocaleString()} file(s) from ${pickedName}…`, 'info');
        runtime.busyImport = true;
        updateImportProgress(operation, { phase: 'import', name: pickedName, done: 0, total: files.length, imported: 0 });
        renderPage();

        let result;
        try {
            if (runtime.currentRun && runtime.messages.length && !saveCurrentRunMessages()) {
                throw new Error('The current transcript could not be saved, so Blueprint did not switch project roots for this import.');
            }
            // Importing a project is deliberately more generous than attaching
            // sources to a prompt — the model-context budget (maxSourceFiles,
            // bounded 1..150, is about what fits in a context window, not about
            // what a project may contain). Those stay separate: lifting the import
            // cap must not mean stuffing 100k files into a prompt.
            //
            // The per-file limit IS shared, because a file too big to attach is too
            // big to be worth storing either.
            result = await core.importFolder(files, pickedName, {
                signal: operation.signal,
                maxFileKb: Math.max(1024, Number(settings.maxSourceFileKb) || 512),
                maxFiles: IMPORT_MAX_FILES,
                maxTotalKb: IMPORT_MAX_TOTAL_KB,
                incompleteReason: scanIncompleteReason,
                onProgress: (done, total, imported) => {
                    updateImportProgress(operation, { phase: 'import', name: pickedName, done, total, imported });
                }
            });
        } catch (error) {
            finishImportOperation(operation);
            if (error && error.code === 'aborted') {
                setToast(error.rolledBack === false
                    ? String(error.message || 'Import cancellation could not be persisted safely.')
                    : 'Folder import cancelled; partial imported files were removed.',
                error.rolledBack === false ? 'error' : 'info', error.rolledBack === false ? 10000 : 4200);
            } else {
                setToast(`Import failed: ${String((error && error.message) || error)}`, 'error');
            }
            renderPage();
            return;
        }
        finishImportOperation(operation);

        if (result.error) {
            setToast(result.error, 'error');
            renderPage();
            return;
        }

        installFolderRunContext(result.folder.id, null);
        // The tree renders directly from the VFS. Opening and persisting one tab
        // per imported source file reintroduced an O(n) localStorage freeze after
        // the chunked importer had finished, so imports update the UI once.

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
        if (result.storageFull) {
            parts.push(`Browser storage filled after ${result.persisted.toLocaleString()} durable file(s); the uncommitted tail was rolled back.`);
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
        if (scan.truncated) {
            if (scan.deadlineReached) {
                parts.push(`The safety scan stopped after ${Number(scan.scannedEntries || 0).toLocaleString()} entries because its ${Math.max(1, Math.round(Number(scan.scanTimeoutMs || 0) / 1000)).toLocaleString()}-second time budget elapsed; exclude generated folders or import a smaller subtree to examine the remainder.`);
            } else if (scan.entryLimitReached) {
                parts.push(`The safety scan stopped after ${Number(scan.maxEntries || scan.scannedEntries || 0).toLocaleString()} filesystem entries; exclude generated folders or import a smaller subtree to examine the remainder.`);
            } else {
                parts.push(`The safety scan stopped after ${Number(scan.maxFiles || 0).toLocaleString()} readable files; split the project or exclude generated folders to import the remainder.`);
            }
        }
        const incomplete = Boolean(skipped || scan.unreadable || scan.lockedDirs || scan.truncated
            || result.storageFull || result.truncatedByBudget);
        setToast(parts.join(' '), result.storageFull ? 'warn' : (incomplete ? 'info' : 'success'),
            incomplete ? 12000 : 4200);

        renderHostSurfaces();
        renderPage();
    }

    function openAddSourceModal() {
        if (operationBusy()) {
            setToast('Finish the active operation before adding source files.', 'warn');
            return;
        }
        const owner = currentFolderId();
        runtime.modal = {
            kind: 'file',
            conflictSensitive: true,
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
            onConfirm: values => commitSourceFile(values, owner)
        };
        renderPage();
    }

    function commitSourceFile(values, ownerFolderId) {
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
        const folderId = String(ownerFolderId || currentFolderId());
        if (!core.getFolder(folderId)) {
            setToast('The project folder for this source file no longer exists.', 'error', 10000);
            return false;
        }
        if (core.readFile(path, folderId)) {
            setToast(`${path} already exists in this project. Choose another path or edit the existing file explicitly.`, 'warn');
            return false;
        }
        const attached = activeSourceFiles();
        if (attached.length >= ui.MAX_SOURCE_FILES) {
            setToast(`At most ${ui.MAX_SOURCE_FILES} files can be attached. Detach one first.`, 'error');
            return false;
        }
        const total = attached.reduce((sum, file) => sum + String(file.content || '').length, 0) + content.length;
        if (total > ui.MAX_SOURCE_TOTAL_BYTES) {
            setToast(`Attached source would exceed ${Math.round(ui.MAX_SOURCE_TOTAL_BYTES / 1024)} KB total.`, 'error');
            return false;
        }
        if (attached.some(file => file.path === path)) {
            setToast(`${path} is already attached.`, 'warn');
            return false;
        }
        const record = core.writeFile(path, content, {
            skill: 'source',
            folder: folderId,
            origin: 'imported',
            createdBy: 'user'
        });
        if (!record || !core.persistenceState().ok) {
            setToast(`Could not save ${path} to the local project store.`, 'error');
            return false;
        }
        const storedPath = record.path || path;
        runtime.sourceFiles.push({ path: storedPath, folderId });
        noteFileWritten(storedPath, folderId);
        runtime.modal = null;
        setToast(`Attached ${storedPath}.`, 'success');
        renderHostSurfaces();
        renderPage();
        return true;
    }

    function attachExistingFile(path) {
        const cleanPath = String(path || '').replace(/^\/+/, '').trim();
        if (!cleanPath) return false;
        const folderId = currentFolderId();
        const record = core.readFile(cleanPath, folderId);
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
        const attached = activeSourceFiles();
        if (attached.length >= ui.MAX_SOURCE_FILES) {
            setToast(`At most ${ui.MAX_SOURCE_FILES} files can be attached. Detach one first.`, 'error');
            return false;
        }
        const total = attached.reduce((sum, file) => sum + file.content.length, 0) + record.content.length;
        if (total > ui.MAX_SOURCE_TOTAL_BYTES) {
            setToast(`Attached source would exceed ${Math.round(ui.MAX_SOURCE_TOTAL_BYTES / 1024)} KB total.`, 'error');
            return false;
        }
        if (attached.some(file => file.path === cleanPath)) {
            setToast(`${cleanPath} is already attached to prompt context.`, 'info');
            return false;
        }
        if (record.folder && record.folder !== currentFolderId()) {
            setToast(`${cleanPath} belongs to a different project folder. Switch folders before attaching it.`, 'warn');
            return false;
        }
        runtime.sourceFiles.push({
            path: cleanPath,
            content: record.content,
            folderId: record.folder || folderId
        });
        setToast(`Attached ${cleanPath} to context.`, 'success');
        renderHostSurfaces();
        renderPage();
        return true;
    }

    function detachSourceFile(path, folderId) {
        const cleanPath = String(path || '').trim();
        const owner = String(folderId || currentFolderId());
        const initialLen = runtime.sourceFiles.length;
        runtime.sourceFiles = runtime.sourceFiles.filter(file => file.path !== cleanPath
            || String(file.folderId || file.folder || owner) !== owner);
        if (runtime.sourceFiles.length < initialLen) {
            setToast(`Detached ${cleanPath} from prompt context.`, 'info');
            renderHostSurfaces();
            renderPage();
        }
    }

    function clearAttachedFiles() {
        const folderId = currentFolderId();
        const before = runtime.sourceFiles.length;
        runtime.sourceFiles = runtime.sourceFiles.filter(file => {
            const stored = file && file.path ? core.readFile(file.path, file.folderId || file.folder || folderId) : null;
            const owner = String((file && (file.folderId || file.folder)) || (stored && stored.folder) || '');
            return owner && owner !== folderId;
        });
        if (runtime.sourceFiles.length === before) return;
        setToast('Detached all source files from this project context.', 'info');
        renderHostSurfaces();
        renderPage();
    }

    // ------------------------------------------------------------------
    // Path context (Agent page): one pick, one path field, one toggle
    //
    // The 2 MB workspace cap means an imported folder can only ever show a
    // slice of a large project. This reads a named subdirectory LIVE at run
    // time through a granted handle, so a 10 GB subtree can be described
    // without storing any of it.
    // ------------------------------------------------------------------

    /** Persist the typed path, clearing the draft so the field reflects truth. */
    function commitPathContextPath(rawPath) {
        const value = String(rawPath || '').trim();
        runtime.pathContextDraft = null;
        const settings = core.readSettings();
        if (String(settings.pathContextPath || '').trim() === value) {
            renderPage();
            return;
        }
        settings.pathContextPath = value;
        if (!core.writeSettings(settings)) {
            setToast('That path could not be saved.', 'error', 8000);
            renderPage();
            return;
        }
        // Validate eagerly so a typo is caught now, not after a model run starts.
        // Without a granted folder there is nothing to validate against, and
        // saying so is more useful than silence.
        if (value && !runtime.pathContextRoot) {
            setToast('Path saved. Pick the project folder so Blueprint is allowed to read it.', 'info', 9000);
        } else if (value) {
            void checkPathContextExists(value);
        }
        renderHostSurfaces();
        renderPage();
    }

    // ------------------------------------------------------------------
    // File Selector & Review Manager Overlay
    // ------------------------------------------------------------------

    function openFileSelectorOverlay(opts = {}) {
        const currentPaths = (runtime.sourceFiles || []).map(f => f.path);
        const selected = new Set(opts.selectedPaths || currentPaths);
        runtime.fileSelector = {
            open: true,
            selectedPaths: selected,
            search: opts.search || '',
            category: opts.category || 'all',
            folderId: opts.folderId || 'all',
            previewPath: opts.previewPath || (currentPaths[0] || null),
            reviewMode: opts.mode || runtime.sourceFileMode || 'combine'
        };
        if (opts.mode) runtime.sourceFileMode = opts.mode;
        renderPage();
    }

    function closeFileSelectorOverlay() {
        if (runtime.fileSelector) {
            runtime.fileSelector.open = false;
        }
        renderPage();
    }

    function toggleAttachedMode() {
        runtime.sourceFileMode = runtime.sourceFileMode === 'exclusive' ? 'combine' : 'exclusive';
        if (runtime.fileSelector) {
            runtime.fileSelector.reviewMode = runtime.sourceFileMode;
        }
        setToast(
            runtime.sourceFileMode === 'exclusive'
                ? 'Review strategy: Independent (strictly evaluates only your chosen files)'
                : 'Review strategy: On top of Agent files (augments automatic workspace discovery)',
            'info'
        );
        renderHostSurfaces();
        renderPage();
    }

    /**
     * Resolve the typed path against the granted root WITHOUT reading any file
     * contents, so the user learns about a typo before spending a run on it.
     */
    async function checkPathContextExists(rawPath) {
        const rootHandle = runtime.pathContextRoot;
        if (!rootHandle) return;
        runtime.pathContextBusy = true;
        renderPage();
        try {
            const { segments } = core.resolveContextSegments(rootHandle.name, rawPath);
            const { handle, resolved, missing } = await core.resolveDirectoryPath(rootHandle, segments);
            const rootName = String(rootHandle.name || 'project');
            if (handle) {
                const where = resolved.length ? `${rootName}/${resolved.join('/')}` : rootName;
                setToast(`Path context: ${where} — will be read when a code-reading skill runs.`, 'success', 7000);
            } else {
                const where = resolved.length ? `${rootName}/${resolved.join('/')}` : rootName;
                setToast(`No "${missing}" inside ${where}. Check the path.`, 'error', 12000);
            }
        } catch (error) {
            setToast(`That path could not be checked: ${String((error && error.message) || error)}`, 'error', 10000);
        } finally {
            runtime.pathContextBusy = false;
            renderPage();
        }
    }

    function fsoSetMode(mode) {
        if (mode === 'combine' || mode === 'exclusive') {
            runtime.sourceFileMode = mode;
            if (runtime.fileSelector) {
                runtime.fileSelector.reviewMode = mode;
            }
            renderPage();
        }
    }

    /** Flip the toggle. Turning it ON with no grant starts the picker. */
    function togglePathContext(forceState) {
        const settings = core.readSettings();
        const next = typeof forceState === 'boolean'
            ? forceState
            : settings.pathContextEnabled !== true;
        settings.pathContextEnabled = next;
        if (!core.writeSettings(settings)) {
            setToast('That setting could not be saved.', 'error', 8000);
            renderPage();
            return;
        }
        renderHostSurfaces();
        renderPage();
        if (!next) {
            setToast('Path context off — runs use only imported project files.', 'info', 5000);
            return;
        }
        // Enabling with no path yet: send the user to the field rather than
        // guessing a folder for them.
        if (!String(settings.pathContextPath || '').trim()) {
            setToast('Type the folder to read (for example TrainingModel), then run a skill.', 'info', 9000);
            return;
        }
        if (!runtime.pathContextRoot) void pickPathContextRoot();
    }

    /** Ask for the folder that the typed path is relative to. */
    async function pickPathContextRoot() {
        if (operationBusy()) {
            setToast('Finish the active operation before picking a folder.', 'warn');
            return;
        }
        if (!core.canPickDirectoryHandle || !core.canPickDirectoryHandle()) {
            // No File System Access API: there is no handle to grant, so a typed
            // path cannot be read. Say that plainly instead of failing silently.
            setToast('This browser cannot grant folder access, so a typed path cannot be read. '
                + 'Import the folder instead.', 'error', 12000);
            return;
        }
        let handle = null;
        try {
            handle = await window.showDirectoryPicker({ mode: 'read' });
        } catch (error) {
            if (error && error.name === 'AbortError') return;
            setToast(`The folder could not be opened: ${String((error && error.message) || error)}`, 'error', 10000);
            return;
        }
        if (!handle) return;
        runtime.pathContextRoot = handle;
        runtime.pathContextRootName = String(handle.name || '');
        setToast(`Granted "${runtime.pathContextRootName}" — path context can now be read from it.`, 'success', 7000);
        const path = String(core.readSettings().pathContextPath || '').trim();
        if (path) void checkPathContextExists(path);
        renderPage();
    }

    function fsoToggleFile(path, opts = {}) {
        if (!runtime.fileSelector || !path) return;
        const selected = runtime.fileSelector.selectedPaths instanceof Set
            ? runtime.fileSelector.selectedPaths
            : new Set(runtime.fileSelector.selectedPaths || []);

        const filtered = fsoGetFilteredPaths();
        const last = runtime.fileSelector.lastClickedPath;

        if (opts.shiftKey && last && last !== path && filtered.includes(last) && filtered.includes(path)) {
            const idx1 = filtered.indexOf(last);
            const idx2 = filtered.indexOf(path);
            const start = Math.min(idx1, idx2);
            const end = Math.max(idx1, idx2);
            const range = filtered.slice(start, end + 1);

            range.forEach(p => selected.add(p));
            runtime.fileSelector.lastClickedPath = path;
            runtime.fileSelector.previewPath = path;
            runtime.fileSelector.selectedPaths = selected;
            renderPage();
            return;
        }

        if (selected.has(path)) {
            selected.delete(path);
        } else {
            selected.add(path);
        }
        runtime.fileSelector.lastClickedPath = path;
        runtime.fileSelector.selectedPaths = selected;
        runtime.fileSelector.previewPath = path;
        renderPage();
    }

    function fsoTogglePreview(path) {
        if (!runtime.fileSelector || !path) return;
        if (runtime.fileSelector.previewPath === path) {
            runtime.fileSelector.previewPath = null;
        } else {
            runtime.fileSelector.previewPath = path;
        }
        renderPage();
    }

    function fsoGetFilteredPaths() {
        if (!runtime.fileSelector) return [];
        const fso = runtime.fileSelector;
        const allPaths = (core && typeof core.listFiles === 'function') ? core.listFiles() : [];
        const CODE_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'ps1', 'sql', 'html', 'css']);
        const DOCS_EXTS = new Set(['md', 'markdown', 'txt', 'rst', 'adoc', 'pdf']);
        const CONFIG_EXTS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'env', 'config']);
        const query = String(fso.search || '').trim().toLowerCase();
        const selected = fso.selectedPaths instanceof Set ? fso.selectedPaths : new Set(fso.selectedPaths || []);

        let searchMatcher = null;
        if (query && (query.includes('*') || query.includes('?'))) {
            try {
                const esc = '^' + query.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
                searchMatcher = new RegExp(esc, 'i');
            } catch (_) {}
        }

        return allPaths.filter(p => {
            if (query) {
                const matches = searchMatcher ? searchMatcher.test(p) : p.toLowerCase().includes(query);
                if (!matches) return false;
            }
            const rec = core && typeof core.readFile === 'function' ? core.readFile(p) : null;
            const folder = rec && rec.folder ? rec.folder : (core ? core.DEFAULT_FOLDER_ID : 'default');
            if (fso.folderId && fso.folderId !== 'all' && folder !== fso.folderId) return false;
            const ext = p.split('.').pop().toLowerCase();
            if (fso.category === 'code') return CODE_EXTS.has(ext);
            if (fso.category === 'docs') return DOCS_EXTS.has(ext);
            if (fso.category === 'config') return CONFIG_EXTS.has(ext);
            if (fso.category === 'selected') return selected.has(p);
            return true;
        });
    }

    function fsoSelectAllFiltered() {
        if (!runtime.fileSelector) return;
        const selected = runtime.fileSelector.selectedPaths instanceof Set
            ? runtime.fileSelector.selectedPaths
            : new Set(runtime.fileSelector.selectedPaths || []);
        const filtered = fsoGetFilteredPaths();
        filtered.forEach(p => selected.add(p));
        runtime.fileSelector.selectedPaths = selected;
        renderPage();
    }

    function fsoDeselectAll() {
        if (!runtime.fileSelector) return;
        runtime.fileSelector.selectedPaths = new Set();
        renderPage();
    }

    function fsoInvertSelection() {
        if (!runtime.fileSelector) return;
        const selected = runtime.fileSelector.selectedPaths instanceof Set
            ? runtime.fileSelector.selectedPaths
            : new Set(runtime.fileSelector.selectedPaths || []);
        const filtered = fsoGetFilteredPaths();
        filtered.forEach(p => {
            if (selected.has(p)) selected.delete(p);
            else selected.add(p);
        });
        runtime.fileSelector.selectedPaths = selected;
        renderPage();
    }

    function fsoFillBudget() {
        if (!runtime.fileSelector) return;
        const selected = runtime.fileSelector.selectedPaths instanceof Set
            ? runtime.fileSelector.selectedPaths
            : new Set(runtime.fileSelector.selectedPaths || []);

        const filtered = fsoGetFilteredPaths();
        const limits = ui.sourceLimits ? ui.sourceLimits() : {
            maxFiles: ui.MAX_SOURCE_FILES || 8,
            maxTotalBytes: ui.MAX_SOURCE_TOTAL_BYTES || (160 * 1024),
            maxFileBytes: ui.MAX_SOURCE_FILE_BYTES || (48 * 1024)
        };

        let currentBytes = 0;
        selected.forEach(p => {
            const rec = core && typeof core.readFile === 'function' ? core.readFile(p) : null;
            if (rec && rec.content) currentBytes += rec.content.length;
        });

        let addedCount = 0;
        for (const p of filtered) {
            if (selected.has(p)) continue;
            if (selected.size >= limits.maxFiles) break;

            const rec = core && typeof core.readFile === 'function' ? core.readFile(p) : null;
            if (!rec || typeof rec.content !== 'string' || !rec.content.trim()) continue;
            const bytes = rec.content.length;
            if (bytes > limits.maxFileBytes) continue;
            if (currentBytes + bytes > limits.maxTotalBytes) continue;

            selected.add(p);
            currentBytes += bytes;
            addedCount++;
        }

        runtime.fileSelector.selectedPaths = selected;
        if (addedCount > 0) {
            setToast(`Filled budget: added ${addedCount} file(s). Total: ${selected.size}/${limits.maxFiles} (${Math.round(currentBytes / 1024)} KB).`, 'success');
        } else if (selected.size >= limits.maxFiles || currentBytes >= limits.maxTotalBytes) {
            setToast(`Context budget is already full (${selected.size} files, ${Math.round(currentBytes / 1024)} KB).`, 'info');
        } else {
            setToast('No additional matching files fit within the budget limit.', 'info');
        }
        renderPage();
    }

    function fsoSelectExt(ext) {
        if (!runtime.fileSelector || !ext) return;
        const selected = runtime.fileSelector.selectedPaths instanceof Set
            ? runtime.fileSelector.selectedPaths
            : new Set(runtime.fileSelector.selectedPaths || []);

        const allPaths = (core && typeof core.listFiles === 'function') ? core.listFiles() : [];
        const targetExt = String(ext).toLowerCase().replace(/^\./, '');
        const matching = allPaths.filter(p => p.toLowerCase().endsWith('.' + targetExt));
        if (!matching.length) return;

        const allSelected = matching.every(p => selected.has(p));
        if (allSelected) {
            matching.forEach(p => selected.delete(p));
            setToast(`Deselected ${matching.length} *.${targetExt} file(s).`, 'info');
        } else {
            matching.forEach(p => selected.add(p));
            setToast(`Selected all ${matching.length} *.${targetExt} file(s).`, 'success');
        }
        runtime.fileSelector.selectedPaths = selected;
        renderPage();
    }

    function fsoSelectDir(dir) {
        if (!runtime.fileSelector) return;
        const selected = runtime.fileSelector.selectedPaths instanceof Set
            ? runtime.fileSelector.selectedPaths
            : new Set(runtime.fileSelector.selectedPaths || []);

        const filtered = fsoGetFilteredPaths();
        const targetDir = String(dir || '');
        const matching = filtered.filter(p => {
            if (!targetDir || targetDir === '(root)') {
                return !p.includes('/');
            }
            return p.startsWith(targetDir);
        });

        matching.forEach(p => selected.add(p));
        runtime.fileSelector.selectedPaths = selected;
        setToast(`Selected ${matching.length} file(s) in ${targetDir || 'root'}.`, 'success');
        renderPage();
    }

    function fsoDeselectDir(dir) {
        if (!runtime.fileSelector) return;
        const selected = runtime.fileSelector.selectedPaths instanceof Set
            ? runtime.fileSelector.selectedPaths
            : new Set(runtime.fileSelector.selectedPaths || []);

        const targetDir = String(dir || '');
        const toDelete = [];
        selected.forEach(p => {
            if (!targetDir || targetDir === '(root)') {
                if (!p.includes('/')) toDelete.push(p);
            } else if (p.startsWith(targetDir)) {
                toDelete.push(p);
            }
        });

        toDelete.forEach(p => selected.delete(p));
        runtime.fileSelector.selectedPaths = selected;
        setToast(`Deselected ${toDelete.length} file(s) in ${targetDir || 'root'}.`, 'info');
        renderPage();
    }

    async function fsoHandleBulkFiles(fileList) {
        if (!fileList || !fileList.length) return;
        const files = Array.from(fileList);
        const folder = runtime.fileSelector && runtime.fileSelector.folderId !== 'all'
            ? runtime.fileSelector.folderId
            : (runtime.activeFolderId || core.DEFAULT_FOLDER_ID);

        let imported = 0;
        let errors = 0;
        const selected = runtime.fileSelector && runtime.fileSelector.selectedPaths instanceof Set
            ? runtime.fileSelector.selectedPaths
            : new Set((runtime.fileSelector && runtime.fileSelector.selectedPaths) || []);

        for (const file of files) {
            try {
                const text = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result || ''));
                    reader.onerror = () => reject(reader.error);
                    reader.readAsText(file);
                });

                const rawPath = file.webkitRelativePath || file.name;
                const cleanName = String(rawPath).replace(/^[\\/]+/, '').replace(/[\\:*?"<>|]/g, '/');
                const projectPath = cleanName.includes('/') ? cleanName : `src/${cleanName}`;

                core.writeFile(projectPath, text, {
                    origin: 'imported',
                    folder
                });

                selected.add(projectPath);
                imported++;
            } catch (err) {
                console.warn('[Blueprint] Failed to read bulk file:', file.name, err);
                errors++;
            }
        }

        if (runtime.fileSelector) {
            runtime.fileSelector.selectedPaths = selected;
        }

        if (imported > 0) {
            setToast(`Imported and selected ${imported} file(s) from disk${errors > 0 ? ` (${errors} failed)` : ''}.`, 'success');
        } else {
            setToast('No files could be imported.', 'error');
        }
        renderHostSurfaces();
        renderPage();
    }

    function fsoConfirmSelection() {
        if (!runtime.fileSelector) return false;
        const selected = runtime.fileSelector.selectedPaths instanceof Set
            ? runtime.fileSelector.selectedPaths
            : new Set(runtime.fileSelector.selectedPaths || []);

        const newSourceFiles = [];
        let totalBytes = 0;
        const maxFiles = ui.MAX_SOURCE_FILES || 8;
        const maxTotalBytes = ui.MAX_SOURCE_TOTAL_BYTES || (160 * 1024);
        const maxFileBytes = ui.MAX_SOURCE_FILE_BYTES || (48 * 1024);
        let skippedCount = 0;

        for (const p of selected) {
            const rec = core.readFile(p);
            if (!rec || typeof rec.content !== 'string' || !rec.content.trim()) {
                skippedCount++;
                continue;
            }
            if (rec.content.length > maxFileBytes) {
                skippedCount++;
                continue;
            }
            if (newSourceFiles.length >= maxFiles || totalBytes + rec.content.length > maxTotalBytes) {
                skippedCount++;
                continue;
            }
            totalBytes += rec.content.length;
            newSourceFiles.push({ path: p, content: rec.content });
        }

        runtime.sourceFiles = newSourceFiles;
        runtime.fileSelector.open = false;

        const modeLabel = runtime.sourceFileMode === 'exclusive' ? 'Independent' : 'On top of Agent files';
        if (skippedCount > 0) {
            setToast(`Attached ${newSourceFiles.length} file(s) (${skippedCount} skipped due to limits/empty). Mode: ${modeLabel}.`, 'warn');
        } else {
            setToast(`Attached ${newSourceFiles.length} file(s) to prompt context. Mode: ${modeLabel}.`, 'success');
        }
        renderHostSurfaces();
        renderPage();
        return true;
    }

    async function fsoReviewNow() {
        if (!runtime.fileSelector) return;
        const selected = runtime.fileSelector.selectedPaths instanceof Set
            ? runtime.fileSelector.selectedPaths
            : new Set(runtime.fileSelector.selectedPaths || []);

        if (selected.size === 0 && runtime.sourceFileMode === 'exclusive') {
            setToast('Please select at least one file to review in independent mode.', 'warn');
            return;
        }

        fsoConfirmSelection();

        runtime.selectedSkillId = 'arch-eval';
        const skill = selectedSkill();
        const modeLabel = runtime.sourceFileMode === 'exclusive' ? 'independent' : 'augmented';
        const count = runtime.sourceFiles.length;

        goToSection('cb-agent');

        const promptText = `Conduct a comprehensive architecture and code quality review of the attached source files (${count} file${count === 1 ? '' : 's'} in ${modeLabel} mode). Identify structural patterns, potential anti-patterns or bugs, modularity, security considerations, and recommended improvements.`;

        runtime.messages.push({
            id: core.uid('msg'),
            role: 'user',
            at: new Date().toISOString(),
            text: promptText
        });
        renderPage();
        scrollTranscriptToEnd();
        await runSelectedSkill(promptText);
    }

    function openNewFileModal() {
        if (operationBusy()) {
            setToast('Finish the active operation before creating a file.', 'warn');
            return;
        }
        const owner = currentFolderId();
        runtime.modal = {
            kind: 'file',
            conflictSensitive: true,
            title: 'New Markdown file',
            icon: 'fa-file-pen',
            description: 'Create a document in the Blueprint project. Useful for pasting an existing PRD so Doc Generation can work from it.',
            path: `docs/prd/${core.todayStamp()}-notes.md`,
            contentLabel: 'Content',
            content: '',
            confirmLabel: 'Create file',
            confirmIcon: 'fa-plus',
            onConfirm: values => {
                const folderId = owner;
                if (!core.getFolder(folderId)) {
                    setToast('The project folder for this file no longer exists.', 'error', 10000);
                    return false;
                }
                const path = String(values.path || '').replace(/^\/+/, '').trim();
                if (!path) {
                    setToast('A project path is required.', 'error');
                    return false;
                }
                if (core.readFile(path, folderId)) {
                    setToast(`${path} already exists.`, 'error');
                    return false;
                }
                const written = core.writeFile(path, String(values.content || ''), {
                    skill: 'manual',
                    folder: folderId,
                    origin: 'created',
                    createdBy: 'user'
                });
                if (!written) {
                    setToast(`Could not save ${path} to the local project store.`, 'error');
                    return false;
                }
                runtime.modal = null;
                // Open the new document in its own editor tab (and make sure the
                // Project Files section exists to browse from).
                noteFileWritten(path, folderId);
                openFileTab(path, folderId);
                setToast(`Created ${path}.`, 'success');
                renderHostSurfaces();
                renderPage();
                return true;
            }
        };
        renderPage();
    }

    function openRenameModal(path, folderId) {
        if (operationBusy()) {
            setToast('Finish the active operation before changing a file.', 'warn');
            return;
        }
        const owner = folderId || currentFolderId();
        const record = core.readFile(path, owner);
        if (!record) return;
        const expectedFile = core.fileSnapshot(record);
        runtime.modal = {
            kind: 'file',
            conflictSensitive: true,
            title: 'Rename or move file',
            icon: 'fa-pen',
            path,
            pathLabel: 'New project path',
            contentLabel: 'Content',
            content: record.content,
            confirmLabel: 'Save',
            confirmIcon: 'fa-floppy-disk',
            onConfirm: values => {
                if (!core.fileMatchesSnapshot(path, owner, expectedFile)) {
                    setToast(`${path} changed in another window. The newer stored file was preserved; reopen it before editing.`, 'error', 10000);
                    return false;
                }
                const target = String(values.path || '').replace(/^\/+/, '').trim();
                if (!target) {
                    setToast('A project path is required.', 'error');
                    return false;
                }
                if (target !== path && core.readFile(target, owner)) {
                    setToast(`${target} already exists.`, 'error');
                    return false;
                }
                const content = String(values.content || '');
                const contentChanged = content !== String(record.content || '');
                const imported = record.origin === 'imported';
                let renamed = false;
                let written = record;

                if (imported && contentChanged) {
                    // Imported source is immutable in place. If the user also
                    // chose another path, create the edited Blueprint-owned copy
                    // there and preserve the original source under its old path.
                    written = core.writeFile(target, content, {
                        folder: owner,
                        origin: 'blueprint',
                        createdBy: 'blueprint',
                        skill: 'manual-revision'
                    });
                } else {
                    written = core.updateFile(path, target, content, owner, expectedFile);
                    renamed = Boolean(written && target !== path);
                }

                if (!written) {
                    setToast(`Could not save ${target} to the local project store.`, 'error');
                    return false;
                }
                const actualPath = String(written.path || target);
                if (renamed) noteFileRenamed(path, actualPath, owner);
                if (contentChanged || renamed) noteFileWritten(actualPath, owner);
                runtime.modal = null;
                setToast(imported && contentChanged
                    ? `Saved revision ${actualPath}; the imported source ${path} was preserved.`
                    : `Saved ${actualPath}.`, 'success');
                renderHostSurfaces();
                renderPage();
                return true;
            }
        };
        renderPage();
    }

    function confirmDeleteFile(path, folderId) {
        if (operationBusy()) {
            setToast('Stop the active operation before deleting project files.', 'warn');
            return;
        }
        const owner = folderId || currentFolderId();
        const record = core.readFile(path, owner);
        if (!record) return;
        const expectedFile = core.fileSnapshot(record);
        runtime.modal = {
            kind: 'confirm',
            conflictSensitive: true,
            title: 'Delete file',
            icon: 'fa-trash',
            message: `Delete ${path} from the Blueprint project? This cannot be undone.`,
            danger: true,
            confirmLabel: 'Delete',
            confirmIcon: 'fa-trash',
            onConfirm: () => {
                if (!core.fileMatchesSnapshot(path, owner, expectedFile)) {
                    setToast(`${path} changed in another window. The newer stored file was preserved; reopen the delete dialog to confirm it.`, 'error', 10000);
                    return false;
                }
                if (!core.deleteFile(path, owner, expectedFile)) {
                    setToast(`Could not delete ${path}; project storage was left unchanged.`, 'error', 8000);
                    return false;
                }
                runtime.sourceFiles = runtime.sourceFiles.filter(file => file.path !== path
                    || String(file.folderId || file.folder || '') !== owner);
                noteFileDeleted(path, owner);
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
        if (operationBusy()) {
            setToast('Stop the active operation before clearing run history.', 'warn');
            return;
        }
        runtime.modal = {
            kind: 'confirm',
            conflictSensitive: true,
            title: 'Clear run history',
            icon: 'fa-clock-rotate-left',
            message: 'Delete every recorded Blueprint run and its step trace? Project files are kept.',
            danger: true,
            confirmLabel: 'Clear runs',
            confirmIcon: 'fa-trash-can',
            onConfirm: () => {
                if (!core.clearRuns()) {
                    setToast('Run history could not be cleared; stored runs were left unchanged.', 'error', 8000);
                    return false;
                }
                runtime.modal = null;
                runtime.explicitNoRun = true;
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
        if (operationBusy()) {
            setToast('Stop the active operation before deleting project files.', 'warn');
            return;
        }
        runtime.modal = {
            kind: 'confirm',
            conflictSensitive: true,
            title: 'Delete all project files',
            icon: 'fa-trash-can',
            message: 'Delete every file in the Blueprint project, including generated documents and attached source? Run history is kept.',
            danger: true,
            confirmLabel: 'Delete all files',
            confirmIcon: 'fa-trash-can',
            onConfirm: () => {
                if (!core.clearFiles()) {
                    setToast('Project files could not be deleted; stored files were left unchanged.', 'error', 8000);
                    return false;
                }
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
        const recovery = typeof core.storageRecoveryState === 'function'
            ? core.storageRecoveryState() : {};
        if (recovery.projects && typeof core.exportRecoverySnapshot === 'function') {
            downloadText('codalio-blueprint-project-recovery.json',
                core.exportRecoverySnapshot(), 'application/json;charset=utf-8');
            setToast('The project store is malformed, so its exact raw bytes were exported for recovery. Nothing was reset.', 'warn', 10000);
            return;
        }
        const paths = core.listFiles();
        if (!paths.length) {
            setToast('The project is empty — nothing to download.', 'warn');
            return;
        }
        const bundle = core.exportBundle();
        downloadText(`${core.slugify(runtime.projectName || 'blueprint')}-project.md`, bundle, 'text/markdown;charset=utf-8');
        setToast(`Downloaded ${paths.length} ${paths.length === 1 ? 'file' : 'files'} with a project-root identity manifest.`, 'success');
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
        if (context && context.state && context.state.app === APP_ID) return true;
        if (typeof window !== 'undefined' && window.currentApp === APP_ID) return true;
        const container = document.getElementById('settings-container');
        return Boolean(container && container.querySelector('.cb-container'));
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
                if (!run || !openStoredRun(runId, true)) return;
                setToast(`Loaded chat: ${run.title || run.skillName}`, 'info');
                goToSection('cb-agent');
                renderHostSurfaces();
                renderPage();
                scrollTranscriptToEnd(true);
                return;
            }
            case 'delete-history-run': {
                const runId = target.dataset.runId;
                if (!deleteStoredRun(runId)) return;
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
                const requestedSkill = skills.getSkill(target.dataset.skillId || '');
                if (!requestedSkill) {
                    setToast('That skill is unavailable. Refresh Blueprint and try again.', 'error');
                    return;
                }
                runtime.selectedSkillId = requestedSkill.id;
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
                    commitWorkspaceMutation(workspace => ws.closeFileTabs(workspace, core.readSettings()));
                }
                return;
            }
            case 'settings-goto': {
                const ws = wsModule();
                const sectionId = target.dataset.sectionId || 'agent';
                const pageId = target.dataset.pageId || '';
                if (ws && runtime.workspace) {
                    commitWorkspaceMutation(workspace => ws.setSettingsLocation(workspace, sectionId, pageId));
                }
                runtime.settingsFocusKey = '';
                renderHostSurfaces();
                renderPage();
                return;
            }
            case 'settings-focus': {
                const ws = wsModule();
                if (ws && runtime.workspace) {
                    commitWorkspaceMutation(workspace => ws.setSettingsLocation(
                        workspace, target.dataset.sectionId || 'agent', target.dataset.pageId || ''));
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
                    commitWorkspaceMutation(workspace => ws.setSettingsQuery(workspace, ''));
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
                    if (!core.writeSettings(settings)) {
                        setToast('That setting could not be saved.', 'error', 8000);
                        return;
                    }
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
                    if (!core.writeSettings(settings)) {
                        setToast('That setting could not be saved.', 'error', 8000);
                        return;
                    }
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
                if (!core.writeSettings(settings)) {
                    setToast(`Could not reset ${page.label}; the previous settings were kept.`, 'error', 8000);
                    return;
                }
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
                if (operationBusy()) {
                    setToast('Stop the active operation before repairing gaps.', 'warn');
                    return;
                }
                const runId = target.dataset.runId;
                const path = target.dataset.path;
                const folderId = target.dataset.folderId || '';
                const run = core.findRun(runId) || runtime.currentRun;
                if (!run || !path) return;
                const review = (run.reviews || []).find(r => r.path === path
                    && (!folderId || String(r.folderId || run.folderId || '') === folderId));
                if (!review) return;
                setToast('Agent is autonomously repairing gaps…', 'info');
                void runGapRepair(run, path, review);
                return;
            }
            case 'answer-question': {
                const answer = target.dataset.answer || '';
                void submitPendingAnswer(answer, target.dataset.stepId || '');
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
                void submitPendingAnswer(answer, target.dataset.stepId || '', () => {
                    runtime.draft = '';
                    if (input) input.value = '';
                });
                return;
            }
            case 'toggle-folder': {
                const path = target.dataset.path || '';
                const folderId = target.dataset.folderId || currentFolderId();
                const key = ui.folderPathKey ? ui.folderPathKey(folderId, path) : path;
                if (runtime.expanded.has(key)) runtime.expanded.delete(key);
                else runtime.expanded.add(key);
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
                core.listFolders().forEach(folder => {
                    core.listFiles(folder.id).forEach(path => {
                        const parts = path.split('/');
                        parts.pop();
                        let walked = [];
                        parts.forEach(part => {
                            walked = walked.concat([part]);
                            const directory = walked.join('/');
                            runtime.expanded.add(ui.folderPathKey
                                ? ui.folderPathKey(folder.id, directory)
                                : directory);
                        });
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
                const folderId = target.dataset.folderId || currentFolderId();
                if (!core.readFile(path, folderId)) {
                    setToast(`${path} is not in the project.`, 'warn');
                    return;
                }
                // A document opens in its OWN editor tab next to the Agent.
                openFileTab(path, folderId);
                return;
            }
            case 'viewer-toggle': {
                const ws = wsModule();
                const path = target.dataset.path || core.store.openPath;
                const folderId = target.dataset.folderId || core.store.openFolderId || currentFolderId();
                if (ws && runtime.workspace && path) {
                    const current = ws.viewerModeFor(runtime.workspace, path, core.readSettings(), folderId);
                    commitWorkspaceMutation(workspace => ws.setViewerMode(
                        workspace, path, current === 'source' ? 'preview' : 'source', folderId));
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
                if (!core.writeSettings(settings)) {
                    setToast('That preview setting could not be saved.', 'error', 8000);
                    return;
                }
                renderPage();
                return;
            }
            case 'copy-file': {
                const record = core.readFile(target.dataset.path || '', target.dataset.folderId || currentFolderId());
                if (record) void copyText(record.content, record.path);
                return;
            }
            case 'download-file': {
                const record = core.readFile(target.dataset.path || '', target.dataset.folderId || currentFolderId());
                if (record) {
                    downloadText(record.path.split('/').pop(), record.content, 'text/markdown;charset=utf-8');
                    setToast(`Downloaded ${record.path}.`, 'success');
                }
                return;
            }
            case 'edit-file': {
                const path = target.dataset.path || core.store.openPath;
                if (!path) return;
                runtime.editingPath = path;
                const ws = wsModule();
                if (ws && runtime.workspace) {
                    ws.setViewerMode(runtime.workspace, path, 'source');
                    persistWorkspace();
                } else {
                    runtime.viewerMode = 'source';
                }
                renderPage();
                return;
            }
            case 'save-file': {
                const path = target.dataset.path || runtime.editingPath || core.store.openPath;
                if (!path) return;
                const container = hostElements()?.settingsContainer || document;
                const ta = container.querySelector('.cb-preview-textarea');
                const content = ta ? ta.value : (core.readFile(path)?.content || '');
                core.writeFile(path, content, { userEdit: true });
                runtime.editingPath = null;
                setToast(`Saved ${path}.`, 'success');
                renderPage();
                return;
            }
            case 'cancel-edit-file': {
                runtime.editingPath = null;
                renderPage();
                return;
            }
            case 'preview-edit': {
                const path = target.dataset.path || core.store.openPath;
                if (path) {
                    runtime.editingPath = runtime.editingPath === path ? null : path;
                    renderPage();
                }
                return;
            }
            case 'preview-save': {
                const path = target.dataset.path || runtime.editingPath || core.store.openPath;
                if (!path) return;
                const container = hostElements()?.settingsContainer || document;
                const ta = container.querySelector('.cb-preview-textarea');
                const content = ta ? ta.value : (core.readFile(path)?.content || '');
                core.writeFile(path, content, { userEdit: true });
                runtime.editingPath = null;
                setToast(`Saved ${path}.`, 'success');
                renderPage();
                return;
            }
            case 'preview-cancel': {
                runtime.editingPath = null;
                renderPage();
                return;
            }
            case 'rename-file':
                openRenameModal(target.dataset.path || '', target.dataset.folderId || currentFolderId());
                return;
            case 'delete-file':
                confirmDeleteFile(target.dataset.path || '', target.dataset.folderId || currentFolderId());
                return;
            case 'open-file-selector':
                openFileSelectorOverlay();
                return;
            case 'close-file-selector':
                closeFileSelectorOverlay();
                return;
            case 'toggle-attached-mode':
                toggleAttachedMode();
                return;
            case 'fso-set-mode':
                fsoSetMode(target.dataset.mode);
                return;
            case 'fso-search-clear':
                if (runtime.fileSelector) {
                    runtime.fileSelector.search = '';
                    renderPage();
                }
                return;
            case 'fso-category':
                if (runtime.fileSelector) {
                    runtime.fileSelector.category = target.dataset.category || 'all';
                    renderPage();
                }
                return;
            case 'fso-toggle-file': {
                const p = target.dataset.path || (target.closest('[data-path]') && target.closest('[data-path]').dataset.path);
                if (p) fsoToggleFile(p, { shiftKey: Boolean(event && event.shiftKey) });
                return;
            }
            case 'fso-select-all':
                fsoSelectAllFiltered();
                return;
            case 'fso-fill-budget':
                fsoFillBudget();
                return;
            case 'fso-deselect-all':
                fsoDeselectAll();
                return;
            case 'fso-invert':
                fsoInvertSelection();
                return;
            case 'fso-select-ext': {
                const ext = target.dataset.ext || (target.closest('[data-ext]') && target.closest('[data-ext]').dataset.ext);
                if (ext) fsoSelectExt(ext);
                return;
            }
            case 'fso-select-dir': {
                const dir = target.dataset.dir || (target.closest('[data-dir]') && target.closest('[data-dir]').dataset.dir);
                fsoSelectDir(dir);
                return;
            }
            case 'fso-deselect-dir': {
                const dir = target.dataset.dir || (target.closest('[data-dir]') && target.closest('[data-dir]').dataset.dir);
                fsoDeselectDir(dir);
                return;
            }
            case 'fso-preview-file': {
                const p = target.dataset.path || (target.closest('[data-path]') && target.closest('[data-path]').dataset.path);
                if (p) fsoTogglePreview(p);
                return;
            }
            case 'fso-bulk-upload-trigger': {
                const container = hostElements()?.settingsContainer;
                const input = container && container.querySelector('[data-cb-role="fso-bulk-file-input"]');
                if (input) input.click();
                return;
            }
            case 'fso-upload':
                openAddSourceModal();
                return;
            case 'fso-paste':
                openAddSourceModal();
                return;
            case 'fso-confirm':
                fsoConfirmSelection();
                return;
            case 'fso-review-now':
                void fsoReviewNow();
                return;
            case 'modal-body':
                return;
            case 'add-source-file':
                openAddSourceModal();
                return;
            case 'detach-source-file': {
                const path = target.dataset.path || (target.closest('[data-path]')?.dataset.path) || '';
                const folderId = target.dataset.folderId || currentFolderId();
                if (path) detachSourceFile(path, folderId);
                return;
            }
            case 'clear-attached-files':
                clearAttachedFiles();
                return;
            case 'toggle-path-context':
                togglePathContext();
                return;
            case 'pick-path-context-root':
                void pickPathContextRoot();
                return;
            case 'recheck-path-context': {
                const path = String(core.readSettings().pathContextPath || '').trim();
                if (!path) { setToast('Type a folder path first.', 'info'); return; }
                if (!runtime.pathContextRoot) { void pickPathContextRoot(); return; }
                void checkPathContextExists(path);
                return;
            }
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
                if (!message || operationBusy()) return;
                if (runtime.unacknowledgedCancelIds.size) {
                    void ensureBackendIdle().then(clear => {
                        if (clear) setToast('Previous cancellation is confirmed. Retry is ready; click Retry once more.', 'info');
                    });
                    return;
                }
                if (message.retryKind === 'revision') {
                    message.retryStarting = true;
                    renderPage();
                    let claimed = false;
                    void reviseDocument(message.id, {
                        runId: message.runId,
                        targetPath: message.targetPath,
                        targetFolderId: message.targetFolderId || message.folderId,
                        instruction: message.revisionInstruction || message.idea,
                        onBeforeStart: () => {
                            message.retryStarting = false;
                            message.canRetry = false;
                            message.retrying = true;
                        },
                        onStarted: () => {
                            claimed = true;
                            renderPage();
                        }
                    }).catch(error => {
                        setToast(`Retry could not start: ${String((error && error.message) || error)}`, 'error');
                    }).finally(() => {
                        message.retryStarting = false;
                        message.retrying = false;
                        if (!claimed) message.canRetry = true;
                        renderPage();
                    });
                    return;
                }
                const failedRun = message.runId ? core.findRun(message.runId) : null;
                const messageIndex = runtime.messages.findIndex(item => item.id === message.id);
                const precedingUser = runtime.messages.slice(0, Math.max(0, messageIndex))
                    .reverse().find(item => item.role === 'user');
                const prompt = String(message.idea
                    || (failedRun && failedRun.idea)
                    || (precedingUser && precedingUser.text)
                    || '').trim();
                if (!prompt) {
                    setToast('The original prompt for this run is no longer available.', 'warn');
                    return;
                }
                const skillId = message.skillId || (failedRun && failedRun.skillId) || runtime.selectedSkillId;
                if (skills.getSkill(skillId)) runtime.selectedSkillId = skillId;
                message.retryStarting = true;
                renderPage();
                let claimed = false;
                void runSelectedSkill(prompt, {
                    skillId,
                    folderId: (failedRun && failedRun.folderId) || message.folderId || currentFolderId(),
                    answers: failedRun && Array.isArray(failedRun.answers)
                        ? failedRun.answers.slice() : [],
                    reuseSuppliedAnswers: true,
                    selectedOptions: failedRun && Array.isArray(failedRun.selectedOptions)
                        ? failedRun.selectedOptions.slice() : null,
                    onBeforeStart: () => {
                        message.retryStarting = false;
                        message.canRetry = false;
                        message.retrying = true;
                    },
                    onStarted: () => {
                        claimed = true;
                        renderPage();
                    }
                }).catch(error => {
                    setToast(`Retry could not start: ${String((error && error.message) || error)}`, 'error');
                }).finally(() => {
                    message.retryStarting = false;
                    message.retrying = false;
                    if (!claimed) message.canRetry = true;
                    renderPage();
                });
                return;
            }
            case 'open-run': {
                const run = core.findRun(target.dataset.runId || '');
                if (!run || !openStoredRun(run.id, false)) return;
                goToSection('cb-agent');
                return;
            }
            case 'delete-run': {
                const runId = target.dataset.runId || '';
                if (!deleteStoredRun(runId)) return;
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
                // Run-owner and cancellation keys can change without touching
                // the project-store revision. A confirmation opened while idle
                // must therefore re-read cross-window ownership at click time.
                // Core destructive APIs repeat this invariant under their write
                // lease, so a claim cannot race the check and the commit.
                refreshForeignRunOwners();
                if (modal.conflictSensitive && operationBusy()) {
                    runtime.modal = null;
                    setToast('The operation was not applied because Blueprint became busy in another window.', 'warn');
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
        // Path-context field: store the draft WITHOUT re-rendering so the caret
        // and focus survive typing. The value is committed to settings on
        // 'change' (blur/Enter), which is when a re-render is harmless.
        if (target && target.dataset && target.dataset.cbRole === 'path-context-input') {
            runtime.pathContextDraft = String(target.value || '');
            return;
        }
        if (target && target.dataset && target.dataset.cbRole === 'fso-search') {
            if (runtime.fileSelector) {
                runtime.fileSelector.search = target.value;
                renderPage();
            }
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
                commitWorkspaceMutation(workspace => ws.setSettingsQuery(workspace, target.value));
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

        if (!core.writeSettings(settings)) {
            setToast('That setting could not be saved. The previous value is still active.', 'error', 8000);
            renderHostSurfaces();
            renderPage();
            return false;
        }

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

        if (key === 'listPaneWidth') {
            applyListPaneWidth(settings.listPaneWidth);
        }

        // Some settings change layout immediately; refresh the host surfaces so
        // nav counts and ribbon state stay correct.
        renderHostSurfaces();
        if (key === 'pinAgentTab' || key === 'maxOpenTabs' || key === 'restoreTabsOnLoad') {
            ensureWorkspace();
            const ws = wsModule();
            if (ws && runtime.workspace) {
                commitWorkspaceMutation(
                    workspace => ws.syncAgentPin(workspace, settings),
                    { retainOnWorkspaceFailure: true }
                );
            }
            renderPage();
        }
        return true;
    }

    function onChange(event) {
        if (!isBlueprintPage()) return;
        const target = event.target;
        if (!target) return;

        if (target.dataset.cbRole === 'composer-folder-select') {
            const val = target.value;
            if (val === '__new__') {
                target.value = currentFolderId();
                openNewFolderModal();
                return;
            }
            if (val === '__import__') {
                target.value = currentFolderId();
                pickFolderFromDisk();
                return;
            }
            if (val && val !== currentFolderId()) {
                selectFolder(val);
            }
            return;
        }

        if (target.dataset.cbRole === 'fso-folder') {
            if (runtime.fileSelector) {
                runtime.fileSelector.folderId = target.value;
                renderPage();
            }
            return;
        }

        if (target.dataset.cbRole === 'fso-bulk-file-input') {
            if (target.files && target.files.length) {
                void fsoHandleBulkFiles(target.files);
                target.value = '';
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

        // Commit the path-context field on blur/Enter. Validating the path here
        // (rather than at send time) gives immediate feedback: a typo reports
        // which segment did not exist, instead of the user waiting for a run to
        // fail.
        if (target.dataset.cbRole === 'path-context-input') {
            commitPathContextPath(String(target.value || ''));
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

        if (runtime.fileSelector && runtime.fileSelector.open) {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeFileSelectorOverlay();
                return;
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                fsoConfirmSelection();
                return;
            }
            if (event.key === 'Tab') {
                trapFocus(event, '.cb-fso-modal');
                return;
            }
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
                downloadFile: (path, folderId) => {
                    const record = core.readFile(path, folderId || currentFolderId());
                    if (record) {
                        downloadText(record.path.split('/').pop(), record.content, 'text/markdown;charset=utf-8');
                        setToast(`Downloaded ${record.path}.`, 'success');
                    }
                },
                isEditingFile: path => runtime.editingPath === path || Boolean(hostElements()?.settingsContainer?.querySelector('.cb-preview.cb-preview-editing')),
                saveFile: path => {
                    const targetPath = path || runtime.editingPath || core.store.openPath;
                    if (!targetPath) return;
                    const container = hostElements()?.settingsContainer || document;
                    const ta = container.querySelector('.cb-preview-textarea');
                    const content = ta ? ta.value : (core.readFile(targetPath)?.content || '');
                    core.writeFile(targetPath, content, { userEdit: true });
                    runtime.editingPath = null;
                    setToast(`Saved ${targetPath}.`, 'success');
                    renderPage();
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

    let activeTooltipEl = null;
    let tooltipBox = null;

    function ensureTooltipBox() {
        if (tooltipBox && tooltipBox.parentNode) return tooltipBox;
        tooltipBox = document.createElement('div');
        tooltipBox.className = 'cb-floating-tooltip';
        tooltipBox.setAttribute('role', 'tooltip');
        tooltipBox.setAttribute('aria-hidden', 'true');
        if (document.body) {
            document.body.appendChild(tooltipBox);
        }
        return tooltipBox;
    }

    function onMouseOver(event) {
        if (!isBlueprintPage()) return;
        const target = event.target && typeof event.target.closest === 'function'
            ? event.target.closest('[data-cb-tooltip]')
            : null;
        if (!target) return;
        const text = target.getAttribute('data-cb-tooltip');
        if (!text) return;
        activeTooltipEl = target;
        const box = ensureTooltipBox();
        box.textContent = text;
        box.className = 'cb-floating-tooltip';

        if (typeof target.getBoundingClientRect !== 'function') return;
        const rect = target.getBoundingClientRect();
        box.style.display = 'block';
        box.style.visibility = 'hidden';
        box.style.left = '0px';
        box.style.top = '0px';

        const boxRect = box.getBoundingClientRect ? box.getBoundingClientRect() : { width: 200, height: 28 };
        let top = (rect.top || 0) - (boxRect.height || 28) - 7;
        let left;
        if (target.classList && target.classList.contains('cb-path-context-status')) {
            left = (rect.right || 0) - (boxRect.width || 200);
            box.classList.add('arrow-right');
        } else {
            left = rect.left || 0;
            box.classList.add('arrow-left');
        }

        const winWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200;
        if (left < 8) {
            left = 8;
        } else if (left + (boxRect.width || 200) > winWidth - 8) {
            left = winWidth - (boxRect.width || 200) - 8;
        }
        if (top < 8) {
            top = (rect.bottom || 0) + 7;
            box.classList.add('arrow-top');
        }

        box.style.left = `${Math.round(left)}px`;
        box.style.top = `${Math.round(top)}px`;
        box.style.visibility = '';
        box.classList.add('visible');
    }

    function onMouseOut(event) {
        if (!activeTooltipEl) return;
        if (event.relatedTarget && typeof activeTooltipEl.contains === 'function' && activeTooltipEl.contains(event.relatedTarget)) return;
        activeTooltipEl = null;
        if (tooltipBox) {
            tooltipBox.classList.remove('visible');
        }
    }

    function onWheel(event) {
        if (!isBlueprintPage()) return;
        const scrollArea = event.target && typeof event.target.closest === 'function'
            ? event.target.closest('.cb-composer-bar-scroll')
            : null;
        if (!scrollArea) return;
        if (scrollArea.scrollWidth <= scrollArea.clientWidth) return;
        if (event.deltaY && !event.deltaX) {
            scrollArea.scrollLeft += event.deltaY;
            if (typeof event.preventDefault === 'function') event.preventDefault();
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
            recoverInterruptedRuns();
            if (runtime.runSelectionRestored) {
                runtime.runs = core.store.runs.slice();
                runtime.currentRun = runtime.activeRunId ? core.findRun(runtime.activeRunId) : null;
                if (runtime.currentRun) rebuildMessagesFromRun(runtime.currentRun);
                runtime.runSelectionRestored = false;
            } else {
                loadRuns();
            }
            if (runtime.currentRun) rebuildMessagesFromRun(runtime.currentRun);
            runtime.selectedSkillId = (runtime.currentRun && runtime.currentRun.skillId) || runtime.selectedSkillId;
        },

        activate(context) {
            runtime.context = context || runtime.context;
            runtime.active = true;
            ensureHostRecord();
            ensureWorkspace();
            loadRuns();
            if (!runtime.busy && !runtime.messages.length && runtime.currentRun) rebuildMessagesFromRun(runtime.currentRun);
            // Do NOT force the Agent tab: restoreTabsOnLoad keeps whatever the
            // user had open. The folder is derived from the active tab instead.
            syncFolderFromTab();
            if (!runtime.busy) runtime.hint = selectedSkill().tagline;
            bindAssistantSteps();
            // setApp() sets state.folder to 'all' before the page renders, so the
            // nav/list/ribbon surfaces must be refreshed once the section is known.
            renderHostSurfaces();
            renderPage();
            if (isAgentTabActive()) scrollTranscriptToEnd();
        },

        deactivate() {
            runtime.active = false;
            clearTimeout(runtime.importRenderTimer);
            runtime.importRenderTimer = null;
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
            clearTimeout(runtime.importRenderTimer);
            runtime.importRenderTimer = null;
            const execution = runtime.currentController;
            const interruptedRun = (execution && execution.ownerRun) || runtime.currentRun;
            const cancelIds = execution && execution.cancelIds
                ? [...execution.cancelIds] : [];
            runtime.generation += 1;
            if (execution && execution.abort) {
                try { execution.abort.abort(); } catch (_) { /* already settled */ }
            }
            const importOperation = runtime.importController;
            if (importOperation) {
                try { importOperation.abort(); } catch (_) { /* already settled */ }
            }
            cancelIds.forEach(cancelId => {
                const cancelling = typeof core.cancelTurnOutcome === 'function'
                    ? core.cancelTurnOutcome(cancelId, { timeoutMs: 5000 })
                    : core.cancelTurn(cancelId, { timeoutMs: 5000 }).then(ok => ok ? 'cancelled' : 'unknown');
                void cancelling.then(outcome => {
                    if (cancellationOutcomeTerminal(outcome)
                        && clearPendingCancelRecord(cancelId, execution
                            && execution.cancelLeases.get(String(cancelId)))) {
                        runtime.unacknowledgedCancelIds.delete(cancelId);
                        if (execution) execution.cancelLeases.delete(String(cancelId));
                    } else runtime.unacknowledgedCancelIds.add(cancelId);
                });
            });
            if (runtime.busy && interruptedRun && interruptedRun.status === 'running') {
                settleRunLocally(interruptedRun, 'interrupted', 'The page was closed before this run completed.');
            }
            if (!runtime.executionSettlements.size) runtime.busy = false;
            // An import owns its mutation lock until its asynchronous rollback or
            // final commit settles. Clearing it here would let an immediate remount
            // race new changes against the old import's late cleanup.
            if (!runtime.importSettlement) {
                runtime.busyImport = false;
                runtime.importController = null;
                runtime.importProgress = null;
            }
            if (!runtime.executionSettlements.size) runtime.currentController = null;
            runtime.answerResolver = null;
            runtime.hint = '';
            stopLiveTicker();
            persistWorkspace();
            releaseDivider();
            clearTimeout(runtime.toastTimer);
            runtime.toastTimer = null;
            if (runtime.foreignRecoveryTimer) clearTimeout(runtime.foreignRecoveryTimer);
            runtime.foreignRecoveryTimer = null;
            runtime.foreignRecoveryPending = false;
            runtime.modal = null;
            runtime.pendingQuestion = null;
            runtime.context = null;
        },

        serializeState() {
            return {
                section: runtime.folder,
                skillId: runtime.selectedSkillId,
                viewerMode: runtime.viewerMode,
                openPath: core.store.openPath,
                openFolderId: core.store.openFolderId,
                activeFolderId: core.store.activeFolderId,
                expanded: [...runtime.expanded].slice(0, 500),
                activeRunId: runtime.activeRunId,
                // The host may snapshot/restore the page across app switches; the
                // tab layout rides along so a restore lands on the same tab.
                workspace: runtime.workspace ? JSON.parse(JSON.stringify(runtime.workspace)) : null
            };
        },

        restoreState(contextOrValue, maybeValue) {
            const value = sanitizeRestoredState(hookContext(contextOrValue, maybeValue));
            if (!value) return;
            if (operationBusy()) {
                runtime.pendingRestoreState = value;
                return;
            }
            applyRestoredState(value);
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
            if (elements && elements.navTitle) {
                elements.navTitle.textContent = '';
                elements.navTitle.appendChild(ui.node('span', 'cb-brand-name', 'Codalio Blueprint'));
            }
            if (elements && elements.navFolderList) {
                elements.navFolderList.setAttribute('aria-label', 'Codalio Blueprint navigation');
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
                const record = path ? core.readFile(path, core.store.openFolderId) : null;
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
                const record = path ? core.readFile(path, core.store.openFolderId) : null;
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
        listFiles: folderId => core.listFiles(folderId),
        readFile: (path, folderId) => core.readFile(path, folderId),
        listRuns: () => core.store.runs.map(run => ({ id: run.id, skill: run.skillId, status: run.status })),
        isBusy: () => runtime.busy,
        handlers,
        controller
    });

    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('mouseover', onMouseOver);
    document.addEventListener('mouseout', onMouseOut);
    document.addEventListener('wheel', onWheel, { passive: false });
    if (typeof window.addEventListener === 'function') {
        // controller.js can be re-evaluated by a development host. Replace the
        // prior closure instead of accumulating duplicate abort/reload handlers.
        const prior = window.__codalioBlueprintStoreChangeListener;
        if (typeof prior === 'function' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('codalio-blueprint-store-change', prior);
        }
        window.__codalioBlueprintStoreChangeListener = onExternalStoreChange;
        window.addEventListener('codalio-blueprint-store-change', onExternalStoreChange);
        const priorLease = window.__codalioBlueprintRunLeaseListener;
        if (typeof priorLease === 'function' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('codalio-blueprint-run-lease-change', priorLease);
        }
        window.__codalioBlueprintRunLeaseListener = onRunLeaseChange;
        window.addEventListener('codalio-blueprint-run-lease-change', onRunLeaseChange);
        const priorWorkspace = window.__codalioBlueprintWorkspaceChangeListener;
        if (typeof priorWorkspace === 'function' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('codalio-blueprint-workspace-change', priorWorkspace);
        }
        window.__codalioBlueprintWorkspaceChangeListener = onExternalWorkspaceChange;
        window.addEventListener('codalio-blueprint-workspace-change', onExternalWorkspaceChange);
    }
    const disposeController = () => {
        if (typeof document.removeEventListener === 'function') {
            document.removeEventListener('click', onClick);
            document.removeEventListener('input', onInput);
            document.removeEventListener('change', onChange);
            document.removeEventListener('keydown', onKeydown);
            document.removeEventListener('mouseover', onMouseOver);
            document.removeEventListener('mouseout', onMouseOut);
            document.removeEventListener('wheel', onWheel);
            if (tooltipBox && tooltipBox.parentNode) {
                tooltipBox.parentNode.removeChild(tooltipBox);
            }
        }
        if (typeof window.removeEventListener === 'function') {
            window.removeEventListener('codalio-blueprint-store-change', onExternalStoreChange);
            window.removeEventListener('codalio-blueprint-run-lease-change', onRunLeaseChange);
            window.removeEventListener('codalio-blueprint-workspace-change', onExternalWorkspaceChange);
        }
        if (window.__codalioBlueprintStoreChangeListener === onExternalStoreChange) {
            delete window.__codalioBlueprintStoreChangeListener;
        }
        if (window.__codalioBlueprintRunLeaseListener === onRunLeaseChange) {
            delete window.__codalioBlueprintRunLeaseListener;
        }
        if (window.__codalioBlueprintWorkspaceChangeListener === onExternalWorkspaceChange) {
            delete window.__codalioBlueprintWorkspaceChangeListener;
        }
        if (runtime.mounted || runtime.active || runtime.busy || runtime.busyImport) {
            controller.unmount();
        }
        if (window[CONTROLLER_DISPOSE_KEY] === disposeController) {
            delete window[CONTROLLER_DISPOSE_KEY];
        }
    };
    window[CONTROLLER_DISPOSE_KEY] = disposeController;
}());
