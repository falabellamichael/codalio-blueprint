/*
 * Codalio Blueprint skill definitions.
 *
 * Faithful port of the codalio-blueprint planning skills (MIT, Codalio) into
 * declarative phase plans the Blueprint agent can execute and show step by
 * step. Lens prompts, process order, output contracts, document templates, and
 * output paths all come from skills/*\/SKILL.md and their references.
 *
 * Skills that the source defines as reading a real codebase
 * (arch-evaluation, code-to-prd) declare requiresSource: true — the agent stops
 * and asks for source instead of inventing an evaluation from nothing.
 */
(function defineBlueprintSkills() {
    'use strict';

    if (window.__codalioBlueprintSkills) return;

    // ------------------------------------------------------------------
    // Shared prompt fragments
    // ------------------------------------------------------------------

    const NO_PREAMBLE = 'No preamble, no meta-commentary about the process, no restating these instructions.';

    const IDEA_BLOCK = (idea, answers) => {
        const lines = ['## Idea as described by the user', '', String(idea || '').trim() || '(not provided)'];
        const resolved = (answers || []).filter(item => item && String(item.answer || '').trim());
        if (resolved.length) {
            lines.push('', '## Clarifying answers already gathered');
            resolved.forEach(item => {
                lines.push(`- ${String(item.question).trim()}: ${String(item.answer).trim()}`);
            });
        }
        return lines.join('\n');
    };

    const PRIOR_SECTION = (label, text) => {
        if (!text || !String(text).trim()) return '';
        return `\n\n## ${label} (already produced — carry its facts forward, do not re-derive them)\n\n${String(text).trim()}`;
    };

    // ------------------------------------------------------------------
    // Lens prompts — prd-builder (from skills/prd-builder/references/lens-prompts.md)
    // ------------------------------------------------------------------

    const LENS_PRODUCT = {
        id: 'lens-product',
        label: 'Lens 1 — Product & Scope',
        icon: 'fa-bullseye',
        summary: 'Elevator pitch, problem, target user, user stories, and the Now/Next/Later MVP checklist.',
        buildPrompt(input) {
            return [
                'You are running ONE lens of a PRD build: Product & Scope. Other lenses run separately, so produce only your own findings.',
                '',
                'Task: Given the idea and clarifying answers below, work out the product shape and its minimum viable scope.',
                '',
                'Cover exactly these sections, in this order, as Markdown:',
                '1. **Elevator pitch** — one sentence: "For [target user] who [problem], [product name] is a [category] that [key benefit], unlike [alternative]."',
                '2. **Problem statement** — 2-3 sentences on the problem being solved and why it matters now.',
                '3. **Target user** — 3-5 bullets describing who this is for. Be specific (role, context, current workaround) rather than generic ("busy professionals").',
                '4. **User stories** — 5-10 stories, each "As a [user], I want [capability] so that [benefit]." Cover the core flow, not edge cases.',
                '5. **MVP checklist** — every user story sorted into Now (must ship v1), Next (soon after), or Later (explicitly deferred). Every Now item should trace back to a user story above.',
                '',
                'Output contract: Return only these five sections, in this order, as Markdown.',
                NO_PREAMBLE,
                '',
                IDEA_BLOCK(input.idea, input.answers)
            ].join('\n');
        }
    };

    const LENS_ARCHITECTURE = {
        id: 'lens-architecture',
        label: 'Lens 2 — Architecture & Data (lite)',
        icon: 'fa-diagram-project',
        summary: 'Core entities, plain-language relationships, and the 3-5 technical risks that could bite.',
        buildPrompt(input) {
            return [
                'You are running ONE lens of a PRD build: Architecture & Data (lite). Other lenses run separately, so produce only your own findings.',
                '',
                'Task: Given the idea and clarifying answers below, sketch the minimum data shape and flag technical risk — not a full architecture evaluation.',
                '',
                'Cover exactly these sections, in this order, as Markdown:',
                '1. **Core entities** — 3-8 entities, one line each (name + what it represents).',
                '2. **Relationships** — plain-language description of how the entities connect (e.g. "a User has many Orders; an Order belongs to one Product"). Not an ERD, not a schema.',
                '3. **Key technical risks/decisions** — 3-5 bullets: things that could bite this project technically (a hard integration, a scaling assumption, a build-vs-buy call) and, where there is an obvious default, what to do about it.',
                '',
                'Output contract: Return only these three sections, in this order, as Markdown. Explicitly note in your response that this is a lite pass, not a full architecture evaluation.',
                NO_PREAMBLE,
                '',
                IDEA_BLOCK(input.idea, input.answers)
            ].join('\n');
        }
    };

    const LENS_GTM = {
        id: 'lens-gtm',
        label: 'Lens 3 — GTM (lite)',
        icon: 'fa-bullhorn',
        summary: 'Positioning sentence, who adopts first and why, plus one channel and one checkable proof point.',
        buildPrompt(input) {
            return [
                'You are running ONE lens of a PRD build: GTM (lite). Other lenses run separately, so produce only your own findings.',
                '',
                'Task: Given the idea and clarifying answers below, sketch how this reaches its first users — not a full go-to-market plan.',
                '',
                'Cover exactly these sections, in this order, as Markdown:',
                '1. **Positioning** — one sentence: "[Product] helps [target market] [achieve outcome] by [mechanism]."',
                '2. **Target market / early adopter** — who buys or adopts first, and why they would feel the problem more acutely than the broader target user.',
                '3. **GTM angle + one early proof point** — the single most plausible channel or motion to reach the early adopter, plus one concrete, checkable signal that would prove it is working (a number, an action, a milestone).',
                '',
                'Output contract: Return only these three sections, in this order, as Markdown. Explicitly note in your response that this is a lite pass, not a full GTM plan.',
                NO_PREAMBLE,
                '',
                IDEA_BLOCK(input.idea, input.answers)
            ].join('\n');
        }
    };

    const PRD_TEMPLATE = [
        '# <Project Name> — Product Requirements Document',
        '',
        '> Generated by the prd-builder skill on <date>. Review and edit before treating this as final.',
        '',
        '## 1. Summary',
        '## 2. Target User',
        '## 3. User Stories',
        '## 4. MVP Scope (Now / Next / Later)',
        '## 5. Data & Architecture Overview (lite)',
        '## 6. Go-to-Market (lite)',
        '## 7. Open Questions',
        '## 8. Appendix: Assumptions'
    ].join('\n');

    // ------------------------------------------------------------------
    // Skills
    // ------------------------------------------------------------------

    const SKILLS = [
        {
            id: 'prd-builder',
            name: 'PRD Builder',
            icon: 'fa-file-lines',
            tagline: 'Idea in, PRD out — three lenses synthesized into one document.',
            announce: "I'm using the prd-builder skill to build your PRD.",
            description: 'Turn a rough product idea into a written PRD by running three focused analytical lenses over the same idea — product/scope, architecture-lite, GTM-lite — then synthesizing their findings into one document.',
            multiLens: true,
            lenses: [LENS_PRODUCT, LENS_ARCHITECTURE, LENS_GTM],
            clarifying: [
                { id: 'user', question: "Who is this for? (role, context, what they do today instead)" },
                { id: 'problem', question: 'What problem does it solve, and why does it matter now?' },
                { id: 'why-now', question: 'Any hard constraints — timeline, platform, or something it must integrate with?' }
            ],
            clarifyGoal: 'Stop once you can write a real first sentence of an elevator pitch.',
            phases: [
                {
                    id: 'synthesize',
                    label: 'Synthesize the three lenses into one PRD',
                    icon: 'fa-object-group',
                    summary: 'Merge the lens findings, reconcile overlaps, fill the PRD template, and self-review.',
                    kind: 'document',
                    buildPrompt(input) {
                        const lensOutputs = input.lensOutputs || {};
                        return [
                            'You are the SYNTHESIS step of the prd-builder skill. Three independent lenses already ran over the same idea. Merge them into ONE consistent PRD.',
                            '',
                            'Rules:',
                            '- Resolve overlaps: both the product and GTM lenses may name a "target user" — reconcile them into one consistent description rather than repeating two versions.',
                            '- Do NOT just concatenate the three raw lens outputs. Rewrite so the document reads as one coherent PRD.',
                            '- Reuse genuinely carried-forward facts (the target user named in the product lens feeds the GTM section).',
                            '- If the final document would let a reader tell which lens produced which paragraph, synthesis has not done its job.',
                            '- Fill every section of the template. Sections 7 (Open Questions) and 8 (Appendix: Assumptions) exist so unresolved items have somewhere to go instead of being silently guessed — put real unknowns there.',
                            '- Then self-review with fresh eyes: remove placeholder text, fix contradictions between sections, and make sure every user story has a corresponding MVP line. Fix inline before returning.',
                            '',
                            '## Output template',
                            '',
                            '```markdown',
                            PRD_TEMPLATE,
                            '```',
                            '',
                            'Return ONLY the finished Markdown document, starting at the `#` title line. No preamble, no commentary, no code fence around the whole document.',
                            '',
                            IDEA_BLOCK(input.idea, input.answers),
                            PRIOR_SECTION('Lens 1 — Product & Scope findings', lensOutputs[LENS_PRODUCT.id]),
                            PRIOR_SECTION('Lens 2 — Architecture & Data (lite) findings', lensOutputs[LENS_ARCHITECTURE.id]),
                            PRIOR_SECTION('Lens 3 — GTM (lite) findings', lensOutputs[LENS_GTM.id])
                        ].join('\n');
                    }
                }
            ],
            outputFolder: 'docs/prd',
            outputFileName(meta) {
                return `${meta.date}-${meta.slug}-prd.md`;
            },
            projectNameFrom(input) {
                return deriveProjectName(input.idea, input.answers);
            }
        },
        {
            id: 'mvp-checklist',
            name: 'MVP Checklist',
            icon: 'fa-list-check',
            tagline: 'Deeper than a Now/Next/Later sketch — forces an explicit cut list and v1 done-criteria.',
            announce: "I'm using the mvp-checklist skill to scope your MVP.",
            description: 'Turn a product idea (or an already-written PRD) into a rigorous MVP scope: not just what is in v1, but what is explicitly cut and why, and what "done" means for v1 so scope cannot quietly creep.',
            multiLens: false,
            readsExistingDocs: ['docs/prd'],
            clarifying: [
                { id: 'deadline', question: 'Any timeline or deadline pressure, and how big is the team?' },
                { id: 'launch', question: 'What does "launch" mean here — paying customers, internal pilot, or public beta?' },
                { id: 'cap', question: 'Any hard constraint that caps scope (budget, a must-hit date, a single-person team)?' }
            ],
            phases: [
                {
                    id: 'scope',
                    label: 'List, score, and cut the candidate features',
                    icon: 'fa-scissors',
                    summary: 'Pull every candidate feature, score each against the core value proposition, then write the explicit cut list.',
                    kind: 'document',
                    buildPrompt(input) {
                        const prd = (input.existingDocs || {})['docs/prd'] || '';
                        return [
                            'You are running the mvp-checklist skill. Produce a rigorous MVP scope that a founder can defend, not a casual Now/Next/Later sketch.',
                            '',
                            'Work through these steps in order, and let the finished document show the result of each:',
                            '1. List EVERY candidate feature first — do not filter yet, so cuts become visible decisions rather than silent omissions.',
                            '2. Score each candidate: does the core value proposition work without it? Is it cheap or expensive to build? Does removing it break a user story that is otherwise in v1? Use those judgments, not gut feel alone.',
                            '3. Write the explicit cut list — every feature sorted Next or Later gets one line saying what it is and why it is not in v1. This is the section people skip when scoping casually; do not skip it.',
                            '4. Define v1 done-criteria: 3-5 concrete, CHECKABLE conditions that mean v1 is complete and shippable ("a user can sign up, create X, and see Y without support intervention"), never "feels done".',
                            '5. Self-review: every Now item traces to a real user need, every cut has a stated reason, and done-criteria are actually checkable.',
                            '',
                            '## Output template',
                            '',
                            '```markdown',
                            [
                                '# <Project Name> — MVP Checklist',
                                '',
                                '> Generated by the mvp-checklist skill on <date>. Review and edit before treating this as final.',
                                '',
                                '## 1. Context',
                                '## 2. Now (v1 scope)',
                                '## 3. Next',
                                '## 4. Later',
                                '## 5. Explicit Cut List (what\u2019s out and why)',
                                '## 6. V1 Done-Criteria',
                                '## 7. Open Questions'
                            ].join('\n'),
                            '```',
                            '',
                            'Return ONLY the finished Markdown document, starting at the `#` title line.',
                            '',
                            IDEA_BLOCK(input.idea, input.answers),
                            prd
                                ? '\n\n## Existing PRD in this Blueprint project (reuse its target user, problem, and user stories rather than re-asking)\n\n' + prd.trim()
                                : ''
                        ].join('\n');
                    }
                }
            ],
            outputFolder: 'docs/mvp',
            outputFileName(meta) {
                return `${meta.date}-${meta.slug}-mvp-checklist.md`;
            },
            projectNameFrom(input) {
                return deriveProjectName(input.idea, input.answers);
            }
        },
        {
            id: 'gtm-plan',
            name: 'GTM Plan',
            icon: 'fa-rocket',
            tagline: 'Full go-to-market: positioning, ranked channels, pricing, and a phased launch sequence.',
            announce: "I'm using the gtm-plan skill to build your go-to-market plan.",
            description: 'Turn a product (idea, existing PRD, or shipped v1) into a full go-to-market plan: positioning, ranked channels, a pricing approach, and a phased launch sequence with milestones.',
            multiLens: false,
            readsExistingDocs: ['docs/prd'],
            clarifying: [
                { id: 'budget', question: 'What budget and team size do you have for GTM execution?' },
                { id: 'pricing', question: 'Is this paid, free, or freemium?' },
                { id: 'audience', question: 'Any audience or channel already in hand (email list, community, prior product)?' },
                { id: 'timeframe', question: 'What is the target launch timeframe?' }
            ],
            phases: [
                {
                    id: 'positioning',
                    label: 'Positioning and early adopter',
                    icon: 'fa-crosshairs',
                    summary: 'One positioning sentence specific enough to guide channel choice, plus who adopts first.',
                    kind: 'analysis',
                    buildPrompt(input) {
                        return [
                            'You are step 3-4 of the gtm-plan skill: POSITIONING.',
                            '',
                            'Produce:',
                            '- **Positioning** — one sentence: "[Product] helps [target market] [achieve outcome] by [mechanism]." Then state plainly whether it is specific enough to guide channel choice. A positioning statement that could describe five other products is not done yet — if yours is generic, tighten it and return the tightened version.',
                            '- **Target market & early adopter** — who buys or adopts first, and why they feel the problem more acutely than the broader target user.',
                            '',
                            'Output contract: return only those two sections as Markdown.',
                            NO_PREAMBLE,
                            '',
                            IDEA_BLOCK(input.idea, input.answers)
                        ].join('\n');
                    }
                },
                {
                    id: 'channels-pricing',
                    label: 'Ranked channels and pricing approach',
                    icon: 'fa-scale-balanced',
                    summary: 'Rank 3-5 channels against this specific early adopter; recommend a pricing model with reasoning.',
                    kind: 'analysis',
                    buildPrompt(input) {
                        return [
                            'You are steps 5-6 of the gtm-plan skill: CHANNELS and PRICING.',
                            '',
                            'Produce:',
                            '- **Channels (ranked)** — list 3-5 candidate channels (content/SEO, community, outbound, paid ads, partnerships, product-led/viral), then rank them by fit for THIS target market and budget. Do not default to a generic list; justify the ranking against who the early adopter actually is and where they already pay attention.',
                            '- **Pricing** — recommend one model (free, freemium, flat subscription, usage-based, one-time) with reasoning tied to the target user\u2019s buying pattern, not a generic recommendation. Include a rough anchor price/tier ONLY if the answers give enough signal to name one; otherwise flag it as an open question rather than inventing a number.',
                            '',
                            'Output contract: return only those two sections as Markdown.',
                            NO_PREAMBLE,
                            '',
                            IDEA_BLOCK(input.idea, input.answers),
                            PRIOR_SECTION('Positioning already agreed', input.phaseOutputs && input.phaseOutputs.positioning)
                        ].join('\n');
                    }
                },
                {
                    id: 'assemble',
                    label: 'Assemble the go-to-market plan',
                    icon: 'fa-file-lines',
                    summary: 'Phased launch sequence with a real exit criterion per phase, success metrics, and self-review.',
                    kind: 'document',
                    buildPrompt(input) {
                        const prd = (input.existingDocs || {})['docs/prd'] || '';
                        const prior = input.phaseOutputs || {};
                        return [
                            'You are the final step of the gtm-plan skill: assemble the complete plan.',
                            '',
                            'Add the launch sequence and success metrics to the positioning, channels, and pricing already produced, then self-review:',
                            '- **Launch sequence** — 3-4 phases (e.g. private beta → waitlist → public launch → post-launch iteration), each with what happens, a rough timeframe, and ONE exit criterion that says when to move to the next phase. Never "when it feels ready".',
                            '- **Success metrics** — the concrete signals that say the plan is working.',
                            '- Self-review: positioning and channels must agree on who the target user is, pricing must match the positioning\u2019s value claim, and every launch phase must have a real exit criterion.',
                            '',
                            '## Output template',
                            '',
                            '```markdown',
                            [
                                '# <Project Name> — Go-to-Market Plan',
                                '',
                                '> Generated by the gtm-plan skill on <date>. Review and edit before treating this as final.',
                                '',
                                '## 1. Positioning',
                                '## 2. Target Market & Early Adopter',
                                '## 3. Channels (ranked)',
                                '## 4. Pricing',
                                '## 5. Launch Sequence',
                                '## 6. Success Metrics',
                                '## 7. Open Questions'
                            ].join('\n'),
                            '```',
                            '',
                            'Return ONLY the finished Markdown document, starting at the `#` title line.',
                            '',
                            IDEA_BLOCK(input.idea, input.answers),
                            PRIOR_SECTION('Positioning & early adopter', prior.positioning),
                            PRIOR_SECTION('Channels & pricing', prior['channels-pricing']),
                            prd ? '\n\n## Existing PRD in this Blueprint project (reuse its target user, positioning, and GTM-lite section rather than re-asking)\n\n' + prd.trim() : ''
                        ].join('\n');
                    }
                }
            ],
            outputFolder: 'docs/gtm',
            outputFileName(meta) {
                return `${meta.date}-${meta.slug}-gtm-plan.md`;
            },
            projectNameFrom(input) {
                return deriveProjectName(input.idea, input.answers);
            }
        },
        {
            id: 'arch-evaluation',
            name: 'Architecture Evaluation',
            icon: 'fa-sitemap',
            tagline: 'Assess an actual codebase against stated requirements — not a generic best-practices audit.',
            announce: "I'm using the arch-evaluation skill to assess your codebase against these requirements.",
            description: 'Assess whether an existing codebase\u2019s architecture can support a specific set of stated requirements, and name the tech debt and risks standing in the way.',
            multiLens: false,
            requiresSource: true,
            sourceHint: 'Attach the source you want evaluated (Add file in the project tree, or paste key modules). The skill must read the actual code — directory layout, data model, integration points, and how the current architecture handles the load closest to the new requirement — and must not evaluate from a README or file names alone.',
            clarifying: [
                { id: 'requirements', question: 'What must the codebase now support — new scale, a compliance need, a must-integrate-with system, or a business/contract requirement?' },
                { id: 'decision', question: 'What decision does this evaluation feed: go/no-go, refactor-vs-rewrite, or a scoping estimate?' },
                { id: 'deadline', question: 'Any hard deadline, and any part of the codebase already known to be a problem area?' }
            ],
            phases: [
                {
                    id: 'read-codebase',
                    label: 'Read the attached codebase',
                    icon: 'fa-magnifying-glass',
                    summary: 'Summarize what is actually built — directory layout, data model, integration points, test coverage.',
                    kind: 'analysis',
                    buildPrompt(input) {
                        return [
                            'You are step 3-4 of the arch-evaluation skill: explore the codebase, then summarize the CURRENT architecture.',
                            '',
                            'Read the attached source carefully. Ground every claim in something actually present in the code — never idealize, never infer from file names alone.',
                            '',
                            'Produce:',
                            '- **What was examined** — the files/modules you actually read, so confidence can be judged.',
                            '- **Current architecture summary** — plain-language description of what is actually built: directory layout, core data model/schema, main integration points, test coverage, and how the current architecture handles the load or pattern closest to the new requirement.',
                            '- **Areas not explored** — say plainly where you could not look, so the final document can flag low confidence there.',
                            '',
                            'Output contract: return only those three sections as Markdown.',
                            NO_PREAMBLE,
                            '',
                            '## Requirements this evaluation is against',
                            '',
                            String(input.requirementsText || '').trim() || '(not provided)',
                            '',
                            IDEA_BLOCK(input.idea, input.answers),
                            sourceBlock(input.sourceFiles)
                        ].join('\n');
                    }
                },
                {
                    id: 'gap-analysis',
                    label: 'Gap analysis per requirement',
                    icon: 'fa-chart-simple',
                    summary: 'For each stated requirement: supported, partially supported, or not at all — pointing at the responsible code.',
                    kind: 'analysis',
                    buildPrompt(input) {
                        return [
                            'You are step 5-6 of the arch-evaluation skill: GAP ANALYSIS and ranked TECH DEBT.',
                            '',
                            'Produce:',
                            '- **Gap analysis** — for EACH stated requirement, does the current architecture support it, partially support it, or not at all? Point to the specific code or pattern responsible for each gap, not a vague concern.',
                            '- **Tech debt & risks, ranked** — 3-7 items ranked by how much they block THESE stated requirements specifically, not a general debt inventory.',
                            '',
                            'Output contract: return only those two sections as Markdown.',
                            NO_PREAMBLE,
                            '',
                            '## Requirements this evaluation is against',
                            '',
                            String(input.requirementsText || '').trim() || '(not provided)',
                            '',
                            IDEA_BLOCK(input.idea, input.answers),
                            PRIOR_SECTION('Current architecture already established', input.phaseOutputs && input.phaseOutputs['read-codebase']),
                            sourceBlock(input.sourceFiles)
                        ].join('\n');
                    }
                },
                {
                    id: 'recommend',
                    label: 'Recommendation and write the evaluation',
                    icon: 'fa-file-lines',
                    summary: 'Build-on, refactor, or rewrite per requirement gap — with reasoning, then self-review every claim.',
                    kind: 'document',
                    buildPrompt(input) {
                        const prior = input.phaseOutputs || {};
                        return [
                            'You are the final step of the arch-evaluation skill: recommendation plus the finished document.',
                            '',
                            'Add the recommendation, then assemble everything:',
                            '- **Recommendation** — build-on, refactor, or rewrite FOR EACH requirement gap, not one blanket verdict. State the reasoning, not just the label.',
                            '- Self-review: every claim must trace to something actually read in the codebase, not assumed. Flag anywhere confidence is low because a part of the codebase was not explored.',
                            '',
                            '## Output template',
                            '',
                            '```markdown',
                            [
                                '# <Project Name> — Architecture Evaluation',
                                '',
                                '> Generated by the arch-evaluation skill on <date>. Review and edit before treating this as final.',
                                '',
                                '## 1. Requirements Being Evaluated Against',
                                '## 2. Current Architecture Summary',
                                '## 3. Gap Analysis (per requirement)',
                                '## 4. Tech Debt & Risks (ranked)',
                                '## 5. Recommendation (per requirement)',
                                '## 6. Open Questions / Areas Not Explored'
                            ].join('\n'),
                            '```',
                            '',
                            'Return ONLY the finished Markdown document, starting at the `#` title line.',
                            '',
                            '## Requirements this evaluation is against',
                            '',
                            String(input.requirementsText || '').trim() || '(not provided)',
                            '',
                            IDEA_BLOCK(input.idea, input.answers),
                            PRIOR_SECTION('Current architecture summary', prior['read-codebase']),
                            PRIOR_SECTION('Gap analysis and ranked tech debt', prior['gap-analysis'])
                        ].join('\n');
                    }
                }
            ],
            outputFolder: 'docs/arch-eval',
            outputFileName(meta) {
                return `${meta.date}-${meta.slug}-arch-evaluation.md`;
            },
            projectNameFrom(input) {
                return deriveProjectName(input.idea, input.answers);
            }
        },
        {
            id: 'doc-generation',
            name: 'Doc Generation',
            icon: 'fa-folder-tree',
            tagline: 'Turn an approved PRD into a backlog, an API contract sketch, and an onboarding doc.',
            announce: "I'm using the doc-generation skill to generate docs from your PRD.",
            description: 'Turn an approved PRD into concrete supporting documents: a backlog, an API contract sketch, and/or an onboarding doc. Each is a distinct, focused document derived from the same source PRD — not a restatement of the PRD itself.',
            multiLens: false,
            requiresPrd: true,
            readsExistingDocs: ['docs/prd'],
            clarifying: [
                { id: 'which', question: 'Which documents do you want — backlog, API contract sketch, onboarding doc? ("everything" generates all three)', multi: ['backlog', 'api-contract', 'onboarding'] }
            ],
            phases: [
                {
                    id: 'backlog',
                    label: 'Generate the backlog',
                    icon: 'fa-list-check',
                    summary: 'One backlog item per PRD user story, grouped by the PRD\u2019s Now/Next/Later scope.',
                    kind: 'document',
                    optional: 'backlog',
                    buildPrompt(input) {
                        return docPrompt(input, {
                            title: 'Backlog',
                            path: 'docs/backlog/<date>-<slug>-backlog.md',
                            mapping: 'One backlog item per user story in the PRD, grouped by the PRD\u2019s MVP scope (Now/Next/Later). Each Now item carries a one-line acceptance note.',
                            template: [
                                '# <Project Name> — Backlog',
                                '',
                                '## Now',
                                '- [ ] <item derived from a Now-scoped user story> — <one-line acceptance note>',
                                '',
                                '## Next',
                                '- [ ] <item derived from a Next-scoped user story>',
                                '',
                                '## Later',
                                '- [ ] <item derived from a Later-scoped user story>'
                            ].join('\n')
                        });
                    }
                },
                {
                    id: 'api-contract',
                    label: 'Generate the API contract sketch',
                    icon: 'fa-plug',
                    summary: 'One resource per core PRD entity, endpoints inferred from the user stories that act on it.',
                    kind: 'document',
                    optional: 'api-contract',
                    buildPrompt(input) {
                        return docPrompt(input, {
                            title: 'API Contract Sketch',
                            path: 'docs/api/<date>-<slug>-api-contract.md',
                            mapping: 'One resource per core entity in the PRD\u2019s Data & Architecture section; endpoints inferred from the user stories that act on that entity. This is a sketch only — not a full OpenAPI spec — and must say so.',
                            template: [
                                '# <Project Name> — API Contract Sketch',
                                '',
                                '> Sketch only — not a full OpenAPI spec. Confirm before implementing.',
                                '',
                                '## <Entity Name>',
                                '',
                                '- `GET /<resource>` — <what it returns, tied to a user story>',
                                '- `POST /<resource>` — <what it creates, tied to a user story>',
                                '- ...',
                                '',
                                '(repeat per core entity)'
                            ].join('\n')
                        });
                    }
                },
                {
                    id: 'onboarding',
                    label: 'Generate the onboarding doc',
                    icon: 'fa-graduation-cap',
                    summary: 'Summary and target user from the PRD, MVP scope as "what exists today", open questions as "still evolving".',
                    kind: 'document',
                    optional: 'onboarding',
                    buildPrompt(input) {
                        return docPrompt(input, {
                            title: 'Onboarding Doc',
                            path: 'docs/onboarding/<date>-<slug>-onboarding.md',
                            mapping: 'Summary + target user from the PRD, MVP scope for "what exists today", and the open questions section flagged as "still evolving". It must not contradict the PRD\u2019s MVP scope.',
                            template: [
                                '# <Project Name> — Onboarding',
                                '',
                                '## What this is',
                                '<PRD summary, restated for a new team member>',
                                '',
                                '## Who it\u2019s for',
                                '<PRD target user>',
                                '',
                                '## What exists today (v1 scope)',
                                '<PRD\u2019s Now scope>',
                                '',
                                '## What\u2019s still evolving',
                                '<PRD\u2019s open questions>',
                                '',
                                '## Where to go deeper',
                                '<link back to the source PRD, and to backlog/API contract sketch if generated>'
                            ].join('\n')
                        });
                    }
                }
            ],
            perPhaseOutput: true,
            outputFolders: {
                backlog: 'docs/backlog',
                'api-contract': 'docs/api',
                onboarding: 'docs/onboarding'
            },
            outputFileNames: {
                backlog: meta => `${meta.date}-${meta.slug}-backlog.md`,
                'api-contract': meta => `${meta.date}-${meta.slug}-api-contract.md`,
                onboarding: meta => `${meta.date}-${meta.slug}-onboarding.md`
            },
            projectNameFrom(input) {
                return deriveProjectNameFromPrd(input.existingDocs && input.existingDocs['docs/prd'])
                    || deriveProjectName(input.idea, input.answers);
            }
        },
        {
            id: 'code-to-prd',
            name: 'Code to PRD',
            icon: 'fa-rotate-left',
            tagline: 'The reverse direction: reconstruct a PRD from an existing codebase.',
            announce: "I'm using the code-to-prd skill to reconstruct a PRD from your codebase.",
            description: 'Reconstruct a PRD-style document from an existing codebase instead of a described idea — for a project that shipped without one, or needs its requirements documented after the fact.',
            multiLens: false,
            requiresSource: true,
            sourceHint: 'Attach the codebase you want documented (Add file in the project tree, or paste the key modules). Everything in the output must be inferred from what the code actually does.',
            clarifying: [
                { id: 'audience', question: 'Who is this reconstructed PRD for — new team members, an acquirer, or a compliance/audit reader?' },
                { id: 'scope', question: 'Should it cover the whole codebase, or one subsystem?' }
            ],
            phases: [
                {
                    id: 'inventory',
                    label: 'Inventory what the code actually does',
                    icon: 'fa-boxes-stacked',
                    summary: 'Read the attached source and list the real capabilities, entities, and flows it implements.',
                    kind: 'analysis',
                    buildPrompt(input) {
                        return [
                            'You are the first step of the code-to-prd skill: inventory the existing codebase.',
                            '',
                            'Read the attached source and produce:',
                            '- **What was examined** — the files/modules you actually read.',
                            '- **Capabilities implemented** — what the software really does, inferred from code behavior rather than names or comments.',
                            '- **Core entities and relationships** — the data model as it actually exists.',
                            '- **Flows** — the main user-visible flows the code supports, end to end.',
                            '- **Gaps and unknowns** — anything you could not determine from the attached source.',
                            '',
                            'Output contract: return only those sections as Markdown.',
                            NO_PREAMBLE,
                            '',
                            IDEA_BLOCK(input.idea, input.answers),
                            sourceBlock(input.sourceFiles)
                        ].join('\n');
                    }
                },
                {
                    id: 'reconstruct',
                    label: 'Reconstruct the PRD',
                    icon: 'fa-file-lines',
                    summary: 'Write the PRD-style document from the inventory, marking every inferred item as inferred.',
                    kind: 'document',
                    buildPrompt(input) {
                        return [
                            'You are the final step of the code-to-prd skill: reconstruct the PRD from the inventory.',
                            '',
                            'Rules:',
                            '- Everything must be inferred from what the code actually does. Where you infer intent rather than observe it, mark it explicitly as inferred.',
                            '- Do not invent scope the code does not support. If a section cannot be grounded, say so in Open Questions instead of guessing.',
                            '- Target the audience named in the clarifying answers.',
                            '',
                            'Use this structure:',
                            '',
                            '```markdown',
                            [
                                '# <Project Name> — Product Requirements Document (reconstructed)',
                                '',
                                '> Reconstructed by the code-to-prd skill on <date> from the attached codebase. Review and edit before treating this as final.',
                                '',
                                '## 1. Summary',
                                '## 2. Target User (inferred)',
                                '## 3. Capabilities As Built',
                                '## 4. Core Entities & Relationships',
                                '## 5. Main Flows',
                                '## 6. Constraints & Assumptions Observed In Code',
                                '## 7. Open Questions / Not Determinable From Source'
                            ].join('\n'),
                            '```',
                            '',
                            'Return ONLY the finished Markdown document, starting at the `#` title line.',
                            '',
                            IDEA_BLOCK(input.idea, input.answers),
                            PRIOR_SECTION('Codebase inventory already produced', input.phaseOutputs && input.phaseOutputs.inventory)
                        ].join('\n');
                    }
                }
            ],
            outputFolder: 'docs/prd',
            outputFileName(meta) {
                return `${meta.date}-${meta.slug}-prd-reconstructed.md`;
            },
            projectNameFrom(input) {
                return deriveProjectName(input.idea, input.answers);
            }
        }
    ];

    // ------------------------------------------------------------------
    // Helpers shared by the skill definitions
    // ------------------------------------------------------------------

    function docPrompt(input, spec) {
        const prd = (input.existingDocs || {})['docs/prd'] || '';
        return [
            `You are the doc-generation skill producing the ${spec.title.toUpperCase()}.`,
            '',
            `Source mapping: ${spec.mapping}`,
            '',
            'Rules:',
            '- Pull directly from the PRD\u2019s user stories, entities, and MVP scope — do not invent scope the PRD does not support.',
            '- This is a distinct, focused document derived from the PRD, NOT a restatement of the PRD itself.',
            '- Start the file with the one-line backlink:',
            '  > Generated by the doc-generation skill on <date> from `docs/prd/<source-prd-filename>`.',
            `- Intended output path: ${spec.path}`,
            '',
            '## Template',
            '',
            '```markdown',
            spec.template,
            '```',
            '',
            'Return ONLY the finished Markdown document, starting at the backlink line or the `#` title line.',
            '',
            '## Source PRD',
            '',
            prd.trim() || '(no PRD content was supplied)'
        ].join('\n');
    }

    function sourceBlock(sourceFiles) {
        const files = Array.isArray(sourceFiles) ? sourceFiles.filter(Boolean) : [];
        if (!files.length) {
            return '\n\n## Attached source\n\n(no source attached)';
        }
        const parts = ['\n\n## Attached source'];
        files.forEach(file => {
            parts.push('', `### ${file.path} (${file.lines} lines)`, '', '```', file.content, '```');
        });
        return parts.join('\n');
    }

    function deriveProjectName(idea, answers) {
        const text = String(idea || '');
        const quoted = /["“']([^"”']{2,48})["”']/.exec(text);
        if (quoted) return quoted[1].trim();
        const named = /(?:called|named|dubbed)\s+([A-Z][A-Za-z0-9 .&+-]{1,40})/.exec(text);
        if (named) return named[1].trim();
        const fromAnswer = (answers || []).find(item => item && item.id === 'name' && String(item.answer || '').trim());
        if (fromAnswer) return String(fromAnswer.answer).trim().slice(0, 60);
        return '';
    }

    function deriveProjectNameFromPrd(prd) {
        const text = String(prd || '');
        const title = /^\s*#\s+(.+?)\s*(?:—|-{1,2})\s*Product Requirements/i.exec(text)
            || /^\s*#\s+(.+)$/m.exec(text);
        return title ? title[1].trim().slice(0, 60) : '';
    }

    function getSkill(id) {
        return SKILLS.find(skill => skill.id === id) || null;
    }

    window.__codalioBlueprintSkills = Object.freeze({
        SKILLS,
        getSkill,
        LENS_PRODUCT,
        LENS_ARCHITECTURE,
        LENS_GTM,
        deriveProjectName,
        deriveProjectNameFromPrd,
        sourceBlock
    });
}());
