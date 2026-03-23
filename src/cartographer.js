/**
 * DeepLore Enhanced — Context Cartographer
 */
import { escapeHtml } from '../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { chat } from '../../../../../script.js';
import { simpleHash } from '../core/utils.js';
import { getSettings } from '../settings.js';
import { vaultIndex, vaultAvgTokens, previousSources, setPreviousSources, lastPipelineTrace, chatInjectionCounts, trackerKey } from './state.js';
import { diagnoseEntry } from './diagnostics.js';
import { STAGE_COLORS, computeSourcesDiff, categorizeRejections, resolveEntryVault, parseMatchReason, tokenBarColor, formatRelativeTime } from './helpers.js';
// Re-export from helpers.js (moved there for testability in Node.js)
export { buildObsidianURI } from './helpers.js';

/**
 * Reset cartographer state on chat change.
 * Clears previousSources so stale diffs don't carry across chats.
 */
export function resetCartographer() {
    setPreviousSources(null);
}

/**
 * Inject a "Lore Sources" button into a message's action bar.
 * @param {number} messageId - Index in the chat array
 */
export function injectSourcesButton(messageId) {
    const mesEl = $(`.mes[mesid="${messageId}"]`);
    if (mesEl.length === 0) return;
    if (mesEl.find('.mes_deeplore_sources').length > 0) return;

    const btn = $('<div title="Why? — See which lore was injected" class="mes_button mes_deeplore_sources fa-solid fa-book-open"></div>');
    mesEl.find('.extraMesButtons').prepend(btn);
}

/**
 * Format a parsed match reason as a parenthetical label for the popup.
 * e.g. "(Constant)", "(AI)", "(Keyword: Eris)", "(Pinned)", "(Bootstrap)"
 */
function formatMatchReason(matchedBy) {
    if (!matchedBy) return '';
    const { type, keyword } = parseMatchReason(matchedBy);
    const labels = {
        constant: '(Constant)', pinned: '(Pinned)', bootstrap: '(Bootstrap)',
        seed: '(Seed)', ai: '(AI)', unknown: '',
    };
    if (type === 'keyword_ai' || type === 'keyword') return `(Keyword: ${escapeHtml(keyword)})`;
    return labels[type] || '';
}

/**
 * Show an enhanced popup with lore source details for a message.
 * @param {Array<{title: string, filename: string, matchedBy: string, priority: number, tokens: number}>} sources
 */
export function showSourcesPopup(sources) {
    const settings = getSettings();
    const totalTokens = sources.reduce((sum, s) => sum + s.tokens, 0);
    const maxTokens = Math.max(...sources.map(s => s.tokens), 1);
    const avgTokens = vaultAvgTokens || 0;
    const positionLabels = { 0: 'After Main Prompt', 1: 'In-chat', 2: 'Before Main Prompt' };

    // Group sources by injection position
    const entryByTitle = new Map(vaultIndex.map(e => [e.title, e]));
    const groups = new Map();
    for (const src of sources) {
        const entry = entryByTitle.get(src.title);
        const pos = entry?.injectionPosition ?? settings.injectionPosition;
        const depth = entry?.injectionDepth ?? settings.injectionDepth;
        const posKey = pos === 1 ? `In-chat @depth ${depth}` : (positionLabels[pos] || 'Unknown');
        if (!groups.has(posKey)) groups.set(posKey, []);
        groups.get(posKey).push({ ...src, entry });
    }

    // Diff with reasons via shared data layer
    const diff = computeSourcesDiff(sources, previousSources);
    setPreviousSources(sources.map(s => ({ title: s.title, tokens: s.tokens, matchedBy: s.matchedBy })));

    let html = `<div class="dle-popup">`;
    html += `<h3>Why? — Injected Sources (${sources.length} entries, ~${totalTokens} tokens)</h3>`;

    // Diff display with reasons
    if (diff.added.length > 0 || diff.removed.length > 0) {
        html += `<div class="dle-card dle-text-sm">`;
        if (diff.added.length > 0) {
            const addedLabels = diff.added.map(s => `${escapeHtml(s.title)} ${formatMatchReason(s.matchedBy)}`);
            html += `<span class="dle-success">+${diff.added.length} new:</span> <span class="dle-muted">${addedLabels.join(', ')}</span><br>`;
        }
        if (diff.removed.length > 0) {
            const removedLabels = diff.removed.map(s => `${escapeHtml(s.title)} (${s.removalReason})`);
            html += `<span class="dle-error">-${diff.removed.length} removed:</span> <span class="dle-muted">${removedLabels.join(', ')}</span>`;
        }
        html += `</div>`;
    }

    for (const [posLabel, groupSources] of groups) {
        // 7.4: Sort by priority ascending (lower number = higher priority)
        groupSources.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));

        const groupTokens = groupSources.reduce((sum, s) => sum + s.tokens, 0);
        html += `<h4 style="margin: var(--dle-space-3) 0 var(--dle-space-1);">${escapeHtml(posLabel)} (~${groupTokens} tokens)</h4>`;

        for (const src of groupSources) {
            const pct = Math.max(2, Math.round((src.tokens / maxTokens) * 100));
            // 7.14: Color bar and token text by vault-relative size
            const barColor = tokenBarColor(src.tokens, avgTokens);
            const { uri } = resolveEntryVault(src, settings.vaults);
            const titleHtml = uri
                ? `<a href="${escapeHtml(uri)}" target="_blank" style="color: var(--SmartThemeQuoteColor, #aac8ff); text-decoration: none;">${escapeHtml(src.title)}</a>`
                : escapeHtml(src.title);
            const entryId = simpleHash(src.filename + '_ctx');
            const rawPreview = src.entry ? src.entry.content.substring(0, 300) + (src.entry.content.length > 300 ? '...' : '') : '';

            html += `<div class="dle-card">`;
            html += `<div class="dle_ctx_toggle dle-card-header" data-target="dle_ctx_${entryId}">`;
            html += `<span><strong>${titleHtml}</strong> <small class="dle-faint">pri ${src.priority}</small></span>`;
            html += `<small style="color: ${barColor};">~${src.tokens} tok</small>`;
            html += `</div>`;
            html += `<div class="dle-token-bar">`;
            html += `<div class="dle-token-bar-fill" style="background: ${barColor}; width: ${pct}%;"></div>`;
            html += `</div>`;
            const vaultLabel = src.vaultSource && (settings.vaults || []).length > 1 ? ` · <em>${escapeHtml(src.vaultSource)}</em>` : '';
            html += `<small class="dle-muted">${escapeHtml(src.matchedBy)}${vaultLabel}</small>`;

            // Per-entry injection stats (chat + all-time)
            const entryKey = src.entry ? trackerKey(src.entry) : `${src.vaultSource || ''}:${src.title}`;
            const chatCount = chatInjectionCounts.get(entryKey) || 0;
            const allTime = settings.analyticsData?.[entryKey];
            const statParts = [];
            if (chatCount > 0) statParts.push(`This chat: ${chatCount}×`);
            if (allTime) {
                statParts.push(`All-time: ${allTime.injected || 0} injected / ${allTime.matched || 0} matched`);
                const lastUsed = formatRelativeTime(allTime.lastTriggered);
                if (lastUsed) statParts.push(`Last: ${lastUsed}`);
            }
            if (statParts.length > 0) {
                html += `<div class="dle-carto-stats dle-text-xs">${statParts.join(' · ')}</div>`;
            }

            if (src.entry) {
                // Metadata line
                const meta = [];
                if (src.entry.keys?.length > 0) meta.push(`Keys: ${src.entry.keys.slice(0, 5).join(', ')}${src.entry.keys.length > 5 ? '...' : ''}`);
                if (src.entry.requires?.length > 0) meta.push(`Requires: ${src.entry.requires.join(', ')}`);
                if (src.entry.era?.length > 0) meta.push(`Era: ${src.entry.era.join(', ')}`);
                if (src.entry.location?.length > 0) meta.push(`Location: ${src.entry.location.join(', ')}`);
                if (src.entry.resolvedLinks?.length > 0) meta.push(`Links: ${src.entry.resolvedLinks.slice(0, 5).join(', ')}`);

                // Highlight matched keywords in content preview
                // Run regex on raw text BEFORE escaping to avoid matching inside HTML entities
                let highlighted = rawPreview;
                if (src.matchedBy && !src.matchedBy.startsWith('(')) {
                    const keyword = src.matchedBy.split('→')[0].trim();
                    if (keyword.length >= 2) {
                        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        // Use a placeholder that won't be escaped, then swap after escapeHtml
                        highlighted = highlighted.replace(new RegExp(`(${escaped})`, 'gi'), '\x00MARK_START\x00$1\x00MARK_END\x00');
                    }
                }
                highlighted = escapeHtml(highlighted)
                    .replace(/\x00MARK_START\x00/g, '<mark class="dle-highlight">')
                    .replace(/\x00MARK_END\x00/g, '</mark>');

                html += `<div id="dle_ctx_${entryId}" class="dle-ctx-detail">`;
                if (meta.length > 0) {
                    html += `<div class="dle-text-xs dle-faint" style="margin-bottom: var(--dle-space-1);">${meta.map(m => escapeHtml(m)).join(' · ')}</div>`;
                }
                html += `<div class="dle-preview">${highlighted}</div>`;
                html += `</div>`;
            }
            html += `</div>`;
        }
    }

    // --- Rejected Entries Section (staged breakdown) ---
    if (lastPipelineTrace && chat && chat.length > 0) {
        const injectedTitles = new Set(sources.map(s => s.title));
        const rejectedGroups = categorizeRejections(lastPipelineTrace, injectedTitles);

        if (rejectedGroups.length > 0) {
            const totalRejected = rejectedGroups.reduce((sum, g) => sum + g.entries.length, 0);
            html += `<hr style="margin: var(--dle-space-3) 0; border-color: var(--dle-border);">`;
            html += `<h4 style="margin: var(--dle-space-2) 0 var(--dle-space-1); color: var(--dle-text-muted);">Not Injected (${totalRejected} entries)</h4>`;

            for (const group of rejectedGroups) {
                const groupId = simpleHash(`rejected_${group.label}`);
                html += `<div class="dle-card" style="opacity: 0.8;">`;
                html += `<div class="dle_ctx_toggle dle-card-header" data-target="dle_rej_${groupId}">`;
                html += `<span><i class="fa-solid ${group.icon}" style="margin-right: 6px; color: var(--dle-text-muted);"></i><strong>${escapeHtml(group.label)}</strong> <small class="dle-faint">(${group.entries.length})</small></span>`;
                html += `<small class="dle-faint">click to expand</small>`;
                html += `</div>`;
                html += `<div id="dle_rej_${groupId}" class="dle-ctx-detail">`;

                for (const e of group.entries) {
                    const entry = entryByTitle.get(e.title);
                    const whynotId = simpleHash(`whynot_${e.title}`);
                    html += `<div style="padding: 4px 0; border-bottom: 1px solid var(--dle-border);">`;
                    html += `<span class="dle-text-sm">${escapeHtml(e.title)}</span>`;
                    if (entry && !entry.constant) {
                        html += ` <button class="menu_button dle_carto_whynot_btn dle-text-xs" data-title="${escapeHtml(e.title)}" data-container="dle_whynot_carto_${whynotId}" style="padding: 1px 6px; margin-left: 6px;">Why?</button>`;
                        html += `<div id="dle_whynot_carto_${whynotId}"></div>`;
                    }
                    // All-time stats for rejected entries
                    const rejKey = entry ? trackerKey(entry) : `${e.vaultSource || ''}:${e.title}`;
                    const rejAllTime = settings.analyticsData?.[rejKey];
                    if (rejAllTime) {
                        const lastUsed = formatRelativeTime(rejAllTime.lastTriggered);
                        html += `<div class="dle-carto-stats dle-text-xs">${rejAllTime.injected || 0} injected / ${rejAllTime.matched || 0} matched${lastUsed ? ` · Last: ${lastUsed}` : ''}</div>`;
                    }
                    html += `</div>`;
                }

                html += `</div></div>`;
            }
        }
    }

    const anyVaultNamed = settings.vaults && settings.vaults.some(v => v.name);
    html += anyVaultNamed
        ? '<p class="dle-faint dle-text-xs" style="margin-top: var(--dle-space-2);">Click entry names to open in Obsidian. Click entries to expand content preview.</p>'
        : '<p class="dle-faint dle-text-xs" style="margin-top: var(--dle-space-2);">Set vault names in Vault Connections to enable deep links.</p>';
    html += '</div>';

    const container = document.createElement('div');
    container.innerHTML = html;

    // Event delegation for entry detail expansion
    container.addEventListener('click', (e) => {
        const toggle = e.target.closest('.dle_ctx_toggle');
        if (!toggle) return;
        const targetId = toggle.dataset.target;
        const targetEl = document.getElementById(targetId);
        if (targetEl) targetEl.classList.toggle('dle-ctx-expanded');
    });

    // Event delegation for "Why?" diagnostic buttons in rejected entries
    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.dle_carto_whynot_btn');
        if (!btn) return;
        e.stopPropagation();
        const title = btn.dataset.title;
        const containerId = btn.dataset.container;
        const entry = vaultIndex.find(en => en.title === title);
        if (!entry || !chat || chat.length === 0) return;
        const result = diagnoseEntry(entry, chat);
        const color = STAGE_COLORS[result.stage] || 'var(--dle-text-muted)';
        const suggestions = result.suggestions.length > 0
            ? `<br><small class="dle-muted">Suggestion: ${escapeHtml(result.suggestions[0])}</small>`
            : '';
        const targetEl = document.getElementById(containerId);
        if (targetEl) {
            targetEl.innerHTML = `<div class="dle-text-sm" style="color: ${color}; padding: var(--dle-space-1) 0;">${escapeHtml(result.detail)}${suggestions}</div>`;
        }
        btn.remove();
    });

    callGenericPopup(container, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}
