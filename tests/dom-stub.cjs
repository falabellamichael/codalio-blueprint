'use strict';

/*
 * Codalio Blueprint — shared DOM stub for tests.
 *
 * The other suites use a throwaway stub whose querySelector() returns null. That
 * is fine for pure render functions, but controller.js queries the DOM about 20
 * times per interaction (transcript scroll anchor, composer focus, modal fields,
 * settings search, focus trapping). Stubbing those to null would let the biggest
 * module in the plug-in pass its tests without ever executing those paths.
 *
 * So this stub implements a real tree plus a CSS selector engine covering the
 * subset Blueprint actually uses:
 *
 *   tag, .class, #id, [attr], [attr="value"], :not([attr]),
 *   descendant combinators ("a b"), and comma-separated selector lists.
 *
 * That is enough for every selector in src/. Anything unsupported throws rather
 * than silently returning null, so a new selector in the product code cannot
 * quietly become an untested no-op.
 */

const UNSUPPORTED = /(~=|\|=|\^=|\$=|\*=|::|>\s|\+\s|~\s)/;

// ---------------------------------------------------------------------------
// Selector parsing
// ---------------------------------------------------------------------------

function parseCompound(text) {
    const compound = { tag: null, id: null, classes: [], attrs: [], notAttrs: [] };
    // :not(...) may itself carry a value test, e.g. [tabindex]:not([tabindex="-1"])
    // which Blueprint's focus trap uses.
    const pattern = /(^[a-zA-Z][\w-]*)|(#([\w-]+))|(\.([\w-]+))|(\[([\w-]+)(?:([~^$|*]?=)"?([^\]"]*)"?)?\])|(:not\(\[([\w-]+)(?:([~^$|*]?=)"?([^\]"]*)"?)?\]\))/g;
    let cursor = 0;
    let match = null;
    while ((match = pattern.exec(text)) !== null) {
        if (match.index !== cursor) {
            throw new Error(`dom-stub: unsupported selector syntax near "${text.slice(cursor)}"`);
        }
        cursor = match.index + match[0].length;
        if (match[1]) compound.tag = match[1].toUpperCase();
        else if (match[3]) compound.id = match[3];
        else if (match[5]) compound.classes.push(match[5]);
        else if (match[7]) compound.attrs.push({ name: match[7], op: match[8] || null, value: match[9] });
        else if (match[11]) compound.notAttrs.push({ name: match[11], op: match[12] || null, value: match[13] });
    }
    if (cursor !== text.length) {
        throw new Error(`dom-stub: unsupported selector syntax in "${text}" at "${text.slice(cursor)}"`);
    }
    return compound;
}

/** "a b, c" -> [[compoundA, compoundB], [compoundC]] (ancestor-first order). */
function parseSelector(selector) {
    const text = String(selector || '').trim();
    if (!text) throw new Error('dom-stub: empty selector');
    if (UNSUPPORTED.test(text.replace(/:not\([^)]*\)/g, ''))) {
        throw new Error(`dom-stub: selector uses unsupported syntax: "${text}"`);
    }
    return text.split(',').map(group => {
        const parts = group.trim().split(/\s+/).filter(Boolean);
        if (!parts.length) throw new Error(`dom-stub: empty selector group in "${selector}"`);
        return parts.map(parseCompound);
    });
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Resolve an attribute value the way the DOM exposes it to selectors.
 * `disabled` is an IDL property on form controls (not necessarily an attribute)
 * and `tabindex` is reflected from the tabIndex property, so both are read from
 * the live property first.
 */
function readAttr(node, name) {
    if (name === 'disabled') return node.disabled === true ? '' : null;
    if (name === 'tabindex') {
        if (node.tabIndex === null || node.tabIndex === undefined) return node.getAttribute('tabindex');
        return String(node.tabIndex);
    }
    return node.getAttribute(name);
}

function matchesAttrTest(node, test) {
    const actual = readAttr(node, test.name);
    if (actual === null || actual === undefined) return false;
    if (!test.op) return true;
    if (test.op === '=') return String(actual) === String(test.value === undefined ? '' : test.value);
    throw new Error(`dom-stub: unsupported attribute operator "${test.op}"`);
}

function matchesCompound(node, compound) {
    if (!node || node.nodeType !== 1) return false;
    if (compound.tag && node.tagName !== compound.tag) return false;
    if (compound.id && node.id !== compound.id) return false;
    if (compound.classes.length && !compound.classes.every(name => node.classList.contains(name))) return false;
    // :not(...) excludes the node when its inner test WOULD have matched.
    if (compound.notAttrs.length && compound.notAttrs.some(test => matchesAttrTest(node, test))) return false;
    return compound.attrs.every(test => matchesAttrTest(node, test));
}

function* walkTree(root) {
    for (const child of root.children || []) {
        yield child;
        yield* walkTree(child);
    }
}

/** Does `node` have an ancestor (or itself) matching every compound, in order? */
function matchesSelectorList(node, groups) {
    return groups.some(compounds => {
        // Last compound must match the node itself.
        if (!matchesCompound(node, compounds[compounds.length - 1])) return false;
        let ancestorIndex = compounds.length - 2;
        let current = node.parentNode || null;
        while (ancestorIndex >= 0) {
            if (!current) return false;
            if (matchesCompound(current, compounds[ancestorIndex])) ancestorIndex -= 1;
            current = current.parentNode || null;
        }
        return true;
    });
}

// ---------------------------------------------------------------------------
// Element
// ---------------------------------------------------------------------------

function createElement(tagName, doc) {
    const classes = new Set();
    const attrs = Object.create(null);
    let ownValue = '';
    let ownTitle = '';
    let ownDisabled = false;

    const element = {
        tagName: String(tagName).toUpperCase(),
        nodeType: 1,
        ownerDocument: doc,
        parentNode: null,
        children: [],
        childElementCount: 0,
        firstElementChild: null,
        lastElementChild: null,
        dataset: {},
        style: {
            setProperty() {}, getPropertyValue() { return ''; },
            width: '', flex: '', cursor: '', userSelect: '', display: ''
        },
        innerHTML: '',
        offsetParent: {},
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        tabIndex: null,
        rows: 0,
        type: '',
        checked: false,
        selected: false,
        min: '',
        max: '',
        step: '',
        accept: '',
        maxLength: 0,
        placeholder: '',
        hidden: false,
        htmlFor: '',
        files: [],
        isConnected: false,

        get classList() {
            return {
                add: (...names) => names.forEach(name => classes.add(String(name))),
                remove: (...names) => names.forEach(name => classes.delete(String(name))),
                toggle: (name, force) => {
                    const on = force === undefined ? !classes.has(name) : Boolean(force);
                    if (on) classes.add(name); else classes.delete(name);
                    return on;
                },
                contains: name => classes.has(String(name))
            };
        },

        appendChild(child) {
            if (child.isFragment) {
                [...child.children].forEach(grandchild => element.appendChild(grandchild));
                child.children.length = 0;
                return child;
            }
            if (child.parentNode) child.parentNode.removeChild(child);
            child.parentNode = element;
            element.children.push(child);
            syncChildren(element);
            syncConnected(element);
            return child;
        },

        insertBefore(child, reference) {
            if (child.parentNode) child.parentNode.removeChild(child);
            child.parentNode = element;
            const index = reference ? element.children.indexOf(reference) : -1;
            if (index >= 0) element.children.splice(index, 0, child);
            else element.children.push(child);
            syncChildren(element);
            syncConnected(element);
            return child;
        },

        removeChild(child) {
            const index = element.children.indexOf(child);
            if (index >= 0) element.children.splice(index, 1);
            child.parentNode = null;
            syncChildren(element);
            // The removed subtree is no longer in the document; recompute its
            // isConnected flags or a detached node keeps claiming to be attached.
            syncConnected(child);
            return child;
        },

        remove() {
            if (element.parentNode) element.parentNode.removeChild(element);
            else syncConnected(element);
        },

        setAttribute(name, value) {
            attrs[String(name)] = String(value);
            if (name === 'class') element.className = String(value);
        },
        getAttribute(name) {
            const key = String(name);
            if (key === 'class') return element.className || null;
            return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null;
        },
        hasAttribute(name) { return element.getAttribute(name) !== null; },
        removeAttribute(name) { delete attrs[String(name)]; },

        closest(selector) {
            const groups = parseSelector(selector);
            let current = element;
            while (current) {
                if (matchesSelectorList(current, groups)) return current;
                current = current.parentNode;
            }
            return null;
        },

        querySelector(selector) {
            const groups = parseSelector(selector);
            for (const node of walkTree(element)) {
                if (matchesSelectorList(node, groups)) return node;
            }
            return null;
        },

        querySelectorAll(selector) {
            const groups = parseSelector(selector);
            const found = [];
            for (const node of walkTree(element)) {
                if (matchesSelectorList(node, groups)) found.push(node);
            }
            return found;
        },

        addEventListener(type, handler) {
            element._listeners = element._listeners || {};
            (element._listeners[type] = element._listeners[type] || []).push(handler);
        },
        removeEventListener(type, handler) {
            const list = (element._listeners || {})[type];
            if (!list) return;
            const index = list.indexOf(handler);
            if (index >= 0) list.splice(index, 1);
        },
        dispatchEvent(event) {
            const list = ((element._listeners || {})[event.type] || []).slice();
            list.forEach(handler => handler.call(element, event));
            return true;
        },
        click() { element.dispatchEvent(makeEvent('click', { target: element })); },
        focus() { if (doc) doc.activeElement = element; },
        blur() { if (doc && doc.activeElement === element) doc.activeElement = doc.body; },
        scrollIntoView() { element._scrolledIntoView = (element._scrolledIntoView || 0) + 1; },
        setSelectionRange() {},
        _attrStore: attrs,
        _classes: classes
    };

    Object.defineProperty(element, 'className', {
        get: () => [...classes].join(' '),
        set(value) {
            classes.clear();
            String(value || '').split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
        },
        configurable: true
    });

    Object.defineProperty(element, 'id', {
        get: () => attrs.id || '',
        set(value) { attrs.id = String(value); if (doc) doc._byId.set(String(value), element); },
        configurable: true
    });

    // The real DOM reflects .title to the title attribute.
    Object.defineProperty(element, 'title', {
        get: () => ownTitle,
        set(value) { ownTitle = String(value); attrs.title = ownTitle; },
        configurable: true
    });

    // A <select> derives .value from its selected <option>.
    Object.defineProperty(element, 'value', {
        get() {
            if (element.tagName === 'SELECT') {
                const selected = element.children.find(child => child.selected);
                return selected ? String(selected.value) : '';
            }
            return ownValue;
        },
        set(next) { ownValue = next === null || next === undefined ? '' : String(next); },
        configurable: true
    });

    Object.defineProperty(element, 'disabled', {
        get: () => ownDisabled,
        set(next) { ownDisabled = Boolean(next); },
        configurable: true
    });

    // .dataset writes must be visible to [data-x="y"] selectors, and vice versa.
    const dataset = new Proxy(element.dataset, {
        get(target, key) {
            if (typeof key !== 'string') return target[key];
            const attr = 'data-' + key.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
            if (Object.prototype.hasOwnProperty.call(target, key)) return target[key];
            const fromAttr = element.getAttribute(attr);
            return fromAttr === null ? undefined : fromAttr;
        },
        set(target, key, value) {
            if (typeof key === 'string') {
                const attr = 'data-' + key.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
                attrs[attr] = String(value);
            }
            target[key] = String(value);
            return true;
        },
        has(target, key) {
            if (typeof key !== 'string') return key in target;
            const attr = 'data-' + key.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
            return key in target || element.getAttribute(attr) !== null;
        },
        deleteProperty(target, key) {
            if (typeof key === 'string') {
                delete attrs['data-' + key.replace(/[A-Z]/g, m => '-' + m.toLowerCase())];
            }
            delete target[key];
            return true;
        },
        ownKeys(target) {
            const keys = new Set(Object.keys(target));
            Object.keys(attrs).forEach(name => {
                if (name.startsWith('data-')) {
                    keys.add(name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
                }
            });
            return [...keys];
        },
        getOwnPropertyDescriptor(target, key) {
            if (element.dataset[key] !== undefined || (typeof key === 'string' && key in target)) {
                return { enumerable: true, configurable: true };
            }
            return undefined;
        }
    });
    element.dataset = dataset;

    Object.defineProperty(element, 'textContent', {
        get() {
            return (element.children || []).map(child => child.textContent || '').join('');
        },
        set(value) {
            element.children.slice().forEach(child => { child.parentNode = null; });
            element.children.length = 0;
            if (value !== '' && value !== null && value !== undefined) {
                element.children.push({ nodeType: 3, textContent: String(value), children: [], parentNode: element });
            }
            syncChildren(element);
        },
        configurable: true
    });

    /*
     * innerHTML, faithful to the DOM for the two cases that matter here:
     *
     *   - assigning '' removes every child. Blueprint's renderPage() and the
     *     host's renderList() both clear their container this way on every
     *     render; without clearing, each re-render stacks another copy of the
     *     whole page and the integration test sees duplicated trees.
     *   - assigning a non-empty string is recorded but NOT parsed into children,
     *     so tests can assert on the markup a producer wrote (the host builds its
     *     app-bar icons this way) without this stub pretending to be an HTML
     *     parser. Every such assignment is logged on the element so a test can
     *     prove which code paths inject HTML at all.
     */
    let htmlValue = '';
    element._htmlAssignments = [];
    Object.defineProperty(element, 'innerHTML', {
        get: () => htmlValue,
        set(value) {
            const next = value === null || value === undefined ? '' : String(value);
            htmlValue = next;
            element._htmlAssignments.push(next);
            if (next === '') {
                const removed = element.children.slice();
                element.children.length = 0;
                syncChildren(element);
                removed.forEach(child => {
                    child.parentNode = null;
                    syncConnected(child);
                });
            }
        },
        configurable: true
    });

    return element;
}

function syncChildren(element) {
    element.childElementCount = element.children.filter(child => child.nodeType === 1).length;
    element.firstElementChild = element.children.find(child => child.nodeType === 1) || null;
    const elements = element.children.filter(child => child.nodeType === 1);
    element.lastElementChild = elements.length ? elements[elements.length - 1] : null;
}

function syncConnected(element) {
    // Walk to the top-most ancestor. The subtree is connected iff that ancestor
    // is the document's root element. Deciding from the walk (not from a node's
    // own stale isConnected flag) is what makes remove() actually clear it.
    let top = element;
    while (top.parentNode) top = top.parentNode;
    const root = top.ownerDocument && top.ownerDocument.documentElement;
    const connected = Boolean(root) && top === root;
    const apply = node => {
        node.isConnected = connected;
        (node.children || []).forEach(apply);
    };
    apply(element);
}

function makeEvent(type, init) {
    const detail = init || {};
    return {
        type,
        target: detail.target || null,
        currentTarget: null,
        button: detail.button === undefined ? 0 : detail.button,
        key: detail.key || '',
        ctrlKey: Boolean(detail.ctrlKey),
        metaKey: Boolean(detail.metaKey),
        shiftKey: Boolean(detail.shiftKey),
        altKey: Boolean(detail.altKey),
        altGraphKey: Boolean(detail.altGraphKey),
        _prevented: false,
        _stopped: false,
        preventDefault() { this._prevented = true; },
        stopPropagation() { this._stopped = true; }
    };
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

function createDocument() {
    const doc = {
        _byId: new Map(),
        _listeners: {},
        activeElement: null,
        readyState: 'complete'
    };

    doc.createElement = tagName => createElement(tagName, doc);
    doc.createDocumentFragment = () => {
        const fragment = createElement('#fragment', doc);
        fragment.isFragment = true;
        return fragment;
    };
    doc.createTextNode = text => ({ nodeType: 3, textContent: String(text), children: [], parentNode: null });

    doc.documentElement = createElement('html', doc);
    doc.documentElement.isConnected = true;
    doc.body = createElement('body', doc);
    doc.head = createElement('head', doc);
    doc.documentElement.appendChild(doc.head);
    doc.documentElement.appendChild(doc.body);
    doc.activeElement = doc.body;

    doc.getElementById = id => doc._byId.get(String(id)) || null;
    doc.querySelector = selector => doc.documentElement.querySelector(selector);
    doc.querySelectorAll = selector => doc.documentElement.querySelectorAll(selector);

    doc.addEventListener = (type, handler) => {
        (doc._listeners[type] = doc._listeners[type] || []).push(handler);
    };
    doc.removeEventListener = (type, handler) => {
        const list = doc._listeners[type];
        if (!list) return;
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
    };
    doc.dispatch = (type, init) => {
        const event = makeEvent(type, init);
        (doc._listeners[type] || []).slice().forEach(handler => handler(event));
        return event;
    };
    doc.dispatchEvent = event => {
        (doc._listeners[event.type] || []).slice().forEach(handler => handler(event));
        return true;
    };

    /**
     * Click a node the way a browser would: build the event with the node as
     * target, then let the document-level delegated listener (which Blueprint
     * installs) see it and walk up via closest().
     */
    doc.clickOn = (node, init) => {
        if (!node) throw new Error('dom-stub: clickOn(null) — the element was not found');
        return doc.dispatch('click', Object.assign({ target: node, button: 0 }, init || {}));
    };

    return doc;
}

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

function createLocalStorage() {
    const map = new Map();
    return {
        getItem: key => (map.has(String(key)) ? map.get(String(key)) : null),
        setItem: (key, value) => { map.set(String(key), String(value)); },
        removeItem: key => { map.delete(String(key)); },
        clear: () => { map.clear(); },
        key: index => [...map.keys()][index] || null,
        get length() { return map.size; },
        _has: key => map.has(String(key)),
        _keys: () => [...map.keys()],
        _dump: () => Object.fromEntries(map)
    };
}

module.exports = {
    createElement,
    createDocument,
    createLocalStorage,
    makeEvent,
    parseSelector,
    matchesSelectorList,
    walkTree,
    syncChildren
};
