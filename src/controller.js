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

    if (!core || !skills || !agent || !ui || !MANIFEST) {
        console.error('[codalio-blueprint] incomplete package: a required module did not load.');
        return;
    }

    const host = window.RAGWorkspaceExtensions;
    if (!host || typeof host.registerController !== 'function' || typeof host.registerManifest !== 'function') {
        console.error('[codalio-blueprint] the SimpleRAG extension host is unavailable.');
        return;
    }

    // ------------------------------------------------------------------
    // Runtime state (never persisted except through core's own keys)
    // ------------------------------------------------------------------

    const runtime = {
        context: null,
        mounted: false,
        active: false,
        folder: 'cb-agent',
        busy: false,
        draft: '',
        hint: '',
        showSettings: false,
        viewerMode: 'preview',
        expanded: new Set(['docs', 'docs/prd']),
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
        clearHistory: () => confirmClearHistory()
    };

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
        return {
            folder: runtime.folder,
            busy: runtime.busy,
            draft: runtime.draft,
            hint: runtime.hint,
            viewerMode: runtime.viewerMode,
            expanded: runtime.expanded,
            selectedSkillId: runtime.selectedSkillId,
            messages: runtime.messages,
            runs: runtime.runs,
            runCount: runtime.runs.length,
            activeRunId: runtime.activeRunId,
            projectName: runtime.projectName,
            sourceFiles: runtime.sourceFiles,
            openPath: core.store.openPath,
            pendingQuestion: runtime.pendingQuestion,
            run: runtime.currentRun,
            modal: runtime.modal,
            toast: runtime.toast,
            handlers
        };
    }

    function hostElements() {
        return (runtime.context && runtime.context.elements) || null;
    }

    function renderPage() {
        const elements = hostElements();
        if (!elements || !elements.settingsContainer) return;
        if (runtime.context && runtime.context.state && runtime.context.state.app !== APP_ID) return;

        const container = elements.settingsContainer;
        const previousScroll = captureScroll();
        container.innerHTML = '';

        let page;
        if (runtime.folder === 'cb-files') page = ui.renderFilesPage(stateSnapshot());
        else if (runtime.folder === 'cb-history') page = ui.renderHistoryPage(stateSnapshot());
        else if (runtime.folder === 'cb-settings') page = ui.renderSettingsPage(stateSnapshot());
        else page = ui.renderAgentPage(stateSnapshot());

        container.appendChild(page);
        if (runtime.modal) container.appendChild(ui.renderModal(stateSnapshot()));
        if (runtime.toast) container.appendChild(ui.renderToast(stateSnapshot()));

        restoreScroll(previousScroll);
        if (!runtime.busy && runtime.folder === 'cb-agent' && !runtime.modal) focusComposer(true);
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

    function scrollTranscriptToEnd() {
        const elements = hostElements();
        const transcript = elements && elements.settingsContainer
            ? elements.settingsContainer.querySelector('[data-cb-role="transcript"]')
            : null;
        if (transcript) transcript.scrollTop = transcript.scrollHeight;
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

    function goToSection(id) {
        runtime.folder = id;
        const context = runtime.context;
        if (context && context.state) context.state.folder = id;
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

    function setToast(text, tone) {
        clearTimeout(runtime.toastTimer);
        runtime.toast = text ? { text, tone: tone || 'info' } : null;
        if (text) {
            runtime.toastTimer = setTimeout(() => {
                runtime.toast = null;
                if (runtime.mounted) renderPage();
            }, 4200);
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

    function rebuildMessagesFromRun(run) {
        runtime.messages = [];
        if (!run) return;
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

    function startNewRun() {
        if (runtime.busy) {
            setToast('Stop the current run before starting a new one.', 'warn');
            return;
        }
        runtime.currentRun = null;
        runtime.activeRunId = '';
        runtime.messages = [];
        runtime.pendingQuestion = null;
        runtime.folder = 'cb-agent';
        const context = runtime.context;
        if (context && context.state) context.state.folder = 'cb-agent';
        runtime.draft = '';
        renderHostSurfaces();
        renderPage();
        focusComposer();
    }

    async function stopRun() {
        if (!runtime.busy) return;
        const generation = runtime.generation;
        runtime.generation += 1;
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

        const generation = runtime.generation;
        const stale = () => generation !== runtime.generation;

        const input = {
            idea,
            answers: [],
            signal: abortController.signal,
            requirementsText: idea
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
                // The agent owns the question sequence; the page only surfaces it.
                askQuestion: async step => {
                    runtime.pendingQuestion = {
                        stepId: step.id,
                        question: step.question,
                        id: step.label
                    };
                    bindAssistantSteps();
                    renderPage();
                    const answer = await waitForAnswer(controller.signal);
                    runtime.pendingQuestion = null;
                    return answer;
                }
            });

            if (stale()) return;
            assistantMessage.paths = result.writtenPaths;
            assistantMessage.text = result.writtenPaths.length
                ? 'Run complete. Every document is in the project tree — review before treating it as final.'
                : 'Run complete.';
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
            if (!stale()) {
                assistantMessage.busy = false;
                runtime.busy = false;
                runtime.hint = '';
                runtime.pendingQuestion = null;
                runtime.currentController = null;
                loadRuns();
                bindAssistantSteps();
                renderHostSurfaces();
                renderPage();
                scrollTranscriptToEnd();
            }
        }
    }

    async function sendMessage() {
        if (runtime.busy) return;
        const elements = hostElements();
        const composer = elements && elements.settingsContainer
            ? elements.settingsContainer.querySelector('[data-cb-role="composer"]')
            : null;
        const text = String((composer && composer.value) || runtime.draft || '').trim();
        if (!text) {
            setToast('Describe your idea first.', 'warn');
            focusComposer();
            return;
        }
        runtime.draft = '';

        // A pending clarifying question consumes the message as an answer.
        if (runtime.pendingQuestion && runtime.answerResolver) {
            const resolver = runtime.answerResolver;
            runtime.pendingQuestion = null;
            renderPage();
            resolver(text);
            return;
        }

        runtime.messages.push({
            id: core.uid('msg'),
            role: 'user',
            at: new Date().toISOString(),
            text
        });
        renderPage();
        scrollTranscriptToEnd();
        await runSelectedSkill(text);
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
            await agent.runModelStep(step, {
                systemPrompt: 'You are a product planning analyst revising one document. Return only the complete revised Markdown document, with no preamble and no commentary.',
                prompt: [
                    'Revise the document below according to the instruction, then return the COMPLETE revised document.',
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
                core.saveRun(reviseRun);
                loadRuns();
                renderHostSurfaces();
                renderPage();
            }
        }
    }

    // ------------------------------------------------------------------
    // Files
    // ------------------------------------------------------------------

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
        runtime.modal = null;
        setToast(`Attached ${path}.`, 'success');
        renderHostSurfaces();
        renderPage();
        return true;
    }

    function removeSourceFile(path) {
        runtime.sourceFiles = runtime.sourceFiles.filter(file => file.path !== path);
        core.deleteFile(path);
        setToast(`Detached ${path}.`, 'info');
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
                runtime.folder = 'cb-files';
                const context = runtime.context;
                if (context && context.state) context.state.folder = 'cb-files';
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

    function isBlueprintPage() {
        const context = runtime.context;
        return Boolean(context && context.state && context.state.app === APP_ID);
    }

    function findAction(target) {
        return target && target.closest ? target.closest('[data-cb-action]') : null;
    }

    function onClick(event) {
        if (!isBlueprintPage()) return;
        const target = findAction(event.target);
        if (!target) return;
        if (runtime.modal && !target.closest('.cb-modal') && target.dataset.cbAction !== 'close-modal') {
            return;
        }
        const action = target.dataset.cbAction;
        event.preventDefault();
        event.stopPropagation();

        switch (action) {
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
            case 'toggle-step': {
                const step = findStep(target.dataset.stepId);
                if (step) { step.open = !step.open; renderPage(); }
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
            case 'toggle-folder': {
                const path = target.dataset.path || '';
                if (runtime.expanded.has(path)) runtime.expanded.delete(path);
                else runtime.expanded.add(path);
                renderHostSurfaces();
                renderPage();
                return;
            }
            case 'expand-all': {
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
                renderHostSurfaces();
                renderPage();
                return;
            case 'open-file': {
                const path = target.dataset.path || '';
                if (!core.readFile(path)) {
                    setToast(`${path} is not in the project.`, 'warn');
                    return;
                }
                core.setOpenPath(path);
                runtime.viewerMode = 'preview';
                runtime.folder = 'cb-files';
                const context = runtime.context;
                if (context && context.state) context.state.folder = 'cb-files';
                renderHostSurfaces();
                renderPage();
                return;
            }
            case 'viewer-toggle': {
                runtime.viewerMode = runtime.viewerMode === 'source' ? 'preview' : 'source';
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
            const settings = core.readSettings();
            const key = target.dataset.cbSetting;
            if (target.type === 'checkbox') settings[key] = target.checked;
            else if (target.type === 'number') settings[key] = Number(target.value);
            else settings[key] = target.value;
            core.writeSettings(settings);
            renderHostSurfaces();
            return;
        }
    }

    function onChange(event) {
        if (!isBlueprintPage() || !runtime.modal) return;
        const target = event.target;
        if (!target || target.dataset.cbField !== 'file') return;
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
            loadRuns();
            if (runtime.currentRun) rebuildMessagesFromRun(runtime.currentRun);
            runtime.selectedSkillId = (runtime.currentRun && runtime.currentRun.skillId) || runtime.selectedSkillId;
        },

        activate(context) {
            runtime.context = context || runtime.context;
            runtime.active = true;
            runtime.generation += 1;
            ensureHostRecord();
            loadRuns();
            if (!runtime.messages.length && runtime.currentRun) rebuildMessagesFromRun(runtime.currentRun);
            runtime.folder = 'cb-agent';
            if (runtime.context && runtime.context.state) runtime.context.state.folder = 'cb-agent';
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
        },

        unmount() {
            runtime.active = false;
            runtime.mounted = false;
            runtime.generation += 1;
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
                activeRunId: runtime.activeRunId
            };
        },

        restoreState(value) {
            if (!value || typeof value !== 'object') return;
            if (typeof value.section === 'string' && ui.SECTIONS.some(section => section.id === value.section)) {
                runtime.folder = value.section;
            }
            if (skills.getSkill(value.skillId)) runtime.selectedSkillId = value.skillId;
            if (value.viewerMode === 'source' || value.viewerMode === 'preview') runtime.viewerMode = value.viewerMode;
            if (typeof value.openPath === 'string') core.setOpenPath(value.openPath);
            if (Array.isArray(value.expanded)) runtime.expanded = new Set(value.expanded.map(String));
            if (typeof value.activeRunId === 'string') runtime.activeRunId = value.activeRunId;
        },

        onThemeChanged() {
            if (runtime.active) renderPage();
        },

        onAccentChanged() {
            if (runtime.active) renderPage();
        },

        onConnectivityChanged(detail) {
            if (!runtime.active) return;
            const online = !detail || detail.online !== false;
            runtime.hint = online
                ? selectedSkill().tagline
                : 'Offline — Blueprint needs the model endpoint, but your project files stay available.';
            renderPage();
        },

        onFolderChanged(id) {
            runtime.folder = String(id || 'cb-agent');
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
