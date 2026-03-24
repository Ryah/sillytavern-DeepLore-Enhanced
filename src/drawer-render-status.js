/**
 * DeepLore Enhanced — Drawer Render: Status Zone
 * Updates the fixed status bar and tab count badges.
 */
import { chat_metadata } from '../../../../../script.js';
import { escapeHtml } from '../../../../utils.js';
import { getSettings } from '../settings.js';
import {
    vaultIndex, lastInjectionSources, lastPipelineTrace,
    generationLock, indexing, indexEverLoaded, computeOverallStatus,
} from './state.js';
import { getCircuitState } from './obsidian-api.js';
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

    // Activity label (3-state: Choosing Lore → Generating → Idle)
    const pipelineText = generationLock ? 'Choosing Lore...' : ds.stGenerating ? 'Generating...' : 'Idle';
    $drawer.find('.dle-pipeline-label').text(pipelineText).attr('aria-label', `Status: ${pipelineText}`);
    $dot.toggleClass('dle-status-active', !!generationLock || ds.stGenerating);

    // First-run setup banner (shown when no vaults configured and setup not dismissed)
    const $setupBanner = $drawer.find('.dle-setup-banner');
    const hasEnabledVaults = (settings.vaults || []).some(v => v.enabled);
    if (!hasEnabledVaults && !settings._setupDismissed && !indexEverLoaded) {
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
    const max = budget || used || 1; // avoid division by zero
    const pct = budget ? Math.min(100, Math.round((used / max) * 100)) : 0;
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
    const tokenTitle = budget
        ? `Lore budget: ${used.toLocaleString()} of ${budget.toLocaleString()} tokens used — controls how much lore is injected`
        : settings.unlimitedBudget
            ? `Lore budget: ${used.toLocaleString()} tokens used (unlimited) — no token cap configured`
            : 'Lore budget: waiting for first generation';
    $barContainer.attr('title', tokenTitle);

    // Entries bar (same fallback as injected stat above)
    const injectedNum = lastInjectionSources?.length ?? lastPipelineTrace?.injected?.length ?? 0;
    const maxEntries = settings.unlimitedEntries ? 0 : (settings.maxEntries || 0);
    const entriesPct = maxEntries ? Math.min(100, Math.round((injectedNum / maxEntries) * 100)) : 0;
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

    // Active gating filters
    const ctx = chat_metadata?.deeplore_context;
    const $filters = $drawer.find('.dle-active-filters');
    if (ctx && (ctx.era || ctx.location || ctx.scene_type || (ctx.characters_present && ctx.characters_present.length))) {
        const chips = [];
        if (ctx.era) chips.push(escapeHtml(ctx.era));
        if (ctx.location) chips.push(escapeHtml(ctx.location));
        if (ctx.scene_type) chips.push(escapeHtml(ctx.scene_type));
        if (ctx.characters_present) {
            for (const c of ctx.characters_present) chips.push(escapeHtml(c));
        }
        $filters.html(chips.map(c => `<span class="dle-chip dle-chip-sm">${c}</span>`).join(''));
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

    // Browse tab: total vault entries
    const browseCount = vaultIndex?.length || 0;
    $drawer.find('[data-badge="browse"]').text(browseCount || '');

    // Gating tab: count of active gating fields
    const ctx = chat_metadata?.deeplore_context;
    let gatingCount = 0;
    if (ctx) {
        if (ctx.era) gatingCount++;
        if (ctx.location) gatingCount++;
        if (ctx.scene_type) gatingCount++;
        if (ctx.characters_present?.length) gatingCount += ctx.characters_present.length;
    }
    $drawer.find('[data-badge="gating"]').text(gatingCount || '');
}
