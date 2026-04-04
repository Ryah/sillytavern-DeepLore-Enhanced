/**
 * DeepLore Enhanced — Librarian Tool Action Implementations
 * search_lore and flag_lore tool actions called by ToolManager during generation.
 */
import { saveChatDebounced } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { truncateToSentence } from '../../core/utils.js';
import { queryBM25, tokenize } from '../vault/bm25.js';
import { getSettings } from '../../settings.js';
import {
    loreGaps, setLoreGaps,
    loreGapSearchCount, setLoreGapSearchCount,
    lastInjectionSources,
    fuzzySearchIndex,
    generationCount,
    chatEpoch,
    librarianSessionStats, setLibrarianSessionStats,
    librarianChatStats, setLibrarianChatStats,
} from '../state.js';

// ════════════════════════════════════════════════════════════════════════════
// Session Activity Log
// ════════════════════════════════════════════════════════════════════════════

/**
 * Per-session activity log — records every search/flag tool invocation.
 * Reset on chat change (via clearSessionActivityLog).
 * @type {Array<{type: string, query: string, resultCount: number, resultTitles: string[], tokens: number, timestamp: number, generation: number}>}
 */
let sessionActivityLog = [];

/** Get the current session activity log (immutable copy). */
export function getSessionActivityLog() {
    return [...sessionActivityLog];
}

/** Clear the session activity log (call on CHAT_CHANGED). */
export function clearSessionActivityLog() {
    sessionActivityLog = [];
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/** Generate a unique gap record ID */
function gapId() {
    return typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Check if a new query overlaps significantly with an existing gap's query.
 * Returns the matching gap if >60% token overlap, null otherwise.
 */
function findSimilarGap(gaps, newQuery, type) {
    const newTokens = tokenize(newQuery);
    if (newTokens.length === 0) return null;
    const newSet = new Set(newTokens);

    for (const gap of gaps) {
        if (gap.type !== type) continue;
        const existingTokens = tokenize(gap.query);
        if (existingTokens.length === 0) continue;

        const existingSet = new Set(existingTokens);
        let overlap = 0;
        for (const t of newSet) {
            if (existingSet.has(t)) overlap++;
        }
        const overlapRatio = overlap / Math.max(newSet.size, existingSet.size);
        if (overlapRatio > 0.6) return gap;
    }
    return null;
}

/** Persist lore gaps to chat_metadata and save */
function persistGaps(updatedGaps) {
    setLoreGaps(updatedGaps);
    const ctx = getContext();
    if (ctx?.chat_metadata) {
        ctx.chat_metadata.deeplore_lore_gaps = updatedGaps;
        saveChatDebounced();
    }
}

/** Update analytics counters */
function updateAnalytics(field) {
    const s = getSettings();
    if (!s.analyticsData._librarian) {
        s.analyticsData._librarian = {
            totalGapSearches: 0,
            totalGapFlags: 0,
            totalEntriesWritten: 0,
            totalEntriesUpdated: 0,
            topUnmetQueries: [],
        };
    }
    s.analyticsData._librarian[field] = (s.analyticsData._librarian[field] || 0) + 1;
}

/** Track an unmet query (searched but no results) */
function trackUnmetQuery(query) {
    const s = getSettings();
    if (!s.analyticsData._librarian) return;
    const unmet = s.analyticsData._librarian.topUnmetQueries || [];
    const existing = unmet.find(u => u.query.toLowerCase() === query.toLowerCase());
    if (existing) {
        existing.count++;
        existing.lastSearched = Date.now();
    } else {
        unmet.push({ query, count: 1, lastSearched: Date.now() });
    }
    // Keep top 20 by count
    unmet.sort((a, b) => b.count - a.count);
    s.analyticsData._librarian.topUnmetQueries = unmet.slice(0, 20);
}

/** Update both session and chat stats */
function incrementStats(field, extraTokens = 0) {
    setLibrarianSessionStats({
        ...librarianSessionStats,
        [field]: (librarianSessionStats[field] || 0) + 1,
        estimatedExtraTokens: (librarianSessionStats.estimatedExtraTokens || 0) + extraTokens,
    });
    setLibrarianChatStats({
        ...librarianChatStats,
        [field]: (librarianChatStats[field] || 0) + 1,
        estimatedExtraTokens: (librarianChatStats.estimatedExtraTokens || 0) + extraTokens,
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Tool Actions
// ════════════════════════════════════════════════════════════════════════════

/**
 * search_lore tool action: search the vault index for entries the pipeline missed.
 * @param {{ query: string }} args
 * @returns {Promise<string>} Result text (returned to the writing AI as tool result)
 */
export async function searchLoreAction(args) {
    const settings = getSettings();
    const epoch = chatEpoch; // Snapshot for stale-guard
    const query = args?.query?.trim();
    if (!query) return 'No query provided.';

    // Guard: max searches per generation
    if (loreGapSearchCount >= settings.librarianMaxSearches) {
        return 'Search limit reached for this generation. Work with the lore already provided.';
    }
    setLoreGapSearchCount(loreGapSearchCount + 1);

    // Search via BM25
    const hits = queryBM25(
        fuzzySearchIndex,
        query,
        settings.librarianMaxResults,
        settings.fuzzySearchMinScore || 0.5,
    );

    // Filter out entries already injected by the pipeline
    const injectedTitles = new Set();
    if (lastInjectionSources && Array.isArray(lastInjectionSources)) {
        for (const src of lastInjectionSources) {
            if (src.title) injectedTitles.add(src.title.toLowerCase());
        }
    }
    const filtered = hits.filter(h => !injectedTitles.has(h.entry.title.toLowerCase()));

    // Truncate results to token budget
    const perEntryBudget = filtered.length > 0
        ? Math.floor(settings.librarianResultTokenBudget / filtered.length)
        : 0;
    const results = filtered.map(h => ({
        title: h.entry.title,
        keys: h.entry.keys?.slice(0, 5) || [],
        snippet: truncateToSentence(h.entry.content || '', perEntryBudget),
        score: Math.round(h.score * 100) / 100,
    }));

    // Estimate extra tokens from this search result
    const resultText = results.length > 0
        ? results.map(r => `## ${r.title}\nKeys: ${r.keys.join(', ')}\n${r.snippet}`).join('\n\n')
        : '';
    const estimatedTokens = Math.ceil(resultText.length / 4); // rough char-to-token estimate

    // Record gap signal (merge frequency with similar queries)
    const existingGap = findSimilarGap(loreGaps, query, 'search');
    let updatedGaps;
    if (existingGap) {
        const updated = {
            ...existingGap,
            frequency: existingGap.frequency + 1,
            timestamp: Date.now(),
            hadResults: results.length > 0,
            resultTitles: results.map(r => r.title),
        };
        updatedGaps = loreGaps.map(g => g === existingGap ? updated : g);
    } else {
        const newGap = {
            id: gapId(),
            type: 'search',
            query,
            reason: `AI searched for "${query}" during generation`,
            timestamp: Date.now(),
            generation: generationCount,
            status: 'pending',
            frequency: 1,
            urgency: 'medium',
            hadResults: results.length > 0,
            resultTitles: results.map(r => r.title),
        };
        updatedGaps = [...loreGaps, newGap];
    }
    // Guard: don't persist if chat changed during generation
    if (epoch === chatEpoch) persistGaps(updatedGaps);

    // Activity log entry
    sessionActivityLog.push({
        type: 'search',
        query,
        resultCount: results.length,
        resultTitles: results.map(r => r.title),
        tokens: estimatedTokens,
        timestamp: Date.now(),
        generation: generationCount,
    });

    // Analytics
    updateAnalytics('totalGapSearches');
    if (results.length === 0) trackUnmetQuery(query);
    incrementStats('searchCalls', estimatedTokens);

    // Return results to the writing AI
    if (results.length === 0) {
        return `No entries found for "${query}". If this information is important to the scene, use flag_lore to record the gap.`;
    }
    return resultText;
}

/**
 * flag_lore tool action: flag a lore gap for later review.
 * @param {{ title: string, reason: string, urgency?: string }} args
 * @returns {Promise<string>} Confirmation text
 */
export async function flagLoreAction(args) {
    const epoch = chatEpoch; // Snapshot for stale-guard
    const title = args?.title?.trim();
    const reason = args?.reason?.trim();
    if (!title) return 'No title provided.';
    if (!reason) return 'No reason provided.';

    const urgency = ['low', 'medium', 'high'].includes(args?.urgency) ? args.urgency : 'medium';

    // Merge frequency with existing flags for the same topic
    const existingGap = findSimilarGap(loreGaps, title, 'flag');
    let updatedGaps;
    if (existingGap) {
        const urgencyOrder = { low: 0, medium: 1, high: 2 };
        const escalatedUrgency = urgencyOrder[urgency] > urgencyOrder[existingGap.urgency]
            ? urgency : existingGap.urgency;
        const mergedReason = existingGap.reason.includes(reason)
            ? existingGap.reason : `${existingGap.reason}; ${reason}`;
        const updated = {
            ...existingGap,
            frequency: existingGap.frequency + 1,
            timestamp: Date.now(),
            urgency: escalatedUrgency,
            reason: mergedReason,
        };
        updatedGaps = loreGaps.map(g => g === existingGap ? updated : g);
    } else {
        const newGap = {
            id: gapId(),
            type: 'flag',
            query: title,
            reason,
            timestamp: Date.now(),
            generation: generationCount,
            status: 'pending',
            frequency: 1,
            urgency,
            hadResults: false,
            resultTitles: null,
        };
        updatedGaps = [...loreGaps, newGap];
    }
    // Guard: don't persist if chat changed during generation
    if (epoch === chatEpoch) persistGaps(updatedGaps);

    // Activity log entry
    sessionActivityLog.push({
        type: 'flag',
        query: title,
        resultCount: 0,
        resultTitles: [],
        tokens: 10,
        timestamp: Date.now(),
        generation: generationCount,
    });

    // Analytics + stats (flags have minimal token overhead)
    updateAnalytics('totalGapFlags');
    incrementStats('flagCalls', 10); // ~10 tokens for the flag confirmation

    return `Flagged: "${title}"`;
}
