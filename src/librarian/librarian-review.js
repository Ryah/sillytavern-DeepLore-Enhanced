/**
 * DeepLore Enhanced -- Librarian Review Popup
 * Two-panel UI: entry editor (left) + AI chat session (right).
 * Entry points: gap review, new entry, vault review.
 */
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { escapeHtml } from '../../../../../utils.js';
import { yamlEscape, classifyError } from '../../core/utils.js';
import { writeNote } from '../vault/obsidian-api.js';
import { getSettings } from '../../settings.js';
import { loreGaps, setLoreGaps } from '../state.js';
import { buildIndex } from '../vault/vault.js';
import { createSession, sendMessage, updateGapStatus } from './librarian-session.js';

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/** Get the primary vault connection info */
function getPrimaryVault(settings) {
    if (settings.vaults && settings.vaults.length > 0) {
        const v = settings.vaults.find(v => v.enabled) || settings.vaults[0];
        return { host: v.host || 'localhost', port: v.port, apiKey: v.apiKey };
    }
    return { host: 'localhost', port: settings.obsidianPort, apiKey: settings.obsidianApiKey };
}

/** Sanitize a title for use as a filename */
function sanitizeFilename(title) {
    let safe = title.replace(/[<>:"/\\|?*]/g, '_');
    safe = safe.replace(/^\.+|\.+$/g, '');
    safe = safe.trimEnd();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safe)) safe = '_' + safe;
    return safe || 'Untitled';
}

/** Strip Obsidian-interpretable syntax from AI content */
function stripObsidianSyntax(text) {
    return text.replace(/^---$/gm, '- - -');
}

// ════════════════════════════════════════════════════════════════════════════
// Popup HTML
// ════════════════════════════════════════════════════════════════════════════

function buildPopupHTML(session) {
    const draft = session.draftState || {};
    const isReview = session.entryPoint === 'review';
    const isGap = session.entryPoint === 'gap';

    // Initial welcome message for chat
    let welcomeMsg = '';
    if (isGap && session.gapRecord) {
        welcomeMsg = `Gap detected: "${escapeHtml(session.gapRecord.query)}". ${escapeHtml(session.gapRecord.reason || '')} What would you like to do?`;
    } else if (isReview) {
        welcomeMsg = 'Ready to review your vault. Send a message to start, or I can analyze your recent chat for entries that need creating or updating.';
    } else {
        welcomeMsg = 'Ready to help create a new lore entry. Describe what you need, or just say "draft something" and I will get started.';
    }

    return `
<div class="dle-librarian-popup">
    <div class="dle-librarian-editor">
        <h4 class="dle-librarian-editor-title">Entry Editor</h4>
        <div class="dle-librarian-field">
            <label for="dle-lib-title">Title</label>
            <input type="text" id="dle-lib-title" class="text_pole" value="${escapeHtml(draft.title || '')}" placeholder="Entry title">
        </div>
        <div class="dle-librarian-field-row">
            <div class="dle-librarian-field">
                <label for="dle-lib-type">Type</label>
                <select id="dle-lib-type" class="text_pole">
                    <option value="character" ${draft.type === 'character' ? 'selected' : ''}>Character</option>
                    <option value="location" ${draft.type === 'location' ? 'selected' : ''}>Location</option>
                    <option value="lore" ${(!draft.type || draft.type === 'lore') ? 'selected' : ''}>Lore</option>
                    <option value="organization" ${draft.type === 'organization' ? 'selected' : ''}>Organization</option>
                    <option value="story" ${draft.type === 'story' ? 'selected' : ''}>Story</option>
                </select>
            </div>
            <div class="dle-librarian-field">
                <label for="dle-lib-priority">Priority</label>
                <input type="number" id="dle-lib-priority" class="text_pole" min="1" max="100" value="${draft.priority || 50}" placeholder="50">
            </div>
        </div>
        <div class="dle-librarian-field">
            <label>Keys</label>
            <div class="dle-librarian-keys" id="dle-lib-keys">
                ${(draft.keys || []).map(k => `<span class="dle-key-chip">${escapeHtml(k)}<button class="dle-key-remove" data-key="${escapeHtml(k)}" aria-label="Remove key ${escapeHtml(k)}">&times;</button></span>`).join('')}
                <input type="text" class="dle-key-input" id="dle-lib-key-input" placeholder="Add key..." aria-label="Add keyword">
            </div>
        </div>
        <div class="dle-librarian-field">
            <label for="dle-lib-summary">Summary</label>
            <textarea id="dle-lib-summary" class="text_pole" rows="3" placeholder="When should this entry be selected? (for AI retrieval)">${escapeHtml(draft.summary || '')}</textarea>
        </div>
        <div class="dle-librarian-field">
            <label for="dle-lib-content">Content</label>
            <textarea id="dle-lib-content" class="text_pole dle-librarian-content-area" rows="10" placeholder="Entry content (markdown)">${escapeHtml(draft.content || '')}</textarea>
        </div>
        <details class="dle-librarian-frontmatter-preview">
            <summary>Frontmatter preview</summary>
            <pre id="dle-lib-frontmatter" class="dle-librarian-frontmatter-code"></pre>
        </details>
    </div>
    <div class="dle-librarian-chat">
        <h4 class="dle-librarian-chat-title">Librarian</h4>
        <div class="dle-librarian-messages" id="dle-lib-messages">
            <div class="dle-lib-msg dle-lib-msg-ai">${welcomeMsg}</div>
        </div>
        ${isReview && session.workQueue ? `<div class="dle-librarian-queue" id="dle-lib-queue"></div>` : ''}
        <div class="dle-librarian-input-row">
            <input type="text" id="dle-lib-chat-input" class="text_pole" placeholder="Type a message..." aria-label="Chat message">
            <button id="dle-lib-send" class="menu_button" aria-label="Send message">
                <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
            </button>
        </div>
    </div>
</div>`;
}

// ════════════════════════════════════════════════════════════════════════════
// Popup Lifecycle
// ════════════════════════════════════════════════════════════════════════════

/**
 * Open the librarian review popup.
 * @param {'gap'|'new'|'review'} entryPoint
 * @param {object} [options] - Options (e.g. { gap: gapRecord })
 */
export async function openLibrarianPopup(entryPoint = 'new', options = {}) {
    const session = createSession(entryPoint, options);

    // If gap, mark it in-progress
    if (entryPoint === 'gap' && options.gap?.id) {
        updateGapStatus(options.gap.id, 'in_progress');
    }

    const container = document.createElement('div');
    container.innerHTML = buildPopupHTML(session);

    let dirty = false;
    let sending = false;

    const result = await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Write to Vault',
        cancelButton: 'Close',
        onOpen: () => {
            // ─── Editor field sync ───
            const titleInput = container.querySelector('#dle-lib-title');
            const typeSelect = container.querySelector('#dle-lib-type');
            const priorityInput = container.querySelector('#dle-lib-priority');
            const summaryInput = container.querySelector('#dle-lib-summary');
            const contentInput = container.querySelector('#dle-lib-content');
            const frontmatterPre = container.querySelector('#dle-lib-frontmatter');

            function syncDraftFromFields() {
                if (!session.draftState) session.draftState = {};
                session.draftState.title = titleInput.value.trim();
                session.draftState.type = typeSelect.value;
                session.draftState.priority = Number(priorityInput.value) || 50;
                session.draftState.summary = summaryInput.value;
                session.draftState.content = contentInput.value;
                dirty = true;
                updateFrontmatterPreview();
            }

            function updateFieldsFromDraft() {
                if (!session.draftState) return;
                const d = session.draftState;
                if (d.title !== undefined) titleInput.value = d.title;
                if (d.type !== undefined) typeSelect.value = d.type;
                if (d.priority !== undefined) priorityInput.value = d.priority;
                if (d.summary !== undefined) summaryInput.value = d.summary;
                if (d.content !== undefined) contentInput.value = d.content;
                rebuildKeyChips();
                updateFrontmatterPreview();
            }

            function updateFrontmatterPreview() {
                const d = session.draftState || {};
                const settings = getSettings();
                const keysYaml = (d.keys || []).map(k => `  - ${yamlEscape(k)}`).join('\n');
                frontmatterPre.textContent = `---
type: ${yamlEscape(d.type || 'lore')}
priority: ${d.priority || 50}
tags:
  - ${settings.lorebookTag || 'lorebook'}
keys:
${keysYaml || '  - (none)'}
summary: "${(d.summary || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
---`;
            }

            function rebuildKeyChips() {
                const keysContainer = container.querySelector('#dle-lib-keys');
                const input = container.querySelector('#dle-lib-key-input');
                // Remove existing chips but keep the input
                keysContainer.querySelectorAll('.dle-key-chip').forEach(c => c.remove());
                const keys = session.draftState?.keys || [];
                for (const k of keys) {
                    const chip = document.createElement('span');
                    chip.className = 'dle-key-chip';
                    chip.innerHTML = `${escapeHtml(k)}<button class="dle-key-remove" data-key="${escapeHtml(k)}" aria-label="Remove key ${escapeHtml(k)}">&times;</button>`;
                    keysContainer.insertBefore(chip, input);
                }
            }

            // Wire editor field changes
            [titleInput, typeSelect, priorityInput, summaryInput, contentInput].forEach(el => {
                el.addEventListener('input', syncDraftFromFields);
            });

            // Wire key chip add/remove
            const keyInput = container.querySelector('#dle-lib-key-input');
            keyInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && keyInput.value.trim()) {
                    e.preventDefault();
                    if (!session.draftState) session.draftState = {};
                    if (!session.draftState.keys) session.draftState.keys = [];
                    session.draftState.keys.push(keyInput.value.trim());
                    keyInput.value = '';
                    dirty = true;
                    rebuildKeyChips();
                    updateFrontmatterPreview();
                }
            });
            container.querySelector('#dle-lib-keys').addEventListener('click', (e) => {
                const removeBtn = e.target.closest('.dle-key-remove');
                if (removeBtn && session.draftState?.keys) {
                    const key = removeBtn.dataset.key;
                    session.draftState.keys = session.draftState.keys.filter(k => k !== key);
                    dirty = true;
                    rebuildKeyChips();
                    updateFrontmatterPreview();
                }
            });

            // ─── Chat interaction ───
            const messagesDiv = container.querySelector('#dle-lib-messages');
            const chatInput = container.querySelector('#dle-lib-chat-input');
            const sendBtn = container.querySelector('#dle-lib-send');

            function appendMessage(role, content) {
                const div = document.createElement('div');
                div.className = `dle-lib-msg dle-lib-msg-${role}`;
                div.textContent = content;
                messagesDiv.appendChild(div);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            function showLoading(show) {
                if (show) {
                    const spinner = document.createElement('div');
                    spinner.className = 'dle-lib-msg dle-lib-msg-loading';
                    spinner.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Thinking...';
                    spinner.id = 'dle-lib-loading';
                    messagesDiv.appendChild(spinner);
                    messagesDiv.scrollTop = messagesDiv.scrollHeight;
                } else {
                    const el = messagesDiv.querySelector('#dle-lib-loading');
                    if (el) el.remove();
                }
            }

            async function handleSend() {
                const text = chatInput.value.trim();
                if (!text || sending) return;
                sending = true;
                chatInput.value = '';
                appendMessage('user', text);
                showLoading(true);

                try {
                    const response = await sendMessage(session, text);
                    showLoading(false);

                    if (response.valid && response.parsed) {
                        appendMessage('ai', response.parsed.message || '(no message)');
                        // Update editor fields from any draft changes
                        if (response.parsed.draft) {
                            updateFieldsFromDraft();
                            dirty = true;
                        }
                        // Show work queue if proposed
                        if (response.parsed.queue) {
                            renderWorkQueue(container, session, response.parsed.queue);
                        }
                    } else if (response.exhausted) {
                        appendMessage('ai',
                            `I could not produce a valid response after ${3} attempts. `
                            + `Last errors: ${response.lastErrors.join('; ')}. `
                            + `You can try rephrasing your request, or edit the fields manually.`
                        );
                    }
                } catch (err) {
                    showLoading(false);
                    appendMessage('ai', `Error: ${classifyError(err)}`);
                }
                sending = false;
                chatInput.focus();
            }

            sendBtn.addEventListener('click', handleSend);
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                }
            });

            // Initial frontmatter preview
            updateFrontmatterPreview();

            // If gap review, auto-send initial prompt
            if (entryPoint === 'gap' && session.gapRecord) {
                setTimeout(() => {
                    chatInput.value = `Draft an entry for "${session.gapRecord.query}".`;
                    handleSend();
                }, 300);
            }
        },
        onClosing: () => {
            // Warn on unsaved changes (unless writing to vault)
            if (dirty && session.draftState?.title) {
                return confirm('You have unsaved changes. Close without saving?');
            }
            return true;
        },
    });

    // Handle result
    if (result === POPUP_TYPE.TEXT) {
        // "Write to Vault" clicked
        await writeToVault(session);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Write to Vault
// ════════════════════════════════════════════════════════════════════════════

async function writeToVault(session) {
    const settings = getSettings();
    const draft = session.draftState;
    if (!draft || !draft.title) {
        toastr.warning('No draft to write. Fill in the entry fields first.', 'DeepLore Enhanced');
        return;
    }

    const vault = getPrimaryVault(settings);
    const safeTitle = sanitizeFilename(draft.title);
    const folder = settings.autoSuggestFolder || '';
    const filename = folder ? `${folder}/${safeTitle}.md` : `${safeTitle}.md`;

    const keysYaml = (draft.keys || []).map(k => `  - ${yamlEscape(k)}`).join('\n');
    const safeContent = stripObsidianSyntax(draft.content || '');
    const fileContent = `---
type: ${yamlEscape(draft.type || 'lore')}
priority: ${draft.priority || 50}
tags:
  - ${settings.lorebookTag || 'lorebook'}
keys:
${keysYaml}
summary: "${(draft.summary || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
---
# ${draft.title}

${safeContent}`;

    try {
        const data = await writeNote(vault.host, vault.port, vault.apiKey, filename, fileContent);
        if (data.ok) {
            toastr.success(`Created: ${draft.title}`, 'DeepLore Enhanced');

            // Update gap status if applicable
            if (session.gapRecord?.id) {
                updateGapStatus(session.gapRecord.id, 'written');
            }

            // Update analytics
            const s = getSettings();
            if (s.analyticsData._librarian) {
                s.analyticsData._librarian.totalEntriesWritten =
                    (s.analyticsData._librarian.totalEntriesWritten || 0) + 1;
                const stCtx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
                if (stCtx?.saveSettingsDebounced) stCtx.saveSettingsDebounced();
            }

            // Trigger index rebuild
            buildIndex(true);
        } else {
            toastr.error(`Could not create entry: ${data.error || 'Unknown error'}`, 'DeepLore Enhanced');
        }
    } catch (err) {
        toastr.error(classifyError(err), 'DeepLore Enhanced');
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Work Queue (Vault Review)
// ════════════════════════════════════════════════════════════════════════════

function renderWorkQueue(container, session, queue) {
    let queueDiv = container.querySelector('#dle-lib-queue');
    if (!queueDiv) {
        queueDiv = document.createElement('div');
        queueDiv.id = 'dle-lib-queue';
        queueDiv.className = 'dle-librarian-queue';
        const chatDiv = container.querySelector('.dle-librarian-chat');
        const inputRow = container.querySelector('.dle-librarian-input-row');
        chatDiv.insertBefore(queueDiv, inputRow);
    }

    let html = '<div class="dle-lib-queue-header">Work Queue</div>';
    for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        const urgencyClass = item.urgency === 'high' ? 'dle-lib-queue-urgent' : '';
        html += `<div class="dle-lib-queue-item ${urgencyClass}" data-queue-idx="${i}">
            <span class="dle-lib-queue-action">${item.action === 'create' ? '+' : '~'}</span>
            <span class="dle-lib-queue-title">${escapeHtml(item.title)}</span>
            <span class="dle-lib-queue-reason">${escapeHtml(item.reason)}</span>
        </div>`;
    }
    queueDiv.innerHTML = html;

    // Wire queue item clicks
    queueDiv.querySelectorAll('.dle-lib-queue-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = Number(el.dataset.queueIdx);
            const item = queue[idx];
            if (item) {
                // Send a message to the AI to start working on this queue item
                const chatInput = container.querySelector('#dle-lib-chat-input');
                if (chatInput) {
                    chatInput.value = `Draft an entry for "${item.title}" (${item.action}). Reason: ${item.reason}`;
                    container.querySelector('#dle-lib-send')?.click();
                }
            }
        });
    });
}
