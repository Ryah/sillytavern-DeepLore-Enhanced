/**
 * DeepLore Enhanced — Librarian Tool Action Implementations
 * search_lore and flag_lore tool actions called by ToolManager during generation.
 */
import { getContext, saveMetadataDebounced } from '../../../../../extensions.js';
import { truncateToSentence, escapeXml } from '../../core/utils.js';
import { queryBM25, tokenize } from '../vault/bm25.js';
import { getSettings } from '../../settings.js';
import {
    loreGaps, setLoreGaps,
    loreGapSearchCount, setLoreGapSearchCount,
    lastInjectionSources,
    fuzzySearchIndex, vaultIndex,
    buildPromise,
    generationCount,
    chatEpoch,
    librarianSessionStats, setLibrarianSessionStats,
    librarianChatStats, setLibrarianChatStats,
    notifyLoreGapsChanged,
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

/**
 * Pending tool calls buffer — accumulates during generation, consumed by
 * CHARACTER_MESSAGE_RENDERED to inject a consolidated dropdown on the reply.
 * @type {Array<{type: string, query: string, resultCount: number, resultTitles: string[], tokens: number, timestamp: number}>}
 */
let pendingToolCalls = [];

/**
 * Consume and clear pending tool calls. Called once per CHARACTER_MESSAGE_RENDERED.
 * @returns {Array} The pending tool calls (empty array if none)
 */
export function consumePendingToolCalls() {
    const calls = pendingToolCalls;
    pendingToolCalls = [];
    return calls;
}

/** Clear pending tool calls (call on CHAT_CHANGED alongside clearSessionActivityLog). */
export function clearPendingToolCalls() {
    pendingToolCalls = [];
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
    // getContext() exposes chatMetadata (camelCase), not chat_metadata
    const meta = ctx?.chatMetadata;
    if (meta) {
        meta.deeplore_lore_gaps = updatedGaps;
        saveMetadataDebounced();
    }
}

// ── Soft-remove sibling-array helpers (mirrors deeplore_pins/blocks pattern) ──

/** Read a sibling-array of gap ids from chat_metadata. */
function readGapIdArray(key) {
    const meta = getContext()?.chatMetadata;
    const raw = meta?.[key];
    return Array.isArray(raw) ? raw : [];
}

/** Write a sibling-array of gap ids and persist. */
function writeGapIdArray(key, ids) {
    const meta = getContext()?.chatMetadata;
    if (!meta) return;
    meta[key] = ids;
    saveMetadataDebounced();
}

/** Get the set of hidden gap ids for the current chat. */
export function getHiddenGapIds() {
    return new Set(readGapIdArray('deeplore_lore_gaps_hidden'));
}

/** Get the set of dismissed-forever gap ids for the current chat. */
export function getDismissedGapIds() {
    return new Set(readGapIdArray('deeplore_lore_gaps_dismissed'));
}

/** First-tier soft-remove: hide a gap (re-flag will resurface it). */
export function hideGap(id) {
    const arr = readGapIdArray('deeplore_lore_gaps_hidden');
    if (!arr.includes(id)) writeGapIdArray('deeplore_lore_gaps_hidden', [...arr, id]);
    setLoreGaps([...loreGaps]); // trigger render
}

/** Second-tier soft-remove: dismiss forever (re-flag will NOT resurface). */
export function dismissGap(id) {
    const arr = readGapIdArray('deeplore_lore_gaps_dismissed');
    if (!arr.includes(id)) writeGapIdArray('deeplore_lore_gaps_dismissed', [...arr, id]);
    // Also drop from hidden if present
    const hidden = readGapIdArray('deeplore_lore_gaps_hidden');
    if (hidden.includes(id)) writeGapIdArray('deeplore_lore_gaps_hidden', hidden.filter(x => x !== id));
    setLoreGaps([...loreGaps]);
}

/** Resurface a hidden gap. */
export function unhideGap(id) {
    const arr = readGapIdArray('deeplore_lore_gaps_hidden');
    if (arr.includes(id)) writeGapIdArray('deeplore_lore_gaps_hidden', arr.filter(x => x !== id));
    setLoreGaps([...loreGaps]);
}

/** Bring back a dismissed-forever gap. */
export function undismissGap(id) {
    const arr = readGapIdArray('deeplore_lore_gaps_dismissed');
    if (arr.includes(id)) writeGapIdArray('deeplore_lore_gaps_dismissed', arr.filter(x => x !== id));
    setLoreGaps([...loreGaps]);
}

/** Internal: silently clear an id from the hidden array (used during re-flag merge). */
function clearHiddenSilently(id) {
    const arr = readGapIdArray('deeplore_lore_gaps_hidden');
    if (arr.includes(id)) writeGapIdArray('deeplore_lore_gaps_hidden', arr.filter(x => x !== id));
}

/**
 * Build a combined activity feed: persistent search gaps + session tool calls.
 * Pure data builder — newest first. Two renderers consume this (drawer + popup).
 * @returns {Array<{kind: string, ts: number, query: string, type: string, resultCount?: number, urgency?: string}>}
 */
export function buildLibrarianActivityFeed() {
    const feed = [];
    // Session tool calls (in-memory, current session only)
    for (const e of sessionActivityLog) {
        feed.push({
            kind: e.type === 'search' ? 'tool-search' : 'tool-flag',
            ts: e.timestamp || 0,
            query: e.query || '',
            type: e.type,
            resultCount: e.resultCount || 0,
            resultTitles: Array.isArray(e.resultTitles) ? e.resultTitles : [],
            tokens: e.tokens || 0,
            generation: e.generation || 0,
            urgency: e.urgency,
        });
    }
    // Persistent search gaps (across chat reloads)
    for (const g of loreGaps) {
        if (g.type !== 'search') continue;
        feed.push({
            kind: 'gap-search',
            ts: g.timestamp || 0,
            query: g.query || '',
            type: 'search',
            resultCount: (g.resultTitles || []).length,
            resultTitles: Array.isArray(g.resultTitles) ? g.resultTitles : [],
            hadResults: !!g.hadResults,
            frequency: g.frequency || 1,
        });
    }
    feed.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return feed;
}

/** Update analytics counters */
function updateAnalytics(field) {
    const s = getSettings();
    if (!s.analyticsData) s.analyticsData = {};
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
 * Format an array of VaultEntries as a manifest of summaries (XML <entry> blocks).
 * Simpler than the sidecar manifest — no decay hints, no budget headers.
 * @param {Array} entries - VaultEntry objects to format
 * @param {number} [summaryLen=400] - Max summary character length
 * @returns {string} Manifest text
 */
function formatLinkedManifest(entries, summaryLen = 400) {
    if (!entries.length) return '';
    return entries.map(entry => {
        const summary = entry.summary
            || truncateToSentence((entry.content || '').substring(0, summaryLen * 3).replace(/\n+/g, ' ').trim(), summaryLen);
        const links = entry.resolvedLinks?.length > 0
            ? ` → ${entry.resolvedLinks.join(', ')}` : '';
        const safeName = escapeXml(entry.title);
        return `<entry name="${safeName}">\n${entry.title} (${entry.tokenEstimate}tok)${links}\n${summary}\n</entry>`;
    }).join('\n');
}

/**
 * Look up linked entries from a VaultEntry's resolvedLinks.
 * @param {object} entry - The source entry
 * @param {Set<string>} excludeTitles - Titles to exclude (already injected or already shown)
 * @param {number} [max=10] - Maximum linked entries to return
 * @returns {Array} Resolved VaultEntry objects
 */
function resolveLinkedEntries(entry, excludeTitles, max = 10) {
    if (!entry.resolvedLinks?.length) return [];
    const linked = [];
    for (const linkTitle of entry.resolvedLinks) {
        if (linked.length >= max) break;
        if (excludeTitles.has(linkTitle.toLowerCase())) continue;
        const found = vaultIndex.find(e => e.title.toLowerCase() === linkTitle.toLowerCase());
        if (found) linked.push(found);
    }
    return linked;
}

/**
 * search_lore tool action: search the vault index for entries the pipeline missed.
 * Returns full content for the top BM25 hit per query, plus a manifest of linked entries.
 * @param {{ queries: string[] }} args
 * @returns {Promise<string>} Result text (returned to the writing AI as tool result)
 */
export async function searchLoreAction(args) {
    const settings = getSettings();
    const epoch = chatEpoch;

    // Accept both { queries: [...] } and legacy { query: "..." }
    let queries = args?.queries;
    if (!queries && args?.query) queries = [args.query];
    if (!Array.isArray(queries)) return 'No queries provided.';
    queries = queries.map(q => (q || '').trim()).filter(Boolean).slice(0, 4);
    if (queries.length === 0) return 'No queries provided.';

    // Guard: max searches per generation
    if (loreGapSearchCount >= settings.librarianMaxSearches) {
        return `Search limit reached (${settings.librarianMaxSearches} per generation). Work with the lore already provided.`;
    }

    // Wait for index if building
    if (!fuzzySearchIndex && buildPromise) {
        try { await buildPromise; } catch { /* fall through */ }
    }

    // Still no index — record gaps and bail
    if (!fuzzySearchIndex) {
        for (const query of queries) {
            const failGap = {
                id: gapId(), type: 'search', query,
                reason: `AI searched for "${query}" but vault index was not ready`,
                timestamp: Date.now(), generation: generationCount,
                status: 'pending', frequency: 1, urgency: 'medium',
                hadResults: false, resultTitles: [],
            };
            const existing = findSimilarGap(loreGaps, query, 'search');
            // Re-flag resurfaces a hidden gap (clears `hidden`) but leaves `dismissed` alone.
            if (existing) clearHiddenSilently(existing.id);
            const updated = existing
                ? loreGaps.map(g => g === existing ? { ...existing, frequency: existing.frequency + 1, timestamp: Date.now() } : g)
                : [...loreGaps, failGap];
            if (epoch === chatEpoch) persistGaps(updated);
        }
        return 'Lore vault index is still loading. This does NOT count against your search limit — try again on the next message.';
    }

    // Count this search call
    setLoreGapSearchCount(loreGapSearchCount + 1);

    // Build injected titles set for filtering
    const injectedTitles = new Set();
    if (lastInjectionSources && Array.isArray(lastInjectionSources)) {
        for (const src of lastInjectionSources) {
            if (src.title) injectedTitles.add(src.title.toLowerCase());
        }
    }

    // Track entries already shown across queries to avoid duplication
    const shownTitles = new Set(injectedTitles);
    const resultParts = [];
    const allResultTitles = [];
    let totalTokens = 0;

    for (const query of queries) {
        const hits = queryBM25(
            fuzzySearchIndex, query,
            settings.librarianMaxResults,
            settings.fuzzySearchMinScore || 0.5,
        );
        const filtered = hits.filter(h => !shownTitles.has(h.entry.title.toLowerCase()) && !h.entry.guide);

        if (filtered.length === 0) {
            resultParts.push(`## Query: "${query}"\nNo matching entries found.`);
            trackUnmetQuery(query);
            // Record gap
            const existing = findSimilarGap(loreGaps, query, 'search');
            // Re-flag resurfaces a hidden gap (clears `hidden`) but leaves `dismissed` alone.
            if (existing) clearHiddenSilently(existing.id);
            const gapUpdate = existing
                ? loreGaps.map(g => g === existing ? { ...existing, frequency: existing.frequency + 1, timestamp: Date.now(), hadResults: false } : g)
                : [...loreGaps, { id: gapId(), type: 'search', query, reason: `AI searched for "${query}" during generation`, timestamp: Date.now(), generation: generationCount, status: 'pending', frequency: 1, urgency: 'medium', hadResults: false, resultTitles: [] }];
            if (epoch === chatEpoch) persistGaps(gapUpdate);
            continue;
        }

        // Top hit: full content
        const topEntry = filtered[0].entry;
        shownTitles.add(topEntry.title.toLowerCase());
        allResultTitles.push(topEntry.title);

        let part = `## Query: "${query}"\n\n### ${topEntry.title}\n${topEntry.content || ''}`;

        // Linked entries from top hit: manifest summaries, up to 10
        const linked = resolveLinkedEntries(topEntry, shownTitles, 10);
        if (linked.length > 0) {
            // Mark linked entries as shown to avoid duplication in later queries
            for (const le of linked) shownTitles.add(le.title.toLowerCase());
            allResultTitles.push(...linked.map(le => le.title));
            part += `\n\n### Linked entries:\n${formatLinkedManifest(linked)}`;
        }

        resultParts.push(part);
        totalTokens += (topEntry.tokenEstimate || 0) + linked.reduce((s, e) => s + (e.tokenEstimate || 0) / 4, 0);

        // Record gap signal
        const existing = findSimilarGap(loreGaps, query, 'search');
        // Re-flag resurfaces a hidden gap (clears `hidden`) but leaves `dismissed` alone.
        if (existing) clearHiddenSilently(existing.id);
        const gapUpdate = existing
            ? loreGaps.map(g => g === existing ? { ...existing, frequency: existing.frequency + 1, timestamp: Date.now(), hadResults: true, resultTitles: [topEntry.title, ...linked.map(l => l.title)] } : g)
            : [...loreGaps, { id: gapId(), type: 'search', query, reason: `AI searched for "${query}" during generation`, timestamp: Date.now(), generation: generationCount, status: 'pending', frequency: 1, urgency: 'medium', hadResults: true, resultTitles: [topEntry.title, ...linked.map(l => l.title)] }];
        if (epoch === chatEpoch) persistGaps(gapUpdate);
    }

    const resultText = resultParts.join('\n\n---\n\n');
    const estimatedTokens = Math.ceil(resultText.length / 4);

    // Activity log + pending buffer
    const logEntry = {
        type: 'search',
        query: queries.join('; '),
        resultCount: allResultTitles.length,
        resultTitles: allResultTitles,
        tokens: estimatedTokens,
        timestamp: Date.now(),
        generation: generationCount,
    };
    sessionActivityLog.push(logEntry);
    pendingToolCalls.push(logEntry);
    notifyLoreGapsChanged(); // Re-render Activity sub-tab even when persistGaps wasn't called

    // Analytics
    updateAnalytics('totalGapSearches');
    incrementStats('searchCalls', estimatedTokens);

    if (allResultTitles.length === 0) {
        return `No entries found for ${queries.map(q => `"${q}"`).join(', ')}. If this information is important to the scene, use flag_lore to record the gap.`;
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
    // Re-flag resurfaces a hidden gap (clears `hidden`) but leaves `dismissed` alone —
    // dismissed entries still escalate urgency silently so the user sees the latest state on un-dismiss.
    if (existingGap) clearHiddenSilently(existingGap.id);
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

    // Activity log + pending buffer for consolidated dropdown
    const logEntry = {
        type: 'flag',
        query: title,
        resultCount: 0,
        resultTitles: [],
        tokens: 10,
        timestamp: Date.now(),
        generation: generationCount,
        urgency,
    };
    sessionActivityLog.push(logEntry);
    pendingToolCalls.push(logEntry);
    notifyLoreGapsChanged();

    // Analytics + stats (flags have minimal token overhead)
    updateAnalytics('totalGapFlags');
    incrementStats('flagCalls', 10); // ~10 tokens for the flag confirmation

    return `Flagged: "${title}"`;
}
