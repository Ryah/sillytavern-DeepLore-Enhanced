/**
 * DeepLore Enhanced — Auto Lorebook Creation
 * Fixes Bug 1 (callAutoSuggest st mode) and Bug 3 (scan depth)
 */
import {
    getRequestHeaders,
    generateQuietPrompt,
    chat,
} from '../../../../script.js';
import { escapeHtml } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { getSettings, getPrimaryVault, PLUGIN_BASE } from '../settings.js';
import { buildAiChatContext } from '../core/utils.js';
import { callViaProfile, extractAiResponseClient } from './ai.js';
import { vaultIndex } from './state.js';
import { ensureIndexFresh } from './vault.js';

const DEFAULT_AUTO_SUGGEST_PROMPT = `You are a lore analyst for a roleplay session. Analyze the recent chat and identify characters, locations, items, concepts, or events that are mentioned but do NOT have an existing lorebook entry.

For each suggested entry, provide:
- "title": A short, unique title for the entry
- "type": One of "character", "location", "lore", "organization", "story"
- "keys": Array of 2-5 trigger keywords that would match this entry
- "summary": A brief description of what this entry is and when to select it (for AI search)
- "content": A 2-3 paragraph description based on what is known from the chat context

Respond with a JSON array of suggested entries. If nothing new is worth creating, respond with [].
Example: [{"title": "The Silver Crown", "type": "lore", "keys": ["silver crown", "crown"], "summary": "A magical artifact mentioned in the throne room scene.", "content": "The Silver Crown is a..."}]`;

/**
 * Route an Auto Suggest AI call based on connection mode (mirrors callScribe pattern).
 * BUG 1 FIX: st mode now uses object form of generateQuietPrompt.
 */
export async function callAutoSuggest(systemPrompt, userMessage) {
    const settings = getSettings();
    const mode = settings.autoSuggestConnectionMode;
    const timeout = settings.autoSuggestTimeout;
    const maxTokens = settings.autoSuggestMaxTokens;

    if (mode === 'st') {
        // BUG 1 FIX: Use object form matching callScribe's pattern
        const quietPrompt = `${systemPrompt}\n\n${userMessage}`;
        const response = await generateQuietPrompt({ quietPrompt, skipWIAN: true, responseLength: maxTokens });
        return { text: response, usage: null };
    } else if (mode === 'profile') {
        return await callViaProfile(systemPrompt, userMessage, maxTokens, timeout, settings.autoSuggestProfileId, settings.autoSuggestModel);
    } else if (mode === 'proxy') {
        const response = await fetch(`${PLUGIN_BASE}/scribe`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                proxyUrl: settings.autoSuggestProxyUrl,
                model: settings.autoSuggestModel || 'claude-haiku-4-5-20251001',
                systemPrompt,
                userMessage,
                maxTokens,
                timeout,
            }),
        });
        if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
        const data = await response.json();
        if (!data.ok) throw new Error(data.error || 'Auto-suggest proxy failed');
        return { text: data.text, usage: data.usage };
    }
    throw new Error(`Unknown auto-suggest connection mode: ${mode}`);
}

/**
 * Run auto-suggest: analyze chat for entities not in lorebook, return suggestions.
 * BUG 3 FIX: Uses aiSearchScanDepth instead of autoSuggestInterval for chat context depth.
 */
export async function runAutoSuggest() {
    const settings = getSettings();
    await ensureIndexFresh();

    const existingTitles = vaultIndex.map(e => e.title).join(', ');
    // BUG 3 FIX: Use a proper scan depth, not the interval frequency
    const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth || 20);

    const systemPrompt = DEFAULT_AUTO_SUGGEST_PROMPT;
    const userMessage = `## Existing lorebook entries (do NOT suggest these):\n${existingTitles}\n\n## Recent Chat:\n${chatContext}\n\nSuggest new lorebook entries as a JSON array.`;

    const result = await callAutoSuggest(systemPrompt, userMessage);
    const parsed = extractAiResponseClient(result.text);

    if (!Array.isArray(parsed)) return [];

    // Filter out entries that already exist
    const existingLower = new Set(vaultIndex.map(e => e.title.toLowerCase()));
    return parsed.filter(s =>
        s && typeof s === 'object' && s.title &&
        !existingLower.has(s.title.toLowerCase())
    );
}

/**
 * Show suggestion popup with editable fields and accept/reject buttons.
 */
export async function showSuggestionPopup(suggestions) {
    if (!suggestions || suggestions.length === 0) {
        toastr.info('No new entries suggested.', 'DeepLore Enhanced');
        return;
    }

    const settings = getSettings();
    const container = document.createElement('div');
    container.style.textAlign = 'left';

    let cardsHtml = '';
    for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        cardsHtml += `
            <div id="dle_suggest_${i}" class="dle_suggest_card" style="border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 5px; padding: 10px; margin-bottom: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <strong>${escapeHtml(s.title || 'Untitled')}</strong>
                    <span style="font-size: 0.8em; opacity: 0.7;">${escapeHtml(s.type || 'lore')}</span>
                </div>
                <div style="font-size: 0.85em; margin-bottom: 4px;">
                    <strong>Keywords:</strong> ${escapeHtml((s.keys || []).join(', '))}
                </div>
                <div style="font-size: 0.85em; margin-bottom: 4px;">
                    <strong>Summary:</strong> ${escapeHtml(s.summary || '')}
                </div>
                <details>
                    <summary style="cursor: pointer; font-size: 0.85em;">Content preview</summary>
                    <div style="white-space: pre-wrap; font-size: 0.85em; max-height: 200px; overflow-y: auto; background: var(--SmartThemeBlurTintColor, #1a1a2e); padding: 6px; border-radius: 4px; margin-top: 4px;">${escapeHtml(s.content || '')}</div>
                </details>
                <div style="margin-top: 6px; display: flex; gap: 6px;">
                    <button class="menu_button dle_accept_suggest" data-index="${i}" style="font-size: 0.85em;">Accept</button>
                    <button class="menu_button dle_reject_suggest" data-index="${i}" style="font-size: 0.85em; opacity: 0.7;">Reject</button>
                </div>
            </div>`;
    }

    container.innerHTML = `
        <h3>Suggested Entries (${suggestions.length})</h3>
        <p style="opacity: 0.7; font-size: 0.85em;">Review each suggestion. Accept to write to Obsidian, reject to skip.</p>
        ${cardsHtml}
    `;

    await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onOpen: () => {
            container.querySelectorAll('.dle_accept_suggest').forEach(btn => {
                btn.addEventListener('click', async function () {
                    const idx = Number(this.dataset.index);
                    const s = suggestions[idx];
                    const card = document.getElementById(`dle_suggest_${idx}`);
                    if (!card) return;

                    // Build frontmatter
                    const folder = settings.autoSuggestFolder || '';
                    const filename = folder
                        ? `${folder}/${s.title.replace(/[/\\:*?"<>|]/g, '')}.md`
                        : `${s.title.replace(/[/\\:*?"<>|]/g, '')}.md`;

                    const keysYaml = (s.keys || []).map(k => `  - ${k}`).join('\n');
                    const fileContent = `---
type: ${s.type || 'lore'}
priority: 50
tags:
  - ${settings.lorebookTag}
keys:
${keysYaml}
summary: "${(s.summary || '').replace(/"/g, '\\"')}"
---
# ${s.title}

${s.content || ''}`;

                    try {
                        const suggestVault = getPrimaryVault(settings);
                        const response = await fetch(`${PLUGIN_BASE}/write-note`, {
                            method: 'POST',
                            headers: getRequestHeaders(),
                            body: JSON.stringify({
                                port: suggestVault.port,
                                apiKey: suggestVault.apiKey,
                                filename,
                                content: fileContent,
                            }),
                        });
                        const data = await response.json();
                        if (data.ok) {
                            card.style.opacity = '0.4';
                            card.style.borderColor = '#4caf50';
                            this.disabled = true;
                            this.textContent = 'Accepted';
                            toastr.success(`Created: ${s.title}`, 'DeepLore Enhanced');
                        } else {
                            toastr.error(`Failed: ${data.error}`, 'DeepLore Enhanced');
                        }
                    } catch (err) {
                        toastr.error(`Error: ${err.message}`, 'DeepLore Enhanced');
                    }
                });
            });

            container.querySelectorAll('.dle_reject_suggest').forEach(btn => {
                btn.addEventListener('click', function () {
                    const idx = Number(this.dataset.index);
                    const card = document.getElementById(`dle_suggest_${idx}`);
                    if (card) {
                        card.style.opacity = '0.3';
                        card.style.borderColor = '#f44336';
                    }
                });
            });
        },
    });
}
