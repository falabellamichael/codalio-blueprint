'use strict';

/*
 * Source-security regression coverage.
 *
 * WHY THIS EXISTS
 * Sol added a sensitive-source layer — isSensitiveSourcePath() (path blocklist)
 * and sanitizeSourceForModel() (inline-secret redaction at the model boundary) —
 * as part of the multi-root / direct-project-access work. Both are exercised only
 * INDIRECTLY by the existing suites (pipeline-resilience asserts "sensitive source
 * paths are excluded"), so a regression that lets a real secret through would not
 * fail any current test.
 *
 * A false negative here is the worst kind of bug in this codebase: it silently
 * sends a credential to a remote model endpoint, and the user never sees it. So
 * this suite pins BOTH directions:
 *   - must BLOCK / must REDACT real secrets (no leaks)
 *   - must ALLOW / must KEEP ordinary source (no over-blocking, which would make
 *     legitimate .env.example, hashes, UUIDs and prose unusable)
 *
 * Every token below is either a constructed value or a documented public example;
 * none is a live credential.
 *
 * Run: node tests/source-security.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument, createLocalStorage } = require('./dom-stub.cjs');

const SRC = path.join(path.resolve(__dirname, '..'), 'src');

function loadCore() {
    const documentStub = createDocument();
    const base = createLocalStorage();
    const ls = {
        getItem: k => base.getItem(k),
        setItem: (k, v) => base.setItem(k, v),
        removeItem: k => base.removeItem(k)
    };
    const w = {
        document: documentStub, localStorage: ls,
        location: { href: 'http://localhost/gui/' }, navigator: { clipboard: null },
        console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
        requestAnimationFrame: f => setTimeout(() => f(Date.now()), 0),
        MutationObserver: class { observe() {} disconnect() {} },
        CustomEvent: class { constructor(t, i) { this.type = t; this.detail = (i || {}).detail; } },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
        Blob: class {}, FileReader: class { readAsText() {} },
        fetch: async () => { throw new Error('no network in tests'); },
        TextDecoder, TextEncoder, AbortController
    };
    w.window = w; w.globalThis = w;
    const sb = Object.assign({}, w, {
        Math, Date, JSON, Object, Array, String, Number, Boolean, Error, RegExp,
        Map, Set, Promise, Intl, Symbol, parseInt, parseFloat, isNaN,
        encodeURIComponent, decodeURIComponent
    });
    sb.globalThis = sb; sb.self = sb;
    const ctx = vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(SRC, 'controller-core.js'), 'utf8'), ctx,
        { filename: 'controller-core.js' });
    return w.__codalioBlueprintCore;
}

const core = loadCore();
assert.ok(core, 'controller-core.js did not export its core');
assert.equal(typeof core.isSensitiveSourcePath, 'function',
    'isSensitiveSourcePath must be exported — source selection depends on it');
assert.equal(typeof core.sanitizeSourceForModel, 'function',
    'sanitizeSourceForModel must be exported — the model boundary depends on it');

const isSensitive = core.isSensitiveSourcePath;
const sanitize = core.sanitizeSourceForModel;

// ---------------------------------------------------------------------------
// 1. Path blocklist: real credential locations MUST be blocked.
// ---------------------------------------------------------------------------
const MUST_BLOCK = [
    '.env', '.env.production', '.env.local', '.env.staging',
    '.env.backup', '.env.old', '.env.2026',
    'config/.env', 'a/b/.env.production',
    '.ssh/id_rsa', '.ssh/id_ed25519', 'C:\\Users\\me\\.ssh\\id_ed25519',
    '.aws/credentials', '.kube/config', '.docker/config.json',
    '.gnupg/secring.gpg', '.azure/accessTokens.json', '.terraform/vars.tf',
    '.npmrc', '.pypirc', '.netrc', '.dockercfg',
    'certs/server.key', 'certs/server.pem', 'app.p12', 'app.pfx',
    'vault.jks', 'android.keystore', 'pw.kdbx',
    'secrets-prod.json', 'credential_store.yaml', 'service-account.json',
    'firebase-adminsdk-abc.json',
    '.git/config',
    'ENV/.ENV', '.SSH/ID_RSA',          // case-insensitive
    'subdir/.ssh/', 'inside/venv/.env'  // trailing slash, nested
];
MUST_BLOCK.forEach(p => assert.equal(isSensitive(p), true,
    `LEAK: sensitive path was allowed through: ${p}`));

// ---------------------------------------------------------------------------
// 2. Path blocklist: ordinary source MUST be allowed (over-blocking is a bug too).
// ---------------------------------------------------------------------------
const MUST_ALLOW = [
    '.env.example', '.env.sample', '.env.template', '.env.dist',
    'src/environment.js', 'config/env.ts', 'environment.yaml',
    '.gitignore', '.dockerignore', '.editorconfig',
    'Dockerfile', 'Makefile', 'README.md', 'CHANGELOG.md', 'LICENSE',
    'keyboard.js', 'monkey.py', 'tokens.css', 'secretsanta.md',
    'src/keys.ts', 'publickey.js', 'passkey.md', 'id_rsa.pub',
    'node_modules/.package-lock.json'
];
MUST_ALLOW.forEach(p => assert.equal(isSensitive(p), false,
    `OVER-BLOCK: ordinary source was treated as sensitive: ${p}`));

// ---------------------------------------------------------------------------
// 3. Path blocklist: malformed input must not throw (defensive — a throw here
//    would abort source selection for the whole project).
// ---------------------------------------------------------------------------
['', null, undefined, '..', '.env.', 'a/.env/../b', 42, {}, []].forEach(input => {
    assert.doesNotThrow(() => isSensitive(input),
        `isSensitiveSourcePath threw on input: ${JSON.stringify(input)}`);
});

// ---------------------------------------------------------------------------
// 4. Inline redaction: real secret SHAPES must be redacted (redactions > 0).
//    Tokens are constructed programmatically so no stray character hides a gap.
// ---------------------------------------------------------------------------
const b64url = s => Buffer.from(s).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

const MUST_REDACT = [
    ['OpenAI key', 'const k = "sk-proj-' + 'a'.repeat(24) + '";'],
    ['GitHub PAT', 'token: github_pat_' + 'A'.repeat(24)],
    ['AWS access key id', 'aws_access_key_id = ' + ['AKIA', 'IOSFODNN7EXAMPLE'].join('')],
    ['Slack token', 'SLACK=xoxb-' + '1'.repeat(12) + '-' + 'a'.repeat(16)],
    ['Google API key', 'apiKey: "AIzaSy' + 'A'.repeat(31) + '"'],
    ['HuggingFace token', 'HF_TOKEN=***' + 'a'.repeat(30)],
    ['GitLab PAT', 'glpat-' + 'A'.repeat(24)],
    ['Stripe webhook secret', 'whsec_' + 'a'.repeat(24)],
    ['npm token', 'npm_' + 'A'.repeat(30)],
    ['PyPI token', 'pypi-' + 'A'.repeat(40)],
    ['SendGrid key', 'SG.' + 'a'.repeat(20) + '.' + 'A'.repeat(30)],
    ['JWT', 'auth = "' + [
        b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
        b64url(JSON.stringify({ sub: '1234567890' })),
        b64url('signature-bytes-here')
    ].join('.') + '"'],
    ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'],
    ['Bearer header', 'Authorization: Bearer ' + 'a'.repeat(24)],
    ['Basic header', 'Authorization: Basic ' + 'a'.repeat(16)],
    ['password assignment', 'password = "hunter2hunter2"'],
    ['api_key yaml', 'api_key: superSecretValue123'],
    ['client_secret json', '"client_secret": "GOCSPX-' + 'a'.repeat(22) + '"'],
    ['url with embedded creds', 'postgres://admin:supers3cret@db.example.com/app'],
    ['CLI --password flag', 'mysql --password=verysecretpass --user=root'],
    ['XML secret tag', '<secret>mySecretValue123</secret>'],
    ['access_token field', 'access_token = "at_' + 'a'.repeat(24) + '"']
];
MUST_REDACT.forEach(([label, source]) => {
    const result = sanitize(source);
    assert.ok(Number(result.redactions) > 0,
        `NOT REDACTED: ${label} passed through to the model unchanged`);
    // The secret material itself must be gone from the output.
    assert.ok(/\[REDACTED_/.test(result.content),
        `${label}: redaction count > 0 but no [REDACTED_*] marker in output`);
});

// ---------------------------------------------------------------------------
// 5. Inline redaction: ordinary source MUST survive (false positives make real
//    code unreadable to the model and would break legitimate prompts).
// ---------------------------------------------------------------------------
const MUST_KEEP = [
    ['uuid', 'const id = "550e8400-e29b-41d4-a716-446655440000";'],
    ['sha256 hash', 'const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";'],
    ['base64 image', 'src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA"'],
    ['version string', 'const VERSION = "1.2.3-beta.4+build.5678";'],
    ['css', '.btn-primary-dark:hover { color: #333333; }'],
    ['prose', 'The quick brown fox jumps over the lazy dog repeatedly here.'],
    ['function name', 'function calculatePasswordStrength(input) { return input.length; }'],
    ['identifier named key', 'const keyboardLayout = "qwertyuiopasdfghjklzxcvbnm";'],
    ['import path', 'import { tokenize } from "./utils/tokenizer.js";'],
    ['short secret-like value', 'let password = "abc";']  // < 6 chars: deliberately conservative
];
MUST_KEEP.forEach(([label, source]) => {
    const result = sanitize(source);
    assert.equal(Number(result.redactions) || 0, 0,
        `FALSE POSITIVE: ordinary source redacted (${label}): ${result.content}`);
});

// ---------------------------------------------------------------------------
// 6. Contract: sanitize returns { content, redactions } and never throws on junk.
// ---------------------------------------------------------------------------
const shape = sanitize('password = "hunter2hunter2"');
assert.equal(typeof shape.content, 'string', 'sanitize must return string content');
assert.equal(typeof shape.redactions, 'number', 'sanitize must return a numeric redaction count');
['', null, undefined, 42, {}, []].forEach(input => {
    assert.doesNotThrow(() => sanitize(input),
        `sanitizeSourceForModel threw on input: ${JSON.stringify(input)}`);
});

console.log('source-security.test.cjs: 6 groups passed');
console.log(`  paths      : ${MUST_BLOCK.length} sensitive blocked, ${MUST_ALLOW.length} ordinary allowed, junk tolerated`);
console.log(`  redaction  : ${MUST_REDACT.length} secret shapes redacted, ${MUST_KEEP.length} ordinary kept`);
console.log('  contract   : { content, redactions } shape, no throws on malformed input');
console.log('');
console.log('  Guards Sol\'s sensitive-source layer, which the existing suites only');
console.log('  exercise indirectly. A false negative here silently sends a credential');
console.log('  to a remote model endpoint, so both directions are pinned.');
