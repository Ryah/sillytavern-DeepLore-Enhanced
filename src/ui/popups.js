/**
 * DeepLore Enhanced — Popup modules
 * showNotebookPopup, showBrowsePopup, runSimulation, showSimulationPopup,
 * optimizeEntryKeys, showOptimizePopup, buildCopyButton
 * (showGraphPopup moved to src/graph.js)
 */
import {
    saveChatDebounced,
    chat_metadata,
    chat,
} from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { getTokenCountAsync } from '../../../../../tokenizers.js';
import { parseFrontmatter, simpleHash, buildScanText, classifyError, NO_ENTRIES_MSG } from '../../core/utils.js';
import { testEntryMatch } from '../../core/matching.js';
import { getSettings, getVaultByName } from '../../settings.js';
import { writeNote, obsidianFetch, encodeVaultPath } from '../vault/obsidian-api.js';
import {
    vaultIndex, trackerKey,
    setVaultIndex, setIndexTimestamp,
} from '../state.js';
import { buildIndex } from '../vault/vault.js';
import { callAutoSuggest } from '../ai/auto-suggest.js';
import { extractAiResponseClient } from '../ai/ai.js';
import { buildObsidianURI } from './cartographer.js';
import { diagnoseEntry } from './diagnostics.js';
import { computeEntryTemperatures } from '../drawer/drawer-state.js';
import { STAGE_COLORS } from '../helpers.js';

/**
 * Serialize a value for YAML frontmatter output.
 * Numbers and booleans are unquoted; strings are quoted only when they
 * contain YAML special characters that would cause parse ambiguity.
 */
function yamlSerializeValue(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    const str = String(val);
    // Quote strings containing YAML special chars or that look like other types
    if (/^[{[\]|>*&!%#@`'",?:~-]/.test(str) || /[:#{}[\],]/.test(str) || str === '' ||
        /^(true|false|yes|no|on|off|null|~)$/i.test(str) || !isNaN(Number(str))) {
        return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return str;
}

/**
 * Build HTML for a "Copy to Clipboard" button used in diagnostic popups.
 * Uses event delegation — attach a single click listener on the popup container
 * that catches clicks on `.dle_copy_btn`.
 * @param {string} plainText - The text to copy (pre-computed, stored in data attribute)
 * @returns {string} HTML string for the button
 */
export function buildCopyButton(plainText) {
    // Encode the text as a data attribute (base64 avoids HTML-escaping issues with quotes/newlines)
    const encoded = btoa(unescape(encodeURIComponent(plainText)));
    return `<button class="menu_button dle_copy_btn dle-text-sm" data-copy="${encoded}" style="padding: 4px 12px; margin-bottom: var(--dle-space-2);">Copy to Clipboard</button>`;
}

/**
 * Attach a delegated click handler for `.dle_copy_btn` on a container element.
 * Reads the base64-encoded data-copy attribute, copies to clipboard, and shows feedback.
 * Safe to call multiple times — uses a class guard to avoid duplicate listeners.
 * @param {HTMLElement|Document} container - The container to listen on
 */
export function attachCopyHandler(container) {
    if (!container || container._dleCopyHandlerAttached) return;
    container._dleCopyHandlerAttached = true;
    container.addEventListener('click', async (e) => {
        const btn = e.target.closest('.dle_copy_btn');
        if (!btn) return;
        try {
            const encoded = btn.dataset.copy;
            const text = decodeURIComponent(escape(atob(encoded)));
            await navigator.clipboard.writeText(text);
            const original = btn.textContent;
            btn.textContent = 'Copied!';
            btn.disabled = true;
            setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
        } catch (err) {
            console.error('[DLE] Clipboard copy failed:', err);
            btn.textContent = 'Copy failed';
            setTimeout(() => { btn.textContent = 'Copy to Clipboard'; }, 2000);
        }
    });
}

/**
 * Show the Notebook editor popup for the current chat.
 */
export async function showNotebookPopup() {
    const currentContent = chat_metadata?.deeplore_notebook || '';

    const container = document.createElement('div');
    container.classList.add('dle-popup');
    container.innerHTML = `
        <h3>Notebook</h3>
        <p class="dle-muted dle-text-sm">Persistent scratchpad for this chat. Contents are injected into every generation when enabled. Use for character notes, plot threads, reminders, or anything the AI should always know.</p>
        <textarea id="dle_notebook_textarea" class="text_pole dle-text-mono" rows="15" style="width: 100%;" placeholder="Write notes here...">${escapeHtml(currentContent)}</textarea>
        <small id="dle_notebook_token_count" class="dle-faint"></small>
    `;

    // Capture textarea value in closure so it's available after popup DOM is destroyed
    let capturedValue = currentContent;
    const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Save',
        cancelButton: 'Cancel',
        onOpen: async () => {
            const textarea = document.getElementById('dle_notebook_textarea');
            const countEl = document.getElementById('dle_notebook_token_count');
            if (textarea && countEl) {
                const updateCount = async () => {
                    try {
                        capturedValue = textarea.value;
                        const tokens = await getTokenCountAsync(textarea.value);
                        countEl.textContent = `~${tokens} tokens`;
                    } catch { countEl.textContent = ''; }
                };
                textarea.addEventListener('input', updateCount);
                await updateCount();
            }
        },
    });

    if (result) {
        chat_metadata.deeplore_notebook = capturedValue;
        saveChatDebounced();
    }
}

/**
 * Show the AI Notepad viewer popup for the current chat.
 * Read-only display of accumulated AI-written notes with clear option.
 */
export async function showAiNotepadPopup() {
    const currentNotes = chat_metadata?.deeplore_ai_notepad || '';

    const container = document.createElement('div');
    container.classList.add('dle-popup');
    container.innerHTML = `
        <h3>AI Notepad</h3>
        <p class="dle-muted dle-text-sm">Session notes written by the AI using &lt;dle-notes&gt; tags. These are stripped from visible chat and reinjected into future messages.</p>
        <textarea id="dle_ai_notepad_textarea" class="text_pole dle-text-mono" rows="15" style="width: 100%;" placeholder="No AI notes yet for this chat.">${escapeHtml(currentNotes)}</textarea>
        <small id="dle_ai_notepad_token_count" class="dle-faint"></small>
    `;

    let capturedValue = currentNotes;
    const result = await callGenericPopup(container, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Save',
        cancelButton: 'Cancel',
        onOpen: async () => {
            const textarea = document.getElementById('dle_ai_notepad_textarea');
            const countEl = document.getElementById('dle_ai_notepad_token_count');
            if (textarea && countEl) {
                const updateCount = async () => {
                    try {
                        capturedValue = textarea.value;
                        const tokens = await getTokenCountAsync(textarea.value);
                        countEl.textContent = `~${tokens} tokens`;
                    } catch { countEl.textContent = ''; }
                };
                textarea.addEventListener('input', updateCount);
                await updateCount();
            }
        },
    });

    if (result) {
        chat_metadata.deeplore_ai_notepad = capturedValue;
        saveChatDebounced();
    }
}

/**
 * Show a searchable, filterable popup of all indexed vault entries.
 */
export async function showBrowsePopup() {
    if (vaultIndex.length === 0) {
        toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
        return;
    }

    const settings = getSettings();
    const analytics = settings.analyticsData || {};
    const allTags = [...new Set(vaultIndex.flatMap(e => e.tags))].sort();
    const pins = new Set((chat_metadata.deeplore_pins || []).map(t => t.toLowerCase()));
    const blocks = new Set((chat_metadata.deeplore_blocks || []).map(t => t.toLowerCase()));

    const container = document.createElement('div');
    container.classList.add('dle-popup');
    container.innerHTML = `
        <h3>Entry Browser (${vaultIndex.length} entries)</h3>
        <div style="display: flex; gap: var(--dle-space-2); margin-bottom: 10px; flex-wrap: wrap;">
            <input id="dle_browse_search" type="text" class="text_pole" placeholder="Search titles, keywords, content..." style="flex: 2; min-width: 200px;" />
            <select id="dle_browse_status" class="text_pole" style="flex: 1; min-width: 120px;">
                <option value="all">All Status</option>
                <option value="pinned">Pinned</option>
                <option value="blocked">Blocked</option>
                <option value="constant">Constants</option>
                <option value="seed">Seeds</option>
                <option value="bootstrap">Bootstrap</option>
                <option value="regular">Regular</option>
                <option value="never_injected">Never Injected</option>
            </select>
            <select id="dle_browse_tag" class="text_pole" style="flex: 1; min-width: 120px;">
                <option value="">All Tags</option>
                ${allTags.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
            </select>
            <select id="dle_browse_sort" class="text_pole" style="flex: 1; min-width: 140px;">
                <option value="priority_asc">Priority (high→low)</option>
                <option value="priority_desc">Priority (low→high)</option>
                <option value="alpha_asc">Alphabetical (A→Z)</option>
                <option value="alpha_desc">Alphabetical (Z→A)</option>
                <option value="tokens_desc">Token size (largest)</option>
                <option value="tokens_asc">Token size (smallest)</option>
                <option value="injected_desc">Most injected</option>
                <option value="injected_asc">Least injected</option>
            </select>
        </div>
        <div id="dle_browse_list" class="dle-scroll-region"></div>
        <small id="dle_browse_count" class="dle-faint"></small>
    `;

    // H8: Pre-compute search haystacks for browse popup filtering
    const haystacks = new Map();
    for (const e of vaultIndex) {
        haystacks.set(e, `${e.title} ${e.keys.join(' ')} ${e.content}`.toLowerCase());
    }

    function renderList() {
        const searchEl = container.querySelector('#dle_browse_search');
        const statusEl = container.querySelector('#dle_browse_status');
        const tagEl = container.querySelector('#dle_browse_tag');
        const sortEl = container.querySelector('#dle_browse_sort');
        const listEl = container.querySelector('#dle_browse_list');
        const countEl = container.querySelector('#dle_browse_count');

        const search = (searchEl?.value || '').toLowerCase();
        const status = statusEl?.value || 'all';
        const tag = tagEl?.value || '';
        const sort = sortEl?.value || 'priority_asc';

        let filtered = vaultIndex.filter(e => {
            if (status === 'pinned' && !pins.has(e.title.toLowerCase())) return false;
            if (status === 'blocked' && !blocks.has(e.title.toLowerCase())) return false;
            if (status === 'constant' && !e.constant) return false;
            if (status === 'seed' && !e.seed) return false;
            if (status === 'bootstrap' && !e.bootstrap) return false;
            if (status === 'regular' && (e.constant || e.seed || e.bootstrap)) return false;
            if (status === 'never_injected') {
                const a = analytics[trackerKey(e)];
                if (a && a.injected > 0) return false;
            }
            if (tag && !e.tags.includes(tag)) return false;
            if (search) {
                if (!haystacks.get(e).includes(search)) return false;
            }
            return true;
        });

        // Sort by selected method
        const getInjected = (e) => (analytics[trackerKey(e)]?.injected || 0);
        switch (sort) {
            case 'priority_asc': filtered.sort((a, b) => a.priority - b.priority); break;
            case 'priority_desc': filtered.sort((a, b) => b.priority - a.priority); break;
            case 'alpha_asc': filtered.sort((a, b) => a.title.localeCompare(b.title)); break;
            case 'alpha_desc': filtered.sort((a, b) => b.title.localeCompare(a.title)); break;
            case 'tokens_desc': filtered.sort((a, b) => (b.tokenEstimate || 0) - (a.tokenEstimate || 0)); break;
            case 'tokens_asc': filtered.sort((a, b) => (a.tokenEstimate || 0) - (b.tokenEstimate || 0)); break;
            case 'injected_desc': filtered.sort((a, b) => getInjected(b) - getInjected(a)); break;
            case 'injected_asc': filtered.sort((a, b) => getInjected(a) - getInjected(b)); break;
            default: filtered.sort((a, b) => a.priority - b.priority);
        }
        countEl.textContent = `Showing ${filtered.length} of ${vaultIndex.length} entries`;

        const tempMap = computeEntryTemperatures();
        let html = '<table class="dle-browse-table"><thead><tr>';
        html += '<th class="dle-col-title">Title</th>';
        html += '<th class="dle-col-keys">Keywords</th>';
        html += '<th class="dle-col-pri">Pri</th>';
        html += '<th class="dle-col-tok">Tokens</th>';
        html += '<th class="dle-col-tok">Usage</th>';
        html += '</tr></thead><tbody>';
        for (const entry of filtered) {
            const statusBadges = [];
            if (pins.has(entry.title.toLowerCase())) statusBadges.push('<span class="dle-badge dle-success">[pinned]</span>');
            if (blocks.has(entry.title.toLowerCase())) statusBadges.push('<span class="dle-badge dle-error">[blocked]</span>');
            if (entry.constant) statusBadges.push('<span class="dle-text-xs dle-success">[const]</span>');
            if (entry.seed) statusBadges.push('<span class="dle-text-xs dle-info">[seed]</span>');
            if (entry.bootstrap) statusBadges.push('<span class="dle-text-xs dle-warning">[boot]</span>');

            const keysDisplay = entry.keys.slice(0, 5).map(k => escapeHtml(k)).join(', ') + (entry.keys.length > 5 ? '...' : '');
            const a = analytics[trackerKey(entry)];
            const matchedNum = a?.matched || 0;
            const injectedNum = a?.injected || 0;
            const usageStr = a ? `${matchedNum}m / ${injectedNum}i` : '—';
            const entryId = simpleHash(entry.filename);

            const entryVaultName = entry.vaultSource
                ? (settings.vaults?.find(v => v.name === entry.vaultSource)?.name || '')
                : (settings.vaults?.[0]?.name || '');
            const obsidianUri = buildObsidianURI(entryVaultName, entry.filename);
            const obsidianLink = obsidianUri
                ? ` <a href="${escapeHtml(obsidianUri)}" target="_blank" class="dle-text-xs dle-muted">Open in Obsidian</a>`
                : '';

            const temp = tempMap.get(trackerKey(entry));
            const tempBorder = temp && temp.hue !== 'neutral'
                ? `border-left: 3px solid ${temp.hue === 'hot' ? '#cc4444' : '#223388'};`
                : '';
            html += `<tr class="dle_entry_toggle dle-browse-table-row" data-target="dle_entry_${entryId}" style="${tempBorder}">`;
            html += `<td class="dle-browse-table-title"><strong>${escapeHtml(entry.title)}</strong> ${statusBadges.join(' ')}</td>`;
            html += `<td class="dle-browse-table-keys">${keysDisplay || '<em class="dle-muted">none</em>'}</td>`;
            html += `<td class="dle-text-center">P${entry.priority}</td>`;
            html += `<td class="dle-text-right">~${entry.tokenEstimate}</td>`;
            html += `<td class="dle-text-right" title="matched / injected">${usageStr}</td>`;
            html += `</tr>`;
            html += `<tr id="dle_entry_${entryId}" class="dle-hidden"><td colspan="5" class="dle-browse-table-detail">`;
            const truncated = entry.content.length > 500 ? entry.content.substring(0, 500) + '…' : entry.content;
            html += `<div class="dle-preview">${escapeHtml(truncated)}</div>`;
            html += `<div class="dle-text-xs dle-muted dle-mt-1">`;
            html += `Links: ${entry.resolvedLinks.length > 0 ? entry.resolvedLinks.map(l => escapeHtml(l)).join(', ') : 'none'}`;
            html += ` · Tags: ${entry.tags.length > 0 ? entry.tags.map(t => escapeHtml(t)).join(', ') : 'none'}`;
            if (entry.requires.length > 0) html += ` · Requires: ${entry.requires.map(r => escapeHtml(r)).join(', ')}`;
            if (entry.excludes.length > 0) html += ` · Excludes: ${entry.excludes.map(r => escapeHtml(r)).join(', ')}`;
            if (entry.probability !== null) html += ` · Probability: ${entry.probability}`;
            if (entry.vaultSource && (settings.vaults || []).length > 1) html += ` · Vault: ${escapeHtml(entry.vaultSource)}`;
            html += obsidianLink;
            html += `</div>`;
            if (chat && chat.length > 0 && !entry.constant) {
                html += `<div id="dle_whynot_${entryId}" class="dle-mt-1"><button class="menu_button dle_whynot_btn dle-text-xs" data-title="${escapeHtml(entry.title)}" style="padding: 2px 8px;">Why not injected?</button></div>`;
            }
            html += `</td></tr>`;
        }
        html += '</tbody></table>';
        listEl.innerHTML = html || '<p class="dle-dimmed">No entries match filters.</p>';
    }

    // Event delegation for entry detail expansion — registered once on container, not per render
    container.addEventListener('click', (e) => {
        const toggle = e.target.closest('.dle_entry_toggle');
        if (!toggle) return;
        const targetId = toggle.dataset.target;
        const targetEl = document.getElementById(targetId);
        if (targetEl) targetEl.classList.toggle('dle-hidden');
    });

    // Event delegation for "Why not?" buttons — registered once on container, not per render
    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.dle_whynot_btn');
        if (!btn) return;
        e.stopPropagation();
        const title = btn.dataset.title;
        const entry = vaultIndex.find(en => en.title === title);
        if (!entry) return;
        const result = diagnoseEntry(entry, chat);
        const color = STAGE_COLORS[result.stage] || '#999';
        const suggestions = result.suggestions.length > 0
            ? `<br><small class="dle-muted">Suggestion: ${escapeHtml(result.suggestions[0])}</small>`
            : '';
        btn.parentElement.innerHTML = `<div class="dle-text-sm" style="color: ${color}; padding: var(--dle-space-1) 0;">${escapeHtml(result.detail)}${suggestions}</div>`;
    });

    await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onOpen: async () => {
            renderList();
            // H8: Debounce search input to avoid re-rendering on every keystroke
            let searchTimer = null;
            container.querySelector('#dle_browse_search')?.addEventListener('input', () => {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(renderList, 150);
            });
            container.querySelector('#dle_browse_status')?.addEventListener('change', renderList);
            container.querySelector('#dle_browse_tag')?.addEventListener('change', renderList);
            container.querySelector('#dle_browse_sort')?.addEventListener('change', renderList);
        },
    });
}

/**
 * Replay chat history step-by-step, running keyword matching at each message.
 * @param {object[]} chatMsgs
 * @returns {Array<{messageIndex: number, speaker: string, active: string[], newlyActivated: string[], deactivated: string[]}>}
 */
export function runSimulation(chatMsgs) {
    const settings = getSettings();
    const timeline = [];
    let previousActive = new Set();

    for (let i = 1; i <= chatMsgs.length; i++) {
        const slicedChat = chatMsgs.slice(0, i);
        const scanText = buildScanText(slicedChat, settings.scanDepth);
        const currentActive = new Set();

        // Always include constants
        for (const entry of vaultIndex) {
            if (entry.constant) currentActive.add(entry.title);
        }

        // Bootstrap
        if (i <= settings.newChatThreshold) {
            for (const entry of vaultIndex) {
                if (entry.bootstrap) currentActive.add(entry.title);
            }
        }

        // Keyword matching (skip probability/warmup/cooldown for clean simulation)
        if (settings.scanDepth > 0) {
            for (const entry of vaultIndex) {
                if (entry.constant) continue;
                const entryText = entry.scanDepth !== null
                    ? buildScanText(slicedChat, entry.scanDepth)
                    : scanText;
                const key = testEntryMatch(entry, entryText, settings);
                if (key) currentActive.add(entry.title);
            }
        }

        const newlyActivated = [...currentActive].filter(t => !previousActive.has(t));
        const deactivated = [...previousActive].filter(t => !currentActive.has(t));

        const msg = chatMsgs[i - 1];
        timeline.push({
            messageIndex: i - 1,
            speaker: msg.is_user ? 'User' : (msg.name || 'AI'),
            active: [...currentActive],
            newlyActivated,
            deactivated,
        });

        previousActive = currentActive;
    }

    return timeline;
}

/**
 * Show simulation results in a scrollable timeline popup.
 */
export function showSimulationPopup(timeline) {
    // Build plain-text version for clipboard
    const plainLines = [`Activation Simulation (${timeline.length} messages)`, ''];
    for (const step of timeline) {
        let line = `#${step.messageIndex + 1} ${step.speaker} (${step.active.length} active)`;
        if (step.newlyActivated.length > 0) line += `  + ${step.newlyActivated.join(', ')}`;
        if (step.deactivated.length > 0) line += `  - ${step.deactivated.join(', ')}`;
        plainLines.push(line);
    }
    const plainText = plainLines.join('\n');

    let html = '<div class="dle-popup">';
    html += `<h3>Activation Simulation (${timeline.length} messages)</h3>`;
    html += buildCopyButton(plainText);
    html += '<div class="dle-scroll-region">';

    for (const step of timeline) {
        const hasChanges = step.newlyActivated.length > 0 || step.deactivated.length > 0;
        const borderColor = hasChanges ? 'var(--SmartThemeQuoteColor, #4caf50)' : 'var(--SmartThemeBorderColor, #444)';

        html += `<div class="dle-text-sm" style="border-left: 3px solid ${borderColor}; padding: var(--dle-space-1) var(--dle-space-2); margin-bottom: 2px;">`;
        html += `<strong>#${step.messageIndex + 1} ${escapeHtml(step.speaker)}</strong>`;
        html += ` <small class="dle-faint">(${step.active.length} active)</small>`;

        if (step.newlyActivated.length > 0) {
            html += `<br><span class="dle-success">+ ${step.newlyActivated.map(t => escapeHtml(t)).join(', ')}</span>`;
        }
        if (step.deactivated.length > 0) {
            html += `<br><span class="dle-error">- ${step.deactivated.map(t => escapeHtml(t)).join(', ')}</span>`;
        }
        html += '</div>';
    }

    html += '</div></div>';
    callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        wide: true, large: true, allowVerticalScrolling: true,
        onOpen: () => attachCopyHandler(document.querySelector('.popup')),
    });
}

// showGraphPopup() moved to src/graph.js

// ============================================================================
// Optimize Keys
// ============================================================================

const DEFAULT_OPTIMIZE_KEYS_PROMPT = `You are a keyword optimization assistant for a lorebook system. Given an entry's title, content, and current keywords, suggest improved keywords that will trigger this entry when relevant topics come up in conversation.

Guidelines:
- Include the entry title and common aliases
- Add thematic keywords (topics, events, emotions this entry relates to)
- For keyword-only mode: be precise, avoid overly generic terms
- For two-stage mode: be broader since AI will filter later
- Return 3-10 keywords, ordered by importance

Respond with a JSON object: {"suggested": ["keyword1", "keyword2", ...], "reasoning": "Brief explanation of changes"}`;

/**
 * Send an entry to AI for keyword suggestions.
 */
export async function optimizeEntryKeys(entry) {
    const settings = getSettings();
    const mode = settings.optimizeKeysMode;
    const modeHint = mode === 'keyword-only'
        ? 'This system uses KEYWORD-ONLY matching (no AI filter). Be precise — avoid generic words.'
        : 'This system uses TWO-STAGE matching (keywords → AI filter). Be broader — the AI will refine.';

    const systemPrompt = DEFAULT_OPTIMIZE_KEYS_PROMPT;
    const userMessage = `Mode: ${modeHint}\n\nTitle: ${entry.title}\nCurrent keywords: ${entry.keys.join(', ')}\nContent:\n${entry.content.substring(0, 1500)}\n\nSuggest optimized keywords as JSON.`;

    const result = await callAutoSuggest(systemPrompt, userMessage);
    const parsed = extractAiResponseClient(result.text);

    if (parsed && parsed.suggested && Array.isArray(parsed.suggested)) {
        return { suggested: parsed.suggested, reasoning: parsed.reasoning || '' };
    }
    if (Array.isArray(parsed)) {
        return { suggested: parsed.map(String), reasoning: '' };
    }
    return null;
}

/**
 * Show optimize popup comparing current vs suggested keywords.
 */
export async function showOptimizePopup(entry, result) {
    if (!result) {
        toastr.warning('Could not get keyword suggestions.', 'DeepLore Enhanced');
        return;
    }

    const settings = getSettings();
    const html = `
        <div class="dle-popup">
            <h3>Optimize Keywords: ${escapeHtml(entry.title)}</h3>
            <div style="display: flex; gap: 20px; margin-bottom: 10px;">
                <div style="flex: 1;">
                    <h4>Current Keywords</h4>
                    <ul>${entry.keys.map(k => `<li>${escapeHtml(k)}</li>`).join('') || '<li><em>none</em></li>'}</ul>
                </div>
                <div style="flex: 1;">
                    <h4>Suggested Keywords</h4>
                    <ul>${result.suggested.map(k => `<li>${escapeHtml(k)}</li>`).join('')}</ul>
                </div>
            </div>
            ${result.reasoning ? `<p class="dle-muted dle-text-sm"><strong>Reasoning:</strong> ${escapeHtml(result.reasoning)}</p>` : ''}
        </div>
    `;

    const accept = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        okButton: 'Accept & Write',
        cancelButton: 'Cancel',
    });

    if (accept) {
        try {
            const optVault = getVaultByName(settings, entry.vaultSource);
            // Fetch current file content from Obsidian (no longer cached in _rawContent to save memory)
            let rawContent = entry.content;
            try {
                const fetchResult = await obsidianFetch({ host: optVault.host, port: optVault.port, apiKey: optVault.apiKey, path: `/vault/${encodeVaultPath(entry.filename)}`, accept: 'text/markdown' });
                if (fetchResult.status === 200) rawContent = fetchResult.data;
            } catch { /* fall back to entry.content */ }
            const { frontmatter, body } = parseFrontmatter(rawContent);
            const newKeys = result.suggested;
            const keysYaml = newKeys.map(k => `  - ${yamlSerializeValue(k)}`).join('\n');

            let newContent = '---\n';
            for (const [key, val] of Object.entries(frontmatter)) {
                if (key === 'keys') {
                    newContent += `keys:\n${keysYaml}\n`;
                } else if (Array.isArray(val)) {
                    newContent += `${key}:\n${val.map(v => `  - ${v}`).join('\n')}\n`;
                } else {
                    newContent += `${key}: ${yamlSerializeValue(val)}\n`;
                }
            }
            if (!frontmatter.keys) {
                newContent += `keys:\n${keysYaml}\n`;
            }
            newContent += `---\n${body}`;

            const data = await writeNote(optVault.host, optVault.port, optVault.apiKey, entry.filename, newContent);
            if (data.ok) {
                toastr.success(`Keywords updated for "${entry.title}"`, 'DeepLore Enhanced');
                setVaultIndex([]);
                setIndexTimestamp(0);
                await buildIndex();
            } else {
                toastr.error(`Failed: ${data.error}`, 'DeepLore Enhanced');
            }
        } catch (err) {
            toastr.error(classifyError(err), 'DeepLore Enhanced');
        }
    }
}
