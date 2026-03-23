/**
 * DeepLore Enhanced — Drawer Event Wiring
 * All event handlers and interaction wiring for the drawer panel.
 */
import { chat_metadata, saveChatDebounced } from '../../../../../script.js';
import { escapeHtml } from '../../../../utils.js';
import { getSettings } from '../settings.js';
import {
    vaultIndex, indexTimestamp, indexEverLoaded,
    aiSearchStats,
    notifyGatingChanged, notifyPinBlockChanged,
} from './state.js';
import { buildIndex } from './vault.js';
import { buildObsidianURI } from './helpers.js';
import { openSettingsPopup } from './settings-ui.js';
import {
    ds, TAB_LABELS, TOOL_ACTIONS, EXPAND_ACTIONS, BROWSE_ROW_HEIGHT,
    scheduleRender,
} from './drawer-state.js';
import { renderBrowseTab, renderBrowseWindow } from './drawer-render.js';

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/** Execute a slash command via ST's context API */
function executeCommand(cmd) {
    const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
    if (ctx?.executeSlashCommands) {
        ctx.executeSlashCommands(cmd).catch(err => console.error('[DLE] Command error:', cmd, err));
    } else {
        console.warn('[DLE] Cannot execute command — SillyTavern.getContext() unavailable');
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Tab Switching
// ════════════════════════════════════════════════════════════════════════════

/**
 * Switch to a tab by name. Updates ARIA, classes, hidden state, roving tabindex, and label.
 * @param {jQuery} $drawer - The drawer root element
 * @param {string} tabName - Tab name to activate
 */
export function switchTab($drawer, tabName) {
    const $tabs = $drawer.find('.dle-tab');
    const $panels = $drawer.find('.dle-tab-panel');
    const $label = $drawer.find('.dle-tab-label');

    // Update tab bar — roving tabindex
    $tabs.each(function () {
        const $t = $(this);
        const isActive = $t.data('tab') === tabName;
        $t.toggleClass('active', isActive)
            .attr('aria-selected', isActive ? 'true' : 'false')
            .attr('tabindex', isActive ? '0' : '-1');
    });

    // Update panels — CSS handles visibility via .active class (fade-in animation)
    $panels.each(function () {
        const $p = $(this);
        const isActive = $p.data('tab') === tabName;
        $p.toggleClass('active', isActive);
    });

    // Update label
    $label.text(TAB_LABELS[tabName] || tabName);

    // Re-render browse window when switching to browse tab (may have been rendered
    // while hidden with degenerate viewport dimensions)
    if (tabName === 'browse') {
        ds.browseLastRangeStart = -1;
        ds.browseLastRangeEnd = -1;
        requestAnimationFrame(() => renderBrowseWindow());
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Wire Functions (one-time event binding)
// ════════════════════════════════════════════════════════════════════════════

/** Wire tools tab buttons to slash commands */
export function wireToolsTab($drawer) {
    $drawer.find('#dle-panel-tools').on('click', '.dle-tool-btn[data-action]', function () {
        const action = $(this).data('action');
        const cmd = TOOL_ACTIONS[action];
        if (cmd) executeCommand(cmd);
    });
}

/** Wire tab expand buttons */
export function wireTabExpand($drawer) {
    $drawer.on('click', '[data-expand]', function () {
        const target = $(this).data('expand');
        const cmd = EXPAND_ACTIONS[target];
        if (cmd) executeCommand(cmd);
    });
}

/** Wire status zone quick action buttons */
export function wireStatusActions($drawer) {
    $drawer.on('click', '.dle-action-btn[data-action]', function () {
        const action = $(this).data('action');
        switch (action) {
            case 'refresh': buildIndex(); break;
            case 'settings': openSettingsPopup(); break;
            case 'scribe': executeCommand('/dle-scribe'); break;
            case 'newlore': executeCommand('/dle-newlore'); break;
        }
    });
}

/** Wire browse tab interactions (search, filters, pin/block, expand preview) */
export function wireBrowseTab($drawer) {
    // Virtual scroll — re-render visible window on scroll (RAF-throttled)
    // The actual scroll container is .dle-drawer-inner (scrollableInner), not the tab panel
    $drawer.find('.dle-drawer-inner').on('scroll', function () {
        if (ds.browseScrollRAF) return;
        ds.browseScrollRAF = requestAnimationFrame(() => {
            ds.browseScrollRAF = null;
            renderBrowseWindow();
        });
    });

    // Search input with debounce
    $drawer.find('.dle-browse-input').on('input', function () {
        const val = $(this).val();
        clearTimeout(ds.browseSearchTimeout);
        ds.browseSearchTimeout = setTimeout(() => {
            ds.browseQuery = val;
            scheduleRender(renderBrowseTab);
        }, 300);
    });

    // Filter selects
    $drawer.find('[data-filter="status"]').on('change', function () {
        ds.browseStatusFilter = $(this).val();
        scheduleRender(renderBrowseTab);
    });

    $drawer.find('[data-filter="tag"]').on('change', function () {
        ds.browseTagFilter = $(this).val();
        scheduleRender(renderBrowseTab);
    });

    $drawer.find('[data-sort]').on('change', function () {
        ds.browseSort = $(this).val();
        scheduleRender(renderBrowseTab);
    });

    // Pin/block buttons via event delegation
    $drawer.find('.dle-browse-list').on('click', '.dle-browse-pin', function () {
        const title = $(this).data('entry');
        if (!title || !chat_metadata) return;

        if (!chat_metadata.deeplore_pins) chat_metadata.deeplore_pins = [];
        const tl = title.toLowerCase();
        const idx = chat_metadata.deeplore_pins.findIndex(t => t.toLowerCase() === tl);

        if (idx !== -1) {
            // Unpin
            chat_metadata.deeplore_pins.splice(idx, 1);
        } else {
            // Pin — also remove from blocks
            chat_metadata.deeplore_pins.push(title);
            if (chat_metadata.deeplore_blocks) {
                chat_metadata.deeplore_blocks = chat_metadata.deeplore_blocks.filter(t => t.toLowerCase() !== tl);
            }
        }
        saveChatDebounced();
        notifyPinBlockChanged();
    });

    $drawer.find('.dle-browse-list').on('click', '.dle-browse-block', function () {
        const title = $(this).data('entry');
        if (!title || !chat_metadata) return;

        if (!chat_metadata.deeplore_blocks) chat_metadata.deeplore_blocks = [];
        const tl = title.toLowerCase();
        const idx = chat_metadata.deeplore_blocks.findIndex(t => t.toLowerCase() === tl);

        if (idx !== -1) {
            // Unblock
            chat_metadata.deeplore_blocks.splice(idx, 1);
        } else {
            // Block — also remove from pins
            chat_metadata.deeplore_blocks.push(title);
            if (chat_metadata.deeplore_pins) {
                chat_metadata.deeplore_pins = chat_metadata.deeplore_pins.filter(t => t.toLowerCase() !== tl);
            }
        }
        saveChatDebounced();
        notifyPinBlockChanged();
    });

    // Click/keyboard-to-expand entry preview (click on entry info area, not buttons)
    $drawer.find('.dle-browse-list').on('click keydown', '.dle-browse-info', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        if (e.type === 'keydown') e.preventDefault();
        const $entry = $(this).closest('.dle-browse-entry');
        const title = $entry.data('title');
        if (!title) return;

        const $existing = $entry.find('.dle-browse-preview');
        if ($existing.length) {
            // Animate collapse: set current height explicitly, then transition to row height
            const currentHeight = $entry[0].scrollHeight;
            $entry.css('height', currentHeight + 'px');
            $entry[0].offsetHeight; // force reflow so browser sees start value
            $entry.css('height', BROWSE_ROW_HEIGHT + 'px');
            let cleaned = false;
            const cleanup = () => { if (!cleaned) { cleaned = true; $existing.remove(); } };
            $entry.one('transitionend', cleanup);
            setTimeout(cleanup, 250); // safety timeout
            $(this).attr('aria-expanded', 'false');
            ds.browseExpandedEntry = null;
            return;
        }

        // Collapse any other expanded entry
        $drawer.find('.dle-browse-preview').remove();
        $drawer.find('.dle-browse-entry').css('height', BROWSE_ROW_HEIGHT + 'px');
        $drawer.find('.dle-browse-info').attr('aria-expanded', 'false');

        // Find the entry data
        const entry = ds.browseFilteredEntries.find(e => e.title === title);
        if (!entry) return;

        ds.browseExpandedEntry = title;
        $(this).attr('aria-expanded', 'true');

        // Build preview content
        const preview = entry.summary || (entry.content ? entry.content.substring(0, 200) + (entry.content.length > 200 ? '...' : '') : 'No content');
        const tokens = entry.tokenEstimate ? `${entry.tokenEstimate} tokens` : '';

        // Build Obsidian link
        const settings = getSettings();
        const srcVault = entry.vaultSource && settings.vaults
            ? settings.vaults.find(v => v.name === entry.vaultSource) : null;
        const vaultName = srcVault ? srcVault.name : (settings.vaults?.[0]?.name || '');
        const uri = entry.filename ? buildObsidianURI(vaultName, entry.filename) : null;
        const linkHtml = uri ? ` <a href="${escapeHtml(uri)}" target="_blank" class="dle-obsidian-link" aria-label="Open in Obsidian">Open in Obsidian</a>` : '';

        const previewHtml = `<div class="dle-browse-preview"><div class="dle-browse-preview-text">${escapeHtml(preview)}</div><div class="dle-browse-preview-meta">${escapeHtml(tokens)}${linkHtml}</div></div>`;

        // Animate expand: lock current height, append preview, measure, transition
        $entry.css('height', BROWSE_ROW_HEIGHT + 'px');
        $entry.append(previewHtml);
        const naturalHeight = $entry[0].scrollHeight;
        $entry[0].offsetHeight; // force reflow so browser sees 32px start
        $entry.css({ height: naturalHeight + 'px', position: 'absolute' });
        // After transition, switch to auto so content isn't clipped
        $entry.one('transitionend', () => $entry.css('height', 'auto'));
    });
}

/** Wire gating tab interactions (chip remove, set buttons) */
export function wireGatingTab($drawer) {
    // Chip X buttons via event delegation — animate out before removing
    $drawer.find('#dle-panel-gating').on('click', '.dle-chip-x', function () {
        const field = $(this).data('field');
        const value = $(this).data('value');
        if (!field || !chat_metadata) return;

        if (!chat_metadata.deeplore_context) return;
        const ctx = chat_metadata.deeplore_context;

        // Animate the chip out
        const $chip = $(this).closest('.dle-chip');
        $chip.addClass('dle-chip-removing');

        // Update state after animation starts (don't wait for transitionend to avoid
        // the chip being re-rendered by a concurrent gating render)
        const applyRemoval = () => {
            if (field === 'characterPresent') {
                if (ctx.characters_present) {
                    ctx.characters_present = ctx.characters_present.filter(c => c !== value);
                }
            } else if (field === 'era') {
                ctx.era = null;
            } else if (field === 'location') {
                ctx.location = null;
            } else if (field === 'sceneType') {
                ctx.scene_type = null;
            }
            saveChatDebounced();
            notifyGatingChanged();
        };

        // Fire state update after animation completes (guard against double-fire)
        let fired = false;
        const once = () => { if (!fired) { fired = true; applyRemoval(); } };
        $chip.one('transitionend', once);
        setTimeout(once, 200); // safety timeout
    });

    // Set buttons via event delegation
    $drawer.find('#dle-panel-gating').on('click', '.dle-gating-set', async function () {
        const $group = $(this).closest('.dle-gating-group');
        const field = $group.data('field');
        if (!field) return;

        // Use the slash command which has the full browse-popup experience
        const cmdMap = {
            era: '/dle-set-era',
            location: '/dle-set-location',
            sceneType: '/dle-set-scene',
            characterPresent: '/dle-set-characters',
        };
        const cmd = cmdMap[field];
        if (cmd) executeCommand(cmd);
    });
}

/**
 * Wire health icon click handlers (one-time binding).
 */
export function wireHealthIcons($drawer) {
    const $footer = $drawer.find('#dle_drawer_footer');
    if (!$footer.length) return;

    $footer.find('.dle-health-icons').on('click', '[data-health]', function (e) {
        e.preventDefault();
        const area = $(this).data('health');
        switch (area) {
            case 'vault': executeCommand('/dle-health'); break;
            case 'connection': executeCommand('/dle-status'); break;
            case 'pipeline': executeCommand('/dle-inspect'); break;
            case 'cache': {
                const ageMs = indexTimestamp ? Date.now() - indexTimestamp : 0;
                const ageSec = Math.round(ageMs / 1000);
                const msg = indexTimestamp
                    ? `Index: ${vaultIndex.length} entries, ${ageSec}s old${indexEverLoaded ? '' : ' (from IndexedDB cache)'}`
                    : 'No index loaded yet.';
                if (typeof toastr !== 'undefined') toastr.info(msg, 'Cache Status');
                break;
            }
            case 'ai': {
                const totalTok = aiSearchStats.totalInputTokens + aiSearchStats.totalOutputTokens;
                const msg = `Calls: ${aiSearchStats.calls} | Cached: ${aiSearchStats.cachedHits} | Tokens: ${totalTok.toLocaleString()} (${aiSearchStats.totalInputTokens.toLocaleString()} in, ${aiSearchStats.totalOutputTokens.toLocaleString()} out)`;
                if (typeof toastr !== 'undefined') toastr.info(msg, 'AI Search Stats');
                break;
            }
        }
    });

    // Also handle Enter/Space for keyboard a11y
    $footer.find('.dle-health-icons').on('keydown', '[data-health]', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            $(this).trigger('click');
        }
    });
}
