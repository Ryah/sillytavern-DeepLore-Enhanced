/**
 * DeepLore Enhanced — Drawer Render: Footer Zone
 * Context bar, health icons, and AI stats.
 */
import { amount_gen } from '../../../../../../script.js';
import { getSettings } from '../../settings.js';
import {
    vaultIndex, lastPipelineTrace, librarianChatStats,
    aiSearchStats, isAiCircuitOpen, indexEverLoaded, indexTimestamp, lastHealthResult,
} from '../state.js';
import { getCircuitState } from '../vault/obsidian-api.js';
import { ds, formatTokensCompact, activityLog } from './drawer-state.js';

// ════════════════════════════════════════════════════════════════════════════
// Footer Zone — Health Icons + AI Stats + Context Bar
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render the footer zone: context bar, health icons, AI stats.
 */
export function renderFooter() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const $footer = $drawer.find('#dle-drawer-footer');
    if (!$footer.length) return;

    // ── Context window bar ──
    const $barContainer = $footer.find('.dle-context-bar-container');

    // Hide context bar entirely on non-OAI backends where prompt token tracking is unavailable
    if (!ds.contextBarAvailable) {
        $barContainer.hide();
    } else {
        $barContainer.show();
    }

    const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
    // Prefer chatCompletionSettings (respects unlocked context) over maxContext (base slider)
    const maxContext = ctx?.chatCompletionSettings?.openai_max_context || ctx?.maxContext || 0;
    const responseTokens = ctx?.chatCompletionSettings?.openai_max_tokens || amount_gen || 0;
    const contextUsed = ds.contextTokens || 0;

    if (maxContext > 0) {
        const contextPct = Math.min(100, (contextUsed / maxContext) * 100);
        const responsePct = Math.min(100 - contextPct, (responseTokens / maxContext) * 100);

        $footer.find('.dle-context-bar-context').css('width', `${contextPct}%`);
        $footer.find('.dle-context-bar-response').css({
            left: `${contextPct}%`,
            width: `${responsePct}%`,
        });

        const libExtra = librarianChatStats.estimatedExtraTokens || 0;
        const totalUsed = contextUsed + libExtra;
        const label = totalUsed
            ? `${totalUsed.toLocaleString()} / ${maxContext.toLocaleString()}`
            : `— / ${maxContext.toLocaleString()}`;
        $footer.find('.dle-context-bar-label').text(label);

        const tooltipParts = [`${contextUsed.toLocaleString()} prompt tokens`];
        if (libExtra > 0) tooltipParts.push(`${libExtra.toLocaleString()} librarian tokens`);
        tooltipParts.push(`${responseTokens.toLocaleString()} response reserve`);
        tooltipParts.push(`${maxContext.toLocaleString()} max context`);
        const contextTitle = tooltipParts.join(' · ');
        $barContainer.attr('aria-valuenow', totalUsed + responseTokens).attr('aria-valuemax', maxContext);
        $barContainer.attr('title', contextTitle);
    } else {
        $footer.find('.dle-context-bar-context').css('width', '0%');
        $footer.find('.dle-context-bar-response').css({ left: '0%', width: '0%' });
        $footer.find('.dle-context-bar-label').text('Context data unavailable \u2014 waiting for first generation');
        $barContainer.attr('aria-valuenow', 0).attr('aria-valuemax', 0);
        $barContainer.attr('title', 'Context data unavailable \u2014 waiting for first generation');
    }

    // ── Activity feed ──
    const $activityFeed = $footer.find('.dle-activity-feed');
    $activityFeed.attr('role', 'log').attr('aria-live', 'polite');
    if ($activityFeed.length && activityLog.length > 0) {
        let feedHtml = '';
        for (const a of activityLog) {
            const time = new Date(a.ts);
            const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const isoTime = time.toISOString();
            feedHtml += `<div class="dle-activity-row">`;
            feedHtml += `<span class="dle-activity-time" title="${isoTime}">${timeStr}</span>`;
            feedHtml += `<span class="dle-activity-mode">${a.mode}</span>`;
            let detail = `${a.injected} entr${a.injected === 1 ? 'y' : 'ies'}, ${formatTokensCompact(a.tokens)} tok`;
            if (a.folderFilter?.length) detail += ` [${a.folderFilter.length} folder${a.folderFilter.length !== 1 ? 's' : ''}]`;
            feedHtml += `<span class="dle-activity-detail">${detail}</span>`;
            feedHtml += `</div>`;
        }
        $activityFeed.html(feedHtml);
    }

    // ── Health icons ──
    const settings = getSettings();

    // Vault health
    const $vault = $footer.find('[data-health="vault"]');
    if (lastHealthResult) {
        const { errors, warnings } = lastHealthResult;
        if (errors > 0) {
            $vault.removeClass('dle-health-ok dle-health-warn').addClass('dle-health-error');
            $vault.attr('aria-label', `Vault health: ${errors} errors — click to see details`).attr('title', `Vault health: ${errors} errors, ${warnings} warnings — click to run health check`);
        } else if (warnings > 3) {
            $vault.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
            $vault.attr('aria-label', `Vault health: ${warnings} warnings — click to see details`).attr('title', `Vault health: ${warnings} warnings — click to run health check`);
        } else {
            $vault.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
            $vault.attr('aria-label', `Vault health: OK — click to run a full health check`).attr('title', `Vault health: OK${warnings ? ` (${warnings} minor warnings)` : ''} — click to run health check`);
        }
    } else {
        $vault.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $vault.attr('aria-label', 'Vault health: not checked yet — click to run health check').attr('title', 'Vault health: not checked yet — click to run health check');
    }

    // Connection (Obsidian circuit breaker — aggregate)
    const $conn = $footer.find('[data-health="connection"]');
    const circuit = getCircuitState();
    if (circuit.state === 'closed') {
        $conn.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
        $conn.attr('aria-label', 'Obsidian: connected — click for full status').attr('title', 'Obsidian: connected — click for full status');
    } else if (circuit.state === 'half-open') {
        $conn.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
        $conn.attr('aria-label', 'Obsidian: recovering — probing vault').attr('title', 'Obsidian: recovering — click to retry');
    } else {
        $conn.removeClass('dle-health-ok dle-health-warn').addClass('dle-health-error');
        $conn.attr('aria-label', `Obsidian: unreachable (${circuit.failures} failures) — click to retry`).attr('title', `Obsidian: unreachable (${circuit.failures} failures) — click to retry`);
    }

    // Pipeline
    const $pipe = $footer.find('[data-health="pipeline"]');
    if (lastPipelineTrace) {
        const entryCount = lastPipelineTrace.injected?.length || 0;
        const hasResults = entryCount > 0 || lastPipelineTrace.totalTokens > 0;
        if (hasResults) {
            $pipe.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
            $pipe.attr('aria-label', `Lore selection: last run found ${entryCount} entries — click for details`).attr('title', `Lore selection: last run found ${entryCount} entries — click for details`);
        } else {
            $pipe.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
            $pipe.attr('aria-label', 'Lore selection: last run produced no results — click for details').attr('title', 'Lore selection: last run produced no results — click for details');
        }
    } else {
        $pipe.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $pipe.attr('aria-label', 'Lore selection: no runs yet').attr('title', 'Lore selection: no runs yet — send a message to trigger');
    }

    // Cache
    const $cache = $footer.find('[data-health="cache"]');
    if (indexEverLoaded && indexTimestamp) {
        const ageMs = Date.now() - indexTimestamp;
        const cacheTTL = (settings.cacheTTL || 300) * 1000;
        const ageSecs = Math.round(ageMs / 1000);
        if (ageMs < cacheTTL) {
            const cacheLabel = `Cache: fresh (${ageSecs} seconds old, ${vaultIndex.length} entries)`;
            $cache.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
            $cache.attr('aria-label', cacheLabel).attr('title', cacheLabel);
        } else {
            const cacheLabel = `Cache: stale (${ageSecs} seconds old, ${vaultIndex.length} entries) — click to refresh`;
            $cache.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
            $cache.attr('aria-label', cacheLabel).attr('title', cacheLabel);
        }
    } else if (vaultIndex.length > 0) {
        const cacheLabel = `Cache: loaded from storage (${vaultIndex.length} entries, not yet refreshed)`;
        $cache.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
        $cache.attr('aria-label', cacheLabel).attr('title', cacheLabel);
    } else {
        $cache.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $cache.attr('aria-label', 'Cache: empty — no index loaded').attr('title', 'Cache: empty — no index loaded');
    }

    // AI service
    const $ai = $footer.find('[data-health="ai"]');
    if (isAiCircuitOpen()) {
        $ai.removeClass('dle-health-ok dle-health-warn').addClass('dle-health-error');
        $ai.attr('aria-label', 'AI search: temporarily paused after repeated failures').attr('title', 'AI search: temporarily paused after repeated failures — will retry automatically');
    } else if (aiSearchStats.calls > 0) {
        $ai.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
        $ai.attr('aria-label', `AI search: OK (${aiSearchStats.calls} calls this session) — click for details`).attr('title', `AI search: OK (${aiSearchStats.calls} calls this session) — click for details`);
    } else if (settings.aiSearchEnabled !== false) {
        $ai.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
        $ai.attr('aria-label', 'AI search: enabled but no calls yet').attr('title', 'AI search: enabled but no calls yet — will activate on first generation');
    } else {
        $ai.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $ai.attr('aria-label', 'AI search: disabled').attr('title', 'AI search: disabled — enable in DeepLore settings');
    }

    // ── AI stats ──
    $footer.find('[data-ai-stat="calls"]').text(`${aiSearchStats.calls} calls`);
    $footer.find('[data-ai-stat="cached"]').text(`${aiSearchStats.cachedHits} cached`);
    const totalTok = aiSearchStats.totalInputTokens + aiSearchStats.totalOutputTokens;
    $footer.find('[data-ai-stat="tokens"]').text(`${formatTokensCompact(totalTok)} tokens`);
}
