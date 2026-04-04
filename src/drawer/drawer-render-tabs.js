/**
 * DeepLore Enhanced — Drawer Render: Tab Content
 * Renders the Why?, Browse, Gating, and Timers tab panels.
 */
import { chat_metadata } from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { getSettings } from '../../settings.js';
import {
    vaultIndex, lastInjectionSources, previousSources, lastPipelineTrace,
    generationLock, indexing,
    cooldownTracker, decayTracker, chatInjectionCounts, trackerKey,
    fieldDefinitions,
} from '../state.js';
import { DEFAULT_FIELD_DEFINITIONS } from '../fields.js';
import { buildObsidianURI, computeSourcesDiff, categorizeRejections, resolveEntryVault, normalizePinBlock } from '../helpers.js';
import {
    ds, BROWSE_ROW_HEIGHT, BROWSE_OVERSCAN,
    getMatchLabel, computeEntryTemperatures,
} from './drawer-state.js';

// ════════════════════════════════════════════════════════════════════════════
// Why? Tab
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render the "Why?" tab — shows why entries were injected AND why others were filtered out.
 */
export function renderInjectionTab() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const sources = lastInjectionSources;
    const prev = previousSources;
    const trace = lastPipelineTrace;
    const $list = $drawer.find('.dle-why-list');
    const $empty = $drawer.find('#dle-panel-injection .dle-empty-state');
    const $diff = $drawer.find('.dle-section-diff');
    const $whyNotSection = $drawer.find('.dle-why-not-section');
    const $whyNotList = $drawer.find('.dle-why-not-list');

    if (!sources || sources.length === 0) {
        $list.empty();
        $whyNotSection.removeClass('dle-visible');
        $diff.empty();
        // Show "Choosing lore..." during active generation, otherwise the default empty state
        if (generationLock) {
            $empty.html('<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><p>Choosing lore...</p>').addClass('dle-visible');
        } else {
            $empty.html('<i class="fa-solid fa-circle-question" aria-hidden="true"></i><p>No lore selected yet. Send a message to see which entries are included and why.</p>').addClass('dle-visible');
        }
        return;
    }

    $empty.removeClass('dle-visible');

    // Why? tab filter toggle — now static in drawer.html, just update active state
    const $filterToggle = $drawer.find('.dle-why-filter-toggle');
    $filterToggle.find('.dle-why-filter-btn').removeClass('active').attr('aria-checked', 'false');
    $filterToggle.find(`[data-filter="${ds.whyTabFilter}"]`).addClass('active').attr('aria-checked', 'true');

    // Compute diff via shared data layer
    const diff = computeSourcesDiff(sources, prev);

    // Diff header
    const diffParts = [];
    if (diff.added.length) diffParts.push(`<span class="dle-diff-add" aria-label="${diff.added.length} new entries added">+${diff.added.length} new</span>`);
    if (diff.removed.length) diffParts.push(`<span class="dle-diff-remove" aria-label="${diff.removed.length} entries removed">-${diff.removed.length} removed</span>`);
    $diff.html(diffParts.join(' '));

    // Build entries
    const settings = getSettings();
    const addedTitles = new Set(diff.added.map(s => s.title));
    const removedTitles = new Set(diff.removed.map(s => s.title));

    function buildWhyHtml(srcs) {
        let h = '';
        for (let idx = 0; idx < srcs.length; idx++) {
            const src = srcs[idx];
            const isNew = addedTitles.has(src.title);
            const isConstant = src.constant || (src.matchedBy && src.matchedBy.toLowerCase().includes('constant'));
            const classes = ['dle-why-entry'];
            if (isNew) classes.push('dle-why-new');
            if (isConstant) classes.push('dle-why-constant');

            const { uri } = resolveEntryVault(src, settings.vaults);
            const matchLabel = getMatchLabel(src.matchedBy);

            const entryAriaLabel = `${escapeHtml(src.title)}, ${src.tokens || '?'} tokens, matched by ${matchLabel}${isNew ? ', newly added' : ''}`;
            h += `<div class="${classes.join(' ')}" style="--i:${idx}" role="listitem" aria-label="${entryAriaLabel}" data-title="${escapeHtml(src.title)}">`;
            h += `<span class="dle-why-title">`;
            if (uri) {
                h += `<a href="${escapeHtml(uri)}" class="dle-obsidian-link" aria-label="Open ${escapeHtml(src.title)} in Obsidian">${escapeHtml(src.title)}</a>`;
            } else {
                h += escapeHtml(src.title);
            }
            h += `</span>`;
            h += `<span class="dle-why-meta">`;
            const tokVal = src.tokens || 0;
            const tokHue = Math.max(0, 120 - (tokVal / 5000) * 120); // 120=green, 0=red
            h += `<span class="dle-why-tokens" style="color: hsl(${Math.round(tokHue)}, 80%, 50%)" aria-label="${tokVal} tokens">${tokVal} tokens</span>`;
            const whyChatCount = chatInjectionCounts.get(`${src.vaultSource || ''}:${src.title}`) || 0;
            if (whyChatCount > 0) h += `<span class="dle-inject-count" title="Injected ${whyChatCount} time${whyChatCount !== 1 ? 's' : ''} this chat" aria-label="Injected ${whyChatCount} times this chat">${whyChatCount}×</span>`;
            h += `<span class="dle-why-match" data-match-type="${matchLabel.toLowerCase()}" title="Matched via ${escapeHtml(src.matchedBy || '?')}" aria-label="Match type: ${matchLabel}">${matchLabel}</span>`;
            if (isNew) h += `<span class="dle-why-new-badge" aria-label="Newly added entry">NEW</span>`;
            h += `<button class="dle-browse-nav-btn" data-browse-title="${escapeHtml(src.title)}" title="Show in Browse" aria-label="Show ${escapeHtml(src.title)} in Browse tab"><i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i></button>`;
            h += `</span>`;
            h += `</div>`;
        }
        return h;
    }

    // Apply filter visibility
    const showInjected = ds.whyTabFilter !== 'filtered';
    const showFiltered = ds.whyTabFilter !== 'injected';
    $list.toggle(showInjected);
    $diff.toggle(showInjected);

    // Animate exit for removed entries, then swap in new content
    if (showInjected && removedTitles.size > 0 && $list.children().length > 0) {
        const exitEls = $list.find('.dle-why-entry').filter(function () {
            return removedTitles.has($(this).data('title'));
        });
        if (exitEls.length > 0) {
            exitEls.addClass('dle-why-exit');
            let swapped = false;
            const swap = () => { if (!swapped) { swapped = true; $list.html(buildWhyHtml(sources)); } };
            // Swap after exit animation completes (or safety timeout if animationend doesn't fire)
            exitEls[0].addEventListener('animationend', swap, { once: true });
            setTimeout(swap, 250);
        } else {
            $list.html(buildWhyHtml(sources));
        }
    } else {
        $list.html(buildWhyHtml(sources));
    }

    // ── "Why Not" section — entries that were candidates but got filtered out ──
    if (!showFiltered) {
        $whyNotSection.removeClass('dle-visible');
    } else if (trace) {
        // Use shared categorization (all 9 rejection stages), render with group headers
        const injectedTitles = new Set(sources.map(s => s.title));
        const rejectedGroups = categorizeRejections(trace, injectedTitles);
        const nonEmpty = rejectedGroups.filter(g => g.entries.length > 0);

        if (nonEmpty.length > 0) {
            let whyNotHtml = '';
            for (const group of nonEmpty) {
                // Group sub-header
                whyNotHtml += `<div class="dle-why-not-group-header" role="heading" aria-level="4">`;
                whyNotHtml += `<span class="dle-why-not-group-icon">${group.icon}</span> `;
                whyNotHtml += `<span class="dle-why-not-group-label">${escapeHtml(group.label)}</span>`;
                whyNotHtml += `<span class="dle-why-not-group-count">${group.entries.length}</span>`;
                whyNotHtml += `</div>`;
                // Entries under this group
                for (const e of group.entries) {
                    whyNotHtml += `<div class="dle-why-entry dle-why-not-entry dle-why-not-grouped" role="listitem" aria-label="${escapeHtml(e.title)}, filtered: ${escapeHtml(e.reason)}">`;
                    whyNotHtml += `<span class="dle-why-title dle-muted">${escapeHtml(e.title)}</span>`;
                    whyNotHtml += `<span class="dle-why-meta"><span class="dle-why-match dle-why-not-reason" title="${escapeHtml(e.reason)}">${escapeHtml(e.reason)}</span>`;
                    whyNotHtml += `<button class="dle-browse-nav-btn" data-browse-title="${escapeHtml(e.title)}" title="Show in Browse" aria-label="Show ${escapeHtml(e.title)} in Browse tab"><i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i></button></span>`;
                    whyNotHtml += `</div>`;
                }
            }
            $whyNotList.html(whyNotHtml);
            $whyNotSection.addClass('dle-visible');
        } else {
            $whyNotSection.removeClass('dle-visible');
        }
    } else {
        $whyNotSection.removeClass('dle-visible');
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Browse Tab
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render the browse tab with live vault entries.
 */
export function renderBrowseTab() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const $list = $drawer.find('.dle-browse-list');
    const $emptyLoading = $drawer.find('#dle-browse-loading');
    const $emptyNoData = $drawer.find('#dle-browse-empty-no-data');
    const $emptyNoResults = $drawer.find('#dle-browse-empty-no-results');
    const $refreshSpinner = $drawer.find('.dle-browse-refresh-spinner');

    // Show/hide inline refresh spinner (visible when indexing with existing data)
    $refreshSpinner.toggle(!!indexing && vaultIndex.length > 0);

    // Announce loading state to screen readers
    $drawer.find('#dle-panel-browse').attr('aria-busy', indexing ? 'true' : 'false');

    if (!vaultIndex || vaultIndex.length === 0) {
        $list.empty();
        // Show loading state during first index build, otherwise "no entries" state
        if (indexing) {
            $emptyLoading.addClass('dle-visible');
            $emptyNoData.removeClass('dle-visible');
        } else {
            $emptyLoading.removeClass('dle-visible');
            $emptyNoData.addClass('dle-visible');
        }
        $emptyNoResults.removeClass('dle-visible');
        return;
    }

    $emptyLoading.removeClass('dle-visible');
    $emptyNoData.removeClass('dle-visible');

    // Use pre-computed tag cache (rebuilt on index update)
    const $tagSelect = $drawer.find('[data-filter="tag"]');
    if (ds.cachedTagOptions) {
        $tagSelect.html(ds.cachedTagOptions);
        if (ds.browseTagFilter) $tagSelect.val(ds.browseTagFilter);
    }

    // Reset stale tag filter if the tag no longer exists in the vault
    if (ds.browseTagFilter && ds.cachedTagSet && !ds.cachedTagSet.has(ds.browseTagFilter)) {
        ds.browseTagFilter = '';
    }

    // Populate custom field filter dropdowns
    const browseFieldDefs = (fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS)
        .filter(fd => fd.gating?.enabled);
    const $cfContainer = $drawer.find('.dle-browse-custom-filters');
    if ($cfContainer.length && browseFieldDefs.length > 0) {
        // Collect unique values per field from vault
        const fieldValues = {};
        for (const fd of browseFieldDefs) {
            const vals = new Set();
            for (const e of vaultIndex) {
                const v = e.customFields?.[fd.name];
                if (v == null) continue;
                if (Array.isArray(v)) v.forEach(x => { if (x) vals.add(String(x)); });
                else if (v !== '') vals.add(String(v));
            }
            if (vals.size > 0) fieldValues[fd.name] = [...vals].sort();
        }
        // Only render selects for fields that have values in the vault
        let cfHtml = '';
        for (const fd of browseFieldDefs) {
            const vals = fieldValues[fd.name];
            if (!vals || vals.length === 0) continue;
            const current = ds.browseCustomFieldFilters[fd.name] || '';
            cfHtml += `<select class="text_pole dle-browse-filter-select dle-browse-cf-filter" data-cf="${escapeHtml(fd.name)}" aria-label="Filter by ${escapeHtml(fd.label)}">`;
            cfHtml += `<option value="">${escapeHtml(fd.label)}</option>`;
            for (const v of vals) {
                cfHtml += `<option value="${escapeHtml(v)}"${current === v ? ' selected' : ''}>${escapeHtml(v)}</option>`;
            }
            cfHtml += '</select>';
        }
        // Don't replace filter HTML while user has a dropdown open (prevents disruption)
        const activeEl = document.activeElement;
        if (!(activeEl && $cfContainer[0]?.contains(activeEl) && (activeEl.tagName === 'SELECT' || activeEl.closest('.dle-browse-cf-filter')))) {
            $cfContainer.html(cfHtml);
        }
    }

    const settings = getSettings();

    // Get filters
    const query = ds.browseQuery.toLowerCase();
    const statusFilter = ds.browseStatusFilter;
    const tagFilter = ds.browseTagFilter;
    const sortKey = ds.browseSort;

    // Pin/block state
    const pins = chat_metadata?.deeplore_pins || [];
    const blocks = chat_metadata?.deeplore_blocks || [];
    // BUG-AUDIT-3: Use normalizePinBlock to handle both {title,vaultSource} objects and legacy bare strings
    const pinSet = new Set(pins.map(p => normalizePinBlock(p).title.toLowerCase()));
    const blockSet = new Set(blocks.map(b => normalizePinBlock(b).title.toLowerCase()));

    // Injected set — fall back to lastPipelineTrace (sources cleared after message render)
    const injectedSet = new Set();
    const injSources = lastInjectionSources ?? lastPipelineTrace?.injected;
    if (injSources) {
        for (const s of injSources) injectedSet.add(s.title.toLowerCase());
    }

    // Filter
    let entries = vaultIndex.filter(e => {
        // Search
        if (query) {
            const titleMatch = e.title.toLowerCase().includes(query);
            const keyMatch = e.keys && e.keys.some(k => k.toLowerCase().includes(query));
            if (!titleMatch && !keyMatch) return false;
        }

        // Status filter
        const tl = e.title.toLowerCase();
        if (statusFilter === 'injected' && !injectedSet.has(tl)) return false;
        if (statusFilter === 'pinned' && !pinSet.has(tl)) return false;
        if (statusFilter === 'blocked' && !blockSet.has(tl)) return false;
        if (statusFilter === 'constant' && !e.constant) return false;
        if (statusFilter === 'seed' && !e.seed) return false;
        if (statusFilter === 'bootstrap' && !e.bootstrap) return false;
        if (statusFilter === 'never_injected') {
            const key = trackerKey(e);
            const allTime = settings.analyticsData?.[key];
            if (allTime && (allTime.injected || 0) > 0) return false;
        }

        // Tag filter
        if (tagFilter && (!e.tags || !e.tags.includes(tagFilter))) return false;

        // Custom field filters
        for (const [cfName, cfVal] of Object.entries(ds.browseCustomFieldFilters)) {
            if (!cfVal) continue;
            const ev = e.customFields?.[cfName];
            if (ev == null) return false;
            if (Array.isArray(ev)) {
                if (!ev.some(v => String(v).toLowerCase() === cfVal.toLowerCase())) return false;
            } else {
                if (String(ev).toLowerCase() !== cfVal.toLowerCase()) return false;
            }
        }

        return true;
    });

    // Sort
    entries = [...entries];
    switch (sortKey) {
        case 'priority_asc': entries.sort((a, b) => (a.priority || 50) - (b.priority || 50)); break;
        case 'priority_desc': entries.sort((a, b) => (b.priority || 50) - (a.priority || 50)); break;
        case 'alpha_asc': entries.sort((a, b) => a.title.localeCompare(b.title)); break;
        case 'alpha_desc': entries.sort((a, b) => b.title.localeCompare(a.title)); break;
        case 'tokens_desc': entries.sort((a, b) => (b.tokenEstimate || 0) - (a.tokenEstimate || 0)); break;
        case 'tokens_asc': entries.sort((a, b) => (a.tokenEstimate || 0) - (b.tokenEstimate || 0)); break;
        case 'injections_desc': entries.sort((a, b) => (chatInjectionCounts.get(trackerKey(b)) || 0) - (chatInjectionCounts.get(trackerKey(a)) || 0)); break;
        default: entries.sort((a, b) => (a.priority || 50) - (b.priority || 50));
    }

    // Update filter summary line
    const $summary = $drawer.find('.dle-browse-summary');
    const isFiltered = query || statusFilter !== 'all' || tagFilter || Object.values(ds.browseCustomFieldFilters).some(v => v);
    if (isFiltered && entries.length !== vaultIndex.length) {
        $summary.text(`Showing ${entries.length} of ${vaultIndex.length} entries`).show();
    } else {
        $summary.hide();
    }

    // Store filtered entries for virtual scroll
    ds.browseFilteredEntries = entries;
    ds.browseLastRangeStart = -1;
    ds.browseLastRangeEnd = -1;
    // If navigating from Carto/Why?, preserve the target for auto-expand; otherwise reset
    if (ds.browseNavigateTarget) {
        ds.browseExpandedEntry = ds.browseNavigateTarget;
        ds.browseNavigateTarget = null;
    } else {
        ds.browseExpandedEntry = null; // collapse any expanded entry on filter change
        ds.browseExpandedIdx = null;
        ds.browseExpandedExtraHeight = 0;
    }

    // Set up virtual scroll container — use min-height so flex doesn't collapse it
    const listEl = $list[0];
    if (!listEl) return;
    const totalHeight = entries.length * BROWSE_ROW_HEIGHT + (ds.browseExpandedExtraHeight || 0);
    $list.css({ 'min-height': totalHeight + 'px' });

    // Reset scroll to top when filters change (prevents seeing empty results after filtering while scrolled)
    const scrollContainer = $drawer.find('.dle-drawer-inner')[0];
    if (scrollContainer) scrollContainer.scrollTop = 0;

    // Render visible window
    renderBrowseWindow();
    $emptyNoResults.toggleClass('dle-visible', entries.length === 0);
}

/**
 * Render only the visible window of browse entries (virtual scroll).
 * Reads scroll position from the tab panel, computes visible range, renders only those rows.
 */
export function renderBrowseWindow() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const $list = $drawer.find('.dle-browse-list');
    const listEl = $list[0];
    if (!listEl) return;

    const entries = ds.browseFilteredEntries;
    if (!entries.length) { $list.empty(); return; }

    // The scrollable container is .dle-drawer-inner, not the tab panel
    const scrollContainer = $drawer.find('.dle-drawer-inner')[0];
    if (!scrollContainer) return;
    // Guard: skip calculation when drawer is hidden (getBoundingClientRect returns zeros)
    if (!scrollContainer.offsetParent && !scrollContainer.offsetHeight) return;
    const viewHeight = scrollContainer.clientHeight;
    // How far the list's top is above (negative) or below (positive) the scroll container's viewport top
    // Using getBoundingClientRect for robustness against intermediate positioned parents
    const relativeScroll = scrollContainer.getBoundingClientRect().top - listEl.getBoundingClientRect().top;

    const startIdx = Math.max(0, Math.floor(relativeScroll / BROWSE_ROW_HEIGHT) - BROWSE_OVERSCAN);
    const endIdx = Math.min(entries.length, Math.ceil((relativeScroll + viewHeight) / BROWSE_ROW_HEIGHT) + BROWSE_OVERSCAN);

    // Skip re-render if visible range hasn't changed
    if (startIdx === ds.browseLastRangeStart && endIdx === ds.browseLastRangeEnd) return;
    ds.browseLastRangeStart = startIdx;
    ds.browseLastRangeEnd = endIdx;

    // Pin/block/injected state for rendering
    const pins = chat_metadata?.deeplore_pins || [];
    const blocks = chat_metadata?.deeplore_blocks || [];
    // BUG-AUDIT-3: Use normalizePinBlock to handle both {title,vaultSource} objects and legacy bare strings
    const pinSet = new Set(pins.map(p => normalizePinBlock(p).title.toLowerCase()));
    const blockSet = new Set(blocks.map(b => normalizePinBlock(b).title.toLowerCase()));
    // Build injected set — fall back to lastPipelineTrace when lastInjectionSources
    // has been consumed by CHARACTER_MESSAGE_RENDERED (moved to message.extra)
    const injectedSet = new Set();
    const injSources = lastInjectionSources ?? lastPipelineTrace?.injected;
    if (injSources) {
        for (const s of injSources) injectedSet.add(s.title.toLowerCase());
    }

    // Compute entry temperatures for visual heat indicator
    const tempMap = computeEntryTemperatures();

    // Build rejection reason lookup from pipeline trace (for "why not?" indicators)
    const rejectionMap = new Map();
    if (lastPipelineTrace) {
        const rejGroups = categorizeRejections(lastPipelineTrace, injectedSet);
        for (const group of rejGroups) {
            for (const entry of group.entries) {
                if (!rejectionMap.has(entry.title.toLowerCase())) {
                    rejectionMap.set(entry.title.toLowerCase(), { label: group.label, icon: group.icon, reason: entry.reason });
                }
            }
        }
    }

    let html = '';
    for (let i = startIdx; i < endIdx; i++) {
        const e = entries[i];
        const tl = e.title.toLowerCase();
        const isPinned = pinSet.has(tl);
        const isBlocked = blockSet.has(tl);
        const isInjected = injectedSet.has(tl);

        const classes = ['dle-browse-entry'];
        if (isInjected) classes.push('dle-browse-injected');

        const keysStr = e.constant ? '(constant)' : (e.keys ? e.keys.slice(0, 4).join(', ') : '');
        const prioLabel = e.constant ? 'CONST' : `P${e.priority || 50}`;
        const prioClass = e.constant ? ' dle-browse-constant' : '';

        const statusParts = [];
        if (isInjected) statusParts.push('currently injected');
        if (isPinned) statusParts.push('pinned');
        if (isBlocked) statusParts.push('blocked');
        if (e.constant) statusParts.push('constant');
        const browseAriaLabel = `${escapeHtml(e.title)}, ${prioLabel}${statusParts.length ? ', ' + statusParts.join(', ') : ''}`;

        let top = i * BROWSE_ROW_HEIGHT;
        if (ds.browseExpandedIdx !== null && i > ds.browseExpandedIdx) {
            top += ds.browseExpandedExtraHeight;
        }
        // Temperature indicator: tint entry based on injection frequency
        const tempKey = trackerKey(e);
        const temp = tempMap.get(tempKey);
        const tempStyle = temp && temp.hue !== 'neutral' ? `--dle-temp:${temp.tempScore.toFixed(2)};--dle-temp-hue:${temp.hue};` : '';
        const tempClass = temp && temp.hue !== 'neutral' ? ` dle-temp-${temp.hue}` : '';

        html += `<div class="${classes.join(' ')}${tempClass}" data-title="${escapeHtml(e.title)}" data-idx="${i}" role="listitem" aria-label="${browseAriaLabel}" aria-setsize="${entries.length}" aria-posinset="${i + 1}" style="position:absolute;top:${top}px;left:0;right:0;height:${BROWSE_ROW_HEIGHT}px;${tempStyle}">`;
        html += `<div class="dle-browse-info" role="button" tabindex="0" aria-expanded="false" aria-label="Expand ${escapeHtml(e.title)}">`;
        html += `<span class="dle-browse-title">${escapeHtml(e.title)}</span>`;
        html += `<span class="dle-browse-keys" aria-label="Keywords: ${escapeHtml(keysStr || 'none')}">${escapeHtml(keysStr)}</span>`;
        html += `</div>`;
        html += `<div class="dle-browse-controls">`;
        // "Why not?" rejection indicator for non-injected entries
        const rejection = !isInjected ? rejectionMap.get(tl) : null;
        if (rejection) {
            html += `<span class="dle-browse-why-not" title="${escapeHtml(rejection.label)}: ${escapeHtml(rejection.reason)}" aria-label="Not injected: ${escapeHtml(rejection.reason)}"><i class="fa-solid ${escapeHtml(rejection.icon)}" aria-hidden="true"></i></span>`;
        }
        const browseCount = chatInjectionCounts.get(trackerKey(e)) || 0;
        if (browseCount > 0) html += `<span class="dle-inject-count" title="Injected ${browseCount} time${browseCount !== 1 ? 's' : ''} this chat">${browseCount}×</span>`;
        html += `<span class="dle-browse-priority${prioClass}" title="${e.constant ? 'Constant — always injected' : `Priority ${e.priority || 50} (lower = more important)`}" aria-label="${e.constant ? 'Constant entry, always injected' : `Priority ${e.priority || 50}`}">${prioLabel}</span>`;
        html += `<button class="dle-browse-pin${isPinned ? ' dle-pin-active' : ''}" data-entry="${escapeHtml(e.title)}" data-vault="${escapeHtml(e.vaultSource || '')}" aria-label="${isPinned ? 'Unpin' : 'Pin'} ${escapeHtml(e.title)}" title="${isPinned ? 'Pinned — always inject' : 'Click to pin'}"><i class="fa-solid fa-thumbtack" aria-hidden="true"></i></button>`;
        html += `<button class="dle-browse-block${isBlocked ? ' dle-block-active' : ''}" data-entry="${escapeHtml(e.title)}" data-vault="${escapeHtml(e.vaultSource || '')}" aria-label="${isBlocked ? 'Unblock' : 'Block'} ${escapeHtml(e.title)}" title="${isBlocked ? 'Blocked — never inject' : 'Click to block'}"><i class="fa-solid fa-ban" aria-hidden="true"></i></button>`;
        html += `</div>`;
        html += `</div>`;
    }

    $list.html(html);

    // Re-expand entry if one was expanded before this re-render
    if (ds.browseExpandedEntry) {
        const $entry = $list.find(`.dle-browse-entry[data-title="${CSS.escape(ds.browseExpandedEntry)}"]`);
        if ($entry.length) {
            const entry = ds.browseFilteredEntries.find(e => e.title === ds.browseExpandedEntry);
            if (entry) {
                const preview = entry.summary || (entry.content ? entry.content.substring(0, 200) + (entry.content.length > 200 ? '...' : '') : 'No content');
                const tokens = entry.tokenEstimate ? `${entry.tokenEstimate} tokens` : '';
                const settings = getSettings();
                const srcVault = entry.vaultSource && settings.vaults ? settings.vaults.find(v => v.name === entry.vaultSource) : null;
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
                // Related entries: direct links + shared keywords
                let relatedHtml = '';
                const related = [];
                for (const link of entry.resolvedLinks || []) {
                    if (!related.includes(link)) related.push(link);
                }
                if (related.length < 5) {
                    const entryKeys = new Set((entry.keys || []).map(k => k.toLowerCase()));
                    if (entryKeys.size > 0) {
                        for (const other of vaultIndex) {
                            if (other.title === entry.title) continue;
                            if (related.includes(other.title)) continue;
                            const overlap = (other.keys || []).filter(k => entryKeys.has(k.toLowerCase())).length;
                            if (overlap > 0) related.push(other.title);
                            if (related.length >= 5) break;
                        }
                    }
                }
                if (related.length > 0) {
                    relatedHtml = `<div class="dle-browse-related"><span class="dle-muted">Related:</span> `;
                    for (const r of related.slice(0, 5)) {
                        relatedHtml += `<span class="dle-browse-related-chip dle-browse-nav-btn" data-browse-title="${escapeHtml(r)}" title="Show in Browse">${escapeHtml(r)}</span>`;
                    }
                    relatedHtml += `</div>`;
                }

                $entry.append(`<div class="dle-browse-preview"><div class="dle-browse-preview-text">${escapeHtml(preview)}</div>${fieldsHtml}${relatedHtml}<div class="dle-browse-preview-meta">${escapeHtml(tokens)}${linkHtml}</div></div>`);
                $entry.css({ height: 'auto' });
                // Measure expanded height and store for virtual scroll offset
                const expandedHeight = $entry[0].scrollHeight;
                ds.browseExpandedIdx = parseInt($entry.data('idx'), 10);
                ds.browseExpandedExtraHeight = Math.max(0, expandedHeight - BROWSE_ROW_HEIGHT);
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Gating Tab
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render the gating tab with live context state.
 */
export function renderGatingTab() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const ctx = chat_metadata?.deeplore_context;

    // Dynamic field definitions from state
    const fieldDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;

    // Build dynamic gating group HTML if container exists
    const $container = $drawer.find('.dle-gating-fields-container');
    const enabledDefs = fieldDefs.filter(fd => fd.gating?.enabled);
    if ($container.length) {
        $container.empty();
        for (const fd of enabledDefs) {
            const hasValue = ctx && (fd.multi
                ? (Array.isArray(ctx[fd.contextKey]) && ctx[fd.contextKey].length > 0)
                : !!ctx[fd.contextKey]);
            const dotClass = hasValue ? 'dle-gating-dot-active' : 'dle-gating-dot-empty';
            const setIcon = fd.multi ? 'fa-plus-circle' : 'fa-pen-to-square';
            const setLabel = fd.multi ? `Add to ${escapeHtml(fd.label)}` : `Set ${escapeHtml(fd.label)}`;
            const fieldHtml = `<div class="dle-gating-group" data-field="${escapeHtml(fd.name)}"${fd.multi ? ' data-multi="true"' : ''}>
                <span class="dle-gating-dot ${dotClass}" aria-hidden="true"></span>
                <span class="dle-gating-label" id="dle-gating-${escapeHtml(fd.name)}" title="${escapeHtml(fd.label)}">${escapeHtml(fd.label)}</span>
                <div class="dle-gating-value" aria-labelledby="dle-gating-${escapeHtml(fd.name)}">
                    <button class="menu_button menu_button_icon dle-gating-set" title="${setLabel}" aria-label="${setLabel}">
                        <i class="fa-solid ${setIcon}" aria-hidden="true"></i>
                    </button>
                </div>
            </div>`;
            $container.append(fieldHtml);
        }
        // Empty state hint when all fields are unset
        const anySet = enabledDefs.some(fd => {
            if (!ctx) return false;
            return fd.multi
                ? (Array.isArray(ctx[fd.contextKey]) && ctx[fd.contextKey].length > 0)
                : !!ctx[fd.contextKey];
        });
        $container.find('.dle-gating-hint').remove();
        if (!anySet && enabledDefs.length > 0) {
            $container.append('<div class="dle-gating-hint">Set gating fields to filter which lore entries are included. Use <code>/dle-set-field</code> or click the edit icon on any field.</div>');
        }
    }

    // Render values for each field
    for (const fd of fieldDefs) {
        if (!fd.gating?.enabled) continue;
        const $group = $drawer.find(`.dle-gating-group[data-field="${fd.name}"]`);
        const $value = $group.find('.dle-gating-value');
        const value = ctx ? ctx[fd.contextKey] : null;
        const $setBtn = $value.find('.dle-gating-set');

        // Remove everything except the set button
        $value.find('.dle-chip, .dle-gating-empty, .dle-gating-count').remove();

        if (!fd.multi) {
            if (value) {
                $setBtn.before(`<span class="dle-chip">${escapeHtml(value)} <button class="dle-chip-x" data-field="${escapeHtml(fd.name)}" data-value="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(value)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`);
                // Impact count: entries with this field set but don't match
                const filtered = vaultIndex.filter(e => {
                    const val = e.customFields?.[fd.name];
                    if (!val || (Array.isArray(val) && val.length === 0)) return false;
                    if (Array.isArray(val)) return !val.some(v => v.toLowerCase() === value.toLowerCase());
                    return String(val).toLowerCase() !== value.toLowerCase();
                }).length;
                if (filtered > 0) {
                    $setBtn.before(`<span class="dle-gating-count" aria-label="Excluding ${filtered} entries" title="${filtered} entries don't match this value and will be filtered out">excluding ${filtered}</span>`);
                }
            } else {
                $setBtn.before('<span class="dle-gating-empty">Not set</span>');
            }
        } else {
            // Array field
            if (value && value.length > 0) {
                for (const c of value) {
                    $setBtn.before(`<span class="dle-chip">${escapeHtml(c)} <button class="dle-chip-x" data-field="${escapeHtml(fd.name)}" data-value="${escapeHtml(c)}" aria-label="Remove ${escapeHtml(c)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`);
                }
                // Impact count: entries with this field set but no overlap
                const activeSet = new Set(value.map(c => c.toLowerCase()));
                const filtered = vaultIndex.filter(e => {
                    const eVal = e.customFields?.[fd.name];
                    return eVal?.length && !eVal.some(v => activeSet.has(v.toLowerCase()));
                }).length;
                if (filtered > 0) {
                    $setBtn.before(`<span class="dle-gating-count" aria-label="Excluding ${filtered} entries" title="${filtered} entries don't match this value and will be filtered out">excluding ${filtered}</span>`);
                }
            } else {
                $setBtn.before('<span class="dle-gating-empty">None set</span>');
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Timers
// ════════════════════════════════════════════════════════════════════════════

/** Render active entry timers (cooldown, decay, warmup) below gating */
export function renderTimers() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const $list = $drawer.find('.dle-timer-list');
    const $empty = $drawer.find('.dle-timer-empty');
    const rows = [];
    const settings = getSettings();

    // Cooldown entries
    let timerIdx = 0;
    for (const [key, remaining] of cooldownTracker) {
        const name = key.includes(':') ? key.split(':').slice(1).join(':') : key;
        rows.push(`<div class="dle-timer-row" style="--i:${timerIdx++}" role="listitem">
            <span class="dle-timer-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="dle-timer-badge dle-timer-cooldown">${remaining} message${remaining !== 1 ? 's' : ''} cooldown</span>
        </div>`);
    }

    // Decay entries (stale = above boost threshold, frequent = consecutive via consecutiveInjections)
    if (settings.decayEnabled) {
        const boostThreshold = settings.decayBoostThreshold || 5;
        for (const [key, staleness] of decayTracker) {
            if (staleness >= boostThreshold) {
                const name = key.includes(':') ? key.split(':').slice(1).join(':') : key;
                rows.push(`<div class="dle-timer-row" style="--i:${timerIdx++}" role="listitem">
                    <span class="dle-timer-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                    <span class="dle-timer-badge dle-timer-stale">stale ${staleness} message${staleness !== 1 ? 's' : ''}</span>
                </div>`);
            }
        }
    }

    // Note: Warmup is static configuration (entry.warmup threshold), not an active timer.
    // Removed from timers section — would show ALL entries with warmup > 1 regardless of state.

    $list.html(rows.join(''));
    $empty.toggleClass('dle-visible', rows.length === 0);
}
