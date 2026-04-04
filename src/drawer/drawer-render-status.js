/**
 * DeepLore Enhanced — Drawer Render: Status Zone
 * Updates the fixed status bar and tab count badges.
 */
import { chat_metadata } from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { getSettings } from '../../settings.js';
import {
    vaultIndex, lastInjectionSources, lastPipelineTrace,
    generationLock, indexing, indexEverLoaded, computeOverallStatus,
    vaultAvgTokens,
} from '../state.js';
import { getCircuitState } from '../vault/obsidian-api.js';
import { ds, MODE_LABELS, MODE_DESCRIPTIONS, STATUS_CLASSES, STATUS_DESCRIPTIONS } from './drawer-state.js';

// ════════════════════════════════════════════════════════════════════════════
// Status Zone
// ════════════════════════════════════════════════════════════════════════════

/**
 * Update the fixed status zone with live data.
 */
export function renderStatusZone() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const settings = getSettings();

    // Status dot (pass Obsidian circuit state for real-time accuracy between index builds)
    const status = computeOverallStatus(getCircuitState());
    const $dot = $drawer.find('.dle-status-dot');
    $dot.removeClass('dle-status-ok dle-status-degraded dle-status-limited dle-status-offline');
    $dot.addClass(STATUS_CLASSES[status] || 'dle-status-offline');
    const statusDesc = STATUS_DESCRIPTIONS[status] || status;
    $dot.attr('title', `System status: ${status} — ${statusDesc}`);
    $dot.attr('aria-label', `System status: ${status} — ${statusDesc}`);

    // Accessibility: shape/icon indicator inside the dot (not color-only)
    const statusIcons = {
        ok: '<i class="fa-solid fa-check" aria-hidden="true"></i>',
        degraded: '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>',
        limited: '<i class="fa-solid fa-arrow-down" aria-hidden="true"></i>',
        offline: '<i class="fa-solid fa-xmark" aria-hidden="true"></i>',
    };
    $dot.html(statusIcons[status] || statusIcons.offline);

    // Activity label (4-state: Indexing → Choosing Lore → Generating → Idle)
    const pipelineText = indexing ? 'Indexing...' : generationLock ? 'Choosing Lore...' : ds.stGenerating ? 'Generating...' : 'Idle';
    $drawer.find('.dle-pipeline-label').text(pipelineText).attr('aria-label', `Status: ${pipelineText}`);
    $dot.toggleClass('dle-status-active', !!indexing || !!generationLock || ds.stGenerating);

    // First-run setup banner (shown when no vaults configured and setup not dismissed)
    const $setupBanner = $drawer.find('.dle-setup-banner');
    const hasEnabledVaults = (settings.vaults || []).some(v => v.enabled);
    if (!hasEnabledVaults && !settings._wizardCompleted && !indexEverLoaded) {
        if (!$setupBanner.length) {
            const banner = `<div class="dle-setup-banner" role="alert" style="padding: var(--dle-space-2) var(--dle-space-3); background: color-mix(in srgb, var(--dle-info) 15%, transparent); border-radius: 4px; margin: var(--dle-space-2) 0; display: flex; align-items: center; gap: var(--dle-space-2); font-size: var(--dle-text-sm);">
                <i class="fa-solid fa-wand-magic-sparkles" style="color: var(--dle-info);"></i>
                <span>New to DeepLore?</span>
                <button class="dle-setup-banner-btn menu_button" style="padding: 4px 12px; min-height: 28px; font-size: var(--dle-text-xs);" title="Run the setup wizard">Run Setup</button>
                <button class="dle-setup-banner-dismiss" style="margin-left: auto; background: none; border: none; cursor: pointer; opacity: 0.5; padding: 2px;" title="Dismiss" aria-label="Dismiss setup banner"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
            $drawer.find('.dle-zone-status').after(banner);
        }
    } else {
        $setupBanner.remove();
    }

    // Cold start: show loading shimmer instead of "0" stats before first index
    if (!indexEverLoaded && vaultIndex.length === 0 && !indexing) {
        $drawer.find('[data-stat="entries"]').html('<span class="dle-shimmer">…</span>');
        $drawer.find('[data-stat="tokens"]').html('<span class="dle-shimmer">…</span>');
        $drawer.find('.dle-pipeline-label').text('Connecting to Obsidian…');
    }

    // Stats (with flash animation on value change)
    const entryCount = indexing ? '…' : vaultIndex.length;
    // Use lastPipelineTrace as fallback — lastInjectionSources gets cleared by CHARACTER_MESSAGE_RENDERED
    // but lastPipelineTrace persists until CHAT_CHANGED
    const $entries = $drawer.find('[data-stat="entries"]');
    if ($entries.text() !== String(entryCount)) {
        $entries.text(entryCount);
        const $eStat = $entries.closest('.dle-stat');
        $eStat.removeClass('dle-stat-changed');
        $eStat[0]?.offsetWidth; // force reflow to restart animation
        $eStat.addClass('dle-stat-changed').off('animationend').one('animationend', function () { $(this).removeClass('dle-stat-changed'); });
    }
    const vaultCount = settings.vaults?.filter(v => v.enabled !== false).length || 1;
    const entryTitle = indexing
        ? 'Loading lore entries...'
        : `${entryCount} lore entries loaded from ${vaultCount === 1 ? 'your Obsidian vault' : `${vaultCount} Obsidian vaults`}`;
    $entries.closest('.dle-stat').attr('title', entryTitle).attr('aria-label', entryTitle);

    const mode = settings.aiSearchEnabled !== false
        ? (MODE_LABELS[settings.aiSearchMode] || settings.aiSearchMode || '—')
        : 'Keywords';
    const modeKey = settings.aiSearchEnabled !== false ? (settings.aiSearchMode || 'two-stage') : 'keywords-only';
    const modeDesc = MODE_DESCRIPTIONS[modeKey] || mode;
    const modeTitle = `Search mode: ${mode} — ${modeDesc}`;
    $drawer.find('[data-stat="mode"]').text(mode).attr('title', modeTitle).attr('aria-label', modeTitle);

    // Token bar
    const trace = lastPipelineTrace;
    const budget = settings.unlimitedBudget ? 0 : (settings.maxTokensBudget || 0);
    const used = trace?.totalTokens || 0;
    // When unlimited: show proportion of total vault being injected (used / total vault tokens)
    const totalVaultTokens = vaultIndex.length * (vaultAvgTokens || 200);
    const pct = budget
        ? Math.min(100, Math.round((used / (budget || 1)) * 100))
        : (settings.unlimitedBudget && used > 0 && totalVaultTokens > 0)
            ? Math.min(100, Math.round((used / totalVaultTokens) * 100)) || 1 // minimum 1% so bar is visible
            : 0;
    const $barContainer = $drawer.find('.dle-token-bar-container');
    $barContainer.attr('aria-valuenow', used).attr('aria-valuemax', budget);
    $barContainer.removeClass('dle-budget-high dle-budget-critical');
    if (pct >= 95) $barContainer.addClass('dle-budget-critical');
    else if (pct >= 80) $barContainer.addClass('dle-budget-high');
    $drawer.find('.dle-token-bar').css('width', `${pct}%`);
    const budgetLabel = budget
        ? `Lore | ${used.toLocaleString()} / ${budget.toLocaleString()}`
        : settings.unlimitedBudget
            ? `Lore | ${used.toLocaleString()} / \u221E`
            : 'Lore | waiting';
    $drawer.find('.dle-token-bar-label').text(budgetLabel);
    // Build budget breakdown from trace for tooltip
    let breakdownParts = [];
    if (trace?.injected?.length) {
        const src = lastInjectionSources || [];
        const srcMap = new Map(src.map(s => [s.title, (s.matchedBy || '').toLowerCase()]));
        let constTokens = 0, keywordTokens = 0, aiTokens = 0, pinTokens = 0, otherTokens = 0;
        for (const e of trace.injected) {
            const reason = srcMap.get(e.title) || '';
            if (reason.includes('constant') || reason.includes('always')) constTokens += e.tokens;
            else if (reason.startsWith('ai:') || reason.includes('ai selection')) aiTokens += e.tokens;
            else if (reason.includes('pinned')) pinTokens += e.tokens;
            else if (reason.includes('fuzzy') || reason.includes('keyword') || reason.includes('(')) keywordTokens += e.tokens;
            else otherTokens += e.tokens;
        }
        if (constTokens) breakdownParts.push(`Constants: ${constTokens}`);
        if (keywordTokens) breakdownParts.push(`Keyword: ${keywordTokens}`);
        if (aiTokens) breakdownParts.push(`AI: ${aiTokens}`);
        if (pinTokens) breakdownParts.push(`Pinned: ${pinTokens}`);
        if (otherTokens) breakdownParts.push(`Other: ${otherTokens}`);
    }
    const breakdownStr = breakdownParts.length ? `\n${breakdownParts.join(' | ')}` : '';
    const tokenTitle = budget
        ? `Lore budget: ${used.toLocaleString()} of ${budget.toLocaleString()} tokens used${breakdownStr}`
        : settings.unlimitedBudget
            ? `Lore budget: ${used.toLocaleString()} tokens used (unlimited)${breakdownStr}`
            : 'Lore budget: waiting for first generation';
    $barContainer.attr('title', tokenTitle);

    // Entries bar (same fallback as injected stat above)
    const injectedNum = lastInjectionSources?.length ?? lastPipelineTrace?.injected?.length ?? 0;
    const maxEntries = settings.unlimitedEntries ? 0 : (settings.maxEntries || 0);
    // When unlimited: show proportion of total vault entries being injected
    const entriesPct = maxEntries
        ? Math.min(100, Math.round((injectedNum / maxEntries) * 100))
        : (settings.unlimitedEntries && injectedNum > 0 && vaultIndex.length > 0)
            ? Math.min(100, Math.round((injectedNum / vaultIndex.length) * 100)) || 1
            : 0;
    const $entriesBarContainer = $drawer.find('.dle-entries-bar-container');
    $entriesBarContainer.attr('aria-valuenow', injectedNum).attr('aria-valuemax', maxEntries);
    $entriesBarContainer.removeClass('dle-budget-high dle-budget-critical');
    if (entriesPct >= 95) $entriesBarContainer.addClass('dle-budget-critical');
    else if (entriesPct >= 80) $entriesBarContainer.addClass('dle-budget-high');
    $drawer.find('.dle-entries-bar').css('width', `${entriesPct}%`);
    const entriesLabel = maxEntries
        ? `Entries | ${injectedNum} / ${maxEntries}`
        : settings.unlimitedEntries
            ? `Entries | ${injectedNum} / \u221E`
            : 'Entries | waiting';
    $drawer.find('.dle-entries-bar-label').text(entriesLabel);
    const entriesTitle = maxEntries
        ? `${injectedNum} of ${maxEntries} entries injected — limits how many lore entries are included per message`
        : settings.unlimitedEntries
            ? `${injectedNum} entries injected (unlimited) — no entry count cap configured`
            : 'Entry limit: waiting for first generation';
    $entriesBarContainer.attr('title', entriesTitle);

    // Active gating filters (driven by field definitions)
    const ctx = chat_metadata?.deeplore_context;
    const $filters = $drawer.find('.dle-active-filters');
    const chips = [];
    // Folder filter badge
    const activeFolders = chat_metadata?.deeplore_folder_filter || [];
    if (activeFolders.length > 0) {
        const folderLabel = activeFolders.length === 1 ? activeFolders[0] : `${activeFolders.length} folders`;
        chips.push(`<span class="dle-chip dle-chip-sm dle-folder-badge-chip" title="Folder filter active: ${escapeHtml(activeFolders.join(', '))}" data-action="goto-gating"><i class="fa-solid fa-folder" aria-hidden="true" style="margin-right:3px;font-size:0.8em;"></i>${escapeHtml(folderLabel)}</span>`);
    }
    if (ctx) {
        for (const [key, val] of Object.entries(ctx)) {
            if (val == null || val === '') continue;
            if (Array.isArray(val)) {
                for (const v of val) chips.push(`<span class="dle-chip dle-chip-sm">${escapeHtml(v)}</span>`);
            } else {
                chips.push(`<span class="dle-chip dle-chip-sm">${escapeHtml(val)}</span>`);
            }
        }
    }
    if (chips.length > 0) {
        $filters.html(chips.join(''));
        $filters.show();
    } else {
        $filters.empty().hide();
    }

    updateTabBadges();
}

/**
 * Update tab count badges (cheap — just sets textContent on 3 spans).
 */
export function updateTabBadges() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;

    // Why? tab: injected entry count (fallback to trace — sources get cleared after message render)
    const injCount = lastInjectionSources?.length ?? lastPipelineTrace?.injected?.length ?? 0;
    $drawer.find('[data-badge="injection"]').text(injCount || '');

    // Browse tab: show filtered/total count when filters active, otherwise just total
    const browseTotal = vaultIndex?.length || 0;
    const hasActiveFilters = ds.browseQuery || ds.browseStatusFilter !== 'all' || ds.browseTagFilter || ds.browseFolderFilter || Object.keys(ds.browseCustomFieldFilters).length > 0;
    const browseLabel = hasActiveFilters && ds.browseFilteredEntries.length !== browseTotal
        ? `${ds.browseFilteredEntries.length}/${browseTotal}`
        : (browseTotal || '');
    $drawer.find('[data-badge="browse"]').text(browseLabel);

    // Gating tab: count of active gating fields + folder filter (dynamic)
    const gatingCtx = chat_metadata?.deeplore_context;
    let gatingCount = 0;
    if (gatingCtx) {
        for (const val of Object.values(gatingCtx)) {
            if (val == null || val === '') continue;
            if (Array.isArray(val)) gatingCount += val.length;
            else gatingCount++;
        }
    }
    const gatingFolders = chat_metadata?.deeplore_folder_filter;
    if (gatingFolders?.length) gatingCount += gatingFolders.length;
    $drawer.find('[data-badge="gating"]').text(gatingCount || '');
}
