/**
 * DeepLore Enhanced — Pure Vault Functions
 * Extracted from vault.js for testability (no SillyTavern imports).
 */

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
 * Detect entry titles that appear in more than one vault.
 * Returns an array of { title, vaults[] } for each conflicting title.
 * Called before deduplicateMultiVault to warn the user.
 * @param {Array} entries - VaultEntry array
 * @returns {Array<{title: string, vaults: string[]}>}
 */
export function detectCrossVaultDuplicates(entries) {
    const titleVaults = new Map();
    for (const entry of entries) {
        const key = entry.title.toLowerCase();
        const vault = entry.vaultSource || '(unknown)';
        if (!titleVaults.has(key)) {
            titleVaults.set(key, new Map()); // vault → display title
        }
        titleVaults.get(key).set(vault, entry.title);
    }
    const duplicates = [];
    for (const [, vaultMap] of titleVaults) {
        if (vaultMap.size > 1) {
            const first = vaultMap.values().next().value;
            duplicates.push({ title: first, vaults: [...vaultMap.keys()] });
        }
    }
    return duplicates;
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
                // BUG-378: Previously mutated the first entry in place and clobbered
                // `_contentHash` with a hash of the merged content. Because reuse-sync
                // compares `entry._contentHash` to the on-disk file hash to detect "modified"
                // entries, the clobbered hash never matched any real file → every poll
                // reported the entry as modified and triggered a redundant re-parse/re-tokenize.
                // Fix: clone the first entry before merging and PRESERVE its original
                // `_contentHash` so reuse-sync sees a stable, on-disk-matching hash.
                const firstEntry = titleMap.get(key);
                const existing = { ...firstEntry };
                // Deep-copy customFields so we don't mutate the source entry's fields
                if (firstEntry.customFields) existing.customFields = { ...firstEntry.customFields };
                titleMap.set(key, existing);
                // H18: Merge all relevant fields, not just keys
                // Arrays: union (deduplicate) — construct new arrays rather than mutating
                for (const field of ['keys', 'tags', 'links', 'resolvedLinks', 'requires', 'excludes']) {
                    if (Array.isArray(entry[field]) && entry[field].length > 0) {
                        existing[field] = [...new Set([...(existing[field] || []), ...entry[field]])];
                    }
                }
                // content: concatenate with separator
                if (entry.content && entry.content.trim()) {
                    existing.content = (existing.content || '') + '\n\n---\n\n' + entry.content;
                    // Recalculate token estimate from merged content for budgeting.
                    existing.tokenEstimate = Math.ceil(existing.content.length / 4.0); // BUG-H9: standardize on 4.0 chars/token
                    // BUG-378: Do NOT recompute `_contentHash` — it must remain equal to the
                    // hash of the ORIGINAL (unmerged) first entry's file content so reuse-sync
                    // can match it against the on-disk file and avoid infinite "modified" loops.
                    // (existing._contentHash was already copied from firstEntry above.)
                }
                // H-05: OR-merge boolean flags — if ANY copy is true, merged entry keeps it
                for (const flag of ['constant', 'seed', 'bootstrap', 'guide']) {
                    if (entry[flag]) existing[flag] = true;
                }
                // summary: prefer first non-empty
                if (!existing.summary && entry.summary) existing.summary = entry.summary;
                // customFields: merge — union arrays, prefer first non-empty for scalars
                if (entry.customFields) {
                    if (!existing.customFields) existing.customFields = {};
                    for (const [k, val] of Object.entries(entry.customFields)) {
                        if (Array.isArray(val) && val.length > 0) {
                            existing.customFields[k] = [...new Set([...(existing.customFields[k] || []), ...val])];
                        } else if (!existing.customFields[k] && val != null) {
                            existing.customFields[k] = val;
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
