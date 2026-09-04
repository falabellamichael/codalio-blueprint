/*
 * Codalio Blueprint — file previewer.
 *
 * Original Blueprint code. The LAYOUT IDEA is Notepad++'s: a line-number gutter,
 * syntax colouring, and a status bar reporting Ln / Col. Notepad++ itself is a
 * GPL C++ Win32 desktop application with no browser component, so nothing from it
 * is used or could be — this is a from-scratch renderer built for this page.
 *
 *   https://github.com/notepad-plus-plus/notepad-plus-plus
 *
 * Design constraints:
 *
 *   - Read-only. This is a preview of a stored document, not an editor; editing
 *     stays out of scope so the plug-in cannot corrupt its own project files.
 *   - No innerHTML for document text. Every token becomes a text node inside a
 *     span, so model output or an imported source file can never inject markup.
 *   - The gutter must survive BOTH scroll axes: one scroll container with sticky
 *     line numbers, so vertical scroll stays aligned and horizontal scroll on a
 *     long line keeps the numbers on screen.
 *   - Caret position comes from the browser's own hit-testing
 *     (caretRangeFromPoint / caretPositionFromPoint) rather than from character
 *     width arithmetic, which would be wrong for proportional fallbacks.
 */

(function attachCodalioBlueprintPreview() {
    'use strict';

    // ------------------------------------------------------------------
    // DOM helpers
    // ------------------------------------------------------------------

    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined && text !== null && text !== '') {
            element.appendChild(document.createTextNode(String(text)));
        }
        return element;
    }

    function icon(name, extra) {
        const element = document.createElement('i');
        element.className = `fas ${name}${extra ? ` ${extra}` : ''}`;
        element.setAttribute('aria-hidden', 'true');
        return element;
    }

    // ------------------------------------------------------------------
    // Language detection
    // ------------------------------------------------------------------

    /**
     * Extension -> language key. Kept explicit rather than guessed so the status
     * bar names the language the tokenizer actually used.
     */
    const LANGUAGES = {
        markdown: {
            label: 'Markdown',
            icon: 'fa-file-lines',
            extensions: ['md', 'markdown', 'mdown', 'mkd']
        },
        javascript: {
            label: 'JavaScript',
            icon: 'fa-file-code',
            extensions: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte']
        },
        json: { label: 'JSON', icon: 'fa-brackets-curly', extensions: ['json', 'jsonc', 'map'] },
        python: { label: 'Python', icon: 'fa-file-code', extensions: ['py', 'pyi', 'pyw'] },
        css: { label: 'CSS', icon: 'fa-palette', extensions: ['css', 'scss', 'sass', 'less'] },
        markup: { label: 'HTML / XML', icon: 'fa-code', extensions: ['html', 'htm', 'xml', 'svg'] },
        yaml: { label: 'YAML', icon: 'fa-file-lines', extensions: ['yaml', 'yml'] },
        toml: { label: 'TOML / INI', icon: 'fa-file-lines', extensions: ['toml', 'ini', 'cfg', 'conf'] },
        shell: { label: 'Shell', icon: 'fa-terminal', extensions: ['sh', 'bash', 'zsh', 'ps1', 'bat'] },
        sql: { label: 'SQL', icon: 'fa-database', extensions: ['sql'] },
        csv: { label: 'CSV', icon: 'fa-table', extensions: ['csv', 'tsv'] },
        go: { label: 'Go', icon: 'fa-file-code', extensions: ['go'] },
        rust: { label: 'Rust', icon: 'fa-file-code', extensions: ['rs'] },
        clike: { label: 'C family', icon: 'fa-file-code', extensions: ['c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'java', 'kt', 'php', 'rb', 'swift'] },
        text: { label: 'Plain text', icon: 'fa-file', extensions: ['txt', 'log', ''] }
    };

    const BY_EXTENSION = {};
    Object.keys(LANGUAGES).forEach(key => {
        LANGUAGES[key].extensions.forEach(ext => { BY_EXTENSION[ext] = key; });
    });

    function extensionOf(path) {
        const clean = String(path || '');
        const dot = clean.lastIndexOf('.');
        if (dot <= 0 || dot === clean.length - 1) return '';
        return clean.slice(dot + 1).toLowerCase();
    }

    function languageFor(path) {
        const key = BY_EXTENSION[extensionOf(path)];
        return { key: key || 'text', info: LANGUAGES[key || 'text'] };
    }

    /** True when colouring this language is worth the work. */
    function isHighlightable(languageKey) {
        return languageKey !== 'text' && languageKey !== 'csv';
    }

    // ------------------------------------------------------------------
    // Tokenizer
    //
    // One pattern list per language family, tried in order at each position. Each
    // entry names a token class and matches from the current index. Returning a
    // token list (rather than HTML) is what keeps this injection-proof: the
    // renderer turns each match into a text node.
    // ------------------------------------------------------------------

    /** Escape a string for embedding in a RegExp. */
    function escapeForRegex(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function wordPattern(words) {
        return new RegExp(`\\b(?:${words.map(escapeForRegex).join('|')})\\b`);
    }

    const C_KEYWORDS = [
        'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
        'switch', 'case', 'break', 'continue', 'new', 'delete', 'typeof', 'instanceof',
        'class', 'extends', 'super', 'this', 'try', 'catch', 'finally', 'throw', 'await',
        'async', 'yield', 'import', 'export', 'from', 'default', 'as', 'in', 'of', 'void',
        'null', 'undefined', 'true', 'false', 'static', 'get', 'set'
    ];

    const PY_KEYWORDS = [
        'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue',
        'pass', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda',
        'yield', 'global', 'nonlocal', 'assert', 'del', 'in', 'is', 'not', 'and', 'or',
        'None', 'True', 'False', 'self', 'async', 'await'
    ];

    const SQL_KEYWORDS = [
        'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete',
        'create', 'table', 'alter', 'drop', 'index', 'view', 'join', 'inner', 'left', 'right',
        'outer', 'on', 'group', 'by', 'order', 'having', 'limit', 'offset', 'as', 'and', 'or',
        'not', 'null', 'is', 'in', 'between', 'like', 'distinct', 'case', 'when', 'then',
        'else', 'end', 'primary', 'key', 'foreign', 'references', 'default', 'constraint'
    ];

    const GO_KEYWORDS = [
        'package', 'import', 'func', 'return', 'if', 'else', 'for', 'range', 'switch', 'case',
        'default', 'break', 'continue', 'go', 'defer', 'chan', 'select', 'type', 'struct',
        'interface', 'map', 'var', 'const', 'nil', 'true', 'false', 'fallthrough'
    ];

    const RUST_KEYWORDS = [
        'fn', 'let', 'mut', 'const', 'static', 'struct', 'enum', 'trait', 'impl', 'for',
        'while', 'loop', 'if', 'else', 'match', 'return', 'break', 'continue', 'use', 'mod',
        'pub', 'crate', 'self', 'super', 'as', 'in', 'ref', 'move', 'async', 'await',
        'Some', 'None', 'Ok', 'Err', 'true', 'false'
    ];

    /** Compiled rules per language, built once. See toSticky() for why. */
    const rulesCache = new Map();

    /**
     * Clone a pattern as a sticky (`y`) regex.
     *
     * Sticky anchors the match at `lastIndex` without copying the string, which is
     * what makes tokenizing a line O(n) rather than O(n^2). A `^`-anchored rule
     * stays correct: sticky plus `^` can only match at index 0, which is exactly
     * the line-oriented behaviour the markdown and yaml rules want.
     */
    function toSticky(pattern) {
        if (pattern.sticky) return pattern;
        const flags = pattern.flags.replace(/g/g, '');
        return new RegExp(pattern.source, flags.indexOf('y') >= 0 ? flags : `${flags}y`);
    }

    /**
     * Build the ordered rule list for a language key. Order matters: comments and
     * strings are tried before keywords so a keyword inside a string is not
     * coloured as code.
     */
    function rulesFor(languageKey) {
        const cached = rulesCache.get(languageKey);
        if (cached) return cached;
        const compiled = buildRules(languageKey).map(rule => ({
            cls: rule.cls,
            pattern: toSticky(rule.pattern)
        }));
        rulesCache.set(languageKey, compiled);
        return compiled;
    }

    function buildRules(languageKey) {
        const number = { cls: 'tok-number', pattern: /\b(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b/ };
        const identifier = { cls: '', pattern: /[A-Za-z_$][A-Za-z0-9_$]*/ };
        const operator = { cls: 'tok-operator', pattern: /[+\-*/%=<>!&|^~?:]+/ };
        const punctuation = { cls: 'tok-punctuation', pattern: /[{}()[\];,.]/ };
        const whitespace = { cls: '', pattern: /[ \t]+/ };

        const keywordRules = words => [
            { cls: 'tok-keyword', pattern: wordPattern(words) },
            number,
            identifier,
            operator,
            punctuation,
            whitespace
        ];

        switch (languageKey) {
            case 'javascript':
            case 'json':
                return [
                    { cls: 'tok-comment', pattern: /\/\/[^\n]*/ },
                    { cls: 'tok-comment', pattern: /\/\*[\s\S]*?(?:\*\/|$)/ },
                    { cls: 'tok-string', pattern: /"(?:[^"\\\n]|\\.)*"?/ },
                    { cls: 'tok-string', pattern: /'(?:[^'\\\n]|\\.)*'?/ },
                    { cls: 'tok-string', pattern: /`(?:[^`\\]|\\.)*`?/ },
                    { cls: 'tok-property', pattern: /[A-Za-z_$][A-Za-z0-9_$]*(?=\s*:)/ },
                    ...keywordRules(C_KEYWORDS)
                ];
            case 'python':
                return [
                    { cls: 'tok-comment', pattern: /#[^\n]*/ },
                    { cls: 'tok-string', pattern: /"""[\s\S]*?(?:"""|$)/ },
                    { cls: 'tok-string', pattern: /'''[\s\S]*?(?:'''|$)/ },
                    { cls: 'tok-string', pattern: /(?:[rRbBuUfF]{0,2})"(?:[^"\\\n]|\\.)*"?/ },
                    { cls: 'tok-string', pattern: /(?:[rRbBuUfF]{0,2})'(?:[^'\\\n]|\\.)*'?/ },
                    { cls: 'tok-decorator', pattern: /@[A-Za-z_][A-Za-z0-9_.]*/ },
                    { cls: 'tok-keyword', pattern: wordPattern(PY_KEYWORDS) },
                    { cls: 'tok-function', pattern: /(?<=\bdef\s)[A-Za-z_][A-Za-z0-9_]*/ },
                    { cls: 'tok-class', pattern: /(?<=\bclass\s)[A-Za-z_][A-Za-z0-9_]*/ },
                    number, identifier, operator, punctuation, whitespace
                ];
            case 'css':
                return [
                    { cls: 'tok-comment', pattern: /\/\*[\s\S]*?(?:\*\/|$)/ },
                    { cls: 'tok-string', pattern: /"(?:[^"\\\n]|\\.)*"?/ },
                    { cls: 'tok-string', pattern: /'(?:[^'\\\n]|\\.)*'?/ },
                    { cls: 'tok-atrule', pattern: /@[\w-]+/ },
                    { cls: 'tok-property', pattern: /[-\w]+(?=\s*:)/ },
                    { cls: 'tok-selector', pattern: /[.#][-\w]+|::?[-\w]+/ },
                    { cls: 'tok-variable', pattern: /--[-\w]+/ },
                    { cls: 'tok-number', pattern: /[-+]?\b\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch|ex|pt)?\b/ },
                    { cls: 'tok-function', pattern: /[-\w]+(?=\()/ },
                    { cls: 'tok-keyword', pattern: /\b(?:inherit|initial|unset|auto|none|normal|important)\b/ },
                    { cls: 'tok-punctuation', pattern: /[{}();:,]/ },
                    whitespace, identifier
                ];
            case 'markup':
                return [
                    { cls: 'tok-comment', pattern: /<!--[\s\S]*?(?:-->|$)/ },
                    { cls: 'tok-tag', pattern: /<\/?[A-Za-z][-\w:.]*/ },
                    { cls: 'tok-tag', pattern: /\/?>/ },
                    { cls: 'tok-attribute', pattern: /[A-Za-z_:][-\w:.]*(?==)/ },
                    { cls: 'tok-string', pattern: /"(?:[^"]*)"|'(?:[^']*)'/ },
                    { cls: 'tok-entity', pattern: /&[#\w]+;/ },
                    { cls: '', pattern: /[^<&"'/=]+/ },
                    { cls: '', pattern: /[\s\S]/ }
                ];
            case 'yaml':
                return [
                    { cls: 'tok-comment', pattern: /#[^\n]*/ },
                    { cls: 'tok-property', pattern: /^[ \t]*-?[ \t]*[A-Za-z_.$][\w.$-]*(?=\s*:)/m },
                    { cls: 'tok-string', pattern: /"(?:[^"\\\n]|\\.)*"?/ },
                    { cls: 'tok-string', pattern: /'(?:[^'\n]|'')*'?/ },
                    { cls: 'tok-keyword', pattern: /\b(?:true|false|null|yes|no|on|off|~)\b/ },
                    number, identifier, punctuation, whitespace,
                    { cls: '', pattern: /[\s\S]/ }
                ];
            case 'toml':
                return [
                    { cls: 'tok-comment', pattern: /[#;][^\n]*/ },
                    { cls: 'tok-selector', pattern: /^\s*\[[^\]\n]*\]/m },
                    { cls: 'tok-property', pattern: /[A-Za-z_.$][\w.$-]*(?=\s*=)/ },
                    { cls: 'tok-string', pattern: /"(?:[^"\\\n]|\\.)*"?/ },
                    { cls: 'tok-string', pattern: /'(?:[^'\n])*'?/ },
                    { cls: 'tok-keyword', pattern: /\b(?:true|false)\b/ },
                    number, identifier, operator, punctuation, whitespace,
                    { cls: '', pattern: /[\s\S]/ }
                ];
            case 'shell':
                return [
                    { cls: 'tok-comment', pattern: /#[^\n]*/ },
                    { cls: 'tok-string', pattern: /"(?:[^"\\\n]|\\.)*"?/ },
                    { cls: 'tok-string', pattern: /'[^'\n]*'?/ },
                    { cls: 'tok-variable', pattern: /\$\{?[A-Za-z_]\w*\}?|\$[0-9@*#?]/ },
                    { cls: 'tok-keyword', pattern: wordPattern([
                        'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
                        'case', 'esac', 'function', 'return', 'exit', 'in', 'local', 'export',
                        'readonly', 'set', 'unset', 'shift', 'true', 'false'
                    ]) },
                    { cls: 'tok-function', pattern: /\b(?:sudo|cd|ls|cp|mv|rm|mkdir|cat|grep|sed|awk|curl|wget|git|node|python3?|pip3?|npm|echo|printf|test|chmod|chown|find|xargs|tar|zip|unzip|env|source)\b/ },
                    number, identifier, operator, punctuation, whitespace
                ];
            case 'sql':
                return [
                    { cls: 'tok-comment', pattern: /--[^\n]*/ },
                    { cls: 'tok-comment', pattern: /\/\*[\s\S]*?(?:\*\/|$)/ },
                    { cls: 'tok-string', pattern: /'(?:[^']|'')*'?/ },
                    { cls: 'tok-keyword', pattern: wordPattern(SQL_KEYWORDS) },
                    { cls: 'tok-function', pattern: /\b(?:count|sum|avg|min|max|coalesce|nullif|cast|concat|substr|length|upper|lower|now|date|round|abs)(?=\()/i },
                    number, identifier, operator, punctuation, whitespace
                ];
            case 'go':
                return [
                    { cls: 'tok-comment', pattern: /\/\/[^\n]*/ },
                    { cls: 'tok-comment', pattern: /\/\*[\s\S]*?(?:\*\/|$)/ },
                    { cls: 'tok-string', pattern: /"(?:[^"\\\n]|\\.)*"?/ },
                    { cls: 'tok-string', pattern: /`[^`]*`?/ },
                    { cls: 'tok-keyword', pattern: wordPattern(GO_KEYWORDS) },
                    { cls: 'tok-type', pattern: /\b(?:int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|float32|float64|string|bool|byte|rune|error|any)\b/ },
                    number, identifier, operator, punctuation, whitespace
                ];
            case 'rust':
                return [
                    { cls: 'tok-comment', pattern: /\/\/[^\n]*/ },
                    { cls: 'tok-comment', pattern: /\/\*[\s\S]*?(?:\*\/|$)/ },
                    { cls: 'tok-string', pattern: /"(?:[^"\\\n]|\\.)*"?/ },
                    { cls: 'tok-attribute', pattern: /#!?\[[^\]]*\]?/ },
                    { cls: 'tok-keyword', pattern: wordPattern(RUST_KEYWORDS) },
                    { cls: 'tok-type', pattern: /\b(?:u8|u16|u32|u64|usize|i8|i16|i32|i64|isize|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc)\b/ },
                    number, identifier, operator, punctuation, whitespace
                ];
            case 'clike':
                return [
                    { cls: 'tok-comment', pattern: /\/\/[^\n]*/ },
                    { cls: 'tok-comment', pattern: /\/\*[\s\S]*?(?:\*\/|$)/ },
                    { cls: 'tok-comment', pattern: /#[^\n]*/ },
                    { cls: 'tok-string', pattern: /"(?:[^"\\\n]|\\.)*"?/ },
                    { cls: 'tok-string', pattern: /'(?:[^'\\\n]|\\.)*'?/ },
                    { cls: 'tok-keyword', pattern: wordPattern(C_KEYWORDS) },
                    { cls: 'tok-type', pattern: /\b(?:int|long|short|char|float|double|bool|void|unsigned|signed|size_t|string|number)\b/ },
                    number, identifier, operator, punctuation, whitespace
                ];
            case 'markdown':
                return markdownRules();
            default:
                return [{ cls: '', pattern: /[\s\S]/ }];
        }
    }

    /**
     * Markdown rules are line-oriented: the token kind depends on where in the
     * line you are (a leading '#' is a heading, a '#' mid-line is literal). The
     * renderer feeds it one line at a time, so these patterns never span lines.
     */
    function markdownRules() {
        return [
            { cls: 'tok-heading', pattern: /^#{1,6}[ \t]+[^\n]*/ },
            { cls: 'tok-comment', pattern: /^ {0,3}<!--[\s\S]*?(?:-->|$)/ },
            { cls: 'tok-quote', pattern: /^>+[ \t]*[^\n]*/ },
            { cls: 'tok-fence', pattern: /^ {0,3}(?:```|~~~)[^\n]*/ },
            { cls: 'tok-list', pattern: /^ {0,3}(?:[-*+]|\d+[.)])[ \t]+/ },
            { cls: 'tok-hr', pattern: /^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/ },
            { cls: 'tok-table', pattern: /^\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/ },
            { cls: 'tok-code', pattern: /`[^`\n]+`/ },
            { cls: 'tok-bold', pattern: /\*\*[^*\n]+\*\*/ },
            { cls: 'tok-bold', pattern: /__[^_\n]+__/ },
            { cls: 'tok-italic', pattern: /(?<!\*)\*(?!\*)[^*\n]+\*(?!\*)/ },
            { cls: 'tok-italic', pattern: /(?<!_)_(?!_)[^_\n]+_(?!_)/ },
            { cls: 'tok-strike', pattern: /~~[^~\n]+~~/ },
            { cls: 'tok-link', pattern: /!?\[[^\]\n]*\]\([^)\n]*\)?/ },
            { cls: 'tok-link', pattern: /!?\[[^\]\n]*\]\[[^\]\n]*\]?/ },
            { cls: 'tok-url', pattern: /\bhttps?:\/\/[^\s)>\]]+/ },
            { cls: 'tok-tag', pattern: /<\/?[A-Za-z][-\w:.]*(?:\s[^>\n]*)?\/?>/ },
            { cls: 'tok-entity', pattern: /&[#\w]+;/ },
            { cls: 'tok-attribute', pattern: /^={1,}[ \t]*$/ },
            { cls: '', pattern: /[^\s`*_~![<&]+/ },
            { cls: '', pattern: /[\s\S]/ }
        ];
    }

    /**
     * Tokenize one line into [{ cls, text }] whose concatenation is exactly the
     * input. Rules are sticky, so each position is attempted in place — no
     * slicing, no O(n^2).
     *
     * Two invariants keep this safe on hostile input:
     *   - every accepted match must be non-empty, and
     *   - if no rule matches, exactly one character is consumed.
     * Together they guarantee termination and a lossless reconstruction, which the
     * stress test asserts.
     */
    function tokenizeLine(line, rules) {
        const source = String(line === undefined || line === null ? '' : line);
        const tokens = [];
        if (!source.length) return tokens;
        const list = Array.isArray(rules) ? rules : [];
        let index = 0;
        // Progress is guaranteed by the one-character fallback, so this cap only
        // bounds a pathological rule set rather than doing real work.
        const budget = source.length + 64;
        let steps = 0;
        while (index < source.length && steps < budget) {
            steps += 1;
            let matchedText = null;
            let matchedCls = '';
            for (let ruleIndex = 0; ruleIndex < list.length; ruleIndex += 1) {
                const rule = list[ruleIndex];
                if (!rule || !rule.pattern) continue;
                rule.pattern.lastIndex = index;
                const found = rule.pattern.exec(source);
                if (!found || !found[0]) continue;
                matchedText = found[0];
                matchedCls = rule.cls || '';
                break;
            }
            if (matchedText === null) {
                tokens.push({ cls: '', text: source[index] });
                index += 1;
                continue;
            }
            tokens.push({ cls: matchedCls, text: matchedText });
            index += matchedText.length;
        }
        if (index < source.length) tokens.push({ cls: '', text: source.slice(index) });
        return tokens;
    }

    // ------------------------------------------------------------------
    // Renderer
    // ------------------------------------------------------------------

    const MAX_PREVIEW_LINES = 6000;
    const MAX_PREVIEW_CHARS = 400000;

    function splitLines(text) {
        return String(text || '').replace(/\r\n?/g, '\n').split('\n');
    }

    /**
     * Render a document as a Notepad++-style code view.
     *
     * options:
     *   highlight  force colouring on/off (default: follow settings)
     *   wrap       soft-wrap long lines (default: follow settings)
     *   startLine  line to reveal after render (default: none)
     *   onCaret    called with { line, column, char } as the caret moves
     */
    function renderPreview(record, options) {
        const cfg = options || {};
        const path = String((record && record.path) || '');
        const language = languageFor(path);
        const raw = String((record && record.content) || '');

        const wrap = node('div', 'cb-preview');
        wrap.dataset.language = language.key;
        wrap.dataset.path = path;
        if (cfg.wrap === false) wrap.classList.add('cb-preview-nowrap');

        // ---- toolbar -------------------------------------------------
        const toolbar = node('div', 'cb-preview-toolbar');
        const nameWrap = node('div', 'cb-preview-name');
        nameWrap.appendChild(icon(language.info.icon || 'fa-file'));
        nameWrap.appendChild(node('strong', null, path.split('/').pop() || 'Untitled'));
        toolbar.appendChild(nameWrap);

        const tools = node('div', 'cb-preview-tools');
        const highlightOn = cfg.highlight !== false && isHighlightable(language.key);
        tools.appendChild(toggleButton(
            'color',
            'fa-highlighter',
            highlightOn,
            'Syntax colouring',
            isHighlightable(language.key) ? '' : 'Plain text has nothing to colour'
        ));
        tools.appendChild(toggleButton(
            'wrap',
            'fa-text-width',
            cfg.wrap !== false,
            'Word wrap',
            ''
        ));
        tools.appendChild(toggleButton(
            'gutter',
            'fa-list-ol',
            cfg.gutter !== false,
            'Line numbers',
            ''
        ));
        toolbar.appendChild(tools);
        wrap.appendChild(toolbar);

        // ---- document body -------------------------------------------
        const lines = splitLines(raw);
        const truncatedLines = lines.length > MAX_PREVIEW_LINES;
        const truncatedChars = raw.length > MAX_PREVIEW_CHARS;
        const shown = truncatedLines ? lines.slice(0, MAX_PREVIEW_LINES) : lines;

        const scroll = node('div', 'cb-preview-scroll');
        scroll.tabIndex = 0;
        scroll.setAttribute('role', 'document');
        scroll.setAttribute('aria-label', `Preview of ${path}`);

        const code = node('div', 'cb-preview-code');
        const rules = rulesFor(language.key);
        const markdown = language.key === 'markdown';
        // Fenced code inside Markdown is coloured as the language the fence
        // declared, not as prose. `inFence` is the state and `fenceLanguage` the
        // declared hint — they must stay separate, because a bare ``` fence has an
        // empty hint but is still a fence.
        let inFence = false;
        let fenceLanguage = '';

        shown.forEach((line, index) => {
            const row = node('div', 'cb-preview-line');
            row.dataset.line = String(index + 1);

            if (cfg.gutter !== false) {
                const gutter = node('span', 'cb-preview-ln', String(index + 1));
                gutter.setAttribute('aria-hidden', 'true');
                row.appendChild(gutter);
            }

            const cell = node('span', 'cb-preview-text');

            // A fence marker toggles the state. The opening fence carries the
            // language hint; the closing one clears it.
            const fenceMatch = /^ {0,3}(?:```|~~~)\s*([A-Za-z0-9_+-]*)/.exec(line);
            if (fenceMatch) {
                inFence = !inFence;
                fenceLanguage = inFence ? (fenceMatch[1] || '') : '';
            }

            // Choose the rule set for this line. The fence marker itself is chrome
            // rather than content, so it is emitted untouched.
            let useRules = null;
            if (highlightOn) {
                if (markdown && fenceMatch) {
                    useRules = null;
                } else if (markdown && inFence) {
                    useRules = rulesFor(languageKeyFromHint(fenceLanguage));
                } else {
                    useRules = rules;
                }
            }

            if (!line.length) {
                // An empty line still needs height, or the gutter drifts out of
                // alignment with the text below it.
                cell.appendChild(document.createTextNode(''));
                cell.appendChild(node('span', 'cb-preview-empty', '\u00a0'));
            } else if (!useRules) {
                // Colouring off, or the fence marker line: emit the text untouched.
                cell.appendChild(document.createTextNode(line));
            } else {
                appendTokens(cell, tokenizeLine(line, useRules));
            }
            row.appendChild(cell);
            code.appendChild(row);
        });

        scroll.appendChild(code);
        wrap.appendChild(scroll);

        if (truncatedLines || truncatedChars) {
            const notice = node('div', 'cb-preview-truncated');
            notice.appendChild(icon('fa-scissors'));
            notice.appendChild(node('span', null, truncatedLines
                ? `Showing the first ${MAX_PREVIEW_LINES.toLocaleString()} of ${lines.length.toLocaleString()} lines.`
                : `Showing the first ${MAX_PREVIEW_CHARS.toLocaleString()} characters of ${raw.length.toLocaleString()}.`));
            notice.appendChild(node('span', 'cb-preview-truncated-hint', 'Open the full file to read the rest.'));
            wrap.appendChild(notice);
        }

        // ---- status bar ----------------------------------------------
        const status = node('div', 'cb-preview-status');
        const caret = node('span', 'cb-preview-caret', 'Ln 1, Col 1');
        const selection = node('span', 'cb-preview-selection', '');
        const length = node('span', 'cb-preview-stat', `${lines.length.toLocaleString()} lines`);
        const chars = node('span', 'cb-preview-stat', `${raw.length.toLocaleString()} chars`);
        const encoding = node('span', 'cb-preview-stat', 'UTF-8');
        const languageLabel = node('span', 'cb-preview-stat cb-preview-language', language.info.label);
        [caret, selection, spacer(), length, chars, encoding, languageLabel].forEach(item => {
            if (item) status.appendChild(item);
        });
        wrap.appendChild(status);

        // ---- caret tracking ------------------------------------------
        // Uses the browser's own hit-testing. caretRangeFromPoint (WebKit/Blink)
        // and caretPositionFromPoint (Gecko) both exist; without either, fall back
        // to the clicked row with column 1 rather than guessing from widths.
        const caretState = { line: 1, column: 1 };

        function reportCaret() {
            caret.textContent = `Ln ${caretState.line}, Col ${caretState.column}`;
            const lineText = shown[caretState.line - 1];
            selection.textContent = typeof lineText === 'string'
                ? `${lineText.length} chars in line`
                : '';
            if (typeof cfg.onCaret === 'function') {
                try {
                    cfg.onCaret({
                        line: caretState.line,
                        column: caretState.column,
                        char: typeof lineText === 'string' ? lineText[caretState.column - 1] || '' : '',
                        text: typeof lineText === 'string' ? lineText : ''
                    });
                } catch (_) { /* a caret listener must not break the view */ }
            }
        }

        function caretFromEvent(event) {
            const row = event.target && typeof event.target.closest === 'function'
                ? event.target.closest('.cb-preview-line')
                : null;
            const lineNumber = row && row.dataset ? Number(row.dataset.line) : 0;
            if (!lineNumber) return null;
            const textNode = row.querySelector('.cb-preview-text');
            if (!textNode) return { line: lineNumber, column: 1 };

            const doc = textNode.ownerDocument || document;
            let offset = 0;
            if (typeof doc.caretRangeFromPoint === 'function') {
                const range = doc.caretRangeFromPoint(event.clientX, event.clientY);
                if (range && textNode.contains(range.startContainer)) {
                    offset = rangeColumn(textNode, range.startContainer, range.startOffset);
                }
            } else if (typeof doc.caretPositionFromPoint === 'function') {
                const position = doc.caretPositionFromPoint(event.clientX, event.clientY);
                if (position && textNode.contains(position.offsetNode)) {
                    offset = rangeColumn(textNode, position.offsetNode, position.offset);
                }
            }
            return { line: lineNumber, column: Math.max(1, offset + 1) };
        }

        /**
         * Convert a (node, offset) caret position into a column number relative to
         * the line's text, counting every character in preceding siblings.
         */
        function rangeColumn(lineRoot, target, offset) {
            let column = 0;
            const walk = currentNode => {
                if (currentNode === target && currentNode.nodeType === 3) {
                    column += Number(offset) || 0;
                    return true;
                }
                const children = currentNode.childNodes || currentNode.children || [];
                for (let i = 0; i < children.length; i += 1) {
                    const child = children[i];
                    if (child.nodeType === 3) {
                        if (child === target) {
                            column += Number(offset) || 0;
                            return true;
                        }
                        column += String(child.textContent || '').length;
                    } else if (walk(child)) {
                        return true;
                    }
                }
                return false;
            };
            walk(lineRoot);
            return column;
        }

        scroll.addEventListener('click', event => {
            const found = caretFromEvent(event);
            if (!found) return;
            caretState.line = found.line;
            caretState.column = found.column;
            markActiveLine(code, caretState.line);
            reportCaret();
        });

        // Arrow keys move the caret like a viewer should, so the status bar is
        // useful without a mouse.
        scroll.addEventListener('keydown', event => {
            const key = String(event.key || '');
            const moves = { ArrowUp: -1, ArrowDown: 1, PageUp: -20, PageDown: 20, Home: null, End: null };
            if (!(key in moves)) return;
            event.preventDefault();
            const max = shown.length || 1;
            if (moves[key] === null) {
                if (key === 'Home') { caretState.column = 1; }
                else { caretState.column = (shown[caretState.line - 1] || '').length + 1; }
            } else {
                caretState.line = Math.min(max, Math.max(1, caretState.line + moves[key]));
            }
            markActiveLine(code, caretState.line);
            reportCaret();
            const activeRow = code.querySelector(`[data-line="${caretState.line}"]`);
            if (activeRow && typeof activeRow.scrollIntoView === 'function') {
                activeRow.scrollIntoView({ block: 'nearest' });
            }
        });

        markActiveLine(code, 1);
        if (cfg.startLine) {
            const target = Math.min(shown.length || 1, Math.max(1, Number(cfg.startLine) || 1));
            caretState.line = target;
            markActiveLine(code, target);
            const row = code.querySelector(`[data-line="${target}"]`);
            if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
        }
        reportCaret();

        return wrap;
    }

    function spacer() {
        return node('span', 'cb-preview-spacer');
    }

    /**
     * A toolbar toggle. `actionKey` names the setting it flips ('color', 'wrap',
     * 'gutter') and becomes data-cb-action="preview-<key>". It is deliberately not
     * also emitted as a class: nothing styles or queries a per-toggle class, so
     * one identifier (the action) is enough.
     */
    function toggleButton(actionKey, iconName, active, label, disabledReason) {
        const element = node('button', `cb-preview-btn${active ? ' active' : ''}`);
        element.type = 'button';
        element.dataset.cbAction = `preview-${actionKey}`;
        element.setAttribute('aria-pressed', active ? 'true' : 'false');
        element.setAttribute('aria-label', label);
        // A disabled toggle explains why; an enabled one names what it does.
        element.title = disabledReason ? `${label} — ${disabledReason}` : label;
        if (disabledReason) element.disabled = true;
        element.appendChild(icon(iconName));
        return element;
    }

    function markActiveLine(code, lineNumber) {
        const rows = code.children || [];
        for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            if (!row || !row.classList) continue;
            const isActive = Number(row.dataset && row.dataset.line) === Number(lineNumber);
            if (isActive) row.classList.add('cb-preview-active-line');
            else row.classList.remove('cb-preview-active-line');
        }
    }

    function appendTokens(target, tokens) {
        tokens.forEach(token => {
            const text = String(token.text === undefined || token.text === null ? '' : token.text);
            if (!text) return;
            if (!token.cls) {
                target.appendChild(document.createTextNode(text));
                return;
            }
            const span = document.createElement('span');
            span.className = token.cls;
            span.appendChild(document.createTextNode(text));
            target.appendChild(span);
        });
    }

    /**
     * Resolve the language a Markdown fence declared to a rule-set key, so ```js
     * blocks colour as JavaScript rather than as prose. An unrecognised or missing
     * hint falls back to plain text, which still tokenizes losslessly.
     */
    function languageKeyFromHint(hint) {
        const clean = String(hint || '').trim().toLowerCase();
        if (!clean) return 'text';
        const aliases = {
            js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript',
            node: 'javascript', jsonc: 'json', py: 'python', python3: 'python',
            sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', shell: 'shell',
            yml: 'yaml', html: 'markup', xml: 'markup', htm: 'markup', c: 'clike',
            cpp: 'clike', 'c++': 'clike', cs: 'clike', csharp: 'clike', java: 'clike',
            kt: 'clike', php: 'clike', rb: 'clike', ruby: 'clike', swift: 'clike',
            ini: 'toml', conf: 'toml', cfg: 'toml', scss: 'css', sass: 'css', less: 'css',
            postgres: 'sql', mysql: 'sql', sqlite: 'sql', golang: 'go', rs: 'rust',
            markdown: 'markdown', md: 'markdown', text: 'text', plain: 'text'
        };
        if (aliases[clean]) return aliases[clean];
        return BY_EXTENSION[clean] || 'text';
    }

    /** Read-only summary used by the viewer toolbar and tests. */
    function describePreview(record) {
        const path = String((record && record.path) || '');
        const language = languageFor(path);
        const raw = String((record && record.content) || '');
        const lines = splitLines(raw);
        return {
            path,
            language: language.key,
            languageLabel: language.info.label,
            icon: language.info.icon || 'fa-file',
            lines: lines.length,
            chars: raw.length,
            highlightable: isHighlightable(language.key),
            truncated: lines.length > MAX_PREVIEW_LINES || raw.length > MAX_PREVIEW_CHARS
        };
    }

    window.__codalioBlueprintPreview = Object.freeze({
        renderPreview,
        describePreview,
        languageFor,
        extensionOf,
        isHighlightable,
        tokenizeLine,
        rulesFor,
        splitLines,
        LANGUAGES,
        BY_EXTENSION,
        MAX_PREVIEW_LINES,
        MAX_PREVIEW_CHARS
    });
})();
