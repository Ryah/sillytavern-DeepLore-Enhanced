/**
 * DeepLore Enhanced — Popup modules
 * showNotebookPopup, showBrowsePopup, runSimulation, showSimulationPopup,
 * showGraphPopup, optimizeEntryKeys, showOptimizePopup, buildCopyButton
 */
import {
    saveChatDebounced,
    chat_metadata,
    chat,
} from '../../../../../script.js';
import { escapeHtml } from '../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { getTokenCountAsync } from '../../../../tokenizers.js';
import { parseFrontmatter, simpleHash, buildScanText, classifyError, NO_ENTRIES_MSG } from '../core/utils.js';
import { testEntryMatch } from '../core/matching.js';
import { getSettings, getVaultByName } from '../settings.js';
import { writeNote, obsidianFetch, encodeVaultPath } from './obsidian-api.js';
import {
    vaultIndex, trackerKey,
    setVaultIndex, setIndexTimestamp,
} from './state.js';
import { buildIndex, ensureIndexFresh } from './vault.js';
import { callAutoSuggest } from './auto-suggest.js';
import { extractAiResponseClient } from './ai.js';
import { buildObsidianURI } from './cartographer.js';
import { diagnoseEntry } from './diagnostics.js';
import { STAGE_COLORS } from './helpers.js';

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
        <textarea id="dle_notebook_textarea" class="text_pole" rows="15" style="width: 100%; font-family: monospace; font-size: 0.9em;" placeholder="Write notes here...">${escapeHtml(currentContent)}</textarea>
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
 * Show a searchable, filterable popup of all indexed vault entries.
 */
export async function showBrowsePopup() {
    await ensureIndexFresh();
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

        let html = '';
        for (const entry of filtered) {
            const statusBadges = [];
            if (pins.has(entry.title.toLowerCase())) statusBadges.push('<span class="dle-badge dle-success">[pinned]</span>');
            if (blocks.has(entry.title.toLowerCase())) statusBadges.push('<span class="dle-badge dle-error">[blocked]</span>');
            if (entry.constant) statusBadges.push('<span class="dle-text-xs dle-success">[constant]</span>');
            if (entry.seed) statusBadges.push('<span class="dle-text-xs dle-info">[seed]</span>');
            if (entry.bootstrap) statusBadges.push('<span class="dle-text-xs dle-warning">[bootstrap]</span>');

            const keysDisplay = entry.keys.slice(0, 5).map(k => escapeHtml(k)).join(', ') + (entry.keys.length > 5 ? '...' : '');
            const a = analytics[trackerKey(entry)];
            const usageStr = a ? `matched: ${a.matched || 0}, injected: ${a.injected || 0}` : 'never used';
            const entryId = simpleHash(entry.filename);

            const entryVaultName = entry.vaultSource
                ? (settings.vaults?.find(v => v.name === entry.vaultSource)?.name || '')
                : (settings.vaults?.[0]?.name || '');
            const obsidianUri = buildObsidianURI(entryVaultName, entry.filename);
            const obsidianLink = obsidianUri
                ? ` <a href="${escapeHtml(obsidianUri)}" target="_blank" class="dle-text-xs dle-muted">Open in Obsidian</a>`
                : '';

            html += `<div class="dle-card">`;
            html += `<div class="dle_entry_toggle dle-card-header" data-target="dle_entry_${entryId}">`;
            html += `<span><strong>${escapeHtml(entry.title)}</strong> ${statusBadges.join(' ')}</span>`;
            html += `<span class="dle-faint dle-text-sm">pri ${entry.priority} · ~${entry.tokenEstimate}tok · ${usageStr}</span>`;
            html += `</div>`;
            html += `<div class="dle-text-xs dle-muted">${keysDisplay || '<em>no keywords</em>'}</div>`;
            html += `<div id="dle_entry_${entryId}" style="display: none; margin-top: var(--dle-space-2); padding-top: var(--dle-space-2); border-top: 1px solid var(--dle-border);">`;
            html += `<div class="dle-preview">${escapeHtml(entry.content)}</div>`;
            html += `<div class="dle-text-xs dle-muted" style="margin-top: var(--dle-space-1);">`;
            html += `Links: ${entry.resolvedLinks.length > 0 ? entry.resolvedLinks.map(l => escapeHtml(l)).join(', ') : 'none'}`;
            html += ` · Tags: ${entry.tags.length > 0 ? entry.tags.map(t => escapeHtml(t)).join(', ') : 'none'}`;
            if (entry.requires.length > 0) html += ` · Requires: ${entry.requires.map(r => escapeHtml(r)).join(', ')}`;
            if (entry.excludes.length > 0) html += ` · Excludes: ${entry.excludes.map(r => escapeHtml(r)).join(', ')}`;
            if (entry.probability !== null) html += ` · Probability: ${entry.probability}`;
            if (entry.vaultSource && (settings.vaults || []).length > 1) html += ` · Vault: ${escapeHtml(entry.vaultSource)}`;
            html += obsidianLink;
            html += `</div>`;
            // "Why not?" diagnostic button
            if (chat && chat.length > 0 && !entry.constant) {
                html += `<div id="dle_whynot_${entryId}" style="margin-top: var(--dle-space-1);"><button class="menu_button dle_whynot_btn dle-text-xs" data-title="${escapeHtml(entry.title)}" style="padding: 2px 8px;">Why not injected?</button></div>`;
            }
            html += `</div></div>`;
        }
        listEl.innerHTML = html || '<p class="dle-dimmed">No entries match filters.</p>';
    }

    // Event delegation for entry detail expansion — registered once on container, not per render
    container.addEventListener('click', (e) => {
        const toggle = e.target.closest('.dle_entry_toggle');
        if (!toggle) return;
        const targetId = toggle.dataset.target;
        const targetEl = document.getElementById(targetId);
        if (targetEl) targetEl.style.display = targetEl.style.display === 'none' ? 'block' : 'none';
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

/**
 * Show an interactive force-directed graph of entry relationships.
 */
export async function showGraphPopup() {
    await ensureIndexFresh();
    if (vaultIndex.length === 0) {
        toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
        return;
    }

    if (vaultIndex.length > 200) {
        toastr.warning(
            `Large vault (${vaultIndex.length} entries). The graph may be slow to render. Consider filtering by tag first.`,
            'DeepLore Enhanced',
            { timeOut: 8000, preventDuplicates: true },
        );
    }

    const settings = getSettings();
    const multiVault = (settings.vaults || []).length > 1;

    // Build node and edge data
    const titleSet = new Set(vaultIndex.map(e => e.title));
    const nodes = vaultIndex.map((e, i) => ({
        id: i,
        title: e.title,
        type: e.constant ? 'constant' : e.seed ? 'seed' : e.bootstrap ? 'bootstrap' : 'regular',
        tokens: e.tokenEstimate,
        vaultSource: e.vaultSource || '',
        x: Math.random() * 800 - 400,
        y: Math.random() * 600 - 300,
        vx: 0, vy: 0,
    }));

    const titleToIdx = new Map(vaultIndex.map((e, i) => [e.title.toLowerCase(), i]));
    const edges = [];

    for (let i = 0; i < vaultIndex.length; i++) {
        const entry = vaultIndex[i];
        for (const link of entry.resolvedLinks) {
            const j = titleToIdx.get(link.toLowerCase());
            if (j !== undefined && j !== i) {
                edges.push({ from: i, to: j, type: 'link' });
            }
        }
        for (const req of entry.requires) {
            const j = titleToIdx.get(req.toLowerCase());
            if (j !== undefined && j !== i) {
                edges.push({ from: i, to: j, type: 'requires' });
            }
        }
        for (const ex of entry.excludes) {
            const j = titleToIdx.get(ex.toLowerCase());
            if (j !== undefined && j !== i) {
                edges.push({ from: i, to: j, type: 'excludes' });
            }
        }
        for (const cl of (entry.cascadeLinks || [])) {
            const j = titleToIdx.get(cl.toLowerCase());
            if (j !== undefined && j !== i) {
                edges.push({ from: i, to: j, type: 'cascade' });
            }
        }
    }

    // Detect circular requires
    const circularPairs = [];
    for (const edge of edges) {
        if (edge.type === 'requires') {
            const reverse = edges.find(e => e.type === 'requires' && e.from === edge.to && e.to === edge.from);
            if (reverse) {
                const key = [Math.min(edge.from, edge.to), Math.max(edge.from, edge.to)].join(',');
                if (!circularPairs.some(p => p === key)) circularPairs.push(key);
            }
        }
    }

    // Build text summary for screen readers
    const typeCounts = { regular: 0, constant: 0, seed: 0, bootstrap: 0 };
    for (const n of nodes) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;

    const edgeCountByNode = new Map();
    for (const edge of edges) {
        edgeCountByNode.set(edge.from, (edgeCountByNode.get(edge.from) || 0) + 1);
        edgeCountByNode.set(edge.to, (edgeCountByNode.get(edge.to) || 0) + 1);
    }
    const topConnected = [...edgeCountByNode.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([idx, count]) => `${nodes[idx].title} (${count} connections)`);

    const circularNames = circularPairs.map(key => {
        const [a, b] = key.split(',').map(Number);
        return `${nodes[a].title} <-> ${nodes[b].title}`;
    });

    let summaryHtml = `<p><strong>Totals:</strong> ${nodes.length} nodes, ${edges.length} edges</p>`;
    summaryHtml += `<p><strong>By type:</strong> ${typeCounts.regular} regular, ${typeCounts.constant} constant, ${typeCounts.seed} seed, ${typeCounts.bootstrap} bootstrap</p>`;
    if (topConnected.length > 0) {
        summaryHtml += `<p><strong>Most connected:</strong></p><ul>${topConnected.map(t => `<li>${t}</li>`).join('')}</ul>`;
    }
    if (circularNames.length > 0) {
        summaryHtml += `<p><strong>Circular requires:</strong></p><ul>${circularNames.map(t => `<li>${t}</li>`).join('')}</ul>`;
    } else {
        summaryHtml += `<p>No circular requires detected.</p>`;
    }

    const container = document.createElement('div');
    container.classList.add('dle-popup');
    const circularWarning = circularPairs.length > 0
        ? `<p class="dle-error dle-text-sm">⚠ ${circularPairs.length} circular require pair(s) detected</p>`
        : '';
    container.innerHTML = `
        <h3>Entry Relationship Graph (${nodes.length} nodes, ${edges.length} edges)</h3>
        ${circularWarning}
        <div class="dle-text-xs" style="display: flex; gap: 10px; margin-bottom: var(--dle-space-2); flex-wrap: wrap;">
            <span><span class="dle-success">●</span> Regular</span>
            <span><span class="dle-warning">●</span> Constant</span>
            <span><span class="dle-info">●</span> Seed</span>
            <span><span class="dle-accent">●</span> Bootstrap</span>
            <span class="dle-muted">—</span>
            <span><span style="color: #aac8ff;">—</span> Link</span>
            <span><span class="dle-success">—</span> Requires</span>
            <span><span class="dle-error">—</span> Excludes</span>
            <span><span class="dle-warning">—</span> Cascade</span>
        </div>
        <canvas id="dle_graph_canvas" width="900" height="600" style="border: 1px solid var(--dle-border); border-radius: 4px; cursor: grab; width: 100%; background: var(--dle-bg-surface);" aria-label="Force-directed graph showing ${nodes.length} vault entries and ${edges.length} relationships between them, including links, requires, excludes, and cascade connections."></canvas>
        <details class="dle-text-sm" style="margin-top: var(--dle-space-2);">
            <summary>Text summary (for screen readers)</summary>
            ${summaryHtml}
        </details>
        <small class="dle-dimmed">Drag nodes to reposition. Right-click to pin/unpin. Scroll to zoom.</small>
    `;

    callGenericPopup(container, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: false });

    // Wait for canvas to be in DOM
    await new Promise(r => setTimeout(r, 100));
    const canvas = document.getElementById('dle_graph_canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * (window.devicePixelRatio || 1);
    canvas.height = rect.height * (window.devicePixelRatio || 1);
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    const W = rect.width;
    const H = rect.height;

    for (const n of nodes) {
        n.x = (Math.random() - 0.5) * W * 0.8;
        n.y = (Math.random() - 0.5) * H * 0.8;
    }

    let panX = W / 2, panY = H / 2, zoom = 1;
    let dragNode = null, hoverNode = null;
    let isRunning = true;
    let alpha = 1.0; // simulation temperature — decays toward 0

    const nodeColors = { constant: '#ff9800', seed: '#2196f3', bootstrap: '#9c27b0', regular: '#4caf50' };
    const edgeColors = { link: '#aac8ff', requires: '#4caf50', excludes: '#f44336', cascade: '#ff9800' };

    function toScreen(x, y) { return { x: x * zoom + panX, y: y * zoom + panY }; }
    function toWorld(sx, sy) { return { x: (sx - panX) / zoom, y: (sy - panY) / zoom }; }

    let hasSpringEnergy = true; // tracks whether springs still need to settle
    function simulate() {
        if (alpha < 0.001 && !dragNode && !hasSpringEnergy) return; // fully settled
        if (!dragNode) alpha *= 0.98; // only decay when not dragging
        const k = 0.008, repulsion = 2000, damping = 0.7, gravity = 0.03, maxV = 8;
        // Repulsion + gravity only during initial layout (not during drag)
        if (!dragNode) {
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    let dx = nodes[j].x - nodes[i].x;
                    let dy = nodes[j].y - nodes[i].y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const force = repulsion / (dist * dist) * alpha;
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;
                    nodes[i].vx -= fx; nodes[i].vy -= fy;
                    nodes[j].vx += fx; nodes[j].vy += fy;
                }
            }
            for (const n of nodes) {
                n.vx -= n.x * gravity * alpha;
                n.vy -= n.y * gravity * alpha;
            }
        }
        // Spring (edge) forces always apply so dragging pulls neighbors
        for (const edge of edges) {
            const a = nodes[edge.from], b = nodes[edge.to];
            const dx = b.x - a.x, dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = k * (dist - 120);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
        }
        let totalSpeed = 0;
        for (const n of nodes) {
            if (n === dragNode || n.pinned) continue;
            n.vx *= damping; n.vy *= damping;
            const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
            if (speed > maxV) { n.vx *= maxV / speed; n.vy *= maxV / speed; }
            n.x += n.vx; n.y += n.vy;
            totalSpeed += speed;
        }
        hasSpringEnergy = totalSpeed > 0.1;
    }

    function draw() {
        ctx.clearRect(0, 0, W, H);
        ctx.lineWidth = 1;
        for (const edge of edges) {
            const a = toScreen(nodes[edge.from].x, nodes[edge.from].y);
            const b = toScreen(nodes[edge.to].x, nodes[edge.to].y);
            ctx.strokeStyle = edgeColors[edge.type] || '#555';
            ctx.globalAlpha = 0.4;
            if (edge.type === 'excludes') { ctx.setLineDash([4, 4]); } else { ctx.setLineDash([]); }
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        for (const n of nodes) {
            const s = toScreen(n.x, n.y);
            const r = Math.max(4, Math.min(12, Math.sqrt(n.tokens / 10)));
            ctx.fillStyle = n === hoverNode ? '#ffffff' : (nodeColors[n.type] || '#4caf50');
            ctx.beginPath(); ctx.arc(s.x, s.y, r * zoom, 0, Math.PI * 2); ctx.fill();
            if (n.pinned) {
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(s.x, s.y, (r + 3) * zoom, 0, Math.PI * 2); ctx.stroke();
                ctx.lineWidth = 1;
            }
        }
        ctx.fillStyle = '#ddd'; ctx.font = `${Math.max(9, 11 * zoom)}px monospace`; ctx.textAlign = 'center';
        for (const n of nodes) {
            const s = toScreen(n.x, n.y);
            if (n === hoverNode || zoom > 1.5 || nodes.length < 30) {
                ctx.fillText(n.title, s.x, s.y - 10 * zoom);
            }
        }
        if (hoverNode) {
            const s = toScreen(hoverNode.x, hoverNode.y);
            const entry = vaultIndex[hoverNode.id];
            const info = `${hoverNode.title} (~${hoverNode.tokens} tok, pri ${entry.priority})`;
            const connections = edges.filter(e => e.from === hoverNode.id || e.to === hoverNode.id).length;
            const vaultLabel = multiVault && hoverNode.vaultSource ? ` [${hoverNode.vaultSource}]` : '';
            const tooltip = `${info}${vaultLabel} — ${connections} connection(s)`;
            ctx.fillStyle = 'rgba(0,0,0,0.8)';
            const tw = ctx.measureText(tooltip).width + 12;
            ctx.fillRect(s.x - tw / 2, s.y + 14 * zoom, tw, 18);
            ctx.fillStyle = '#fff'; ctx.fillText(tooltip, s.x, s.y + 27 * zoom);
        }
    }

    let animationFrameId = null;
    function tick() {
        if (!isRunning) return;
        if (!document.getElementById('dle_graph_canvas')) {
            isRunning = false;
            if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
            return;
        }
        simulate(); draw();
        animationFrameId = requestAnimationFrame(tick);
    }

    // Clean up on popup close via MutationObserver
    // AbortController allows removing all event listeners at once on cleanup
    const listenerAC = new AbortController();
    const popupContainer = canvas.closest('.popup') || container.parentElement || document.body;
    const observer = new MutationObserver(() => {
        if (!document.getElementById('dle_graph_canvas')) {
            isRunning = false;
            if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
            listenerAC.abort(); // Remove all canvas event listeners
            observer.disconnect();
        }
    });
    observer.observe(popupContainer, { childList: true, subtree: true });

    const lOpt = { signal: listenerAC.signal };
    canvas.addEventListener('mousedown', (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const w = toWorld(mx, my);
        let closest = null, closestDist = 20 / zoom;
        for (const n of nodes) {
            const d = Math.sqrt((n.x - w.x) ** 2 + (n.y - w.y) ** 2);
            if (d < closestDist) { closest = n; closestDist = d; }
        }
        if (closest) { dragNode = closest; alpha = Math.max(alpha, 0.5); canvas.style.cursor = 'grabbing'; }
    }, lOpt);
    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        if (dragNode) {
            const w = toWorld(mx, my); dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0;
            alpha = Math.max(alpha, 0.5); // keep simulation active while dragging
        } else {
            const w = toWorld(mx, my);
            let closest = null, closestDist = 15 / zoom;
            for (const n of nodes) {
                const d = Math.sqrt((n.x - w.x) ** 2 + (n.y - w.y) ** 2);
                if (d < closestDist) { closest = n; closestDist = d; }
            }
            hoverNode = closest;
            canvas.style.cursor = closest ? 'pointer' : 'grab';
        }
    }, lOpt);
    canvas.addEventListener('mouseup', () => { dragNode = null; alpha = 0; canvas.style.cursor = 'grab'; }, lOpt);
    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const w = toWorld(mx, my);
        let closest = null, closestDist = 20 / zoom;
        for (const n of nodes) {
            const d = Math.sqrt((n.x - w.x) ** 2 + (n.y - w.y) ** 2);
            if (d < closestDist) { closest = n; closestDist = d; }
        }
        if (closest) {
            closest.pinned = !closest.pinned;
            closest.vx = 0; closest.vy = 0;
        }
    }, lOpt);
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        panX = mx - (mx - panX) * zoomFactor; panY = my - (my - panY) * zoomFactor;
        zoom *= zoomFactor; zoom = Math.max(0.2, Math.min(5, zoom));
    }, { passive: false, signal: listenerAC.signal });
    tick();
}

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
                const fetchResult = await obsidianFetch({ port: optVault.port, apiKey: optVault.apiKey, path: `/vault/${encodeVaultPath(entry.filename)}`, accept: 'text/markdown' });
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

            const data = await writeNote(optVault.port, optVault.apiKey, entry.filename, newContent);
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
