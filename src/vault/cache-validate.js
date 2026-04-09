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
    // Validate customFields object. BUG-376: also validate inner field values —
    // reject entries whose customFields contains a non-plain-object (array, Map, etc.),
    // and coerce any inner value that is itself a non-plain-object/non-primitive to a safe default.
    if (!entry.customFields || typeof entry.customFields !== 'object' || Array.isArray(entry.customFields)) {
        entry.customFields = {};
    } else {
        for (const [k, v] of Object.entries(entry.customFields)) {
            if (v == null) continue;
            const t = typeof v;
            if (t === 'string' || t === 'number' || t === 'boolean') continue;
            if (Array.isArray(v)) {
                // Ensure all items are primitives (string/number/boolean); otherwise drop the field.
                if (v.every(x => x == null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) continue;
                delete entry.customFields[k];
                continue;
            }
            // Objects, Maps, Sets, functions, etc. — not valid custom field values. Drop.
            delete entry.customFields[k];
        }
    }
    return true;
}
