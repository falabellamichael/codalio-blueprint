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
    const PROJECTS_KEY = 'codalio-blueprint.projects.v1';
    const SETTINGS_KEY = 'codalio-blueprint.settings.v1';
    const REMOVED_KEY = 'codalio-blueprint.removed.v1';
    const PLUGIN_ID = 'codalio-blueprint';

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

    const DEFAULT_SETTINGS = {
        concurrency: 'parallel',
        lensMaxOutputTokens: 4096,
        documentMaxOutputTokens: 8192,
        temperature: 0.3,
        askClarifyingQuestions: true,
        autoOpenWrittenDocument: true
    };

    function readSettings() {
        const settings = { ...DEFAULT_SETTINGS };
        try {
            const raw = window.localStorage.getItem(SETTINGS_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    Object.keys(DEFAULT_SETTINGS).forEach(key => {
                        if (parsed[key] !== undefined) settings[key] = parsed[key];
                    });
                }
            }
        } catch (_) { /* corrupt settings fall back to defaults */ }
        if (settings.concurrency !== 'sequential') settings.concurrency = 'parallel';
        settings.lensMaxOutputTokens = boundedInt(settings.lensMaxOutputTokens, 512, 32768, DEFAULT_SETTINGS.lensMaxOutputTokens);
        settings.documentMaxOutputTokens = boundedInt(settings.documentMaxOutputTokens, 512, 32768, DEFAULT_SETTINGS.documentMaxOutputTokens);
        settings.temperature = boundedFloat(settings.temperature, 0, 1.5, DEFAULT_SETTINGS.temperature);
        settings.askClarifyingQuestions = settings.askClarifyingQuestions !== false;
        settings.autoOpenWrittenDocument = settings.autoOpenWrittenDocument !== false;
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

    function emptyStore() {
        return { version: 1, files: {}, runs: [], openPath: '', activeRunId: '' };
    }

    function readStore() {
        const store = emptyStore();
        try {
            const raw = window.localStorage.getItem(PROJECTS_KEY);
            if (!raw) return store;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return store;
            if (parsed.files && typeof parsed.files === 'object') store.files = parsed.files;
            if (Array.isArray(parsed.runs)) store.runs = parsed.runs.slice(0, 60);
            store.openPath = typeof parsed.openPath === 'string' ? parsed.openPath : '';
            store.activeRunId = typeof parsed.activeRunId === 'string' ? parsed.activeRunId : '';
        } catch (_) { /* corrupt store starts empty */ }
        return store;
    }

    function writeStore(store) {
        try {
            window.localStorage.setItem(PROJECTS_KEY, JSON.stringify({
                version: 1,
                files: store.files,
                runs: store.runs.slice(0, 60),
                openPath: store.openPath,
                activeRunId: store.activeRunId
            }));
            return true;
        } catch (error) {
            console.warn('[codalio-blueprint] unable to persist project state', error);
            return false;
        }
    }

    const store = readStore();

    function listFiles() {
        return Object.keys(store.files)
            .filter(path => store.files[path] && typeof store.files[path].content === 'string')
            .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    }

    function readFile(path) {
        return store.files[path] || null;
    }

    function writeFile(path, content, meta) {
        const cleanPath = String(path || '').replace(/^\/+/, '').trim();
        if (!cleanPath) return null;
        const previous = store.files[cleanPath] || null;
        const now = new Date().toISOString();
        store.files[cleanPath] = {
            path: cleanPath,
            content: String(content === null || content === undefined ? '' : content),
            createdAt: previous ? previous.createdAt : now,
            updatedAt: now,
            runId: (meta && meta.runId) || (previous && previous.runId) || '',
            skill: (meta && meta.skill) || (previous && previous.skill) || ''
        };
        store.openPath = cleanPath;
        writeStore(store);
        return store.files[cleanPath];
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
    // Runs
    // ------------------------------------------------------------------

    function findRun(runId) {
        return store.runs.find(run => run && run.id === runId) || null;
    }

    function activeRun() {
        return findRun(store.activeRunId);
    }

    function saveRun(run) {
        const index = store.runs.findIndex(item => item && item.id === run.id);
        if (index >= 0) store.runs[index] = run;
        else store.runs.unshift(run);
        store.runs = store.runs.slice(0, 60);
        store.activeRunId = run.id;
        writeStore(store);
    }

    function deleteRun(runId) {
        store.runs = store.runs.filter(run => run && run.id !== runId);
        if (store.activeRunId === runId) store.activeRunId = store.runs[0]?.id || '';
        writeStore(store);
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
                thinking += String((event && event.delta) || '');
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

    // ------------------------------------------------------------------
    // Public surface
    // ------------------------------------------------------------------

    window.__codalioBlueprintCore = Object.freeze({
        API_BASE,
        PLUGIN_ID,
        PROJECTS_KEY,
        SETTINGS_KEY,
        REMOVED_KEY,
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
        writeSettings,
        listFiles,
        readFile,
        writeFile,
        deleteFile,
        renameFile,
        setOpenPath,
        findRun,
        activeRun,
        saveRun,
        deleteRun,
        createRun,
        renderMarkdown,
        appendInline,
        streamModelTurn,
        cancelTurn,
        extractJsonObject,
        unwrapDocument,
        writeStore: () => writeStore(store)
    });
}());
