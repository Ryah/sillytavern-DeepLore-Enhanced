/**
 * DeepLore Enhanced — Drawer Render: Librarian Tab
 * Renders the Librarian inbox with gap records, green heatmap, and filters.
 */
import { escapeHtml } from '../../../../../utils.js';
import { loreGaps } from '../state.js';
import { getSettings } from '../../settings.js';
import { ds, scheduleRender } from './drawer-state.js';

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/** Urgency → normalized score for heatmap */
const URGENCY_SCORE = { low: 0.2, medium: 0.5, high: 1.0 };

/** Status → icon mapping (FontAwesome) */
const STATUS_ICONS = {
    pending: { icon: '<i class="fa-solid fa-circle-exclamation"></i>', cls: 'dle-gap-pending', label: 'Pending' },
    acknowledged: { icon: '<i class="fa-solid fa-eye"></i>', cls: 'dle-gap-acknowledged', label: 'Noted' },
    in_progress: { icon: '<i class="fa-solid fa-spinner fa-spin"></i>', cls: 'dle-gap-in-progress', label: 'In progress' },
    written: { icon: '<i class="fa-solid fa-check"></i>', cls: 'dle-gap-written', label: 'Written' },
    rejected: { icon: '<i class="fa-solid fa-xmark"></i>', cls: 'dle-gap-rejected', label: 'Dismissed' },
};

/**
 * Compute a 0-3 relevance score for heatmap intensity.
 * Higher = stronger signal (green tint), lower = weaker (grey/no tint).
 */
function computeGapScore(gap) {
    const urgency = URGENCY_SCORE[gap.urgency] || 0.5;
    // Normalize frequency to 0-1 range (1 → 0, 10+ → 1)
    const freqNorm = Math.min(1, ((gap.frequency || 1) - 1) / 9);

    // Recency: 1.0 at <1hr, decays to 0 at 24hr
    const ageMs = Date.now() - (gap.timestamp || 0);
    const ageHours = ageMs / (1000 * 60 * 60);
    const recency = Math.max(0, 1.0 - ageHours / 24);

    // Unmet search bonus (strongest triage signal)
    const unmetBonus = (gap.type === 'search' && !gap.hadResults) ? 0.3 : 0;

    // Rescale to use more of the 0-3 range (raw max is ~1.2)
    const raw = (freqNorm * 0.3) + (urgency * 0.3) + (recency * 0.2) + unmetBonus;
    return Math.min(3, raw * 2.5);
}

/**
 * Format a timestamp as relative time (e.g. "2m ago", "3h ago", "1d ago").
 */
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
 * Render the Librarian tab — inbox of gap records with green heatmap.
 */
export function renderLibrarianTab() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;

    const $list = $drawer.find('.dle-librarian-list');
    const $empty = $drawer.find('#dle-panel-librarian .dle-empty-state');

    // Update sub-tab active states
    const $subTabs = $drawer.find('.dle-librarian-sub-tabs');
    $subTabs.find('.dle-librarian-sub-tab').removeClass('active').attr('aria-checked', 'false');
    $subTabs.find(`[data-filter="${ds.librarianFilter}"]`).addClass('active').attr('aria-checked', 'true');

    // Show/hide activity filter dropdown (only visible on Activity sub-tab)
    const $activityFilter = $drawer.find('.dle-librarian-activity-filter');
    $activityFilter.css('display', ds.librarianFilter === 'activity' ? '' : 'none');
    $activityFilter.val(ds.librarianActivityFilter);

    // Update sort select
    $drawer.find('.dle-librarian-sort').val(ds.librarianSort);

    // Show/hide Clear Written button
    const hasCompleted = loreGaps.some(g => g.status === 'written' || g.status === 'rejected');
    $drawer.find('.dle-librarian-clear-written').css('display', hasCompleted ? '' : 'none');

    // Filter gaps by sub-tab
    let gaps = [...loreGaps];
    if (ds.librarianFilter === 'flag') {
        gaps = gaps.filter(g => g.type === 'flag');
    } else if (ds.librarianFilter === 'activity') {
        // Activity tab: show everything, then apply activity sub-filter
        switch (ds.librarianActivityFilter) {
            case 'search':
                gaps = gaps.filter(g => g.type === 'search');
                break;
            case 'search-noresults':
                gaps = gaps.filter(g => g.type === 'search' && !g.hadResults);
                break;
            case 'search-results':
                gaps = gaps.filter(g => g.type === 'search' && g.hadResults);
                break;
            // 'all' — no additional filtering
        }
    }

    // Update sub-tab counts
    const flagCount = loreGaps.filter(g => g.type === 'flag').length;
    const activityCount = loreGaps.length;
    $subTabs.find('[data-filter="flag"] .dle-sub-tab-count').text(flagCount > 0 ? `(${flagCount})` : '');
    $subTabs.find('[data-filter="activity"] .dle-sub-tab-count').text(activityCount > 0 ? `(${activityCount})` : '');

    // Sort gaps
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

    // Empty state — show dynamic enabled/disabled status
    if (gaps.length === 0) {
        $list.empty();
        const enabled = getSettings().librarianEnabled;
        const $text = $empty.find('.dle-librarian-empty-text');
        if (!enabled) {
            $text.text('Librarian is disabled. Enable it in Settings \u2192 Features \u2192 Librarian.');
        } else if (ds.librarianFilter === 'flag') {
            $text.text('No flagged gaps yet. The AI will flag missing lore during replies.');
        } else {
            $text.text('No activity recorded yet. Tool calls will appear here after your next reply.');
        }
        $empty.addClass('dle-visible');
        return;
    }
    $empty.removeClass('dle-visible');

    // Build inbox HTML — scan tier: status, type, title, time only
    let html = '';
    for (const gap of gaps) {
        const score = computeGapScore(gap);
        const heatClass = score > 1.5 ? 'dle-gap-hot' : score > 0.6 ? 'dle-gap-warm' : '';
        // Stale: pending and older than 24 hours
        const isStale = gap.status === 'pending' && gap.timestamp && (Date.now() - gap.timestamp) > 24 * 60 * 60 * 1000;
        const staleClass = isStale ? 'dle-gap-stale' : '';
        const statusInfo = STATUS_ICONS[gap.status] || STATUS_ICONS.pending;
        const typeIcon = gap.type === 'search'
            ? '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>'
            : '<i class="fa-solid fa-flag" aria-hidden="true"></i>';

        const title = escapeHtml(gap.query || '');
        const time = relativeTime(gap.timestamp);

        const isSelected = ds.librarianSelected.has(gap.id);
        const selClass = isSelected ? 'dle-gap-selected' : '';

        html += `<div class="dle-librarian-entry ${heatClass} ${staleClass} ${selClass}" style="--dle-gap:${score.toFixed(2)}" `
            + `data-gap-id="${escapeHtml(gap.id)}" data-urgency="${gap.urgency || 'medium'}" role="listitem" `
            + `aria-label="${title}, ${statusInfo.label}, ${gap.urgency || 'medium'} urgency" tabindex="0">`;
        html += `<input type="checkbox" class="dle-gap-check" ${isSelected ? 'checked' : ''} aria-label="Select ${title}" tabindex="-1">`;
        html += `<span class="dle-gap-status ${statusInfo.cls}" title="${statusInfo.label}" aria-label="${statusInfo.label}">${statusInfo.icon}</span>`;
        html += `<span class="dle-gap-type" aria-label="${gap.type === 'search' ? 'Search' : 'Flag'}">${typeIcon}</span>`;
        html += `<span class="dle-gap-title">${title}</span>`;
        html += `<span class="dle-gap-time">${time}</span>`;
        html += `</div>`;
    }

    // Preserve focused gap id before replacing DOM
    const focusedGapId = document.activeElement?.closest?.('.dle-librarian-entry')?.dataset?.gapId;

    $list.html(html);

    // Restore focus after re-render
    if (focusedGapId) {
        const $target = $list.find(`[data-gap-id="${focusedGapId}"]`);
        if ($target.length) {
            $target[0].focus();
        } else {
            // Entry was removed — focus next available entry
            const $first = $list.find('.dle-librarian-entry').first();
            if ($first.length) $first[0].focus();
        }
    }

    // Update bulk action bar visibility
    updateBulkBar();

    // Update badge count on tab button (pending flags only — the actionable items)
    updateLibrarianBadge();
}

/**
 * Show/hide the bulk action bar based on selection state.
 */
export function updateBulkBar() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;

    const count = ds.librarianSelected.size;
    let $bar = $drawer.find('.dle-librarian-bulk-bar');

    if (count === 0) {
        $bar.remove();
        $drawer.find('.dle-librarian-list').removeClass('dle-has-selection');
        return;
    }

    $drawer.find('.dle-librarian-list').addClass('dle-has-selection');

    if (!$bar.length) {
        $bar = $(`<div class="dle-librarian-bulk-bar">
            <span class="dle-bulk-count">${count} selected</span>
            <button class="menu_button_icon dle-bulk-action" data-bulk="note" title="Note all selected"><i class="fa-solid fa-eye"></i> Note All</button>
            <button class="menu_button_icon dle-bulk-action" data-bulk="dismiss" title="Dismiss all selected"><i class="fa-solid fa-xmark"></i> Dismiss All</button>
            <button class="menu_button_icon dle-bulk-action" data-bulk="deselect" title="Clear selection"><i class="fa-solid fa-times"></i> Deselect</button>
        </div>`);
        $drawer.find('.dle-librarian-list').before($bar);
    } else {
        $bar.find('.dle-bulk-count').text(`${count} selected`);
    }
}

/**
 * Update the pending count badge on the Librarian tab button.
 * Badge color reflects highest urgency among pending items.
 */
export function updateLibrarianBadge() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;

    const pending = loreGaps.filter(g => g.status === 'pending' && g.type === 'flag');
    const pendingCount = pending.length;
    const $badge = $drawer.find('.dle-librarian-badge');
    const $tab = $drawer.find('#dle-tab-librarian');

    if (pendingCount > 0) {
        $badge.text(pendingCount).addClass('dle-visible');

        // Urgency-aware badge coloring
        const hasHigh = pending.some(g => g.urgency === 'high');
        const hasMedium = pending.some(g => g.urgency === 'medium');
        $badge.removeClass('dle-badge-urgent dle-badge-warning');
        if (hasHigh) $badge.addClass('dle-badge-urgent');
        else if (hasMedium) $badge.addClass('dle-badge-warning');
    } else {
        $badge.text('').removeClass('dle-visible dle-badge-urgent dle-badge-warning');
    }

    // Update tab aria-label with count
    $tab.attr('aria-label', pendingCount > 0
        ? `Librarian -- ${pendingCount} pending flag${pendingCount !== 1 ? 's' : ''}`
        : 'Librarian -- lore activity and writing assistant');
}
