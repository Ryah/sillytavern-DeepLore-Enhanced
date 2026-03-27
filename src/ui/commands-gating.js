/**
 * DeepLore Enhanced — Slash Commands: Per-Chat Gating
 * /dle-pin, /dle-unpin, /dle-block, /dle-unblock, /dle-pins,
 * /dle-set-era, /dle-set-location, /dle-set-scene, /dle-set-characters, /dle-context-state
 */
import { chat_metadata } from '../../../../../../script.js';
import { saveChatDebounced } from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { vaultIndex, notifyGatingChanged, notifyPinBlockChanged } from '../state.js';
import { ensureIndexFresh } from '../vault/vault.js';

export function registerGatingCommands() {
    // ── Per-Chat Pin/Block Commands ──

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-pin',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.info('Usage: /dle-pin <entry name>', 'DeepLore Enhanced'); return ''; }
            await ensureIndexFresh();
            const entry = vaultIndex.find(e => e.title.toLowerCase() === name.toLowerCase());
            if (!entry) { toastr.warning(`Entry "${name}" not found in vault.`, 'DeepLore Enhanced'); return ''; }
            if (!chat_metadata.deeplore_pins) chat_metadata.deeplore_pins = [];
            if (chat_metadata.deeplore_pins.some(t => t.toLowerCase() === entry.title.toLowerCase())) {
                toastr.info(`"${entry.title}" is already pinned.`, 'DeepLore Enhanced'); return '';
            }
            // Remove from blocks if present
            if (chat_metadata.deeplore_blocks) {
                chat_metadata.deeplore_blocks = chat_metadata.deeplore_blocks.filter(t => t.toLowerCase() !== entry.title.toLowerCase());
            }
            chat_metadata.deeplore_pins.push(entry.title);
            saveChatDebounced();
            notifyPinBlockChanged();
            toastr.success(`Pinned "${entry.title}" for this chat.`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Pin an entry so it always injects in this chat. Usage: /dle-pin <entry name>.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-unpin',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.info('Usage: /dle-unpin <entry name>', 'DeepLore Enhanced'); return ''; }
            if (!chat_metadata.deeplore_pins || chat_metadata.deeplore_pins.length === 0) {
                toastr.info('No pinned entries.', 'DeepLore Enhanced'); return '';
            }
            const idx = chat_metadata.deeplore_pins.findIndex(t => t.toLowerCase() === name.toLowerCase());
            if (idx === -1) { toastr.info(`"${name}" is not pinned.`, 'DeepLore Enhanced'); return ''; }
            const removed = chat_metadata.deeplore_pins.splice(idx, 1)[0];
            saveChatDebounced();
            notifyPinBlockChanged();
            toastr.success(`Unpinned "${removed}".`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Remove a per-chat pin. Usage: /dle-unpin <entry name>.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-block',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.info('Usage: /dle-block <entry name>', 'DeepLore Enhanced'); return ''; }
            await ensureIndexFresh();
            const entry = vaultIndex.find(e => e.title.toLowerCase() === name.toLowerCase());
            if (!entry) { toastr.warning(`Entry "${name}" not found in vault.`, 'DeepLore Enhanced'); return ''; }
            if (!chat_metadata.deeplore_blocks) chat_metadata.deeplore_blocks = [];
            if (chat_metadata.deeplore_blocks.some(t => t.toLowerCase() === entry.title.toLowerCase())) {
                toastr.info(`"${entry.title}" is already blocked.`, 'DeepLore Enhanced'); return '';
            }
            // Remove from pins if present
            if (chat_metadata.deeplore_pins) {
                chat_metadata.deeplore_pins = chat_metadata.deeplore_pins.filter(t => t.toLowerCase() !== entry.title.toLowerCase());
            }
            chat_metadata.deeplore_blocks.push(entry.title);
            saveChatDebounced();
            notifyPinBlockChanged();
            toastr.success(`Blocked "${entry.title}" for this chat.`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Block an entry so it never injects in this chat. Usage: /dle-block <entry name>.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-unblock',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.info('Usage: /dle-unblock <entry name>', 'DeepLore Enhanced'); return ''; }
            if (!chat_metadata.deeplore_blocks || chat_metadata.deeplore_blocks.length === 0) {
                toastr.info('No blocked entries.', 'DeepLore Enhanced'); return '';
            }
            const idx = chat_metadata.deeplore_blocks.findIndex(t => t.toLowerCase() === name.toLowerCase());
            if (idx === -1) { toastr.info(`"${name}" is not blocked.`, 'DeepLore Enhanced'); return ''; }
            const removed = chat_metadata.deeplore_blocks.splice(idx, 1)[0];
            saveChatDebounced();
            notifyPinBlockChanged();
            toastr.success(`Unblocked "${removed}".`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Remove a per-chat block. Usage: /dle-unblock <entry name>.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-pins',
        callback: async () => {
            const pins = chat_metadata.deeplore_pins || [];
            const blocks = chat_metadata.deeplore_blocks || [];
            if (pins.length === 0 && blocks.length === 0) {
                toastr.info('No per-chat pins or blocks.', 'DeepLore Enhanced');
                return '';
            }
            let html = '<div class="dle-popup">';
            if (pins.length > 0) {
                html += `<h4>Pinned (${pins.length})</h4><ul>`;
                for (const p of pins) html += `<li class="dle-success">${escapeHtml(p)}</li>`;
                html += '</ul>';
            }
            if (blocks.length > 0) {
                html += `<h4>Blocked (${blocks.length})</h4><ul>`;
                for (const b of blocks) html += `<li class="dle-error">${escapeHtml(b)}</li>`;
                html += '</ul>';
            }
            html += '</div>';
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: false });
            return '';
        },
        helpString: 'Show all per-chat pinned and blocked entries.',
        returns: 'Pins/blocks popup',
    }));

    // ── Contextual Gating Commands ──

    /** Helper: initialize deeplore_context in chat_metadata if needed */
    const ensureCtx = () => {
        if (!chat_metadata.deeplore_context) chat_metadata.deeplore_context = {};
        return chat_metadata.deeplore_context;
    };

    /**
     * Helper: collect unique values for a gating field from the vault index.
     * Returns a Map<normalizedValue, { display: string, count: number }>.
     */
    const collectFieldValues = (entryField) => {
        const valueMap = new Map();
        for (const entry of vaultIndex) {
            const arr = entry[entryField];
            if (!Array.isArray(arr)) continue;
            for (const raw of arr) {
                const key = raw.toLowerCase().trim();
                if (!key) continue;
                if (valueMap.has(key)) {
                    valueMap.get(key).count++;
                } else {
                    valueMap.set(key, { display: raw.trim(), count: 1 });
                }
            }
        }
        return valueMap;
    };

    /**
     * Helper: count entries matching a value for a gating field (case-insensitive substring).
     */
    const countFieldMatches = (entryField, value) => {
        const lower = value.toLowerCase();
        let count = 0;
        for (const entry of vaultIndex) {
            const arr = entry[entryField];
            if (!Array.isArray(arr)) continue;
            if (arr.some(v => v.toLowerCase().includes(lower) || lower.includes(v.toLowerCase()))) {
                count++;
            }
        }
        return count;
    };

    /**
     * Helper: build and show a selection popup for a gating field.
     */
    const showFieldSelectionPopup = async (label, entryField, ctxField) => {
        const ctx = ensureCtx();
        const valueMap = collectFieldValues(entryField);

        if (valueMap.size === 0) {
            await callGenericPopup(
                `<div class="dle-popup"><p>No entries have a <strong>${label.toLowerCase()}</strong> field set.</p></div>`,
                POPUP_TYPE.TEXT, '', { wide: false },
            );
            return;
        }

        // Sort by count descending, then alphabetically
        const sorted = [...valueMap.entries()].sort((a, b) => b[1].count - a[1].count || a[1].display.localeCompare(b[1].display));

        const currentValue = ctx[ctxField] || '';
        let html = `<div class="dle-popup"><h4>Select ${label}</h4>`;
        if (currentValue) {
            html += `<p style="margin-bottom:8px;">Current: <strong>${escapeHtml(currentValue)}</strong></p>`;
        }
        html += '<div style="display:flex;flex-direction:column;gap:4px;">';
        html += `<button class="menu_button dle-field-select" data-value="" style="display:flex;justify-content:space-between;align-items:center;width:100%;">Clear filter</button>`;
        for (const [, { display, count }] of sorted) {
            const isActive = currentValue.toLowerCase() === display.toLowerCase();
            const activeStyle = isActive ? 'font-weight:bold;border-left:3px solid var(--dle-success, #4caf50);padding-left:8px;' : '';
            html += `<button class="menu_button dle-field-select" data-value="${escapeHtml(display)}" style="display:flex;justify-content:space-between;align-items:center;width:100%;${activeStyle}">${escapeHtml(display)}<span style="font-size:11px;opacity:0.5;margin-left:auto;padding-left:8px;">${count} ${count === 1 ? 'entry' : 'entries'}</span></button>`;
        }
        html += '</div></div>';

        // Show popup and wire up click handlers via event delegation
        const promise = callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: false });

        // After DOM renders, attach click handlers
        await new Promise(r => setTimeout(r, 50));
        const buttons = document.querySelectorAll('.dle-field-select');
        for (const btn of buttons) {
            btn.addEventListener('click', () => {
                const selected = btn.getAttribute('data-value');
                ctx[ctxField] = selected;
                saveChatDebounced();
                notifyGatingChanged();
                if (selected) {
                    toastr.success(`${label} set to "${selected}" for this chat.`, 'DeepLore Enhanced');
                } else {
                    toastr.success(`${label} cleared.`, 'DeepLore Enhanced');
                }
                // Close the popup
                document.querySelector('.popup-button-ok')?.click();
            });
        }

        await promise;
    };

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-era',
        callback: async (_args, value) => {
            const v = (value || '').trim();

            // No argument — show selection popup
            if (!v) {
                await showFieldSelectionPopup('Era', 'era', 'era');
                return '';
            }

            // With argument — set directly with match feedback
            const ctx = ensureCtx();
            ctx.era = v;
            saveChatDebounced();
            notifyGatingChanged();

            const matchCount = countFieldMatches('era', v);
            if (matchCount === 0) {
                const valueMap = collectFieldValues('era');
                const available = [...valueMap.values()].map(x => x.display);
                const listStr = available.length > 0 ? available.join(', ') : 'none';
                await callGenericPopup(
                    `<div class="dle-popup"><p>Era set to <strong>"${escapeHtml(v)}"</strong> — <span class="dle-warning">no entries match</span>.</p><p>Available eras: ${escapeHtml(listStr)}</p></div>`,
                    POPUP_TYPE.TEXT, '', { wide: false },
                );
            } else {
                toastr.success(`Era set to "${v}" — ${matchCount} ${matchCount === 1 ? 'entry matches' : 'entries match'}.`, 'DeepLore Enhanced');
            }
            return '';
        },
        helpString: 'Set the current era for contextual gating. Usage: /dle-set-era <era>. Run without args to browse available values.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-location',
        callback: async (_args, value) => {
            const v = (value || '').trim();

            if (!v) {
                await showFieldSelectionPopup('Location', 'location', 'location');
                return '';
            }

            const ctx = ensureCtx();
            ctx.location = v;
            saveChatDebounced();
            notifyGatingChanged();

            const matchCount = countFieldMatches('location', v);
            if (matchCount === 0) {
                const valueMap = collectFieldValues('location');
                const available = [...valueMap.values()].map(x => x.display);
                const listStr = available.length > 0 ? available.join(', ') : 'none';
                await callGenericPopup(
                    `<div class="dle-popup"><p>Location set to <strong>"${escapeHtml(v)}"</strong> — <span class="dle-warning">no entries match</span>.</p><p>Available locations: ${escapeHtml(listStr)}</p></div>`,
                    POPUP_TYPE.TEXT, '', { wide: false },
                );
            } else {
                toastr.success(`Location set to "${v}" — ${matchCount} ${matchCount === 1 ? 'entry matches' : 'entries match'}.`, 'DeepLore Enhanced');
            }
            return '';
        },
        helpString: 'Set the current location for contextual gating. Usage: /dle-set-location <location>. Run without args to browse available values.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-scene',
        callback: async (_args, value) => {
            const v = (value || '').trim();

            if (!v) {
                await showFieldSelectionPopup('Scene Type', 'sceneType', 'scene_type');
                return '';
            }

            const ctx = ensureCtx();
            ctx.scene_type = v;
            saveChatDebounced();
            notifyGatingChanged();

            const matchCount = countFieldMatches('sceneType', v);
            if (matchCount === 0) {
                const valueMap = collectFieldValues('sceneType');
                const available = [...valueMap.values()].map(x => x.display);
                const listStr = available.length > 0 ? available.join(', ') : 'none';
                await callGenericPopup(
                    `<div class="dle-popup"><p>Scene type set to <strong>"${escapeHtml(v)}"</strong> — <span class="dle-warning">no entries match</span>.</p><p>Available scene types: ${escapeHtml(listStr)}</p></div>`,
                    POPUP_TYPE.TEXT, '', { wide: false },
                );
            } else {
                toastr.success(`Scene type set to "${v}" — ${matchCount} ${matchCount === 1 ? 'entry matches' : 'entries match'}.`, 'DeepLore Enhanced');
            }
            return '';
        },
        helpString: 'Set the current scene type for contextual gating. Usage: /dle-set-scene <type>. Run without args to browse available values.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-characters',
        callback: async (_args, value) => {
            const ctx = ensureCtx();
            const v = (value || '').trim();
            if (!v) {
                ctx.characters_present = [];
                saveChatDebounced();
                notifyGatingChanged();
                toastr.success('Present characters cleared.', 'DeepLore Enhanced');
                return '';
            }
            ctx.characters_present = v.split(',').map(c => c.trim()).filter(Boolean);
            saveChatDebounced();
            notifyGatingChanged();
            toastr.success(`Characters present: ${ctx.characters_present.join(', ')}`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Set which characters are present for contextual gating. Usage: /dle-set-characters <name1, name2>. Run without args to clear.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-context-state',
        callback: async () => {
            const ctx = chat_metadata.deeplore_context || {};
            const lines = [
                `Era: ${ctx.era || '(not set)'}`,
                `Location: ${ctx.location || '(not set)'}`,
                `Scene Type: ${ctx.scene_type || '(not set)'}`,
                `Characters Present: ${(ctx.characters_present || []).join(', ') || '(not set)'}`,
            ];
            const html = `<pre style="white-space: pre-wrap; font-size: 0.9em;">${escapeHtml(lines.join('\n'))}</pre>`;
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: false });
            return '';
        },
        helpString: 'Show current contextual gating state (era, location, scene type, characters present).',
        returns: 'Context state popup',
    }));
}
