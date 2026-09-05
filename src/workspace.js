/*
 * Codalio Blueprint — tabbed workspace engine.
 *
 * Original Blueprint code. SimpleRAG's own graph workspace uses multi-tab
 * navigation, and Blueprint follows that *idea* — nothing else. Every function
 * here is Blueprint's own, operates on Blueprint's own persisted state, and
 * renders only .cb- namespaced nodes.
 *
 * The model:
 *
 *   Agent  |  Project Files  |  toolshare-prd.md  x  |  Settings  x
 *   ^pinned    ^opened from nav      ^opened from tree    ^opened from nav
 *
 * Pressing Project Files / Runs / Settings in the sidebar OPENS A TAB beside
 * the Agent instead of replacing it, so the conversation in progress is never
 * lost. Documents open as their own editor tabs. Tabs persist across reloads
 * (settings.restoreTabsOnLoad) and are capped with LRU eviction
 * (settings.maxOpenTabs).
 *
 * All functions are pure over the workspace object unless noted, so the whole
 * engine is testable headless.
 */
(function defineBlueprintWorkspace() {
    'use strict';

    if (window.__codalioBlueprintWorkspace) return;

    const core = window.__codalioBlueprintCore;
    // Resolved lazily: script order must not decide whether settings navigation
    // works. An eager capture would freeze `null` if this module ever loaded
    // before settings.js and silently degrade every later call.
    const settingsModule = () => window.__codalioBlueprintSettings;

    const AGENT_TAB_ID = 'tab-agent';

    // Sections that can own a singleton tab. 'cb-agent' is special: it is the
    // chat and is (by default) pinned.
    const SECTION_TABS = [
        { id: 'cb-files', label: 'Project Files', icon: 'fa-folder-tree' },
        { id: 'cb-history', label: 'Runs', icon: 'fa-clock-rotate-left' },
        { id: 'cb-settings', label: 'Settings', icon: 'fa-sliders' }
    ];

    const MAX_TABS_HARD_CAP = 24;

    // ------------------------------------------------------------------
    // Construction / normalization
    // ------------------------------------------------------------------

    function makeTab(partial) {
        return Object.assign({
            id: '',
            kind: 'section',          // 'agent' | 'section' | 'file'
            title: '',
            icon: 'fa-file',
            sectionId: '',
            path: '',
            folderId: '',
            pinned: false,
            openedAt: Date.now(),
            lastActiveAt: Date.now()
        }, partial || {});
    }

    function agentTab(pinned) {
        return makeTab({
            id: AGENT_TAB_ID,
            kind: 'agent',
            title: 'Agent',
            icon: 'fa-robot',
            sectionId: 'cb-agent',
            pinned: pinned !== false
        });
    }

    function createWorkspace(settings) {
        const cfg = settings || readSettingsSafe();
        return {
            tabs: [agentTab(cfg.pinAgentTab)],
            activeTabId: AGENT_TAB_ID,
            settingsSection: 'agent',
            settingsPage: 'planning',
            settingsQuery: '',
            viewerModeByPath: Object.create(null),
            dividerPx: 0            // 0 = use settings.listPaneWidth
        };
    }

    function readSettingsSafe() {
        try {
            return core.readSettings();
        } catch (_) {
            return {};
        }
    }

    function sectionMeta(sectionId) {
        return SECTION_TABS.find(item => item.id === sectionId) || null;
    }

    function persistedTabTimes(candidate) {
        const now = Date.now();
        const maxFuture = now + 24 * 60 * 60 * 1000;
        const opened = Number(candidate && candidate.openedAt);
        const active = Number(candidate && candidate.lastActiveAt);
        const openedAt = Number.isFinite(opened) && opened > 0 && opened <= maxFuture ? opened : now;
        const lastActiveAt = Number.isFinite(active) && active > 0 && active <= maxFuture
            ? active : openedAt;
        return { openedAt, lastActiveAt };
    }

    /**
     * Rebuild a persisted workspace: drop tabs whose file no longer exists,
     * re-pin the agent per settings, clamp the active id, cap the tab count.
     */
    function normalizeWorkspace(raw, settings) {
        const cfg = settings || readSettingsSafe();
        const base = createWorkspace(cfg);
        if (!raw || typeof raw !== 'object') return base;
        const schemaVersion = Number.isSafeInteger(raw.version) && raw.version > 0
            ? raw.version : 1;

        const tabs = [];
        let sawAgent = false;

        (Array.isArray(raw.tabs) ? raw.tabs : []).forEach(candidate => {
            if (!candidate || typeof candidate !== 'object') return;
            const kind = candidate.kind;
            if (kind === 'agent') {
                if (sawAgent) return;
                sawAgent = true;
                tabs.push(Object.assign(agentTab(cfg.pinAgentTab), persistedTabTimes(candidate)));
                return;
            }
            if (kind === 'section') {
                const meta = sectionMeta(candidate.sectionId);
                if (!meta) return;
                if (tabs.some(tab => tab.kind === 'section' && tab.sectionId === meta.id)) return;
                tabs.push(makeTab({
                    id: `tab-${meta.id}`,
                    kind: 'section',
                    title: meta.label,
                    icon: meta.icon,
                    sectionId: meta.id,
                    pinned: false,
                    ...persistedTabTimes(candidate)
                }));
                return;
            }
            if (kind === 'file') {
                const requestedPath = String(candidate.path || '');
                if (!requestedPath) return;
                const requestedFolder = String(candidate.folderId || '');
                let record = requestedFolder ? core.readFile(requestedPath, requestedFolder) : null;
                // v1 tabs predate root-qualified identities. Migrate only when
                // the path exists in exactly one root; picking the active root or
                // the first match can display a different project's same-path
                // file. A v2 ownerless tab is malformed and is dropped.
                if (!requestedFolder && schemaVersion < 2) {
                    const matches = core.listFolders()
                        .map(folder => core.readFile(requestedPath, folder.id))
                        .filter(Boolean);
                    record = matches.length === 1 ? matches[0] : null;
                }
                if (!record) return;   // file was deleted
                const folderId = String(record.folder || requestedFolder || '');
                const path = String(record.path || '');
                if (!path) return;
                if (tabs.some(tab => tab.kind === 'file'
                    && tab.path === path && tab.folderId === folderId)) return;
                tabs.push(makeTab({
                    id: fileTabId(path, folderId),
                    kind: 'file',
                    title: path.split('/').pop(),
                    icon: 'fa-file-lines',
                    path,
                    folderId,
                    pinned: false,
                    ...persistedTabTimes(candidate)
                }));
            }
        });

        if (!sawAgent) tabs.unshift(agentTab(cfg.pinAgentTab));

        // Cap: keep agent (pinned) + most recently active up to maxOpenTabs.
        const cap = clampTabCap(cfg.maxOpenTabs);
        const sorted = tabs.slice().sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
        const keep = new Set(sorted.slice(0, cap).map(tab => tab.id));
        const finalTabs = tabs.filter(tab => keep.has(tab.id) || (tab.pinned && tab.kind === 'agent'));

        let activeTabId = finalTabs.some(tab => tab.id === raw.activeTabId)
            ? String(raw.activeTabId)
            : AGENT_TAB_ID;
        // Workspace v1 file tabs were keyed by path alone. Preserve the selected
        // legacy tab while migrating it to the folder-qualified v2 identity.
        if (activeTabId === AGENT_TAB_ID && String(raw.activeTabId || '').startsWith('tab-file:')) {
            const rawActiveId = String(raw.activeTabId);
            const sourceTab = (Array.isArray(raw.tabs) ? raw.tabs : []).find(tab => tab
                && tab.kind === 'file'
                && (String(tab.id || '') === rawActiveId
                    || fileTabId(tab.path, tab.folderId) === rawActiveId));
            const sourceRef = sourceTab
                ? core.fileRef(String(sourceTab.path || ''), String(sourceTab.folderId || ''))
                : null;
            const legacyPath = rawActiveId.slice('tab-file:'.length);
            const migrated = finalTabs.find(tab => tab.kind === 'file'
                && ((sourceRef && tab.path === sourceRef.path
                    && tab.folderId === sourceRef.folderId)
                    || tab.path === legacyPath));
            if (migrated) activeTabId = migrated.id;
        }

        return {
            tabs: finalTabs,
            activeTabId,
            settingsSection: validSettingsSection(raw.settingsSection),
            settingsPage: validSettingsPage(raw.settingsSection, raw.settingsPage),
            settingsQuery: typeof raw.settingsQuery === 'string' ? raw.settingsQuery.slice(0, 120) : '',
            viewerModeByPath: sanitizeViewerModes(raw.viewerModeByPath),
            dividerPx: clampDivider(raw.dividerPx)
        };
    }

    function clampTabCap(value) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return 8;
        return Math.min(MAX_TABS_HARD_CAP, Math.max(2, parsed));
    }

    function clampDivider(value) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) return 0;
        return Math.min(640, Math.max(180, parsed));
    }

    function validSettingsSection(sectionId) {
        const schema = settingsModule();
        if (!schema) return 'agent';
        const found = schema.sections().find(section => section.id === sectionId);
        return found ? found.id : schema.sections()[0].id;
    }

    function validSettingsPage(sectionId, pageId) {
        const schema = settingsModule();
        if (!schema) return 'planning';
        const section = schema.getSection(validSettingsSection(sectionId));
        const found = section.pages.find(page => page.id === pageId);
        return found ? found.id : section.pages[0].id;
    }

    function sanitizeViewerModes(raw) {
        const out = Object.create(null);
        if (raw && typeof raw === 'object') {
            Object.keys(raw).forEach(path => {
                if (raw[path] === 'source' || raw[path] === 'preview') out[path] = raw[path];
            });
        }
        return out;
    }

    function safeListFiles() {
        try {
            return core.listFiles();
        } catch (_) {
            return [];
        }
    }

    function fileTabId(path, folderId) {
        // A relative path is not a file identity in a multi-root workspace.
        // Encode both components so separators or punctuation in either value
        // cannot make two references collapse to the same DOM/persistence id.
        const folder = encodeURIComponent(String(folderId || ''));
        const filePath = encodeURIComponent(String(path || ''));
        return `tab-file:${folder}::${filePath}`;
    }

    function viewerKey(path, folderId) {
        return fileTabId(path, folderId).slice('tab-file:'.length);
    }

    // ------------------------------------------------------------------
    // Queries
    // ------------------------------------------------------------------

    function tabs(ws) {
        return Array.isArray(ws.tabs) ? ws.tabs : [];
    }

    function findTab(ws, tabId) {
        return tabs(ws).find(tab => tab.id === tabId) || null;
    }

    function activeTab(ws) {
        return findTab(ws, ws.activeTabId) || tabs(ws)[0] || agentTab(true);
    }

    function sectionTab(ws, sectionId) {
        if (sectionId === 'cb-agent') return findTab(ws, AGENT_TAB_ID);
        return tabs(ws).find(tab => tab.kind === 'section' && tab.sectionId === sectionId) || null;
    }

    function fileTab(ws, path, folderId) {
        const wantedFolder = String(folderId || '');
        return tabs(ws).find(tab => tab.kind === 'file' && tab.path === path
            && (!wantedFolder || tab.folderId === wantedFolder)) || null;
    }

    function isAgentActive(ws) {
        return activeTab(ws).kind === 'agent';
    }

    /** Which sidebar section is "current" for nav highlighting + list pane. */
    function activeSectionId(ws) {
        const tab = activeTab(ws);
        if (tab.kind === 'agent') return 'cb-agent';
        if (tab.kind === 'section') return tab.sectionId;
        return 'cb-files';      // a document tab belongs to Project Files
    }

    /**
     * Which view a document tab opens in.
     *
     * An explicit per-document choice always wins. Otherwise the DEFAULT depends
     * on what the file IS, not on one global setting: Markdown renders as prose,
     * and everything else opens in the code previewer. Rendering a .py or .json
     * file through the Markdown renderer mangles it — `#` comments become
     * headings, `*args` becomes a bullet — which is what happened to every imported
     * source folder before this.
     *
     * Settings -> Workspace -> Editor -> "Open documents in" still decides for
     * Markdown, where both readings are sensible.
     */
    function viewerModeFor(ws, path, settings, folderId) {
        const stored = ws.viewerModeByPath
            && (ws.viewerModeByPath[viewerKey(path, folderId)] || ws.viewerModeByPath[path]);
        if (stored === 'source' || stored === 'preview') return stored;

        const clean = String(path || '');
        const preview = typeof window !== 'undefined' ? window.__codalioBlueprintPreview : null;
        // preview.js loads before workspace.js, but resolve it lazily anyway so a
        // load-order change cannot silently downgrade this to "always Markdown".
        if (preview && typeof preview.languageFor === 'function') {
            const language = preview.languageFor(clean);
            const markdownLike = language && (language.key === 'markdown' || language.key === 'text');
            if (!markdownLike) return 'source';
        }

        return settings && settings.defaultViewerMode === 'source' ? 'source' : 'preview';
    }

    // ------------------------------------------------------------------
    // Mutations (all return the same ws object, mutated — the controller
    // persists it afterwards via core.saveWorkspace)
    // ------------------------------------------------------------------

    function touch(tab) {
        tab.lastActiveAt = Date.now();
        return tab;
    }

    function activateTab(ws, tabId) {
        const tab = findTab(ws, tabId);
        if (!tab) return ws;
        ws.activeTabId = tab.id;
        touch(tab);
        return ws;
    }

    function activateAgent(ws) {
        return activateTab(ws, AGENT_TAB_ID);
    }

    /**
     * Open (or activate) the singleton tab for a sidebar section.
     * 'cb-agent' activates the pinned chat tab.
     */
    function openSection(ws, sectionId, settings) {
        const cfg = settings || readSettingsSafe();
        if (sectionId === 'cb-agent') return activateAgent(ws);

        const existing = sectionTab(ws, sectionId);
        if (existing) return activateTab(ws, existing.id);

        const meta = sectionMeta(sectionId);
        if (!meta) return ws;

        const tab = touch(makeTab({
            id: `tab-${meta.id}`,
            kind: 'section',
            title: meta.label,
            icon: meta.icon,
            sectionId: meta.id
        }));
        ws.tabs.push(tab);
        evictIfNeeded(ws, cfg, tab.id);
        ws.activeTabId = tab.id;
        return ws;
    }

    /**
     * Open (or activate) a document editor tab. Applies the LRU cap: when over
     * maxOpenTabs, the least recently used *file* tab is closed — never the
     * pinned agent, never the tab just opened, never a section tab the user
     * explicitly opened (files are the cheap-to-reopen kind).
     *
     * Pass activate=false to open the tab in the BACKGROUND: it joins the strip
     * without taking focus. That is what a run uses when it writes a document, so
     * the step trace the user is watching is not replaced mid-stream.
     */
    function openFile(ws, path, settings, activate, folderId) {
        const cfg = settings || readSettingsSafe();
        const requestedPath = String(path || '');
        if (!requestedPath) return ws;
        const shouldActivate = activate !== false;
        const ref = core.fileRef(requestedPath, typeof folderId === 'string' ? folderId : '');
        if (!ref || !ref.folderId) return ws;
        const record = core.readFile(ref.path, ref.folderId);
        if (!record) return ws;
        const clean = String(record.path || ref.path || '');
        const owner = String(ref.folderId);

        const existing = fileTab(ws, clean, owner);
        if (existing) {
            existing.title = clean.split('/').pop();
            touch(existing);
            return shouldActivate ? activateTab(ws, existing.id) : ws;
        }

        const tab = touch(makeTab({
            id: fileTabId(clean, owner),
            kind: 'file',
            title: clean.split('/').pop(),
            icon: fileIcon(clean),
            path: clean,
            folderId: owner
        }));
        ws.tabs.push(tab);
        evictIfNeeded(ws, cfg, tab.id);
        if (shouldActivate) ws.activeTabId = tab.id;
        return ws;
    }

    function evictIfNeeded(ws, cfg, protectTabId) {
        const cap = clampTabCap(cfg && cfg.maxOpenTabs);
        let overflow = tabs(ws).length - cap;
        if (overflow <= 0) return;

        const candidates = tabs(ws)
            .filter(tab => tab.id !== protectTabId && tab.kind === 'file' && !tab.pinned)
            .sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0));

        for (const victim of candidates) {
            if (overflow <= 0) break;
            ws.tabs = ws.tabs.filter(tab => tab.id !== victim.id);
            overflow -= 1;
        }
        // Still over cap (user opened many section tabs)? Evict LRU sections.
        if (overflow > 0) {
            const sectionCandidates = tabs(ws)
                .filter(tab => tab.id !== protectTabId && tab.kind === 'section')
                .sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0));
            for (const victim of sectionCandidates) {
                if (overflow <= 0) break;
                ws.tabs = ws.tabs.filter(tab => tab.id !== victim.id);
                overflow -= 1;
            }
        }
    }

    /**
     * Close a tab. The pinned agent tab refuses. Returns the id to activate
     * after closing (the neighbour, IDE-style: prefer the tab to the right).
     */
    function closeTab(ws, tabId, settings) {
        const cfg = settings || readSettingsSafe();
        const tab = findTab(ws, tabId);
        if (!tab) return ws;
        if (tab.pinned && tab.kind === 'agent' && cfg.pinAgentTab !== false) return ws;

        const index = ws.tabs.findIndex(item => item.id === tabId);
        ws.tabs.splice(index, 1);

        if (ws.activeTabId === tabId) {
            const neighbour = ws.tabs[index] || ws.tabs[index - 1] || ws.tabs[0];
            ws.activeTabId = neighbour ? neighbour.id : AGENT_TAB_ID;
            const next = findTab(ws, ws.activeTabId);
            if (next) touch(next);
        }
        if (!ws.tabs.length) ws.tabs.push(agentTab(cfg.pinAgentTab));
        return ws;
    }

    function closeOtherTabs(ws, tabId) {
        const keep = findTab(ws, tabId);
        if (!keep) return ws;
        ws.tabs = ws.tabs.filter(tab => tab.id === tabId || (tab.pinned && tab.kind === 'agent'));
        ws.activeTabId = keep.id;
        return ws;
    }

    function closeFileTabs(ws) {
        const remaining = ws.tabs.filter(tab => tab.kind !== 'file');
        ws.tabs = remaining.length ? remaining : [agentTab(true)];
        if (!findTab(ws, ws.activeTabId)) ws.activeTabId = ws.tabs[0].id;
        return ws;
    }

    /** Keep the agent tab's pinned flag in sync with settings. */
    function syncAgentPin(ws, settings) {
        const cfg = settings || readSettingsSafe();
        const tab = findTab(ws, AGENT_TAB_ID);
        if (tab) tab.pinned = cfg.pinAgentTab !== false;
        return ws;
    }

    /** Called after a file is written: open or refresh its tab per settings. */
    function onFileWritten(ws, path, settings, folderId) {
        const cfg = settings || readSettingsSafe();
        if (!path) return ws;
        const record = folderId ? core.readFile(path, folderId) : core.readFile(path);
        const owner = String((record && record.folder) || folderId || '');
        const existing = fileTab(ws, path, owner);
        if (existing) {
            existing.title = path.split('/').pop();
            touch(existing);
            return ws;
        }
        if (cfg.autoOpenWrittenDocument === false) return ws;
        // Background: the document is ready in the strip, but the run keeps the
        // Agent tab in focus so its steps stay visible while it finishes.
        return openFile(ws, path, cfg, false, owner);
    }

    /** Called after a file is deleted: drop its tab per settings. */
    function onFileDeleted(ws, path, settings, folderId) {
        const cfg = settings || readSettingsSafe();
        const tab = fileTab(ws, path, folderId);
        if (!tab) return ws;
        if (cfg.closeTabOnDelete === false) {
            // Keep the tab; the viewer renders its own "file is gone" state.
            return ws;
        }
        return closeTab(ws, tab.id, cfg);
    }

    function onFileRenamed(ws, oldPath, newPath, settings, folderId) {
        const tab = fileTab(ws, oldPath, folderId);
        const oldKey = viewerKey(oldPath, folderId);
        const newKey = viewerKey(newPath, folderId);
        const legacyPathStillShared = tabs(ws).some(candidate => candidate
            && candidate.kind === 'file'
            && candidate.path === oldPath
            && String(candidate.folderId || '') !== String(folderId || ''));
        if (ws.viewerModeByPath && (ws.viewerModeByPath[oldKey] || ws.viewerModeByPath[oldPath])) {
            ws.viewerModeByPath[newKey] = ws.viewerModeByPath[oldKey] || ws.viewerModeByPath[oldPath];
            delete ws.viewerModeByPath[oldKey];
            // A legacy unqualified preference can still be the fallback for a
            // same-path tab in another root. Do not erase that root's mode while
            // renaming only this owner-qualified tab.
            if (!legacyPathStillShared) delete ws.viewerModeByPath[oldPath];
        }
        if (!tab) return ws;
        const oldId = tab.id;
        tab.path = newPath;
        tab.id = fileTabId(newPath, folderId || tab.folderId);
        tab.title = newPath.split('/').pop();
        if (ws.activeTabId === oldId) ws.activeTabId = tab.id;
        return ws;
    }

    function setViewerMode(ws, path, mode, folderId) {
        if (!ws.viewerModeByPath) ws.viewerModeByPath = {};
        ws.viewerModeByPath[viewerKey(path, folderId)] = mode === 'source' ? 'source' : 'preview';
        return ws;
    }

    function setSettingsLocation(ws, sectionId, pageId) {
        ws.settingsSection = validSettingsSection(sectionId);
        ws.settingsPage = validSettingsPage(ws.settingsSection, pageId);
        return ws;
    }

    function setSettingsQuery(ws, query) {
        ws.settingsQuery = String(query || '').slice(0, 120);
        return ws;
    }

    function setDivider(ws, px) {
        ws.dividerPx = clampDivider(px);
        return ws;
    }

    function fileIcon(path) {
        const lower = String(path || '').toLowerCase();
        if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'fa-file-lines';
        if (/\.(json|py|js|jsx|ts|tsx|css|html|sh|ps1|ya?ml|toml)$/.test(lower)) return 'fa-file-code';
        if (/\.(png|jpe?g|gif|svg|webp)$/.test(lower)) return 'fa-file-image';
        return 'fa-file';
    }

    // ------------------------------------------------------------------
    // Keyboard shortcuts (IDE conventions)
    // ------------------------------------------------------------------

    const SHORTCUTS = [
        { combo: 'Ctrl+W', description: 'Close the active tab' },
        { combo: 'Ctrl+Tab', description: 'Next tab' },
        { combo: 'Ctrl+Shift+Tab', description: 'Previous tab' },
        { combo: 'Ctrl+1 … Ctrl+4', description: 'Jump to Agent / Files / Runs / Settings' },
        { combo: 'Ctrl+S', description: 'Download the open document' },
        { combo: 'Ctrl+F', description: 'Search settings (on the Settings tab)' },
        { combo: 'Alt+Left', description: 'Back to the Agent tab' }
    ];

    /**
     * Handle a keydown on the Blueprint page. Returns true when handled so the
     * controller can preventDefault. Never swallows keys aimed at inputs except
     * for Escape-style cases noted inline.
     */
    function handleShortcut(ws, event, actions, settings) {
        if (!event || event.altGraphKey) return false;
        const cfg = settings || readSettingsSafe();
        const key = String(event.key || '');
        const ctrl = Boolean(event.ctrlKey || event.metaKey);
        const target = event.target;
        const inTextField = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);

        if (ctrl && key.toLowerCase() === 'w') {
            const tab = activeTab(ws);
            if (tab.pinned && tab.kind === 'agent' && cfg.pinAgentTab !== false) return false;
            actions.closeTab(tab.id);
            return true;
        }
        if (ctrl && key === 'Tab') {
            actions.cycleTab(event.shiftKey ? -1 : 1);
            return true;
        }
        if (ctrl && /^[1-4]$/.test(key)) {
            const order = ['cb-agent', 'cb-files', 'cb-history', 'cb-settings'];
            actions.openSection(order[Number(key) - 1]);
            return true;
        }
        if (ctrl && key.toLowerCase() === 's') {
            const tab = activeTab(ws);
            if (actions.isEditingFile && actions.isEditingFile(tab.path) && typeof actions.saveFile === 'function') {
                actions.saveFile(tab.path);
                return true;
            }
            if (tab.kind === 'file') {
                actions.downloadFile(tab.path, tab.folderId);
                return true;
            }
            return false;
        }
        if (ctrl && key.toLowerCase() === 'f' && !inTextField) {
            if (activeSectionId(ws) === 'cb-settings') {
                actions.focusSettingsSearch();
                return true;
            }
            return false;
        }
        if (event.altKey && key === 'ArrowLeft') {
            actions.openSection('cb-agent');
            return true;
        }
        return false;
    }

    function cycleIndex(ws, direction) {
        const list = tabs(ws);
        if (list.length < 2) return ws.activeTabId;
        const current = list.findIndex(tab => tab.id === ws.activeTabId);
        const next = (current + direction + list.length) % list.length;
        return list[next].id;
    }

    // ------------------------------------------------------------------
    // Tab strip rendering
    // ------------------------------------------------------------------

    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined && text !== null) element.textContent = String(text);
        return element;
    }

    function icon(name) {
        const element = document.createElement('i');
        element.className = `fas ${name}`;
        element.setAttribute('aria-hidden', 'true');
        return element;
    }

    /**
     * The tab strip: role=tablist, one role=tab button per tab, middle-click and
     * an x button to close, pinned agent has no x. Overflow scrolls sideways.
     */
    function renderTabStrip(ws, state) {
        const strip = node('div', 'cb-tabstrip');
        strip.dataset.cbRole = 'tabstrip';
        strip.setAttribute('role', 'tablist');
        strip.setAttribute('aria-label', 'Blueprint workspace tabs');

        const fileTitleCounts = new Map();
        tabs(ws).forEach(tab => {
            if (tab.kind !== 'file') return;
            const key = String(tab.title || tab.path || '');
            fileTitleCounts.set(key, (fileTitleCounts.get(key) || 0) + 1);
        });

        tabs(ws).forEach((tab, index) => {
            const isActive = tab.id === ws.activeTabId;
            const button = node('button', `cb-tab${isActive ? ' active' : ''}${tab.pinned ? ' pinned' : ''}`);
            button.type = 'button';
            button.dataset.cbAction = 'activate-tab';
            button.dataset.tabId = tab.id;
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
            button.setAttribute('aria-controls', 'cb-tabpanel');
            button.id = `cb-tabbtn-${index}`;
            button.tabIndex = isActive ? 0 : -1;

            // A tab is locked only while it is the pinned Agent AND the setting
            // that pins it is on. closeTab() and handleShortcut() apply the same
            // rule, so the affordance and the behaviour cannot disagree: turning
            // "Keep the Agent tab pinned" off makes the chat tab closable here too.
            const locked = tab.kind === 'agent' && tab.pinned && (!state || state.pinAgentTab !== false);
            const owningFolder = tab.kind === 'file' && tab.folderId && core.getFolder
                ? core.getFolder(tab.folderId) : null;
            const duplicateTitle = tab.kind === 'file'
                && (fileTitleCounts.get(String(tab.title || tab.path || '')) || 0) > 1;
            const displayTitle = duplicateTitle
                ? `${tab.title} · ${(owningFolder && owningFolder.name) || tab.folderId || 'project'}`
                : tab.title;
            const fileLocation = owningFolder
                ? `${owningFolder.name} / ${tab.path}`
                : tab.path;

            button.title = locked
                ? `${tab.title} (pinned — the chat is never closed)`
                : tab.kind === 'file'
                    ? `${fileLocation} — middle-click or Ctrl+W to close`
                    : `${tab.title} — middle-click or Ctrl+W to close`;

            button.appendChild(icon(tab.kind === 'file' ? fileIcon(tab.path) : tab.icon));
            const label = node('span', 'cb-tab-label', displayTitle);
            button.appendChild(label);

            if (state && state.busy && tab.kind === 'agent') {
                button.appendChild(icon('fa-circle-notch fa-spin cb-tab-busy'));
            }

            if (locked) {
                const pin = node('span', 'cb-tab-pin');
                pin.title = 'Pinned — the chat is never closed';
                pin.appendChild(icon('fa-thumbtack'));
                button.appendChild(pin);
            } else {
                const close = node('span', 'cb-tab-close');
                close.dataset.cbAction = 'close-tab';
                close.dataset.tabId = tab.id;
                close.setAttribute('role', 'button');
                close.setAttribute('aria-label', `Close ${displayTitle}`);
                close.tabIndex = -1;
                close.appendChild(icon('fa-xmark'));
                button.appendChild(close);
            }

            strip.appendChild(button);
        });

        // Right-aligned tab tools.
        const tools = node('div', 'cb-tabstrip-tools');
        const closeFiles = node('button', 'cb-icon-btn');
        closeFiles.type = 'button';
        closeFiles.dataset.cbAction = 'close-file-tabs';
        closeFiles.title = 'Close all document tabs';
        closeFiles.setAttribute('aria-label', 'Close all document tabs');
        closeFiles.appendChild(icon('fa-files'));
        tools.appendChild(closeFiles);
        strip.appendChild(tools);

        return strip;
    }

    window.__codalioBlueprintWorkspace = Object.freeze({
        AGENT_TAB_ID,
        SECTION_TABS,
        SHORTCUTS,
        makeTab,
        agentTab,
        createWorkspace,
        normalizeWorkspace,
        sectionMeta,
        fileTabId,
        viewerKey,
        tabs,
        findTab,
        activeTab,
        sectionTab,
        fileTab,
        isAgentActive,
        activeSectionId,
        viewerModeFor,
        activateTab,
        activateAgent,
        openSection,
        openFile,
        closeTab,
        closeOtherTabs,
        closeFileTabs,
        syncAgentPin,
        onFileWritten,
        onFileDeleted,
        onFileRenamed,
        setViewerMode,
        setSettingsLocation,
        setSettingsQuery,
        setDivider,
        fileIcon,
        handleShortcut,
        cycleIndex,
        renderTabStrip
    });
}());
