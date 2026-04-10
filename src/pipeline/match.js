/**
 * DeepLore Enhanced — Entry Matching Engine
 * Extracted from pipeline.js for testability (no SillyTavern imports).
 *
 * matchEntries() performs keyword matching against chat messages, with support for:
 * - Constants and bootstrap entries
 * - Warmup, probability, and cooldown gates
 * - Cascade links (explicit author-defined relationships)
 * - Recursive scanning (scan matched entry content for more matches)
 * - BM25 fuzzy search (TF-IDF supplement to keyword matching)
 * - Keyword occurrence weighting (sort by hit count within priority group)
 * - Active character boost (auto-match active character's vault entry)
 */

import { buildScanText } from '../../core/utils.js';
import { testEntryMatch, testPrimaryMatchOnly, countKeywordOccurrences } from '../../core/matching.js';
import { vaultIndex, cooldownTracker, trackerKey, fuzzySearchIndex } from '../state.js';
import { queryBM25 } from '../vault/bm25.js';

const MAX_RECURSION_TEXT = 50000;

/**
 * Match vault entries against chat messages, with recursive scanning support.
 * @param {object[]} chat - Chat messages array
 * @param {object[]|null} [snapshot] - Optional vault snapshot (defaults to vaultIndex)
 * @param {object} [options] - Optional overrides for testing
 * @param {object} [options.settings] - Settings override (defaults to getSettings() in pipeline.js wrapper)
 * @param {string} [options.characterName] - Active character name override (defaults to name2)
 * @returns {{ matched: VaultEntry[], matchedKeys: Map<string, string>, probabilitySkipped: Array, warmupFailed: Array, fuzzyStats: object, refineKeyBlocked: Array }}
 */
export function matchEntries(chat, snapshot = null, { settings, characterName } = {}) {
    if (!settings) throw new Error('matchEntries: settings parameter is required when called from match.js');
    const entries = snapshot || vaultIndex;
    const activeCharName = characterName !== undefined ? characterName : null;
    /** @type {Set<VaultEntry>} */
    const matchedSet = new Set();
    /** @type {Map<string, string>} entry title -> matched key */
    const matchedKeys = new Map();
    /** @type {Array<{title: string, probability: number, roll: number}>} */
    const probabilitySkipped = [];
    /** @type {Array<{title: string, needed: number, found: number}>} */
    const warmupFailed = [];
    /** @type {Array<{title: string, primaryKey: string, refineKeys: string[]}>} */
    const refineKeyBlocked = [];

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

    // Memoize buildScanText by depth — shared across keyword matching and BM25 fuzzy search
    const scanTextMemo = new Map();
    function getScanText(depth) {
        if (!scanTextMemo.has(depth)) scanTextMemo.set(depth, buildScanText(chat, depth));
        return scanTextMemo.get(depth);
    }

    // Keyword matching: skip entirely when scanDepth is 0 (AI-only mode)
    if (settings.scanDepth > 0) {
        const globalScanText = getScanText(settings.scanDepth);

        // Initial scan pass
        for (const entry of entries) {
            if (entry.constant) continue; // Already added above

            // Use per-entry scan depth if set, otherwise use global scan text
            const scanText = entry.scanDepth !== null
                ? getScanText(entry.scanDepth)
                : globalScanText;

            const key = testEntryMatch(entry, scanText, settings);
            if (!key && entry.refineKeys?.length > 0) {
                // Check if primary key matched but refine keys blocked
                const primaryHit = testPrimaryMatchOnly(entry, scanText, settings);
                if (primaryHit) {
                    refineKeyBlocked.push({ title: entry.title, primaryKey: primaryHit, refineKeys: [...entry.refineKeys] });
                }
            }
            if (key) {
                // Warmup check: require N keyword occurrences before triggering
                if (entry.warmup !== null) {
                    const occurrences = countKeywordOccurrences(entry, scanText, settings);
                    if (occurrences < entry.warmup) {
                        warmupFailed.push({ title: entry.title, needed: entry.warmup, found: occurrences });
                        continue;
                    }
                }

                // Probability check: explicit zero = never fires, otherwise random roll
                if (entry.probability === 0) {
                    probabilitySkipped.push({ title: entry.title, probability: 0, roll: 0 });
                    continue;
                }
                if (entry.probability !== null && entry.probability < 1.0) {
                    const roll = Math.random();
                    if (roll > entry.probability) {
                        probabilitySkipped.push({ title: entry.title, probability: entry.probability, roll });
                        continue;
                    }
                }

                // Cooldown check: skip entries still on cooldown
                const remaining = cooldownTracker.get(trackerKey(entry));
                if (remaining !== undefined && remaining > 0) {
                    continue;
                }

                matchedSet.add(entry);
                matchedKeys.set(entry.title, key);
            }
        }

        // Pre-compute title lookup map for cascade links and character matching
        const titleMap = new Map(entries.map(e => [e.title.toLowerCase(), e]));

        // Active Character Boost: auto-match active character's vault entry
        if (settings.characterContextScan && activeCharName) {
            const nameLower = activeCharName.toLowerCase();
            const charEntry = titleMap.get(nameLower) || entries.find(e =>
                e.keys.some(k => k.toLowerCase() === nameLower)
            );
            if (charEntry && !matchedSet.has(charEntry)) {
                matchedSet.add(charEntry);
                matchedKeys.set(charEntry.title, '(active character)');
            }
        }

        // Cascade links: explicitly pull in linked entries from matched entries
        // Cascade-linked entries still respect cooldown/probability gates but NOT warmup
        const cascadeSource = [...matchedSet];
        for (const entry of cascadeSource) {
            if (!entry.cascadeLinks || entry.cascadeLinks.length === 0) continue;
            for (const linkTitle of entry.cascadeLinks) {
                const linked = titleMap.get(linkTitle.toLowerCase());
                if (linked && !matchedSet.has(linked)) {
                    // Apply same gates as direct matches (except warmup)
                    if (linked.cooldown !== null) {
                        const remaining = cooldownTracker.get(trackerKey(linked));
                        if (remaining !== undefined && remaining > 0) continue;
                    }
                    if (linked.probability === 0) continue;
                    if (linked.probability !== null && linked.probability < 1.0 && Math.random() > linked.probability) continue;
                    // BUG-035: Skip warmup check for cascade-linked entries — cascade links are
                    // explicit author-defined relationships, not keyword-triggered matches
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

                let recursionText = [...newlyMatched]
                    .filter(e => !e.excludeRecursion)
                    .map(e => e.content)
                    .join('\n');
                if (recursionText.length > MAX_RECURSION_TEXT) {
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
    const fuzzyStats = { active: false, candidates: 0, matched: 0, threshold: settings.fuzzySearchMinScore || 0.5 };
    if (settings.fuzzySearchEnabled && fuzzySearchIndex && settings.scanDepth > 0) {
        fuzzyStats.active = true;
        const fuzzyText = getScanText(settings.scanDepth);
        const bm25Results = queryBM25(fuzzySearchIndex, fuzzyText, 20, fuzzyStats.threshold);
        fuzzyStats.candidates = bm25Results.length;
        for (const result of bm25Results) {
            const entry = result.entry;
            if (matchedSet.has(entry)) continue;
            if (entry.constant) continue;

            // Respect cooldown
            const remaining = cooldownTracker.get(trackerKey(entry));
            if (remaining !== undefined && remaining > 0) continue;

            // BUG-AUDIT-8: Respect warmup — BM25 fuzzy matches must also honor warmup gates.
            if (entry.warmup && entry.warmup >= 1) {
                const scanText = getScanText(entry.scanDepth ?? settings.scanDepth);
                const occurrences = countKeywordOccurrences(entry, scanText, settings);
                if (occurrences < entry.warmup) continue;
            }

            // Respect probability
            if (entry.probability === 0) continue;
            if (entry.probability !== null && entry.probability < 1.0 && Math.random() > entry.probability) continue;

            matchedSet.add(entry);
            matchedKeys.set(entry.title, `(fuzzy, score: ${result.score.toFixed(1)})`);
            fuzzyStats.matched++;
        }
    }

    // Sort by priority (ascending - lower number = higher priority)
    const matched = [...matchedSet].sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));

    // Keyword occurrence weighting: re-sort within same priority group using hit count as tiebreaker
    if (settings.keywordOccurrenceWeighting) {
        // BUG-AUDIT-H13: Use getScanText memo instead of calling buildScanText directly.
        const scanText = getScanText(settings.scanDepth);
        const occurrenceCache = new Map();
        const getCachedCount = (entry) => {
            let count = occurrenceCache.get(entry.title);
            if (count === undefined) {
                count = countKeywordOccurrences(entry, scanText, settings);
                occurrenceCache.set(entry.title, count);
            }
            return count;
        };
        matched.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return getCachedCount(b) - getCachedCount(a) || a.title.localeCompare(b.title);
        });
    }

    return { matched, matchedKeys, probabilitySkipped, warmupFailed, fuzzyStats, refineKeyBlocked };
}
