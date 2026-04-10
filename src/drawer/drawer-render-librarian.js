/**
 * DeepLore Enhanced — Drawer Render: Librarian Tab
 *
 * v2: Flat Flags-only list (with Activity sub-tab), plain rows, selective
 * heatmap (only for repeat or high-urgency gaps), always-visible checkboxes,
 * persistent footer action row. Two-tier soft-remove via sibling arrays
 * in chat_metadata (`deeplore_lore_gaps_hidden` / `_dismissed`).
 */
import { escapeHtml } from '../../../../../utils.js';
import { loreGaps } from '../state.js';
import { getSettings } from '../../settings.js';
import { getHiddenGapIds, getDismissedGapIds, buildLibrarianActivityFeed } from '../librarian/librarian-tools.js';
import { ds, scheduleRender } from './drawer-state.js';

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

const URGENCY_SCORE = { low: 0.2, medium: 0.5, high: 1.0 };

/** Status set is now `pending` ↔ `written`. Soft-remove uses sibling arrays. */
const STATUS_ICONS = {
    pending: { icon: '<i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>', cls: 'dle-gap-pending', label: 'Pending' },
    written: { icon: '<i class="fa-solid fa-check" aria-hidden="true"></i>', cls: 'dle-gap-written', label: 'Written' },
};

/**
 * Compute a 0-3 relevance score for the (selective) heatmap intensity.
 * Only entries with `frequency >= 2 || urgency === 'high'` get tinted at all.
 */
function computeGapScore(gap) {
    const urgency = URGENCY_SCORE[gap.urgency] || 0.5;
    const freqNorm = Math.min(1, ((gap.frequency || 1) - 1) / 9);
    const ageMs = Date.now() - (gap.timestamp || 0);
    const ageHours = ageMs / (1000 * 60 * 60);
    const recency = Math.max(0, 1.0 - ageHours / 24);
    const raw = (freqNorm * 0.4) + (urgency * 0.4) + (recency * 0.2);
    return Math.min(3, raw * 2.5);
}

/** Format a timestamp as relative time (e.g. "2m ago"). */
function relativeTime(ts) {
    if (!ts) return '';
    const diffMs = Date.now() - ts;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

// ════════════════════════════════════════════════════════════════════════════
// Render
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render the Librarian tab.
 */
export function renderLibrarianTab() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;

    const $list = $drawer.find('.dle-librarian-list');
    const $empty = $drawer.find('#dle-panel-librarian .dle-empty-state');
    const $selectAllBar = $drawer.find('.dle-librarian-select-all-bar');
    const $actionRow = $drawer.find('.dle-librarian-action-row');
    const $toolbarBottom = $drawer.find('#dle-panel-librarian .dle-librarian-toolbar-bottom');

    // Sub-tabs (Flags / Activity) — roving tabindex
    const $subTabs = $drawer.find('.dle-librarian-sub-tabs');
    $subTabs.find('.dle-librarian-sub-tab').removeClass('active').attr('aria-checked', 'false').attr('tabindex', '-1');
    $subTabs.find(`[data-filter="${ds.librarianFilter}"]`).addClass('active').attr('aria-checked', 'true').attr('tabindex', '0');

    // Sort select
    $drawer.find('.dle-librarian-sort').val(ds.librarianSort);

    // Sub-tab counts: show only the COUNT OF NEW items since last view of that sub-tab.
    // Viewing a sub-tab clears its badge by stamping `lastViewed[subtab] = now`.
    const hiddenIds = getHiddenGapIds();
    const dismissedIds = getDismissedGapIds();
    const visibleFlagGaps = loreGaps.filter(g => g.type === 'flag' && !hiddenIds.has(g.id) && !dismissedIds.has(g.id));
    const activityFeed = buildLibrarianActivityFeed();

    // Stamp the active sub-tab as viewed BEFORE computing counts so its badge stays empty
    ds.librarianLastViewed[ds.librarianFilter] = Date.now();

    const flagNew = visibleFlagGaps.filter(g => (g.timestamp || 0) > ds.librarianLastViewed.flag).length;
    const activityNew = activityFeed.filter(it => (it.ts || 0) > ds.librarianLastViewed.activity).length;
    $subTabs.find('[data-filter="flag"] .dle-sub-tab-count').text(flagNew > 0 ? `(${flagNew})` : '');
    $subTabs.find('[data-filter="activity"] .dle-sub-tab-count').text(activityNew > 0 ? `(${activityNew})` : '');

    // ─── Activity sub-tab ───────────────────────────────────────────────────
    if (ds.librarianFilter === 'activity') {
        $selectAllBar.hide();
        $actionRow.hide();
        const feed = activityFeed;

        if (feed.length === 0) {
            $list.empty();
            const $text = $empty.find('.dle-librarian-empty-text');
            $text.text('No tool activity recorded yet.');
            $empty.find('.dle-librarian-empty-actions').css('display', '');
            $empty.addClass('dle-visible');
            $toolbarBottom.css('display', 'none');
            updateLibrarianBadge();
            return;
        }
        $empty.removeClass('dle-visible');
        $toolbarBottom.css('display', '');

        let html = '';
        for (const item of feed) {
            const icon = item.kind === 'tool-search'
                ? '<i class="fa-solid fa-magnifying-glass" aria-hidden="true" title="Search tool call"></i>'
                : item.kind === 'tool-flag'
                    ? '<i class="fa-solid fa-flag" aria-hidden="true" title="Flag tool call"></i>'
                    : item.kind === 'gap-flag'
                        ? '<i class="fa-solid fa-flag" aria-hidden="true" title="Persistent flag"></i>'
                        : '<i class="fa-solid fa-thumbtack" aria-hidden="true" title="Persistent search gap"></i>';
            const isSearch = item.type === 'search';
            const hasResults = isSearch && (item.resultTitles && item.resultTitles.length > 0);
            const metaText = item.kind === 'gap-search'
                ? 'no results'
                : item.kind === 'gap-flag'
                    ? `${item.urgency || 'medium'}${item.frequency > 1 ? `, flagged ${item.frequency}x` : ''}`
                    : isSearch
                        ? `${item.resultCount} result${item.resultCount !== 1 ? 's' : ''}`
                        : (item.urgency || '');
            const metaHtml = hasResults
                ? `<button type="button" class="dle-activity-meta dle-activity-results-link dle-text-xs" data-results="${escapeHtml(JSON.stringify(item.resultTitles))}" data-query="${escapeHtml(item.query)}" title="Show context returned to writing AI">${escapeHtml(metaText)}</button>`
                : `<span class="dle-activity-meta dle-text-xs dle-muted">${escapeHtml(metaText)}</span>`;
            html += `<div class="dle-librarian-activity-row" role="listitem">`
                + `<span class="dle-activity-icon">${icon}</span>`
                + `<span class="dle-activity-query">${escapeHtml(item.query)}</span>`
                + metaHtml
                + `<span class="dle-activity-time dle-text-xs dle-muted">${relativeTime(item.ts)}</span>`
                + `</div>`;
        }
        $list.html(html);
        updateLibrarianBadge();
        return;
    }

    // ─── Flags sub-tab ──────────────────────────────────────────────────────
    let gaps = [...visibleFlagGaps];

    // Sort
    switch (ds.librarianSort) {
        case 'frequency':
            gaps.sort((a, b) => (b.frequency || 1) - (a.frequency || 1));
            break;
        case 'urgency': {
            const order = { high: 0, medium: 1, low: 2 };
            gaps.sort((a, b) => (order[a.urgency] ?? 1) - (order[b.urgency] ?? 1));
            break;
        }
        case 'newest':
        default:
            gaps.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            break;
    }

    // Empty state
    if (gaps.length === 0) {
        $list.empty();
        $selectAllBar.hide();
        $actionRow.hide();
        const enabled = getSettings().librarianEnabled;
        const $text = $empty.find('.dle-librarian-empty-text');
        const $emptyActions = $empty.find('.dle-librarian-empty-actions');
        if (!enabled) {
            $text.text('Librarian is disabled. Enable it in Settings \u2192 Features \u2192 Librarian.');
            $emptyActions.css('display', 'none');
        } else {
            $text.text('No flagged issues yet. The AI will flag missing or stale lore during replies.');
            $emptyActions.css('display', '');
        }
        $empty.addClass('dle-visible');
        $toolbarBottom.css('display', 'none');
        updateLibrarianBadge();
        return;
    }
    $empty.removeClass('dle-visible');
    $toolbarBottom.css('display', '');
    $selectAllBar.show();
    $actionRow.show();

    // Build inbox HTML
    let html = '';
    for (const gap of gaps) {
        const score = computeGapScore(gap);
        // Selective heatmap: only repeat-flagged or high-urgency gaps get tinted
        const tinted = (gap.frequency || 1) >= 2 || gap.urgency === 'high';
        const tintClass = tinted ? 'dle-gap-tinted' : '';
        const isUpdate = gap.subtype === 'update';
        const subtypeClass = isUpdate ? 'dle-gap-update' : '';
        const statusInfo = STATUS_ICONS[gap.status] || STATUS_ICONS.pending;
        const title = escapeHtml(gap.query || '');
        const entryTitleAttr = gap.entryTitle ? `data-entry-title="${escapeHtml(gap.entryTitle)}"` : '';
        const time = relativeTime(gap.timestamp);
        const isSelected = ds.librarianSelected.has(gap.id);
        const selClass = isSelected ? 'dle-gap-selected' : '';

        html += `<div class="dle-librarian-entry ${tintClass} ${subtypeClass} ${selClass}" style="--dle-gap:${score.toFixed(2)}" `
            + `data-gap-id="${escapeHtml(gap.id)}" data-subtype="${gap.subtype || 'gap'}" ${entryTitleAttr} `
            + `data-urgency="${gap.urgency || 'medium'}" role="listitem" `
            + `aria-expanded="false" aria-label="${title}, ${statusInfo.label}, ${gap.urgency || 'medium'} urgency" tabindex="0">`;
        html += `<input type="checkbox" class="dle-gap-check" ${isSelected ? 'checked' : ''} aria-label="Select ${title}" tabindex="-1">`;
        // Update flags get a pen icon; gaps get the status icon
        if (isUpdate) {
            html += `<span class="dle-gap-status dle-gap-update-icon" title="Entry needs updating" aria-label="Update needed"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></span>`;
        } else {
            html += `<span class="dle-gap-status ${statusInfo.cls}" title="${statusInfo.label}" aria-label="${statusInfo.label}">${statusInfo.icon}</span>`;
        }
        html += `<span class="dle-gap-title">${title}</span>`;
        if (isUpdate && gap.entryTitle) {
            html += `<span class="dle-gap-entry-title dle-text-xs dle-muted">${escapeHtml(gap.entryTitle)}</span>`;
        }
        html += `<span class="dle-gap-time dle-text-xs dle-muted">${time}</span>`;
        html += `</div>`;
    }

    // Preserve focus across re-render
    const focusedGapId = document.activeElement?.closest?.('.dle-librarian-entry')?.dataset?.gapId;
    $list.html(html);
    if (focusedGapId) {
        const $target = $list.find(`[data-gap-id="${focusedGapId}"]`);
        if ($target.length) {
            $target[0].focus();
        } else {
            const $first = $list.find('.dle-librarian-entry').first();
            if ($first.length) $first[0].focus();
        }
    }

    // Select-all checkbox + count + action-row enablement
    const selCount = ds.librarianSelected.size;
    const allSelected = selCount > 0 && gaps.every(g => ds.librarianSelected.has(g.id));
    $selectAllBar.find('.dle-librarian-select-all').prop('checked', allSelected);
    $selectAllBar.find('.dle-librarian-select-count').text(selCount > 0 ? `${selCount} selected` : '');

    // Action buttons: act on selection only; disable when empty
    const hasSelection = selCount > 0;
    const hasSingleSelection = selCount === 1;
    $actionRow.find('[data-librarian-action="open"]').prop('disabled', !hasSingleSelection);
    $actionRow.find('[data-librarian-action="done"]').prop('disabled', !hasSelection);
    $actionRow.find('[data-librarian-action="remove"]').prop('disabled', !hasSelection);

    updateLibrarianBadge();
}

/**
 * Update the pending count badge on the Librarian tab button.
 */
export function updateLibrarianBadge() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;

    const hiddenIds = getHiddenGapIds();
    const dismissedIds = getDismissedGapIds();
    const pendingCount = loreGaps.filter(g =>
        g.status === 'pending'
        && g.type === 'flag'
        && !hiddenIds.has(g.id)
        && !dismissedIds.has(g.id)
    ).length;

    const $badge = $drawer.find('.dle-librarian-badge');
    if (pendingCount > 0) {
        $badge.text(pendingCount).addClass('dle-visible');
    } else {
        $badge.text('').removeClass('dle-visible');
    }

    const $tab = $drawer.find('#dle-tab-librarian');
    $tab.attr('aria-label', pendingCount > 0
        ? `Librarian -- ${pendingCount} pending flag${pendingCount !== 1 ? 's' : ''}`
        : 'Librarian -- lore activity and writing assistant');
}
