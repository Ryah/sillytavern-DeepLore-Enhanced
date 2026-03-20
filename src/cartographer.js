/**
 * DeepLore Enhanced — Context Cartographer
 */
import { escapeHtml } from '../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { simpleHash } from '../core/utils.js';
import { getSettings } from '../settings.js';
import { vaultIndex, lastInjectionSources } from './state.js';

/** Track previous sources for diff display */
let previousSources = null;

/**
 * Reset cartographer state on chat change.
 * Clears previousSources so stale diffs don't carry across chats.
 */
export function resetCartographer() {
    previousSources = null;
}

/**
 * Build an obsidian:// URI to open a note in Obsidian.
 * @param {string} vaultName - Name of the Obsidian vault
 * @param {string} filename - File path within the vault
 * @returns {string|null} URI string, or null if vault name not configured
 */
export function buildObsidianURI(vaultName, filename) {
    if (!vaultName) return null;
    const encodedVault = encodeURIComponent(vaultName);
    const encodedFile = filename.split('/').map(s => encodeURIComponent(s)).join('/');
    return `obsidian://open?vault=${encodedVault}&file=${encodedFile}`;
}

/**
 * Inject a "Lore Sources" button into a message's action bar.
 * @param {number} messageId - Index in the chat array
 */
export function injectSourcesButton(messageId) {
    const mesEl = $(`.mes[mesid="${messageId}"]`);
    if (mesEl.length === 0) return;
    if (mesEl.find('.mes_deeplore_sources').length > 0) return;

    const btn = $('<div title="Lore Sources" class="mes_button mes_deeplore_sources fa-solid fa-book-open"></div>');
    mesEl.find('.extraMesButtons').prepend(btn);
}

/**
 * Show an enhanced popup with lore source details for a message.
 * @param {Array<{title: string, filename: string, matchedBy: string, priority: number, tokens: number}>} sources
 */
export function showSourcesPopup(sources) {
    const settings = getSettings();
    const totalTokens = sources.reduce((sum, s) => sum + s.tokens, 0);
    const maxTokens = Math.max(...sources.map(s => s.tokens), 1);
    const positionLabels = { 0: 'After Main Prompt', 1: 'In-chat', 2: 'Before Main Prompt' };

    // Group sources by injection position
    const groups = new Map();
    for (const src of sources) {
        const entry = vaultIndex.find(e => e.title === src.title);
        const pos = entry?.injectionPosition ?? settings.injectionPosition;
        const depth = entry?.injectionDepth ?? settings.injectionDepth;
        const posKey = pos === 1 ? `In-chat @depth ${depth}` : (positionLabels[pos] || 'Unknown');
        if (!groups.has(posKey)) groups.set(posKey, []);
        groups.get(posKey).push({ ...src, entry });
    }

    // Diff: compute added/removed since previous generation
    const prevTitles = previousSources ? new Set(previousSources.map(s => s.title)) : null;
    const currTitles = new Set(sources.map(s => s.title));
    const added = prevTitles ? sources.filter(s => !prevTitles.has(s.title)).map(s => s.title) : [];
    const removed = prevTitles ? previousSources.filter(s => !currTitles.has(s.title)).map(s => s.title) : [];
    previousSources = sources.map(s => ({ title: s.title, tokens: s.tokens })); // Save minimal data for next diff

    let html = `<div style="text-align: left;">`;
    html += `<h3>Context Map (${sources.length} entries, ~${totalTokens} tokens)</h3>`;

    // Diff display
    if (added.length > 0 || removed.length > 0) {
        html += `<div style="font-size: 0.85em; margin-bottom: 10px; padding: 6px; border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 4px;">`;
        if (added.length > 0) html += `<span style="color: #4caf50;">+${added.length} new:</span> <span style="opacity: 0.8;">${added.map(t => escapeHtml(t)).join(', ')}</span><br>`;
        if (removed.length > 0) html += `<span style="color: #f44336;">-${removed.length} removed:</span> <span style="opacity: 0.8;">${removed.map(t => escapeHtml(t)).join(', ')}</span>`;
        html += `</div>`;
    }

    for (const [posLabel, groupSources] of groups) {
        const groupTokens = groupSources.reduce((sum, s) => sum + s.tokens, 0);
        html += `<h4 style="margin: 12px 0 6px;">${escapeHtml(posLabel)} (~${groupTokens} tokens)</h4>`;

        for (const src of groupSources) {
            const pct = Math.max(2, Math.round((src.tokens / maxTokens) * 100));
            const srcVault = src.vaultSource && settings.vaults
                ? settings.vaults.find(v => v.name === src.vaultSource)
                : null;
            const vaultName = srcVault ? srcVault.name : (settings.vaults?.[0]?.name || '');
            const uri = buildObsidianURI(vaultName, src.filename);
            const titleHtml = uri
                ? `<a href="${escapeHtml(uri)}" target="_blank" style="color: var(--SmartThemeQuoteColor, #aac8ff); text-decoration: none;">${escapeHtml(src.title)}</a>`
                : escapeHtml(src.title);
            const entryId = simpleHash(src.filename + '_ctx');
            const contentPreview = src.entry ? escapeHtml(src.entry.content.substring(0, 300)) + (src.entry.content.length > 300 ? '...' : '') : '';

            html += `<div style="margin-bottom: 6px; padding: 6px; border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 4px;">`;
            html += `<div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" onclick="document.getElementById('dle_ctx_${entryId}').style.display = document.getElementById('dle_ctx_${entryId}').style.display === 'none' ? 'block' : 'none'">`;
            html += `<span><strong>${titleHtml}</strong> <small style="opacity: 0.6;">pri ${src.priority}</small></span>`;
            html += `<small>~${src.tokens} tok</small>`;
            html += `</div>`;
            html += `<div style="background: var(--SmartThemeBorderColor, #333); border-radius: 2px; height: 6px; margin: 4px 0;">`;
            html += `<div style="background: var(--SmartThemeQuoteColor, #4caf50); height: 100%; width: ${pct}%; border-radius: 2px;"></div>`;
            html += `</div>`;
            const vaultLabel = src.vaultSource && (settings.vaults || []).length > 1 ? ` · <em>${escapeHtml(src.vaultSource)}</em>` : '';
            html += `<small style="opacity: 0.7;">${escapeHtml(src.matchedBy)}${vaultLabel}</small>`;
            if (src.entry) {
                // Metadata line
                const meta = [];
                if (src.entry.keys?.length > 0) meta.push(`Keys: ${src.entry.keys.slice(0, 5).join(', ')}${src.entry.keys.length > 5 ? '...' : ''}`);
                if (src.entry.requires?.length > 0) meta.push(`Requires: ${src.entry.requires.join(', ')}`);
                if (src.entry.era?.length > 0) meta.push(`Era: ${src.entry.era.join(', ')}`);
                if (src.entry.location?.length > 0) meta.push(`Location: ${src.entry.location.join(', ')}`);
                if (src.entry.resolvedLinks?.length > 0) meta.push(`Links: ${src.entry.resolvedLinks.slice(0, 5).join(', ')}`);

                // Highlight matched keywords in content preview
                let highlighted = contentPreview;
                if (src.matchedBy && !src.matchedBy.startsWith('(')) {
                    // Extract the keyword from matchedBy (may have "→ AI:" suffix)
                    const keyword = src.matchedBy.split('→')[0].trim();
                    if (keyword.length >= 2) {
                        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        highlighted = highlighted.replace(new RegExp(`(${escaped})`, 'gi'), '<mark style="background: rgba(255,193,7,0.3); padding: 0 2px; border-radius: 2px;">$1</mark>');
                    }
                }

                html += `<div id="dle_ctx_${entryId}" style="display: none; margin-top: 6px;">`;
                if (meta.length > 0) {
                    html += `<div style="font-size: 0.8em; opacity: 0.6; margin-bottom: 4px;">${meta.map(m => escapeHtml(m)).join(' · ')}</div>`;
                }
                html += `<div style="padding: 6px; background: var(--SmartThemeBlurTintColor, #1a1a2e); border-radius: 4px; font-size: 0.85em; white-space: pre-wrap; max-height: 300px; overflow-y: auto;">${highlighted}</div>`;
                html += `</div>`;
            }
            html += `</div>`;
        }
    }

    const anyVaultNamed = settings.vaults && settings.vaults.some(v => v.name);
    html += anyVaultNamed
        ? '<p style="opacity: 0.6; font-size: 0.8em; margin-top: 8px;">Click entry names to open in Obsidian. Click entries to expand content preview.</p>'
        : '<p style="opacity: 0.6; font-size: 0.8em; margin-top: 8px;">Set vault names in Vault Connections to enable deep links.</p>';
    html += '</div>';

    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}
