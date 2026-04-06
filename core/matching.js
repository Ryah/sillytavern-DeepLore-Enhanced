/**
 * DeepLore Enhanced Core — Matching, Gating & Formatting
 */

import { escapeRegex, truncateToSentence } from './utils.js';

// ── Regex cache (C4): WeakMap keyed by entry object, invalidated when settings change ──
const _regexCache = new WeakMap();

// ── H9: Cache lowercased scanText to avoid 25MB transient allocations per-entry ──
let _lastScanText = '';
let _lastScanTextLower = '';

/** Release the cached scan text strings after the matching phase completes. */
export function clearScanTextCache() {
    _lastScanText = '';
    _lastScanTextLower = '';
}

/**
 * Get or build cached compiled regexes for an entry's keys and refine keys.
 * Cache is keyed by entry object reference and invalidated when relevant settings change.
 * @param {import('./pipeline.js').VaultEntry} entry
 * @param {{ caseSensitive: boolean, matchWholeWords: boolean }} settings
 * @returns {{ _key: string, primary: Array<{rawKey: string, key: string, regex: RegExp|null, regexG: RegExp|null}>, refine: Array<{rKey: string, regex: RegExp|null}> }}
 */
function getCachedRegexes(entry, settings) {
    let cache = _regexCache.get(entry);
    const cacheKey = `${settings.caseSensitive}|${settings.matchWholeWords}`;
    if (cache && cache._key === cacheKey) return cache;

    const MAX_KEYWORD_LENGTH = 200;
    cache = { _key: cacheKey, primary: [], refine: [] };
    for (const rawKey of entry.keys) {
        if (!rawKey || !rawKey.trim()) continue;
        const truncatedKey = rawKey.length > MAX_KEYWORD_LENGTH ? rawKey.substring(0, MAX_KEYWORD_LENGTH) : rawKey;
        const key = settings.caseSensitive ? truncatedKey : truncatedKey.normalize('NFC').toLowerCase();
        if (settings.matchWholeWords) {
            const escaped = escapeRegex(key);
            const prefix = /^\w/.test(key) ? '\\b' : '(?<!\\w)';
            const suffix = /\w$/.test(key) ? '\\b' : '(?!\\w)';
            cache.primary.push({
                rawKey,
                key,
                regex: new RegExp(`${prefix}${escaped}${suffix}`, settings.caseSensitive ? '' : 'i'),
                regexG: new RegExp(`${prefix}${escaped}${suffix}`, settings.caseSensitive ? 'g' : 'gi'),
            });
        } else {
            cache.primary.push({ rawKey, key, regex: null, regexG: null });
        }
    }
    if (entry.refineKeys) {
        for (const rk of entry.refineKeys) {
            const rKey = settings.caseSensitive ? rk : rk.normalize('NFC').toLowerCase();
            if (settings.matchWholeWords) {
                // M13: Smart word boundary for refine keys (same logic as primary keys)
                const escaped = escapeRegex(rKey);
                const prefix = /^\w/.test(rKey) ? '\\b' : '(?<!\\w)';
                const suffix = /\w$/.test(rKey) ? '\\b' : '(?!\\w)';
                cache.refine.push({
                    rKey,
                    regex: new RegExp(`${prefix}${escaped}${suffix}`, settings.caseSensitive ? '' : 'i'),
                });
            } else {
                cache.refine.push({ rKey, regex: null });
            }
        }
    }
    _regexCache.set(entry, cache);
    return cache;
}

/**
 * Test if an entry's keys match against the given text.
 * Uses cached compiled regexes for performance (C4).
 * @param {import('./pipeline.js').VaultEntry} entry
 * @param {string} scanText
 * @param {{ caseSensitive: boolean, matchWholeWords: boolean }} settings
 * @returns {string|null} The matched key, or null if no match
 */
export function testEntryMatch(entry, scanText, settings) {
    if (entry.keys.length === 0) return null;

    const cached = getCachedRegexes(entry, settings);
    let haystack;
    if (settings.caseSensitive) {
        haystack = scanText;
    } else {
        if (scanText !== _lastScanText) {
            _lastScanTextLower = scanText.normalize('NFC').toLowerCase();
            _lastScanText = scanText;
        }
        haystack = _lastScanTextLower;
    }

    let primaryMatch = null;
    for (const item of cached.primary) {
        if (settings.matchWholeWords) {
            // Test against normalized text to match NFC-normalized regex pattern
            if (item.regex.test(haystack)) { primaryMatch = item.rawKey; break; }
        } else {
            if (haystack.includes(item.key)) { primaryMatch = item.rawKey; break; }
        }
    }
    if (!primaryMatch) return null;

    // Refine keys: if non-empty, at least one must also match (AND_ANY mode)
    if (cached.refine.length > 0) {
        const hasRefine = cached.refine.some(item => {
            if (settings.matchWholeWords) {
                return item.regex.test(haystack);
            }
            return haystack.includes(item.rKey);
        });
        if (!hasRefine) return null;
    }
    return primaryMatch;
}

/**
 * Test if an entry's primary keys match (ignoring refine keys).
 * Used to detect entries blocked specifically by refine key filtering.
 * @param {import('./pipeline.js').VaultEntry} entry
 * @param {string} scanText
 * @param {{ caseSensitive: boolean, matchWholeWords: boolean }} settings
 * @returns {string|null} The matched primary key, or null if no primary match
 */
export function testPrimaryMatchOnly(entry, scanText, settings) {
    if (entry.keys.length === 0) return null;

    const cached = getCachedRegexes(entry, settings);
    let haystack;
    if (settings.caseSensitive) {
        haystack = scanText;
    } else {
        if (scanText !== _lastScanText) {
            _lastScanTextLower = scanText.normalize('NFC').toLowerCase();
            _lastScanText = scanText;
        }
        haystack = _lastScanTextLower;
    }

    for (const item of cached.primary) {
        if (settings.matchWholeWords) {
            if (item.regex.test(haystack)) return item.rawKey;
        } else {
            if (haystack.includes(item.key)) return item.rawKey;
        }
    }
    return null;
}

/**
 * Count how many times an entry's keywords appear in the scan text.
 * Respects case sensitivity and whole-word matching settings.
 * Uses cached compiled regexes for performance (C4).
 * @param {import('./pipeline.js').VaultEntry} entry
 * @param {string} scanText
 * @param {{ caseSensitive: boolean, matchWholeWords: boolean }} settings
 * @returns {number} Total keyword occurrence count
 */
export function countKeywordOccurrences(entry, scanText, settings) {
    let count = 0;
    const cached = getCachedRegexes(entry, settings);
    let text;
    if (settings.caseSensitive) {
        text = scanText;
    } else {
        if (scanText !== _lastScanText) {
            _lastScanTextLower = scanText.normalize('NFC').toLowerCase();
            _lastScanText = scanText;
        }
        text = _lastScanTextLower;
    }
    for (const item of cached.primary) {
        if (settings.matchWholeWords) {
            const matches = text.match(item.regexG); // use normalized text (consistent with testEntryMatch)
            if (matches) count += matches.length;
        } else {
            let idx = 0;
            while ((idx = text.indexOf(item.key, idx)) !== -1) {
                count++;
                idx += item.key.length;
            }
        }
    }
    return count;
}

/**
 * Apply conditional gating rules (requires/excludes) to matched entries.
 * Iterates until stable since removing a gated entry may affect another's requires.
 * @param {import('./pipeline.js').VaultEntry[]} entries - Matched entries (already merged)
 * @returns {import('./pipeline.js').VaultEntry[]}
 */
export function applyGating(entries) {
    // BUG-029: Sort descending by priority number for deterministic mutual-excludes resolution.
    // Note: This is legacy code — the live pipeline uses applyRequiresExcludesGating in stages.js.
    let result = [...entries].sort((a, b) => ((b.priority || 50) - (a.priority || 50)) || a.title.localeCompare(b.title));
    let changed = true;
    let iterations = 0;
    const MAX_ITERATIONS = 10;

    let activeTitles = new Set(result.map(e => e.title.toLowerCase()));

    while (changed && iterations < MAX_ITERATIONS) {
        changed = false;
        iterations++;

        const nextResult = [];
        for (const entry of result) {
            if (entry.requires && entry.requires.length > 0) {
                const allPresent = entry.requires.every(r => activeTitles.has(r.toLowerCase()));
                if (!allPresent) {
                    changed = true;
                    activeTitles.delete(entry.title.toLowerCase());
                    continue;
                }
            }
            if (entry.excludes && entry.excludes.length > 0) {
                const anyPresent = entry.excludes.some(r => activeTitles.has(r.toLowerCase()));
                if (anyPresent) {
                    changed = true;
                    activeTitles.delete(entry.title.toLowerCase());
                    continue;
                }
            }
            nextResult.push(entry);
        }
        result = nextResult;
    }

    // Detect contradictory gating (A requires B, B excludes A) — warn for debugging
    const removedEntries = entries.filter(e => !result.includes(e));
    if (removedEntries.length > 0) {
        for (const removed of removedEntries) {
            if (removed.requires && removed.requires.length > 0) {
                for (const req of removed.requires) {
                    const reqEntry = entries.find(e => e.title.toLowerCase() === req.toLowerCase());
                    if (reqEntry && reqEntry.excludes && reqEntry.excludes.some(exc => exc.toLowerCase() === removed.title.toLowerCase())) {
                        console.warn(`[DLE] Contradictory gating: "${removed.title}" requires "${reqEntry.title}" but "${reqEntry.title}" excludes "${removed.title}" — both dropped`);
                    }
                }
            }
        }
    }

    if (iterations >= MAX_ITERATIONS && changed) {
        console.warn('[DLE] Gating did not stabilize after', MAX_ITERATIONS, 'iterations — results may be incomplete. Check for circular requires/excludes.');
    }

    return result;
}

/**
 * Resolve raw wiki-link targets to confirmed entry titles in the vault index.
 * Must be called after vaultIndex is fully populated.
 * @param {import('./pipeline.js').VaultEntry[]} vaultIndex
 */
export function resolveLinks(vaultIndex) {
    const titleMap = new Map(vaultIndex.map(e => [e.title.toLowerCase(), e.title]));
    for (const entry of vaultIndex) {
        entry.resolvedLinks = entry.links
            .map(l => titleMap.get(l.toLowerCase()))
            .filter(Boolean);
    }
}

/**
 * Format matched entries for injection, respecting budget limits, grouped by injection position.
 * Entries can override the global injection position/depth/role via frontmatter.
 *
 * Two grouping modes:
 * - 'extension' (default): Groups by (position, depth, role) with auto-generated keys.
 * - 'prompt_list': Groups into stable named keys (constants vs lore) with IN_PROMPT position.
 *   ST's Prompt Manager automatically surfaces these as draggable entries.
 *   Per-entry overrides with custom position/depth get their own IN_CHAT group.
 *
 * @param {import('./pipeline.js').VaultEntry[]} entries - Matched entries sorted by priority
 * @param {{ injectionMode?: string, injectionTemplate: string, injectionPosition: number, injectionDepth: number, injectionRole: number, maxEntries: number, unlimitedEntries: boolean, maxTokensBudget: number, unlimitedBudget: boolean }} settings
 * @param {string} promptTagPrefix - Prefix for prompt tags (e.g. 'deeplore_')
 * @returns {{ groups: Array<{ tag: string, text: string, position: number, depth: number, role: number }>, count: number, totalTokens: number, acceptedEntries: import('./pipeline.js').VaultEntry[] }}
 */
export function formatAndGroup(entries, settings, promptTagPrefix) {
    const template = settings.injectionTemplate || '<{{title}}>\n{{content}}\n</{{title}}>';
    let totalTokens = 0;
    let count = 0;

    // Separate outlet entries — they bypass normal positional injection
    const outletEntries = entries.filter(e => e.outlet);
    const positionalEntries = entries.filter(e => !e.outlet);

    const accepted = [];

    const MIN_TRUNCATION_TOKENS = 50;

    for (const entry of positionalEntries) {
        if (!settings.unlimitedEntries && count >= settings.maxEntries) break;
        if (!settings.unlimitedBudget && totalTokens + entry.tokenEstimate > settings.maxTokensBudget) {
            const remainingTokens = settings.maxTokensBudget - totalTokens;

            if (remainingTokens >= MIN_TRUNCATION_TOKENS) {
                // MIN_TRUNCATION_TOKENS (50) prevents uselessly small fragments.
                // At ~4 chars/token, 50 tokens ≈ 200 chars — enough for a meaningful
                // paragraph. Below this threshold, the truncated entry would be too
                // short to provide useful context, so it's better to skip it entirely.
                // Truncate entry to fit remaining budget (shallow copy — never mutate original)
                // BUG-032: Use chars/4.0 ratio (more conservative, better alignment with actual tokenizer)
                const maxChars = Math.floor(remainingTokens * 4.0);
                const truncatedContent = truncateToSentence(entry.content, maxChars);
                const truncatedEntry = {
                    ...entry,
                    content: truncatedContent,
                    tokenEstimate: Math.ceil(truncatedContent.length / 4.0),
                    _truncated: true,
                    _originalTokens: entry.tokenEstimate,
                    // Recompute content hash so strip-dedup doesn't use the pre-truncation hash
                    _contentHash: typeof entry._contentHash === 'string' ? entry._contentHash + '_trunc' : '',
                };
                accepted.push({
                    entry: truncatedEntry,
                    position: truncatedEntry.injectionPosition ?? settings.injectionPosition,
                    depth: truncatedEntry.injectionDepth ?? settings.injectionDepth,
                    role: truncatedEntry.injectionRole ?? settings.injectionRole,
                });
                totalTokens += truncatedEntry.tokenEstimate;
                count++;
                break; // Budget is now fully consumed
            }

            if (count > 0) break;
            // First entry exceeds budget and remaining is too small to truncate — skip
            console.warn(`[DLE] Entry "${entry.title}" (${entry.tokenEstimate} tokens) exceeds entire budget (${settings.maxTokensBudget}) — skipping`);
            continue;
        }

        accepted.push({
            entry,
            position: entry.injectionPosition ?? settings.injectionPosition,
            depth: entry.injectionDepth ?? settings.injectionDepth,
            role: entry.injectionRole ?? settings.injectionRole,
        });
        totalTokens += entry.tokenEstimate;
        count++;
    }

    // Only escape angle brackets to prevent structural XML injection (e.g. </system>).
    // Do NOT escape quotes or ampersands — those are valid content the AI should see as-is.
    const escapeBrackets = (s) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const formatEntry = (entry) => {
        let text = template.replace(/\{\{title\}\}/g, escapeBrackets(entry.title));
        text = text.replace(/\{\{content\}\}/g, escapeBrackets(entry.content));
        return text;
    };

    // ── Outlet entries: group by outlet name, inject via {{outlet::name}} macro ──
    // Outlet entries bypass positional injection entirely (extension_prompt_types.NONE = -1).
    // They're written to extension_prompts under 'customWIOutlet_<name>' keys and read by
    // ST's {{outlet::name}} macro. Budget/maxEntries limits don't apply to outlet entries
    // since they're user-placed via macros, not auto-positioned.
    const outletGroupMap = new Map();
    let outletTokens = 0;
    for (const entry of outletEntries) {
        const key = `customWIOutlet_${entry.outlet}`;
        if (!outletGroupMap.has(key)) {
            outletGroupMap.set(key, { tag: key, texts: [], tokens: 0 });
        }
        const g = outletGroupMap.get(key);
        g.texts.push(formatEntry(entry));
        g.tokens += entry.tokenEstimate;
        outletTokens += entry.tokenEstimate;
    }
    const outletGroups = [...outletGroupMap.values()].map(g => ({
        tag: g.tag,
        text: g.texts.join('\n\n'),
        position: -1, // extension_prompt_types.NONE
        depth: 0,
        role: 0,
    }));

    const mode = settings.injectionMode || 'extension';

    if (mode === 'prompt_list') {
        // ── Prompt List mode: group by type (constants vs lore) with stable keys ──
        // Entries with per-entry overrides get their own IN_CHAT group (bypasses PM).
        const groupMap = new Map();
        const IN_PROMPT = 0; // extension_prompt_types.IN_PROMPT

        for (const item of accepted) {
            const hasOverride = item.entry.injectionPosition !== null || item.entry.injectionDepth !== null || item.entry.injectionRole !== null;

            let key, position, depth, role;
            if (hasOverride) {
                // Per-entry override → own group with IN_CHAT, bypasses PM
                key = `${promptTagPrefix}override_p${item.position}_d${item.depth}_r${item.role}`;
                position = item.position;
                depth = item.depth;
                role = item.role;
            } else if (item.entry.constant) {
                key = `${promptTagPrefix}constants`;
                position = IN_PROMPT;
                depth = 0;
                role = 0;
            } else {
                key = `${promptTagPrefix}lore`;
                position = IN_PROMPT;
                depth = 0;
                role = 0;
            }

            if (!groupMap.has(key)) {
                groupMap.set(key, { tag: key, position, depth, role, texts: [] });
            }
            groupMap.get(key).texts.push(formatEntry(item.entry));
        }

        const groups = [...groupMap.values()].map(g => ({
            tag: g.tag,
            text: g.texts.join('\n\n'),
            position: g.position,
            depth: g.depth,
            role: g.role,
        }));

        groups.push(...outletGroups);
        return { groups, count: count + outletEntries.length, totalTokens: totalTokens + outletTokens, acceptedEntries: [...accepted.map(a => a.entry), ...outletEntries] };
    }

    // ── Extension mode (default): group by (position, depth, role) ──
    const groupMap = new Map();
    for (const item of accepted) {
        const key = `${promptTagPrefix}p${item.position}_d${item.depth}_r${item.role}`;
        if (!groupMap.has(key)) {
            groupMap.set(key, {
                tag: key,
                position: item.position,
                depth: item.depth,
                role: item.role,
                texts: [],
            });
        }
        groupMap.get(key).texts.push(formatEntry(item.entry));
    }

    const groups = [...groupMap.values()].map(g => ({
        tag: g.tag,
        text: g.texts.join('\n\n'),
        position: g.position,
        depth: g.depth,
        role: g.role,
    }));

    groups.push(...outletGroups);
    return { groups, count: count + outletEntries.length, totalTokens: totalTokens + outletTokens, acceptedEntries: [...accepted.map(a => a.entry), ...outletEntries] };
}
