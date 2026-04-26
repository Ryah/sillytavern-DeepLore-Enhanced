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

    // Word-boundary regexes for ALL entity names — prevents substring false
    // positives like "an" in "want" or "Arch" in "monarch".
    const nameRegexes = new Map();
    for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        nameRegexes.set(name, new RegExp(`\\b${escaped}\\b`, 'i'));
    }
    setEntityShortNameRegexes(nameRegexes);
}

/**
 * Detect entry titles that appear in more than one vault.
 * Returns { title, vaults[] } per conflict — used pre-dedup to warn the user.
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
// Settings whitelist enforces the enum on save, but imports / hand-edited config
// can land an invalid value. Without this guard the invalid mode falls through
// every branch and silently behaves like 'first'. Unknown → 'all' (preserve).
const VALID_DEDUPE_MODES = new Set(['all', 'first', 'last', 'merge']);
export function deduplicateMultiVault(entries, mode) {
    if (!mode || !VALID_DEDUPE_MODES.has(mode) || mode === 'all') return entries;
    const titleMap = new Map();
    for (const entry of entries) {
        const key = entry.title.toLowerCase();
        if (titleMap.has(key)) {
            if (mode === 'first') continue;
            if (mode === 'last') {
                titleMap.set(key, entry);
            } else if (mode === 'merge') {
                // BUG-378: clone first entry and PRESERVE its `_contentHash`. The previous
                // in-place mutation clobbered the hash with one of the merged content,
                // which never matched any real on-disk file — so reuse-sync flagged the
                // entry as modified every poll, triggering infinite re-parse/re-tokenize.
                const firstEntry = titleMap.get(key);
                const existing = { ...firstEntry };
                if (firstEntry.customFields) existing.customFields = { ...firstEntry.customFields };
                titleMap.set(key, existing);
                // H18: union all relevant array fields, not just keys.
                for (const field of ['keys', 'tags', 'links', 'resolvedLinks', 'requires', 'excludes']) {
                    if (Array.isArray(entry[field]) && entry[field].length > 0) {
                        existing[field] = [...new Set([...(existing[field] || []), ...entry[field]])];
                    }
                }
                if (entry.content && entry.content.trim()) {
                    existing.content = (existing.content || '') + '\n\n---\n\n' + entry.content;
                    existing.tokenEstimate = Math.ceil(existing.content.length / 4.0); // BUG-H9: 4.0 chars/token
                    // BUG-378: do NOT recompute `_contentHash` — must equal the hash of the
                    // ORIGINAL first entry's file content for reuse-sync to skip re-parse.
                }
                // H-05: OR-merge boolean flags — true if ANY copy is true.
                for (const flag of ['constant', 'seed', 'bootstrap', 'guide']) {
                    if (entry[flag]) existing[flag] = true;
                }
                if (!existing.summary && entry.summary) existing.summary = entry.summary;
                // customFields: union arrays, first-non-empty for scalars.
                if (entry.customFields) {
                    if (!existing.customFields) existing.customFields = {};
                    for (const [k, val] of Object.entries(entry.customFields)) {
                        if (Array.isArray(val) && val.length > 0) {
                            existing.customFields[k] = [...new Set([...(existing.customFields[k] || []), ...val])];
                        } else if (existing.customFields[k] == null && val != null) {
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
