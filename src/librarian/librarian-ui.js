/**
 * DeepLore Enhanced — Librarian UI: Tool Call Dropdown
 * Injects a consolidated "Consulted lore vault" dropdown into assistant messages,
 * styled like ST's native "Thought for X seconds" reasoning block.
 */
import { getSettings } from '../../settings.js';

/**
 * Build the summary text for the dropdown header.
 * @param {Array} toolCalls - Array of tool call records
 * @returns {string}
 */
function buildSummaryText(toolCalls) {
    const searches = toolCalls.filter(c => c.type === 'search').length;
    const flags = toolCalls.filter(c => c.type === 'flag').length;

    const parts = [];
    if (searches > 0) {
        parts.push(`${searches} ${searches === 1 ? 'search' : 'searches'}`);
    }
    if (flags > 0) {
        parts.push(`${flags} ${flags === 1 ? 'flag' : 'flags'}`);
    }

    if (searches > 0 && flags > 0) {
        return `Consulted lore vault (${parts.join(', ')})`;
    }
    if (searches > 0) {
        return `Consulted lore vault (${parts[0]})`;
    }
    return `Flagged ${parts[0].replace(/^\d+ /, (m) => m)}`;
}

/**
 * Build the HTML for a single tool call entry inside the dropdown content.
 * @param {object} call - Tool call record
 * @returns {string}
 */
function buildEntryHtml(call) {
    if (call.type === 'search') {
        const resultText = call.resultCount > 0
            ? `${call.resultCount} ${call.resultCount === 1 ? 'entry' : 'entries'} found (${call.resultTitles.join(', ')})`
            : 'no results';
        return `<div class="dle-librarian-dropdown-entry">
            <span class="dle-librarian-icon fa-solid fa-magnifying-glass"></span>
            <span class="dle-librarian-query">${escapeHtml(call.query)}</span>
            <span class="dle-librarian-result">${escapeHtml(resultText)}</span>
        </div>`;
    }
    // flag
    const urgencyLabel = call.urgency ? ` (${call.urgency})` : '';
    return `<div class="dle-librarian-dropdown-entry">
        <span class="dle-librarian-icon fa-solid fa-flag"></span>
        <span class="dle-librarian-query">${escapeHtml(call.query)}</span>
        <span class="dle-librarian-result">${escapeHtml(urgencyLabel)}</span>
    </div>`;
}

/** Simple HTML escaper */
function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Inject a "Consulted lore vault" dropdown into a chat message.
 * Mirrors ST's reasoning dropdown structure for visual consistency.
 *
 * @param {number} messageId - Chat message index (mesid)
 * @param {Array} toolCalls - Array of tool call records to display
 */
export function injectLibrarianDropdown(messageId, toolCalls) {
    if (!toolCalls || toolCalls.length === 0) return;

    const settings = getSettings();
    if (!settings.librarianShowToolCalls) return;

    const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mesEl) return;

    // Remove existing dropdown before (re)injecting (handles swipes, re-renders)
    const existing = mesEl.querySelector('.dle-librarian-details');
    if (existing) existing.remove();

    const summaryText = buildSummaryText(toolCalls);
    const entriesHtml = toolCalls.map(buildEntryHtml).join('\n');

    const details = document.createElement('details');
    details.className = 'dle-librarian-details';
    details.innerHTML = `
        <summary class="dle-librarian-summary">
            <div class="dle-librarian-header">
                <span class="dle-librarian-icon-header fa-solid fa-book-bookmark"></span>
                <span class="dle-librarian-title">${escapeHtml(summaryText)}</span>
                <div class="dle-librarian-arrow fa-solid fa-chevron-up"></div>
            </div>
        </summary>
        <div class="dle-librarian-content">
            ${entriesHtml}
        </div>
    `;

    // Insert after reasoning details (if present), otherwise before mes_text
    const mesBlock = mesEl.querySelector('.mes_block');
    if (!mesBlock) return;

    const reasoningDetails = mesBlock.querySelector('.mes_reasoning_details');
    const mesText = mesBlock.querySelector('.mes_text');

    if (reasoningDetails) {
        reasoningDetails.after(details);
    } else if (mesText) {
        mesText.before(details);
    } else {
        mesBlock.appendChild(details);
    }
}

/**
 * Remove the librarian dropdown from a chat message (e.g. on swipe).
 * @param {number} messageId - Chat message index (mesid)
 */
export function removeLibrarianDropdown(messageId) {
    const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mesEl) return;
    const existing = mesEl.querySelector('.dle-librarian-details');
    if (existing) existing.remove();
}
