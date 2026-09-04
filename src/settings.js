/*
 * Codalio Blueprint — settings schema and engine.
 *
 * Original Blueprint code. It follows the same *conventions* SimpleRAG's own
 * Settings app uses (sections -> sub-pages -> cards -> groups -> rows, a live
 * summary per sub-page, and a searchable field index) but shares no source with
 * it: every identifier here is Blueprint's own and every rule is namespaced
 * .cb- in the stylesheet.
 *
 * The schema is the single source of truth for labels, help text, control type,
 * and bounds. core.readSettings() delegates clamping here when this module is
 * loaded, and falls back to its own bounds when it is not (so the agent can run
 * headless in tests without the UI layer).
 *
 * Every field below is WIRED — changing it changes real behaviour somewhere in
 * agent.js, controller.js, ui.js or workspace.js. There are no decorative knobs.
 */
(function defineBlueprintSettings() {
    'use strict';

    if (window.__codalioBlueprintSettings) return;

    const core = window.__codalioBlueprintCore;

    // ------------------------------------------------------------------
    // Bound helpers (schema-driven, so bounds live next to the field)
    // ------------------------------------------------------------------

    function intBound(field, value, fallback) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(field.max, Math.max(field.min, parsed));
    }

    function floatBound(field, value, fallback) {
        const parsed = Number.parseFloat(value);
        if (!Number.isFinite(parsed)) return fallback;
        const step = field.step || 0.05;
        const snapped = Math.round(parsed / step) * step;
        const rounded = Number.parseFloat(snapped.toFixed(4));
        return Math.min(field.max, Math.max(field.min, rounded));
    }

    function enumBound(field, value, fallback) {
        const allowed = field.options.map(option => option.value);
        return allowed.includes(value) ? value : fallback;
    }

    function boolBound(value, fallback) {
        return typeof value === 'boolean' ? value : fallback;
    }

    function textBound(field, value, fallback) {
        if (typeof value !== 'string') return fallback;
        const max = field.maxChars || 4000;
        return value.length > max ? value.slice(0, max) : value;
    }

    /** Clamp one raw value against its field definition. */
    function coerceField(field, value, fallback) {
        switch (field.type) {
            case 'toggle':
                return boolBound(value, fallback);
            case 'number':
            case 'range':
                return Number.isInteger(fallback)
                    ? intBound(field, value, fallback)
                    : floatBound(field, value, fallback);
            case 'segmented':
            case 'select':
                return enumBound(field, value, fallback);
            case 'text':
            case 'textarea':
                return textBound(field, value, fallback);
            default:
                return value === undefined ? fallback : value;
        }
    }

    // ------------------------------------------------------------------
    // Summary builders — one line per sub-page, shown in the sub-page nav
    // ------------------------------------------------------------------

    function percent(value) {
        return `${Math.round(Number(value) * 100)}%`;
    }

    function tokens(value) {
        return `${Number(value).toLocaleString()} tokens`;
    }

    // ------------------------------------------------------------------
    // The schema
    // ------------------------------------------------------------------

    const SETTINGS_SCHEMA = [
        {
            id: 'agent',
            label: 'Agent',
            icon: 'fa-robot',
            pages: [
                {
                    id: 'planning',
                    label: 'Planning',
                    icon: 'fa-list-check',
                    summary: settings => `${settings.concurrency === 'parallel' ? 'Parallel' : 'Sequential'} lenses`
                        + ` · questions ${settings.askClarifyingQuestions ? 'on' : 'off'}`
                        + ` · review gate ${settings.requireReviewGate ? 'on' : 'off'}`,
                    groups: [
                        {
                            id: 'flow',
                            label: 'Run flow',
                            icon: 'fa-diagram-project',
                            fields: [
                                {
                                    key: 'concurrency',
                                    label: 'Lens concurrency',
                                    type: 'segmented',
                                    help: 'Multi-lens skills (PRD Builder) run their three lenses either all at once or one after another. Both produce identical output — sequential is lighter on a single local endpoint and easier to watch.',
                                    options: [
                                        { value: 'parallel', label: 'Parallel', icon: 'fa-bolt', hint: 'Three requests at once. Fastest.' },
                                        { value: 'sequential', label: 'Sequential', icon: 'fa-list-ol', hint: 'One lens at a time. Gentler on VRAM.' }
                                    ]
                                },
                                {
                                    key: 'askClarifyingQuestions',
                                    label: 'Ask clarifying questions',
                                    type: 'toggle',
                                    help: 'When on, the skill asks its own questions one at a time as visible steps and waits for your answer before any model turn. When off, Blueprint goes straight to the lenses using only what you described.'
                                },
                                {
                                    key: 'announceSkill',
                                    label: 'Announce the chosen skill',
                                    type: 'toggle',
                                    help: 'Adds a first step naming the skill being used and what it will produce, so the transcript says what is about to happen before it happens.'
                                },
                                {
                                    key: 'selfReviewPass',
                                    label: 'Self-review pass',
                                    type: 'toggle',
                                    help: 'After a document is written, Blueprint re-reads it and reports which required sections are present, which are thin, and what is missing. Costs no model turn — it is a structural check over the written text.'
                                },
                                {
                                    key: 'requireReviewGate',
                                    label: 'End on a review gate',
                                    type: 'toggle',
                                    help: 'Finishes every run with an explicit "your review gate" step listing what to check before treating the document as final. Turn off for uninterrupted batch runs.'
                                },
                                {
                                    key: 'autoOpenWrittenDocument',
                                    label: 'Open written documents',
                                    type: 'toggle',
                                    help: 'Opens each document in its own editor tab as soon as it is written, instead of leaving it in the file tree for you to find.'
                                }
                            ]
                        }
                    ]
                },
                {
                    id: 'model',
                    label: 'Model',
                    icon: 'fa-microchip',
                    summary: settings => `temp ${settings.temperature.toFixed(2)}`
                        + ` · lens ${tokens(settings.lensMaxOutputTokens)}`
                        + ` · doc ${tokens(settings.documentMaxOutputTokens)}`,
                    groups: [
                        {
                            id: 'sampling',
                            label: 'Sampling',
                            icon: 'fa-temperature-half',
                            fields: [
                                {
                                    key: 'temperature',
                                    label: 'Temperature',
                                    type: 'range',
                                    min: 0,
                                    max: 1.5,
                                    step: 0.05,
                                    unit: '',
                                    format: value => Number(value).toFixed(2),
                                    help: 'Lower keeps the planning lenses close to the brief and the templates. Higher loosens phrasing. Blueprint sends this with every turn.',
                                    hints: [
                                        { at: 0, label: 'Deterministic' },
                                        { at: 0.3, label: 'Planning default' },
                                        { at: 0.7, label: 'Looser prose' },
                                        { at: 1.2, label: 'Divergent' }
                                    ]
                                }
                            ]
                        },
                        {
                            id: 'budgets',
                            label: 'Output budgets',
                            icon: 'fa-gauge-high',
                            fields: [
                                {
                                    key: 'lensMaxOutputTokens',
                                    label: 'Lens token budget',
                                    type: 'number',
                                    min: 512,
                                    max: 32768,
                                    step: 256,
                                    unit: 'tokens',
                                    help: 'Per-lens ceiling for multi-lens skills. A lens that keeps stopping mid-section needs more room here — this is per step, not per run.'
                                },
                                {
                                    key: 'documentMaxOutputTokens',
                                    label: 'Document token budget',
                                    type: 'number',
                                    min: 512,
                                    max: 32768,
                                    step: 512,
                                    unit: 'tokens',
                                    help: 'Ceiling for the synthesis pass and for single-document skills. A full PRD needs noticeably more room than one lens.'
                                },
                                {
                                    key: 'maxPromptChars',
                                    label: 'Prompt preview length',
                                    type: 'number',
                                    min: 200,
                                    max: 8000,
                                    step: 200,
                                    unit: 'chars',
                                    help: 'How much of each prompt the step row keeps for you to read. The full prompt is always sent to the model; this only affects what the transcript stores and displays.'
                                }
                            ]
                        },
                        {
                            id: 'compression',
                            label: 'Context compression (Anti-gravity Protocol)',
                            icon: 'fa-bolt-lightning',
                            note: 'Compresses long conversation transcripts into dense, structured Anti-gravity summaries (# Resuming from a compaction... <summary>) while preserving user requests and decisions.',
                            fields: [
                                {
                                    key: 'contextCompression',
                                    label: 'Enable context compression',
                                    type: 'toggle',
                                    help: 'Compress conversation history when the transcript grows long, preventing context overflow while preserving all user requests, decisions, and constraints.'
                                },
                                {
                                    key: 'autoCompactThreshold',
                                    label: 'Auto-compaction threshold',
                                    type: 'number',
                                    min: 2,
                                    max: 20,
                                    step: 1,
                                    unit: 'messages',
                                    help: 'Number of conversation messages that triggers automatic background context compaction.'
                                }
                            ]
                        },
                        {
                            id: 'endpoint',
                            label: 'Endpoint',
                            icon: 'fa-plug',
                            note: 'Blueprint never stores credentials or adds its own endpoint. It uses whichever model endpoint SimpleRAG is already configured with.',
                            fields: [
                                {
                                    key: 'confirmStop',
                                    label: 'Confirm before stopping',
                                    type: 'toggle',
                                    help: 'Ask before cancelling a running step. Stop sends a real cancel to the backend turn, so an accidental click loses the work in progress.'
                                }
                            ]
                        }
                    ]
                },
                {
                    id: 'steps',
                    label: 'Step detail',
                    icon: 'fa-shoe-prints',
                    summary: settings => `${settings.streamLive ? 'Live' : 'Batched'} tokens`
                        + ` · prompts ${settings.showPromptPreview ? 'shown' : 'hidden'}`
                        + ` · timings ${settings.stepElapsed ? 'on' : 'off'}`,
                    groups: [
                        {
                            id: 'transcript',
                            label: 'Transcript',
                            icon: 'fa-timeline',
                            fields: [
                                {
                                    key: 'streamLive',
                                    label: 'Stream tokens live',
                                    type: 'toggle',
                                    help: 'Paints each token into the open step as it arrives. Turn off to render only the finished output per step — calmer on long runs and cheaper to repaint.'
                                },
                                {
                                    key: 'showPromptPreview',
                                    label: 'Show the prompt sent',
                                    type: 'toggle',
                                    help: 'Each model step can expand to show the exact prompt Blueprint sent. This is the point of the visible-step design; turn it off only if the transcript gets noisy.'
                                },
                                {
                                    key: 'stepElapsed',
                                    label: 'Show step timings',
                                    type: 'toggle',
                                    help: 'Adds the elapsed time to each finished step, so you can see which lens is slow on your endpoint.'
                                },
                                {
                                    key: 'expandRunningSteps',
                                    label: 'Auto-expand running steps',
                                    type: 'toggle',
                                    help: 'Opens a step automatically while it runs and collapses it when it finishes. Off keeps the timeline compact and you expand what you want to read.'
                                },
                                {
                                    key: 'autoScrollTranscript',
                                    label: 'Follow the transcript',
                                    type: 'toggle',
                                    help: 'Scrolls to the newest output while a step streams. Turn off to read earlier steps without being pulled back down.'
                                }
                            ]
                        }
                    ]
                }
            ]
        },
        {
            id: 'documents',
            label: 'Documents',
            icon: 'fa-file-lines',
            pages: [
                {
                    id: 'naming',
                    label: 'Naming & folders',
                    icon: 'fa-folder-tree',
                    summary: settings => `${settings.fileNameStyle === 'date-slug' ? 'date-slug' : settings.fileNameStyle === 'slug-date' ? 'slug-date' : 'slug'}`
                        + ` · conflicts ${settings.overwriteExistingFile}`,
                    groups: [
                        {
                            id: 'files',
                            label: 'Generated files',
                            icon: 'fa-file-pen',
                            fields: [
                                {
                                    key: 'fileNameStyle',
                                    label: 'File name style',
                                    type: 'segmented',
                                    help: 'How Blueprint names each generated document. The upstream skills default to date-first so a folder sorts chronologically.',
                                    options: [
                                        { value: 'date-slug', label: 'date-slug', icon: 'fa-calendar-day', hint: '2026-09-03-toolshare-prd.md' },
                                        { value: 'slug-date', label: 'slug-date', icon: 'fa-signature', hint: 'toolshare-prd-2026-09-03.md' },
                                        { value: 'slug', label: 'slug', icon: 'fa-tag', hint: 'toolshare-prd.md' }
                                    ]
                                },
                                {
                                    key: 'overwriteExistingFile',
                                    label: 'When the file already exists',
                                    type: 'select',
                                    help: 'What to do if a run would write a path that already holds a document.',
                                    options: [
                                        { value: 'ask', label: 'Ask me', icon: 'fa-circle-question', hint: 'Opens a dialog before touching the existing file.' },
                                        { value: 'version', label: 'Write a new version', icon: 'fa-code-branch', hint: 'Adds -2, -3, ... so nothing is ever lost.' },
                                        { value: 'overwrite', label: 'Overwrite it', icon: 'fa-recycle', hint: 'Replaces the old document with no prompt.' }
                                    ]
                                },
                                {
                                    key: 'folderLayout',
                                    label: 'Folder layout',
                                    type: 'segmented',
                                    help: 'Where documents land in the project tree.',
                                    options: [
                                        { value: 'skill-folders', label: 'Per skill', icon: 'fa-folder-open', hint: 'docs/prd, docs/mvp, docs/gtm, docs/arch-eval — the upstream layout.' },
                                        { value: 'flat', label: 'Flat docs/', icon: 'fa-folder', hint: 'Everything in docs/ with the skill name in the file name.' }
                                    ]
                                }
                            ]
                        }
                    ]
                },
                {
                    id: 'content',
                    label: 'Content handling',
                    icon: 'fa-wand-magic-sparkles',
                    summary: settings => `${[settings.applyDocumentHeader, settings.substitutePlaceholders, settings.unwrapCodeFences].filter(Boolean).length}/3 cleanups on`,
                    groups: [
                        {
                            id: 'cleanup',
                            label: 'Before writing',
                            icon: 'fa-broom',
                            note: 'Model output is tidied deterministically — no extra model turn is spent on any of this.',
                            fields: [
                                {
                                    key: 'unwrapCodeFences',
                                    label: 'Unwrap code fences',
                                    type: 'toggle',
                                    help: 'Strips a ```markdown fence the model wrapped the whole document in, so the file contains the document and not a code block containing it.'
                                },
                                {
                                    key: 'substitutePlaceholders',
                                    label: 'Substitute placeholders',
                                    type: 'toggle',
                                    help: 'Replaces <date> and <Project Name> from the upstream templates with the real run date and project name.'
                                },
                                {
                                    key: 'applyDocumentHeader',
                                    label: 'Add a provenance header',
                                    type: 'toggle',
                                    help: 'Inserts a short blockquote naming the skill and the date, so a document read later says where it came from.'
                                },
                                {
                                    key: 'trimPreamble',
                                    label: 'Trim model preamble',
                                    type: 'toggle',
                                    help: 'Drops leading chatter before the first Markdown heading ("Here is your PRD:") so the file starts at the document.'
                                }
                            ]
                        },
                        {
                            id: 'guidance',
                            label: 'Standing guidance',
                            icon: 'fa-quote-left',
                            fields: [
                                {
                                    key: 'extraGuidance',
                                    label: 'Extra instruction for every turn',
                                    type: 'textarea',
                                    rows: 4,
                                    maxChars: 1200,
                                    placeholder: 'e.g. Write in British English. Keep sections under 120 words. Never invent metrics.',
                                    help: 'Appended to the system prompt of every Blueprint model turn. Use it for house style, language, or hard constraints. Leave empty for the skills\' own wording only.'
                                }
                            ]
                        }
                    ]
                }
            ]
        },
        {
            id: 'workspace',
            label: 'Workspace',
            icon: 'fa-table-columns',
            pages: [
                {
                    id: 'tabs',
                    label: 'Tabs',
                    icon: 'fa-clone',
                    summary: settings => `${settings.pinAgentTab ? 'Agent pinned' : 'Agent closable'}`
                        + ` · up to ${settings.maxOpenTabs} tabs`
                        + ` · ${settings.restoreTabsOnLoad ? 'restored' : 'fresh'} on load`,
                    groups: [
                        {
                            id: 'behaviour',
                            label: 'Tab behaviour',
                            icon: 'fa-window-restore',
                            fields: [
                                {
                                    key: 'pinAgentTab',
                                    label: 'Keep the Agent tab pinned',
                                    type: 'toggle',
                                    help: 'The chat stays open as the first tab and cannot be closed, so opening Project Files or Settings never loses the conversation in progress.'
                                },
                                {
                                    key: 'maxOpenTabs',
                                    label: 'Maximum open tabs',
                                    type: 'number',
                                    min: 2,
                                    max: 24,
                                    step: 1,
                                    unit: 'tabs',
                                    help: 'Opening a document beyond this limit closes the least recently used document tab. The pinned Agent tab and the current tab are never closed.'
                                },
                                {
                                    key: 'restoreTabsOnLoad',
                                    label: 'Restore tabs on load',
                                    type: 'toggle',
                                    help: 'Reopens last session\'s tabs when the page mounts. Off starts every visit on the Agent tab alone.'
                                },
                                {
                                    key: 'closeTabOnDelete',
                                    label: 'Close a tab when its file is deleted',
                                    type: 'toggle',
                                    help: 'Removes the editor tab after you delete the document it was showing. Off leaves the tab open on an empty state.'
                                }
                            ]
                        }
                    ]
                },
                {
                    id: 'layout',
                    label: 'Layout',
                    icon: 'fa-ruler-combined',
                    summary: settings => `sidebar ${settings.listPaneWidth}px`
                        + ` · tree indent ${settings.treeIndentPx}px`,
                    groups: [
                        {
                            id: 'panes',
                            label: 'Panes',
                            icon: 'fa-table-columns',
                            fields: [
                                {
                                    key: 'listPaneWidth',
                                    label: 'Sidebar width',
                                    type: 'range',
                                    min: 220,
                                    max: 520,
                                    step: 10,
                                    unit: 'px',
                                    format: value => `${value}px`,
                                    help: 'Width of the left sidebar (skills, file tree, run list). Drag the divider between the panes to set it directly; the value is stored here.',
                                    hints: [
                                        { at: 220, label: 'Narrow' },
                                        { at: 300, label: 'Default' },
                                        { at: 420, label: 'Wide' }
                                    ]
                                },
                                {
                                    key: 'treeIndentPx',
                                    label: 'Tree indent per level',
                                    type: 'range',
                                    min: 8,
                                    max: 28,
                                    step: 1,
                                    unit: 'px',
                                    format: value => `${value}px`,
                                    help: 'How far each nested folder level indents in the project file tree.'
                                },
                                {
                                    key: 'autoExpandWrittenFolders',
                                    label: 'Expand folders a run writes to',
                                    type: 'toggle',
                                    help: 'Opens docs/prd and friends automatically when a run writes into them, so the new file is visible in the tree without hunting.'
                                },
                                {
                                    key: 'showFileMeta',
                                    label: 'Show file size and time in the tree',
                                    type: 'toggle',
                                    help: 'Adds character count and last-written time to each tree row. Off keeps the tree to names only.'
                                }
                            ]
                        }
                    ]
                },
                {
                    id: 'editor',
                    label: 'Editor',
                    icon: 'fa-pen-nib',
                    summary: settings => `${settings.defaultViewerMode === 'preview' ? 'Preview' : 'Source'} by default`
                        + ` · wrap ${settings.wrapLongLines ? 'on' : 'off'}`
                        + ` · lines ${settings.showLineNumbers ? 'on' : 'off'}`
                        + ` · colour ${settings.syntaxHighlighting ? 'on' : 'off'}`,
                    groups: [
                        {
                            id: 'viewing',
                            label: 'Viewing documents',
                            icon: 'fa-eye',
                            fields: [
                                {
                                    key: 'defaultViewerMode',
                                    label: 'Open documents in',
                                    type: 'segmented',
                                    help: 'Whether a document tab starts on rendered Markdown or raw source. Each tab can still be flipped individually.',
                                    options: [
                                        { value: 'preview', label: 'Preview', icon: 'fa-eye', hint: 'Rendered Markdown.' },
                                        { value: 'source', label: 'Source', icon: 'fa-code', hint: 'Raw Markdown, monospace.' }
                                    ]
                                },
                                {
                                    key: 'wrapLongLines',
                                    label: 'Wrap long lines',
                                    type: 'toggle',
                                    help: 'In source view, wraps instead of scrolling sideways. Preview view always wraps.'
                                },
                                {
                                    key: 'showLineNumbers',
                                    label: 'Show line numbers',
                                    type: 'toggle',
                                    help: 'Adds a gutter with line numbers in source view, so you can quote a line when asking for a revision. The status bar reports Ln / Col as you click through the file.'
                                },
                                {
                                    key: 'syntaxHighlighting',
                                    label: 'Syntax highlighting',
                                    type: 'toggle',
                                    help: 'Colours keywords, strings, comments and headings in source view. Turn it off for a plain monochrome view, or when previewing a very large file.'
                                },
                                {
                                    key: 'readingWidth',
                                    label: 'Reading width',
                                    type: 'segmented',
                                    help: 'How wide the rendered document column is inside its tab.',
                                    options: [
                                        { value: 'narrow', label: 'Narrow', icon: 'fa-compress', hint: 'About 68 characters per line.' },
                                        { value: 'wide', label: 'Wide', icon: 'fa-expand', hint: 'About 96 characters per line.' },
                                        { value: 'full', label: 'Full', icon: 'fa-up-right-and-down-left-from-center', hint: 'Fills the tab.' }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            ]
        },
        {
            id: 'source',
            label: 'Source files',
            icon: 'fa-code',
            pages: [
                {
                    id: 'limits',
                    label: 'Attach limits',
                    icon: 'fa-weight-hanging',
                    summary: settings => `${settings.maxSourceFiles} files`
                        + ` · ${settings.maxSourceFileKb} KB each`
                        + ` · ${settings.maxSourceTotalKb} KB total`,
                    groups: [
                        {
                            id: 'budget',
                            label: 'What can be attached',
                            icon: 'fa-paperclip',
                            note: 'Attached source is stored in the plug-in\'s own local project store and sent inside the prompt. These limits keep a prompt from exceeding the endpoint\'s context window.',
                            fields: [
                                {
                                    key: 'maxSourceFiles',
                                    label: 'Maximum attached files',
                                    type: 'number',
                                    min: 1,
                                    max: 150,
                                    step: 1,
                                    unit: 'files',
                                    help: 'How many source files the code-reading skills may carry into a prompt.'
                                },
                                {
                                    key: 'maxSourceFileKb',
                                    label: 'Maximum size per file',
                                    type: 'number',
                                    min: 8,
                                    max: 2048,
                                    step: 8,
                                    unit: 'KB',
                                    help: 'A single file larger than this is refused at attach time rather than truncated silently mid-prompt.'
                                },
                                {
                                    key: 'maxSourceTotalKb',
                                    label: 'Maximum total size',
                                    type: 'number',
                                    min: 32,
                                    max: 16384,
                                    step: 32,
                                    unit: 'KB',
                                    help: 'Combined ceiling for every attached file. Lower this if your endpoint has a small context window.'
                                },
                                {
                                    key: 'includeSourceInPrompts',
                                    label: 'Send attached source to the model',
                                    type: 'toggle',
                                    help: 'Off keeps source in the project for reference but leaves it out of prompts — the code-reading skills then refuse to run rather than evaluate code they cannot see.'
                                }
                            ]
                        }
                    ]
                }
            ]
        },
        {
            id: 'data',
            label: 'Data',
            icon: 'fa-database',
            pages: [
                {
                    id: 'storage',
                    label: 'Storage & privacy',
                    icon: 'fa-shield-halved',
                    summary: () => 'Local to this browser profile',
                    groups: [
                        {
                            id: 'privacy',
                            label: 'What Blueprint touches',
                            icon: 'fa-user-shield',
                            note: 'Blueprint is a guest in SimpleRAG. Your journal, documents, knowledge graph and settings are never read or written — every document, run and preference lives in this browser profile under Blueprint\u2019s own storage keys. The only thing sent anywhere is the prompt for the model endpoint you already configured.',
                            fields: [
                                {
                                    key: 'showStorageUsage',
                                    label: 'Show storage usage on this page',
                                    type: 'toggle',
                                    help: 'Displays how much of the browser\'s local storage Blueprint\'s projects, runs and settings occupy, refreshed when this page renders.'
                                }
                            ]
                        }
                    ]
                },
                {
                    id: 'maintenance',
                    label: 'Maintenance',
                    icon: 'fa-screwdriver-wrench',
                    summary: () => 'Export, reset, clear',
                    groups: [
                        {
                            id: 'actions',
                            label: 'Actions',
                            icon: 'fa-bolt',
                            note: 'Every action here asks for confirmation first and affects only Blueprint\'s own stored data.',
                            actions: [
                                { key: 'export-project', label: 'Export project', icon: 'fa-file-zipper', tone: 'default', help: 'Downloads every document in the project as a single .zip-free Markdown bundle.' },
                                { key: 'export-settings', label: 'Export settings', icon: 'fa-file-arrow-down', tone: 'default', help: 'Downloads these settings as JSON you can keep or share.' },
                                { key: 'import-settings', label: 'Import settings', icon: 'fa-file-arrow-up', tone: 'default', help: 'Restores settings from a JSON file. Unknown keys are ignored; values are clamped to their documented bounds.' },
                                { key: 'reset-settings', label: 'Reset settings', icon: 'fa-rotate-left', tone: 'warn', help: 'Returns every setting on this page to its documented default.' },
                                { key: 'clear-runs', label: 'Clear run history', icon: 'fa-clock-rotate-left', tone: 'warn', help: 'Deletes every stored run and its step trace. Documents already written stay in the project.' },
                                { key: 'clear-files', label: 'Clear project files', icon: 'fa-folder-minus', tone: 'danger', help: 'Deletes every document and attached source file from the project. Run history is kept.' },
                                { key: 'clear-all', label: 'Erase all Blueprint data', icon: 'fa-trash-can', tone: 'danger', help: 'Removes projects, runs, settings and the removal marker — the plug-in starts as if freshly installed.' }
                            ]
                        }
                    ]
                }
            ]
        }
    ];

    // ------------------------------------------------------------------
    // Defaults derived from the schema (single source of truth)
    // ------------------------------------------------------------------

    const ALL_FIELDS = [];
    SETTINGS_SCHEMA.forEach(section => {
        section.pages.forEach(page => {
            page.groups.forEach(group => {
                (group.fields || []).forEach(field => {
                    ALL_FIELDS.push(Object.assign({ sectionId: section.id, pageId: page.id, groupId: group.id }, field));
                });
            });
        });
    });

    const FIELD_BY_KEY = new Map(ALL_FIELDS.map(field => [field.key, field]));

    /**
     * Default for a field. core.DEFAULT_SETTINGS wins where it has an opinion
     * (so headless runs and UI runs agree), otherwise the schema supplies it.
     */
    function defaultFor(field) {
        const coreDefaults = (core && core.DEFAULT_SETTINGS) || {};
        if (Object.prototype.hasOwnProperty.call(coreDefaults, field.key)) return coreDefaults[field.key];
        switch (field.type) {
            case 'toggle': return field.default !== undefined ? field.default : true;
            case 'number':
            case 'range':
                return field.default !== undefined ? field.default : field.min;
            case 'segmented':
            case 'select':
                return field.default !== undefined ? field.default : field.options[0].value;
            case 'text':
            case 'textarea':
                return field.default !== undefined ? field.default : '';
            default:
                return field.default !== undefined ? field.default : null;
        }
    }

    const SCHEMA_DEFAULTS = ALL_FIELDS.reduce((acc, field) => {
        acc[field.key] = defaultFor(field);
        return acc;
    }, {});

    /**
     * Normalize a raw settings object: keep every schema key, clamp every value
     * to its documented bounds, drop anything unknown.
     */
    function normalizeSettings(raw) {
        const source = (raw && typeof raw === 'object') ? raw : {};
        const base = Object.assign({}, (core && core.DEFAULT_SETTINGS) || {}, SCHEMA_DEFAULTS);
        const next = {};
        ALL_FIELDS.forEach(field => {
            const fallback = base[field.key] !== undefined ? base[field.key] : defaultFor(field);
            next[field.key] = coerceField(field, source[field.key], fallback);
        });
        return next;
    }

    // ------------------------------------------------------------------
    // Lookup helpers used by the UI
    // ------------------------------------------------------------------

    function sections() {
        return SETTINGS_SCHEMA;
    }

    function getSection(sectionId) {
        return SETTINGS_SCHEMA.find(section => section.id === sectionId) || SETTINGS_SCHEMA[0];
    }

    function getPage(sectionId, pageId) {
        const section = getSection(sectionId);
        return section.pages.find(page => page.id === pageId) || section.pages[0];
    }

    function getField(key) {
        return FIELD_BY_KEY.get(key) || null;
    }

    function allFields() {
        return ALL_FIELDS;
    }

    function pageSummary(sectionId, pageId, settings) {
        const page = getPage(sectionId, pageId);
        try {
            return typeof page.summary === 'function' ? page.summary(settings) : '';
        } catch (_) {
            return '';
        }
    }

    /** Section-level roll-up for the sidebar: first page's summary. */
    function sectionSummary(sectionId, settings) {
        const section = getSection(sectionId);
        return pageSummary(sectionId, section.pages[0].id, settings);
    }

    // ------------------------------------------------------------------
    // Search index — so "where is temperature" answers directly
    // ------------------------------------------------------------------

    const STOP_WORDS = new Set([
        'a', 'an', 'and', 'are', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it',
        'of', 'on', 'or', 'set', 'setting', 'settings', 'the', 'to', 'what', 'where', 'with'
    ]);

    function fieldSearchText(field, section, page, group) {
        const optionLabels = (field.options || []).map(option => `${option.label} ${option.hint || ''}`).join(' ');
        return [
            field.key.replace(/([A-Z])/g, ' $1'),
            field.label,
            field.help || '',
            optionLabels,
            group.label,
            page.label,
            section.label
        ].join(' ').toLowerCase();
    }

    const SEARCH_INDEX = ALL_FIELDS.map(field => {
        const section = getSection(field.sectionId);
        const page = getPage(field.sectionId, field.pageId);
        const group = page.groups.find(item => item.id === field.groupId) || { label: '' };
        return {
            key: field.key,
            label: field.label,
            sectionId: field.sectionId,
            pageId: field.pageId,
            text: fieldSearchText(field, section, page, group),
            tokens: new Set(
                fieldSearchText(field, section, page, group)
                    .split(/[^a-z0-9]+/)
                    .filter(token => token.length > 2 && !STOP_WORDS.has(token))
            )
        };
    });

    /**
     * Rank fields against a query. Returns best matches first, capped.
     * Matches on the label weigh more than body matches.
     */
    function searchFields(query, limit) {
        const raw = String(query || '').trim().toLowerCase();
        if (!raw) return [];
        const words = raw.split(/\s+/).filter(word => word.length > 1 && !STOP_WORDS.has(word));
        if (!words.length) return [];
        const cap = limit || 12;

        const scored = SEARCH_INDEX
            .map(entry => {
                let score = 0;
                words.forEach(word => {
                    if (entry.label.toLowerCase().includes(word)) score += 6;
                    if (entry.key.toLowerCase().includes(word.replace(/\s+/g, ''))) score += 5;
                    if (entry.tokens.has(word)) score += 3;
                    else if (entry.text.includes(word)) score += 1;
                });
                // Every word must appear somewhere, or it is not a match.
                const covered = words.every(word => entry.text.includes(word));
                return { entry, score: covered ? score : 0 };
            })
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
            .slice(0, cap);

        return scored.map(item => ({
            key: item.entry.key,
            label: item.entry.label,
            sectionId: item.entry.sectionId,
            pageId: item.entry.pageId,
            score: item.score
        }));
    }

    /** Group results by section for display. */
    function searchSections(query) {
        const hits = searchFields(query, 24);
        const bySection = new Map();
        hits.forEach(hit => {
            const section = getSection(hit.sectionId);
            if (!bySection.has(section.id)) {
                bySection.set(section.id, { section, pageId: hit.pageId, hits: [] });
            }
            const bucket = bySection.get(section.id);
            if (hit.pageId !== bucket.pageId) bucket.pageId = hit.pageId;
            bucket.hits.push(hit);
        });
        return [...bySection.values()];
    }

    // ------------------------------------------------------------------
    // Import / export
    // ------------------------------------------------------------------

    function exportSettings(settings) {
        const out = { format: 'codalio-blueprint.settings', version: 1, exportedAt: new Date().toISOString(), settings: {} };
        ALL_FIELDS.forEach(field => {
            if (settings[field.key] !== undefined) out.settings[field.key] = settings[field.key];
        });
        return JSON.stringify(out, null, 2);
    }

    /**
     * Parse an exported settings file. Accepts either the wrapped export format
     * or a bare { key: value } object. Unknown keys are dropped, values clamped.
     */
    function parseSettingsFile(text) {
        const parsed = JSON.parse(String(text || ''));
        if (!parsed || typeof parsed !== 'object') throw new Error('Not a settings object.');
        const candidate = (parsed.settings && typeof parsed.settings === 'object') ? parsed.settings : parsed;
        const known = Object.keys(candidate).filter(key => FIELD_BY_KEY.has(key));
        if (!known.length) throw new Error('No recognised Blueprint settings in that file.');
        const current = normalizeSettings(core ? core.readSettings() : {});
        const merged = Object.assign({}, current);
        known.forEach(key => { merged[key] = candidate[key]; });
        return { settings: normalizeSettings(merged), applied: known.length, ignored: Object.keys(candidate).length - known.length };
    }

    /** Human-readable description of one field's current value. */
    function describeValue(field, value) {
        if (field.type === 'toggle') return value ? 'On' : 'Off';
        if (field.type === 'segmented' || field.type === 'select') {
            const option = (field.options || []).find(item => item.value === value);
            return option ? option.label : String(value);
        }
        if (field.type === 'range' || field.type === 'number') {
            const formatted = typeof field.format === 'function' ? field.format(value) : String(value);
            return field.unit ? `${formatted} ${field.unit}` : formatted;
        }
        if (field.type === 'textarea' || field.type === 'text') {
            const text = String(value || '').trim();
            if (!text) return 'Empty';
            return text.length > 48 ? `${text.slice(0, 48)}...` : text;
        }
        return String(value);
    }

    window.__codalioBlueprintSettings = Object.freeze({
        SETTINGS_SCHEMA,
        SCHEMA_DEFAULTS,
        ALL_FIELDS,
        sections,
        getSection,
        getPage,
        getField,
        allFields,
        defaultFor,
        coerceField,
        normalizeSettings,
        pageSummary,
        sectionSummary,
        searchFields,
        searchSections,
        exportSettings,
        parseSettingsFile,
        describeValue
    });
}());
