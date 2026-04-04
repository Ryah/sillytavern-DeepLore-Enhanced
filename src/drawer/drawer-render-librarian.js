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
    pending: { icon: '<i class="fa-solid fa-circle"></i>', cls: 'dle-gap-pending', label: 'Pending' },
    acknowledged: { icon: '<i class="fa-regular fa-circle"></i>', cls: 'dle-gap-acknowledged', label: 'Acknowledged' },
    in_progress: { icon: '<i class="fa-solid fa-spinner fa-spin"></i>', cls: 'dle-gap-in-progress', label: 'In progress' },
    written: { icon: '<i class="fa-solid fa-check"></i>', cls: 'dle-gap-written', label: 'Written' },
    rejected: { icon: '<i class="fa-solid fa-xmark"></i>', cls: 'dle-gap-rejected', label: 'Rejected' },
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

    // Unmet search bonus
    const unmetBonus = (gap.type === 'search' && !gap.hadResults) ? 0.2 : 0;

    return Math.min(3, (freqNorm * 0.3) + (urgency * 0.3) + (recency * 0.2) + unmetBonus);
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
    $subTabs.find('.dle-librarian-sub-tab').removeClass('active').attr('aria-selected', 'false');
    $subTabs.find(`[data-filter="${ds.librarianFilter}"]`).addClass('active').attr('aria-selected', 'true');

    // Update sort select
    $drawer.find('.dle-librarian-sort').val(ds.librarianSort);

    // Filter gaps
    let gaps = [...loreGaps];
    if (ds.librarianFilter === 'search') {
        gaps = gaps.filter(g => g.type === 'search');
    } else if (ds.librarianFilter === 'flag') {
        gaps = gaps.filter(g => g.type === 'flag');
    }

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
        $text.text(enabled
            ? 'No lore gaps recorded yet. Gaps will appear here after your next generation.'
            : 'Librarian is disabled. Enable it in Settings \u2192 Features \u2192 Librarian.');
        $empty.addClass('dle-visible');
        return;
    }
    $empty.removeClass('dle-visible');

    // Build inbox HTML
    let html = '';
    for (const gap of gaps) {
        const score = computeGapScore(gap);
        const heatClass = score > 1.2 ? 'dle-gap-hot' : score > 0.5 ? 'dle-gap-warm' : '';
        const statusInfo = STATUS_ICONS[gap.status] || STATUS_ICONS.pending;
        const typeIcon = gap.type === 'search'
            ? '<i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>'
            : '<i class="fa-solid fa-flag" aria-hidden="true"></i>';

        const title = escapeHtml(gap.query || '');
        const reason = escapeHtml((gap.reason || '').length > 120 ? gap.reason.slice(0, 117) + '...' : gap.reason || '');
        const time = relativeTime(gap.timestamp);
        const freqBadge = (gap.frequency || 1) > 1
            ? `<span class="dle-gap-freq" title="Flagged ${gap.frequency} times" aria-label="Frequency: ${gap.frequency}">${gap.frequency}x</span>`
            : '';
        const urgencyBadge = gap.urgency === 'high'
            ? '<span class="dle-gap-urgency-high" aria-label="High urgency">!</span>'
            : '';
        const resultInfo = gap.type === 'search' && gap.hadResults === false
            ? '<span class="dle-gap-no-results" title="No vault entries found" aria-label="No results">0 results</span>'
            : '';

        html += `<div class="dle-librarian-entry ${heatClass}" style="--dle-gap:${score.toFixed(2)}" `
            + `data-gap-id="${escapeHtml(gap.id)}" role="listitem" `
            + `aria-label="${title}, ${statusInfo.label}, ${gap.urgency || 'medium'} urgency" tabindex="0">`;
        html += `<span class="dle-gap-status ${statusInfo.cls}" title="${statusInfo.label}" aria-label="${statusInfo.label}">${statusInfo.icon}</span>`;
        html += `<span class="dle-gap-type" aria-label="${gap.type === 'search' ? 'Search' : 'Flag'}">${typeIcon}</span>`;
        html += `<span class="dle-gap-title">${title}</span>`;
        html += `<span class="dle-gap-meta">`;
        html += `<span class="dle-gap-reason" title="${escapeHtml(gap.reason || '')}">${reason}</span>`;
        html += `<span class="dle-gap-time">${time}</span>`;
        html += freqBadge;
        html += urgencyBadge;
        html += resultInfo;
        html += `</span>`;
        html += `</div>`;
    }

    $list.html(html);

    // Update badge count on tab button (pending items only)
    updateLibrarianBadge();
}

/**
 * Update the pending count badge on the Librarian tab button.
 */
export function updateLibrarianBadge() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;

    const pendingCount = loreGaps.filter(g => g.status === 'pending').length;
    const $badge = $drawer.find('.dle-librarian-badge');
    if (pendingCount > 0) {
        $badge.text(pendingCount).addClass('dle-visible');
    } else {
        $badge.text('').removeClass('dle-visible');
    }
}
