/**
 * DeepLore Enhanced — Context Cartographer
 */
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { buildCopyButton, attachCopyHandler } from './popups.js';
import { chat } from '../../../../../../script.js';
import { simpleHash } from '../../core/utils.js';
import { getSettings } from '../../settings.js';
import { vaultIndex, vaultAvgTokens, previousSources, setPreviousSources, lastPipelineTrace, chatInjectionCounts, trackerKey } from '../state.js';
import { diagnoseEntry } from './diagnostics.js';
import { STAGE_COLORS, computeSourcesDiff, categorizeRejections, resolveEntryVault, parseMatchReason, tokenBarColor, formatRelativeTime } from '../helpers.js';
import { navigateToBrowseEntry } from '../drawer/drawer.js';
// Re-export from helpers.js (moved there for testability in Node.js)
export { buildObsidianURI } from '../helpers.js';

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

    const btn = $('<div title="Why? — See which lore was injected" class="mes_button mes_deeplore_sources fa-solid fa-book-open" role="button" tabindex="0" aria-label="Why? — See which lore was injected"></div>');
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
export function showSourcesPopup(sources, opts = {}) {
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

    // Build plain-text for clipboard
    const plainLines = [`Injected Sources (${sources.length} entries, ~${totalTokens} tokens)`, '', 'Entry\tTokens\tMatched By\tChat×\tAll-time Inj\tAll-time Match\tLast Used'];
    for (const src of sources) {
        const ek = src.entry ? trackerKey(src.entry) : `${src.vaultSource || ''}:${src.title}`;
        const cc = chatInjectionCounts.get(ek) || 0;
        const at = settings.analyticsData?.[ek];
        plainLines.push(`${src.title}\t${src.tokens}\t${src.matchedBy}\t${cc}\t${at?.injected || 0}\t${at?.matched || 0}\t${at?.lastTriggered ? new Date(at.lastTriggered).toLocaleString() : 'Never'}`);
    }

    let html = `<div class="dle-popup">`;
    html += buildCopyButton(plainLines.join('\n'));
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
        html += `<h4 class="dle-carto-heading">${escapeHtml(posLabel)} (~${groupTokens} tokens)</h4>`;

        for (const src of groupSources) {
            const pct = Math.max(2, Math.round((src.tokens / maxTokens) * 100));
            // 7.14: Color bar and token text by vault-relative size
            const barColor = tokenBarColor(src.tokens, avgTokens);
            const { uri } = resolveEntryVault(src, settings.vaults);
            const titleHtml = uri
                ? `<a href="${escapeHtml(uri)}" target="_blank" class="dle-carto-obsidian-link">${escapeHtml(src.title)}</a>`
                : escapeHtml(src.title);
            const entryId = simpleHash(src.filename + '_ctx');
            const rawPreview = src.entry ? src.entry.content.substring(0, 300) + (src.entry.content.length > 300 ? '...' : '') : '';

            html += `<div class="dle-card">`;
            html += `<div class="dle-ctx-toggle dle-card-header" data-target="dle_ctx_${entryId}" aria-expanded="false">`;
            html += `<span><strong>${titleHtml}</strong> <span class="dle-text-xs dle-faint">pri ${src.priority}</span>`;
            html += ` <button class="dle-carto-browse-btn" data-browse-title="${escapeHtml(src.title)}" title="Show in Browse"><i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i></button></span>`;
            html += `<span class="dle-text-xs" style="color: ${barColor};">~${src.tokens} tok</span>`;
            html += `</div>`;
            html += `<div class="dle-token-bar">`;
            html += `<div class="dle-token-bar-fill" style="background: ${barColor}; width: ${pct}%;"></div>`;
            html += `</div>`;
            const vaultLabel = src.vaultSource && (settings.vaults || []).length > 1 ? ` · <em>${escapeHtml(src.vaultSource)}</em>` : '';
            html += `<span class="dle-text-xs dle-muted">${escapeHtml(src.matchedBy)}${vaultLabel}</span>`;

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
                if (src.entry.customFields) {
                    for (const [key, val] of Object.entries(src.entry.customFields)) {
                        if (val != null && val !== '' && (!Array.isArray(val) || val.length > 0)) {
                            const display = Array.isArray(val) ? val.join(', ') : String(val);
                            meta.push(`${key}: ${display}`);
                        }
                    }
                }
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
                    html += `<div class="dle-text-xs dle-faint dle-mb-1">${meta.map(m => escapeHtml(m)).join(' · ')}</div>`;
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
            html += `<hr class="dle-my-3" style="border-color: var(--dle-border);">`;
            html += `<h4 class="dle-carto-heading" style="color: var(--dle-text-muted);">Not Injected (${totalRejected} entries)</h4>`;

            for (const group of rejectedGroups) {
                const groupId = simpleHash(`rejected_${group.label}`);
                html += `<div class="dle-card dle-carto-rejected">`;
                html += `<div class="dle-ctx-toggle dle-card-header" data-target="dle_rej_${groupId}" aria-expanded="false">`;
                html += `<span><i class="fa-solid ${group.icon} dle-text-muted" style="margin-right: 6px;"></i><strong>${escapeHtml(group.label)}</strong> <span class="dle-text-xs dle-faint">(${group.entries.length})</span></span>`;
                html += `<span class="dle-text-xs dle-faint">click to expand</span>`;
                html += `</div>`;
                html += `<div id="dle_rej_${groupId}" class="dle-ctx-detail">`;

                for (const e of group.entries) {
                    const entry = entryByTitle.get(e.title);
                    const whynotId = simpleHash(`whynot_${e.title}`);
                    html += `<div class="dle-carto-entry-row">`;
                    html += `<span class="dle-text-sm">${escapeHtml(e.title)} <button class="dle-carto-browse-btn" data-browse-title="${escapeHtml(e.title)}" title="Show in Browse"><i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i></button></span>`;
                    if (entry && !entry.constant) {
                        html += ` <button class="menu_button dle-carto-whynot-btn dle-text-xs" data-title="${escapeHtml(e.title)}" data-container="dle_whynot_carto_${whynotId}">Why?</button>`;
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
        ? '<p class="dle-faint dle-text-xs dle-mt-2">Click entry names to open in Obsidian. Click entries to expand content preview.</p>'
        : '<p class="dle-faint dle-text-xs dle-mt-2">Set vault names in Vault Connections to enable deep links.</p>';

    // AI Notepad: show per-message notes if present
    if (opts.aiNotes) {
        html += `<div class="dle-card dle-mt-2">
            <h4><i class="fa-solid fa-robot" style="margin-right: 4px;"></i>AI Notes (this message)</h4>
            <pre class="dle-text-sm dle-preview">${escapeHtml(opts.aiNotes)}</pre>
        </div>`;
    }

    html += '</div>';

    const container = document.createElement('div');
    container.innerHTML = html;

    // Event delegation for entry detail expansion
    container.addEventListener('click', (e) => {
        const toggle = e.target.closest('.dle-ctx-toggle');
        if (!toggle) return;
        const targetId = toggle.dataset.target;
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
            targetEl.classList.toggle('dle-ctx-expanded');
            toggle.setAttribute('aria-expanded', targetEl.classList.contains('dle-ctx-expanded'));
        }
    });

    // Event delegation for "Why?" diagnostic buttons in rejected entries
    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.dle-carto-whynot-btn');
        if (!btn) return;
        e.stopPropagation();
        const title = btn.dataset.title;
        const containerId = btn.dataset.container;
        const entry = vaultIndex.find(en => en.title === title);
        if (!entry || !chat || chat.length === 0) return;
        const result = diagnoseEntry(entry, chat);
        const color = STAGE_COLORS[result.stage] || 'var(--dle-text-muted)';
        const suggestions = result.suggestions.length > 0
            ? `<br><span class="dle-text-xs dle-muted">Suggestion: ${escapeHtml(result.suggestions[0])}</span>`
            : '';
        const targetEl = document.getElementById(containerId);
        if (targetEl) {
            targetEl.innerHTML = `<div class="dle-text-sm dle-diag-result" style="color: ${color};">${escapeHtml(result.detail)}${suggestions}</div>`;
        }
        btn.remove();
    });

    // Event delegation for browse navigation buttons (Carto → Drawer Browse)
    container.addEventListener('click', (e) => {
        const browseBtn = e.target.closest('.dle-carto-browse-btn');
        if (!browseBtn) return;
        e.stopPropagation();
        const title = browseBtn.dataset.browseTitle;
        if (title) {
            navigateToBrowseEntry(title);
            // Close the popup
            document.querySelector('.popup .popup_ok')?.click();
        }
    });

    callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wide: true, large: true, allowVerticalScrolling: true,
        onOpen: () => attachCopyHandler(document.querySelector('.popup')),
    });
}
