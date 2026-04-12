/**
 * DeepLore Enhanced — Auto Lorebook Creation
 * Fixes Bug 1 (callAutoSuggest st mode) and Bug 3 (scan depth)
 */
import {
    generateQuietPrompt,
    chat,
    saveSettingsDebounced,
    eventSource,
    event_types,
} from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { getSettings, getPrimaryVault, resolveConnectionConfig } from '../../settings.js';
import { writeNote } from '../vault/obsidian-api.js';
import { buildAiChatContext, yamlEscape, classifyError } from '../../core/utils.js';
import { callAI } from './ai.js';
import { extractAiResponseClient } from '../helpers.js';
import { getWriterVisibleEntries, chatEpoch, isAiCircuitOpen, tryAcquireHalfOpenProbe, recordAiSuccess, recordAiFailure, releaseHalfOpenProbe } from '../state.js';
import { stripObsidianSyntax } from '../helpers.js';
import { ensureIndexFresh, buildIndex } from '../vault/vault.js';

export const DEFAULT_AUTO_SUGGEST_PROMPT = `You are a lore analyst for a roleplay session. Analyze the recent chat and identify characters, locations, items, concepts, or events that are mentioned but do NOT have an existing lorebook entry.

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
export async function callAutoSuggest(systemPrompt, userMessage, toolKey = 'autoSuggest') {
    const resolved = resolveConnectionConfig(toolKey);
    const mode = resolved.mode;
    const timeout = resolved.timeout;
    const maxTokens = resolved.maxTokens;

    if (mode === 'st') {
        if (isAiCircuitOpen() && !tryAcquireHalfOpenProbe()) throw new Error('AI circuit breaker is open — skipping auto-suggest');
        // BUG-244: generateQuietPrompt cannot be aborted mid-flight. Mirror scribe's GENERATION_STOPPED
        // race pattern so our await resolves early on user stop (lock releases promptly) rather than
        // blocking until the orphaned background generation completes or times out.
        const quietPrompt = `${systemPrompt}\n\n${userMessage}`;
        // BUG-FIX: timeout=0 should mean "no timeout", not "instant timeout" (setTimeout(fn, 0) fires immediately)
        const effectiveTimeout = timeout || 60000;
        const quietPromise = generateQuietPrompt({ quietPrompt, skipWIAN: true, responseLength: maxTokens });
        let suggestTimer;
        let onStop;
        try {
            const response = await Promise.race([
                quietPromise.finally(() => clearTimeout(suggestTimer)),
                new Promise((_, reject) => { suggestTimer = setTimeout(() => {
                    console.warn('[DLE] Auto-suggest quiet prompt timed out — orphaned generation may still complete in background');
                    const err = new Error(`Auto-suggest quiet prompt timed out (${Math.round(effectiveTimeout / 1000)}s)`);
                    err.timedOut = true;
                    reject(err);
                }, effectiveTimeout); }),
                new Promise((_, reject) => {
                    onStop = () => {
                        const err = new Error('Auto-suggest aborted by user (GENERATION_STOPPED)');
                        err.name = 'AbortError';
                        err.userAborted = true;
                        reject(err);
                    };
                    try { eventSource.on(event_types.GENERATION_STOPPED, onStop); } catch { /* noop */ }
                }),
            ]);
            recordAiSuccess();
            return { text: response, usage: null };
        } catch (err) {
            // BUG-252: user aborts and timeouts must not trip the circuit breaker.
            if (!err.throttled && !err.userAborted && !err.timedOut) recordAiFailure();
            throw err;
        } finally {
            if (onStop) { try { eventSource.removeListener(event_types.GENERATION_STOPPED, onStop); } catch { /* noop */ } }
        }
    } else if (mode === 'profile' || mode === 'proxy') {
        if (isAiCircuitOpen() && !tryAcquireHalfOpenProbe()) throw new Error('AI circuit breaker is open — skipping auto-suggest');
        try {
            const result = await callAI(systemPrompt, userMessage, { ...resolved, caller: 'autoSuggest' });
            recordAiSuccess();
            return result;
        } catch (err) {
            if (!err.throttled && !err.userAborted && !err.timedOut) recordAiFailure();
            throw err;
        }
    }
    throw new Error(`Unknown auto-suggest connection mode: ${mode}`);
}

let autoSuggestInProgress = false;
let autoSuggestInProgressEpoch = -1;

/**
 * Run auto-suggest: analyze chat for entities not in lorebook, return suggestions.
 * BUG 3 FIX: Uses aiSearchScanDepth instead of autoSuggestInterval for chat context depth.
 */
export async function runAutoSuggest() {
    // If a previous run was abandoned by a chat switch, the flag would be stuck — reset.
    if (autoSuggestInProgress && autoSuggestInProgressEpoch !== chatEpoch) {
        autoSuggestInProgress = false;
    }
    if (autoSuggestInProgress) return [];
    autoSuggestInProgress = true;
    autoSuggestInProgressEpoch = chatEpoch;
    const epoch = chatEpoch;
    try {
    const settings = getSettings();
    await ensureIndexFresh();
    // BUG-398: snapshot the writer-visible entry set BEFORE the epoch check so that
    // a concurrent rebuild landing between the check and the read cannot inject new
    // entries into our "existing" list (which would cause us to suggest entries that
    // already exist, or worse, silently write duplicates under skipReview).
    const visibleEntries = getWriterVisibleEntries();
    if (epoch !== chatEpoch) return []; // chat changed during index refresh
    const existingTitles = visibleEntries.map(e => `"${e.title.replace(/"/g, '\\"')}"`).join(', ');
    // BUG 3 FIX: Use a proper scan depth, not the interval frequency
    const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth || 20);

    const systemPrompt = settings.autoSuggestPrompt?.trim() || DEFAULT_AUTO_SUGGEST_PROMPT;
    const userMessage = `## Existing lorebook entries (do NOT suggest these):\n${existingTitles}\n\n## Recent Chat:\n${chatContext}\n\nSuggest new lorebook entries as a JSON array.`;

    const result = await callAutoSuggest(systemPrompt, userMessage);
    // BUG-023: Post-AI-call epoch guard. If the user switched chats during the AI call,
    // suggestions were generated against chat A's context — surfacing them in chat B would
    // tag the wrong chat/characters, and with skipReview on they'd be written silently.
    if (epoch !== chatEpoch) return [];
    const parsed = extractAiResponseClient(result.text);

    if (!Array.isArray(parsed)) return [];

    // Filter out entries that already exist
    const existingLower = new Set(visibleEntries.map(e => e.title.toLowerCase()));
    return parsed.filter(s =>
        s && typeof s === 'object' && s.title &&
        !existingLower.has(s.title.toLowerCase())
    );
    } finally {
        autoSuggestInProgress = false;
    }
}

/**
 * Show suggestion popup with editable fields and accept/reject buttons.
 */
export async function showSuggestionPopup(suggestions) {
    if (!suggestions || suggestions.length === 0) {
        toastr.info('No new entries suggested.', 'DeepLore Enhanced');
        return;
    }

    // BUG-272: capture epoch at popup open. Suggestions were generated against this chat's
    // context — if the user switches chats before clicking Accept, we must NOT write them
    // (they'd be tagged as belonging to the new chat's character/context). Vault writes are
    // global but the conceptual ownership is chat-scoped for auto-suggest.
    const popupEpoch = chatEpoch;

    const settings = getSettings();
    const container = document.createElement('div');
    container.classList.add('dle-popup');

    let cardsHtml = '';
    for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        cardsHtml += `
            <div id="dle-suggest-${i}" class="dle-suggest-card dle-card">
                <div class="dle-card-header dle-mb-1">
                    <strong>${escapeHtml(s.title || 'Untitled')}</strong>
                    <span class="dle-text-xs dle-muted">${escapeHtml(s.type || 'lore')}</span>
                </div>
                <div class="dle-text-sm dle-mb-1">
                    <strong>Keywords:</strong> ${escapeHtml((s.keys || []).join(', '))}
                </div>
                <div class="dle-text-sm dle-mb-1">
                    <strong>Summary:</strong> ${escapeHtml(s.summary || '')}
                </div>
                <details>
                    <summary class="dle-text-sm dle-cursor-pointer">Content preview</summary>
                    <div class="dle-preview dle-preview--short dle-mt-1">${escapeHtml(s.content || '')}</div>
                </details>
                <div class="dle-flex dle-mt-1 dle-gap-1">
                    <button class="menu_button dle-accept-suggest dle-text-sm" data-index="${i}">Accept</button>
                    <button class="menu_button dle-reject-suggest dle-text-sm dle-muted" data-index="${i}">Reject</button>
                </div>
            </div>`;
    }

    container.innerHTML = `
        <h3>Suggested Entries (${suggestions.length})</h3>
        <p class="dle-muted dle-text-sm">Review each suggestion. Accept to write to Obsidian, reject to skip.</p>
        <label class="checkbox_label dle-text-sm dle-checkbox-row">
            <input type="checkbox" class="checkbox" id="dle-suggest-skip-review" ${settings.autoSuggestSkipReview ? 'checked' : ''}>
            <span>Write directly (skip review)</span>
        </label>
        ${cardsHtml}
    `;

    await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onOpen: () => {
            // E11: Sync skip-review checkbox with settings
            const skipCheckbox = container.querySelector('#dle-suggest-skip-review');
            if (skipCheckbox) {
                skipCheckbox.addEventListener('change', function () {
                    settings.autoSuggestSkipReview = this.checked;
                    saveSettingsDebounced();
                });
            }

            container.querySelectorAll('.dle-accept-suggest').forEach(btn => {
                btn.addEventListener('click', async function () {
                    if (this.disabled) return; // Double-click guard
                    // BUG-272: chat switched since suggestions were generated — refuse to write.
                    if (popupEpoch !== chatEpoch) {
                        toastr.warning('Chat changed — these suggestions are no longer valid.', 'DeepLore Enhanced');
                        this.disabled = true;
                        return;
                    }
                    this.disabled = true;
                    const idx = Number(this.dataset.index);
                    const s = suggestions[idx];
                    const card = document.getElementById(`dle-suggest-${idx}`);
                    if (!card) { this.disabled = false; return; }

                    // Build frontmatter
                    const folder = settings.autoSuggestFolder || '';
                    // Sanitize title for filesystem safety (same pattern as Scribe)
                    let safeTitle = s.title.replace(/[<>:"/\\|?*]/g, '_');
                    safeTitle = safeTitle.replace(/^\.+|\.+$/g, ''); // strip leading/trailing dots
                    safeTitle = safeTitle.trimEnd(); // strip trailing spaces
                    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safeTitle)) safeTitle = '_' + safeTitle;
                    if (!safeTitle) safeTitle = 'Untitled';
                    const filename = folder
                        ? `${folder}/${safeTitle}.md`
                        : `${safeTitle}.md`;

                    const keysYaml = (s.keys || []).map(k => `  - ${yamlEscape(k)}`).join('\n');
                    // Sanitize AI-generated content: strip Obsidian-interpretable syntax and bare YAML delimiters
                    const safeContent = stripObsidianSyntax(s.content || '').replace(/^---$/gm, '- - -');
                    const fileContent = `---
type: ${yamlEscape(s.type || 'lore')}
priority: 50
tags:
  - ${settings.lorebookTag}
keys:
${keysYaml}
summary: "${(s.summary || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
---
# ${s.title}

${safeContent}`;

                    try {
                        const suggestVault = getPrimaryVault(settings);
                        const data = await writeNote(suggestVault.host, suggestVault.port, suggestVault.apiKey, filename, fileContent, !!suggestVault.https);
                        if (data.ok) {
                            card.classList.add('dle-suggest-card--accepted');
                            this.disabled = true;
                            this.textContent = 'Accepted';
                            toastr.success(`Created: ${s.title}`, 'DeepLore Enhanced');
                            // Reindex so the new entry is immediately retrievable
                            try { await buildIndex(); } catch (reidxErr) { console.warn('[DLE] Auto-suggest reindex after write failed:', reidxErr?.message); }
                        } else {
                            console.warn('[DLE] Auto-suggest write failed:', data && data.error);
                            toastr.error('Couldn\'t save that entry to your vault.', 'DeepLore Enhanced');
                        }
                    } catch (err) {
                        toastr.error(classifyError(err), 'DeepLore Enhanced');
                        this.disabled = false; // Re-enable on error
                    }
                });
            });

            container.querySelectorAll('.dle-reject-suggest').forEach(btn => {
                btn.addEventListener('click', function () {
                    const idx = Number(this.dataset.index);
                    const card = document.getElementById(`dle-suggest-${idx}`);
                    if (card) {
                        card.classList.add('dle-suggest-card--rejected');
                        // Disable both buttons and update label
                        card.querySelectorAll('button').forEach(b => b.disabled = true);
                        this.textContent = 'Rejected';
                    }
                });
            });
        },
    });
}
