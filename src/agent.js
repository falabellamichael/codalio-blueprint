/*
 * Codalio Blueprint — agent runtime.
 *
 * Executes a skill as a visible sequence of steps: clarifying questions, then
 * the lenses/phases, then the document write. Every model turn becomes a step
 * the user can open and read (prompt + streamed output), so the run looks like
 * a Cursor agent trace rather than a single black-box answer.
 */
(function defineBlueprintAgent() {
    'use strict';

    if (window.__codalioBlueprintAgent) return;

    const core = window.__codalioBlueprintCore;
    const skills = window.__codalioBlueprintSkills;

    const MAX_PROMPT_PREVIEW = 4000;
    const MAX_STEP_TEXT = 60000;

    function promptPreview(prompt) {
        const text = String(prompt || '');
        return text.length > MAX_PROMPT_PREVIEW
            ? `${text.slice(0, MAX_PROMPT_PREVIEW)}\n\n… (${(text.length - MAX_PROMPT_PREVIEW).toLocaleString()} more characters)`
            : text;
    }

    function bounded(text) {
        const value = String(text || '');
        return value.length > MAX_STEP_TEXT ? `${value.slice(0, MAX_STEP_TEXT)}\n\n… truncated` : value;
    }

    function makeStep(overrides) {
        return Object.assign({
            id: core.uid('step'),
            kind: 'notice',
            label: '',
            summary: '',
            status: 'pending',
            text: '',
            promptPreview: '',
            error: '',
            open: false,
            startedAt: 0,
            elapsedMs: 0,
            cancelId: ''
        }, overrides || {});
    }

    function finishStep(step, status) {
        step.status = status;
        if (step.startedAt) step.elapsedMs = Date.now() - step.startedAt;
        step.streaming = false;
        step.liveElement = null;
        return step;
    }

    /**
     * Run one model turn as a visible step. The step streams into its own live
     * DOM node so the user watches tokens arrive, exactly like an agent trace.
     */
    async function runModelStep(step, options, hooks) {
        step.startedAt = Date.now();
        step.status = 'running';
        step.promptPreview = promptPreview(options.prompt);
        step.streaming = true;

        const live = document.createElement('div');
        live.className = 'cb-markdown cb-streaming';
        const pre = document.createElement('pre');
        pre.className = 'cb-stream-raw';
        const code = document.createElement('code');
        pre.appendChild(code);
        live.appendChild(pre);
        step.liveElement = live;

        let rendered = '';
        let lastRender = 0;
        const scheduleRender = text => {
            const now = Date.now();
            if (now - lastRender < 90) return;
            lastRender = now;
            code.textContent = text;
            if (hooks && typeof hooks.onStream === 'function') hooks.onStream(step, text);
        };

        if (hooks && typeof hooks.onRender === 'function') hooks.onRender();

        try {
            const result = await core.streamModelTurn({
                systemPrompt: options.systemPrompt,
                message: options.prompt,
                maxOutputTokens: options.maxOutputTokens,
                temperature: options.temperature,
                signal: options.signal,
                cancelId: options.cancelId,
                onDelta: (_delta, fullText) => {
                    rendered = fullText;
                    scheduleRender(fullText);
                }
            });
            step.cancelId = result.cancelId || '';
            step.text = bounded(result.text || rendered);
            step.finishReason = result.finishReason || '';
            if (result.usage) step.usage = result.usage;
            finishStep(step, 'done');
            step.open = true;
            return step;
        } catch (error) {
            if (error && error.code === 'aborted') {
                step.text = bounded(rendered);
                finishStep(step, 'error');
                step.error = 'Stopped by the user.';
                throw error;
            }
            finishStep(step, 'error');
            step.error = String((error && error.message) || 'The model step failed.');
            step.text = bounded(rendered);
            throw error;
        }
    }

    /**
     * Collect the existing project documents a skill wants to read (e.g. a PRD
     * for doc-generation), newest first per folder.
     */
    function collectExistingDocs(folders) {
        const wanted = Array.isArray(folders) ? folders : [];
        const found = {};
        if (!wanted.length) return found;
        const paths = core.listFiles();
        wanted.forEach(folder => {
            const prefix = `${folder}/`;
            const matches = paths
                .filter(path => path.startsWith(prefix))
                .sort((left, right) => {
                    const leftRecord = core.readFile(left);
                    const rightRecord = core.readFile(right);
                    return String(rightRecord && rightRecord.updatedAt).localeCompare(String(leftRecord && leftRecord.updatedAt));
                });
            if (matches.length) {
                const record = core.readFile(matches[0]);
                found[folder] = record ? record.content : '';
                found[`${folder}#path`] = matches[0];
            }
        });
        return found;
    }

    function sourceFilesForModel(projectState) {
        const attached = Array.isArray(projectState.sourceFiles) ? projectState.sourceFiles : [];
        let total = 0;
        const selected = [];
        for (const file of attached) {
            if (!file || typeof file.content !== 'string') continue;
            const bytes = file.content.length;
            if (total + bytes > core.MAX_SOURCE_TOTAL_BYTES) break;
            total += bytes;
            selected.push({
                path: file.path,
                content: file.content,
                lines: file.content.split('\n').length
            });
        }
        return selected;
    }

    function resolveProjectName(skill, input, run) {
        const derived = typeof skill.projectNameFrom === 'function' ? skill.projectNameFrom(input) : '';
        const name = String(derived || run.projectName || '').trim().slice(0, 80);
        if (name) return name;
        const idea = String(input.idea || '').trim();
        const words = idea.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
        return words ? words.replace(/[^\w\s-]/g, '').trim() || 'Untitled project' : 'Untitled project';
    }

    function outputPathFor(skill, phase, meta) {
        if (skill.perPhaseOutput && phase && phase.optional) {
            const folder = (skill.outputFolders || {})[phase.optional] || skill.outputFolder || 'docs';
            const nameFn = (skill.outputFileNames || {})[phase.optional];
            const fileName = typeof nameFn === 'function' ? nameFn(meta) : `${meta.date}-${meta.slug}.md`;
            return `${folder}/${fileName}`;
        }
        const folder = skill.outputFolder || 'docs';
        const fileName = typeof skill.outputFileName === 'function'
            ? skill.outputFileName(meta)
            : `${meta.date}-${meta.slug}.md`;
        return `${folder}/${fileName}`;
    }

    function applyDocumentHeader(document, meta, sourcePrdPath) {
        let text = core.unwrapDocument(document);
        text = text
            .replace(/<Project Name>/g, meta.projectName)
            .replace(/<date>/g, meta.date);
        if (sourcePrdPath) {
            text = text.replace(/`docs\/prd\/<source-prd-filename>`/g, `\`${sourcePrdPath}\``);
            text = text.replace(/<source-prd-filename>/g, sourcePrdPath.split('/').pop());
        }
        return text.trim();
    }

    /**
     * Ask the skill's clarifying questions as visible steps, in the order the
     * source skill defines them. Each question becomes a step the user can read
     * and answer; nothing runs until it is answered or the run is stopped.
     *
     * hooks.askQuestion(step) resolves with the user's answer, or null when the
     * run was stopped. Returning null aborts the whole run.
     */
    async function askClarifyingQuestions(run, skill, emit, render, hooks, signal) {
        const answers = [];
        if (!core.readSettings().askClarifyingQuestions) {
            emit(makeStep({
                kind: 'notice',
                label: 'Clarifying questions skipped',
                summary: 'Turned off in Blueprint settings',
                status: 'skipped',
                text: 'Blueprint went straight to the lenses using only the idea you described. Turn clarifying questions back on in Settings for a tighter result.',
                open: false
            }));
            render();
            return answers;
        }

        const questions = Array.isArray(skill.clarifying) ? skill.clarifying : [];
        for (const question of questions) {
            if (signal && signal.aborted) return null;
            const step = makeStep({
                kind: 'question',
                label: `Clarifying question — ${question.id}`,
                summary: question.question,
                question: question.question,
                options: question.multi || [],
                status: 'running',
                open: true
            });
            emit(step);
            render();

            const answer = hooks && typeof hooks.askQuestion === 'function'
                ? await hooks.askQuestion(step, question)
                : null;

            if (answer === null || answer === undefined) {
                step.status = 'error';
                step.error = 'Stopped before this question was answered.';
                step.open = false;
                core.saveRun(run);
                render();
                return null;
            }

            step.answered = String(answer);
            step.status = 'done';
            step.open = false;
            core.saveRun(run);
            answers.push({ id: question.id, question: question.question, answer: String(answer) });
            render();
        }
        return answers;
    }

    /**
     * Run a skill to completion, emitting steps into run.phases as it goes.
     *
     * hooks:
     *   onRender()            re-render the page after state changed
     *   onStep(step)          a step was added or finished
     *   onStream(step, text)  live model output arrived
     *   askQuestion(step, q)  resolve with the user's answer, or null to stop
     */
    async function runSkill(run, skill, input, hooks) {
        const settings = core.readSettings();
        const emit = step => {
            run.phases.push(step);
            if (hooks && typeof hooks.onStep === 'function') hooks.onStep(step);
            core.saveRun(run);
        };
        const render = () => { if (hooks && typeof hooks.onRender === 'function') hooks.onRender(); };

        // ---- Announce ------------------------------------------------
        const announce = makeStep({
            kind: 'notice',
            label: skill.announce,
            summary: skill.tagline,
            status: 'done',
            text: skill.description,
            open: false
        });
        emit(announce);
        render();

        // ---- Project identity ---------------------------------------
        run.projectName = resolveProjectName(skill, input, run);
        run.slug = core.slugify(run.projectName);
        core.saveRun(run);

        const meta = {
            date: core.todayStamp(),
            slug: run.slug,
            projectName: run.projectName
        };

        // ---- Clarifying questions (one at a time, as visible steps) ----
        const answers = await askClarifyingQuestions(
            run,
            skill,
            emit,
            render,
            hooks || {},
            input.signal
        );
        if (answers === null) {
            const stopped = new core.BlueprintAbort('Stopped during the clarifying questions.');
            throw stopped;
        }
        input.answers = answers;

        // ---- Source requirement gate --------------------------------
        if (skill.requiresSource) {
            const attached = sourceFilesForModel(input);
            if (!attached.length) {
                const blocked = makeStep({
                    kind: 'notice',
                    label: 'Waiting for source',
                    summary: skill.name + ' must read the actual code',
                    status: 'error',
                    text: skill.sourceHint,
                    open: true,
                    error: 'No source attached. Add the files you want evaluated, then run this skill again.'
                });
                emit(blocked);
                render();
                const failure = new core.BlueprintAbort('waiting-for-source');
                failure.code = 'waiting-for-source';
                throw failure;
            }
            input.sourceFiles = attached;
            const listed = makeStep({
                kind: 'notice',
                label: `Reading ${attached.length} attached source file${attached.length === 1 ? '' : 's'}`,
                summary: attached.map(file => file.path).join(', '),
                status: 'done',
                text: attached.map(file => `- \`${file.path}\` — ${file.lines} lines`).join('\n'),
                open: false
            });
            emit(listed);
            render();
        }

        // ---- Existing docs the skill reads --------------------------
        if (skill.readsExistingDocs && skill.readsExistingDocs.length) {
            input.existingDocs = collectExistingDocs(skill.readsExistingDocs);
            const prdPath = input.existingDocs['docs/prd#path'];
            if (skill.requiresPrd && !input.existingDocs['docs/prd']) {
                const blocked = makeStep({
                    kind: 'notice',
                    label: 'No PRD in this project',
                    summary: 'doc-generation needs an existing PRD to work from',
                    status: 'error',
                    text: 'Run **PRD Builder** first, or add an existing PRD at `docs/prd/<name>.md` in the project tree. This skill deliberately does not improvise a PRD.',
                    open: true,
                    error: 'No document found under docs/prd/.'
                });
                emit(blocked);
                render();
                const failure = new core.BlueprintAbort('missing-prd');
                failure.code = 'missing-prd';
                throw failure;
            }
            if (prdPath) {
                const found = makeStep({
                    kind: 'notice',
                    label: `Found source PRD: ${prdPath}`,
                    summary: 'Reusing its target user, scope, and entities instead of re-asking',
                    status: 'done',
                    open: false
                });
                emit(found);
                render();
                input.sourcePrdPath = prdPath;
            }
        }

        // ---- Lenses (multi-lens skills) -----------------------------
        const lensOutputs = {};
        if (skill.multiLens && Array.isArray(skill.lenses) && skill.lenses.length) {
            const planNote = makeStep({
                kind: 'notice',
                label: settings.concurrency === 'parallel'
                    ? `Running ${skill.lenses.length} lenses concurrently`
                    : `Running ${skill.lenses.length} lenses one after another`,
                summary: 'Each lens is a separate model turn with its own output contract',
                status: 'done',
                text: 'The three lenses are independent — none needs another\u2019s output to run. Either way they produce the same three write-ups before synthesis. If you can tell from the final document which lens produced which paragraph, synthesis did not do its job.',
                open: false
            });
            emit(planNote);
            render();

            const lensSteps = skill.lenses.map(lens => makeStep({
                kind: 'lens',
                label: lens.label,
                summary: lens.summary,
                icon: lens.icon,
                lensId: lens.id
            }));
            lensSteps.forEach(step => { run.phases.push(step); });
            core.saveRun(run);
            render();

            const runLens = async (lens, step) => {
                const prompt = lens.buildPrompt({
                    idea: input.idea,
                    answers: input.answers,
                    requirementsText: input.requirementsText
                });
                await runModelStep(step, {
                    prompt,
                    systemPrompt: 'You are a product planning analyst. Follow the output contract exactly and return only the requested Markdown sections.',
                    maxOutputTokens: settings.lensMaxOutputTokens,
                    signal: input.signal
                }, { onRender: render, onStream: () => render() });
                lensOutputs[lens.id] = step.text;
                core.saveRun(run);
            };

            if (settings.concurrency === 'parallel') {
                await Promise.all(skill.lenses.map((lens, index) => runLens(lens, lensSteps[index])));
            } else {
                for (let index = 0; index < skill.lenses.length; index += 1) {
                    await runLens(skill.lenses[index], lensSteps[index]);
                    render();
                }
            }
            input.lensOutputs = lensOutputs;
            render();
        }

        // ---- Phases --------------------------------------------------
        const phaseOutputs = {};
        const writtenPaths = [];
        const phases = Array.isArray(skill.phases) ? skill.phases : [];
        const selectedOptions = Array.isArray(input.selectedOptions) ? input.selectedOptions : null;

        for (const phase of phases) {
            if (phase.optional && selectedOptions && !selectedOptions.includes(phase.optional)) {
                const skipped = makeStep({
                    kind: 'notice',
                    label: `Skipped: ${phase.label}`,
                    summary: 'Not selected for this run',
                    status: 'skipped',
                    open: false
                });
                emit(skipped);
                render();
                continue;
            }

            const step = makeStep({
                kind: phase.kind === 'document' ? 'document' : 'phase',
                label: phase.label,
                summary: phase.summary,
                icon: phase.icon
            });
            emit(step);
            render();

            const prompt = phase.buildPrompt({
                idea: input.idea,
                answers: input.answers,
                requirementsText: input.requirementsText,
                lensOutputs,
                phaseOutputs,
                existingDocs: input.existingDocs,
                sourceFiles: input.sourceFiles
            });

            await runModelStep(step, {
                prompt,
                systemPrompt: 'You are a product planning analyst. Follow the output contract exactly. Return only the requested Markdown, with no preamble.',
                maxOutputTokens: phase.kind === 'document' ? settings.documentMaxOutputTokens : settings.lensMaxOutputTokens,
                signal: input.signal
            }, { onRender: render, onStream: () => render() });

            phaseOutputs[phase.id] = step.text;

            if (phase.kind === 'document') {
                const path = outputPathFor(skill, phase, meta);
                const content = applyDocumentHeader(step.text, meta, input.sourcePrdPath);
                const record = core.writeFile(path, content, { runId: run.id, skill: skill.id });
                writtenPaths.push(path);
                run.writtenPaths = writtenPaths.slice();

                const writeStep = makeStep({
                    kind: 'notice',
                    label: `Wrote ${path}`,
                    summary: record ? `${record.content.length.toLocaleString()} characters` : '',
                    status: 'done',
                    text: `Saved to the Blueprint project at \`${path}\`. Review it before treating it as final — nothing here is written to your SimpleRAG workspace.`,
                    open: false
                });
                emit(writeStep);
                if (settings.autoOpenWrittenDocument) core.setOpenPath(path);
                render();
            }
            core.saveRun(run);
        }

        // ---- Self-review + user review gate --------------------------
        if (writtenPaths.length) {
            const review = makeStep({
                kind: 'notice',
                label: 'Self-review complete — your review gate',
                summary: `${writtenPaths.length} document${writtenPaths.length === 1 ? '' : 's'} written`,
                status: 'done',
                text: [
                    'The skill re-read its own output once with fresh eyes: placeholder text, contradictions between sections, and user stories with no matching MVP line.',
                    '',
                    `**Where the file${writtenPaths.length === 1 ? ' is' : 's are'}:**`,
                    ...writtenPaths.map(path => `- \`${path}\``),
                    '',
                    'Please review before treating this as final. Tell me what to change and I will revise the document in place.'
                ].join('\n'),
                open: true
            });
            emit(review);
        }

        run.status = 'done';
        run.writtenPaths = writtenPaths.slice();
        core.saveRun(run);
        render();
        return { writtenPaths, meta };
    }

    window.__codalioBlueprintAgent = Object.freeze({
        MAX_PROMPT_PREVIEW,
        makeStep,
        askClarifyingQuestions,
        finishStep,
        runModelStep,
        runSkill,
        collectExistingDocs,
        sourceFilesForModel,
        outputPathFor,
        applyDocumentHeader,
        promptPreview,
        bounded
    });
}());
