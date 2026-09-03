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

    const MAX_SOURCE_FILE_BYTES = 120 * 1024;
    const MAX_SOURCE_FILES = 12;
    const MAX_SOURCE_TOTAL_BYTES = 420 * 1024;
    const MAX_FILE_NAME_LENGTH = 140;

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

    function icon(name) {
        const element = document.createElement('i');
        element.className = `fas ${name}`;
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
            host.addFolder(section.id, section.icon, section.label, count);
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
            host.addBtn('cb-add-source', 'fa-file-circle-plus', 'Add Source File', true, () => state.handlers.addSourceFile());
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
            listContent.appendChild(renderSettingsSummary(state));
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

    function renderTreeBranch(branch, state, depth) {
        const fragment = document.createDocumentFragment();
        [...branch.folders.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(folder => {
                const isOpen = state.expanded.has(folder.path);
                const row = node('div', 'cb-tree-row cb-tree-folder');
                row.style.paddingLeft = `${8 + depth * 13}px`;
                row.dataset.cbAction = 'toggle-folder';
                row.dataset.path = folder.path;
                row.setAttribute('role', 'treeitem');
                row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
                row.tabIndex = 0;
                row.appendChild(icon(isOpen ? 'fa-folder-open' : 'fa-folder'));
                row.appendChild(node('span', 'cb-tree-name', folder.name));
                fragment.appendChild(row);
                if (isOpen) fragment.appendChild(renderTreeBranch(folder, state, depth + 1));
            });
        branch.files
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(file => {
                const row = node('div', `cb-tree-row cb-tree-file${state.openPath === file.path ? ' selected' : ''}`);
                row.style.paddingLeft = `${11 + depth * 13}px`;
                row.dataset.cbAction = 'open-file';
                row.dataset.path = file.path;
                row.setAttribute('role', 'treeitem');
                row.setAttribute('aria-selected', state.openPath === file.path ? 'true' : 'false');
                row.tabIndex = 0;
                row.appendChild(icon(fileIconFor(file.name)));
                row.appendChild(node('span', 'cb-tree-name', file.name));
                fragment.appendChild(row);
            });
        return fragment;
    }

    function renderFileTree(state) {
        const wrap = node('div', 'cb-tree-wrap');
        const header = node('div', 'cb-tree-header');
        header.appendChild(node('strong', null, state.projectName || 'Blueprint project'));
        const tools = node('div', 'cb-tree-tools');
        tools.appendChild(iconButton('fa-file-circle-plus', 'add-source-file', 'Add a source file to the project'));
        tools.appendChild(iconButton('fa-file-pen', 'new-file', 'Create a Markdown file'));
        tools.appendChild(iconButton('fa-folder-open', 'expand-all', 'Expand every folder'));
        tools.appendChild(iconButton('fa-folder', 'collapse-all', 'Collapse every folder'));
        header.appendChild(tools);
        wrap.appendChild(header);

        const paths = core.listFiles();
        const tree = node('div', 'cb-tree');
        tree.setAttribute('role', 'tree');
        if (!paths.length) {
            const empty = node('div', 'cb-tree-empty');
            empty.appendChild(icon('fa-folder-open'));
            empty.appendChild(node('span', null, 'No files yet.'));
            empty.appendChild(node('p', null, 'Blueprint writes each generated document here under docs/. Add source files for the code-reading skills.'));
            tree.appendChild(empty);
        } else {
            tree.appendChild(renderTreeBranch(buildTree(paths), state, 0));
        }
        wrap.appendChild(tree);

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
                const remove = iconButton('fa-xmark', 'remove-source-file', `Detach ${file.path}`, { path: file.path });
                item.appendChild(remove);
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
        if (status === 'error') return 'fa-circle-exclamation';
        if (status === 'stopped') return 'fa-circle-stop';
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
        skipped: 'fa-circle-minus'
    };

    function renderStep(step) {
        const wrap = node('div', `cb-step cb-step-${step.status || 'pending'}`);
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
        if (step.summary) titleWrap.appendChild(node('span', 'cb-step-summary', step.summary));
        head.appendChild(titleWrap);

        if (step.elapsedMs) head.appendChild(node('time', 'cb-step-time', `${(step.elapsedMs / 1000).toFixed(1)}s`));
        head.appendChild(icon(step.open ? 'fa-chevron-up' : 'fa-chevron-down'));
        wrap.appendChild(head);

        if (!step.open) return wrap;

        const body = node('div', 'cb-step-body');

        if (step.kind === 'question') {
            body.appendChild(node('p', 'cb-step-question', step.question || ''));
            if (step.options && step.options.length) {
                const options = node('div', 'cb-step-options');
                step.options.forEach(option => {
                    const chip = node('button', 'cb-chip');
                    chip.type = 'button';
                    chip.dataset.cbAction = 'answer-question';
                    chip.dataset.stepId = step.id;
                    chip.dataset.answer = option;
                    chip.textContent = option;
                    options.appendChild(chip);
                });
                body.appendChild(options);
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
            outputHead.appendChild(node('span', null, step.status === 'running' ? 'Model output (streaming)' : 'Model output'));
            if (step.finishReason) outputHead.appendChild(node('span', 'cb-step-flag', `finish: ${step.finishReason}`));
            outputBox.appendChild(outputHead);
            if (step.streaming && step.liveElement) {
                outputBox.appendChild(step.liveElement);
            } else if (step.text) {
                outputBox.appendChild(core.renderMarkdown(step.text));
            } else {
                outputBox.appendChild(node('p', 'cb-muted', step.status === 'running' ? 'Waiting for the first token…' : 'No output.'));
            }
            body.appendChild(outputBox);
        } else if (step.text) {
            body.appendChild(core.renderMarkdown(step.text));
        }

        if (step.error) {
            const errorBox = node('div', 'cb-step-errbox');
            errorBox.appendChild(icon('fa-triangle-exclamation'));
            errorBox.appendChild(node('span', null, step.error));
            body.appendChild(errorBox);
        }

        wrap.appendChild(body);
        return wrap;
    }

    // ------------------------------------------------------------------
    // Transcript — the one big chat
    // ------------------------------------------------------------------

    function renderMessage(message) {
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
            written.appendChild(node('span', 'cb-written-label', 'Written to project:'));
            message.paths.forEach(path => {
                const chip = node('button', 'cb-path-chip');
                chip.type = 'button';
                chip.dataset.cbAction = 'open-file';
                chip.dataset.path = path;
                chip.appendChild(icon('fa-file-arrow-down'));
                chip.appendChild(node('span', null, path));
                written.appendChild(chip);
            });
            wrap.appendChild(written);
        }

        const actions = node('div', 'cb-msg-actions');
        if (message.role === 'assistant') {
            if (message.text) actions.appendChild(button('Copy', 'fa-copy', 'copy-message', { compact: true, dataset: { messageId: message.id } }));
            if (message.canRetry && !message.busy) {
                actions.appendChild(button('Retry', 'fa-rotate-right', 'retry-message', { compact: true, dataset: { messageId: message.id } }));
            }
            actions.appendChild(button('Revise', 'fa-pen', 'revise-message', { compact: true, dataset: { messageId: message.id } }));
        }
        if (actions.childElementCount) wrap.appendChild(actions);
        return wrap;
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
        const skillLabel = node('div', 'cb-agent-skill');
        skillLabel.appendChild(icon(skills.getSkill(state.selectedSkillId)?.icon || 'fa-wand-magic-sparkles'));
        skillLabel.appendChild(node('span', null, skills.getSkill(state.selectedSkillId)?.name || 'No skill selected'));
        header.appendChild(skillLabel);
        wrap.appendChild(header);

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

        if (state.pendingQuestion) {
            const bar = node('div', 'cb-composer-question');
            bar.appendChild(icon('fa-circle-question'));
            bar.appendChild(node('span', null, state.pendingQuestion.question));
            composer.appendChild(bar);
        }

        const textarea = node('textarea', 'cb-composer-input');
        textarea.dataset.cbRole = 'composer';
        textarea.rows = 3;
        textarea.value = state.draft || '';
        textarea.placeholder = state.busy
            ? 'A step is running — press Stop to interrupt safely.'
            : state.pendingQuestion
                ? 'Answer the question above, or pick an option.'
                : 'Describe your product idea, or tell Blueprint what to revise. Enter sends · Shift+Enter adds a line.';
        if (state.busy) textarea.disabled = true;
        composer.appendChild(textarea);

        const bar = node('div', 'cb-composer-bar');
        const hint = node('span', 'cb-composer-hint');
        hint.appendChild(icon(state.busy ? 'fa-circle-notch fa-spin' : 'fa-circle-info'));
        hint.appendChild(node('span', null, state.hint || 'Runs on your active SimpleRAG model endpoint. Nothing is written to your workspace.'));
        bar.appendChild(hint);

        const right = node('div', 'cb-composer-right');
        if (state.busy) {
            right.appendChild(button('Stop', 'fa-stop', 'stop-run', { danger: true, title: 'Stop the current step safely' }));
        }
        const send = node('button', 'cb-btn primary cb-send');
        send.type = 'button';
        send.dataset.cbAction = 'send';
        send.appendChild(icon('fa-paper-plane'));
        send.appendChild(node('span', null, state.busy ? 'Running…' : 'Send'));
        if (state.busy) send.disabled = true;
        right.appendChild(send);
        bar.appendChild(right);
        composer.appendChild(bar);
        return composer;
    }

    function renderFilesPage(state) {
        const record = state.openPath ? core.readFile(state.openPath) : null;
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

    function renderViewer(state, record) {
        const viewer = node('div', 'cb-viewer');

        const bar = node('div', 'cb-viewer-bar');
        const pathWrap = node('div', 'cb-viewer-path');
        pathWrap.appendChild(icon(fileIconFor(record.path)));
        pathWrap.appendChild(node('span', null, record.path));
        bar.appendChild(pathWrap);

        const tools = node('div', 'cb-viewer-tools');
        tools.appendChild(node('span', 'cb-viewer-meta', `${record.content.length.toLocaleString()} chars · ${record.content.split('\n').length} lines · ${core.formatClock(record.updatedAt)}`));
        tools.appendChild(button(state.viewerMode === 'source' ? 'Preview' : 'Markdown', state.viewerMode === 'source' ? 'fa-eye' : 'fa-code', 'viewer-toggle', { compact: true, dataset: { path: record.path } }));
        tools.appendChild(button('Copy', 'fa-copy', 'copy-file', { compact: true, dataset: { path: record.path } }));
        tools.appendChild(button('Download', 'fa-download', 'download-file', { compact: true, dataset: { path: record.path } }));
        tools.appendChild(button('Rename', 'fa-pen', 'rename-file', { compact: true, dataset: { path: record.path } }));
        tools.appendChild(button('Delete', 'fa-trash', 'delete-file', { compact: true, danger: true, dataset: { path: record.path } }));
        bar.appendChild(tools);
        viewer.appendChild(bar);

        const body = node('div', 'cb-viewer-body');
        if (state.viewerMode === 'source') {
            const pre = node('pre', 'cb-pre cb-viewer-source');
            pre.appendChild(node('code', null, record.content));
            body.appendChild(pre);
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
            run.writtenPaths.forEach(path => {
                const chip = node('button', 'cb-path-chip');
                chip.type = 'button';
                chip.dataset.cbAction = 'open-file';
                chip.dataset.path = path;
                chip.appendChild(icon('fa-file-lines'));
                chip.appendChild(node('span', null, path));
                written.appendChild(chip);
            });
            wrap.appendChild(written);
        }
        return wrap;
    }

    function renderSettingsPage(state) {
        const panel = node('div', 'cb-settings');
        const header = node('header', 'cb-settings-header');
        header.appendChild(icon('fa-sliders'));
        const titleWrap = node('div');
        titleWrap.appendChild(node('h2', null, 'Blueprint settings'));
        titleWrap.appendChild(node('p', null, 'These control how the agent runs the skills. They are stored only in this browser profile.'));
        header.appendChild(titleWrap);
        panel.appendChild(header);

        const settings = core.readSettings();
        const body = node('div', 'cb-settings-body');

        body.appendChild(settingRow(
            'Lens concurrency',
            'Run the three PRD lenses together, or one after another. Both produce the same three write-ups before synthesis; sequential is easier to watch and lighter on a local endpoint.',
            selectControl('concurrency', [
                { value: 'parallel', label: 'Parallel — all three at once' },
                { value: 'sequential', label: 'Sequential — one at a time' }
            ], settings.concurrency)
        ));

        body.appendChild(settingRow(
            'Ask clarifying questions',
            'The skills stop to ask who the user is, what problem is solved, and what constraints apply before running any lens.',
            toggleControl('askClarifyingQuestions', settings.askClarifyingQuestions)
        ));

        body.appendChild(settingRow(
            'Auto-open written documents',
            'Open each document in the viewer as soon as the agent writes it into the project.',
            toggleControl('autoOpenWrittenDocument', settings.autoOpenWrittenDocument)
        ));

        body.appendChild(settingRow(
            'Lens token budget',
            'max_output_tokens for each lens and analysis step. Raise it if a step keeps hitting the output limit.',
            numberControl('lensMaxOutputTokens', settings.lensMaxOutputTokens, 512, 32768, 256)
        ));

        body.appendChild(settingRow(
            'Document token budget',
            'max_output_tokens for the final synthesized document. A full PRD needs more room than one lens.',
            numberControl('documentMaxOutputTokens', settings.documentMaxOutputTokens, 512, 32768, 512)
        ));

        body.appendChild(settingRow(
            'Temperature',
            'Lower keeps the lenses consistent with each other; higher explores more wording.',
            numberControl('temperature', settings.temperature, 0, 1.5, 0.1, 0.1)
        ));

        const danger = node('div', 'cb-settings-danger');
        danger.appendChild(node('h3', null, 'Blueprint data'));
        danger.appendChild(node('p', null, 'Generated documents, run history, and attached source live only in this browser profile under Blueprint\u2019s own storage keys. Your SimpleRAG journal, documents, graph, and settings are never read or written.'));
        const rows = node('div', 'cb-settings-danger-row');
        rows.appendChild(button('Clear run history', 'fa-clock-rotate-left', 'clear-history', { danger: true }));
        rows.appendChild(button('Delete all project files', 'fa-trash-can', 'clear-files', { danger: true }));
        danger.appendChild(rows);
        body.appendChild(danger);

        panel.appendChild(body);
        void state;
        return panel;
    }

    function settingRow(label, help, control) {
        const row = node('div', 'cb-setting-row');
        const copy = node('div', 'cb-setting-copy');
        copy.appendChild(node('strong', null, label));
        copy.appendChild(node('p', null, help));
        row.appendChild(copy);
        row.appendChild(control);
        return row;
    }

    function selectControl(key, options, value) {
        const select = node('select', 'cb-input cb-select');
        select.dataset.cbSetting = key;
        options.forEach(option => {
            const item = node('option', null, option.label);
            item.value = option.value;
            if (option.value === value) item.selected = true;
            select.appendChild(item);
        });
        return select;
    }

    function toggleControl(key, value) {
        const label = node('label', 'cb-switch');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.cbSetting = key;
        input.checked = Boolean(value);
        label.appendChild(input);
        label.appendChild(node('i'));
        return label;
    }

    function numberControl(key, value, min, max, step, fractionStep) {
        const input = node('input', 'cb-input cb-number');
        input.type = 'number';
        input.dataset.cbSetting = key;
        input.value = String(value);
        input.min = String(min);
        input.max = String(max);
        input.step = String(fractionStep || step);
        return input;
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

        if (modal.kind === 'file') {
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
                body.appendChild(node('p', 'cb-modal-note', modal.note || `Text files up to ${Math.round(MAX_SOURCE_FILE_BYTES / 1024)} KB. At most ${MAX_SOURCE_FILES} attached files and ${Math.round(MAX_SOURCE_TOTAL_BYTES / 1024)} KB total are sent to the model.`));
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
        node,
        icon,
        button,
        iconButton,
        fileIconFor,
        buildTree,
        renderNav,
        renderRibbon,
        renderList,
        renderAgentPage,
        renderFilesPage,
        renderHistoryPage,
        renderSettingsPage,
        renderViewer,
        renderStep,
        renderMessage,
        renderModal,
        renderToast,
        statusIcon
    });
}());
