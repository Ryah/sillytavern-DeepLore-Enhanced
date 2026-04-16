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
import { getContext } from '../../../../../extensions.js';
import { accountStorage } from '../../../../../util/AccountStorage.js';
import { loreGaps, setLoreGaps } from '../state.js';
import { buildIndex } from '../vault/vault.js';
import { createSession, sendMessage, editMessage, regenerateResponse, updateGapStatus, saveSessionState, loadSessionState, clearSessionState, restoreSession, pickFlavorIntro } from './librarian-session.js';
import { getSessionActivityLog, buildLibrarianActivityFeed } from './librarian-tools.js';

const emmaAvatarUrl = new URL('../../assets/companions/Emma-STChar.png', import.meta.url).href;

// ════════════════════════════════════════════════════════════════════════════
// Helpers — Unified document format
// ════════════════════════════════════════════════════════════════════════════

/**
 * Serialize a draft state object into a full Obsidian-style document string.
 * Format: YAML frontmatter block + markdown content.
 */
function formatEntryAsDocument(draft, settings) {
    if (!draft) draft = {};
    const s = settings || getSettings();
    const typeStr = draft.type || 'lore';
    const tags = draft.tags?.length ? draft.tags : [s.lorebookTag || 'lorebook'];
    const keys = draft.keys || [];
    const priority = draft.priority || 50;
    const summary = (draft.summary || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

    const fileClassLine = typeStr !== 'story' ? `fileClass: ${yamlEscape(typeStr)}\n` : '';
    const tagsYaml = tags.map(t => `  - ${yamlEscape(t)}`).join('\n');
    const keysYaml = keys.length ? keys.map(k => `  - ${yamlEscape(k)}`).join('\n') : '  - ';

    let doc = `---\n${fileClassLine}type: ${yamlEscape(typeStr)}\nstatus: active\npriority: ${priority}\ntags:\n${tagsYaml}\nkeys:\n${keysYaml}\nsummary: "${summary}"\n---`;

    if (draft.title || draft.content) {
        doc += `\n# ${draft.title || 'Untitled'}\n\n${draft.content || ''}`;
    }
    return doc;
}

/**
 * Parse a unified document string back into draft state fields.
 * Extracts YAML frontmatter and markdown content.
 */
function parseEntryDocument(text) {
    const draft = {};
    if (!text || !text.trim()) return draft;

    // Extract frontmatter
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
    let body = text;
    if (fmMatch) {
        const yaml = fmMatch[1];
        body = text.slice(fmMatch[0].length).trim();

        // Parse simple YAML fields
        const typeMatch = yaml.match(/^type:\s*(.+)$/m);
        if (typeMatch) draft.type = typeMatch[1].trim();

        const priorityMatch = yaml.match(/^priority:\s*(\d+)/m);
        if (priorityMatch) draft.priority = parseInt(priorityMatch[1], 10);

        const summaryMatch = yaml.match(/^summary:\s*"((?:[^"\\]|\\.)*)"/m);
        if (summaryMatch) {
            draft.summary = summaryMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }

        // Parse tags array
        const tagsSection = yaml.match(/^tags:\n((?:\s+-\s+.+\n?)*)/m);
        if (tagsSection) {
            draft.tags = tagsSection[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
        }

        // Parse keys array
        const keysSection = yaml.match(/^keys:\n((?:\s+-\s+.+\n?)*)/m);
        if (keysSection) {
            draft.keys = keysSection[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
        }
    }

    // Extract title from first heading
    const titleMatch = body.match(/^#\s+(.+)$/m);
    if (titleMatch) {
        draft.title = titleMatch[1].trim();
        body = body.slice(body.indexOf(titleMatch[0]) + titleMatch[0].length).trim();
    }

    draft.content = body;
    return draft;
}


// ════════════════════════════════════════════════════════════════════════════
// Popup HTML
// ════════════════════════════════════════════════════════════════════════════

function buildPopupHTML(session) {
    const draft = session.draftState || {};
    const isReview = session.entryPoint === 'review';
    const isGap = session.entryPoint === 'gap';

    const isAudit = session.entryPoint === 'audit';

    // Initial welcome message for chat
    let welcomeMsg = '';
    if (isGap && session.gapRecord) {
        if (session.gapRecord.subtype === 'update' && session.gapRecord.entryTitle) {
            welcomeMsg = `*shuffles papers* So "<b>${escapeHtml(session.gapRecord.entryTitle)}</b>" needs updating. ${escapeHtml(session.gapRecord.reason || '')} Let me pull it up and see what's changed.`;
        } else {
            welcomeMsg = `*shuffles papers* So your vault name-drops "<b>${escapeHtml(session.gapRecord.query)}</b>" but nobody bothered to write the entry. ${escapeHtml(session.gapRecord.reason || '')} Classic. Tell me what you want, or I'll just start drafting.`;
        }
    } else if (isReview) {
        welcomeMsg = `*leans back, flips through your vault* Alright, let's see what kind of mess we're working with. Send me a direction or I'll start pulling threads from your recent chat.`;
    } else if (isAudit) {
        // Audit uses seeded greeting from session — this is a fallback
        welcomeMsg = escapeHtml(session.messages?.[0]?.content || 'Audit mode. Pulling up the vault and recent chat now.');
    } else {
        // Empty 'new' session — Emma greets with a random flavor intro
        welcomeMsg = escapeHtml(pickFlavorIntro());
    }

    const initialDoc = formatEntryAsDocument(draft, getSettings());

    return `
<div class="dle-librarian-popup">
    <div class="dle-librarian-editor" role="form" aria-label="Entry editor">
        <h4 class="dle-librarian-editor-title">Entry Editor</h4>
        <textarea id="dle-lib-unified" class="text_pole dle-librarian-unified-textarea" spellcheck="false" placeholder="---${'\n'}type: lore${'\n'}priority: 50${'\n'}tags:${'\n'}  - lorebook${'\n'}keys:${'\n'}  - keyword${'\n'}summary: &quot;What this is and when to select it&quot;${'\n'}---${'\n'}# Entry Title${'\n'}${'\n'}Content goes here...">${escapeHtml(initialDoc)}</textarea>
    </div>
    <div class="dle-librarian-chat" role="region" aria-label="AI assistant">
        <div class="dle-librarian-chat-header">
            <h4 class="dle-librarian-chat-title">Emma <span class="dle-librarian-chat-subtitle">the Librarian</span></h4>
            <button class="menu_button_icon" id="dle-lib-clear-chat" title="Clear chat history" aria-label="Clear chat history">
                <i class="fa-solid fa-eraser" aria-hidden="true"></i>
            </button>
            <button class="dle-lib-activity-toggle menu_button_icon" id="dle-lib-activity-btn" title="Toggle activity log" aria-label="Toggle activity log" aria-expanded="false">
                <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>
            </button>
            <button class="menu_button_icon" id="dle-lib-chat-collapse" title="Toggle chat panel" aria-label="Toggle chat panel" aria-expanded="true">
                <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
            </button>
        </div>
        <div class="dle-lib-activity-log" id="dle-lib-activity" hidden aria-label="Tool use activity log"></div>
        <div class="dle-librarian-messages" id="dle-lib-messages" role="log" aria-live="polite">
            <div class="dle-lib-msg dle-lib-msg-ai"><img class="dle-lib-avatar" src="${emmaAvatarUrl}" alt=""><div class="dle-lib-msg-content">${welcomeMsg}</div></div>
            <div class="dle-lib-status-line" id="dle-lib-status-line" aria-live="polite" hidden></div>
        </div>
        ${(isReview || isAudit) && session.workQueue ? `<div class="dle-librarian-queue" id="dle-lib-queue"></div>` : ''}
        <div class="dle-librarian-input-row">
            <textarea id="dle-lib-chat-input" class="text_pole" rows="1" placeholder="Ask Emma anything..." aria-label="Chat message"></textarea>
            <button id="dle-lib-send" class="menu_button" aria-label="Send message">
                <i class="fa-solid fa-paper-plane" aria-hidden="true"></i>
            </button>
            <button id="dle-lib-stop" class="menu_button dle-lib-stop-btn" style="display:none" aria-label="Stop generation">
                <i class="fa-solid fa-stop" aria-hidden="true"></i>
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
 * @param {'gap'|'new'|'review'|'audit'} entryPoint
 * @param {object} [options] - Options (e.g. { gap: gapRecord })
 */
export async function openLibrarianPopup(entryPoint = 'new', options = {}) {
    // Allow openLibrarianPopup(null, { mode: 'guide-firstrun' }) — guide modes default entryPoint to 'new'.
    if (entryPoint === null || entryPoint === undefined) entryPoint = 'new';
    const isGuideMode = options.mode === 'guide-firstrun' || options.mode === 'guide-adhoc';

    // Check for saved session from a previous page refresh
    let session;
    let isRestored = false;
    const saved = loadSessionState();
    const STALE_MS = 4 * 60 * 60 * 1000; // 4 hours
    const isStale = saved?.savedAt && (Date.now() - saved.savedAt) > STALE_MS;
    // Guide mode always starts fresh — never resume into a different conversation.
    if (!isGuideMode && saved && saved.messages?.length > 0 && !isStale) {
        const resume = await callGenericPopup(
            'You have a previous Librarian session in progress. Resume where you left off?',
            POPUP_TYPE.CONFIRM,
            '', { okButton: 'Resume', cancelButton: 'Start Fresh' },
        );
        if (resume === POPUP_RESULT.AFFIRMATIVE) {
            session = restoreSession(saved);
            isRestored = true;
        } else {
            clearSessionState();
            session = createSession(entryPoint, options);
        }
    } else {
        if (isStale) clearSessionState();
        session = createSession(entryPoint, options);
    }

    // (v2) Do NOT mark gap as in_progress on popup open — that left a stuck
    // spinner on the row when the popup was closed without writing.
    // Status flips to 'written' on successful confirm/write instead.

    const container = document.createElement('div');
    container.innerHTML = buildPopupHTML(session);

    let dirty = false;
    let sending = false;
    let _saveTimer = null;
    // Track whether there are edits since the last successful write.
    // Starts false; any field edit sets true; successful write clears it.
    let dirtySinceLastWrite = false;
    let hasWrittenOnce = false;

    // BUG-236/254/255: Lifted to outer scope so onClosing can abort in-flight calls
    // when the popup is dismissed (X / Escape / Close), and so buildSendOptions can
    // abort the previous controller before creating a new one (kills the rapid-resend
    // race where the first call became un-stoppable).
    let abortController = null;

    const result = await callGenericPopup(container, POPUP_TYPE.TEXT, '', {
        wider: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Close',
        cancelButton: false,
        onOpen: (popup) => {
            // Add custom class for CSS targeting
            if (popup?.dlg) {
                popup.dlg.classList.add('dle-librarian-review');
            }

            // Inject "Write to Vault" button + status into the popup's own button row,
            // sitting next to the Close button at the bottom of the popup chrome.
            let writeBtn = null;
            let writeStatusEl = null;
            try {
                const dlg = popup?.dlg;
                const controls = dlg?.querySelector('.popup-controls');
                const okBtn = controls?.querySelector('.popup-button-ok');
                if (controls && okBtn) {
                    const wrap = document.createElement('div');
                    wrap.className = 'dle-librarian-write-action';
                    wrap.innerHTML = `
                        <span id="dle-lib-write-status" class="dle-lib-write-status" aria-live="polite"></span>
                        <button type="button" id="dle-lib-write-btn" class="menu_button interactable" title="Write entry to Obsidian vault (Ctrl+S)">
                            <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i><span>Write to Vault</span>
                        </button>
                    `;
                    controls.insertBefore(wrap, okBtn);
                    writeBtn = wrap.querySelector('#dle-lib-write-btn');
                    writeStatusEl = wrap.querySelector('#dle-lib-write-status');
                }
            } catch (_) { /* fallback below */ }
            // Fallback: if injection failed for any reason, look in the container
            if (!writeBtn) writeBtn = container.querySelector('#dle-lib-write-btn');
            if (!writeStatusEl) writeStatusEl = container.querySelector('#dle-lib-write-status');
            if (writeBtn) {
                writeBtn.addEventListener('click', async () => {
                    writeBtn.disabled = true;
                    try {
                        const wrote = await writeToVault(session, { statusEl: writeStatusEl });
                        if (wrote) {
                            dirtySinceLastWrite = false;
                            hasWrittenOnce = true;
                        }
                    } finally {
                        writeBtn.disabled = false;
                    }
                });
            }

            // Focus the unified textarea on open
            requestAnimationFrame(() => {
                const ta = container.querySelector('#dle-lib-unified');
                if (ta) ta.focus();
            });

            // ─── Unified editor sync ───
            const unifiedTextarea = container.querySelector('#dle-lib-unified');
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
                const parsed = parseEntryDocument(unifiedTextarea.value);
                session.draftState = { ...session.draftState, ...parsed };
                // The unified textarea IS the frontmatter — user always owns it
                session.frontmatterUserEdited = true;
                session.frontmatterOverride = unifiedTextarea.value.match(/^---\n[\s\S]*?\n---/)?.[0] || '';
                dirty = true;
                dirtySinceLastWrite = true;
                updateDirtyIndicator();
                debouncedSaveSession();
            }

            function flashField() {
                unifiedTextarea.classList.remove('dle-field-updated');
                void unifiedTextarea.offsetWidth;
                unifiedTextarea.classList.add('dle-field-updated');
            }

            function updateFieldsFromDraft() {
                const _debug = getSettings().debugMode;
                if (!session.draftState) { if (_debug) console.debug('[DLE] updateFieldsFromDraft: no draftState'); return; }
                const newDoc = formatEntryAsDocument(session.draftState, getSettings());
                if (_debug) console.debug('[DLE] updateFieldsFromDraft:', {
                    draftKeys: Object.keys(session.draftState),
                    hasTitle: !!session.draftState.title,
                    hasContent: !!session.draftState.content,
                    newDocLen: newDoc.length,
                    currentLen: unifiedTextarea.value.length,
                    willUpdate: unifiedTextarea.value !== newDoc,
                });
                if (unifiedTextarea.value !== newDoc) {
                    // Preserve cursor position
                    const pos = unifiedTextarea.selectionStart;
                    unifiedTextarea.value = newDoc;
                    unifiedTextarea.selectionStart = unifiedTextarea.selectionEnd = Math.min(pos, newDoc.length);
                    flashField();
                }
                updateDirtyIndicator();
            }

            // Wire unified textarea changes
            unifiedTextarea.addEventListener('input', syncDraftFromFields);

            // ─── Chat interaction ───
            const messagesDiv = container.querySelector('#dle-lib-messages');
            const chatInput = container.querySelector('#dle-lib-chat-input');
            const sendBtn = container.querySelector('#dle-lib-send');
            const stopBtn = container.querySelector('#dle-lib-stop');
            // abortController lifted to outer openLibrarianPopup scope for onClosing access.

            /** Track message index for edit/regenerate mapping */
            let msgCounter = 0;

            function appendMessage(role, content) {
                // Track unread AI messages while chat is collapsed
                if (role === 'ai' && popupEl.classList.contains('dle-librarian-chat-collapsed')) {
                    _chatUnreadCount++;
                    updateUnreadBadge();
                }
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
                    div.innerHTML = `<img class="dle-lib-avatar" src="${emmaAvatarUrl}" alt="">`
                        + `<div class="dle-lib-msg-content">${html}</div>`
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
                    // (redundant write removed — newContent already has textContent set above)

                    // Send edited message
                    sending = true;
                    setSendingUI(true);
                    showLoading(true, 'Calling AI...');
                    const editOpts = buildSendOptions();

                    try {
                        const response = sessionIdx >= 0
                            ? await editMessage(session, sessionIdx, newText, editOpts)
                            : await sendMessage(session, newText, editOpts);
                        showLoading(false);
                        processAIResponse(response);
                    } catch (err) {
                        showLoading(false);
                        if (err.name !== 'AbortError') {
                            appendMessage('ai', `Error: ${classifyError(err)}`);
                        }
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
                const regenOpts = buildSendOptions();

                try {
                    const response = await regenerateResponse(session, regenOpts);
                    showLoading(false);
                    msgDiv.remove();
                    processAIResponse(response);
                } catch (err) {
                    showLoading(false);
                    if (err.name !== 'AbortError') {
                        appendMessage('ai', `Error: ${classifyError(err)}`);
                    }
                }
                sending = false;
                setSendingUI(false);
            });

            // Loading state is shown via the status line (see setSendingUI). The old
            // in-chat spinner was redundant with it, so showLoading/updateLoadingStage
            // are no-ops kept for call-site compatibility.
            function showLoading(_show, _stage) { /* no-op */ }
            function updateLoadingStage(_text) { /* no-op */ }

            function setSendingUI(isSending) {
                chatInput.disabled = isSending;
                sendBtn.style.display = isSending ? 'none' : '';
                stopBtn.style.display = isSending ? '' : 'none';
                const chatMessages = container.querySelector('#dle-lib-chat-messages');
                if (chatMessages) chatMessages.setAttribute('aria-busy', isSending ? 'true' : 'false');
                const statusLine = container.querySelector('#dle-lib-status-line');
                if (statusLine) {
                    if (isSending) {
                        statusLine.textContent = 'Emma is consulting the stacks';
                        statusLine.classList.add('dle-lib-status-thinking');
                        statusLine.hidden = false;
                        const cm = container.querySelector('#dle-lib-chat-messages');
                        if (cm) cm.scrollTop = cm.scrollHeight;
                    } else {
                        statusLine.classList.remove('dle-lib-status-thinking');
                        statusLine.hidden = true;
                        statusLine.textContent = '';
                    }
                }
            }

            // ─── Stop button ───
            stopBtn.addEventListener('click', () => {
                if (abortController) abortController.abort();
                sending = false;
                setSendingUI(false);
                showLoading(false);
                appendMessage('ai', '*(Stopped by user)*');
            });

            // ─── Tool activity helpers ───
            const TOOL_DISPLAY_NAMES = {
                search_vault: 'Searching vault',
                get_entry: 'Reading entry',
                get_full_content: 'Loading full entry',
                get_links: 'Checking links',
                get_backlinks: 'Checking backlinks',
                find_similar: 'Finding similar entries',
                list_flags: 'Checking flags',
                list_entries: 'Listing entries',
                get_recent_chat: 'Reading recent chat',
                flag_entry_update: 'Flagging for update',
                compare_entry_to_chat: 'Comparing to chat',
                get_writing_guide: 'Reading guide',
            };
            function toolDisplayName(name, args) {
                const friendly = TOOL_DISPLAY_NAMES[name] || name;
                const subject = args?.title || args?.query || '';
                return subject ? `${friendly}: ${subject}` : friendly;
            }

            /** Track tool divs created during a single turn for collapsing */
            let turnToolDivs = [];

            function appendToolActivity(name, args) {
                const div = document.createElement('div');
                div.className = 'dle-lib-msg dle-lib-msg-tool';
                div.dataset.toolName = name;
                const label = toolDisplayName(name, args);
                div.innerHTML = `<div class="dle-lib-tool-header" role="button" tabindex="0" aria-expanded="false">`
                    + `<i class="fa-solid fa-wrench"></i> ${escapeHtml(label)}`
                    + ` <i class="fa-solid fa-spinner fa-spin dle-lib-tool-spinner"></i>`
                    + `</div>`
                    + `<div class="dle-lib-tool-result" hidden></div>`;
                // BUG-184: mouse + keyboard toggle
                const _toolHdr = div.querySelector('.dle-lib-tool-header');
                const _toggleTool = () => {
                    const resultDiv = div.querySelector('.dle-lib-tool-result');
                    resultDiv.hidden = !resultDiv.hidden;
                    _toolHdr.setAttribute('aria-expanded', String(!resultDiv.hidden));
                };
                _toolHdr.addEventListener('click', _toggleTool);
                _toolHdr.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _toggleTool(); }
                });
                // Insert before the loading spinner so it stays at the bottom
                const loadingEl = messagesDiv.querySelector('#dle-lib-loading');
                if (loadingEl) {
                    messagesDiv.insertBefore(div, loadingEl);
                } else {
                    messagesDiv.appendChild(div);
                }
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
                turnToolDivs.push(div);
                return div;
            }

            function completeToolActivity(toolDiv, result) {
                const spinner = toolDiv.querySelector('.dle-lib-tool-spinner');
                if (spinner) spinner.remove();
                const resultDiv = toolDiv.querySelector('.dle-lib-tool-result');
                if (resultDiv) {
                    resultDiv.textContent = result.length > 500 ? result.slice(0, 497) + '...' : result;
                }
            }

            /** Collapse all tool divs from this turn into a single summary line */
            function collapseToolActivity() {
                if (turnToolDivs.length === 0) return;
                // Count tool calls by friendly name
                const counts = {};
                for (const div of turnToolDivs) {
                    const name = TOOL_DISPLAY_NAMES[div.dataset.toolName] || div.dataset.toolName || 'tool';
                    counts[name] = (counts[name] || 0) + 1;
                }
                const summary = Object.entries(counts).map(([n, c]) => c > 1 ? `${n} x${c}` : n).join(', ');

                // Create collapsed summary node
                const wrap = document.createElement('div');
                wrap.className = 'dle-lib-msg dle-lib-msg-tool dle-lib-tool-collapsed';
                wrap.innerHTML = `<div class="dle-lib-tool-header" role="button" tabindex="0" aria-expanded="false">`
                    + `<i class="fa-solid fa-wrench"></i> ${escapeHtml(summary)}`
                    + ` <i class="fa-solid fa-chevron-down dle-lib-tool-expand-icon"></i>`
                    + `</div>`
                    + `<div class="dle-lib-tool-expanded" hidden></div>`;

                // Move all individual tool divs inside the expandable area
                const expandArea = wrap.querySelector('.dle-lib-tool-expanded');
                for (const div of turnToolDivs) {
                    div.remove();
                    expandArea.appendChild(div);
                }

                // BUG-184: mouse + keyboard toggle
                const _collHdr = wrap.querySelector('.dle-lib-tool-header');
                const _toggleCollapsed = () => {
                    const expanded = expandArea.hidden;
                    expandArea.hidden = !expanded;
                    _collHdr.setAttribute('aria-expanded', String(expanded));
                    const icon = wrap.querySelector('.dle-lib-tool-expand-icon');
                    if (icon) icon.className = expanded
                        ? 'fa-solid fa-chevron-up dle-lib-tool-expand-icon'
                        : 'fa-solid fa-chevron-down dle-lib-tool-expand-icon';
                };
                _collHdr.addEventListener('click', _toggleCollapsed);
                _collHdr.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _toggleCollapsed(); }
                });

                // Insert before the last AI message (or append)
                const lastAiMsg = messagesDiv.querySelector('.dle-lib-msg-ai:last-of-type');
                if (lastAiMsg) {
                    messagesDiv.insertBefore(wrap, lastAiMsg);
                } else {
                    messagesDiv.appendChild(wrap);
                }

                turnToolDivs = [];
            }

            /** Build sendMessage options with signal and tool callbacks */
            function buildSendOptions() {
                // BUG-254/255: Abort any prior in-flight controller before replacing it,
                // otherwise the prior call's listener still references the stale controller
                // and the user can't stop it.
                if (abortController) { try { abortController.abort(); } catch { /* noop */ } }
                abortController = new AbortController();
                turnToolDivs = [];
                let currentToolDiv = null;
                return {
                    signal: abortController.signal,
                    onToolCall: (name, args) => {
                        currentToolDiv = appendToolActivity(name, args);
                        updateLoadingStage(`Running ${name}...`);
                    },
                    onToolResult: (name, result) => {
                        if (currentToolDiv) completeToolActivity(currentToolDiv, result);
                        currentToolDiv = null;
                        // get_full_content directly populates session.draftState —
                        // update the editor immediately so the user sees it
                        if (name === 'get_full_content') {
                            updateFieldsFromDraft();
                            dirty = true;
                            dirtySinceLastWrite = true;
                        }
                    },
                };
            }

            /** Shared handler for all AI response types (draft, queue, options, exhaust) */
            function processAIResponse(response) {
                // Collapse tool activity from this turn before adding the AI's response
                collapseToolActivity();
                if (getSettings().debugMode) console.debug('[DLE] processAIResponse:', { valid: response.valid, hasParsed: !!response.parsed, hasDraft: !!response.parsed?.draft, draftType: typeof response.parsed?.draft, exhausted: response.exhausted });

                if (response.valid && response.parsed) {
                    appendMessage('ai', response.parsed.message || '(no message)');
                    if (response.parsed.draft) {
                        if (getSettings().debugMode) console.debug('[DLE] processAIResponse: draft update received, fields:', Object.keys(response.parsed.draft));
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
                debouncedSaveSession();
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

                // Dismiss button at the bottom
                const dismissBtn = document.createElement('button');
                dismissBtn.className = 'menu_button dle-lib-option-dismiss';
                dismissBtn.textContent = 'Dismiss';
                dismissBtn.addEventListener('click', () => {
                    // Abort any in-flight call
                    if (abortController) abortController.abort();
                    sending = false;
                    setSendingUI(false);
                    showLoading(false);
                    wrap.remove();
                    appendMessage('ai', '*(Options dismissed)*');
                });
                wrap.appendChild(dismissBtn);

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
                chatInput.style.height = 'auto';
                appendMessage('user', text);
                showLoading(true, 'Preparing...');
                const opts = buildSendOptions();
                // BUG-240/243: capture this send's controller identity. If the user stops
                // this call and starts a new one before the old promise resolves, the late
                // handler must NOT clobber the new request's sending/UI state.
                const myController = abortController;
                const isStillMine = () => abortController === myController;

                try {
                    updateLoadingStage('Calling AI...');
                    const response = await sendMessage(session, finalText, opts);
                    if (!isStillMine()) { showLoading(false); return; }
                    if (!sending) {
                        showLoading(false);
                        return;
                    }
                    updateLoadingStage('Validating response...');
                    showLoading(false);
                    processAIResponse(response);
                } catch (err) {
                    if (!isStillMine()) return;
                    showLoading(false);
                    if (err.name !== 'AbortError') {
                        appendMessage('ai', `Error: ${classifyError(err)}`);
                    }
                }
                if (!isStillMine()) return;
                sending = false;
                setSendingUI(false);
                chatInput.focus();
            }

            sendBtn.addEventListener('click', handleSend);
            // Auto-resize chat textarea as user types
            function autoResizeChatInput() {
                chatInput.style.height = 'auto';
                chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
            }
            chatInput.addEventListener('input', autoResizeChatInput);
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
            // Ctrl+S anywhere in popup → Write to Vault (inline, does not close popup)
            container.addEventListener('keydown', (e) => {
                if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    // Button now lives in popup chrome, not container — use document scope
                    const btn = document.querySelector('.dle-librarian-review #dle-lib-write-btn')
                        || container.querySelector('#dle-lib-write-btn');
                    if (btn && !btn.disabled) btn.click();
                }
            });

            // ─── Clear chat ───
            const clearChatBtn = container.querySelector('#dle-lib-clear-chat');
            clearChatBtn.addEventListener('click', () => {
                // Abort any in-flight call
                if (abortController) abortController.abort();
                sending = false;
                setSendingUI(false);
                showLoading(false);

                // Clear session messages but keep draft state
                session.messages = [];
                msgCounter = 0;

                // Clear DOM — re-add welcome message
                messagesDiv.innerHTML = '';
                const welcomeDiv = document.createElement('div');
                welcomeDiv.className = 'dle-lib-msg dle-lib-msg-ai';
                welcomeDiv.innerHTML = `<img class="dle-lib-avatar" src="${emmaAvatarUrl}" alt=""><div class="dle-lib-msg-content"><em>*dusts off the desk*</em> Clean slate. What are we working on?</div>`;
                messagesDiv.appendChild(welcomeDiv);

                // Remove any options cards or queue
                messagesDiv.querySelectorAll('.dle-lib-options').forEach(el => el.remove());

                debouncedSaveSession();
                chatInput.focus();
            });

            // ─── Activity log toggle ───
            const activityBtn = container.querySelector('#dle-lib-activity-btn');
            const activityPanel = container.querySelector('#dle-lib-activity');

            function renderActivityLog() {
                // v2: combined feed (session tool calls + persistent search gaps)
                const feed = buildLibrarianActivityFeed();
                if (feed.length === 0) {
                    activityPanel.innerHTML = '<div class="dle-lib-activity-empty">No tool activity recorded yet.</div>';
                    return;
                }
                const session = getSessionActivityLog();
                const searches = session.filter(e => e.type === 'search').length;
                const flags = session.filter(e => e.type === 'flag').length;
                const totalTokens = session.reduce((sum, e) => sum + (e.tokens || 0), 0);
                let html = `<div class="dle-lib-activity-summary">${searches} search${searches !== 1 ? 'es' : ''}, ${flags} flag${flags !== 1 ? 's' : ''}, ~${totalTokens} tokens this session</div>`;

                for (const item of feed) {
                    const icon = item.kind === 'tool-search'
                        ? '<i class="fa-solid fa-magnifying-glass" aria-hidden="true" title="Search"></i>'
                        : item.kind === 'tool-flag'
                            ? '<i class="fa-solid fa-flag" aria-hidden="true" title="Flag"></i>'
                            : item.kind === 'gap-search'
                                ? '<i class="fa-solid fa-magnifying-glass" aria-hidden="true" title="Search (no results)"></i>'
                                : '<i class="fa-solid fa-flag" aria-hidden="true" title="Flag"></i>';
                    const meta = item.kind === 'gap-search'
                        ? 'no results'
                        : item.type === 'search'
                            ? `${item.resultCount} result${item.resultCount !== 1 ? 's' : ''}`
                            : (item.urgency || '');
                    const tokens = item.tokens ? `~${item.tokens}tok` : '';
                    html += `<div class="dle-lib-activity-row">`;
                    html += `<span class="dle-lib-activity-icon">${icon}</span>`;
                    html += `<span class="dle-lib-activity-query">${escapeHtml(item.query || '')}</span>`;
                    html += `<span class="dle-lib-activity-result">${escapeHtml(meta)}</span>`;
                    html += `<span class="dle-lib-activity-tokens">${tokens}</span>`;
                    html += `</div>`;
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

            let _chatUnreadCount = 0;
            function updateUnreadBadge() {
                let badge = collapseBtn.querySelector('.dle-chat-unread');
                if (_chatUnreadCount > 0) {
                    if (!badge) {
                        badge = document.createElement('span');
                        badge.className = 'dle-chat-unread';
                        collapseBtn.appendChild(badge);
                    }
                    badge.textContent = _chatUnreadCount;
                } else if (badge) {
                    badge.remove();
                }
            }

            function setChatCollapsed(collapsed) {
                popupEl.classList.toggle('dle-librarian-chat-collapsed', collapsed);
                collapseBtn.setAttribute('aria-expanded', String(!collapsed));
                const icon = collapseBtn.querySelector('i');
                if (icon) icon.className = collapsed
                    ? 'fa-solid fa-chevron-left'
                    : 'fa-solid fa-chevron-right';
                if (!collapsed) { _chatUnreadCount = 0; updateUnreadBadge(); }
                // BUG-042: accountStorage for cross-browser sync
                try { accountStorage.setItem('dle-librarian-panel-state', collapsed ? 'collapsed' : 'both'); } catch {}
            }

            // Restore saved state (BUG-042: migrate legacy localStorage)
            try {
                let state = accountStorage.getItem('dle-librarian-panel-state');
                if (!state) {
                    const legacy = localStorage.getItem('dle-librarian-panel-state');
                    if (legacy) {
                        accountStorage.setItem('dle-librarian-panel-state', legacy);
                        localStorage.removeItem('dle-librarian-panel-state');
                        state = legacy;
                    }
                }
                if (state === 'collapsed') setChatCollapsed(true);
            } catch {}

            collapseBtn.addEventListener('click', () => {
                const isCollapsed = popupEl.classList.contains('dle-librarian-chat-collapsed');
                setChatCollapsed(!isCollapsed);
            });

            // ─── Session persistence ───
            function debouncedSaveSession() {
                clearTimeout(_saveTimer);
                _saveTimer = setTimeout(() => saveSessionState(session), 500);
            }

            // ─── Restore session from saved state ───
            if (isRestored) {
                // Replay messages to DOM
                for (const msg of session.messages) {
                    if (msg.role === 'tool_result') {
                        // Render tool results as collapsed tool nodes
                        const div = document.createElement('div');
                        div.className = 'dle-lib-msg dle-lib-msg-tool';
                        div.innerHTML = `<div class="dle-lib-tool-header" role="button" tabindex="0" aria-expanded="false">`
                            + `<i class="fa-solid fa-wrench"></i> Tool Results`
                            + `</div>`
                            + `<div class="dle-lib-tool-result" hidden></div>`;
                        const resultDiv = div.querySelector('.dle-lib-tool-result');
                        resultDiv.textContent = msg.content.length > 500 ? msg.content.slice(0, 497) + '...' : msg.content;
                        // BUG-184: mouse + keyboard
                        const _hdr = div.querySelector('.dle-lib-tool-header');
                        const _tog = () => {
                            resultDiv.hidden = !resultDiv.hidden;
                            _hdr.setAttribute('aria-expanded', String(!resultDiv.hidden));
                        };
                        _hdr.addEventListener('click', _tog);
                        _hdr.addEventListener('keydown', (e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _tog(); }
                        });
                        messagesDiv.appendChild(div);
                    } else {
                        appendMessage(msg.role === 'user' ? 'user' : 'ai', msg.content);
                    }
                }
                // Restore draft fields to editor
                if (session.draftState) {
                    dirty = true;
                    updateFieldsFromDraft();
                    updateDirtyIndicator();
                }
                // Restore work queue
                if (session.workQueue?.length) {
                    renderWorkQueue(container, session, session.workQueue);
                }
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
            }

            // If gap review and auto-send enabled, send initial prompt (skip if restored)
            if (!isRestored && entryPoint === 'gap' && session.gapRecord && getSettings().librarianAutoSendOnGap !== false) {
                const isUpdate = session.gapRecord.subtype === 'update' && session.gapRecord.entryTitle;
                session._autoSendTimer = setTimeout(() => {
                    chatInput.value = isUpdate
                        ? `Review and update the entry for "${session.gapRecord.entryTitle}". Context: ${session.gapRecord.reason || session.gapRecord.query}`
                        : `Draft an entry for "${session.gapRecord.query}".`;
                    handleSend();
                }, 300);
            }
            // Auto-send for audit mode — kick off the systematic review
            if (!isRestored && entryPoint === 'audit') {
                session._autoSendTimer = setTimeout(() => {
                    chatInput.value = 'Begin the audit. Pull the recent chat, cross-reference with vault entries, and flag anything stale or contradicted.';
                    handleSend();
                }, 300);
            }
        },
        onClosing: async () => {
            // BUG-236: Abort any in-flight Librarian AI call when the popup is dismissed
            // (X button / Escape / Close). Without this, the call keeps burning tokens
            // until the provider returns, and any resulting history mutation becomes
            // a ghost write against a closed session.
            if (abortController) { try { abortController.abort(); } catch { /* noop */ } }
            // Clear auto-send timer to prevent wasted API call
            if (session._autoSendTimer) clearTimeout(session._autoSendTimer);
            clearTimeout(_saveTimer);
            // Only prompt if there is unwritten work — i.e. edits that were never written.
            // Writing to vault clears dirtySinceLastWrite, so a freshly-written session closes silently.
            const hasContent = session.draftState?.title || session.draftState?.summary || session.draftState?.content || (session.draftState?.keys?.length > 0);
            if (dirtySinceLastWrite && hasContent) {
                const confirmResult = await callGenericPopup(
                    hasWrittenOnce
                        ? 'You have changes since your last write. Discard them, or keep the session for later?'
                        : 'You have unsaved changes. Discard draft, or keep session for later?',
                    POPUP_TYPE.CONFIRM,
                    '', { okButton: 'Discard', cancelButton: 'Keep for Later' },
                );
                if (confirmResult === POPUP_RESULT.AFFIRMATIVE) {
                    clearSessionState();
                    return true;
                }
                // "Keep for Later" — save and close
                saveSessionState(session);
                return true;
            }
            // No unsaved changes — clear saved state
            clearSessionState();
            return true;
        },
    });
    // Note: the popup only has a Close button now. Writing happens via the
    // in-popup "Write to Vault" button, which opens a nested confirm dialog
    // and leaves the Librarian popup open after completion.
}

// ════════════════════════════════════════════════════════════════════════════
// Write to Vault
// ════════════════════════════════════════════════════════════════════════════

async function writeToVault(session, opts = {}) {
    const statusEl = opts.statusEl || null;
    const setStatus = (text, kind) => {
        if (!statusEl) return;
        statusEl.textContent = text || '';
        statusEl.classList.remove('dle-lib-write-status--ok', 'dle-lib-write-status--err');
        if (kind === 'ok') statusEl.classList.add('dle-lib-write-status--ok');
        if (kind === 'err') statusEl.classList.add('dle-lib-write-status--err');
    };
    const settings = getSettings();
    const draft = session.draftState;
    if (!draft || !draft.title) {
        toastr.warning('No draft to write. Fill in the entry fields first.', 'DeepLore Enhanced');
        setStatus('Needs a title.', 'err');
        return false;
    }

    // Validation warning: no trigger keys means the entry won't match in chat
    if (!draft.keys?.length) {
        const proceed = await callGenericPopup(
            'This entry has no trigger keys, so it won\'t match in chat unless it\'s a constant. Write anyway?',
            POPUP_TYPE.CONFIRM,
            '', { okButton: 'Write Anyway', cancelButton: 'Go Back' },
        );
        if (proceed !== POPUP_RESULT.AFFIRMATIVE) return false;
    }

    const vault = getPrimaryVault(settings);
    const safeTitle = sanitizeFilename(draft.title);
    const folder = settings.librarianWriteFolder || settings.autoSuggestFolder || '';
    const filename = folder ? `${folder}/${safeTitle}.md` : `${safeTitle}.md`;

    const tags = draft.tags?.length ? draft.tags : [settings.lorebookTag || 'lorebook'];
    const typeStr = draft.type || 'lore';
    const safeContent = stripObsidianSyntax(draft.content || '');
    let frontmatterBlock;
    if (session.frontmatterUserEdited && typeof session.frontmatterOverride === 'string' && session.frontmatterOverride.trim()) {
        // Honor the user's hand-edited frontmatter verbatim. They own it now.
        frontmatterBlock = session.frontmatterOverride.trim();
    } else {
        const keysYaml = (draft.keys || []).map(k => `  - ${yamlEscape(k)}`).join('\n');
        const tagsYaml = tags.map(t => `  - ${yamlEscape(t)}`).join('\n');
        const fileClassLine = typeStr !== 'story' ? `fileClass: ${yamlEscape(typeStr)}\n` : '';
        frontmatterBlock = `---\n${fileClassLine}type: ${yamlEscape(typeStr)}\nstatus: active\npriority: ${draft.priority || 50}\ntags:\n${tagsYaml}\nkeys:\n${keysYaml}\nsummary: "${(draft.summary || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"\n---`;
    }
    const fileContent = `${frontmatterBlock}\n# ${draft.title}\n\n${safeContent}`;

    // Preview before writing — nested dialog stacked over the Librarian popup
    const lineCount = fileContent.split('\n').length;
    const byteCount = new Blob([fileContent]).size;
    const tagsPreview = tags.join(', ');
    const previewHtml = document.createElement('div');
    previewHtml.innerHTML = `<h3 style="margin:0 0 8px 0;">Write entry to vault?</h3>`
        + `<div style="margin-bottom:6px"><strong>File:</strong> <code>${escapeHtml(filename)}</code></div>`
        + `<div style="margin-bottom:6px;font-size:11px;opacity:0.85;">`
        + `<strong>Title:</strong> ${escapeHtml(draft.title)} &nbsp; `
        + `<strong>Type:</strong> ${escapeHtml(typeStr)} &nbsp; `
        + `<strong>Priority:</strong> ${draft.priority || 50} &nbsp; `
        + `<strong>Keys:</strong> ${(draft.keys || []).length} &nbsp; `
        + `<strong>Tags:</strong> ${escapeHtml(tagsPreview)} &nbsp; `
        + `<strong>${lineCount} lines / ${byteCount} bytes</strong>`
        + `</div>`
        + `<pre style="max-height:360px;overflow-y:auto;font-size:11px;padding:8px;background:var(--SmartThemeBlurTintColor);border-radius:4px;white-space:pre-wrap;word-break:break-word">${escapeHtml(fileContent)}</pre>`;
    const confirmWrite = await callGenericPopup(previewHtml, POPUP_TYPE.CONFIRM, '', {
        wider: true,
        allowVerticalScrolling: true,
        okButton: 'Write',
        cancelButton: 'Cancel',
    });
    if (confirmWrite !== POPUP_RESULT.AFFIRMATIVE) {
        setStatus('Write cancelled.', null);
        return false;
    }

    try {
        const data = await writeNote(vault.host, vault.port, vault.apiKey, filename, fileContent, !!vault.https);
        if (data.ok) {
            toastr.success(`Created: ${draft.title} (${filename})`, 'DeepLore Enhanced');
            setStatus(`Written to ${filename}`, 'ok');

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
            buildIndex(true).catch(err => console.warn('[DLE] Post-write index rebuild failed:', err.message));
            return true;
        } else {
            console.warn('[DLE] Librarian write failed:', data && data.error);
            toastr.error('Couldn\'t save that entry to your vault.', 'DeepLore Enhanced');
            setStatus('Write failed.', 'err');
            return false;
        }
    } catch (err) {
        toastr.error(classifyError(err), 'DeepLore Enhanced');
        setStatus('Write failed.', 'err');
        return false;
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

    const MAX_QUEUE_ITEMS = 5;
    const capped = queue.slice(0, MAX_QUEUE_ITEMS);
    let html = '<div class="dle-lib-queue-header">Suggestions — click to draft</div>';
    for (let i = 0; i < capped.length; i++) {
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
