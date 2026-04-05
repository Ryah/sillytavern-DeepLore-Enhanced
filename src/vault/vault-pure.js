/**
 * DeepLore Enhanced — Pure Vault Functions
 * Extracted from vault.js for testability (no SillyTavern imports).
 */

import { simpleHash } from '../../core/utils.js';
import { setEntityNameSet, setEntityShortNameRegexes } from '../state.js';

/**
 * Compute entity name Set and pre-compiled short-name regexes from vault entries.
 * Used by both finalizeIndex (after full rebuild) and hydrateFromCache (instant startup).
 * @param {Array} entries - VaultEntry array
 */
export function computeEntityDerivedState(entries) {
    const names = new Set();
    for (const entry of entries) {
        if (entry.title.length >= 1) names.add(entry.title.toLowerCase());
        for (const key of entry.keys) {
            if (key.length >= 2) names.add(key.toLowerCase());
        }
    }
    setEntityNameSet(names);

    // Pre-compile word-boundary regexes for ALL entity names
    // Short names (≤3 chars): always use regex to avoid false positives ("an" in "want")
    // Longer names: regex prevents substring false positives ("Arch" in "monarch")
    const nameRegexes = new Map();
    for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        nameRegexes.set(name, new RegExp(`\\b${escaped}\\b`, 'i'));
    }
    setEntityShortNameRegexes(nameRegexes);
}

/**
 * Multi-vault conflict resolution dedup pass (BUG-007).
 * When entries with the same title exist in different vaults, this resolves them:
 *   'all'   — Keep every copy (no dedup). Entries from each vault appear independently.
 *   'first' — Keep the first vault's copy, discard later duplicates.
 *   'last'  — Keep the last vault's copy, replacing earlier ones.
 *   'merge' — Combine into a single entry:
 *             Arrays (keys, tags, links, etc.) are unioned (no duplicates).
 *             Content is concatenated with a separator.
 *             Summary and scalar fields prefer the first non-empty value.
 *             Token estimate is recalculated from merged content.
 *
 * @param {Array} entries - VaultEntry array (mutated: may be replaced)
 * @param {string} mode - Conflict resolution mode ('all'|'first'|'last'|'merge')
 * @returns {Array} Deduplicated entries
 */
export function deduplicateMultiVault(entries, mode) {
    if (!mode || mode === 'all') return entries;
    const titleMap = new Map();
    for (const entry of entries) {
        const key = entry.title.toLowerCase();
        if (titleMap.has(key)) {
            if (mode === 'first') continue;
            if (mode === 'last') {
                titleMap.set(key, entry);
            } else if (mode === 'merge') {
                const existing = titleMap.get(key);
                // H18: Merge all relevant fields, not just keys
                // Arrays: union (deduplicate)
                for (const field of ['keys', 'tags', 'links', 'resolvedLinks', 'requires', 'excludes']) {
                    if (Array.isArray(entry[field]) && entry[field].length > 0) {
                        existing[field] = [...new Set([...(existing[field] || []), ...entry[field]])];
                    }
                }
                // content: concatenate with separator
                if (entry.content && entry.content.trim()) {
                    existing.content = (existing.content || '') + '\n\n---\n\n' + entry.content;
                    // Recalculate token estimate and content hash from merged content
                    existing.tokenEstimate = Math.ceil(existing.content.length / 4.0); // BUG-H9: standardize on 4.0 chars/token
                    existing._contentHash = simpleHash(existing.content);
                }
                // summary: prefer first non-empty
                if (!existing.summary && entry.summary) existing.summary = entry.summary;
                // customFields: merge — union arrays, prefer first non-empty for scalars
                if (entry.customFields) {
                    if (!existing.customFields) existing.customFields = {};
                    for (const [key, val] of Object.entries(entry.customFields)) {
                        if (Array.isArray(val) && val.length > 0) {
                            existing.customFields[key] = [...new Set([...(existing.customFields[key] || []), ...val])];
                        } else if (!existing.customFields[key] && val != null) {
                            existing.customFields[key] = val;
                        }
                    }
                }
            }
        } else {
            titleMap.set(key, entry);
        }
    }
    return [...titleMap.values()];
}
