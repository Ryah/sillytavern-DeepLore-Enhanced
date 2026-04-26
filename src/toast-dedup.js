/**
 * DeepLore Enhanced — Toast Deduplication.
 * Suppresses repeats within DEDUP_WINDOW_MS. Keyed by category so different
 * messages about the same root cause still dedup.
 */

const DEDUP_WINDOW_MS = 10_000;

/** @type {Map<string, number>} category → timestamp of last toast */
const recentToasts = new Map();

/**
 * toastr.error if category hasn't fired recently.
 * @param {string} message
 * @param {string} category - dedup key (e.g. 'obsidian_connect')
 * @param {object} [options] - merged with toastr defaults
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
 * toastr.warning if category hasn't fired recently.
 * @param {string} message
 * @param {string} category
 * @param {object} [options] - merged with toastr defaults
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
 * @param {string} category
 * @returns {boolean} true if duplicate (suppress)
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
