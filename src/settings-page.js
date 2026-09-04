/*
 * Codalio Blueprint — settings page renderer.
 *
 * Original Blueprint code. It follows the same *shape* SimpleRAG's own Settings
 * app uses — a section/sub-page navigation with a live summary per page, then
 * cards, groups and labelled rows in the reading pane, plus a search that jumps
 * straight to a field — but shares no source with it. Every element here is
 * Blueprint's own, every class is namespaced .cb-, and every value comes from
 * the schema in settings.js.
 *
 * Loads AFTER ui.js so it can reuse its element helpers, and AFTER settings.js
 * so the schema is available.
 */
(function defineBlueprintSettingsPage() {
    'use strict';

    if (window.__codalioBlueprintSettingsPage) return;

    const core = window.__codalioBlueprintCore;
    const schema = window.__codalioBlueprintSettings;
    const ui = window.__codalioBlueprintUi;
    const workspace = window.__codalioBlueprintWorkspace;

    const node = ui.node;
    const icon = ui.icon;
    const button = ui.button;

    // ------------------------------------------------------------------
    // List pane: section + sub-page navigation with live summaries
    // ------------------------------------------------------------------

    /**
     * The sidebar for the Settings tab. Sections group sub-pages; the active
     * sub-page is marked, and each row carries a one-line summary of what the
     * current values actually are — so you can see state without opening it.
     */
    function renderSettingsNav(state) {
        const settings = state.settings || core.readSettings();
        const wrap = node('div', 'cb-settings-nav');

        const search = node('div', 'cb-settings-search');
        const searchIcon = icon('fa-magnifying-glass');
        search.appendChild(searchIcon);
        const input = node('input', 'cb-settings-search-input');
        input.type = 'search';
        input.dataset.cbRole = 'settings-search';
        input.placeholder = 'Search settings…';
        input.value = state.settingsQuery || '';
        input.setAttribute('aria-label', 'Search Blueprint settings');
        input.maxLength = 120;
        search.appendChild(input);
        if (state.settingsQuery) {
            const clear = node('button', 'cb-settings-search-clear');
            clear.type = 'button';
            clear.dataset.cbAction = 'clear-settings-search';
            clear.title = 'Clear the search';
            clear.setAttribute('aria-label', 'Clear the search');
            clear.appendChild(icon('fa-xmark'));
            search.appendChild(clear);
        }
        wrap.appendChild(search);

        // Search results replace the tree while a query is active.
        if (state.settingsQuery && state.settingsQuery.trim().length > 1) {
            wrap.appendChild(renderSearchResults(state));
            return wrap;
        }

        schema.sections().forEach(section => {
            const group = node('div', 'cb-settings-nav-group');
            const heading = node('div', 'cb-settings-nav-heading');
            heading.appendChild(icon(section.icon));
            heading.appendChild(node('span', null, section.label));
            group.appendChild(heading);

            section.pages.forEach(page => {
                const isActive = state.settingsSection === section.id && state.settingsPage === page.id;
                const row = node('button', `cb-settings-nav-item${isActive ? ' active' : ''}`);
                row.type = 'button';
                row.dataset.cbAction = 'settings-goto';
                row.dataset.sectionId = section.id;
                row.dataset.pageId = page.id;
                if (isActive) row.setAttribute('aria-current', 'page');

                const iconWrap = node('span', 'cb-settings-nav-icon');
                iconWrap.appendChild(icon(page.icon));
                row.appendChild(iconWrap);

                const copy = node('span', 'cb-settings-nav-copy');
                copy.appendChild(node('span', 'cb-settings-nav-label', page.label));
                const summary = schema.pageSummary(section.id, page.id, settings);
                if (summary) copy.appendChild(node('span', 'cb-settings-nav-summary', summary));
                row.appendChild(copy);

                row.appendChild(icon('fa-chevron-right cb-settings-nav-chevron'));
                group.appendChild(row);
            });

            wrap.appendChild(group);
        });

        const note = node('p', 'cb-list-note');
        note.appendChild(icon('fa-circle-info'));
        note.appendChild(node('span', null, 'Settings are stored in this browser profile only. Nothing is written to your SimpleRAG workspace.'));
        wrap.appendChild(note);

        return wrap;
    }

    function renderSearchResults(state) {
        const query = state.settingsQuery;
        const groups = schema.searchSections(query);
        const wrap = node('div', 'cb-settings-results');

        if (!groups.length) {
            const empty = node('div', 'cb-settings-results-empty');
            empty.appendChild(icon('fa-magnifying-glass'));
            empty.appendChild(node('p', null, `No setting matches “${query}”.`));
            empty.appendChild(node('p', 'cb-muted', 'Try a shorter word, or browse the sections above by clearing the search.'));
            wrap.appendChild(empty);
            return wrap;
        }

        const heading = node('div', 'cb-settings-results-heading');
        heading.appendChild(node('span', null, `${groups.reduce((total, group) => total + group.hits.length, 0)} matches`));
        wrap.appendChild(heading);

        groups.forEach(group => {
            const section = node('div', 'cb-settings-result-section');
            const label = node('div', 'cb-settings-result-label');
            label.appendChild(icon(group.section.icon));
            label.appendChild(node('span', null, group.section.label));
            section.appendChild(label);

            group.hits.forEach(hit => {
                const field = schema.getField(hit.key);
                const row = node('button', 'cb-settings-result');
                row.type = 'button';
                row.dataset.cbAction = 'settings-focus';
                row.dataset.sectionId = hit.sectionId;
                row.dataset.pageId = hit.pageId;
                row.dataset.settingKey = hit.key;
                row.appendChild(node('span', 'cb-settings-result-name', hit.label));
                const page = schema.getPage(hit.sectionId, hit.pageId);
                row.appendChild(node('span', 'cb-settings-result-path', `${page.label} · ${schema.describeValue(field, (state.settings || {})[hit.key])}`));
                section.appendChild(row);
            });

            wrap.appendChild(section);
        });

        return wrap;
    }

    // ------------------------------------------------------------------
    // Reading pane: the active settings page
    // ------------------------------------------------------------------

    function renderSettingsPage(state) {
        const settings = state.settings || core.readSettings();
        const section = schema.getSection(state.settingsSection);
        const page = schema.getPage(section.id, state.settingsPage);

        const panel = node('div', 'cb-settings');
        panel.dataset.cbSection = section.id;
        panel.dataset.cbPage = page.id;

        // ---- header -------------------------------------------------
        const header = node('header', 'cb-settings-header');
        const headIcon = node('span', 'cb-settings-header-icon');
        headIcon.appendChild(icon(page.icon));
        header.appendChild(headIcon);

        const copy = node('div', 'cb-settings-header-copy');
        copy.appendChild(node('h2', null, page.label));
        copy.appendChild(node('p', null, `${section.label} · ${schema.pageSummary(section.id, page.id, settings)}`));
        header.appendChild(copy);

        const headTools = node('div', 'cb-settings-header-tools');
        headTools.appendChild(button('Reset page', 'fa-rotate-left', 'reset-settings-page', {
            compact: true,
            title: 'Return every setting on this page to its documented default',
            dataset: { sectionId: section.id, pageId: page.id }
        }));
        header.appendChild(headTools);
        panel.appendChild(header);

        // ---- in-page sub-page tabs (when a section has several) -------
        if (section.pages.length > 1) {
            const subNav = node('nav', 'cb-settings-subnav');
            subNav.setAttribute('role', 'tablist');
            subNav.setAttribute('aria-label', `${section.label} settings pages`);
            section.pages.forEach(item => {
                const isActive = item.id === page.id;
                const tab = node('button', `cb-settings-subnav-tab${isActive ? ' active' : ''}`);
                tab.type = 'button';
                tab.dataset.cbAction = 'settings-goto';
                tab.dataset.sectionId = section.id;
                tab.dataset.pageId = item.id;
                tab.setAttribute('role', 'tab');
                tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
                tab.title = schema.pageSummary(section.id, item.id, settings);
                tab.appendChild(icon(item.icon));
                tab.appendChild(node('span', null, item.label));
                subNav.appendChild(tab);
            });
            panel.appendChild(subNav);
        }

        // ---- groups --------------------------------------------------
        const body = node('div', 'cb-settings-body');

        // Read-only panels that belong to a specific page. Rendered first so the
        // facts sit above the controls they describe.
        if (section.id === 'data' && page.id === 'storage' && settings.showStorageUsage !== false) {
            body.appendChild(renderStorageMetrics());
        }
        if (section.id === 'workspace' && page.id === 'tabs') {
            body.appendChild(renderShortcutReference());
        }

        page.groups.forEach(group => {
            body.appendChild(renderGroup(group, settings, state));
        });

        panel.appendChild(body);
        return panel;
    }

    function renderGroup(group, settings, state) {
        const card = node('section', 'cb-settings-card');

        const head = node('header', 'cb-settings-card-head');
        const title = node('div', 'cb-settings-card-title');
        title.appendChild(icon(group.icon || 'fa-sliders'));
        title.appendChild(node('h3', null, group.label));
        head.appendChild(title);
        card.appendChild(head);

        if (group.note) {
            const note = node('p', 'cb-settings-note');
            note.appendChild(icon('fa-circle-info'));
            note.appendChild(node('span', null, group.note));
            card.appendChild(note);
        }

        const body = node('div', 'cb-settings-card-body');
        (group.fields || []).forEach(field => {
            body.appendChild(renderField(field, settings, state));
        });
        if (Array.isArray(group.actions)) {
            group.actions.forEach(action => body.appendChild(renderAction(action)));
        }
        card.appendChild(body);
        return card;
    }

    function renderField(field, settings, state) {
        const value = settings[field.key];
        const row = node('div', `cb-setting-row cb-setting-${field.type}`);
        row.dataset.cbSettingKey = field.key;
        if (state.settingsFocusKey === field.key) row.classList.add('focused');

        const copy = node('div', 'cb-setting-copy');
        const labelWrap = node('div', 'cb-setting-label');
        const label = node('label', null, field.label);
        label.htmlFor = `cb-set-${field.key}`;
        labelWrap.appendChild(label);
        labelWrap.appendChild(node('span', 'cb-setting-value', schema.describeValue(field, value)));
        copy.appendChild(labelWrap);
        if (field.help) copy.appendChild(node('p', 'cb-setting-help', field.help));
        row.appendChild(copy);

        const control = node('div', 'cb-setting-control');
        control.appendChild(buildControl(field, value));
        row.appendChild(control);
        return row;
    }

    function buildControl(field, value) {
        switch (field.type) {
            case 'toggle': return toggleControl(field, value);
            case 'segmented': return segmentedControl(field, value);
            case 'select': return selectControl(field, value);
            case 'number': return numberControl(field, value);
            case 'range': return rangeControl(field, value);
            case 'textarea': return textareaControl(field, value);
            case 'text': return textControl(field, value);
            default: return node('span', 'cb-muted', '(unsupported control)');
        }
    }

    function toggleControl(field, value) {
        const wrap = node('label', 'cb-switch');
        wrap.title = value ? 'On' : 'Off';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = `cb-set-${field.key}`;
        input.dataset.cbSetting = field.key;
        input.checked = value !== false;
        wrap.appendChild(input);
        wrap.appendChild(node('i', 'cb-switch-track'));
        return wrap;
    }

    function segmentedControl(field, value) {
        const group = node('div', 'cb-segmented');
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-label', field.label);
        (field.options || []).forEach(option => {
            const item = node('label', `cb-segment${option.value === value ? ' active' : ''}`);
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = `cb-set-${field.key}`;
            input.value = option.value;
            input.dataset.cbSetting = field.key;
            input.checked = option.value === value;
            if (option.value === value) input.id = `cb-set-${field.key}`;
            item.appendChild(input);
            const face = node('span', 'cb-segment-face');
            face.appendChild(icon(option.icon || 'fa-circle'));
            face.appendChild(node('span', null, option.label));
            item.appendChild(face);
            if (option.hint) item.title = option.hint;
            group.appendChild(item);
        });
        return group;
    }

    function selectControl(field, value) {
        const wrap = node('div', 'cb-select-wrap');
        const select = node('select', 'cb-input cb-select');
        select.id = `cb-set-${field.key}`;
        select.dataset.cbSetting = field.key;
        (field.options || []).forEach(option => {
            const item = node('option', null, option.label);
            item.value = option.value;
            if (option.value === value) item.selected = true;
            select.appendChild(item);
        });
        wrap.appendChild(select);
        wrap.appendChild(icon('fa-chevron-down cb-select-caret'));
        return wrap;
    }

    function numberControl(field, value) {
        const wrap = node('div', 'cb-number-wrap');
        const input = node('input', 'cb-input cb-number');
        input.type = 'number';
        input.id = `cb-set-${field.key}`;
        input.dataset.cbSetting = field.key;
        input.value = String(value);
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = String(field.step || 1);
        wrap.appendChild(input);
        if (field.unit) wrap.appendChild(node('span', 'cb-number-unit', field.unit));
        const bounds = node('span', 'cb-number-bounds', `${field.min}–${field.max}`);
        wrap.appendChild(bounds);
        return wrap;
    }

    function rangeControl(field, value) {
        const wrap = node('div', 'cb-range-wrap');
        const input = node('input', 'cb-range');
        input.type = 'range';
        input.id = `cb-set-${field.key}`;
        input.dataset.cbSetting = field.key;
        input.min = String(field.min);
        input.max = String(field.max);
        input.step = String(field.step || 1);
        input.value = String(value);
        input.setAttribute('aria-label', field.label);
        wrap.appendChild(input);

        const readout = node('output', 'cb-range-value');
        readout.dataset.cbRole = `range-value-${field.key}`;
        readout.textContent = typeof field.format === 'function' ? field.format(value) : String(value);
        wrap.appendChild(readout);

        if (Array.isArray(field.hints) && field.hints.length) {
            const marks = node('div', 'cb-range-hints');
            field.hints.forEach(hint => {
                const mark = node('button', 'cb-range-hint');
                mark.type = 'button';
                mark.dataset.cbAction = 'settings-range-jump';
                mark.dataset.settingKey = field.key;
                mark.dataset.value = String(hint.at);
                mark.title = `${hint.label} (${typeof field.format === 'function' ? field.format(hint.at) : hint.at})`;
                mark.appendChild(node('span', null, hint.label));
                marks.appendChild(mark);
            });
            wrap.appendChild(marks);
        }
        return wrap;
    }

    function textareaControl(field, value) {
        const wrap = node('div', 'cb-textarea-wrap');
        const input = node('textarea', 'cb-input cb-textarea');
        input.id = `cb-set-${field.key}`;
        input.dataset.cbSetting = field.key;
        input.rows = field.rows || 4;
        input.maxLength = field.maxChars || 1200;
        input.value = String(value || '');
        if (field.placeholder) input.placeholder = field.placeholder;
        wrap.appendChild(input);

        const footer = node('div', 'cb-textarea-footer');
        const counter = node('span', 'cb-textarea-count');
        counter.dataset.cbRole = `counter-${field.key}`;
        counter.textContent = `${String(value || '').length} / ${input.maxLength}`;
        footer.appendChild(counter);
        if (value) {
            const clear = node('button', 'cb-link-btn');
            clear.type = 'button';
            clear.dataset.cbAction = 'settings-clear-text';
            clear.dataset.settingKey = field.key;
            clear.appendChild(node('span', null, 'Clear'));
            footer.appendChild(clear);
        }
        wrap.appendChild(footer);
        return wrap;
    }

    function textControl(field, value) {
        const input = node('input', 'cb-input');
        input.type = 'text';
        input.id = `cb-set-${field.key}`;
        input.dataset.cbSetting = field.key;
        input.value = String(value || '');
        input.maxLength = field.maxChars || 240;
        if (field.placeholder) input.placeholder = field.placeholder;
        return input;
    }

    // ------------------------------------------------------------------
    // Actions
    //
    // The schema declares actions on a GROUP (Settings -> Data -> Maintenance),
    // and renderGroup() renders them via renderAction(). There is deliberately no
    // page-level action path — two ways to declare the same thing invites
    // duplicates and silent divergence.
    // ------------------------------------------------------------------

    function renderAction(action, state) {
        const row = node('div', `cb-action-row${action.tone ? ` cb-action-${action.tone}` : ''}`);
        const copy = node('div', 'cb-setting-copy');
        copy.appendChild(node('div', 'cb-setting-label', action.label));
        if (action.help) copy.appendChild(node('p', 'cb-setting-help', action.help));
        row.appendChild(copy);

        const control = node('div', 'cb-setting-control');
        control.appendChild(button(action.label, action.icon || 'fa-bolt', `settings-action:${action.key}`, {
            danger: action.tone === 'danger',
            compact: false,
            disabled: Boolean(state && state.busy)
        }));
        row.appendChild(control);
        return row;
    }

    // ------------------------------------------------------------------
    // Data page extras: storage metrics + shortcut reference
    // ------------------------------------------------------------------

    /** Read-only metrics strip for Settings -> Data -> Storage & privacy. */
    function renderStorageMetrics() {
        const usage = core.storageUsage();
        const headroom = core.storageHeadroom();
        const persistence = core.persistenceState();
        const strip = node('div', 'cb-metrics');
        const metrics = [
            { label: 'Total', value: core.formatBytes(usage.total), icon: 'fa-database' },
            { label: 'Documents', value: `${usage.fileCount} · ${core.formatBytes(usage.projects)}`, icon: 'fa-file-lines' },
            { label: 'Runs', value: String(usage.runCount), icon: 'fa-clock-rotate-left' },
            { label: 'Settings', value: core.formatBytes(usage.settings), icon: 'fa-sliders' },
            { label: 'Tab layout', value: core.formatBytes(usage.workspace), icon: 'fa-clone' },
            { label: 'Free space', value: `${core.formatBytes(headroom.remaining)} (${headroom.percentUsed}% used)`, icon: 'fa-gauge-high' }
        ];
        metrics.forEach(metric => {
            const item = node('div', 'cb-metric');
            item.appendChild(icon(metric.icon));
            const copy = node('div', 'cb-metric-copy');
            copy.appendChild(node('span', 'cb-metric-label', metric.label));
            copy.appendChild(node('strong', 'cb-metric-value', metric.value));
            item.appendChild(copy);
            strip.appendChild(item);
        });

        const wrap = node('div', 'cb-storage-wrap');

        // A write that failed is otherwise invisible: the in-memory store moves on
        // while nothing reached disk, and the user only finds out on reload. Say so
        // here, with the largest consumer named so the fix is obvious.
        if (persistence.ok === false) {
            const largest = core.largestStorageConsumer();
            const warning = node('div', 'cb-storage-warning');
            warning.appendChild(icon('fa-triangle-exclamation'));
            const copy = node('div', 'cb-storage-warning-copy');
            copy.appendChild(node('strong', null, 'Blueprint could not save your project'));
            copy.appendChild(node('p', null,
                `The browser refused the write${persistence.failureCount > 1 ? ` (${persistence.failureCount} failed attempts)` : ''}: `
                + `${persistence.lastError || 'storage is unavailable'}. `
                + `Work stays visible until you reload, then it is lost. `
                + `Your largest consumer is ${largest.label} at ${core.formatBytes(largest.bytes)} — ${largest.action} to make room.`));
            warning.appendChild(copy);
            const action = button(largest.action, 'fa-broom', 'settings-action:clear-runs', { danger: true, compact: true });
            if (largest.action === 'Clear project files') {
                action.dataset.cbAction = 'settings-action:clear-files';
            }
            warning.appendChild(action);
            wrap.appendChild(warning);
        } else if (headroom.percentUsed >= 80) {
            const soon = node('div', 'cb-storage-soon');
            soon.appendChild(icon('fa-circle-info'));
            const largest = core.largestStorageConsumer();
            soon.appendChild(node('span', null,
                `Storage is ${headroom.percentUsed}% full. Blueprint may stop saving soon — ${largest.action.toLowerCase()} would free about ${core.formatBytes(largest.bytes)}.`));
            wrap.appendChild(soon);
        }

        wrap.appendChild(strip);
        return wrap;
    }

    /** Read-only keyboard shortcut reference for Settings -> Workspace -> Tabs. */
    function renderShortcutReference() {
        const card = node('section', 'cb-settings-card cb-settings-card-reference');
        const head = node('header', 'cb-settings-card-head');
        const title = node('div', 'cb-settings-card-title');
        title.appendChild(icon('fa-keyboard'));
        title.appendChild(node('h3', null, 'Keyboard shortcuts'));
        head.appendChild(title);
        card.appendChild(head);

        const body = node('div', 'cb-settings-card-body');
        const list = node('dl', 'cb-shortcuts');
        (workspace ? workspace.SHORTCUTS : []).forEach(shortcut => {
            const term = node('dt', null);
            term.appendChild(node('kbd', null, shortcut.combo));
            list.appendChild(term);
            list.appendChild(node('dd', null, shortcut.description));
        });
        body.appendChild(list);
        card.appendChild(body);
        return card;
    }

    window.__codalioBlueprintSettingsPage = Object.freeze({
        renderSettingsNav,
        renderSettingsPage,
        renderSearchResults,
        renderStorageMetrics,
        renderShortcutReference,
        renderField,
        buildControl
    });
}());
