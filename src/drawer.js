/**
 * DeepLore Enhanced — Drawer Panel
 * Native ST drawer in the top bar for live pipeline status and operations.
 * Phase 0: Static mockup with placeholder content.
 */
import { doNavbarIconClick, saveSettingsDebounced } from '../../../../../script.js';
import { renderExtensionTemplateAsync, extension_settings } from '../../../../extensions.js';

// Lazy-loaded ST internals (imported dynamically to avoid breaking the module graph)
let dragElement, isMobile, power_user;
async function loadSTInternals() {
    try {
        const ross = await import('../../../../../scripts/RossAscends-mods.js');
        dragElement = ross.dragElement;
        isMobile = ross.isMobile;
        const pu = await import('../../../../../scripts/power-user.js');
        power_user = pu.power_user;
    } catch (err) {
        console.warn('[DLE] Could not load ST internals for drawer (Moving UI/mobile detection unavailable):', err.message);
    }
}

const DRAWER_ID = 'deeplore-drawer';
const MODULE_NAME = 'deeplore-enhanced';

/** Tab name → display label map */
const TAB_LABELS = {
    injection: 'Injection',
    browse: 'Browse',
    gating: 'Gating',
    tools: 'Tools',
};

/**
 * Switch to a tab by name. Updates ARIA, classes, hidden state, roving tabindex, and label.
 * @param {jQuery} $drawer - The drawer root element
 * @param {string} tabName - Tab name to activate
 */
function switchTab($drawer, tabName) {
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

    // Update panels — use hidden attribute for a11y
    $panels.each(function () {
        const $p = $(this);
        const isActive = $p.data('tab') === tabName;
        $p.toggleClass('active', isActive);
        if (isActive) {
            $p.removeAttr('hidden');
        } else {
            $p.attr('hidden', '');
        }
    });

    // Update label
    $label.text(TAB_LABELS[tabName] || tabName);
}

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
    const $drawer = $(`
        <div id="${DRAWER_ID}" class="drawer">
            <div class="drawer-toggle drawer-header">
                <div id="deeploreDrawerIcon"
                     class="drawer-icon fa-solid fa-scroll fa-fw interactable closedIcon"
                     title="DeepLore Enhanced"
                     tabindex="0"
                     role="button"></div>
            </div>
            <nav id="deeplore-panel" class="drawer-content closedDrawer fillRight">
                <div id="deeplore-panelheader" class="fa-solid fa-grip drag-grabber" aria-hidden="true"></div>
                <div class="dle-drawer-pin" title="Pin drawer open">
                    <input type="checkbox" id="dle_drawer_pin" aria-label="Pin drawer open">
                    <label for="dle_drawer_pin">
                        <div class="fa-solid unchecked fa-unlock right_menu_button" aria-hidden="true"></div>
                        <div class="fa-solid checked fa-lock right_menu_button" aria-hidden="true"></div>
                    </label>
                </div>
                <div class="scrollableInner dle-drawer-inner">
                </div>
            </nav>
        </div>
    `);

    // Inject content into the scrollable area
    $drawer.find('.dle-drawer-inner').append(drawerContent);

    // Add to top-settings-holder (after native drawers)
    $('#top-settings-holder').append($drawer);

    // CRITICAL: Bind the drawer toggle — ST's initial binding already ran at page load,
    // so dynamically-added drawers need explicit binding to doNavbarIconClick
    $drawer.find('.drawer-toggle').on('click', doNavbarIconClick);

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

    // Moving UI support — let ST's drag system handle our panel
    if (power_user?.movingUI && dragElement) {
        dragElement($('#deeplore-panel'));
    }

    // Wire up tab switching — click
    $drawer.find('.dle-tab').on('click', function () {
        switchTab($drawer, $(this).data('tab'));
    });

    // Wire up tab switching — keyboard (arrow keys, Home/End per ARIA tabs pattern)
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
}
