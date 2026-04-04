/**
 * DeepLore Enhanced -- Librarian Review Popup
 * Two-panel UI: entry editor (left) + AI chat session (right).
 * Entry points: gap review, new entry, vault review.
 */
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../../../popup.js';
import { escapeHtml } from '../../../../../utils.js';
import { yamlEscape, classifyError } from '../../core/utils.js';
import { stripObsidianSyntax, sanitizeFilename } from '../helpers.js';
import { writeNote } from '../vault/obsidian-api.js';
import { getSettings, getPrimaryVault } from '../../settings.js';
import { loreGaps, setLoreGaps } from '../state.js';
import { buildIndex } from '../vault/vault.js';
import { createSession, sendMessage, editMessage, regenerateResponse, updateGapStatus } from './librarian-session.js';
import { getSessionActivityLog } from './librarian-tools.js';

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════


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

    const settings = getSettings();
    const lorebookTag = settings.lorebookTag || 'lorebook';
    const tagsVal = draft.tags ? draft.tags.join(', ') : lorebookTag;

    return `
<div class="dle-librarian-popup">
    <div class="dle-librarian-editor" role="form" aria-label="Entry editor">
        <h4 class="dle-librarian-editor-title">Entry Editor</h4>
        <div class="dle-librarian-field">
            <label for="dle-lib-title">Title</label>
            <input type="text" id="dle-lib-title" class="text_pole" value="${escapeHtml(draft.title || '')}" placeholder="Entry title">
        </div>
        <div class="dle-librarian-field-row dle-librarian-field-row-3">
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
                <label for="dle-lib-priority">Priority <span class="dle-priority-hint">(20=core 50=std 80=bg)</span></label>
                <input type="number" id="dle-lib-priority" class="text_pole" min="1" max="100" value="${draft.priority || 50}" placeholder="50">
            </div>
            <div class="dle-librarian-field">
                <label for="dle-lib-tags">Tags</label>
                <input type="text" id="dle-lib-tags" class="text_pole" value="${escapeHtml(tagsVal)}" placeholder="${escapeHtml(lorebookTag)}" title="Comma-separated tags. Must include the lorebook tag.">
            </div>
        </div>
        <div class="dle-librarian-field">
            <label>Keys</label>
            <div class="dle-librarian-keys" id="dle-lib-keys">
                ${(draft.keys || []).map(k => `<span class="dle-key-chip">${escapeHtml(k)}<button class="dle-key-remove" data-key="${escapeHtml(k)}" aria-label="Remove key ${escapeHtml(k)}">&times;</button></span>`).join('')}
                <input type="text" class="dle-key-input" id="dle-lib-key-input" placeholder="Add key (Enter or comma)..." aria-label="Add keyword">
            </div>
        </div>
        <div class="dle-librarian-field">
            <label for="dle-lib-summary">Summary <span class="dle-field-hint">(for AI selection, not the writing AI)</span></label>
            <textarea id="dle-lib-summary" class="text_pole" rows="4" placeholder="What is this? When should it be selected? Key relationships?">${escapeHtml(draft.summary || '')}</textarea>
        </div>
        <div class="dle-librarian-field dle-librarian-field-grow">
            <label for="dle-lib-content">Content</label>
            <textarea id="dle-lib-content" class="text_pole dle-librarian-content-area" placeholder="Entry content (markdown with meta-block, prose, [[wikilinks]])">${escapeHtml(draft.content || '')}</textarea>
        </div>
        <div class="dle-librarian-frontmatter-preview" id="dle-lib-frontmatter-wrap">
            <div class="dle-librarian-frontmatter-label" id="dle-lib-frontmatter-toggle" role="button" tabindex="0" aria-expanded="false" aria-controls="dle-lib-frontmatter">
                <i class="fa-solid fa-chevron-right dle-frontmatter-chevron" aria-hidden="true"></i> Frontmatter Preview
            </div>
            <pre id="dle-lib-frontmatter" class="dle-librarian-frontmatter-code"></pre>
        </div>
    </div>
    <div class="dle-librarian-chat" role="region" aria-label="AI assistant">
        <div class="dle-librarian-chat-header">
            <h4 class="dle-librarian-chat-title">Librarian</h4>
            <button class="dle-lib-activity-toggle menu_button_icon" id="dle-lib-activity-btn" title="Toggle activity log" aria-label="Toggle activity log" aria-expanded="false">
                <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>
            </button>
            <button class="menu_button_icon" id="dle-lib-chat-collapse" title="Toggle chat panel" aria-label="Toggle chat panel" aria-expanded="true">
                <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
            </button>
        </div>
        <div class="dle-lib-activity-log" id="dle-lib-activity" hidden aria-label="Tool use activity log"></div>
        <div class="dle-librarian-messages" id="dle-lib-messages" role="log" aria-live="polite">
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
    let writingToVault = false;

    const result = await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wider: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Write to Vault',
        cancelButton: 'Close',
        onOpen: (popup) => {
            // Add custom class for CSS targeting
            if (popup?.dlg) {
                popup.dlg.classList.add('dle-librarian-review');
                // Set writingToVault flag when OK button is clicked (before onClosing fires)
                const okBtn = popup.dlg.querySelector('.popup-button-ok');
                if (okBtn) okBtn.addEventListener('click', () => { writingToVault = true; });
            }

            // ─── Editor field sync ───
            const titleInput = container.querySelector('#dle-lib-title');
            const typeSelect = container.querySelector('#dle-lib-type');
            const priorityInput = container.querySelector('#dle-lib-priority');
            const tagsInput = container.querySelector('#dle-lib-tags');
            const summaryInput = container.querySelector('#dle-lib-summary');
            const contentInput = container.querySelector('#dle-lib-content');
            const frontmatterPre = container.querySelector('#dle-lib-frontmatter');
            const editorTitle = container.querySelector('.dle-librarian-editor-title');

            function updateDirtyIndicator() {
                if (dirty && editorTitle) {
                    editorTitle.textContent = 'Entry Editor \u2022';
                    editorTitle.classList.add('dle-librarian-dirty');
                }
                const ep = container.querySelector('.dle-librarian-editor');
                if (ep) ep.classList.toggle('dle-librarian-editor--dirty', dirty);
            }

            function syncDraftFromFields() {
                if (!session.draftState) session.draftState = {};
                session.draftState.title = titleInput.value.trim();
                session.draftState.type = typeSelect.value;
                session.draftState.priority = Number(priorityInput.value) || 50;
                session.draftState.tags = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
                session.draftState.summary = summaryInput.value;
                session.draftState.content = contentInput.value;
                dirty = true;
                updateDirtyIndicator();
                updateFrontmatterPreview();
            }

            function flashField(el) {
                el.classList.remove('dle-field-updated');
                // Force reflow to restart animation
                void el.offsetWidth;
                el.classList.add('dle-field-updated');
            }

            function updateFieldsFromDraft() {
                if (!session.draftState) return;
                const d = session.draftState;
                if (d.title !== undefined && titleInput.value !== d.title) { titleInput.value = d.title; flashField(titleInput); }
                if (d.type !== undefined && typeSelect.value !== d.type) { typeSelect.value = d.type; flashField(typeSelect); }
                if (d.priority !== undefined && String(priorityInput.value) !== String(d.priority)) { priorityInput.value = d.priority; flashField(priorityInput); }
                if (d.tags !== undefined) { const tv = d.tags.join(', '); if (tagsInput.value !== tv) { tagsInput.value = tv; flashField(tagsInput); } }
                if (d.summary !== undefined && summaryInput.value !== d.summary) { summaryInput.value = d.summary; flashField(summaryInput); }
                if (d.content !== undefined && contentInput.value !== d.content) { contentInput.value = d.content; flashField(contentInput); }
                rebuildKeyChips();
                updateDirtyIndicator();
                updateFrontmatterPreview();
            }

            function updateFrontmatterPreview() {
                const d = session.draftState || {};
                const settings = getSettings();
                const keysYaml = (d.keys || []).map(k => `  - ${yamlEscape(k)}`).join('\n');
                const tags = d.tags?.length ? d.tags : [settings.lorebookTag || 'lorebook'];
                const tagsYaml = tags.map(t => `  - ${yamlEscape(t)}`).join('\n');
                const typeStr = d.type || 'lore';
                const fileClassLine = typeStr !== 'story' ? `fileClass: ${yamlEscape(typeStr)}\n` : '';
                frontmatterPre.textContent = `---
${fileClassLine}type: ${yamlEscape(typeStr)}
status: active
priority: ${d.priority || 50}
tags:
${tagsYaml}
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
            [titleInput, typeSelect, priorityInput, tagsInput, summaryInput, contentInput].forEach(el => {
                el.addEventListener('input', syncDraftFromFields);
            });

            // Wire key chip add/remove
            const keyInput = container.querySelector('#dle-lib-key-input');

            function addKeyFromInput() {
                const val = keyInput.value.trim();
                if (!val) return false;
                if (!session.draftState) session.draftState = {};
                if (!session.draftState.keys) session.draftState.keys = [];
                // Split on comma to support pasting multiple keys
                const newKeys = val.split(',').map(k => k.trim()).filter(Boolean);
                for (const k of newKeys) {
                    if (!session.draftState.keys.includes(k)) {
                        session.draftState.keys.push(k);
                    }
                }
                keyInput.value = '';
                dirty = true;
                rebuildKeyChips();
                updateFrontmatterPreview();
                return true;
            }

            keyInput.addEventListener('keydown', (e) => {
                if ((e.key === 'Enter' || e.key === 'Tab') && keyInput.value.trim()) {
                    e.preventDefault();
                    addKeyFromInput();
                }
                // Comma triggers add (but don't prevent default — the comma char will be caught by input event)
                if (e.key === ',') {
                    // Use timeout so the comma character is in the value before we process
                    setTimeout(() => addKeyFromInput(), 0);
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

            // ─── Frontmatter toggle ───
            const fmToggle = container.querySelector('#dle-lib-frontmatter-toggle');
            const fmWrap = container.querySelector('#dle-lib-frontmatter-wrap');
            if (fmToggle && fmWrap) {
                fmToggle.addEventListener('click', () => {
                    const expanded = fmWrap.classList.toggle('dle-frontmatter-expanded');
                    fmToggle.setAttribute('aria-expanded', String(expanded));
                });
                fmToggle.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fmToggle.click(); }
                });
            }

            // ─── Chat interaction ───
            const messagesDiv = container.querySelector('#dle-lib-messages');
            const chatInput = container.querySelector('#dle-lib-chat-input');
            const sendBtn = container.querySelector('#dle-lib-send');

            /** Track message index for edit/regenerate mapping */
            let msgCounter = 0;

            function appendMessage(role, content) {
                const div = document.createElement('div');
                const msgIdx = msgCounter++;
                div.className = `dle-lib-msg dle-lib-msg-${role}`;
                div.dataset.msgIdx = msgIdx;

                if (role === 'ai') {
                    // Basic markdown rendering for AI messages (safe: escapeHtml first)
                    let html = escapeHtml(content);
                    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
                    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
                    html = html.replace(/\n/g, '<br>');
                    div.innerHTML = `<div class="dle-lib-msg-content">${html}</div>`
                        + `<button class="dle-lib-msg-action dle-lib-msg-regen" title="Regenerate" aria-label="Regenerate response"><i class="fa-solid fa-rotate-right"></i></button>`;
                } else {
                    div.innerHTML = `<div class="dle-lib-msg-content">${escapeHtml(content)}</div>`
                        + `<button class="dle-lib-msg-action dle-lib-msg-edit" title="Edit" aria-label="Edit message"><i class="fa-solid fa-pen"></i></button>`;
                }
                messagesDiv.appendChild(div);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            // Edit user message
            messagesDiv.addEventListener('click', async (e) => {
                const editBtn = e.target.closest('.dle-lib-msg-edit');
                if (!editBtn || sending) return;

                const msgDiv = editBtn.closest('.dle-lib-msg');
                const contentDiv = msgDiv.querySelector('.dle-lib-msg-content');
                const originalText = contentDiv.textContent;

                // Replace content with textarea
                const textarea = document.createElement('textarea');
                textarea.className = 'text_pole dle-lib-msg-edit-area';
                textarea.value = originalText;
                textarea.rows = 3;
                contentDiv.replaceWith(textarea);
                editBtn.style.display = 'none';
                textarea.focus();

                // Submit/cancel buttons
                const btnRow = document.createElement('div');
                btnRow.className = 'dle-lib-msg-edit-btns';
                btnRow.innerHTML = '<button class="menu_button_icon dle-lib-msg-edit-submit" title="Send edited message"><i class="fa-solid fa-check"></i></button>'
                    + '<button class="menu_button_icon dle-lib-msg-edit-cancel" title="Cancel edit"><i class="fa-solid fa-xmark"></i></button>';
                msgDiv.appendChild(btnRow);

                function cancelEdit() {
                    const newContent = document.createElement('div');
                    newContent.className = 'dle-lib-msg-content';
                    newContent.textContent = originalText;
                    textarea.replaceWith(newContent);
                    editBtn.style.display = '';
                    btnRow.remove();
                }

                btnRow.querySelector('.dle-lib-msg-edit-cancel').addEventListener('click', cancelEdit);
                textarea.addEventListener('keydown', (ke) => {
                    if (ke.key === 'Escape') { ke.stopPropagation(); cancelEdit(); }
                    if (ke.key === 'Enter' && ke.ctrlKey) { ke.preventDefault(); btnRow.querySelector('.dle-lib-msg-edit-submit').click(); }
                });

                btnRow.querySelector('.dle-lib-msg-edit-submit').addEventListener('click', async () => {
                    const newText = textarea.value.trim();
                    if (!newText) return;

                    // Find the session message index — count user messages up to this DOM element
                    const allMsgs = [...messagesDiv.querySelectorAll('.dle-lib-msg')];
                    const domIdx = allMsgs.indexOf(msgDiv);
                    // Map to session.messages index (skip welcome msg at index 0)
                    let sessionIdx = -1;
                    let userCount = 0;
                    for (let i = 0; i < session.messages.length; i++) {
                        if (session.messages[i].role === 'user') {
                            // Count DOM user messages before this one
                            if (allMsgs.filter((m, mi) => mi <= domIdx && m.classList.contains('dle-lib-msg-user')).length === userCount + 1) {
                                sessionIdx = i;
                                break;
                            }
                            userCount++;
                        }
                    }

                    // Remove all messages after this one in the DOM
                    while (msgDiv.nextElementSibling) {
                        msgDiv.nextElementSibling.remove();
                    }

                    // Restore the edited message display
                    const newContent = document.createElement('div');
                    newContent.className = 'dle-lib-msg-content';
                    newContent.textContent = newText;
                    textarea.replaceWith(newContent);
                    editBtn.style.display = '';
                    btnRow.remove();
                    newContent.parentElement.querySelector('.dle-lib-msg-content').textContent = newText;

                    // Send edited message
                    sending = true;
                    setSendingUI(true);
                    showLoading(true, 'Calling AI...');

                    try {
                        const response = sessionIdx >= 0
                            ? await editMessage(session, sessionIdx, newText)
                            : await sendMessage(session, newText);
                        showLoading(false);
                        processAIResponse(response);
                    } catch (err) {
                        showLoading(false);
                        appendMessage('ai', `Error: ${classifyError(err)}`);
                    }
                    sending = false;
                    setSendingUI(false);
                });
            });

            // Regenerate AI response
            messagesDiv.addEventListener('click', async (e) => {
                const regenBtn = e.target.closest('.dle-lib-msg-regen');
                if (!regenBtn || sending) return;

                sending = true;
                setSendingUI(true);

                // Mark old response as stale
                const msgDiv = regenBtn.closest('.dle-lib-msg');
                msgDiv.classList.add('dle-lib-msg-stale');

                showLoading(true, 'Regenerating...');

                try {
                    const response = await regenerateResponse(session);
                    showLoading(false);
                    msgDiv.remove();
                    processAIResponse(response);
                } catch (err) {
                    showLoading(false);
                    appendMessage('ai', `Error: ${classifyError(err)}`);
                }
                sending = false;
                setSendingUI(false);
            });

            let loadingTimers = [];
            function showLoading(show, stage = 'Building prompt...') {
                if (show) {
                    // Clear any previous loading state
                    const existing = messagesDiv.querySelector('#dle-lib-loading');
                    if (existing) existing.remove();
                    loadingTimers.forEach(t => clearTimeout(t));
                    loadingTimers = [];

                    const spinner = document.createElement('div');
                    spinner.className = 'dle-lib-msg dle-lib-msg-loading';
                    spinner.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span class="dle-lib-loading-text">${stage}</span>`;
                    spinner.id = 'dle-lib-loading';
                    messagesDiv.appendChild(spinner);
                    messagesDiv.scrollTop = messagesDiv.scrollHeight;

                    // Staged timeout feedback
                    const textEl = spinner.querySelector('.dle-lib-loading-text');
                    loadingTimers.push(setTimeout(() => {
                        if (textEl) textEl.textContent = 'Still waiting...';
                    }, 15000));
                    loadingTimers.push(setTimeout(() => {
                        if (textEl) textEl.textContent = 'Taking longer than usual...';
                    }, 30000));
                } else {
                    loadingTimers.forEach(t => clearTimeout(t));
                    loadingTimers = [];
                    const el = messagesDiv.querySelector('#dle-lib-loading');
                    if (el) el.remove();
                }
            }
            function updateLoadingStage(text) {
                const textEl = messagesDiv.querySelector('#dle-lib-loading .dle-lib-loading-text');
                if (textEl) textEl.textContent = text;
            }

            function setSendingUI(isSending) {
                sendBtn.disabled = isSending;
                chatInput.disabled = isSending;
                const icon = sendBtn.querySelector('i');
                if (icon) icon.className = isSending
                    ? 'fa-solid fa-spinner fa-spin'
                    : 'fa-solid fa-paper-plane';
            }

            /** Shared handler for all AI response types (draft, queue, options, exhaust) */
            function processAIResponse(response) {
                if (response.valid && response.parsed) {
                    appendMessage('ai', response.parsed.message || '(no message)');
                    if (response.parsed.draft) {
                        updateFieldsFromDraft();
                        dirty = true;
                    }
                    if (response.parsed.queue) {
                        renderWorkQueue(container, session, response.parsed.queue);
                    }
                    if (response.parsed.options) {
                        renderOptionsCards(response.parsed.options);
                    }
                } else if (response.exhausted) {
                    const retryNote = response.lastErrors.length > 0
                        ? ` Last errors: ${response.lastErrors.join('; ')}.`
                        : '';
                    appendMessage('ai',
                        `Could not produce a valid response after 3 attempts.${retryNote} `
                        + `Try rephrasing your request, or edit the fields manually.`
                    );
                }
            }

            /** Render options picker cards in the chat panel */
            function renderOptionsCards(options) {
                // Remove any existing options cards
                messagesDiv.querySelectorAll('.dle-lib-options').forEach(el => el.remove());

                const wrap = document.createElement('div');
                wrap.className = 'dle-lib-options';

                for (let i = 0; i < options.length; i++) {
                    const opt = options[i];
                    const card = document.createElement('div');
                    card.className = 'dle-lib-option-card';

                    let fieldsHtml = '';
                    for (const [key, val] of Object.entries(opt.fields || {})) {
                        const display = Array.isArray(val) ? val.join(', ') : String(val);
                        const truncated = display.length > 120 ? display.slice(0, 117) + '...' : display;
                        fieldsHtml += `<div class="dle-lib-option-field"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(truncated)}</div>`;
                    }

                    card.innerHTML = `<div class="dle-lib-option-label">${escapeHtml(opt.label || `Option ${i + 1}`)}</div>`
                        + `<div class="dle-lib-option-fields">${fieldsHtml}</div>`
                        + `<button class="menu_button dle-lib-option-apply" data-option-idx="${i}">Apply This</button>`;
                    wrap.appendChild(card);
                }

                messagesDiv.appendChild(wrap);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;

                // Wire apply buttons
                wrap.addEventListener('click', (e) => {
                    const applyBtn = e.target.closest('.dle-lib-option-apply');
                    if (!applyBtn) return;
                    const idx = parseInt(applyBtn.dataset.optionIdx, 10);
                    const chosen = options[idx];
                    if (!chosen?.fields) return;

                    // Apply chosen fields to draft
                    const filtered = Object.fromEntries(
                        Object.entries(chosen.fields).filter(([, v]) => v != null),
                    );
                    session.draftState = { ...session.draftState, ...filtered };
                    dirty = true;
                    updateFieldsFromDraft();

                    // Remove the options cards
                    wrap.remove();
                    appendMessage('ai', `Applied: ${chosen.label || `Option ${idx + 1}`}`);
                });
            }

            async function handleSend() {
                const text = chatInput.value.trim();
                if (sending) return;
                if (!text) {
                    // Empty message shake
                    chatInput.classList.remove('dle-shake');
                    void chatInput.offsetWidth;
                    chatInput.classList.add('dle-shake');
                    return;
                }
                // /options shortcut: /options 3 keys summary → natural language request
                let finalText = text;
                const optionsMatch = text.match(/^\/options?\s+(\d+)\s+(.+)/i);
                if (optionsMatch) {
                    const count = optionsMatch[1];
                    const fields = optionsMatch[2].trim();
                    finalText = `Propose ${count} alternative options for ${fields}. Use the propose_options response format.`;
                }

                sending = true;
                setSendingUI(true);
                chatInput.value = '';
                appendMessage('user', text);
                showLoading(true, 'Building prompt...');

                try {
                    updateLoadingStage('Calling AI...');
                    const response = await sendMessage(session, finalText);
                    if (!sending) {
                        // Cancelled while waiting
                        showLoading(false);
                        return;
                    }
                    updateLoadingStage('Validating response...');
                    showLoading(false);
                    processAIResponse(response);
                } catch (err) {
                    showLoading(false);
                    appendMessage('ai', `Error: ${classifyError(err)}`);
                }
                sending = false;
                setSendingUI(false);
                chatInput.focus();
            }

            sendBtn.addEventListener('click', handleSend);
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                }
                // Ctrl+Enter also sends
                if (e.key === 'Enter' && e.ctrlKey) {
                    e.preventDefault();
                    handleSend();
                }
                // Escape: don't let popup close, just blur
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    chatInput.blur();
                }
            });
            // Ctrl+S anywhere in popup → Write to Vault
            container.addEventListener('keydown', (e) => {
                if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    const okBtn = popup?.dlg?.querySelector('.popup-button-ok');
                    if (okBtn) okBtn.click();
                }
            });

            // Initial frontmatter preview
            updateFrontmatterPreview();

            // ─── Activity log toggle ───
            const activityBtn = container.querySelector('#dle-lib-activity-btn');
            const activityPanel = container.querySelector('#dle-lib-activity');

            function renderActivityLog() {
                const log = getSessionActivityLog();
                if (log.length === 0) {
                    activityPanel.innerHTML = '<div class="dle-lib-activity-empty">No tool activity recorded this session.</div>';
                    return;
                }

                // Summary line
                const searches = log.filter(e => e.type === 'search').length;
                const flags = log.filter(e => e.type === 'flag').length;
                const totalTokens = log.reduce((sum, e) => sum + (e.tokens || 0), 0);
                let html = `<div class="dle-lib-activity-summary">${searches} search${searches !== 1 ? 'es' : ''}, ${flags} flag${flags !== 1 ? 's' : ''}, ~${totalTokens} tokens this session</div>`;

                // Group by generation
                const byGen = new Map();
                for (const entry of log) {
                    const gen = entry.generation || 0;
                    if (!byGen.has(gen)) byGen.set(gen, []);
                    byGen.get(gen).push(entry);
                }

                // Render groups (newest generation first)
                const genKeys = [...byGen.keys()].sort((a, b) => b - a);
                for (const gen of genKeys) {
                    const entries = byGen.get(gen);
                    html += `<div class="dle-lib-activity-gen-label">Gen #${gen}</div>`;
                    for (const entry of entries) {
                        const icon = entry.type === 'search'
                            ? '<i class="fa-solid fa-magnifying-glass"></i>'
                            : '<i class="fa-solid fa-flag"></i>';
                        const results = entry.type === 'search'
                            ? `${entry.resultCount} result${entry.resultCount !== 1 ? 's' : ''}`
                            : '';
                        const tokens = entry.tokens ? `~${entry.tokens}tok` : '';
                        html += `<div class="dle-lib-activity-row">`;
                        html += `<span class="dle-lib-activity-icon">${icon}</span>`;
                        html += `<span class="dle-lib-activity-query">${escapeHtml(entry.query || '')}</span>`;
                        html += `<span class="dle-lib-activity-result">${results}</span>`;
                        html += `<span class="dle-lib-activity-tokens">${tokens}</span>`;
                        html += `</div>`;
                    }
                }
                activityPanel.innerHTML = html;
            }

            activityBtn.addEventListener('click', () => {
                const expanded = activityPanel.hidden;
                activityPanel.hidden = !expanded;
                activityBtn.setAttribute('aria-expanded', String(expanded));
                if (expanded) renderActivityLog();
            });

            // ─── Chat panel collapse toggle ───
            const collapseBtn = container.querySelector('#dle-lib-chat-collapse');
            const popupEl = container.querySelector('.dle-librarian-popup');
            const chatPanel = container.querySelector('.dle-librarian-chat');

            function setChatCollapsed(collapsed) {
                popupEl.classList.toggle('dle-librarian-chat-collapsed', collapsed);
                collapseBtn.setAttribute('aria-expanded', String(!collapsed));
                const icon = collapseBtn.querySelector('i');
                if (icon) icon.className = collapsed
                    ? 'fa-solid fa-chevron-left'
                    : 'fa-solid fa-chevron-right';
                try { localStorage.setItem('dle-librarian-panel-state', collapsed ? 'collapsed' : 'both'); } catch {}
            }

            // Restore saved state
            try {
                if (localStorage.getItem('dle-librarian-panel-state') === 'collapsed') {
                    setChatCollapsed(true);
                }
            } catch {}

            collapseBtn.addEventListener('click', () => {
                const isCollapsed = popupEl.classList.contains('dle-librarian-chat-collapsed');
                setChatCollapsed(!isCollapsed);
            });

            // If gap review and auto-send enabled, send initial prompt
            if (entryPoint === 'gap' && session.gapRecord && getSettings().librarianAutoSendOnGap !== false) {
                session._autoSendTimer = setTimeout(() => {
                    chatInput.value = `Draft an entry for "${session.gapRecord.query}".`;
                    handleSend();
                }, 300);
            }
        },
        onClosing: async () => {
            // Clear auto-send timer to prevent wasted API call
            if (session._autoSendTimer) clearTimeout(session._autoSendTimer);
            // Skip discard prompt when writing to vault (OK button was clicked)
            if (writingToVault) return true;
            // Warn on unsaved changes when closing without writing
            if (dirty && session.draftState?.title) {
                const confirmResult = await callGenericPopup(
                    'You have unsaved changes. Discard them?',
                    POPUP_TYPE.CONFIRM,
                );
                return confirmResult === POPUP_RESULT.AFFIRMATIVE;
            }
            return true;
        },
    });

    // Handle result
    if (result === POPUP_RESULT.AFFIRMATIVE) {
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
    const folder = settings.librarianWriteFolder || settings.autoSuggestFolder || '';
    const filename = folder ? `${folder}/${safeTitle}.md` : `${safeTitle}.md`;

    const keysYaml = (draft.keys || []).map(k => `  - ${yamlEscape(k)}`).join('\n');
    const tags = draft.tags?.length ? draft.tags : [settings.lorebookTag || 'lorebook'];
    const tagsYaml = tags.map(t => `  - ${yamlEscape(t)}`).join('\n');
    const typeStr = draft.type || 'lore';
    const fileClassLine = typeStr !== 'story' ? `fileClass: ${yamlEscape(typeStr)}\n` : '';
    const safeContent = stripObsidianSyntax(draft.content || '');
    const fileContent = `---
${fileClassLine}type: ${yamlEscape(typeStr)}
status: active
priority: ${draft.priority || 50}
tags:
${tagsYaml}
keys:
${keysYaml}
summary: "${(draft.summary || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
---
# ${draft.title}

${safeContent}`;

    // Preview before writing
    const previewHtml = document.createElement('div');
    previewHtml.innerHTML = `<div style="margin-bottom:8px"><strong>File:</strong> <code>${escapeHtml(filename)}</code></div>`
        + `<pre style="max-height:400px;overflow-y:auto;font-size:11px;padding:8px;background:var(--SmartThemeBlurTintColor);border-radius:4px;white-space:pre-wrap;word-break:break-word">${escapeHtml(fileContent)}</pre>`;
    const confirmWrite = await callGenericPopup(previewHtml, POPUP_TYPE.CONFIRM, '', {
        wider: true,
        allowVerticalScrolling: true,
        okButton: 'Write',
        cancelButton: 'Cancel',
    });
    if (confirmWrite !== POPUP_RESULT.AFFIRMATIVE) return;

    try {
        const data = await writeNote(vault.host, vault.port, vault.apiKey, filename, fileContent);
        if (data.ok) {
            toastr.success(`Created: ${draft.title} (${filename})`, 'DeepLore Enhanced');

            // Update gap status if applicable
            if (session.gapRecord?.id) {
                updateGapStatus(session.gapRecord.id, 'written');
            }

            // Update analytics
            const s = getSettings();
            if (!s.analyticsData._librarian) {
                s.analyticsData._librarian = {
                    totalGapSearches: 0, totalGapFlags: 0,
                    totalEntriesWritten: 0, totalEntriesUpdated: 0,
                    topUnmetQueries: [],
                };
            }
            s.analyticsData._librarian.totalEntriesWritten =
                (s.analyticsData._librarian.totalEntriesWritten || 0) + 1;
            const stCtx = getContext();
            if (stCtx?.saveSettingsDebounced) stCtx.saveSettingsDebounced();

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
