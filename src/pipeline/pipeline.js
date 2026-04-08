/**
 * DeepLore Enhanced — Pipeline runner
 * matchEntries, runPipeline, matchTextForExternal
 */
import { getSettings, PROMPT_TAG_PREFIX } from '../../settings.js';
import { buildScanText } from '../../core/utils.js';
import { testEntryMatch, testPrimaryMatchOnly, countKeywordOccurrences, formatAndGroup, clearScanTextCache } from '../../core/matching.js';
import { buildExemptionPolicy, applyRequiresExcludesGating, applyContextualGating, applyFolderFilter } from '../stages.js';
import {
    vaultIndex, cooldownTracker, injectionHistory, generationCount,
    trackerKey, setLastPipelineTrace, fuzzySearchIndex, fieldDefinitions,
    getWriterVisibleEntries,
} from '../state.js';
import { DEFAULT_FIELD_DEFINITIONS } from '../fields.js';
import { buildCandidateManifest, aiSearch, hierarchicalPreFilter } from '../ai/ai.js';
import { isForceInjected } from '../helpers.js';
import { ensureIndexFresh } from '../vault/vault.js';
import { queryBM25 } from '../vault/bm25.js';
import { name2 } from '../../../../../../script.js';
import { dedupWarning } from '../toast-dedup.js';
// matchEntries core logic extracted to match.js for testability
import { matchEntries as _matchEntriesPure } from './match.js';

/** Match vault entries — delegates to extracted pure function with settings/name2 injection. */
export function matchEntries(chat, snapshot = null, opts = {}) {
    return _matchEntriesPure(chat, snapshot, {
        settings: opts.settings || getSettings(),
        characterName: opts.characterName !== undefined ? opts.characterName : name2,
    });
}

/**
 * Run the full entry selection pipeline (3-mode branching: keywords-only, two-stage, ai-only).
 * Records a trace for the Pipeline Inspector (/dle-inspect).
 * BUG 6 FIX: Reset lastWarningRatio when ratio drops below threshold.
 * @param {object[]} chat - Chat messages array
 * @param {VaultEntry[]} [externalSnapshot] - Optional pre-taken vault snapshot (avoids double-snapshotting with onGenerate)
 * @returns {Promise<{ finalEntries: VaultEntry[], matchedKeys: Map<string, string>, trace: object }>}
 */
export async function runPipeline(chat, externalSnapshot, contextualGatingContext, { pins = [], blocks = [], folderFilter = null, signal = null } = {}) {
    // Snapshot settings and vault index so async stages (AI search) see a consistent view
    const rawSettings = getSettings();
    const settings = { ...rawSettings, analyticsData: { ...rawSettings.analyticsData } };
    // Filter out lorebook-guide entries — they are Librarian-only and must never reach the writing AI.
    // External snapshots are assumed already-filtered if the caller used getWriterVisibleEntries().
    const vaultSnapshot = externalSnapshot || getWriterVisibleEntries();
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
        aiError: '', // BUG-004: Capture AI error message for toast enrichment
        fuzzyStats: null,
        refineKeyBlocked: [],
    };

    let finalEntries;
    let matchedKeys = new Map();

    if (settings.aiSearchEnabled && settings.aiSearchMode === 'ai-only') {
        // Hierarchical pre-filter: for large vaults, narrow candidates by category first
        let aiOnlyCandidates = vaultSnapshot;
        const preFiltered = await hierarchicalPreFilter(vaultSnapshot, chat, signal);
        if (signal?.aborted) { const e = new Error('Pipeline aborted by user'); e.name = 'AbortError'; e.userAborted = true; throw e; }
        // BUG-FIX: Was `if (preFiltered)` which treats [] as falsy, discarding valid empty results
        if (preFiltered != null) {
            aiOnlyCandidates = preFiltered;
            if (settings.debugMode) {
                console.log(`[DLE] Hierarchical clustering: ${vaultSnapshot.length} → ${aiOnlyCandidates.length} candidates`);
            }
        }

        // Pre-filter by contextual gating so AI doesn't waste selections on gated entries
        if (contextualGatingContext) {
            const beforeGating = aiOnlyCandidates.length;
            const prePolicy = buildExemptionPolicy(aiOnlyCandidates, pins, blocks);
            const fieldDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            aiOnlyCandidates = applyContextualGating(aiOnlyCandidates, contextualGatingContext, prePolicy, settings.debugMode, settings, fieldDefs);
            trace.aiPreFilter = { before: beforeGating, after: aiOnlyCandidates.length, removed: beforeGating - aiOnlyCandidates.length };
        }

        // Pre-filter by folder so AI doesn't see entries from excluded folders
        if (folderFilter && folderFilter.length > 0) {
            const prePolicy = buildExemptionPolicy(aiOnlyCandidates, pins, blocks);
            aiOnlyCandidates = applyFolderFilter(aiOnlyCandidates, folderFilter, prePolicy, settings.debugMode);
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
            const aiResult = await aiSearch(chat, candidateManifest, candidateHeader, vaultSnapshot, aiOnlyCandidates, signal);
            if (signal?.aborted) { const e = new Error('Pipeline aborted by user'); e.name = 'AbortError'; e.userAborted = true; throw e; }
            if (aiResult.error) {
                trace.aiFallback = true;
                trace.aiError = aiResult.errorMessage || ''; // BUG-004: Capture error details
                const fallback = settings.aiErrorFallback || 'keyword';
                if (fallback === 'keyword') {
                    const kwResult = matchEntries(chat, vaultSnapshot);
                    finalEntries = kwResult.matched;
                    matchedKeys = kwResult.matchedKeys;
                    trace.keywordMatched = kwResult.matched.map(e => ({ title: e.title, matchedBy: kwResult.matchedKeys.get(e.title) || '?' }));
                    trace.probabilitySkipped = kwResult.probabilitySkipped;
                    trace.warmupFailed = kwResult.warmupFailed;
                    trace.fuzzyStats = kwResult.fuzzyStats;
                    trace.refineKeyBlocked = kwResult.refineKeyBlocked;
                    // Warn if ai-only fallback collapsed to constants-only
                    const nonConstant = finalEntries.filter(e => !e.constant && !e.bootstrap);
                    if (nonConstant.length === 0 && finalEntries.length > 0) {
                        console.warn('[DLE] AI-only mode failed and keyword fallback found only constants/bootstraps — lore coverage is minimal');
                        dedupWarning('AI search hit a snag — only your always-send lore is active.', 'ai_fallback', { hint: 'Check AI connection in DeepLore settings.' });
                    }
                } else if (fallback === 'constants_only') {
                    finalEntries = vaultSnapshot.filter(e => e.constant);
                } else if (fallback === 'bootstrap_only') {
                    finalEntries = vaultSnapshot.filter(e => bootstrapActive && e.bootstrap);
                } else { // 'none'
                    finalEntries = [];
                }
            } else if (aiResult.results.length === 0) {
                const emptyFallback = settings.aiEmptyFallback || 'constants';
                dedupWarning('AI didn\'t pick any lore for this scene — using your fallback.', 'ai_empty_fallback', { hint: `Empty fallback mode: ${emptyFallback}` });
                if (emptyFallback === 'constants') {
                    finalEntries = vaultSnapshot.filter(e => e.constant);
                } else if (emptyFallback === 'constants_bootstrap') {
                    finalEntries = alwaysInject;
                } else if (emptyFallback === 'keyword') {
                    finalEntries = matchEntries(chat, vaultSnapshot).matched;
                } else { // 'none'
                    finalEntries = [];
                }
            } else {
                finalEntries = [...alwaysInject, ...aiResult.results.map(r => r.entry).filter(e => !isForceInjected(e, { bootstrapActive }))];
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
        trace.fuzzyStats = keywordResult.fuzzyStats;
        trace.refineKeyBlocked = keywordResult.refineKeyBlocked;

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
        // BUG-022: Use expandedMatched (includes wiki-linked candidates), not keywordResult.matched
        // null means "skip, use all"; empty array means "AI selected zero categories" — treat as valid filter
        let twoStageCandidates = expandedMatched;
        const preFiltered = await hierarchicalPreFilter(expandedMatched, chat, signal);
        if (signal?.aborted) { const e = new Error('Pipeline aborted by user'); e.name = 'AbortError'; e.userAborted = true; throw e; }
        if (preFiltered != null) {
            twoStageCandidates = preFiltered;
            if (settings.debugMode) {
                console.log(`[DLE] Two-stage hierarchical: ${keywordResult.matched.length} → ${twoStageCandidates.length} candidates`);
            }
        }

        // Pre-filter by contextual gating so AI doesn't waste selections on gated entries
        if (contextualGatingContext) {
            const beforeGating = twoStageCandidates.length;
            const prePolicy = buildExemptionPolicy(twoStageCandidates, pins, blocks);
            const fieldDefs2 = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            twoStageCandidates = applyContextualGating(twoStageCandidates, contextualGatingContext, prePolicy, settings.debugMode, settings, fieldDefs2);
            trace.aiPreFilter = { before: beforeGating, after: twoStageCandidates.length, removed: beforeGating - twoStageCandidates.length };
        }

        // Pre-filter by folder so AI doesn't see entries from excluded folders
        if (folderFilter && folderFilter.length > 0) {
            const prePolicy = buildExemptionPolicy(twoStageCandidates, pins, blocks);
            twoStageCandidates = applyFolderFilter(twoStageCandidates, folderFilter, prePolicy, settings.debugMode);
        }

        const { manifest: candidateManifest, header: candidateHeader } = buildCandidateManifest(twoStageCandidates, bootstrapActive);

        if (!candidateManifest) {
            finalEntries = keywordResult.matched;
        } else {
            const aiResult = await aiSearch(chat, candidateManifest, candidateHeader, vaultSnapshot, twoStageCandidates, signal);
            if (signal?.aborted) { const e = new Error('Pipeline aborted by user'); e.name = 'AbortError'; e.userAborted = true; throw e; }
            if (aiResult.error) {
                trace.aiFallback = true;
                trace.aiError = aiResult.errorMessage || ''; // BUG-004: Capture error details
                const fallback = settings.aiErrorFallback || 'keyword';
                if (fallback === 'keyword') {
                    finalEntries = keywordResult.matched;
                } else if (fallback === 'constants_only') {
                    finalEntries = vaultSnapshot.filter(e => e.constant);
                } else if (fallback === 'bootstrap_only') {
                    finalEntries = vaultSnapshot.filter(e => bootstrapActive && e.bootstrap);
                } else { // 'none'
                    finalEntries = [];
                }
            } else if (aiResult.results.length === 0) {
                const emptyFallback = settings.aiEmptyFallback || 'constants';
                dedupWarning('AI didn\'t pick any lore for this scene — using your fallback.', 'ai_empty_fallback', { hint: `Empty fallback mode: ${emptyFallback}` });
                if (emptyFallback === 'constants') {
                    finalEntries = vaultSnapshot.filter(e => e.constant);
                } else if (emptyFallback === 'constants_bootstrap') {
                    finalEntries = vaultSnapshot.filter(e => e.constant || (bootstrapActive && e.bootstrap));
                } else if (emptyFallback === 'keyword') {
                    finalEntries = keywordResult.matched;
                } else { // 'none'
                    finalEntries = [];
                }
            } else {
                const ctx = { bootstrapActive };
                const alwaysInject = keywordResult.matched.filter(e => isForceInjected(e, ctx));
                finalEntries = [...alwaysInject, ...aiResult.results.map(r => r.entry).filter(e => !isForceInjected(e, ctx))];
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
        trace.fuzzyStats = keywordResult.fuzzyStats;
        trace.refineKeyBlocked = keywordResult.refineKeyBlocked;

        // BUG-F1: Apply contextual gating in keywords-only mode (was previously skipped)
        if (contextualGatingContext) {
            const prePolicy = buildExemptionPolicy(finalEntries, pins, blocks);
            const fieldDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            finalEntries = applyContextualGating(finalEntries, contextualGatingContext, prePolicy, settings.debugMode, settings, fieldDefs);
        }
    }

    // Folder-based filtering: restrict to entries from selected folders
    if (folderFilter && folderFilter.length > 0) {
        const beforeFolder = finalEntries.length;
        const folderPolicy = buildExemptionPolicy(finalEntries, pins, blocks);
        finalEntries = applyFolderFilter(finalEntries, folderFilter, folderPolicy, settings.debugMode);
        trace.folderFilter = { folders: folderFilter, before: beforeFolder, after: finalEntries.length, removed: beforeFolder - finalEntries.length };
    }

    // Re-sort by user priority (with tiebreaker) after all modes.
    // In AI modes, confidence sorting may have overridden user priority — this restores it
    // so budget trimming respects the user's explicit priority field.
    finalEntries.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));

    // Release cached scan text strings now that matching is complete
    clearScanTextCache();

    // Note: trace is set by onGenerate after enrichment — don't set here to avoid double-write
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
    clearScanTextCache();
    const policy = buildExemptionPolicy(matched, [], []);
    const { result: gated } = applyRequiresExcludesGating(matched, policy, false);
    const { groups, count, totalTokens } = formatAndGroup(gated, getSettings(), PROMPT_TAG_PREFIX);

    const combinedText = groups.map(g => g.text).join('\n\n');
    return { text: combinedText, count, tokens: totalTokens };
}
