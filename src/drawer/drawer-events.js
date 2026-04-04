/**
 * DeepLore Enhanced — Drawer Event Wiring
 * All event handlers and interaction wiring for the drawer panel.
 */
import { chat_metadata, saveChatDebounced, saveSettingsDebounced } from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { getSettings, invalidateSettingsCache } from '../../settings.js';
import {
    vaultIndex, indexTimestamp, indexEverLoaded,
    aiSearchStats, lastInjectionSources,
    notifyGatingChanged, notifyPinBlockChanged,
    fieldDefinitions,
    loreGaps, setLoreGaps,
} from '../state.js';
import { DEFAULT_FIELD_DEFINITIONS } from '../fields.js';
import { normalizePinBlock } from '../helpers.js';
import { buildIndex } from '../vault/vault.js';
import { buildObsidianURI } from '../helpers.js';
import { openRuleBuilder } from '../ui/rule-builder.js';
import {
    ds, TAB_LABELS, TOOL_ACTIONS, EXPAND_ACTIONS, BROWSE_ROW_HEIGHT,
    scheduleRender,
} from './drawer-state.js';
import { renderInjectionTab, renderBrowseTab, renderBrowseWindow } from './drawer-render.js';
import { renderLibrarianTab } from './drawer-render-librarian.js';

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

    // E10: Persist last viewed tab
    try { localStorage.setItem('dle-last-drawer-tab', tabName); } catch { /* noop */ }
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
    $drawer.on('click', '[data-expand]', async function () {
        try {
            const target = $(this).data('expand');
            // Why tab "Full View" → show Context Cartographer popup (no API call)
            if (target === 'injection') {
                const { lastInjectionSources } = await import('../state.js');
                let sources = lastInjectionSources;
                // Fallback: lastInjectionSources gets cleared after render — check the last AI message
                if (!sources || sources.length === 0) {
                    const { chat } = await import('../../../../../../script.js');
                    if (chat) {
                        for (let i = chat.length - 1; i >= 0; i--) {
                            if (!chat[i].is_user && chat[i].extra?.deeplore_sources?.length > 0) {
                                sources = chat[i].extra.deeplore_sources;
                                break;
                            }
                        }
                    }
                }
                if (sources && sources.length > 0) {
                    const { showSourcesPopup } = await import('../ui/cartographer.js');
                    showSourcesPopup(sources);
                } else {
                    toastr.info('No lore sources from the last generation. Send a message first.', 'DeepLore Enhanced', { timeOut: 3000 });
                }
                return;
            }
            const cmd = EXPAND_ACTIONS[target];
            if (cmd) executeCommand(cmd);
        } catch (err) {
            console.error('[DLE] Tab expand error:', err);
            toastr.error('Failed to expand tab view.', 'DeepLore Enhanced');
        }
    });
}

/** Wire status zone quick action buttons */
export function wireStatusActions($drawer) {
    $drawer.on('click', '.dle-action-btn[data-action]', function () {
        const action = $(this).data('action');
        switch (action) {
            case 'refresh': buildIndex().catch(err => console.warn('[DLE] Manual refresh failed:', err.message)); break;
            case 'scribe': executeCommand('/dle-scribe'); break;
            case 'newlore': executeCommand('/dle-newlore'); break;
        }
    });

    // First-run setup banner actions
    $drawer.on('click', '.dle-setup-banner-btn', async () => {
        try {
            const { showSetupWizard } = await import('../ui/setup-wizard.js');
            showSetupWizard();
        } catch (err) {
            console.error('[DLE] Setup wizard error:', err);
            toastr.error('Failed to open setup wizard.', 'DeepLore Enhanced');
        }
    });
    $drawer.on('click', '.dle-setup-banner-dismiss', () => {
        $drawer.find('.dle-setup-banner').remove();
        const s = getSettings();
        s._wizardCompleted = true;
        invalidateSettingsCache();
        saveSettingsDebounced();
    });
}

/** Wire the Why? tab filter toggle (Injected / Filtered / Both) */
export function wireInjectionTab($drawer) {
    $drawer.on('click', '.dle-why-filter-btn', function () {
        ds.whyTabFilter = $(this).data('filter') || 'both';
        scheduleRender(renderInjectionTab);
    });

    // Copy injected entry titles to clipboard
    $drawer.on('click', '.dle-copy-titles-btn', function () {
        const sources = lastInjectionSources;
        if (!sources || sources.length === 0) {
            toastr.warning('No injected entries to copy.', 'DeepLore Enhanced', { timeOut: 2000 });
            return;
        }
        const titles = sources.map(s => s.title).join('\n');
        navigator.clipboard.writeText(titles).then(
            () => toastr.success(`Copied ${sources.length} entry title${sources.length !== 1 ? 's' : ''} to clipboard`, 'DeepLore Enhanced', { timeOut: 2000 }),
            () => toastr.warning('Clipboard access denied — check browser permissions.', 'DeepLore Enhanced', { timeOut: 3000 }),
        );
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

    // Custom field filter selects (delegated — selects are dynamically created)
    $drawer.find('.dle-browse-filters').on('change', '.dle-browse-cf-filter', function () {
        const field = $(this).data('cf');
        const val = $(this).val();
        if (val) {
            ds.browseCustomFieldFilters[field] = val;
        } else {
            delete ds.browseCustomFieldFilters[field];
        }
        scheduleRender(renderBrowseTab);
    });

    // BUG-AUDIT-3: Pin/block buttons via event delegation
    // Store {title, vaultSource} objects to match the format used by slash commands.
    // Use normalizePinBlock() to safely compare existing entries (handles both legacy
    // bare strings and structured objects).
    $drawer.find('.dle-browse-list').on('click', '.dle-browse-pin', function () {
        const title = $(this).data('entry');
        const vaultSource = $(this).data('vault') || null;
        if (!title || !chat_metadata) return;

        if (!chat_metadata.deeplore_pins) chat_metadata.deeplore_pins = [];
        const tl = title.toLowerCase();
        const idx = chat_metadata.deeplore_pins.findIndex(p => normalizePinBlock(p).title.toLowerCase() === tl);

        if (idx !== -1) {
            // Unpin
            chat_metadata.deeplore_pins.splice(idx, 1);
        } else {
            // Pin — also remove from blocks
            chat_metadata.deeplore_pins.push({ title, vaultSource });
            if (chat_metadata.deeplore_blocks) {
                chat_metadata.deeplore_blocks = chat_metadata.deeplore_blocks.filter(b => normalizePinBlock(b).title.toLowerCase() !== tl);
            }
        }
        saveChatDebounced();
        notifyPinBlockChanged();
    });

    $drawer.find('.dle-browse-list').on('click', '.dle-browse-block', function () {
        const title = $(this).data('entry');
        const vaultSource = $(this).data('vault') || null;
        if (!title || !chat_metadata) return;

        if (!chat_metadata.deeplore_blocks) chat_metadata.deeplore_blocks = [];
        const tl = title.toLowerCase();
        const idx = chat_metadata.deeplore_blocks.findIndex(b => normalizePinBlock(b).title.toLowerCase() === tl);

        if (idx !== -1) {
            // Unblock
            chat_metadata.deeplore_blocks.splice(idx, 1);
        } else {
            // Block — also remove from pins
            chat_metadata.deeplore_blocks.push({ title, vaultSource });
            if (chat_metadata.deeplore_pins) {
                chat_metadata.deeplore_pins = chat_metadata.deeplore_pins.filter(p => normalizePinBlock(p).title.toLowerCase() !== tl);
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

        const $list = $drawer.find('.dle-browse-list');
        const $existing = $entry.find('.dle-browse-preview');
        if ($existing.length) {
            // Collapse: reset expanded state and force re-render to fix positions
            $existing.remove();
            $entry.css('height', BROWSE_ROW_HEIGHT + 'px');
            $(this).attr('aria-expanded', 'false');
            ds.browseExpandedEntry = null;
            ds.browseExpandedIdx = null;
            ds.browseExpandedExtraHeight = 0;
            // Update container min-height and force re-render
            const totalHeight = ds.browseFilteredEntries.length * BROWSE_ROW_HEIGHT;
            $list.css({ 'min-height': totalHeight + 'px' });
            ds.browseLastRangeStart = -1; // invalidate cache
            renderBrowseWindow();
            return;
        }

        // Collapse any other expanded entry
        $drawer.find('.dle-browse-preview').remove();
        $drawer.find('.dle-browse-entry').css('height', BROWSE_ROW_HEIGHT + 'px');
        $drawer.find('.dle-browse-info').attr('aria-expanded', 'false');

        // Find the entry data
        const entry = ds.browseFilteredEntries.find(e => e.title === title);
        if (!entry) return;

        const entryIdx = parseInt($entry.data('idx'), 10);
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
        const linkHtml = uri ? ` <a href="${escapeHtml(uri)}" class="dle-obsidian-link" aria-label="Open in Obsidian">Open in Obsidian</a>` : '';

        // Custom fields line
        let fieldsHtml = '';
        if (entry.customFields && Object.keys(entry.customFields).length > 0) {
            const pairs = Object.entries(entry.customFields)
                .filter(([, v]) => v != null && v !== '' && (!Array.isArray(v) || v.length > 0))
                .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(Array.isArray(v) ? v.join(', ') : String(v))}`);
            if (pairs.length) fieldsHtml = `<div class="dle-browse-fields">${pairs.join(' &middot; ')}</div>`;
        }

        const previewHtml = `<div class="dle-browse-preview"><div class="dle-browse-preview-text">${escapeHtml(preview)}</div>${fieldsHtml}<div class="dle-browse-preview-meta">${escapeHtml(tokens)}${linkHtml}</div></div>`;

        // Expand: append preview, measure, store offset for virtual scroll
        $entry.append(previewHtml);
        $entry.css('height', 'auto');
        const naturalHeight = $entry[0].scrollHeight;
        const extraHeight = Math.max(0, naturalHeight - BROWSE_ROW_HEIGHT);

        ds.browseExpandedIdx = entryIdx;
        ds.browseExpandedExtraHeight = extraHeight;

        // Update container min-height and force re-render to shift entries below
        const totalHeight = ds.browseFilteredEntries.length * BROWSE_ROW_HEIGHT + extraHeight;
        $list.css({ 'min-height': totalHeight + 'px' });
        ds.browseLastRangeStart = -1; // invalidate cache
        renderBrowseWindow();
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
            // Look up the field definition to find the contextKey
            const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
            const fd = allDefs.find(d => d.name === field);
            if (fd) {
                const ctxKey = fd.contextKey;
                if (fd.multi && Array.isArray(ctx[ctxKey])) {
                    ctx[ctxKey] = ctx[ctxKey].filter(c => c !== value);
                } else {
                    ctx[ctxKey] = null;
                }
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

    // Set buttons via event delegation — uses generic /dle-set-field for custom fields
    $drawer.find('#dle-panel-gating').on('click', '.dle-gating-set', async function () {
        const $group = $(this).closest('.dle-gating-group');
        const field = $group.data('field');
        if (!field) return;

        // Built-in fields have dedicated commands; custom fields use generic command
        const cmdMap = {
            era: '/dle-set-era',
            location: '/dle-set-location',
            scene_type: '/dle-set-scene',
            character_present: '/dle-set-characters',
        };
        const cmd = cmdMap[field] || `/dle-set-field ${field}`;
        executeCommand(cmd);
    });

    // Clear All gating button — reset all active context fields
    $drawer.find('.dle-clear-all-gating-btn').on('click', function () {
        if (!chat_metadata?.deeplore_context) return;
        const ctx = chat_metadata.deeplore_context;
        const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
        let cleared = 0;
        for (const fd of allDefs) {
            if (!fd.gating?.enabled) continue;
            const val = ctx[fd.contextKey];
            if (fd.multi ? (Array.isArray(val) && val.length > 0) : !!val) {
                ctx[fd.contextKey] = fd.multi ? [] : null;
                cleared++;
            }
        }
        if (cleared === 0) {
            toastr.info('No active gating filters to clear.', 'DeepLore Enhanced', { timeOut: 2000 });
            return;
        }
        saveChatDebounced();
        notifyGatingChanged();
        toastr.success(`Cleared ${cleared} gating filter${cleared !== 1 ? 's' : ''}.`, 'DeepLore Enhanced', { timeOut: 2000 });
    });

    // Manage Fields button — opens the rule builder popup
    $drawer.find('.dle-manage-fields-btn').on('click', () => openRuleBuilder());
}

/**
 * Wire health icon click handlers (one-time binding).
 */
export function wireHealthIcons($drawer) {
    const $footer = $drawer.find('#dle-drawer-footer');
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

// ════════════════════════════════════════════════════════════════════════════
// Librarian Tab
// ════════════════════════════════════════════════════════════════════════════

/** Wire Librarian tab interactions (filter, sort, gap click) */
export function wireLibrarianTab($drawer) {
    // Sub-tab buttons
    $drawer.on('click', '.dle-librarian-sub-tab', function () {
        ds.librarianFilter = $(this).data('filter') || 'all';
        scheduleRender(renderLibrarianTab);
    });

    // Sort select
    $drawer.on('change', '.dle-librarian-sort', function () {
        ds.librarianSort = $(this).val() || 'newest';
        scheduleRender(renderLibrarianTab);
    });

    // Click status icon → cycle pending→acknowledged→rejected (quick-toggle)
    $drawer.on('click', '.dle-gap-status', function (e) {
        e.stopPropagation();
        const $entry = $(this).closest('.dle-librarian-entry');
        const gapId = $entry.data('gap-id');
        const gap = loreGaps.find(g => g.id === gapId);
        if (!gap) return;

        const cycle = { pending: 'acknowledged', acknowledged: 'rejected', rejected: 'pending' };
        gap.status = cycle[gap.status] || 'acknowledged';
        setLoreGaps([...loreGaps]); // trigger observers
        scheduleRender(renderLibrarianTab);
    });

    // Click gap action buttons (inside expanded view)
    $drawer.on('click', '.dle-gap-action', function (e) {
        e.stopPropagation();
        const action = $(this).data('action');
        const $entry = $(this).closest('.dle-librarian-entry');
        const gapId = $entry.data('gap-id');
        const gap = loreGaps.find(g => g.id === gapId);
        if (!gap) return;

        if (action === 'acknowledge') {
            gap.status = 'acknowledged';
            setLoreGaps([...loreGaps]);
            scheduleRender(renderLibrarianTab);
        } else if (action === 'reject') {
            gap.status = 'rejected';
            setLoreGaps([...loreGaps]);
            scheduleRender(renderLibrarianTab);
        } else if (action === 'open-editor') {
            executeCommand(`/dle-librarian gap ${gapId}`);
        }
    });

    // Click on a gap entry (not status icon, not action buttons) → toggle expand
    $drawer.on('click', '.dle-librarian-entry', function (e) {
        if ($(e.target).closest('.dle-gap-status, .dle-gap-action').length) return;

        const $entry = $(this);
        const $existing = $entry.find('.dle-gap-detail');

        if ($existing.length) {
            // Collapse
            $existing.remove();
            $entry.removeClass('dle-gap-expanded');
            return;
        }

        // Collapse any other expanded entry
        $drawer.find('.dle-gap-detail').remove();
        $drawer.find('.dle-librarian-entry').removeClass('dle-gap-expanded');

        // Build expanded detail
        const gapId = $entry.data('gap-id');
        const gap = loreGaps.find(g => g.id === gapId);
        if (!gap) return;

        let detailHtml = '<div class="dle-gap-detail">';
        detailHtml += `<div class="dle-gap-detail-reason">${escapeHtml(gap.reason || 'No reason provided')}</div>`;
        detailHtml += `<div class="dle-gap-detail-meta">`;
        detailHtml += `Frequency: ${gap.frequency || 1}× &middot; Urgency: ${gap.urgency || 'medium'} &middot; Status: ${gap.status || 'pending'}`;
        detailHtml += `</div>`;

        if (gap.type === 'search' && gap.resultTitles?.length > 0) {
            detailHtml += `<div class="dle-gap-detail-results">`;
            detailHtml += `<span class="dle-gap-detail-results-label">Search results: ${gap.resultTitles.length} entries</span>`;
            detailHtml += `<div class="dle-gap-detail-results-list">${gap.resultTitles.map(t => escapeHtml(t)).join(' &middot; ')}</div>`;
            detailHtml += `</div>`;
        } else if (gap.type === 'search') {
            detailHtml += `<div class="dle-gap-detail-results"><span class="dle-gap-detail-results-label">No search results found</span></div>`;
        }

        detailHtml += `<div class="dle-gap-detail-actions">`;
        detailHtml += `<button class="menu_button_icon dle-gap-action" data-action="acknowledge" title="Acknowledge (a)"><i class="fa-solid fa-check"></i> Acknowledge</button>`;
        detailHtml += `<button class="menu_button_icon dle-gap-action" data-action="open-editor" title="Open Editor (Enter)"><i class="fa-solid fa-pen-to-square"></i> Open Editor</button>`;
        detailHtml += `<button class="menu_button_icon dle-gap-action" data-action="reject" title="Reject (x)"><i class="fa-solid fa-xmark"></i> Reject</button>`;
        detailHtml += `</div>`;
        detailHtml += '</div>';

        $entry.append(detailHtml);
        $entry.addClass('dle-gap-expanded');
    });

    // Keyboard shortcuts on focused gap entries
    $drawer.on('keydown', '.dle-librarian-entry', function (e) {
        const gapId = $(this).data('gap-id');
        const gap = loreGaps.find(g => g.id === gapId);

        if (e.key === 'a' && gap) {
            e.preventDefault();
            gap.status = 'acknowledged';
            setLoreGaps([...loreGaps]);
            scheduleRender(renderLibrarianTab);
        } else if (e.key === 'x' && gap) {
            e.preventDefault();
            gap.status = 'rejected';
            setLoreGaps([...loreGaps]);
            scheduleRender(renderLibrarianTab);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if ($(this).find('.dle-gap-detail').length) {
                // If already expanded, Enter opens editor
                if (gapId) executeCommand(`/dle-librarian gap ${gapId}`);
            } else {
                // First Enter expands
                $(this).trigger('click');
            }
        } else if (e.key === ' ') {
            e.preventDefault();
            $(this).trigger('click');
        }
    });

    // Clear Written/Rejected button
    $drawer.on('click', '.dle-librarian-clear-written', function () {
        const remaining = loreGaps.filter(g => g.status !== 'written' && g.status !== 'rejected');
        setLoreGaps(remaining);
        scheduleRender(renderLibrarianTab);
    });

    // New Entry button in empty state
    $drawer.on('click', '.dle-librarian-new-entry-btn', function () {
        executeCommand('/dle-librarian');
    });
}
