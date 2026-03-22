/**
 * DeepLore Enhanced — Pipeline runner
 * matchEntries, runPipeline, matchTextForExternal
 */
import { getSettings, PROMPT_TAG_PREFIX } from '../settings.js';
import { buildScanText } from '../core/utils.js';
import { testEntryMatch, countKeywordOccurrences, formatAndGroup } from '../core/matching.js';
import { buildExemptionPolicy, applyRequiresExcludesGating, applyContextualGating } from './stages.js';
import {
    vaultIndex, cooldownTracker, injectionHistory, generationCount,
    trackerKey, setLastPipelineTrace, fuzzySearchIndex,
} from './state.js';
import { buildCandidateManifest, aiSearch, hierarchicalPreFilter } from './ai.js';
import { ensureIndexFresh, queryBM25 } from './vault.js';
import { name2 } from '../../../../../script.js';

/**
 * Match vault entries against chat messages, with recursive scanning support.
 * @param {object[]} chat - Chat messages array
 * @returns {{ matched: VaultEntry[], matchedKeys: Map<string, string>, probabilitySkipped: Array<{title: string, probability: number, roll: number}>, warmupFailed: Array<{title: string, needed: number, found: number}> }}
 */
export function matchEntries(chat, snapshot = null) {
    const settings = getSettings();
    const entries = snapshot || vaultIndex;
    /** @type {Set<VaultEntry>} */
    const matchedSet = new Set();
    /** @type {Map<string, string>} entry title -> matched key */
    const matchedKeys = new Map();
    /** @type {Array<{title: string, probability: number, roll: number}>} */
    const probabilitySkipped = [];
    /** @type {Array<{title: string, needed: number, found: number}>} */
    const warmupFailed = [];

    // Always collect constants regardless of scan depth
    for (const entry of entries) {
        if (entry.constant) {
            matchedSet.add(entry);
            matchedKeys.set(entry.title, '(constant)');
        }
    }

    // Collect bootstrap entries when chat is short (cold-start injection)
    if (chat.length <= settings.newChatThreshold) {
        for (const entry of entries) {
            if (entry.bootstrap && !matchedSet.has(entry)) {
                matchedSet.add(entry);
                matchedKeys.set(entry.title, '(bootstrap)');
            }
        }
    }

    // Keyword matching: skip entirely when scanDepth is 0 (AI-only mode)
    if (settings.scanDepth > 0) {
        // C5: Memoize buildScanText by depth to avoid redundant string building
        const scanTextMemo = new Map();
        function getScanText(depth) {
            if (!scanTextMemo.has(depth)) scanTextMemo.set(depth, buildScanText(chat, depth));
            return scanTextMemo.get(depth);
        }
        const globalScanText = getScanText(settings.scanDepth);

        // Initial scan pass
        for (const entry of entries) {
            if (entry.constant) continue; // Already added above

            // Use per-entry scan depth if set, otherwise use global scan text
            const scanText = entry.scanDepth !== null
                ? getScanText(entry.scanDepth)
                : globalScanText;

            const key = testEntryMatch(entry, scanText, settings);
            if (key) {
                // Warmup check: require N keyword occurrences before triggering
                if (entry.warmup !== null) {
                    const occurrences = countKeywordOccurrences(entry, scanText, settings);
                    if (occurrences < entry.warmup) {
                        if (settings.debugMode) {
                            console.debug(`[DLE] Warmup: "${entry.title}" needs ${entry.warmup} occurrences, found ${occurrences} — skipping`);
                        }
                        warmupFailed.push({ title: entry.title, needed: entry.warmup, found: occurrences });
                        continue;
                    }
                }

                // Probability check: explicit zero = never fires, otherwise random roll
                if (entry.probability === 0) {
                    if (settings.debugMode) {
                        console.debug(`[DLE] Probability: "${entry.title}" has probability 0 — skipping`);
                    }
                    probabilitySkipped.push({ title: entry.title, probability: 0, roll: 0 });
                    continue;
                }
                if (entry.probability !== null && entry.probability < 1.0) {
                    const roll = Math.random();
                    if (roll > entry.probability) {
                        if (settings.debugMode) {
                            console.debug(`[DLE] Probability: "${entry.title}" rolled ${roll.toFixed(3)} > ${entry.probability} — skipping`);
                        }
                        probabilitySkipped.push({ title: entry.title, probability: entry.probability, roll });
                        continue;
                    }
                }

                // Cooldown check: skip entries still on cooldown
                const remaining = cooldownTracker.get(trackerKey(entry));
                if (remaining !== undefined && remaining > 0) {
                    if (settings.debugMode) {
                        console.debug(`[DLE] Cooldown: "${entry.title}" has ${remaining} generations remaining — skipping`);
                    }
                    continue;
                }

                matchedSet.add(entry);
                matchedKeys.set(entry.title, key);
            }
        }

        // Pre-compute title lookup map for cascade links and character matching
        const titleMap = new Map(entries.map(e => [e.title.toLowerCase(), e]));

        // Active Character Boost: auto-match active character's vault entry
        if (settings.characterContextScan && name2) {
            const nameLower = name2.toLowerCase();
            const charEntry = titleMap.get(nameLower) || entries.find(e =>
                e.keys.some(k => k.toLowerCase() === nameLower)
            );
            if (charEntry && !matchedSet.has(charEntry)) {
                matchedSet.add(charEntry);
                matchedKeys.set(charEntry.title, '(active character)');
            }
        }

        // Cascade links: explicitly pull in linked entries from matched entries
        // Cascade-linked entries still respect cooldown/warmup/probability gates
        const cascadeSource = [...matchedSet];
        for (const entry of cascadeSource) {
            if (!entry.cascadeLinks || entry.cascadeLinks.length === 0) continue;
            for (const linkTitle of entry.cascadeLinks) {
                const linked = titleMap.get(linkTitle.toLowerCase());
                if (linked && !matchedSet.has(linked)) {
                    // Apply same gates as direct matches
                    if (linked.cooldown !== null) {
                        const remaining = cooldownTracker.get(trackerKey(linked));
                        if (remaining !== undefined && remaining > 0) continue;
                    }
                    if (linked.probability === 0) continue;
                    if (linked.probability !== null && linked.probability < 1.0 && Math.random() > linked.probability) continue;
                    if (linked.warmup !== null) {
                        const scanText = linked.scanDepth !== null ? getScanText(linked.scanDepth) : globalScanText;
                        const occurrences = countKeywordOccurrences(linked, scanText, settings);
                        if (occurrences < linked.warmup) continue;
                    }
                    matchedSet.add(linked);
                    matchedKeys.set(linked.title, `(cascade from: ${entry.title})`);
                }
            }
        }

        // Recursive scanning: scan matched entry content for more matches
        if (settings.recursiveScan && settings.maxRecursionSteps > 0) {
            let step = 0;
            let newlyMatched = new Set(matchedSet);

            while (newlyMatched.size > 0 && step < settings.maxRecursionSteps) {
                step++;

                const MAX_RECURSION_TEXT = 50000;
                let recursionText = [...newlyMatched]
                    .filter(e => !e.excludeRecursion)
                    .map(e => e.content)
                    .join('\n');
                if (recursionText.length > MAX_RECURSION_TEXT) {
                    if (settings.debugMode) console.debug('[DLE] Recursion text truncated from', recursionText.length, 'to', MAX_RECURSION_TEXT, 'chars');
                    recursionText = recursionText.substring(0, MAX_RECURSION_TEXT);
                }

                if (!recursionText.trim()) break;

                newlyMatched = new Set();

                for (const entry of entries) {
                    if (matchedSet.has(entry)) continue;
                    if (entry.constant) continue;

                    const key = testEntryMatch(entry, recursionText, settings);
                    if (key) {
                        // Recursive matches still respect cooldown/warmup/probability gates
                        if (entry.cooldown !== null) {
                            const remaining = cooldownTracker.get(trackerKey(entry));
                            if (remaining !== undefined && remaining > 0) continue;
                        }
                        if (entry.probability === 0) continue;
                        if (entry.probability !== null && entry.probability < 1.0 && Math.random() > entry.probability) continue;
                        if (entry.warmup !== null) {
                            const occurrences = countKeywordOccurrences(entry, recursionText, settings);
                            if (occurrences < entry.warmup) continue;
                        }
                        matchedSet.add(entry);
                        newlyMatched.add(entry);
                        matchedKeys.set(entry.title, `${key} (recursion step ${step})`);
                    }
                }
            }
        }
    }

    // BM25 fuzzy search: supplement keyword matches with TF-IDF scored results
    if (settings.fuzzySearchEnabled && fuzzySearchIndex && settings.scanDepth > 0) {
        const scanTextMemo2 = new Map();
        function getScanText2(depth) {
            if (!scanTextMemo2.has(depth)) scanTextMemo2.set(depth, buildScanText(chat, depth));
            return scanTextMemo2.get(depth);
        }
        const fuzzyText = getScanText2(settings.scanDepth);
        const bm25Results = queryBM25(fuzzySearchIndex, fuzzyText, 20);
        for (const result of bm25Results) {
            const entry = result.entry;
            if (matchedSet.has(entry)) continue; // Already matched by keywords
            if (entry.constant) continue;         // Constants already handled

            // Respect cooldown
            const remaining = cooldownTracker.get(trackerKey(entry));
            if (remaining !== undefined && remaining > 0) continue;

            // Respect probability
            if (entry.probability === 0) continue;
            if (entry.probability !== null && entry.probability < 1.0 && Math.random() > entry.probability) continue;

            matchedSet.add(entry);
            matchedKeys.set(entry.title, `(fuzzy, score: ${result.score.toFixed(1)})`);
        }
    }

    // Sort by priority (ascending - lower number = higher priority)
    const matched = [...matchedSet].sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));

    return { matched, matchedKeys, probabilitySkipped, warmupFailed };
}

/**
 * Run the full entry selection pipeline (3-mode branching: keywords-only, two-stage, ai-only).
 * Records a trace for the Pipeline Inspector (/dle-inspect).
 * BUG 6 FIX: Reset lastWarningRatio when ratio drops below threshold.
 * @param {object[]} chat - Chat messages array
 * @param {VaultEntry[]} [externalSnapshot] - Optional pre-taken vault snapshot (avoids double-snapshotting with onGenerate)
 * @returns {Promise<{ finalEntries: VaultEntry[], matchedKeys: Map<string, string>, trace: object }>}
 */
export async function runPipeline(chat, externalSnapshot, contextualGatingContext, { pins = [], blocks = [] } = {}) {
    // Snapshot settings and vault index so async stages (AI search) see a consistent view
    const rawSettings = getSettings();
    const settings = { ...rawSettings, analyticsData: { ...rawSettings.analyticsData } };
    const vaultSnapshot = externalSnapshot || [...vaultIndex];
    const bootstrapActive = chat.length <= settings.newChatThreshold;

    const trace = {
        mode: settings.aiSearchEnabled
            ? settings.aiSearchMode
            : 'keywords-only',
        indexed: vaultSnapshot.length,
        keywordMatched: [],
        aiSelected: [],
        gatedOut: [],
        budgetCut: [],
        injected: [],
        probabilitySkipped: [],
        warmupFailed: [],
        cooldownRemoved: [],
        contextualGatingRemoved: [],
        stripDedupRemoved: [],
        bootstrapActive,
        aiFallback: false,
    };

    let finalEntries;
    let matchedKeys = new Map();

    if (settings.aiSearchEnabled && settings.aiSearchMode === 'ai-only') {
        // Hierarchical pre-filter: for large vaults, narrow candidates by category first
        let aiOnlyCandidates = vaultSnapshot;
        const preFiltered = await hierarchicalPreFilter(vaultSnapshot, chat);
        if (preFiltered) {
            aiOnlyCandidates = preFiltered;
            if (settings.debugMode) {
                console.log(`[DLE] Hierarchical clustering: ${vaultSnapshot.length} → ${aiOnlyCandidates.length} candidates`);
            }
        }

        // Pre-filter by contextual gating so AI doesn't waste selections on gated entries
        if (contextualGatingContext) {
            const prePolicy = buildExemptionPolicy(aiOnlyCandidates, pins, blocks);
            aiOnlyCandidates = applyContextualGating(aiOnlyCandidates, contextualGatingContext, prePolicy, settings.debugMode);
        }

        const { manifest: candidateManifest, header: candidateHeader } = buildCandidateManifest(aiOnlyCandidates, bootstrapActive);
        const alwaysInject = vaultSnapshot.filter(e => e.constant || (bootstrapActive && e.bootstrap));

        if (bootstrapActive) {
            for (const e of alwaysInject) {
                if (e.bootstrap && !e.constant) matchedKeys.set(e.title, '(bootstrap)');
            }
        }
        // Always label constants in matchedKeys
        for (const e of alwaysInject) {
            if (e.constant && !matchedKeys.has(e.title)) matchedKeys.set(e.title, '(constant)');
        }

        if (candidateManifest) {
            const aiResult = await aiSearch(chat, candidateManifest, candidateHeader, vaultSnapshot, aiOnlyCandidates);
            if (aiResult.error) {
                trace.aiFallback = true;
                const kwResult = matchEntries(chat, vaultSnapshot);
                finalEntries = kwResult.matched;
                matchedKeys = kwResult.matchedKeys;
                trace.keywordMatched = kwResult.matched.map(e => ({ title: e.title, matchedBy: kwResult.matchedKeys.get(e.title) || '?' }));
                trace.probabilitySkipped = kwResult.probabilitySkipped;
                trace.warmupFailed = kwResult.warmupFailed;
                // Warn if ai-only fallback collapsed to constants-only
                const nonConstant = finalEntries.filter(e => !e.constant && !e.bootstrap);
                if (nonConstant.length === 0 && finalEntries.length > 0) {
                    console.warn('[DLE] AI-only mode failed and keyword fallback found only constants/bootstraps — lore coverage is minimal');
                    toastr.warning('AI search failed — only constant entries are active. Check your AI connection.', 'DeepLore Enhanced', { timeOut: 8000, preventDuplicates: true });
                }
            } else if (aiResult.results.length === 0) {
                finalEntries = alwaysInject;
            } else {
                const isForceInjected = e => e.constant || (bootstrapActive && e.bootstrap);
                finalEntries = [...alwaysInject, ...aiResult.results.map(r => r.entry).filter(e => !isForceInjected(e))];
                for (const r of aiResult.results) {
                    matchedKeys.set(r.entry.title, `AI: ${r.reason} (${r.confidence})`);
                    trace.aiSelected.push({ title: r.entry.title, reason: r.reason, confidence: r.confidence });
                }
            }
        } else {
            finalEntries = alwaysInject;
        }

    } else if (settings.aiSearchEnabled && settings.aiSearchMode === 'two-stage') {
        const keywordResult = matchEntries(chat, vaultSnapshot);
        matchedKeys = keywordResult.matchedKeys;
        trace.keywordMatched = keywordResult.matched.map(e => ({ title: e.title, matchedBy: matchedKeys.get(e.title) || '?' }));
        trace.probabilitySkipped = keywordResult.probabilitySkipped;
        trace.warmupFailed = keywordResult.warmupFailed;

        // Wiki-link candidate expansion: add entries referenced by matched entries as AI candidates
        const matchedTitles = new Set(keywordResult.matched.map(e => e.title));
        const titleLookup = new Map(vaultSnapshot.map(e => [e.title, e]));
        const linkedCandidates = [];
        for (const entry of keywordResult.matched) {
            for (const linkTitle of (entry.resolvedLinks || [])) {
                if (!matchedTitles.has(linkTitle)) {
                    const linked = titleLookup.get(linkTitle);
                    if (linked && !linked.constant) {
                        matchedTitles.add(linkTitle);
                        linkedCandidates.push(linked);
                        matchedKeys.set(linkTitle, `(wiki-linked from: ${entry.title})`);
                    }
                }
            }
        }
        const expandedMatched = [...keywordResult.matched, ...linkedCandidates];
        if (linkedCandidates.length > 0) {
            trace.keywordMatched.push(...linkedCandidates.map(e => ({ title: e.title, matchedBy: matchedKeys.get(e.title) || '?' })));
            if (settings.debugMode) {
                console.log(`[DLE] Wiki-link expansion: +${linkedCandidates.length} candidates (${linkedCandidates.map(e => e.title).join(', ')})`);
            }
        }

        // Hierarchical pre-filter for large keyword match sets
        let twoStageCandidates = expandedMatched;
        const preFiltered = await hierarchicalPreFilter(keywordResult.matched, chat);
        if (preFiltered) {
            twoStageCandidates = preFiltered;
            if (settings.debugMode) {
                console.log(`[DLE] Two-stage hierarchical: ${keywordResult.matched.length} → ${twoStageCandidates.length} candidates`);
            }
        }

        // Pre-filter by contextual gating so AI doesn't waste selections on gated entries
        if (contextualGatingContext) {
            const prePolicy = buildExemptionPolicy(twoStageCandidates, pins, blocks);
            twoStageCandidates = applyContextualGating(twoStageCandidates, contextualGatingContext, prePolicy, settings.debugMode);
        }

        const { manifest: candidateManifest, header: candidateHeader } = buildCandidateManifest(twoStageCandidates, bootstrapActive);

        if (!candidateManifest) {
            finalEntries = keywordResult.matched;
        } else {
            const aiResult = await aiSearch(chat, candidateManifest, candidateHeader, vaultSnapshot, twoStageCandidates);
            if (aiResult.error) {
                trace.aiFallback = true;
                finalEntries = keywordResult.matched;
            } else if (aiResult.results.length === 0) {
                finalEntries = keywordResult.matched.filter(e => e.constant || (bootstrapActive && e.bootstrap));
            } else {
                const isForceInjected = e => e.constant || (bootstrapActive && e.bootstrap);
                const alwaysInject = keywordResult.matched.filter(e => isForceInjected(e));
                finalEntries = [...alwaysInject, ...aiResult.results.map(r => r.entry).filter(e => !isForceInjected(e))];
                for (const r of aiResult.results) {
                    const existing = matchedKeys.get(r.entry.title);
                    matchedKeys.set(r.entry.title, existing
                        ? `${existing} → AI: ${r.reason} (${r.confidence})`
                        : `AI: ${r.reason} (${r.confidence})`);
                    trace.aiSelected.push({ title: r.entry.title, reason: r.reason, confidence: r.confidence });
                }
            }
        }

    } else {
        const keywordResult = matchEntries(chat, vaultSnapshot);
        finalEntries = keywordResult.matched;
        matchedKeys = keywordResult.matchedKeys;
        trace.keywordMatched = keywordResult.matched.map(e => ({ title: e.title, matchedBy: matchedKeys.get(e.title) || '?' }));
        trace.probabilitySkipped = keywordResult.probabilitySkipped;
        trace.warmupFailed = keywordResult.warmupFailed;
    }

    // Re-sort by user priority (with tiebreaker) after all modes.
    // In AI modes, confidence sorting may have overridden user priority — this restores it
    // so budget trimming respects the user's explicit priority field.
    finalEntries.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));

    setLastPipelineTrace(trace);
    return { finalEntries, matchedKeys, trace };
}

/**
 * External API: match vault entries against arbitrary text.
 * Used by other extensions (e.g. BurnerPhone) to get lore without going through the interceptor.
 * @param {string|object[]} scanInput - Text string or array of {name, mes, is_user} chat objects
 * @returns {Promise<{text: string, count: number, tokens: number}>}
 */
export async function matchTextForExternal(scanInput) {
    const settings = getSettings();
    if (!settings.enabled) return { text: '', count: 0, tokens: 0 };

    await ensureIndexFresh();
    if (vaultIndex.length === 0) return { text: '', count: 0, tokens: 0 };

    const fakeChat = typeof scanInput === 'string'
        ? [{ name: 'context', mes: scanInput, is_user: true }]
        : scanInput;

    const { matched } = matchEntries(fakeChat);
    const policy = buildExemptionPolicy(matched, [], []);
    const { result: gated } = applyRequiresExcludesGating(matched, policy, false);
    const { groups, count, totalTokens } = formatAndGroup(gated, getSettings(), PROMPT_TAG_PREFIX);

    const combinedText = groups.map(g => g.text).join('\n\n');
    return { text: combinedText, count, tokens: totalTokens };
}
