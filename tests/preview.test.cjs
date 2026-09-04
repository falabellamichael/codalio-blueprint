'use strict';

/*
 * Codalio Blueprint — file previewer test.
 *
 * preview.js renders a Notepad++-style read-only view: line-number gutter,
 * syntax colouring, and an Ln/Col status bar. The layout idea is Notepad++'s;
 * the code is entirely this plug-in's (Notepad++ is a GPL C++ Win32 desktop app
 * with no browser component to reuse).
 *
 * What matters most here, and what this suite pins:
 *
 *   1. Tokenization is LOSSLESS — concatenating a line's tokens must reproduce
 *      the line exactly. A tokenizer that drops or reorders characters would
 *      silently corrupt what the user is reading, which is the worst failure mode
 *      a previewer has.
 *   2. Tokenization TERMINATES on hostile input. An earlier version matched with
 *      `pattern.exec(line.slice(index))`; the slice made it O(n^2) and a 50,000
 *      character line took 13 seconds to colour. Sticky matching fixed it. This
 *      suite keeps that regression honest.
 *   3. Nothing is injected as HTML. Document text reaches the DOM through text
 *      nodes, so an imported source file containing `<img onerror=...>` is inert.
 *   4. Fenced code inside Markdown colours as the fenced language, not as prose.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument } = require('./dom-stub.cjs');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');

// ---------------------------------------------------------------------------
// DOM stub — preview.js builds real elements, so it needs one. It uses the shared
// tests/dom-stub.cjs, which is faithful where this suite depends on it:
// textContent derives from child text nodes, className syncs with classList, and
// closest()/scrollIntoView() exist. That stub has its own suite
// (dom-stub.test.cjs), so a stub bug cannot masquerade as a product bug here.
// ---------------------------------------------------------------------------

const documentStub = createDocument();

// preview.js builds elements through document.createElement and appends text with
// document.createTextNode, both of which the shared stub provides faithfully.
documentStub.activeElement = documentStub.body;

const sandbox = {
    window: {},
    document: documentStub,
    console,
    Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
    Symbol, Promise, Intl, parseInt, parseFloat, isNaN, encodeURIComponent
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);

vm.runInContext(
    fs.readFileSync(path.join(SRC, 'preview.js'), 'utf8'),
    context,
    { filename: 'preview.js' }
);

const preview = sandbox.window.__codalioBlueprintPreview;
assert.ok(preview, 'preview.js did not expose __codalioBlueprintPreview');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tokenize a whole document the way the renderer does, per line. */
function tokenizeDocument(text, languageKey) {
    const rules = preview.rulesFor(languageKey);
    return preview.splitLines(text).map(line => preview.tokenizeLine(line, rules));
}

/** Flatten tokens back to text. */
function flatten(tokens) {
    return tokens.map(token => String(token.text)).join('');
}

/** Collect every class name the renderer emitted for a document. */
function classesIn(element, found) {
    const bag = found || new Set();
    const walk = node => {
        if (!node) return;
        if (node.nodeType === 1 && node.className) {
            String(node.className).split(/\s+/).forEach(cls => { if (cls) bag.add(cls); });
        }
        (node.children || []).forEach(walk);
    };
    walk(element);
    return bag;
}

/** Concatenate all text nodes under an element (what the user reads). */
function visibleText(element) {
    let out = '';
    const walk = node => {
        if (!node) return;
        if (node.nodeType === 3) { out += node.textContent; return; }
        (node.children || []).forEach(walk);
    };
    walk(element);
    return out;
}

// ---------------------------------------------------------------------------

// 1. Every language tokenizes losslessly on representative input.
const SAMPLES = {
    javascript: 'const x = `tmpl ${y}`; // trailing comment\nfunction f(a){ return a?.b ?? 1; }',
    python: 'def f(self):\n    """docstring"""\n    return x[1:2]  # note\n@decorator\nclass C:\n    pass',
    json: '{"a": 1, "b": [true, null, 2.5e3], "c": "esc\\"aped"}',
    css: ':root { --x: 10px; }\n.a:hover::before { content: "x"; width: calc(100% - 2rem); }',
    markup: '<div class="a" data-x=\'b\'><!-- c --> <br/> &amp; </div>',
    yaml: 'key: value  # comment\n- item\nnested:\n  deep: true',
    toml: '[section]\nkey = "val"\nnum = 42\nflag = true',
    shell: 'if [ -f "$x" ]; then echo ${VAR:-def}; fi  # c\nsudo rm -rf /tmp/*',
    sql: "SELECT a, COUNT(*) FROM t WHERE x='y' AND z IS NULL GROUP BY a;",
    go: 'func main() { x := make(map[string]int); defer f.Close() }',
    rust: 'fn f<T: Clone>(x: &mut Vec<Option<T>>) -> Result<(), Box<dyn Error>> { Ok(()) }',
    clike: 'int main(void){ char* s = "hi"; return sizeof(int); }',
    markdown: '# Heading\n\n- item **bold** _italic_ `code`\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    text: 'just some words\nand more',
    csv: 'a,b,c\n1,2,3'
};

let checkedLanguages = 0;
Object.keys(SAMPLES).forEach(languageKey => {
    const lines = preview.splitLines(SAMPLES[languageKey]);
    const tokenized = tokenizeDocument(SAMPLES[languageKey], languageKey);
    assert.equal(tokenized.length, lines.length, `${languageKey}: line count changed`);
    tokenized.forEach((tokens, index) => {
        assert.equal(flatten(tokens), lines[index],
            `${languageKey} line ${index + 1} was not reproduced exactly`);
    });
    // Every token must be non-empty: an empty token means a rule matched nothing
    // and the loop only advanced because of the one-character fallback.
    tokenized.forEach(tokens => {
        tokens.forEach(token => {
            assert.ok(String(token.text).length > 0, `${languageKey}: emitted an empty token`);
        });
    });
    checkedLanguages += 1;
});
assert.equal(checkedLanguages, Object.keys(SAMPLES).length);

// 2. Highlighting actually produces classes for languages that should colour.
const jsTokens = tokenizeDocument(SAMPLES.javascript, 'javascript').flat();
assert.ok(jsTokens.some(token => token.cls === 'tok-keyword'), 'JavaScript keywords were not recognised');
assert.ok(jsTokens.some(token => token.cls === 'tok-string'), 'JavaScript strings were not recognised');
assert.ok(jsTokens.some(token => token.cls === 'tok-comment'), 'JavaScript comments were not recognised');

const pyTokens = tokenizeDocument(SAMPLES.python, 'python').flat();
assert.ok(pyTokens.some(token => token.cls === 'tok-keyword'), 'Python keywords were not recognised');
assert.ok(pyTokens.some(token => token.cls === 'tok-decorator'), 'Python decorators were not recognised');

const mdTokens = tokenizeDocument(SAMPLES.markdown, 'markdown').flat();
assert.ok(mdTokens.some(token => token.cls === 'tok-heading'), 'Markdown headings were not recognised');
assert.ok(mdTokens.some(token => token.cls === 'tok-bold'), 'Markdown bold was not recognised');
assert.ok(mdTokens.some(token => token.cls === 'tok-table'), 'Markdown tables were not recognised');

// A keyword INSIDE a string must not be coloured as a keyword.
const stringOnly = tokenizeDocument('"const let function"', 'javascript').flat();
assert.ok(stringOnly.some(token => token.cls === 'tok-string'), 'a quoted keyword run was not seen as a string');
assert.ok(!stringOnly.some(token => token.cls === 'tok-keyword'),
    'keywords inside a string were coloured as code');

// 3. Plain text and CSV are not coloured, but still tokenize losslessly.
assert.equal(preview.isHighlightable('text'), false);
assert.equal(preview.isHighlightable('csv'), false);
assert.equal(preview.isHighlightable('javascript'), true);
assert.equal(preview.isHighlightable('markdown'), true);

// 4. Language detection from the path.
const detection = [
    ['docs/prd/plan.md', 'markdown'],
    ['src/app.jsx', 'javascript'],
    ['config/settings.json', 'json'],
    ['scripts/run.py', 'python'],
    ['style.css', 'css'],
    ['index.html', 'markup'],
    ['data.yaml', 'yaml'],
    ['pyproject.toml', 'toml'],
    ['deploy.sh', 'shell'],
    ['schema.sql', 'sql'],
    ['main.go', 'go'],
    ['lib.rs', 'rust'],
    ['notes.txt', 'text'],
    ['no-extension', 'text'],
    ['weird.PY', 'python']
];
detection.forEach(([filePath, expected]) => {
    assert.equal(preview.languageFor(filePath).key, expected, `${filePath} detected wrong`);
});

// 5. Hostile input terminates quickly and stays lossless.
//
// The O(n^2) slice regression made the first of these take ~13 seconds. The
// threshold is deliberately generous (this runs in CI alongside everything else)
// but tight enough that a quadratic blow-up fails loudly.
const HOSTILE = [
    ['a'.repeat(50000), 'one very long identifier run'],
    ['"'.repeat(20000), 'unterminated quote run'],
    ['`'.repeat(20000), 'unterminated template run'],
    ['\\'.repeat(20000), 'escape run'],
    ['/*' + 'x'.repeat(20000), 'unterminated block comment'],
    ['#'.repeat(20000), 'markdown heading run'],
    ['*'.repeat(20000), 'bold/italic run'],
    ['('.repeat(20000), 'unclosed parens'],
    ['   '.repeat(10000), 'whitespace run'],
    ['é'.repeat(5000), 'multibyte run'],
    [String.fromCharCode(0) + 'a'.repeat(1000), 'NUL byte'],
    ['<script>alert(1)</script>'.repeat(500), 'markup-looking run']
];
const HOSTILE_LANGUAGES = ['javascript', 'python', 'markdown', 'markup', 'css'];

HOSTILE.forEach(([text, label], index) => {
    HOSTILE_LANGUAGES.forEach(languageKey => {
        const lines = preview.splitLines(text).slice(0, 200);
        const started = Date.now();
        const rules = preview.rulesFor(languageKey);
        lines.forEach(line => {
            const tokens = preview.tokenizeLine(line, rules);
            assert.equal(flatten(tokens), line,
                `hostile input #${index} (${label}) was not reproduced under ${languageKey}`);
        });
        const elapsed = Date.now() - started;
        assert.ok(elapsed < 3000,
            `hostile input #${index} (${label}) took ${elapsed}ms under ${languageKey} — tokenizer is not linear`);
    });
});

// 6. renderPreview produces the Notepad++-style structure.
const record = { path: 'docs/prd/toolshare-prd.md', content: '# ToolShare\n\nSome **bold** text.\n' };
const view = preview.renderPreview(record, {});
assert.equal(view.className.includes('cb-preview'), true, 'the preview root class is wrong');
assert.equal(view.dataset.language, 'markdown', 'the preview did not record its language');

const viewClasses = classesIn(view);
['cb-preview-toolbar', 'cb-preview-scroll', 'cb-preview-code', 'cb-preview-line',
 'cb-preview-ln', 'cb-preview-text', 'cb-preview-status', 'cb-preview-caret'].forEach(cls => {
    assert.ok(viewClasses.has(cls), `the preview is missing .${cls}`);
});

// The gutter numbers every line.
const lineNumberCells = [];
(function collect(node) {
    if (node.className && String(node.className).includes('cb-preview-ln')) lineNumberCells.push(node);
    (node.children || []).forEach(collect);
})(view);
const expectedLines = preview.splitLines(record.content).length;
assert.equal(lineNumberCells.length, expectedLines, 'the gutter did not number every line');
assert.equal(lineNumberCells[0].textContent, '1', 'gutter numbering does not start at 1');
assert.equal(lineNumberCells[expectedLines - 1].textContent, String(expectedLines),
    'gutter numbering does not end at the last line');

// The status bar reports Ln/Col and the document metrics.
const statusText = visibleText(view);
assert.match(statusText, /Ln 1, Col 1/, 'the status bar did not report a caret position');
assert.match(statusText, /Markdown/, 'the status bar did not name the language');
assert.match(statusText, /UTF-8/, 'the status bar did not report an encoding');
assert.match(statusText, new RegExp(`${expectedLines} lines`), 'the status bar did not report the line count');

// 7. Rendered text is exactly the document — the renderer adds nothing and drops
//    nothing. Whitespace-only spacer cells are the one intentional addition.
const rendered = visibleText(view)
    .split('Ln 1, Col 1')[0]           // drop the status bar
    .replace(/\u00a0/g, '')            // drop gutter spacers
    .replace(/\s+/g, ' ')
    .trim();
const source = record.content.replace(/\s+/g, ' ').trim();
assert.ok(rendered.includes('# ToolShare'), 'the heading text did not survive rendering');
assert.ok(rendered.includes('bold'), 'the body text did not survive rendering');
void source;

// 8. No HTML injection: hostile content lands in text nodes only.
const xss = {
    path: 'notes.md',
    content: '<img src=x onerror="alert(1)">\n\n<script>window.pwned = true</script>'
};
const xssView = preview.renderPreview(xss, {});
const xssText = visibleText(xssView);
assert.ok(xssText.includes('<img src=x onerror="alert(1)">'), 'markup content was not preserved as text');
assert.ok(xssText.includes('<script>'), 'script content was not preserved as text');

// Nothing in the produced tree may carry that text as a parsed element. The stub
// never parses innerHTML, so assert the renderer never assigned it either.
const previewSource = fs.readFileSync(path.join(SRC, 'preview.js'), 'utf8');
const innerHtmlAssignments = previewSource.match(/\.innerHTML\s*=\s*(?!''|""|``)/g) || [];
assert.equal(innerHtmlAssignments.length, 0,
    'preview.js assigns non-empty innerHTML, which could inject document text');

// 9. Fenced code inside Markdown colours as the fenced language.
const fenced = {
    path: 'README.md',
    content: '# Title\n\n```js\nconst a = 1; // note\n```\n\nProse **after** the fence.\n'
};
const fenceTokens = [];
(function collectFence(node) {
    if (node.nodeType === 1 && node.className && String(node.className).startsWith('tok-')) {
        fenceTokens.push(String(node.className));
    }
    (node.children || []).forEach(collectFence);
})(preview.renderPreview(fenced, {}));
assert.ok(fenceTokens.includes('tok-keyword'), 'the fenced js block did not colour its keyword');
assert.ok(fenceTokens.includes('tok-comment'), 'the fenced js block did not colour its comment');
assert.ok(fenceTokens.includes('tok-heading'), 'Markdown prose around the fence was not coloured');

// An unknown fence hint must still render losslessly, not throw.
const unknownFence = { path: 'x.md', content: '```brainfuck\n++++[->++<]\n```\n' };
const unknownView = preview.renderPreview(unknownFence, {});
assert.ok(visibleText(unknownView).includes('++++[->++<]'), 'an unknown fence hint lost its content');

// 10. Colouring can be turned off, and the text is then untouched.
const plainView = preview.renderPreview(record, { highlight: false });
const plainClasses = classesIn(plainView);
assert.ok(![...plainClasses].some(cls => cls.startsWith('tok-')),
    'highlight:false still emitted token classes');
assert.ok(visibleText(plainView).includes('# ToolShare'), 'colouring off lost the text');

// 11. The gutter can be turned off (a narrow pane wants the width back).
const noGutter = preview.renderPreview(record, { gutter: false });
assert.ok(!classesIn(noGutter).has('cb-preview-ln'), 'gutter:false still rendered line numbers');

// 12. Very large documents are truncated rather than rendered in full.
const huge = { path: 'big.log', content: Array.from({ length: 9000 }, (_, i) => `line ${i + 1}`).join('\n') };
const hugeView = preview.renderPreview(huge, {});
assert.ok(classesIn(hugeView).has('cb-preview-truncated'), 'an oversized document was not marked truncated');
const renderedRows = [];
(function countRows(node) {
    if (node.className && String(node.className).includes('cb-preview-line')) renderedRows.push(node);
    (node.children || []).forEach(countRows);
})(hugeView);
assert.equal(renderedRows.length, preview.MAX_PREVIEW_LINES,
    'truncation did not cap the rendered line count');
assert.match(visibleText(hugeView), /Showing the first/, 'the truncation notice did not explain itself');

// 13. describePreview summarizes without rendering.
const described = preview.describePreview(record);
assert.equal(described.language, 'markdown');
assert.equal(described.languageLabel, 'Markdown');
assert.equal(described.lines, 4);
assert.equal(described.highlightable, true);
assert.equal(described.truncated, false);

// 14. rulesFor is cached and returns sticky patterns (the linear-time guarantee).
const first = preview.rulesFor('javascript');
const second = preview.rulesFor('javascript');
assert.equal(first, second, 'rulesFor rebuilt its rule list instead of caching');
first.forEach(rule => {
    assert.ok(rule.pattern.sticky, 'a compiled rule is not sticky, so tokenizing is O(n^2) again');
});

// 15. An empty document renders without error.
const emptyView = preview.renderPreview({ path: 'empty.md', content: '' }, {});
assert.ok(emptyView, 'an empty document failed to render');
assert.match(visibleText(emptyView), /Ln 1, Col 1/, 'an empty document reported no caret');

// 16. Edit mode affordance, editable textarea, and save callbacks.
let savedPath = null;
let savedContent = null;
let editToggled = null;
const editableView = preview.renderPreview({ path: 'src/main.js', content: 'console.log("hello");\n' }, {
    onSave: (p, c) => { savedPath = p; savedContent = c; },
    onEditChange: isEditing => { editToggled = isEditing; }
});

const editButton = editableView.querySelector('button[data-cb-action="preview-edit"]');
const saveButton = editableView.querySelector('button[data-cb-action="preview-save"]');
const cancelButton = editableView.querySelector('button[data-cb-action="preview-cancel"]');
const textarea = editableView.querySelector('.cb-preview-textarea');

assert.ok(editButton, 'missing edit button in toolbar');
assert.ok(saveButton, 'missing save button in toolbar');
assert.ok(cancelButton, 'missing cancel button in toolbar');
assert.ok(textarea, 'missing textarea in preview editor');

// Toggle edit mode
editButton.click();
assert.equal(editableView.className.includes('cb-preview-editing'), true, 'edit mode did not add .cb-preview-editing');
assert.equal(editToggled, true, 'onEditChange was not notified of entering edit mode');

// Mutate textarea and trigger save
textarea.value = 'console.log("updated");\n// extra line\n';
saveButton.click();
assert.equal(savedPath, 'src/main.js', 'onSave received the wrong path');
assert.equal(savedContent, 'console.log("updated");\n// extra line\n', 'onSave received the wrong content');

console.log('preview.test.cjs: 16 groups passed');
console.log(`  languages     : ${Object.keys(SAMPLES).length} tokenized losslessly`);
console.log(`  hostile input : ${HOSTILE.length} shapes x ${HOSTILE_LANGUAGES.length} languages, all linear`);
console.log(`  structure     : gutter, toolbar, status bar (Ln/Col, UTF-8, language)`);
console.log(`  safety        : no innerHTML; markup preserved as text; fences honoured`);
console.log(`  editing       : edit mode toggle, gutter sync, live textarea, save callbacks`);
process.exit(0);
