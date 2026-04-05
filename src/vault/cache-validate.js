/**
 * DeepLore Enhanced — Cache Entry Validation
 * Pure function extracted from cache.js for testability (no SillyTavern imports).
 */

/**
 * Validate a cached vault entry and backfill missing fields.
 * Returns false if the entry is structurally invalid (corrupt IndexedDB write).
 * Mutates the entry in-place to backfill missing optional fields.
 * @param {object} entry
 * @returns {boolean} true if entry is valid (possibly after backfill)
 */
export function validateCachedEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.title !== 'string' || !entry.title) return false;
    if (!Array.isArray(entry.keys)) return false;
    if (typeof entry.content !== 'string') return false;
    if (typeof entry.tokenEstimate !== 'number' || entry.tokenEstimate < 0 || Number.isNaN(entry.tokenEstimate)) return false;
    if (entry.links !== undefined && !Array.isArray(entry.links)) return false;
    if (entry.tags !== undefined && !Array.isArray(entry.tags)) return false;
    // Default critical fields that may be missing from partial writes
    if (typeof entry.priority !== 'number' || Number.isNaN(entry.priority)) entry.priority = 50;
    if (typeof entry.constant !== 'boolean') entry.constant = false;
    if (entry.requires !== undefined && !Array.isArray(entry.requires)) entry.requires = [];
    if (entry.excludes !== undefined && !Array.isArray(entry.excludes)) entry.excludes = [];
    if (entry.probability !== undefined && entry.probability !== null && typeof entry.probability !== 'number') entry.probability = null;
    // Default array fields if missing or corrupt (defend against partial IndexedDB writes)
    for (const field of ['links', 'resolvedLinks', 'tags']) {
        if (!Array.isArray(entry[field])) entry[field] = [];
    }
    // Validate customFields object
    if (!entry.customFields || typeof entry.customFields !== 'object') entry.customFields = {};
    return true;
}
