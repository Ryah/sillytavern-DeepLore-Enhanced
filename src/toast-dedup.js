/**
 * DeepLore Enhanced — Toast Deduplication
 *
 * Suppresses duplicate error/warning toasts within a time window.
 * Keyed by category string (e.g. 'obsidian_connect', 'scribe') so that
 * different messages about the same root cause are still deduplicated.
 */

const DEDUP_WINDOW_MS = 10_000;

/** @type {Map<string, number>} category → timestamp of last toast */
const recentToasts = new Map();

/**
 * Show a toastr.error if the category hasn't been toasted recently.
 * @param {string} message - Toast message
 * @param {string} category - Dedup category key (e.g. 'obsidian_connect')
 * @param {object} [options] - Extra toastr options (merged with defaults)
 */
export function dedupError(message, category, options = {}) {
    if (_isDuplicate(category)) return;
    const { hint, ...rest } = options;
    if (hint) console.warn('[DLE]', category, '-', hint);
    try {
        const t = toastr.error(message, 'DeepLore Enhanced', {
            timeOut: 10000,
            ...rest,
        });
        if (hint && t && t[0]) t[0].title = hint;
    } catch (e) {
        console.error('[DLE] toastr unavailable:', category, message, e?.message);
    }
}

/**
 * Show a toastr.warning if the category hasn't been toasted recently.
 * @param {string} message - Toast message
 * @param {string} category - Dedup category key
 * @param {object} [options] - Extra toastr options (merged with defaults)
 */
export function dedupWarning(message, category, options = {}) {
    if (_isDuplicate(category)) return;
    const { hint, ...rest } = options;
    if (hint) console.warn('[DLE]', category, '-', hint);
    try {
        const t = toastr.warning(message, 'DeepLore Enhanced', {
            timeOut: 8000,
            ...rest,
        });
        if (hint && t && t[0]) t[0].title = hint;
    } catch (e) {
        console.warn('[DLE] toastr unavailable:', category, message, e?.message);
    }
}

/**
 * Check if a category was toasted recently and update the timestamp.
 * @param {string} category
 * @returns {boolean} True if duplicate (should suppress)
 */
function _isDuplicate(category) {
    const now = Date.now();
    const last = recentToasts.get(category);
    if (last && now - last < DEDUP_WINDOW_MS) {
        return true;
    }
    recentToasts.set(category, now);
    return false;
}
