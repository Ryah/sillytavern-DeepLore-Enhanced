/**
 * DeepLore Enhanced — Drawer Panel (Orchestrator)
 * Creates the drawer, wires observers, and delegates to render/events modules.
 *
 * Module split:
 *   drawer-state.js  — Shared mutable state, constants, utility functions
 *   drawer-render.js — All render/DOM-update functions
 *   drawer-events.js — All event wiring and interaction handlers
 *   drawer.js        — This file: creation, lifecycle, observer subscriptions
 */
import { doNavbarIconClick, saveSettingsDebounced } from '../../../../../script.js';
import { renderExtensionTemplateAsync, extension_settings } from '../../../../extensions.js';
import { escapeHtml } from '../../../../utils.js';
import {
    vaultIndex,
    lastInjectionSources,
    onIndexUpdated, onAiStatsUpdated, onCircuitStateChanged,
    onPipelineComplete, onGatingChanged, onPinBlockChanged, onGenerationLockChanged,
} from './state.js';

// ─── Drawer sub-modules ───
import {
    ds, DRAWER_ID, MODULE_NAME, OVERLAY_CHAT_WIDTH_THRESHOLD,
    scheduleRender, announceToScreenReader, loadSTInternals, dragElement, isMobile, power_user,
} from './drawer-state.js';
import {
    renderStatusZone, renderInjectionTab, renderBrowseTab, renderBrowseWindow,
    renderGatingTab, renderTimers, renderFooter,
} from './drawer-render.js';
import {
    switchTab,
    wireToolsTab, wireTabExpand, wireStatusActions, wireBrowseTab, wireGatingTab, wireHealthIcons,
} from './drawer-events.js';

// ════════════════════════════════════════════════════════════════════════════
// Public API (consumed by index.js)
// ════════════════════════════════════════════════════════════════════════════

/** Reset ephemeral drawer state on chat change */
export function resetDrawerState() {
    ds.browseQuery = '';
    ds.browseStatusFilter = 'all';
    ds.browseTagFilter = '';
    ds.browseSort = 'priority_asc';
    ds.browseFilteredEntries = [];
    ds.browseLastRangeStart = -1;
    ds.browseLastRangeEnd = -1;
    ds.browseExpandedEntry = null;
    ds.contextTokens = 0;
    ds.stGenerating = false;
    if (ds.browseSearchTimeout) { clearTimeout(ds.browseSearchTimeout); ds.browseSearchTimeout = null; }
    // Clear the search input and filter selects if drawer exists
    const $input = $(`#${DRAWER_ID} .dle-browse-input`);
    if ($input.length) $input.val('');
    const $status = $(`#${DRAWER_ID} [data-filter="status"]`);
    if ($status.length) $status.val('all');
    const $tag = $(`#${DRAWER_ID} [data-filter="tag"]`);
    if ($tag.length) $tag.val('');
    const $sort = $(`#${DRAWER_ID} [data-sort]`);
    if ($sort.length) $sort.val('priority_asc');
}

// ════════════════════════════════════════════════════════════════════════════
// Tag Cache
// ════════════════════════════════════════════════════════════════════════════

/** Rebuild the pre-computed tag cache from the current vault index */
function rebuildTagCache() {
    ds.cachedTagSet = new Set();
    for (const e of vaultIndex) {
        if (e.tags) for (const t of e.tags) ds.cachedTagSet.add(t);
    }
    ds.cachedTagOptions = '<option value="">Tags</option>' +
        [...ds.cachedTagSet].sort().map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
}

// ════════════════════════════════════════════════════════════════════════════
// Drawer Creation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create the drawer panel in #top-settings-holder.
 * Mirrors ST's native drawer structure exactly (see #rightNavHolder pattern).
 */
export async function createDrawerPanel() {
    if ($(`#${DRAWER_ID}`).length) return;

    // Load ST internals (Moving UI, mobile detection)
    await loadSTInternals();

    // Load the drawer HTML template
    const drawerContent = await renderExtensionTemplateAsync(
        'third-party/sillytavern-DeepLore-Enhanced',
        'drawer',
    );

    // Build the full drawer structure — mirrors ST's native pattern exactly
    const $drawer = ds.$drawer = $(`
        <div id="${DRAWER_ID}" class="drawer">
            <div class="drawer-toggle drawer-header">
                <div id="deeploreDrawerIcon"
                     class="drawer-icon fa-solid fa-scroll fa-fw interactable closedIcon"
                     title="DeepLore Enhanced"
                     tabindex="0"
                     role="button"
                     aria-expanded="false"
                     aria-label="DeepLore Enhanced drawer"></div>
            </div>
            <div id="deeplore-panel" class="drawer-content closedDrawer fillRight" role="region" aria-label="DeepLore Enhanced panel">
                <div id="deeplore-panelheader" class="fa-solid fa-grip drag-grabber" aria-hidden="true"></div>
                <div class="dle-drawer-controls">
                    <div class="dle-drawer-pin" title="Pin drawer open">
                        <input type="checkbox" id="dle_drawer_pin" aria-label="Pin drawer open">
                        <label for="dle_drawer_pin">
                            <div class="fa-solid unchecked fa-unlock right_menu_button" aria-hidden="true"></div>
                            <div class="fa-solid checked fa-lock right_menu_button" aria-hidden="true"></div>
                        </label>
                    </div>
                    <!-- NOTE: Do NOT use right_menu_button class on <button> elements — ST applies
                         background-color: rgb(240,240,240) which creates a white square. The lock avoids
                         this because it's a checkbox+label, not a button. Style manually instead. -->
                    <button id="dle_drawer_close" class="dle-drawer-close" title="Close drawer" aria-label="Close drawer">
                        <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
                    </button>
                </div>
                <div class="scrollableInner dle-drawer-inner">
                </div>
            </div>
        </div>
    `);

    // Inject content into the scrollable area, then move footer outside so it stays pinned
    $drawer.find('.dle-drawer-inner').append(drawerContent);
    const $footerZone = $drawer.find('#dle_drawer_footer');
    if ($footerZone.length) $footerZone.insertAfter($drawer.find('.dle-drawer-inner'));

    // Add to top-settings-holder (after native drawers)
    $('#top-settings-holder').append($drawer);

    // ═══════════════════════════════════════════════════════════════════════
    // Drawer toggle binding
    // ═══════════════════════════════════════════════════════════════════════

    // CRITICAL: Bind the drawer toggle — ST's initial binding already ran at page load,
    // so dynamically-added drawers need explicit binding to doNavbarIconClick
    $drawer.find('.drawer-toggle').on('click', function (e) {
        doNavbarIconClick.call(this, e);
        // Update aria-expanded after ST processes the toggle
        requestAnimationFrame(() => {
            const isOpen = $drawer.find('#deeplore-panel').hasClass('openDrawer');
            $drawer.find('#deeploreDrawerIcon').attr('aria-expanded', String(isOpen));
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Overlay mode
    // ═══════════════════════════════════════════════════════════════════════

    // When chat_width is set too high for the drawer to fit comfortably,
    // switch to fixed overlay (mirrors ST's mobile pattern).
    const $panel = $drawer.find('#deeplore-panel');

    function updateOverlayMode() {
        const chatWidth = power_user?.chat_width || 50;
        if (chatWidth >= OVERLAY_CHAT_WIDTH_THRESHOLD) {
            $panel.addClass('dle-overlay-mode');
        } else {
            $panel.removeClass('dle-overlay-mode');
        }
    }

    // Check on drawer toggle
    $drawer.find('.drawer-toggle').on('click', () => requestAnimationFrame(updateOverlayMode));
    // Check now (in case drawer is pinned open at init)
    updateOverlayMode();

    // ═══════════════════════════════════════════════════════════════════════
    // Pin / Close / Mobile
    // ═══════════════════════════════════════════════════════════════════════

    // Hide pin on mobile (ST convention — native drawers gate behind !isMobile())
    if (isMobile && isMobile()) {
        $drawer.find('.dle-drawer-pin').hide();
    }

    // Restore persisted pin state
    const settings = extension_settings[MODULE_NAME] || {};
    if (settings.drawerPinned && !(isMobile && isMobile())) {
        $drawer.find('#dle_drawer_pin').prop('checked', true);
        $drawer.find('#deeplore-panel').addClass('pinnedOpen');
        $drawer.find('#deeploreDrawerIcon').addClass('drawerPinnedOpen');
    }

    // Wire up pin toggle — matches ST's native drawer pin pattern
    $drawer.find('#dle_drawer_pin').on('click', function () {
        const pinned = $(this).prop('checked');
        if (pinned) {
            $drawer.find('#deeplore-panel').addClass('pinnedOpen');
            $drawer.find('#deeploreDrawerIcon').addClass('drawerPinnedOpen');
        } else {
            $drawer.find('#deeplore-panel').removeClass('pinnedOpen');
            $drawer.find('#deeploreDrawerIcon').removeClass('drawerPinnedOpen');
            // ST convention: close drawer on unpin if another drawer is also open
            if ($drawer.find('#deeplore-panel').hasClass('openDrawer') && $('.openDrawer').length > 1) {
                doNavbarIconClick.call($drawer.find('.drawer-toggle')[0]);
            }
        }

        // Persist pin state
        if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
        extension_settings[MODULE_NAME].drawerPinned = pinned;
        saveSettingsDebounced();
    });

    // Wire up close button — triggers the same toggle as clicking the drawer icon
    $drawer.find('#dle_drawer_close').on('click', function () {
        // Only close if drawer is actually open (prevent toggle-reopen)
        if ($panel.hasClass('openDrawer')) {
            doNavbarIconClick.call($drawer.find('.drawer-toggle')[0]);
        }
    });

    // Moving UI support — let ST's drag system handle our panel
    if (power_user?.movingUI && dragElement) {
        dragElement($('#deeplore-panel'));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Tab switching
    // ═══════════════════════════════════════════════════════════════════════

    $drawer.find('.dle-tab').on('click', function () {
        switchTab($drawer, $(this).data('tab'));
    });

    // Keyboard (arrow keys, Home/End per ARIA tabs pattern)
    $drawer.find('.dle-tab').on('keydown', function (e) {
        const $tabs = $drawer.find('.dle-tab');
        const idx = $tabs.index(this);
        let newIdx = idx;

        switch (e.key) {
            case 'ArrowRight': newIdx = (idx + 1) % $tabs.length; break;
            case 'ArrowLeft': newIdx = (idx - 1 + $tabs.length) % $tabs.length; break;
            case 'Home': newIdx = 0; break;
            case 'End': newIdx = $tabs.length - 1; break;
            default: return;
        }

        e.preventDefault();
        const $newTab = $tabs.eq(newIdx);
        switchTab($drawer, $newTab.data('tab'));
        $newTab.trigger('focus');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Wire event handlers (one-time, delegated to sub-module)
    // ═══════════════════════════════════════════════════════════════════════
    wireToolsTab($drawer);
    wireTabExpand($drawer);
    wireStatusActions($drawer);
    wireBrowseTab($drawer);
    wireGatingTab($drawer);
    wireHealthIcons($drawer);

    // ═══════════════════════════════════════════════════════════════════════
    // Context window event — track total prompt tokens after assembly
    // ═══════════════════════════════════════════════════════════════════════
    try {
        const stCtx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stCtx?.eventSource && stCtx?.eventTypes?.CHAT_COMPLETION_PROMPT_READY) {
            // Lazy-load promptManager to avoid breaking module graph for non-OAI backends
            if (!ds.promptManagerRef) {
                try {
                    const oai = await import('../../../../openai.js');
                    ds.promptManagerRef = oai.promptManager;
                } catch { /* non-OAI backend, context bar stays at 0 */ }
            }
            stCtx.eventSource.on(stCtx.eventTypes.CHAT_COMPLETION_PROMPT_READY, () => {
                ds.contextTokens = ds.promptManagerRef?.tokenUsage || 0;
                scheduleRender(renderFooter);
            });
        }
    } catch (err) {
        console.warn('[DLE] Could not wire context token tracking:', err.message);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Generation lifecycle — track "Writing..." state
    // ═══════════════════════════════════════════════════════════════════════
    try {
        const stCtx2 = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stCtx2?.eventSource && stCtx2?.eventTypes?.GENERATION_STARTED) {
            stCtx2.eventSource.on(stCtx2.eventTypes.GENERATION_STARTED, () => {
                ds.stGenerating = true;
                scheduleRender(renderStatusZone);
            });
            stCtx2.eventSource.on(stCtx2.eventTypes.GENERATION_ENDED, () => {
                ds.stGenerating = false;
                scheduleRender(renderStatusZone);
            });
        }
    } catch (err) {
        console.warn('[DLE] Could not wire generation lifecycle tracking:', err.message);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Initial render
    // ═══════════════════════════════════════════════════════════════════════

    // Build tag cache if index is already loaded
    if (vaultIndex?.length) rebuildTagCache();

    renderStatusZone();
    renderInjectionTab();
    renderBrowseTab();
    renderGatingTab();
    renderTimers();
    renderFooter();

    // ═══════════════════════════════════════════════════════════════════════
    // Observer subscriptions — live data updates
    // ═══════════════════════════════════════════════════════════════════════
    onIndexUpdated(() => {
        rebuildTagCache();
        scheduleRender(renderStatusZone);
        scheduleRender(renderBrowseTab);
        scheduleRender(renderTimers);
        scheduleRender(renderFooter);
        announceToScreenReader(`Vault index refreshed: ${vaultIndex.length} entries loaded.`);
    });

    onAiStatsUpdated(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderFooter);
    });

    onCircuitStateChanged(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderFooter);
    });

    onPipelineComplete(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderInjectionTab);
        scheduleRender(renderBrowseTab);
        scheduleRender(renderTimers);
        scheduleRender(renderFooter);
        if (lastInjectionSources !== null) {
            announceToScreenReader(`Pipeline complete: ${lastInjectionSources.length} entries injected.`);
        }
    });

    onGatingChanged(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderGatingTab);
    });

    onPinBlockChanged(() => {
        scheduleRender(renderBrowseTab);
    });

    onGenerationLockChanged(() => {
        scheduleRender(renderStatusZone);
    });
}
