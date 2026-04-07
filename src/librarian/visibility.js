/**
 * DeepLore Enhanced — Librarian Visibility
 * Hides every Librarian surface when the feature is disabled, so users never
 * see vestigial UI for a feature that isn't running.
 *
 * Surfaces toggled:
 *   - Drawer Librarian tab button + panel
 *   - Per-message "Consulted lore vault" dropdowns (removed from existing chat messages)
 *
 * Other surfaces are handled at their own seams:
 *   - ToolManager registration: settings-ui.js (register/unregister on toggle)
 *   - injectLibrarianDropdown: librarian-ui.js early-returns when disabled
 *   - /dle-librarian slash command: commands-ai.js early-returns with toast
 */
import { getContext } from '../../../../../extensions.js';

/**
 * Apply visibility rules across the Librarian surface area.
 * Safe to call repeatedly (idempotent). Call from settings toggle and at init.
 * @param {boolean} enabled
 */
export function applyLibrarianVisibility(enabled) {
    const display = enabled ? '' : 'none';
    const $tab = $('#dle-tab-librarian');
    const $panel = $('#dle-panel-librarian');
    if ($tab.length) $tab.css('display', display);
    if ($panel.length) $panel.css('display', display);

    if (!enabled) {
        // Strip any existing per-message dropdowns from rendered chat messages
        try {
            const ctx = getContext();
            const chat = ctx?.chat;
            if (Array.isArray(chat)) {
                import('./librarian-ui.js').then(m => {
                    for (let i = 0; i < chat.length; i++) {
                        try { m.removeLibrarianDropdown(i); } catch { /* noop */ }
                    }
                }).catch(() => { /* noop */ });
            }
        } catch { /* noop */ }
    }
}
