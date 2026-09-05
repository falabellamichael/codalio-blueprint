/*
 * Codalio Blueprint — page UI.
 *
 * Renders into SimpleRAG's native three-pane shell exactly like the bundled
 * Calendar page does: nav folders on the left, a contextual list pane, and the
 * main reading pane. The main pane carries the one big Cursor-style chat with
 * its visible step timeline and composer, plus the project document viewer.
 *
 * Builds DOM nodes only — model text never goes through innerHTML.
 */
(function defineBlueprintUi() {
    'use strict';

    if (window.__codalioBlueprintUi) return;

    const core = window.__codalioBlueprintCore;
    const skills = window.__codalioBlueprintSkills;
    // Both load after ui.js; resolved lazily so load order cannot break the page.
    const workspaceModule = () => window.__codalioBlueprintWorkspace;
    const settingsPage = () => window.__codalioBlueprintSettingsPage;

    // Fallbacks only. The live limits come from Settings -> Source files, so
    // changing them there actually changes what the attach dialog allows.
    const MAX_SOURCE_FILE_BYTES = 500 * 1024;
    const MAX_SOURCE_FILES = 50;
    const MAX_SOURCE_TOTAL_BYTES = 2048 * 1024;
    const MAX_FILE_NAME_LENGTH = 140;

    function sourceLimits() {
        let settings = null;
        try { settings = core.readSettings(); } catch (_) { settings = null; }
        if (!settings) {
            return {
                maxFiles: MAX_SOURCE_FILES,
                maxFileBytes: MAX_SOURCE_FILE_BYTES,
                maxTotalBytes: MAX_SOURCE_TOTAL_BYTES
            };
        }
        return {
            maxFiles: Number(settings.maxSourceFiles) || MAX_SOURCE_FILES,
            maxFileBytes: (Number(settings.maxSourceFileKb) || 120) * 1024,
            maxTotalBytes: (Number(settings.maxSourceTotalKb) || 420) * 1024
        };
    }

    const SECTIONS = [
        { id: 'cb-agent', icon: 'fa-robot', label: 'Agent' },
        { id: 'cb-files', icon: 'fa-folder-tree', label: 'Project Files' },
        { id: 'cb-history', icon: 'fa-clock-rotate-left', label: 'Runs' },
        { id: 'cb-settings', icon: 'fa-sliders', label: 'Settings' }
    ];

    // ------------------------------------------------------------------
    // Element helpers
    // ------------------------------------------------------------------

    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined && text !== null) element.textContent = String(text);
        return element;
    }

    function icon(name, extra) {
        const element = document.createElement('i');
        element.className = `fas ${name}${extra ? ` ${extra}` : ''}`;
        element.setAttribute('aria-hidden', 'true');
        return element;
    }

    function button(label, iconName, action, options) {
        const opts = options || {};
        const element = node('button', `cb-btn${opts.primary ? ' primary' : ''}${opts.danger ? ' danger' : ''}${opts.compact ? ' compact' : ''}`);
        element.type = 'button';
        element.dataset.cbAction = action;
        if (iconName) element.appendChild(icon(iconName));
        element.appendChild(node('span', null, label));
        if (opts.title) element.title = opts.title;
        if (opts.disabled) element.disabled = true;
        if (opts.dataset) {
            Object.entries(opts.dataset).forEach(([key, value]) => { element.dataset[key] = String(value); });
        }
        return element;
    }

    function iconButton(iconName, action, title, dataset) {
        const element = node('button', 'cb-icon-btn');
        element.type = 'button';
        element.dataset.cbAction = action;
        element.title = title;
        element.setAttribute('aria-label', title);
        element.appendChild(icon(iconName));
        if (dataset) {
            Object.entries(dataset).forEach(([key, value]) => { element.dataset[key] = String(value); });
        }
        return element;
    }

    function fileIconFor(name) {
        const lower = String(name || '').toLowerCase();
        if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'fa-file-lines';
        if (/\.(json|py|js|jsx|ts|tsx|css|html|sh|ps1|ya?ml|toml)$/.test(lower)) return 'fa-file-code';
        if (/\.(png|jpe?g|gif|svg|webp)$/.test(lower)) return 'fa-file-image';
        return 'fa-file';
    }

    // ------------------------------------------------------------------
    // Nav pane
    // ------------------------------------------------------------------

    function renderNav(state, host) {
        SECTIONS.forEach(section => {
            const count = section.id === 'cb-files'
                ? core.listFiles().length
                : section.id === 'cb-history'
                    ? state.runCount
                    : null;
            const iconName = (state && state.busy && section.id === 'cb-agent')
                ? 'fa-circle-notch fa-spin'
                : section.icon;
            host.addFolder(section.id, iconName, section.label, count);
        });
    }

    // ------------------------------------------------------------------
    // Ribbon
    // ------------------------------------------------------------------

    function renderRibbon(state, host) {
        if (state.folder === 'cb-agent') {
            host.addBtn('cb-run-new', 'fa-plus', 'New Run', true, () => state.handlers.newRun());
            host.addSep();
            if (state.busy) {
                host.addBtn('cb-run-stop', 'fa-stop', 'Stop', false, () => state.handlers.stopRun());
            } else {
                host.addBtn('cb-run-resume', 'fa-play', 'Run', false, () => state.handlers.focusComposer());
            }
            host.addSep();
            host.addBtn('cb-open-files', 'fa-folder-tree', 'Files', false, () => state.handlers.goSection('cb-files'));
            host.addBtn('cb-open-settings', 'fa-sliders', 'Settings', false, () => state.handlers.goSection('cb-settings'));
            return;
        }
        if (state.folder === 'cb-files') {
            host.addBtn('cb-new-folder', 'fa-folder-plus', 'New Folder', true, () => state.handlers.newFolder());
            host.addBtn('cb-open-folder', 'fa-folder-open', 'Open Folder', true, () => state.handlers.openFolder());
            host.addSep();
            host.addBtn('cb-add-source', 'fa-file-circle-plus', 'Add Source File', false, () => state.handlers.addSourceFile());
            host.addBtn('cb-new-file', 'fa-file-pen', 'New Markdown', false, () => state.handlers.newFile());
            host.addSep();
            host.addBtn('cb-export-project', 'fa-file-zipper', 'Download All', false, () => state.handlers.exportProject());
            host.addBtn('cb-open-agent', 'fa-robot', 'Agent', false, () => state.handlers.goSection('cb-agent'));
            return;
        }
        if (state.folder === 'cb-history') {
            host.addBtn('cb-history-refresh', 'fa-rotate', 'Refresh', false, () => state.handlers.render());
            host.addBtn('cb-clear-history', 'fa-trash-can', 'Clear Runs', false, () => state.handlers.clearHistory());
            return;
        }
        if (state.folder === 'cb-settings') {
            host.addBtn('cb-open-agent', 'fa-robot', 'Back to Agent', true, () => state.handlers.goSection('cb-agent'));
        }
    }

    // ------------------------------------------------------------------
    // List pane (contextual: skills, file tree, runs, settings summary)
    // ------------------------------------------------------------------

    function renderList(state, listTitle, listContent) {
        listContent.innerHTML = '';
        if (state.folder === 'cb-files') {
            listTitle.textContent = 'Project Files';
            listContent.appendChild(renderFileTree(state));
            return;
        }
        if (state.folder === 'cb-history') {
            listTitle.textContent = 'Runs';
            listContent.appendChild(renderRunList(state));
            return;
        }
        if (state.folder === 'cb-settings') {
            listTitle.textContent = 'Settings';
            const page = settingsPage();
            if (page) {
                listContent.appendChild(page.renderSettingsNav(state));
            } else {
                listContent.appendChild(renderSettingsSummary(state));
            }
            return;
        }
        listTitle.textContent = 'Blueprint Skills';
        listContent.appendChild(renderSkillList(state));
    }

    function renderSkillList(state) {
        const wrap = node('div', 'cb-skill-list');
        skills.SKILLS.forEach(skill => {
            const card = node('button', `cb-skill-card${state.selectedSkillId === skill.id ? ' selected' : ''}`);
            card.type = 'button';
            card.dataset.cbAction = 'pick-skill';
            card.dataset.skillId = skill.id;
            const head = node('div', 'cb-skill-card-head');
            head.appendChild(icon(skill.icon));
            head.appendChild(node('strong', null, skill.name));
            card.appendChild(head);
            card.appendChild(node('p', 'cb-skill-tagline', skill.tagline));
            const badges = node('div', 'cb-skill-badges');
            if (skill.multiLens) badges.appendChild(node('span', 'cb-badge cb-badge-lens', '3 lenses'));
            if (skill.requiresSource) badges.appendChild(node('span', 'cb-badge cb-badge-source', 'needs source'));
            if (skill.requiresPrd) badges.appendChild(node('span', 'cb-badge cb-badge-prd', 'needs PRD'));
            if (badges.childElementCount) card.appendChild(badges);
            wrap.appendChild(card);
        });
        const note = node('p', 'cb-list-note');
        note.appendChild(icon('fa-circle-info'));
        note.appendChild(node('span', null, 'Pick a skill, describe your idea in the chat, and press Send. Blueprint runs every step visibly.'));
        wrap.appendChild(note);
        return wrap;
    }

    function buildTree(paths) {
        const root = { name: '', path: '', folders: new Map(), files: [] };
        paths.forEach(path => {
            const parts = path.split('/').filter(Boolean);
            const fileName = parts.pop();
            let current = root;
            let walked = [];
            parts.forEach(part => {
                walked = walked.concat([part]);
                if (!current.folders.has(part)) {
                    current.folders.set(part, { name: part, path: walked.join('/'), folders: new Map(), files: [] });
                }
                current = current.folders.get(part);
            });
            current.files.push({ name: fileName, path });
        });
        return root;
    }

    function renderTreeBranch(branch, state, depth, folderId) {
        const fragment = document.createDocumentFragment();
        const indent = Number(state.treeIndentPx) || 13;
        [...branch.folders.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(folder => {
                const qualifiedPath = folderPathKey(folderId, folder.path);
                const isOpen = state.expanded.has(qualifiedPath)
                    || state.expanded.has(folder.path); // legacy state, migrated by controller
                const row = node('div', 'cb-tree-row cb-tree-folder');
                row.style.paddingLeft = `${8 + depth * indent}px`;
                row.dataset.cbAction = 'toggle-folder';
                row.dataset.path = folder.path;
                row.dataset.folderId = folderId;
                row.setAttribute('role', 'treeitem');
                row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
                row.tabIndex = 0;
                row.appendChild(icon(isOpen ? 'fa-folder-open' : 'fa-folder'));
                row.appendChild(node('span', 'cb-tree-name', folder.name));
                fragment.appendChild(row);
                if (isOpen) fragment.appendChild(renderTreeBranch(folder, state, depth + 1, folderId));
            });
        branch.files
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(file => {
                const selected = state.openPath === file.path && state.openFolderId === folderId;
                const row = node('div', `cb-tree-row cb-tree-file${selected ? ' selected' : ''}`);
                row.style.paddingLeft = `${11 + depth * indent}px`;
                row.dataset.cbAction = 'open-file';
                row.dataset.path = file.path;
                row.dataset.folderId = folderId;
                row.setAttribute('role', 'treeitem');
                row.setAttribute('aria-selected', selected ? 'true' : 'false');
                row.tabIndex = 0;
                row.title = file.path;
                row.appendChild(icon(fileIconFor(file.name)));
                row.appendChild(node('span', 'cb-tree-name', file.name));
                if (state.showFileMeta !== false) {
                    const record = core.readFile(file.path, folderId);
                    if (record) {
                        row.appendChild(node('span', 'cb-tree-meta', `${(record.content.length / 1024).toFixed(1)} KB`));
                    }
                }
                fragment.appendChild(row);
            });
        return fragment;
    }

    /**
     * Key used in `state.collapsedRoots` for a PROJECT folder root. Roots are open
     * unless the user collapsed them — opening Project Files should show files, not
     * a list of folder names to click through first. Tracked in its own Set rather
     * than inverted inside `expanded`, so "expand all" and "collapse all" can both
     * be expressed without fighting a default.
     */
    function folderRootKey(folderId) {
        return `folder:${folderId}`;
    }

    /** Root-qualified directory identity for the multi-root explorer. */
    function folderPathKey(folderId, path) {
        return `path:${encodeURIComponent(String(folderId || ''))}:${encodeURIComponent(String(path || ''))}`;
    }

    /**
     * The Project Files sidebar, as a multi-root explorer.
     *
     * Every project folder is a root and every root lists all of its own
     * documents, so the whole project is visible at once. The ACTIVE folder is
     * where a new document lands; it is marked, but it does not filter the view.
     */
    function renderFileTree(state) {
        const wrap = node('div', 'cb-tree-wrap');

        const folders = state.folders || core.listFolders();
        const activeFolderId = state.activeFolderId || core.DEFAULT_FOLDER_ID;
        const counts = state.folderFileCounts || {};
        const expanded = state.expanded || new Set();
        // Roots are open unless explicitly collapsed; directories inside a root
        // still follow `expanded`, which defaults to closed.
        const collapsedRoots = state.collapsedRoots || new Set();
        const indent = Number(state.treeIndentPx) || 13;

        // ---- header ---------------------------------------------------
        const header = node('div', 'cb-tree-header');
        header.appendChild(node('strong', null, 'Project Files'));
        const tools = node('div', 'cb-tree-tools');
        tools.appendChild(iconButton('fa-folder-plus', 'new-folder', 'Create a new project folder'));
        tools.appendChild(iconButton('fa-folder-open', 'open-folder', 'Import a folder from disk'));
        tools.appendChild(iconButton('fa-file-circle-plus', 'add-source-file', 'Add a source file to the project'));
        tools.appendChild(iconButton('fa-layer-group', 'open-file-selector', 'File Selector & Multi-File Review Manager'));
        tools.appendChild(iconButton('fa-file-pen', 'new-file', 'Create a Markdown file'));
        tools.appendChild(iconButton('fa-angles-down', 'expand-all', 'Expand every folder'));
        tools.appendChild(iconButton('fa-angles-up', 'collapse-all', 'Collapse every folder'));
        header.appendChild(tools);
        wrap.appendChild(header);

        const totalFiles = core.listFiles().length;
        const summary = node('div', 'cb-tree-summary');
        summary.appendChild(node('span', null,
            `${folders.length} folder${folders.length === 1 ? '' : 's'} · ${totalFiles} file${totalFiles === 1 ? '' : 's'}`));
        const activeFolder = folders.find(folder => folder.id === activeFolderId) || null;
        if (activeFolder) {
            summary.appendChild(node('em', null, `new files go to ${activeFolder.name}`));
        }
        wrap.appendChild(summary);

        // ---- one root per project folder ------------------------------
        const tree = node('div', 'cb-tree cb-tree-multiroot');
        tree.setAttribute('role', 'tree');
        tree.setAttribute('aria-label', 'All project folders and files');

        folders.forEach(folder => {
            const isActive = folder.id === activeFolderId;
            // Open unless the user collapsed it, so the pane shows files on arrival.
            const isOpen = !collapsedRoots.has(folderRootKey(folder.id));
            const fileCount = counts[folder.id] !== undefined ? counts[folder.id] : core.folderFileCount(folder.id);

            const row = node('div', `cb-tree-row cb-tree-root${isActive ? ' active' : ''}${isOpen ? ' open' : ''}`);
            row.style.paddingLeft = '8px';
            row.dataset.cbAction = 'toggle-folder-root';
            row.dataset.folderId = folder.id;
            row.setAttribute('role', 'treeitem');
            row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            row.setAttribute('aria-selected', isActive ? 'true' : 'false');
            row.tabIndex = 0;
            row.title = `${folder.name} — ${fileCount} file(s)`
                + (isActive ? ' · new files are created here' : ' · click to expand or collapse')
                + (folder.origin === 'imported' ? ' · imported from disk' : '')
                + (folder.importState === 'incomplete'
                    ? ` · incomplete import${folder.importError ? `: ${folder.importError}` : ''}` : '');

            row.appendChild(icon(isOpen ? 'fa-folder-open' : 'fa-folder'));
            const nameWrap = node('span', 'cb-tree-name');
            nameWrap.appendChild(node('span', null, folder.name));
            if (isActive) nameWrap.appendChild(node('span', 'cb-root-badge', 'target'));
            if (folder.importState === 'incomplete') {
                nameWrap.appendChild(node('span', 'cb-root-badge cb-root-badge-warn', 'incomplete'));
            }
            row.appendChild(nameWrap);
            row.appendChild(node('span', 'cb-tree-meta', String(fileCount)));

            // Folder actions live on the root row. They are separate buttons with
            // their own data-cb-action, and findAction() resolves the closest
            // ancestor with an action — so clicking one of these never also toggles
            // the root.
            const rowTools = node('span', 'cb-tree-rowtools');
            if (!isActive) {
                rowTools.appendChild(iconButton('fa-bullseye', 'select-folder',
                    `Create new files in ${folder.name}`, { folderId: folder.id }));
            }
            if (folder.id !== core.DEFAULT_FOLDER_ID) {
                rowTools.appendChild(iconButton('fa-pen', 'rename-folder', `Rename ${folder.name}`, { folderId: folder.id }));
                rowTools.appendChild(iconButton('fa-trash', 'delete-folder', `Delete ${folder.name}`, { folderId: folder.id }));
            }
            if (rowTools.childElementCount) row.appendChild(rowTools);

            tree.appendChild(row);

            if (!isOpen) return;

            const paths = core.listFiles(folder.id);
            if (!paths.length) {
                const none = node('div', 'cb-tree-none');
                none.style.paddingLeft = `${8 + indent}px`;
                none.appendChild(node('span', null, 'No files in this folder yet.'));
                tree.appendChild(none);
                return;
            }
            // Nested one level under the root, so the hierarchy reads
            // project folder -> directory -> file.
            tree.appendChild(renderTreeBranch(buildTree(paths), state, 1, folder.id));
        });

        // A store with no folders at all cannot happen (the default folder is
        // always recreated on read), but render something rather than a blank pane.
        if (!folders.length) {
            const empty = node('div', 'cb-tree-empty');
            empty.appendChild(icon('fa-folder-open'));
            empty.appendChild(node('span', null, 'No project folders.'));
            tree.appendChild(empty);
        }
        wrap.appendChild(tree);

        // ---- attached source files ------------------------------------
        const source = state.sourceFiles || [];
        if (source.length) {
            const attached = node('div', 'cb-attached');
            attached.appendChild(node('span', 'cb-attached-label', `Attached for the model (${source.length})`));
            const list = node('ul');
            source.forEach(file => {
                const item = node('li');
                item.appendChild(icon('fa-paperclip'));
                item.appendChild(node('span', null, file.path));
                item.appendChild(node('em', null, `${Math.round(file.content.length / 1024)} KB`));
                item.appendChild(iconButton('fa-xmark', 'detach-source-file', `Detach ${file.path}`, {
                    path: file.path,
                    folderId: file.folderId || file.folder || state.activeFolderId || ''
                }));
                list.appendChild(item);
            });
            attached.appendChild(list);
            wrap.appendChild(attached);
        }
        return wrap;
    }

    function renderRunList(state) {
        const wrap = node('div', 'cb-run-list');
        const runs = state.runs || [];
        if (!runs.length) {
            const empty = node('div', 'cb-tree-empty');
            empty.appendChild(icon('fa-clock-rotate-left'));
            empty.appendChild(node('span', null, 'No runs yet.'));
            empty.appendChild(node('p', null, 'Every Blueprint run is kept here with its full step trace.'));
            wrap.appendChild(empty);
            return wrap;
        }
        runs.forEach(run => {
            const item = node('button', `cb-run-item${state.activeRunId === run.id ? ' selected' : ''}`);
            item.type = 'button';
            item.dataset.cbAction = 'open-run';
            item.dataset.runId = run.id;
            const head = node('div', 'cb-run-item-head');
            head.appendChild(icon(statusIcon(run.status)));
            head.appendChild(node('strong', null, run.title || run.skillName));
            item.appendChild(head);
            item.appendChild(node('span', 'cb-run-item-meta', `${run.skillName} · ${core.formatClock(run.createdAt)}`));
            if (run.projectName) item.appendChild(node('em', 'cb-run-item-project', run.projectName));
            if (run.writtenPaths && run.writtenPaths.length) {
                const paths = node('span', 'cb-run-item-paths');
                paths.appendChild(icon('fa-file-lines'));
                paths.appendChild(node('span', null, `${run.writtenPaths.length} written`));
                item.appendChild(paths);
            }
            wrap.appendChild(item);
        });
        return wrap;
    }

    function statusIcon(status) {
        if (status === 'done') return 'fa-circle-check';
        if (status === 'error' || status === 'blocked' || status === 'gaps') return 'fa-circle-exclamation';
        if (status === 'stopped' || status === 'interrupted') return 'fa-circle-stop';
        if (status === 'running') return 'fa-circle-notch fa-spin';
        return 'fa-circle-dot';
    }

    function renderSettingsSummary(state) {
        const settings = core.readSettings();
        const wrap = node('div', 'cb-settings-summary');
        const rows = [
            ['Lens concurrency', settings.concurrency === 'parallel' ? 'Parallel' : 'Sequential'],
            ['Clarifying questions', settings.askClarifyingQuestions ? 'On' : 'Off'],
            ['Auto-open documents', settings.autoOpenWrittenDocument ? 'On' : 'Off'],
            ['Lens tokens', String(settings.lensMaxOutputTokens)],
            ['Document tokens', String(settings.documentMaxOutputTokens)],
            ['Temperature', String(settings.temperature)]
        ];
        rows.forEach(([label, value]) => {
            const row = node('div', 'cb-summary-row');
            row.appendChild(node('span', null, label));
            row.appendChild(node('strong', null, value));
            wrap.appendChild(row);
        });
        const open = button('Open full settings', 'fa-sliders', 'go-settings-full', { primary: true });
        wrap.appendChild(open);
        void state;
        return wrap;
    }

    // ------------------------------------------------------------------
    // Step timeline — the visible Cursor-style agent trace
    // ------------------------------------------------------------------

    const STATUS_ICONS = {
        pending: 'fa-circle-dot',
        running: 'fa-circle-notch fa-spin',
        done: 'fa-circle-check',
        error: 'fa-circle-exclamation',
        blocked: 'fa-circle-exclamation',
        gaps: 'fa-circle-exclamation',
        stopped: 'fa-circle-stop',
        interrupted: 'fa-circle-stop',
        skipped: 'fa-circle-minus'
    };

    function renderStep(step) {
        const isRunning = step.status === 'running';
        const wrap = node('div', `cb-step cb-step-${step.status || 'pending'}${isRunning ? ' cb-step-active' : ''}`);
        wrap.dataset.stepId = step.id;
        wrap.dataset.cbStep = 'step';

        const head = node('button', 'cb-step-head');
        head.type = 'button';
        head.dataset.cbAction = 'toggle-step';
        head.dataset.stepId = step.id;
        head.setAttribute('aria-expanded', step.open ? 'true' : 'false');
        head.appendChild(icon(STATUS_ICONS[step.status] || STATUS_ICONS.pending));

        const titleWrap = node('div', 'cb-step-title');
        titleWrap.appendChild(node('strong', null, step.label));
        if (isRunning && step.substatus) {
            const substatusNode = node('span', 'cb-step-substatus');
            substatusNode.appendChild(icon('fa-arrow-right-long'));
            substatusNode.appendChild(node('span', null, step.substatus));
            titleWrap.appendChild(substatusNode);
        } else if (step.summary) {
            titleWrap.appendChild(node('span', 'cb-step-summary', step.summary));
        }
        head.appendChild(titleWrap);

        if (isRunning && step.tokensPerSec) {
            head.appendChild(node('span', 'cb-step-tps', `${step.tokensPerSec} tok/s`));
        }

        if (step.elapsedMs || isRunning) {
            head.appendChild(node('time', `cb-step-time${isRunning ? ' cb-step-time-live' : ''}`, `${((step.elapsedMs || 0) / 1000).toFixed(1)}s`));
        }

        if (isRunning) {
            head.appendChild(node('span', 'cb-step-pulse'));
        }

        head.appendChild(icon(step.open ? 'fa-chevron-up' : 'fa-chevron-down'));
        wrap.appendChild(head);

        if (!step.open) return wrap;

        const body = node('div', 'cb-step-body');

        // ---- Thinking Process Drawer (Anti-gravity reasoning trace) ----
        if (step.thinking || (isRunning && step.liveThinkingElement)) {
            const thinkingBox = node('details', 'cb-step-block cb-step-thinking');
            if (isRunning) thinkingBox.open = true;
            const thinkSummary = node('summary', 'cb-thinking-summary');
            thinkSummary.appendChild(icon('fa-brain', isRunning ? 'cb-brain-pulse' : ''));
            thinkSummary.appendChild(node('span', null, 'Thinking & Reasoning Trace'));
            const tokens = Math.round(((step.thinking && step.thinking.length) || 0) / 3.8);
            if (tokens > 0) {
                thinkSummary.appendChild(node('span', 'cb-step-flag', `${tokens} tokens`));
            }
            thinkingBox.appendChild(thinkSummary);

            if (isRunning && step.liveThinkingElement) {
                thinkingBox.appendChild(step.liveThinkingElement);
            } else {
                const thinkPre = node('pre', 'cb-pre cb-thinking-pre');
                thinkPre.appendChild(node('code', null, step.thinking || ''));
                thinkingBox.appendChild(thinkPre);
            }
            body.appendChild(thinkingBox);
        }

        if (step.kind === 'question') {
            if (step.section) {
                const secBadge = node('div', 'cb-step-section-badge', step.section);
                body.appendChild(secBadge);
            }
            body.appendChild(node('p', 'cb-step-question', step.question || ''));
            if (isRunning && !step.answered && step.options && step.options.length) {
                const options = node('div', 'cb-step-options');
                step.options.forEach(option => {
                    const chip = node('button', 'cb-chip cb-chip-primary');
                    chip.type = 'button';
                    chip.dataset.cbAction = 'answer-question';
                    chip.dataset.stepId = step.id;
                    chip.dataset.answer = option;
                    chip.textContent = option;
                    options.appendChild(chip);
                });
                body.appendChild(options);
            }
            if (isRunning && !step.answered) {
                const inlineBox = node('div', 'cb-step-inline-answer');
                const inlineInput = node('input', 'cb-input cb-step-inline-input');
                inlineInput.type = 'text';
                inlineInput.placeholder = 'Type your answer here…';
                inlineInput.value = step.answerDraft || '';
                inlineInput.dataset.cbRole = 'inline-answer-input';
                inlineInput.dataset.stepId = step.id;
                inlineBox.appendChild(inlineInput);

                const inlineBtn = node('button', 'cb-btn primary cb-step-inline-btn');
                inlineBtn.type = 'button';
                inlineBtn.dataset.cbAction = 'submit-inline-answer';
                inlineBtn.dataset.stepId = step.id;
                inlineBtn.appendChild(icon('fa-paper-plane'));
                inlineBtn.appendChild(node('span', null, 'Answer'));
                inlineBox.appendChild(inlineBtn);
                body.appendChild(inlineBox);
            }
            if (step.answered) {
                const answer = node('p', 'cb-step-answer');
                answer.appendChild(icon('fa-reply'));
                answer.appendChild(node('span', null, step.answered));
                body.appendChild(answer);
            }
        } else if (step.kind === 'lens' || step.kind === 'phase' || step.kind === 'document') {
            if (step.promptPreview) {
                const promptBox = node('details', 'cb-step-block');
                const summary = node('summary');
                summary.appendChild(icon('fa-terminal'));
                summary.appendChild(node('span', null, 'Prompt sent to the model'));
                promptBox.appendChild(summary);
                const pre = node('pre', 'cb-pre');
                pre.appendChild(node('code', null, step.promptPreview));
                promptBox.appendChild(pre);
                body.appendChild(promptBox);
            }
            const outputBox = node('div', 'cb-step-block');
            const outputHead = node('div', 'cb-step-block-head');
            outputHead.appendChild(icon('fa-align-left'));
            outputHead.appendChild(node('span', null, isRunning ? 'Model output (streaming…)' : 'Model output'));
            if (step.finishReason) outputHead.appendChild(node('span', 'cb-step-flag', `finish: ${step.finishReason}`));
            if (step.tokenCount) outputHead.appendChild(node('span', 'cb-step-flag', `${step.tokenCount} tokens`));
            outputBox.appendChild(outputHead);
            if ((step.streaming || isRunning) && step.liveElement) {
                outputBox.appendChild(step.liveElement);
                const cursor = node('span', 'cb-stream-cursor', '▋');
                outputBox.appendChild(cursor);
            } else if (step.text) {
                if (step._renderedMarkdown && typeof step._renderedMarkdown.cloneNode === 'function' && step._renderedMarkdownText === step.text) {
                    outputBox.appendChild(step._renderedMarkdown.cloneNode(true));
                } else {
                    const rendered = core.renderMarkdown(step.text);
                    if (step.status === 'done') {
                        step._renderedMarkdown = rendered;
                        step._renderedMarkdownText = step.text;
                    }
                    outputBox.appendChild(rendered);
                }
            } else {
                outputBox.appendChild(node('p', 'cb-muted', isRunning ? 'Waiting for the first token…' : 'No output.'));
            }
            body.appendChild(outputBox);
        } else if (step.text) {
            if (step._renderedMarkdown && typeof step._renderedMarkdown.cloneNode === 'function' && step._renderedMarkdownText === step.text) {
                body.appendChild(step._renderedMarkdown.cloneNode(true));
            } else {
                const rendered = core.renderMarkdown(step.text);
                if (step.status === 'done') {
                    step._renderedMarkdown = rendered;
                    step._renderedMarkdownText = step.text;
                }
                body.appendChild(rendered);
            }
        }

        if (step.error) {
            const errorBox = node('div', 'cb-step-errbox');
            errorBox.appendChild(icon('fa-triangle-exclamation'));
            errorBox.appendChild(node('span', null, step.error));
            body.appendChild(errorBox);

            if (step.label === 'Waiting for source' || (typeof step.error === 'string' && step.error.indexOf('No source attached') >= 0)) {
                const actionRow = node('div', 'cb-step-source-actions');
                const addFileBtn = node('button', 'cb-btn primary cb-step-action-btn');
                addFileBtn.type = 'button';
                addFileBtn.dataset.cbAction = 'add-source-file';
                addFileBtn.appendChild(icon('fa-file-circle-plus'));
                addFileBtn.appendChild(node('span', null, 'Add Source File'));
                actionRow.appendChild(addFileBtn);

                const importFolderBtn = node('button', 'cb-btn cb-step-action-btn');
                importFolderBtn.type = 'button';
                importFolderBtn.dataset.cbAction = 'open-folder';
                importFolderBtn.appendChild(icon('fa-folder-open'));
                importFolderBtn.appendChild(node('span', null, 'Import Folder'));
                actionRow.appendChild(importFolderBtn);

                const filesTabBtn = node('button', 'cb-btn cb-step-action-btn');
                filesTabBtn.type = 'button';
                filesTabBtn.dataset.cbAction = 'go-files';
                filesTabBtn.appendChild(icon('fa-folder-tree'));
                filesTabBtn.appendChild(node('span', null, 'Project Files'));
                actionRow.appendChild(filesTabBtn);

                body.appendChild(actionRow);
            }
            if (step.canRepair && step.runId && step.reviewPath) {
                const repairRow = node('div', 'cb-step-source-actions');
                const repairBtn = node('button', 'cb-btn primary cb-step-action-btn');
                repairBtn.type = 'button';
                repairBtn.dataset.cbAction = 'auto-repair-gaps';
                repairBtn.dataset.runId = step.runId;
                repairBtn.dataset.path = step.reviewPath;
                repairBtn.dataset.folderId = step.reviewFolderId || '';
                repairBtn.appendChild(icon('fa-wand-magic-sparkles'));
                repairBtn.appendChild(node('span', null, 'Repair Gaps'));
                repairRow.appendChild(repairBtn);
                body.appendChild(repairRow);
            }
        }

        wrap.appendChild(body);
        return wrap;
    }

    // ------------------------------------------------------------------
    // Transcript — the one big chat
    // ------------------------------------------------------------------

    function renderCompactionCard(message) {
        const compaction = message.compaction || {};
        const wrap = node('div', 'cb-msg cb-msg-compaction');
        wrap.dataset.messageId = message.id;

        const card = node('div', 'cb-compaction-card');
        card.setAttribute('role', 'region');
        card.setAttribute('aria-label', 'Context Compaction');

        const head = node('div', 'cb-compaction-head');
        const titleArea = node('div', 'cb-compaction-title');
        titleArea.appendChild(icon('fa-bolt-lightning'));
        titleArea.appendChild(node('strong', null, '⚡ Context Compacted (Anti-gravity Protocol)'));
        head.appendChild(titleArea);

        const metrics = node('div', 'cb-compaction-metrics');
        const reqCount = Array.isArray(compaction.userRequests) ? compaction.userRequests.length : 1;
        const savedPercent = compaction.savedPercent || 0;
        const origTokens = compaction.originalTokens || 0;
        const compTokens = compaction.compactedTokens || 0;

        const pillReq = node('span', 'cb-compaction-pill', `Preserved ${reqCount} user goal${reqCount === 1 ? '' : 's'}`);
        const pillSaved = node('span', 'cb-compaction-pill highlight', `${savedPercent}% reduction (${origTokens} → ${compTokens} tokens)`);
        metrics.appendChild(pillReq);
        metrics.appendChild(pillSaved);
        head.appendChild(metrics);

        card.appendChild(head);

        const details = node('details', 'cb-compaction-details');
        const summaryTag = node('summary', 'cb-compaction-summary-btn', 'View Anti-gravity Structured Summary');
        details.appendChild(summaryTag);

        const body = node('div', 'cb-compaction-body');
        if (compaction.summary) {
            body.appendChild(core.renderMarkdown(compaction.summary));
        } else if (message.text) {
            body.appendChild(core.renderMarkdown(message.text));
        }
        details.appendChild(body);
        card.appendChild(details);

        wrap.appendChild(card);
        return wrap;
    }

    function renderMessage(message) {
        if (message.role === 'compaction' || message.compaction) {
            return renderCompactionCard(message);
        }
        const wrap = node('div', `cb-msg cb-msg-${message.role}`);
        wrap.dataset.messageId = message.id;

        const head = node('div', 'cb-msg-head');
        head.appendChild(icon(message.role === 'user' ? 'fa-user' : 'fa-compass-drafting'));
        head.appendChild(node('strong', null, message.role === 'user' ? 'You' : 'Blueprint'));
        if (message.skillName) head.appendChild(node('span', 'cb-msg-skill', message.skillName));
        head.appendChild(node('time', null, core.formatClock(message.at)));
        wrap.appendChild(head);

        if (message.text) wrap.appendChild(core.renderMarkdown(message.text));

        if (Array.isArray(message.steps) && message.steps.length) {
            const timeline = node('div', 'cb-timeline');
            timeline.dataset.cbRole = 'timeline';
            timeline.setAttribute('role', 'list');
            timeline.setAttribute('aria-label', 'Agent steps');
            message.steps.forEach(step => {
                const stepNode = renderStep(step);
                stepNode.setAttribute('role', 'listitem');
                timeline.appendChild(stepNode);
            });
            wrap.appendChild(timeline);
        }

        if (message.paths && message.paths.length) {
            const written = node('div', 'cb-written');
            const writtenHeader = node('div', 'cb-written-header');
            writtenHeader.appendChild(icon('fa-box-archive'));
            writtenHeader.appendChild(node('span', 'cb-written-label', 'Written to project:'));
            written.appendChild(writtenHeader);

            const grid = node('div', 'cb-written-grid');
            const writtenFiles = Array.isArray(message.writtenFiles) && message.writtenFiles.length
                ? message.writtenFiles
                : message.paths.map(path => ({ path, folderId: message.folderId || '' }));
            writtenFiles.forEach(file => {
                const path = file.path;
                const card = node('div', 'cb-artifact-card');
                const fileHead = node('div', 'cb-artifact-head');
                fileHead.appendChild(icon(fileIconFor(path)));
                fileHead.appendChild(node('strong', 'cb-artifact-path', path));
                card.appendChild(fileHead);

                const chip = node('button', 'cb-path-chip cb-artifact-chip');
                chip.type = 'button';
                chip.dataset.cbAction = 'open-file';
                chip.dataset.path = path;
                chip.dataset.folderId = file.folderId || message.folderId || '';
                chip.appendChild(icon('fa-file-arrow-down'));
                chip.appendChild(node('span', null, path));
                card.appendChild(chip);

                grid.appendChild(card);
            });
            written.appendChild(grid);
            wrap.appendChild(written);
        }

        const actions = node('div', 'cb-msg-actions');
        if (message.role === 'assistant') {
            if (message.text) actions.appendChild(button('Copy', 'fa-copy', 'copy-message', { compact: true, dataset: { messageId: message.id } }));
            if ((message.canRetry || message.retryStarting) && !message.busy) {
                const retry = button(message.retryStarting ? 'Checking…' : 'Retry', 'fa-rotate-right', 'retry-message', {
                    compact: true,
                    dataset: { messageId: message.id }
                });
                retry.disabled = Boolean(message.retryStarting);
                actions.appendChild(retry);
            }
            actions.appendChild(button('Revise', 'fa-pen', 'revise-message', { compact: true, dataset: { messageId: message.id } }));
        }
        if (actions.childElementCount) wrap.appendChild(actions);
        return wrap;
    }

    // ------------------------------------------------------------------
    // Pipeline stepper — Anti-gravity progress tracking
    // ------------------------------------------------------------------

    function renderPipeline(pipeline) {
        if (!Array.isArray(pipeline) || !pipeline.length) return null;
        const bar = node('div', 'cb-pipeline');
        bar.setAttribute('role', 'region');
        bar.setAttribute('aria-label', 'Agent pipeline');
        pipeline.forEach((item, index) => {
            const isRunning = item.status === 'running';
            const isDone = item.status === 'done';
            const stepItem = node('div', `cb-pipeline-step cb-pipeline-${item.status || 'pending'}${isRunning ? ' active' : ''}`);
            const iconName = isDone
                ? 'fa-circle-check'
                : isRunning
                    ? 'fa-circle-notch fa-spin'
                    : (item.status === 'error' || item.status === 'blocked' || item.status === 'gaps')
                        ? 'fa-circle-exclamation'
                        : (item.status === 'stopped' || item.status === 'interrupted')
                            ? 'fa-circle-stop'
                            : item.status === 'skipped' ? 'fa-circle-minus' : 'fa-circle-dot';
            stepItem.appendChild(icon(iconName));
            stepItem.appendChild(node('span', 'cb-pipeline-label', item.label));
            bar.appendChild(stepItem);
            if (index < pipeline.length - 1) {
                const sep = node('span', 'cb-pipeline-sep');
                sep.appendChild(icon('fa-chevron-right'));
                bar.appendChild(sep);
            }
        });
        return bar;
    }

    // ------------------------------------------------------------------
    // Main pane
    // ------------------------------------------------------------------

    function renderAgentPage(state) {
        const wrap = node('div', 'cb-agent');

        const header = node('header', 'cb-agent-header');
        const title = node('div', 'cb-agent-title');
        title.appendChild(icon('fa-compass-drafting'));
        title.appendChild(node('h2', null, state.run && state.run.title ? state.run.title : 'Blueprint planning agent'));
        if (state.run) {
            title.appendChild(node('span', `cb-run-status cb-run-${state.run.status}`, state.run.status));
        }
        header.appendChild(title);

        const actions = node('div', 'cb-agent-header-actions');
        const skillLabel = node('div', 'cb-agent-skill');
        skillLabel.appendChild(icon(skills.getSkill(state.selectedSkillId)?.icon || 'fa-wand-magic-sparkles'));
        skillLabel.appendChild(node('span', null, skills.getSkill(state.selectedSkillId)?.name || 'No skill selected'));
        actions.appendChild(skillLabel);

        const historyBtn = node('button', `cb-icon-btn cb-header-icon-btn${state.isHistoryOpen ? ' active' : ''}`);
        historyBtn.type = 'button';
        historyBtn.dataset.cbAction = 'toggle-chat-history';
        historyBtn.title = 'Chat history';
        historyBtn.setAttribute('aria-label', 'Chat history');
        historyBtn.appendChild(icon('fa-clock-rotate-left'));
        actions.appendChild(historyBtn);

        const compactBtn = node('button', `cb-icon-btn cb-header-icon-btn${state.hasCompaction ? ' active' : ''}`);
        compactBtn.type = 'button';
        compactBtn.dataset.cbAction = 'compact-context';
        compactBtn.title = 'Compact Context (Anti-gravity Protocol)';
        compactBtn.setAttribute('aria-label', 'Compact Context');
        compactBtn.appendChild(icon('fa-bolt-lightning'));
        actions.appendChild(compactBtn);

        const clearBtn = node('button', 'cb-icon-btn cb-header-icon-btn');
        clearBtn.type = 'button';
        clearBtn.dataset.cbAction = 'clear-chat';
        clearBtn.title = 'Clear chat (New conversation)';
        clearBtn.setAttribute('aria-label', 'Clear chat');
        clearBtn.appendChild(icon('fa-broom'));
        actions.appendChild(clearBtn);

        header.appendChild(actions);
        wrap.appendChild(header);

        if (state.isHistoryOpen) {
            wrap.appendChild(renderChatHistoryFlyout(state));
        }

        if (state.run && Array.isArray(state.run.pipeline)) {
            const pipelineNode = renderPipeline(state.run.pipeline);
            if (pipelineNode) wrap.appendChild(pipelineNode);
        }

        const transcript = node('div', 'cb-transcript');
        transcript.dataset.cbRole = 'transcript';
        transcript.setAttribute('role', 'log');
        transcript.setAttribute('aria-live', 'polite');
        transcript.tabIndex = -1;

        if (!state.messages.length) {
            transcript.appendChild(renderWelcome(state));
        } else {
            state.messages.forEach(message => transcript.appendChild(renderMessage(message)));
        }
        wrap.appendChild(transcript);
        wrap.appendChild(renderComposer(state));
        return wrap;
    }

    function renderChatHistoryFlyout(state) {
        const flyout = node('div', 'cb-chat-history-popover');
        flyout.dataset.cbRole = 'chat-history-popover';
        flyout.setAttribute('role', 'dialog');
        flyout.setAttribute('aria-label', 'Chat history');

        const head = node('div', 'cb-chat-history-head');
        const headTitle = node('div', 'cb-chat-history-title');
        headTitle.appendChild(icon('fa-clock-rotate-left'));
        headTitle.appendChild(node('strong', null, 'Chat History'));
        head.appendChild(headTitle);

        const headActions = node('div', 'cb-chat-history-actions');
        const newChatBtn = node('button', 'cb-btn compact primary');
        newChatBtn.type = 'button';
        newChatBtn.dataset.cbAction = 'clear-chat';
        newChatBtn.appendChild(icon('fa-plus'));
        newChatBtn.appendChild(node('span', null, 'New Chat'));
        headActions.appendChild(newChatBtn);

        const closeBtn = node('button', 'cb-icon-btn cb-header-icon-btn');
        closeBtn.type = 'button';
        closeBtn.dataset.cbAction = 'toggle-chat-history';
        closeBtn.title = 'Close history';
        closeBtn.setAttribute('aria-label', 'Close history');
        closeBtn.appendChild(icon('fa-xmark'));
        headActions.appendChild(closeBtn);
        head.appendChild(headActions);
        flyout.appendChild(head);

        const list = node('div', 'cb-chat-history-list');
        const runs = state.runs || [];
        if (!runs.length) {
            const empty = node('div', 'cb-chat-history-empty');
            empty.appendChild(icon('fa-clock-rotate-left'));
            empty.appendChild(node('p', null, 'No chat history yet.'));
            empty.appendChild(node('span', 'cb-muted', 'Finished runs and conversations will be saved here.'));
            list.appendChild(empty);
        } else {
            runs.forEach(run => {
                const isActive = run.id === state.activeRunId;
                const item = node('div', `cb-chat-history-item${isActive ? ' active' : ''}`);
                item.dataset.cbAction = 'open-chat-run';
                item.dataset.runId = run.id;
                item.setAttribute('role', 'button');
                item.tabIndex = 0;

                const itemIcon = node('div', 'cb-chat-history-item-icon');
                const skill = skills.getSkill(run.skillId);
                itemIcon.appendChild(icon(skill?.icon || 'fa-robot'));
                item.appendChild(itemIcon);

                const itemContent = node('div', 'cb-chat-history-item-content');
                const titleLine = node('div', 'cb-chat-history-item-title');
                const titleText = run.title || run.skillName || 'Untitled Chat';
                titleLine.appendChild(node('strong', null, titleText));
                if (isActive) {
                    titleLine.appendChild(node('span', 'cb-badge cb-badge-primary', 'Active'));
                }
                itemContent.appendChild(titleLine);

                if (run.idea) {
                    itemContent.appendChild(node('p', 'cb-chat-history-item-idea', run.idea));
                }

                const meta = node('div', 'cb-chat-history-item-meta');
                meta.appendChild(node('span', null, core.formatClock(run.createdAt)));
                if (run.status) {
                    meta.appendChild(node('span', `cb-run-status cb-run-${run.status}`, run.status));
                }
                if (run.writtenPaths && run.writtenPaths.length) {
                    meta.appendChild(node('span', 'cb-muted', `${run.writtenPaths.length} doc${run.writtenPaths.length > 1 ? 's' : ''}`));
                }
                itemContent.appendChild(meta);
                item.appendChild(itemContent);

                const delBtn = node('button', 'cb-icon-btn cb-chat-history-delete-btn');
                delBtn.type = 'button';
                delBtn.dataset.cbAction = 'delete-history-run';
                delBtn.dataset.runId = run.id;
                delBtn.title = 'Delete from history';
                delBtn.setAttribute('aria-label', 'Delete from history');
                delBtn.appendChild(icon('fa-trash-can'));
                item.appendChild(delBtn);

                list.appendChild(item);
            });
        }
        flyout.appendChild(list);

        const foot = node('div', 'cb-chat-history-foot');
        if (runs.length) {
            const clearAllBtn = node('button', 'cb-btn compact danger');
            clearAllBtn.type = 'button';
            clearAllBtn.dataset.cbAction = 'clear-all-history';
            clearAllBtn.appendChild(icon('fa-trash-can'));
            clearAllBtn.appendChild(node('span', null, 'Clear All History'));
            foot.appendChild(clearAllBtn);
        }
        const openRunsTabBtn = node('button', 'cb-btn compact');
        openRunsTabBtn.type = 'button';
        openRunsTabBtn.dataset.cbAction = 'open-runs-tab';
        openRunsTabBtn.appendChild(icon('fa-arrow-up-right-from-square'));
        openRunsTabBtn.appendChild(node('span', null, 'Open Runs Tab'));
        foot.appendChild(openRunsTabBtn);

        flyout.appendChild(foot);
        return flyout;
    }

    function renderWelcome(state) {
        const empty = node('div', 'cb-welcome');
        empty.appendChild(icon('fa-compass-drafting'));
        empty.appendChild(node('h3', null, 'One big planning chat'));
        empty.appendChild(node('p', null, 'Describe the product you are building. Blueprint runs the Codalio skills as visible steps — clarifying questions, three independent lenses, then one synthesized document — and writes the results into the project file tree.'));

        const picker = node('div', 'cb-welcome-skills');
        skills.SKILLS.forEach(skill => {
            const card = node('button', `cb-skill-card${state.selectedSkillId === skill.id ? ' selected' : ''}`);
            card.type = 'button';
            card.dataset.cbAction = 'pick-skill';
            card.dataset.skillId = skill.id;
            const head = node('div', 'cb-skill-card-head');
            head.appendChild(icon(skill.icon));
            head.appendChild(node('strong', null, skill.name));
            card.appendChild(head);
            card.appendChild(node('p', 'cb-skill-tagline', skill.tagline));
            picker.appendChild(card);
        });
        empty.appendChild(picker);

        const example = node('div', 'cb-welcome-example');
        example.appendChild(node('span', null, 'Try:'));
        const chip = node('button', 'cb-chip');
        chip.type = 'button';
        chip.dataset.cbAction = 'use-example';
        chip.textContent = 'I want to build an app for neighbors to lend and borrow tools instead of everyone buying their own.';
        example.appendChild(chip);
        empty.appendChild(example);
        return empty;
    }

    function renderComposer(state) {
        const composer = node('div', 'cb-composer');

        if (!state.busy && !state.busyImport && !state.cancellationCheckBusy && !state.pendingQuestion) {
            const quickBar = node('div', 'cb-quick-bar');

            // --- Group 1: Skills ---
            const skillsGroup = node('div', 'cb-quick-group cb-quick-skills');
            const quickLabel = node('span', 'cb-quick-label');
            quickLabel.appendChild(icon('fa-bolt'));
            quickLabel.appendChild(node('span', null, 'Skills:'));
            skillsGroup.appendChild(quickLabel);

            const quickSkills = [
                { id: 'prd-builder', label: '/prd', title: 'PRD Builder' },
                { id: 'mvp-checklist', label: '/mvp', title: 'MVP Scope' },
                { id: 'gtm-plan', label: '/gtm', title: 'GTM Strategy' },
                { id: 'arch-evaluation', label: '/arch', title: 'Architecture Evaluation' },
                { id: 'doc-generation', label: '/docs', title: 'Doc Generation' },
                { id: 'code-to-prd', label: '/code2prd', title: 'Code to PRD' }
            ];
            quickSkills.forEach(item => {
                const chip = node('button', `cb-quick-chip${state.selectedSkillId === item.id ? ' active' : ''}`);
                chip.type = 'button';
                chip.dataset.cbAction = 'pick-skill';
                chip.dataset.skillId = item.id;
                chip.title = item.title;
                chip.textContent = item.label;
                skillsGroup.appendChild(chip);
            });

            const compactChip = node('button', `cb-quick-chip-compact${state.hasCompaction ? ' active' : ''}`);
            compactChip.type = 'button';
            compactChip.dataset.cbAction = 'compact-context';
            compactChip.title = 'Compact Context (Anti-gravity Protocol)';
            compactChip.textContent = '/compact';
            skillsGroup.appendChild(compactChip);

            quickBar.appendChild(skillsGroup);

            // Divider
            quickBar.appendChild(node('span', 'cb-quick-divider'));

            // --- Group 2: Direct Folder Access ---
            const folderGroup = node('div', 'cb-quick-group cb-quick-folders');
            const folderLabel = node('span', 'cb-quick-label');
            folderLabel.appendChild(icon('fa-folder'));
            folderLabel.appendChild(node('span', null, 'Folder:'));
            folderGroup.appendChild(folderLabel);

            const folderSelect = node('select', 'cb-composer-select');
            folderSelect.dataset.cbRole = 'composer-folder-select';
            folderSelect.title = 'Active project folder — select to switch, create, or import';

            const folders = Array.isArray(state.folders) ? state.folders : [];
            folders.forEach(f => {
                const opt = node('option');
                opt.value = f.id;
                const count = state.folderFileCounts && typeof state.folderFileCounts[f.id] === 'number'
                    ? state.folderFileCounts[f.id]
                    : (core && typeof core.folderFileCount === 'function' ? core.folderFileCount(f.id) : 0);
                opt.textContent = `📁 ${f.name} (${count} file${count === 1 ? '' : 's'})`;
                if (f.id === state.activeFolderId) {
                    opt.selected = true;
                    folderSelect.value = f.id;
                }
                folderSelect.appendChild(opt);
            });

            const sepOpt = node('option');
            sepOpt.disabled = true;
            sepOpt.textContent = '──────────';
            folderSelect.appendChild(sepOpt);

            const newFolderOpt = node('option');
            newFolderOpt.value = '__new__';
            newFolderOpt.textContent = '➕ New Folder…';
            folderSelect.appendChild(newFolderOpt);

            const importFolderOpt = node('option');
            importFolderOpt.value = '__import__';
            importFolderOpt.textContent = '📂 Import Folder from Disk…';
            folderSelect.appendChild(importFolderOpt);

            folderGroup.appendChild(folderSelect);

            const importBtn = node('button', 'cb-quick-action-btn');
            importBtn.type = 'button';
            importBtn.dataset.cbAction = 'open-folder';
            importBtn.title = 'Import a folder of source files from disk';
            importBtn.appendChild(icon('fa-folder-open'));
            importBtn.appendChild(node('span', null, 'Import'));
            folderGroup.appendChild(importBtn);

            quickBar.appendChild(folderGroup);

            // Divider
            quickBar.appendChild(node('span', 'cb-quick-divider'));

            // --- Group 3: Project Files Selector ---
            const filesGroup = node('div', 'cb-quick-group cb-quick-files');
            const filesLabel = node('span', 'cb-quick-label');
            filesLabel.appendChild(icon('fa-file-code'));
            filesLabel.appendChild(node('span', null, 'Files:'));
            filesGroup.appendChild(filesLabel);

            const fileSelect = node('select', 'cb-composer-select');
            fileSelect.dataset.cbRole = 'composer-file-select';
            fileSelect.title = 'Attach a file from Project Files to prompt context';

            const defaultFileOpt = node('option');
            defaultFileOpt.value = '';
            defaultFileOpt.disabled = true;
            defaultFileOpt.selected = true;
            defaultFileOpt.textContent = 'Attach file from project…';
            fileSelect.appendChild(defaultFileOpt);

            const allFiles = (core && typeof core.listFiles === 'function')
                ? core.listFiles(state.activeFolderId) : (state.projectFiles || []);
            const attachedFiles = Array.isArray(state.sourceFiles) ? state.sourceFiles : [];

            if (!allFiles.length) {
                const noFilesOpt = node('option');
                noFilesOpt.value = '';
                noFilesOpt.disabled = true;
                noFilesOpt.textContent = '(No files in project yet)';
                fileSelect.appendChild(noFilesOpt);
            } else {
                allFiles.forEach(filePath => {
                    const opt = node('option');
                    opt.value = filePath;
                    const isAttached = attachedFiles.some(f => f.path === filePath);
                    const rec = core && typeof core.readFile === 'function'
                        ? core.readFile(filePath, state.activeFolderId) : null;
                    const sizeStr = rec && typeof rec.bytes === 'number' ? ` (${Math.round(rec.bytes / 1024)} KB)` : '';
                    opt.textContent = `${isAttached ? '✓ ' : '📄 '}${filePath}${sizeStr}`;
                    fileSelect.appendChild(opt);
                });
            }

            const fileSepOpt = node('option');
            fileSepOpt.disabled = true;
            fileSepOpt.textContent = '──────────';
            fileSelect.appendChild(fileSepOpt);

            const uploadOpt = node('option');
            uploadOpt.value = '__add__';
            uploadOpt.textContent = '➕ Upload Source File from Disk…';
            fileSelect.appendChild(uploadOpt);

            filesGroup.appendChild(fileSelect);

            const addFileBtn = node('button', 'cb-quick-action-btn');
            addFileBtn.type = 'button';
            addFileBtn.dataset.cbAction = 'add-source-file';
            addFileBtn.title = 'Upload or paste a source file to attach to context';
            addFileBtn.appendChild(icon('fa-file-circle-plus'));
            addFileBtn.appendChild(node('span', null, 'Add File'));
            filesGroup.appendChild(addFileBtn);

            const selectFilesBtn = node('button', 'cb-quick-action-btn');
            selectFilesBtn.type = 'button';
            selectFilesBtn.dataset.cbAction = 'open-file-selector';
            selectFilesBtn.title = 'Open File Selector & Review Manager';
            selectFilesBtn.appendChild(icon('fa-layer-group'));
            selectFilesBtn.appendChild(node('span', null, 'Select Files…'));
            filesGroup.appendChild(selectFilesBtn);

            const browseBtn = node('button', 'cb-quick-action-btn');
            browseBtn.type = 'button';
            browseBtn.dataset.cbAction = 'go-files';
            browseBtn.title = 'Jump to Project Files tab to browse and inspect documents';
            browseBtn.appendChild(icon('fa-folder-tree'));
            browseBtn.appendChild(node('span', null, 'Files Tab'));
            filesGroup.appendChild(browseBtn);

            quickBar.appendChild(filesGroup);

            composer.appendChild(quickBar);
        }

        // --- Attached Files Bar (rendered whenever 1+ files are attached to prompt context) ---
        if (Array.isArray(state.sourceFiles) && state.sourceFiles.length > 0) {
            const attachedBar = node('div', 'cb-composer-attached');
            const attachedLabel = node('span', 'cb-attached-label');
            attachedLabel.appendChild(icon('fa-paperclip'));
            attachedLabel.appendChild(node('span', null, `Attached (${state.sourceFiles.length}):`));
            attachedBar.appendChild(attachedLabel);

            const isExclusive = state.sourceFileMode === 'exclusive';
            const modeBadge = node('button', 'cb-attached-mode-badge');
            modeBadge.type = 'button';
            modeBadge.dataset.cbAction = 'toggle-attached-mode';
            modeBadge.title = 'Click to switch review strategy between Augmented and Independent';
            modeBadge.appendChild(icon(isExclusive ? 'fa-filter' : 'fa-layer-group'));
            modeBadge.appendChild(node('span', null, isExclusive ? 'Mode: Independent (Manual only)' : 'Mode: On top of Agent files'));
            attachedBar.appendChild(modeBadge);

            const manageBtn = node('button', 'cb-attached-manage-btn');
            manageBtn.type = 'button';
            manageBtn.dataset.cbAction = 'open-file-selector';
            manageBtn.title = 'Open File Selector Overlay to add or modify files';
            manageBtn.appendChild(icon('fa-pen-to-square'));
            manageBtn.appendChild(node('span', null, 'Manage'));
            attachedBar.appendChild(manageBtn);

            const chipList = node('div', 'cb-attached-list');
            state.sourceFiles.forEach(file => {
                const chip = node('div', 'cb-attached-chip');
                const len = file.content ? file.content.length : 0;
                chip.title = `${file.path} (${Math.round(len / 1024)} KB)`;
                chip.appendChild(icon('fa-file-lines'));
                chip.appendChild(node('span', 'cb-attached-name', file.path));
                chip.appendChild(node('span', 'cb-attached-size', ` (${Math.round(len / 1024)} KB)`));

                const removeBtn = node('button', 'cb-attached-remove');
                removeBtn.type = 'button';
                removeBtn.title = `Detach ${file.path} from context`;
                removeBtn.dataset.cbAction = 'detach-source-file';
                removeBtn.dataset.path = file.path;
                removeBtn.dataset.folderId = file.folderId || file.folder || state.activeFolderId || '';
                removeBtn.appendChild(icon('fa-xmark'));
                chip.appendChild(removeBtn);

                chipList.appendChild(chip);
            });
            attachedBar.appendChild(chipList);

            const clearBtn = node('button', 'cb-attached-clear');
            clearBtn.type = 'button';
            clearBtn.dataset.cbAction = 'clear-attached-files';
            clearBtn.title = 'Detach all files from prompt context';
            clearBtn.textContent = 'Detach all';
            attachedBar.appendChild(clearBtn);

            composer.appendChild(attachedBar);
        }

        const isAwaitingAnswer = Boolean(state.pendingQuestion);
        const isSubmittingAnswer = Boolean(state.pendingQuestion && state.pendingQuestion.submitting);
        const isEffectivelyBusy = Boolean(
            (state.busy && !isAwaitingAnswer)
            || isSubmittingAnswer
            || state.busyImport
            || state.cancellationCheckBusy
            || state.recoveryPersistenceBlocked
        );

        if (state.pendingQuestion) {
            const bar = node('div', 'cb-composer-question');
            bar.appendChild(icon('fa-circle-question'));
            const textWrap = node('div', 'cb-composer-question-text');
            textWrap.appendChild(node('strong', null, 'Clarifying question: '));
            if (state.pendingQuestion.section) {
                const secTag = node('span', 'cb-composer-question-section', `[${state.pendingQuestion.section}] `);
                textWrap.appendChild(secTag);
            }
            textWrap.appendChild(node('span', null, state.pendingQuestion.question));
            bar.appendChild(textWrap);

            if (Array.isArray(state.pendingQuestion.options) && state.pendingQuestion.options.length) {
                const optGroup = node('div', 'cb-composer-question-options');
                state.pendingQuestion.options.forEach(opt => {
                    const optBtn = node('button', 'cb-chip cb-chip-primary');
                    optBtn.type = 'button';
                    optBtn.dataset.cbAction = 'answer-question';
                    optBtn.dataset.stepId = state.pendingQuestion.stepId || '';
                    optBtn.dataset.answer = opt;
                    optBtn.textContent = opt;
                    if (isSubmittingAnswer) optBtn.disabled = true;
                    optGroup.appendChild(optBtn);
                });
                bar.appendChild(optGroup);
            }
            composer.appendChild(bar);
        }

        const textarea = node('textarea', 'cb-composer-input');
        textarea.dataset.cbRole = 'composer';
        textarea.rows = 3;
        if (Number.isFinite(Number(state.maxUserRequestChars))) {
            textarea.maxLength = Number(state.maxUserRequestChars);
        }
        textarea.value = state.draft || '';
        textarea.placeholder = isSubmittingAnswer
            ? 'Saving your answer…'
            : isAwaitingAnswer
            ? 'Type your answer to the question above… Enter sends · Shift+Enter adds a line.'
            : isEffectivelyBusy
                ? 'A step is running — press Stop to interrupt safely.'
                : 'Describe your product idea, or tell Blueprint what to revise. Enter sends · Shift+Enter adds a line.';
        if (isEffectivelyBusy) textarea.disabled = true;
        composer.appendChild(textarea);

        const bar = node('div', 'cb-composer-bar');
        const hint = node('span', 'cb-composer-hint');
        hint.appendChild(icon(isAwaitingAnswer ? 'fa-pen-to-square' : isEffectivelyBusy ? 'fa-circle-notch fa-spin' : 'fa-circle-info'));
        hint.appendChild(node('span', null, isSubmittingAnswer
            ? 'Saving your answer before the agent continues…'
            : isAwaitingAnswer ? 'Agent paused · Awaiting your response to proceed with the plan.' : (state.hint || 'Runs on your active SimpleRAG model endpoint. Nothing is written to your workspace.')));
        bar.appendChild(hint);

        const right = node('div', 'cb-composer-right');
        if (state.busy || state.busyImport) {
            right.appendChild(button(state.busyImport ? 'Cancel import' : 'Stop', 'fa-stop', 'stop-run', {
                danger: true,
                title: state.busyImport ? 'Cancel the import and remove partial files' : 'Stop the current step safely'
            }));
        }
        const send = node('button', `cb-btn primary cb-send${isAwaitingAnswer ? ' cb-send-answer' : ''}`);
        send.type = 'button';
        send.dataset.cbAction = 'send';
        send.appendChild(icon(isAwaitingAnswer ? 'fa-paper-plane' : isEffectivelyBusy ? 'fa-circle-notch fa-spin' : 'fa-paper-plane'));
        send.appendChild(node('span', null, isSubmittingAnswer ? 'Saving…' : isAwaitingAnswer ? 'Send Answer' : isEffectivelyBusy ? 'Running…' : 'Send'));
        if (isEffectivelyBusy) send.disabled = true;
        right.appendChild(send);
        bar.appendChild(right);
        composer.appendChild(bar);

        composer.appendChild(renderPathContextBar(state, isEffectivelyBusy));
        return composer;
    }

    /**
     * Path context bar: one folder pick, one path field, one toggle.
     *
     * Sits BENEATH the send row because the top of the composer already carries
     * the folder select, file select and attachment chips. It reads a named
     * subdirectory live at run time, so it is the escape hatch from the 2 MB
     * workspace cap that keeps a large project's real source out of reach.
     */
    function renderPathContextBar(state, disabled) {
        const bar = node('div', `cb-path-context${state.pathContextEnabled ? ' cb-path-context-on' : ''}`);
        const enabled = state.pathContextEnabled === true;
        const hasGrant = Boolean(state.pathContextHasGrant);
        const busy = Boolean(state.pathContextBusy) || Boolean(disabled);

        // The toggle is the primary control and stays visible at all times.
        const toggle = node('button', `cb-path-toggle${enabled ? ' on' : ''}`);
        toggle.type = 'button';
        toggle.dataset.cbAction = 'toggle-path-context';
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
        toggle.title = enabled
            ? 'Path context ON — the named folder is read live when a code-reading skill runs'
            : 'Path context OFF — runs use only the imported project files';
        if (busy) toggle.disabled = true;
        const knob = node('span', 'cb-path-toggle-knob');
        knob.appendChild(icon(enabled ? 'fa-folder-open' : 'fa-folder'));
        toggle.appendChild(knob);
        toggle.appendChild(node('span', 'cb-path-toggle-label', enabled ? 'On' : 'Off'));
        bar.appendChild(toggle);

        const label = node('span', 'cb-path-context-label');
        label.appendChild(icon('fa-diagram-project'));
        label.appendChild(node('span', null, 'Folder path'));
        bar.appendChild(label);

        // The draft wins over the saved value while typing so the field never
        // fights the user mid-word (commit happens on blur/Enter).
        const value = state.pathContextDraft !== null && state.pathContextDraft !== undefined
            ? state.pathContextDraft
            : String(state.pathContextPath || '');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'cb-path-context-input';
        input.dataset.cbRole = 'path-context-input';
        input.value = value;
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.placeholder = hasGrant
            ? 'TrainingModel  ·  or GUI/ai_agents'
            : 'TrainingModel  ·  pick a folder first';
        input.title = 'A folder inside the granted project. Type it relative to the root '
            + '(TrainingModel), or paste a full path — the matching root prefix is ignored.';
        if (busy) input.disabled = true;
        bar.appendChild(input);

        // Reuse the folder-import grant when there is one; otherwise offer a
        // pick. A browser cannot open a typed path without a granted handle, so
        // this button is what makes the field meaningful.
        const pickLabel = hasGrant
            ? (state.pathContextRootName || 'Folder')
            : 'Pick folder';
        const pick = button(pickLabel, hasGrant ? 'fa-folder-check' : 'fa-folder-plus',
            'pick-path-context-root', {
                compact: true,
                title: hasGrant
                    ? `Reading paths inside "${state.pathContextRootName}". Pick again to change it.`
                    : 'Grant Blueprint read access to the project folder the path is inside',
                disabled: busy
            });
        bar.appendChild(pick);

        const check = button('Check', 'fa-circle-question', 'recheck-path-context', {
            compact: true,
            title: 'Resolve the path now and report whether that folder exists',
            disabled: busy || !hasGrant || !value.trim()
        });
        bar.appendChild(check);

        // One-line status so the state is never a guess: whether the grant is
        // present, and what the caps will be. A lost grant after a reload is
        // called out explicitly rather than reading as "off".
        const status = node('span', 'cb-path-context-status');
        const settings = state.settings || {};
        if (enabled && hasGrant && value.trim()) {
            status.appendChild(icon('fa-circle-check'));
            status.appendChild(node('span', null,
                `${state.pathContextRootName}/… · up to ${Number(settings.pathContextMaxFiles || 400).toLocaleString()} files`));
        } else if (enabled && !hasGrant) {
            status.appendChild(icon('fa-triangle-exclamation'));
            status.appendChild(node('span', null, 'Needs folder access — pick the project folder'));
        } else if (enabled && !value.trim()) {
            status.appendChild(icon('fa-circle-info'));
            status.appendChild(node('span', null, 'Type a folder to read'));
        } else {
            status.appendChild(node('span', null, 'Off · imported files only'));
        }
        bar.appendChild(status);

        return bar;
    }

    function renderFilesPage(state) {
        const record = state.openPath ? core.readFile(state.openPath, state.openFolderId) : null;
        if (!record) {
            const wrap = node('div', 'cb-viewer');
            const empty = node('div', 'cb-viewer-empty');
            empty.appendChild(icon('fa-folder-tree'));
            empty.appendChild(node('h3', null, 'Project files'));
            empty.appendChild(node('p', null, 'Pick a file in the list to read it. Blueprint writes each generated document here under docs/, and you can add your own source files for the code-reading skills.'));
            const actions = node('div', 'cb-viewer-empty-actions');
            actions.appendChild(button('Add source file', 'fa-file-circle-plus', 'add-source-file', { primary: true }));
            actions.appendChild(button('New Markdown', 'fa-file-pen', 'new-file'));
            empty.appendChild(actions);
            wrap.appendChild(empty);
            return wrap;
        }
        return renderViewer(state, record);
    }

    /** preview.js loads before ui.js; resolved lazily so order cannot break the page. */
    const previewModule = () => window.__codalioBlueprintPreview;

    /**
     * Label and icon for the viewer mode toggle, phrased for the file being read.
     *
     * Offering "Markdown" on a .py file is misleading — rendering Python through
     * the Markdown parser turns `#` comments into headings. For code the button
     * says "Code" and for documents it says "Markdown", while the action stays the
     * same either way.
     */
    function viewerToggleAffordance(state, path) {
        const inSource = state.viewerMode === 'source';
        const preview = previewModule();
        // languageFor() returns { key, info }, and the display name lives on info.
        const language = preview ? preview.languageFor(path) : { key: 'text', info: { label: 'Plain text' } };
        const isDocument = language.key === 'markdown' || language.key === 'text';
        const languageLabel = (language.info && language.info.label) || 'language';
        return {
            label: inSource ? 'Preview' : (isDocument ? 'Markdown' : 'Code'),
            iconName: inSource ? 'fa-eye' : (isDocument ? 'fa-code' : 'fa-file-code'),
            title: inSource
                ? 'Render this document'
                : (isDocument
                    ? 'Show the raw Markdown'
                    : `Show this file with line numbers and ${languageLabel} colouring`)
        };
    }

    function renderViewer(state, record) {
        const viewer = node('div', 'cb-viewer');

        const bar = node('div', 'cb-viewer-bar');
        const isImported = record.origin === 'imported';
        const pathWrap = node('div', 'cb-viewer-path');
        pathWrap.appendChild(icon(fileIconFor(record.path)));
        pathWrap.appendChild(node('span', null, record.path));
        if (isImported) {
            const badge = node('span', 'cb-chip cb-chip-muted cb-viewer-badge');
            badge.title = 'Project source file — Read-only to Blueprint';
            badge.appendChild(icon('fa-lock'));
            badge.appendChild(node('span', null, 'Read-Only Source'));
            pathWrap.appendChild(badge);
        } else {
            const badge = node('span', 'cb-chip cb-chip-primary cb-viewer-badge');
            badge.title = 'Created by Blueprint — Editable & rewritable';
            badge.appendChild(icon('fa-pen-nib'));
            badge.appendChild(node('span', null, 'Blueprint Document'));
            pathWrap.appendChild(badge);
        }
        bar.appendChild(pathWrap);

        const tools = node('div', 'cb-viewer-tools');
        tools.appendChild(node('span', 'cb-viewer-meta', `${record.content.length.toLocaleString()} chars · ${record.content.split('\n').length} lines · ${core.formatClock(record.updatedAt)}`));
        const toggle = viewerToggleAffordance(state, record.path);
        tools.appendChild(button(toggle.label, toggle.iconName, 'viewer-toggle', {
            compact: true,
            title: toggle.title,
            dataset: { path: record.path, folderId: record.folder || '' }
        }));
        // Edit/Save/Cancel (Gemini) with folderId on every dataset (Sol).
        // Both are required: the edit affordance does not exist without
        // Gemini's buttons, and multi-root support breaks without Sol's
        // folderId — the controller resolves an edit against the wrong
        // project root when two roots hold the same relative path.
        const isEditing = state.editingPath === record.path;
        if (isEditing) {
            tools.appendChild(button('Save', 'fa-floppy-disk', 'save-file', {
                compact: true,
                primary: true,
                title: 'Save changes to this file (Ctrl+S)',
                dataset: { path: record.path, folderId: record.folder || '' }
            }));
            tools.appendChild(button('Cancel', 'fa-xmark', 'cancel-edit-file', {
                compact: true,
                title: 'Discard edits',
                dataset: { path: record.path, folderId: record.folder || '' }
            }));
        } else {
            tools.appendChild(button('Edit', 'fa-pen-to-square', 'edit-file', {
                compact: true,
                title: 'Edit this file',
                dataset: { path: record.path, folderId: record.folder || '' }
            }));
        }
        tools.appendChild(button('Copy', 'fa-copy', 'copy-file', { compact: true, dataset: { path: record.path, folderId: record.folder || '' } }));
        tools.appendChild(button('Download', 'fa-download', 'download-file', { compact: true, dataset: { path: record.path, folderId: record.folder || '' } }));
        tools.appendChild(button('Rename', 'fa-pen', 'rename-file', { compact: true, dataset: { path: record.path, folderId: record.folder || '' } }));
        tools.appendChild(button('Delete', 'fa-trash', 'delete-file', { compact: true, danger: true, dataset: { path: record.path, folderId: record.folder || '' } }));
        bar.appendChild(tools);
        viewer.appendChild(bar);

        const body = node('div', 'cb-viewer-body');
        const settings = core.readSettings();
        // Reading width applies to both modes: rendered prose wants a comfortable
        // measure, and the code view honours it so lines do not run to the edge.
        body.classList.add(`cb-reading-${settings.readingWidth || 'wide'}`);

        const preview = previewModule();
        if (state.viewerMode === 'source' || isEditing) {
            if (preview) {
                // The Notepad++-style view: line-number gutter, syntax colouring,
                // and an Ln / Col status bar. Layout idea from Notepad++; the code
                // is this plug-in's own (see preview.js).
                body.appendChild(preview.renderPreview(record, {
                    highlight: settings.syntaxHighlighting !== false,
                    wrap: settings.wrapLongLines !== false,
                    gutter: settings.showLineNumbers !== false,
                    editing: isEditing
                }));
            } else {
                const pre = node('pre', 'cb-pre cb-viewer-source');
                pre.appendChild(node('code', null, record.content));
                body.appendChild(pre);
            }
        } else {
            body.appendChild(core.renderMarkdown(record.content));
        }
        viewer.appendChild(body);
        return viewer;
    }

    function renderHistoryPage(state) {
        const wrap = node('div', 'cb-history');
        const runs = state.runs || [];
        if (!runs.length) {
            const empty = node('div', 'cb-viewer-empty');
            empty.appendChild(icon('fa-clock-rotate-left'));
            empty.appendChild(node('h3', null, 'No runs yet'));
            empty.appendChild(node('p', null, 'Every Blueprint run is stored here with its complete step trace, prompts, and written documents — kept only in this browser profile.'));
            wrap.appendChild(empty);
            return wrap;
        }
        const run = runs.find(item => item.id === state.activeRunId) || runs[0];
        const header = node('header', 'cb-history-header');
        const title = node('div');
        title.appendChild(node('h2', null, run.title || run.skillName));
        title.appendChild(node('p', null, `${run.skillName} · ${core.formatClock(run.createdAt)} · ${run.status}`));
        header.appendChild(title);
        const tools = node('div', 'cb-viewer-tools');
        tools.appendChild(button('Reopen in agent', 'fa-robot', 'open-run', { compact: true, dataset: { runId: run.id } }));
        tools.appendChild(button('Delete run', 'fa-trash', 'delete-run', { compact: true, danger: true, dataset: { runId: run.id } }));
        header.appendChild(tools);
        wrap.appendChild(header);

        if (run.idea) {
            const idea = node('div', 'cb-history-idea');
            idea.appendChild(node('span', 'cb-written-label', 'Idea'));
            idea.appendChild(node('p', null, run.idea));
            wrap.appendChild(idea);
        }

        const timeline = node('div', 'cb-timeline cb-history-timeline');
        (run.phases || []).forEach(step => timeline.appendChild(renderStep(step)));
        if (!(run.phases || []).length) timeline.appendChild(node('p', 'cb-muted', 'This run recorded no steps.'));
        wrap.appendChild(timeline);

        if (run.writtenPaths && run.writtenPaths.length) {
            const written = node('div', 'cb-written');
            written.appendChild(node('span', 'cb-written-label', 'Documents written:'));
            const writtenFiles = Array.isArray(run.writtenFiles) && run.writtenFiles.length
                ? run.writtenFiles
                : run.writtenPaths.map(path => ({ path, folderId: run.folderId || '' }));
            writtenFiles.forEach(file => {
                const path = file.path;
                const chip = node('button', 'cb-path-chip');
                chip.type = 'button';
                chip.dataset.cbAction = 'open-file';
                chip.dataset.path = path;
                chip.dataset.folderId = file.folderId || run.folderId || '';
                chip.appendChild(icon('fa-file-lines'));
                chip.appendChild(node('span', null, path));
                written.appendChild(chip);
            });
            wrap.appendChild(written);
        }
        return wrap;
    }

    /**
     * The thorough settings page: sections -> sub-pages -> cards -> groups ->
     * rows, all driven by the schema in settings.js and rendered by
     * settings-page.js. Kept as a ui.js export so existing callers and tests do
     * not have to know the split.
     */
    function renderSettingsPage(state) {
        const page = settingsPage();
        if (page) return page.renderSettingsPage(state);
        // settings-page.js is declared in the same install manifest as this file
        // and the host rejects the extension if any asset hash fails, so this
        // branch is unreachable in a working install. Say so plainly rather than
        // rendering a broken half-page.
        const broken = node('div', 'cb-viewer');
        const empty = node('div', 'cb-viewer-empty');
        empty.appendChild(icon('fa-triangle-exclamation'));
        empty.appendChild(node('h3', null, 'Settings unavailable'));
        empty.appendChild(node('p', null, 'The settings module did not load. Reinstall the plug-in with tools/blueprint.py install, then reload the page.'));
        broken.appendChild(empty);
        return broken;
    }

    // ------------------------------------------------------------------
    // Tabbed workspace shell (the reading pane)
    // ------------------------------------------------------------------

    /**
     * The whole Blueprint reading pane: tab strip + active panel.
     *
     * The Agent tab is pinned by default (Settings -> Workspace -> Tabs), so
     * opening Project Files, Runs or Settings adds a tab BESIDE the chat
     * instead of replacing it — the IDE behaviour the page is built around.
     */
    function renderWorkspace(state) {
        const ws = state.workspace;
        const shell = node('div', 'cb-workspace');

        const wsModule = workspaceModule();
        if (wsModule && ws) {
            shell.appendChild(wsModule.renderTabStrip(ws, state));
        }

        const panel = node('div', 'cb-tabpanel');
        panel.id = 'cb-tabpanel';
        panel.dataset.cbRole = 'tabpanel';
        panel.setAttribute('role', 'tabpanel');
        panel.tabIndex = -1;
        panel.appendChild(renderTabPanel(state));
        shell.appendChild(panel);

        return shell;
    }

    /** Map the active tab to its panel. */
    function renderTabPanel(state) {
        const ws = state.workspace;
        const wsModule = workspaceModule();
        if (!ws || !wsModule) return renderAgentPage(state);

        const tab = wsModule.activeTab(ws);
        if (tab.kind === 'file') {
            const record = core.readFile(tab.path, tab.folderId);
            if (!record) return renderMissingFilePanel(state, tab);
            const mode = wsModule.viewerModeFor(ws, tab.path, state.settings || core.readSettings(), tab.folderId);
            return renderViewer(Object.assign({}, state, {
                viewerMode: mode,
                openPath: tab.path,
                openFolderId: tab.folderId
            }), record);
        }
        if (tab.kind === 'section') {
            if (tab.sectionId === 'cb-files') return renderFilesPage(state);
            if (tab.sectionId === 'cb-history') return renderHistoryPage(state);
            if (tab.sectionId === 'cb-settings') return renderSettingsPage(state);
        }
        return renderAgentPage(state);
    }

    /**
     * A file tab whose document was deleted (e.g. closeTabOnDelete is off).
     * Says so plainly and offers the way back.
     */
    function renderMissingFilePanel(state, tab) {
        const wrap = node('div', 'cb-viewer');
        const empty = node('div', 'cb-viewer-empty');
        empty.appendChild(icon('fa-file-circle-xmark'));
        empty.appendChild(node('h3', null, tab.title));
        empty.appendChild(node('p', null, `\u201c${tab.path}\u201d is no longer in the project. It was deleted while this tab was open.`));
        const actions = node('div', 'cb-viewer-empty-actions');
        actions.appendChild(button('Close this tab', 'fa-xmark', 'close-tab', { dataset: { tabId: tab.id } }));
        actions.appendChild(button('Back to Agent', 'fa-robot', 'activate-tab', { primary: true, dataset: { tabId: 'tab-agent' } }));
        empty.appendChild(actions);
        wrap.appendChild(empty);
        return wrap;
    }

    // ------------------------------------------------------------------
    // Modal + toast
    // ------------------------------------------------------------------

    function renderModal(state) {
        const modal = state.modal;
        const backdrop = node('div', 'cb-modal-backdrop');
        backdrop.dataset.cbAction = 'close-modal';

        const dialog = node('section', 'cb-modal');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.dataset.cbAction = 'modal-body';

        const header = node('header', 'cb-modal-header');
        header.appendChild(icon(modal.icon || 'fa-file-circle-plus'));
        header.appendChild(node('h2', null, modal.title));
        header.appendChild(iconButton('fa-xmark', 'close-modal', 'Close'));
        dialog.appendChild(header);

        const body = node('div', 'cb-modal-body');
        if (modal.description) body.appendChild(node('p', 'cb-modal-description', modal.description));

        if (modal.kind === 'folder') {
            // New folder / rename folder: a single name field. The confirm handler
            // reads values.name, collected by data-cb-field below.
            const nameLabel = node('label', 'cb-field');
            nameLabel.appendChild(node('span', null, modal.nameLabel || 'Folder name'));
            const nameInput = node('input', 'cb-input');
            nameInput.type = 'text';
            nameInput.dataset.cbField = 'name';
            nameInput.value = modal.name || '';
            nameInput.maxLength = MAX_FILE_NAME_LENGTH;
            nameLabel.appendChild(nameInput);
            body.appendChild(nameLabel);
            body.appendChild(node('p', 'cb-modal-note', modal.note
                || 'Folders live only in this browser profile, alongside the documents they hold. Nothing is uploaded.'));
        } else if (modal.kind === 'file') {
            const nameLabel = node('label', 'cb-field');
            nameLabel.appendChild(node('span', null, modal.pathLabel || 'Project path'));
            const nameInput = node('input', 'cb-input');
            nameInput.type = 'text';
            nameInput.dataset.cbField = 'path';
            nameInput.value = modal.path || '';
            nameInput.maxLength = MAX_FILE_NAME_LENGTH;
            nameLabel.appendChild(nameInput);
            body.appendChild(nameLabel);

            if (modal.allowUpload) {
                body.appendChild(button('Choose a file from disk…', 'fa-upload', 'pick-upload', { primary: true }));
                const fileInput = document.createElement('input');
                fileInput.type = 'file';
                fileInput.dataset.cbField = 'file';
                fileInput.style.display = 'none';
                if (modal.accept) fileInput.accept = modal.accept;
                body.appendChild(fileInput);
                const limits = sourceLimits();
                body.appendChild(node('p', 'cb-modal-note', modal.note || `Text files up to ${Math.round(limits.maxFileBytes / 1024)} KB. At most ${limits.maxFiles} attached files and ${Math.round(limits.maxTotalBytes / 1024)} KB total are sent to the model. Change these in Settings → Source files.`));
            }

            const contentLabel = node('label', 'cb-field');
            contentLabel.appendChild(node('span', null, modal.contentLabel || 'Content'));
            const contentInput = node('textarea', 'cb-input cb-modal-textarea');
            contentInput.dataset.cbField = 'content';
            contentInput.rows = modal.allowUpload ? 6 : 12;
            contentInput.value = modal.content || '';
            contentLabel.appendChild(contentInput);
            body.appendChild(contentLabel);
        } else if (modal.message) {
            body.appendChild(node('p', null, modal.message));
        }

        dialog.appendChild(body);

        const footer = node('footer', 'cb-modal-footer');
        footer.appendChild(button(modal.cancelLabel || 'Cancel', '', 'close-modal'));
        footer.appendChild(button(modal.confirmLabel || 'OK', modal.confirmIcon || '', 'confirm-modal', { primary: !modal.danger, danger: modal.danger }));
        dialog.appendChild(footer);

        backdrop.appendChild(dialog);
        return backdrop;
    }

    function renderFileSelectorOverlay(state) {
        const fso = state.fileSelector || {
            open: true,
            search: '',
            category: 'all',
            folderId: 'all',
            selectedPaths: new Set(),
            reviewMode: state.sourceFileMode || 'combine',
            previewPath: null
        };
        const selectedPaths = fso.selectedPaths instanceof Set ? fso.selectedPaths : new Set(fso.selectedPaths || []);
        const reviewMode = fso.reviewMode || state.sourceFileMode || 'combine';
        const isCombine = reviewMode === 'combine';

        const backdrop = node('div', 'cb-modal-backdrop cb-fso-backdrop');
        backdrop.dataset.cbAction = 'close-file-selector';

        const dialog = node('section', 'cb-modal cb-fso-modal');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.dataset.cbAction = 'modal-body';

        // Header
        const header = node('header', 'cb-modal-header cb-fso-header');
        header.appendChild(icon('fa-layer-group'));
        const headerCopy = node('div', 'cb-fso-header-copy');
        headerCopy.appendChild(node('h2', null, 'File Selector & Review Manager'));
        headerCopy.appendChild(node('p', 'cb-fso-header-subtitle', 'Choose files to review independently or augment what the Agent chooses from the workspace.'));
        header.appendChild(headerCopy);
        header.appendChild(iconButton('fa-xmark', 'close-file-selector', 'Close'));
        dialog.appendChild(header);

        const body = node('div', 'cb-modal-body cb-fso-body');

        // Review Strategy Section
        const modeSection = node('div', 'cb-fso-mode-section');
        modeSection.appendChild(node('span', 'cb-fso-section-label', 'Review Strategy:'));
        const modeGroup = node('div', 'cb-fso-mode-group');

        // Mode Card 1: Combine (On top of Agent files)
        const combineCard = node('div', `cb-fso-mode-card cb-fso-mode-combine${isCombine ? ' cb-fso-mode-active' : ''}`);
        combineCard.dataset.cbAction = 'fso-set-mode';
        combineCard.dataset.mode = 'combine';
        const combineRadio = node('span', 'cb-fso-mode-radio');
        combineRadio.appendChild(icon(isCombine ? 'fa-circle-dot' : 'fa-circle'));
        combineCard.appendChild(combineRadio);
        const combineInfo = node('div', 'cb-fso-mode-info');
        const combineTitleRow = node('div', 'cb-fso-mode-title-row');
        combineTitleRow.appendChild(node('strong', 'cb-fso-mode-title', 'On top of Agent files'));
        combineTitleRow.appendChild(node('span', 'cb-fso-mode-badge cb-fso-badge-primary', 'Augment / Recommended'));
        combineInfo.appendChild(combineTitleRow);
        combineInfo.appendChild(node('p', 'cb-fso-mode-desc', 'Your selected files are pinned with top priority in prompt context, and the Agent continues to auto-discover related workspace files up to the context budget.'));
        combineCard.appendChild(combineInfo);
        modeGroup.appendChild(combineCard);

        // Mode Card 2: Exclusive (Review independently)
        const exclusiveCard = node('div', `cb-fso-mode-card cb-fso-mode-exclusive${!isCombine ? ' cb-fso-mode-active' : ''}`);
        exclusiveCard.dataset.cbAction = 'fso-set-mode';
        exclusiveCard.dataset.mode = 'exclusive';
        const exclusiveRadio = node('span', 'cb-fso-mode-radio');
        exclusiveRadio.appendChild(icon(!isCombine ? 'fa-circle-dot' : 'fa-circle'));
        exclusiveCard.appendChild(exclusiveRadio);
        const exclusiveInfo = node('div', 'cb-fso-mode-info');
        const exclusiveTitleRow = node('div', 'cb-fso-mode-title-row');
        exclusiveTitleRow.appendChild(node('strong', 'cb-fso-mode-title', 'Review independently'));
        exclusiveTitleRow.appendChild(node('span', 'cb-fso-mode-badge cb-fso-badge-warn', 'Manual Only / Strict'));
        exclusiveInfo.appendChild(exclusiveTitleRow);
        exclusiveInfo.appendChild(node('p', 'cb-fso-mode-desc', 'The Agent strictly evaluates ONLY your chosen files. All automatic workspace file discovery is bypassed.'));
        exclusiveCard.appendChild(exclusiveInfo);
        modeGroup.appendChild(exclusiveCard);

        modeSection.appendChild(modeGroup);
        body.appendChild(modeSection);

        const allPaths = (core && typeof core.listFiles === 'function') ? core.listFiles() : (state.projectFiles || []);
        const extCounts = {};
        allPaths.forEach(p => {
            const ext = p.split('.').pop().toLowerCase();
            if (ext && ext !== p.toLowerCase()) {
                extCounts[ext] = (extCounts[ext] || 0) + 1;
            }
        });
        const sortedExts = Object.keys(extCounts).sort((a, b) => extCounts[b] - extCounts[a]);

        // Toolbar: Search + Category chips + Folder select + Bulk buttons
        const toolbar = node('div', 'cb-fso-toolbar');
        const searchWrap = node('div', 'cb-fso-search-wrap');
        searchWrap.appendChild(icon('fa-magnifying-glass'));
        const searchInput = node('input', 'cb-input cb-fso-search-input');
        searchInput.type = 'text';
        searchInput.dataset.cbRole = 'fso-search';
        searchInput.placeholder = 'Search or filter files by glob (e.g. *.js, src/**, config*)…';
        searchInput.value = fso.search || '';
        searchWrap.appendChild(searchInput);
        if (fso.search) {
            const clearBtn = node('button', 'cb-fso-clear-btn');
            clearBtn.type = 'button';
            clearBtn.dataset.cbAction = 'fso-search-clear';
            clearBtn.title = 'Clear search';
            clearBtn.appendChild(icon('fa-xmark'));
            searchWrap.appendChild(clearBtn);
        }
        toolbar.appendChild(searchWrap);

        const controlsRow = node('div', 'cb-fso-controls-row');
        // Category Chips
        const chipsWrap = node('div', 'cb-fso-categories');
        const categories = [
            { id: 'all', label: 'All Files' },
            { id: 'code', label: 'Code' },
            { id: 'docs', label: 'Docs & PRDs' },
            { id: 'config', label: 'Config' },
            { id: 'selected', label: `Selected (${selectedPaths.size})` }
        ];
        categories.forEach(cat => {
            const chip = node('button', `cb-fso-chip${fso.category === cat.id ? ' active' : ''}`);
            chip.type = 'button';
            chip.dataset.cbAction = 'fso-category';
            chip.dataset.category = cat.id;
            chip.textContent = cat.label;
            chipsWrap.appendChild(chip);
        });
        controlsRow.appendChild(chipsWrap);

        // Folder filter
        const folderSelect = node('select', 'cb-select cb-fso-folder-select');
        folderSelect.dataset.cbRole = 'fso-folder';
        const allFolderOpt = node('option');
        allFolderOpt.value = 'all';
        allFolderOpt.textContent = '📁 All Folders';
        if (!fso.folderId || fso.folderId === 'all') allFolderOpt.selected = true;
        folderSelect.appendChild(allFolderOpt);
        (state.folders || []).forEach(f => {
            const opt = node('option');
            opt.value = f.id;
            opt.textContent = `📁 ${f.name}`;
            if (fso.folderId === f.id) opt.selected = true;
            folderSelect.appendChild(opt);
        });
        controlsRow.appendChild(folderSelect);

        // Bulk buttons
        const bulkWrap = node('div', 'cb-fso-bulk-actions');
        const selectAllBtn = node('button', 'cb-btn cb-fso-bulk-btn');
        selectAllBtn.type = 'button';
        selectAllBtn.dataset.cbAction = 'fso-select-all';
        selectAllBtn.title = 'Select all filtered files';
        selectAllBtn.appendChild(icon('fa-square-check'));
        selectAllBtn.appendChild(node('span', null, 'Select All'));
        bulkWrap.appendChild(selectAllBtn);

        const fillBudgetBtn = node('button', 'cb-btn cb-fso-bulk-btn cb-fso-fill-budget-btn');
        fillBudgetBtn.type = 'button';
        fillBudgetBtn.dataset.cbAction = 'fso-fill-budget';
        fillBudgetBtn.title = 'Auto-select files in order up to maximum context budget';
        fillBudgetBtn.appendChild(icon('fa-bolt'));
        fillBudgetBtn.appendChild(node('span', null, 'Fill Budget'));
        bulkWrap.appendChild(fillBudgetBtn);

        const deselectAllBtn = node('button', 'cb-btn cb-fso-bulk-btn');
        deselectAllBtn.type = 'button';
        deselectAllBtn.dataset.cbAction = 'fso-deselect-all';
        deselectAllBtn.title = 'Deselect all files';
        deselectAllBtn.appendChild(icon('fa-square'));
        deselectAllBtn.appendChild(node('span', null, 'Deselect All'));
        bulkWrap.appendChild(deselectAllBtn);

        const invertBtn = node('button', 'cb-btn cb-fso-bulk-btn');
        invertBtn.type = 'button';
        invertBtn.dataset.cbAction = 'fso-invert';
        invertBtn.title = 'Invert current selection';
        invertBtn.appendChild(icon('fa-arrow-right-arrow-left'));
        invertBtn.appendChild(node('span', null, 'Invert'));
        bulkWrap.appendChild(invertBtn);

        controlsRow.appendChild(bulkWrap);
        toolbar.appendChild(controlsRow);

        // Quick Extension Selector Pills
        if (sortedExts.length > 1) {
            const extsRow = node('div', 'cb-fso-ext-row');
            extsRow.appendChild(node('span', 'cb-fso-ext-label', 'Select by type:'));
            const extsPills = node('div', 'cb-fso-ext-pills');
            sortedExts.slice(0, 8).forEach(ext => {
                const filesWithExt = allPaths.filter(p => p.toLowerCase().endsWith('.' + ext));
                const allSel = filesWithExt.length > 0 && filesWithExt.every(p => selectedPaths.has(p));
                const someSel = !allSel && filesWithExt.some(p => selectedPaths.has(p));
                const pill = node('button', `cb-fso-ext-pill${allSel ? ' active' : someSel ? ' partial' : ''}`);
                pill.type = 'button';
                pill.dataset.cbAction = 'fso-select-ext';
                pill.dataset.ext = ext;
                pill.title = `${allSel ? 'Deselect' : 'Select'} all *.${ext} files (${filesWithExt.length})`;
                pill.appendChild(node('span', null, `*.${ext}`));
                pill.appendChild(node('span', 'cb-fso-ext-count', String(extCounts[ext])));
                extsPills.appendChild(pill);
            });
            extsRow.appendChild(extsPills);
            toolbar.appendChild(extsRow);
        }

        body.appendChild(toolbar);

        // File Filtering Logic
        const CODE_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'ps1', 'sql', 'html', 'css']);
        const DOCS_EXTS = new Set(['md', 'markdown', 'txt', 'rst', 'adoc', 'pdf']);
        const CONFIG_EXTS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'env', 'config']);

        const query = String(fso.search || '').trim().toLowerCase();
        let searchMatcher = null;
        if (query && (query.includes('*') || query.includes('?'))) {
            try {
                const esc = '^' + query.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
                searchMatcher = new RegExp(esc, 'i');
            } catch (_) {}
        }

        const filteredFiles = allPaths.map(p => {
            const rec = core && typeof core.readFile === 'function' ? core.readFile(p) : null;
            const content = rec && typeof rec.content === 'string' ? rec.content : '';
            const ext = p.split('.').pop().toLowerCase();
            const folder = rec && rec.folder ? rec.folder : (core ? core.DEFAULT_FOLDER_ID : 'default');
            return {
                path: p,
                content,
                bytes: content.length,
                lines: content ? content.split('\n').length : 0,
                ext,
                folder
            };
        }).filter(item => {
            // Search query / wildcard filter
            if (query) {
                const matches = searchMatcher ? searchMatcher.test(item.path) : item.path.toLowerCase().includes(query);
                if (!matches) return false;
            }

            // Folder filter
            if (fso.folderId && fso.folderId !== 'all' && item.folder !== fso.folderId) return false;

            // Category filter
            if (fso.category === 'code') return CODE_EXTS.has(item.ext);
            if (fso.category === 'docs') return DOCS_EXTS.has(item.ext);
            if (fso.category === 'config') return CONFIG_EXTS.has(item.ext);
            if (fso.category === 'selected') return selectedPaths.has(item.path);
            return true;
        });

        // Main Layout: Split list + preview drawer
        const main = node('div', 'cb-fso-main');
        const listWrap = node('div', 'cb-fso-list-wrap');

        if (!filteredFiles.length) {
            const empty = node('div', 'cb-fso-empty');
            empty.appendChild(icon('fa-folder-open'));
            empty.appendChild(node('span', null, query ? `No files matching "${fso.search}"` : 'No files in this view'));
            listWrap.appendChild(empty);
        } else {
            const list = node('div', 'cb-fso-list');

            // Group by directory if files span multiple directories
            const dirGroups = new Map();
            filteredFiles.forEach(file => {
                const parts = file.path.split('/');
                parts.pop();
                const dir = parts.length ? parts.join('/') + '/' : '';
                if (!dirGroups.has(dir)) dirGroups.set(dir, []);
                dirGroups.get(dir).push(file);
            });

            const showDirHeaders = dirGroups.size > 1;

            dirGroups.forEach((files, dir) => {
                if (showDirHeaders) {
                    const dirHeader = node('div', 'cb-fso-dir-header');
                    const dirTitle = node('div', 'cb-fso-dir-title');
                    dirTitle.appendChild(icon('fa-folder-open'));
                    dirTitle.appendChild(node('span', null, `${dir || '(root)'} (${files.length} file${files.length === 1 ? '' : 's'})`));
                    dirHeader.appendChild(dirTitle);

                    const dirTools = node('div', 'cb-fso-dir-tools');
                    const allDirSelected = files.every(f => selectedPaths.has(f.path));
                    const selDirBtn = node('button', 'cb-fso-dir-btn');
                    selDirBtn.type = 'button';
                    selDirBtn.dataset.cbAction = allDirSelected ? 'fso-deselect-dir' : 'fso-select-dir';
                    selDirBtn.dataset.dir = dir;
                    selDirBtn.textContent = allDirSelected ? 'Deselect folder' : 'Select all in folder';
                    dirTools.appendChild(selDirBtn);
                    dirHeader.appendChild(dirTools);

                    list.appendChild(dirHeader);
                }

                files.forEach(file => {
                    const isSelected = selectedPaths.has(file.path);
                    const isCurrentlyAttached = Array.isArray(state.sourceFiles) && state.sourceFiles.some(f => f.path === file.path);
                    const isPreviewing = fso.previewPath === file.path;

                    const row = node('div', `cb-fso-row${isSelected ? ' cb-fso-selected' : ''}${isPreviewing ? ' cb-fso-previewing' : ''}`);

                    // Checkbox
                    const cb = node('input', 'cb-fso-checkbox');
                    cb.type = 'checkbox';
                    cb.checked = isSelected;
                    cb.dataset.cbAction = 'fso-toggle-file';
                    cb.dataset.path = file.path;
                    row.appendChild(cb);

                    // File icon
                    const fileIco = icon(fileIconFor(file.path));
                    fileIco.className = `cb-fso-icon ${fileIco.className}`;
                    row.appendChild(fileIco);

                    // Path & Name
                    const details = node('div', 'cb-fso-details');
                    details.dataset.cbAction = 'fso-toggle-file';
                    details.dataset.path = file.path;
                    const pathBox = node('div', 'cb-fso-path');
                    const parts = file.path.split('/');
                    const filename = parts.pop();
                    const dirPath = parts.length ? parts.join('/') + '/' : '';
                    if (dirPath) pathBox.appendChild(node('span', 'cb-fso-dir', dirPath));
                    pathBox.appendChild(node('strong', 'cb-fso-name', filename));
                    details.appendChild(pathBox);
                    row.appendChild(details);

                    // Meta badges (size, lines)
                    const meta = node('div', 'cb-fso-meta');
                    meta.appendChild(node('span', 'cb-fso-size', `${Math.round(file.bytes / 1024)} KB`));
                    meta.appendChild(node('span', 'cb-fso-lines', `${file.lines} lines`));
                    if (isCurrentlyAttached) {
                        meta.appendChild(node('span', 'cb-fso-badge cb-fso-badge-attached', 'Attached'));
                    }
                    row.appendChild(meta);

                    // Preview Button
                    const previewBtn = node('button', 'cb-fso-preview-btn');
                    previewBtn.type = 'button';
                    previewBtn.dataset.cbAction = 'fso-preview-file';
                    previewBtn.dataset.path = file.path;
                    previewBtn.title = isPreviewing ? 'Hide preview' : 'Inspect file content';
                    previewBtn.appendChild(icon(isPreviewing ? 'fa-eye-slash' : 'fa-eye'));
                    row.appendChild(previewBtn);

                    list.appendChild(row);
                });
            });

            const hint = node('div', 'cb-fso-dropzone-hint');
            hint.appendChild(icon('fa-lightbulb'));
            hint.appendChild(node('span', null, 'Tip: Shift-click to select ranges of files in bulk • Click "Fill Budget" to auto-select up to the context limit'));
            listWrap.appendChild(hint);

            listWrap.appendChild(list);
        }
        main.appendChild(listWrap);

        // Optional Preview Drawer
        if (fso.previewPath) {
            const previewRecord = core && typeof core.readFile === 'function' ? core.readFile(fso.previewPath) : null;
            if (previewRecord) {
                const drawer = node('div', 'cb-fso-preview-drawer');
                const drawerHead = node('div', 'cb-fso-preview-header');
                const drawerTitle = node('div', 'cb-fso-preview-title');
                drawerTitle.appendChild(icon(fileIconFor(fso.previewPath)));
                drawerTitle.appendChild(node('strong', null, fso.previewPath));
                drawerHead.appendChild(drawerTitle);

                const drawerTools = node('div', 'cb-fso-preview-tools');
                const isSelected = selectedPaths.has(fso.previewPath);
                const toggleBtn = node('button', 'cb-btn');
                toggleBtn.type = 'button';
                toggleBtn.dataset.cbAction = 'fso-toggle-file';
                toggleBtn.dataset.path = fso.previewPath;
                toggleBtn.appendChild(icon(isSelected ? 'fa-check' : 'fa-plus'));
                toggleBtn.appendChild(node('span', null, isSelected ? 'Selected' : 'Select'));
                drawerTools.appendChild(toggleBtn);

                const closePrevBtn = node('button', 'cb-icon-btn');
                closePrevBtn.type = 'button';
                closePrevBtn.dataset.cbAction = 'fso-preview-file';
                closePrevBtn.dataset.path = fso.previewPath;
                closePrevBtn.appendChild(icon('fa-xmark'));
                drawerTools.appendChild(closePrevBtn);

                drawerHead.appendChild(drawerTools);
                drawer.appendChild(drawerHead);

                const drawerBody = node('div', 'cb-fso-preview-body');
                const pre = node('pre', 'cb-fso-preview-code');
                pre.appendChild(node('code', null, previewRecord.content || '(empty file)'));
                drawerBody.appendChild(pre);
                drawer.appendChild(drawerBody);

                main.appendChild(drawer);
            }
        }

        body.appendChild(main);

        // Quick add buttons
        const quickAdd = node('div', 'cb-fso-quick-add');
        const uploadBtn = node('button', 'cb-btn');
        uploadBtn.type = 'button';
        uploadBtn.dataset.cbAction = 'fso-bulk-upload-trigger';
        uploadBtn.appendChild(icon('fa-file-arrow-up'));
        uploadBtn.appendChild(node('span', null, 'Upload Multiple Files from Disk…'));
        quickAdd.appendChild(uploadBtn);

        const pasteBtn = node('button', 'cb-btn');
        pasteBtn.type = 'button';
        pasteBtn.dataset.cbAction = 'fso-paste';
        pasteBtn.appendChild(icon('fa-paste'));
        pasteBtn.appendChild(node('span', null, 'Paste New File…'));
        quickAdd.appendChild(pasteBtn);
        body.appendChild(quickAdd);

        const bulkFileInput = node('input', 'cb-fso-bulk-file-input');
        bulkFileInput.type = 'file';
        bulkFileInput.multiple = true;
        bulkFileInput.dataset.cbRole = 'fso-bulk-file-input';
        bulkFileInput.accept = '.py,.js,.jsx,.ts,.tsx,.json,.md,.css,.html,.txt,.yaml,.yml,.toml,.sh,.ps1,.sql';
        dialog.appendChild(bulkFileInput);

        dialog.appendChild(body);

        // Footer: Stats & Actions
        const footer = node('footer', 'cb-modal-footer cb-fso-footer');

        // Selection metrics
        let totalSelectedBytes = 0;
        selectedPaths.forEach(p => {
            const rec = core && typeof core.readFile === 'function' ? core.readFile(p) : null;
            if (rec && rec.content) totalSelectedBytes += rec.content.length;
        });
        const limits = sourceLimits();
        const estTokens = Math.round(totalSelectedBytes / 3.8);

        const stats = node('div', 'cb-fso-stats');
        stats.appendChild(node('span', 'cb-fso-stat-count', `Selected: ${selectedPaths.size} file${selectedPaths.size === 1 ? '' : 's'}`));
        stats.appendChild(node('span', 'cb-fso-stat-size', `• ${Math.round(totalSelectedBytes / 1024)} KB`));
        stats.appendChild(node('span', 'cb-fso-stat-tokens', `(~${estTokens.toLocaleString()} tokens)`));

        const isOverBudget = selectedPaths.size > limits.maxFiles || totalSelectedBytes > limits.maxTotalBytes;
        const budgetBadge = node('span', `cb-fso-budget-badge ${isOverBudget ? 'cb-fso-badge-warn' : 'cb-fso-badge-primary'}`);
        budgetBadge.textContent = isOverBudget
            ? `⚠️ Exceeds budget (${selectedPaths.size}/${limits.maxFiles} files, ${Math.round(totalSelectedBytes / 1024)}/${Math.round(limits.maxTotalBytes / 1024)} KB)`
            : `Within context limit (${selectedPaths.size}/${limits.maxFiles} files)`;
        stats.appendChild(budgetBadge);
        footer.appendChild(stats);

        const actions = node('div', 'cb-fso-actions');
        actions.appendChild(button('Cancel', '', 'close-file-selector'));
        actions.appendChild(button('Attach to Context', 'fa-paperclip', 'fso-confirm'));
        actions.appendChild(button('Review Selected Files Now', 'fa-rocket', 'fso-review-now', { primary: true }));
        footer.appendChild(actions);

        dialog.appendChild(footer);
        backdrop.appendChild(dialog);
        return backdrop;
    }

    function renderToast(state) {
        const toast = node('div', `cb-toast cb-toast-${state.toast.tone || 'info'}`);
        toast.setAttribute('role', 'status');
        toast.appendChild(icon(state.toast.tone === 'error' ? 'fa-circle-exclamation' : state.toast.tone === 'success' ? 'fa-circle-check' : 'fa-circle-info'));
        toast.appendChild(node('span', null, state.toast.text));
        return toast;
    }

    window.__codalioBlueprintUi = Object.freeze({
        MAX_SOURCE_FILE_BYTES,
        MAX_SOURCE_FILES,
        MAX_SOURCE_TOTAL_BYTES,
        MAX_FILE_NAME_LENGTH,
        SECTIONS,
        folderRootKey,
        folderPathKey,
        node,
        icon,
        button,
        iconButton,
        fileIconFor,
        buildTree,
        renderNav,
        renderRibbon,
        renderList,
        renderWorkspace,
        renderTabPanel,
        renderMissingFilePanel,
        renderAgentPage,
        renderChatHistoryFlyout,
        renderFilesPage,
        renderHistoryPage,
        renderSettingsPage,
        renderViewer,
        sourceLimits,
        renderStep,
        renderMessage,
        renderModal,
        renderFileSelectorOverlay,
        renderToast,
        statusIcon
    });
}());
