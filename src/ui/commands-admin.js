/**
 * DeepLore Enhanced — Slash Commands: Admin & Status
 * /dle-notebook, /dle-ai-notepad, /dle-status, /dle-scribe-history, /dle-analytics, /dle-health, /dle-setup, /dle-help
 */
import { saveSettingsDebounced } from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { parseFrontmatter, simpleHash, classifyError } from '../../core/utils.js';
import { getSettings, getPrimaryVault, invalidateSettingsCache } from '../../settings.js';
import { fetchScribeNotes } from '../vault/obsidian-api.js';
import {
    vaultIndex, aiSearchStats, indexTimestamp, trackerKey, setIndexTimestamp,
    fieldDefinitions,
} from '../state.js';
import { buildIndex, ensureIndexFresh } from '../vault/vault.js';
import { runHealthCheck } from './diagnostics.js';
import { showNotebookPopup, showAiNotepadPopup, buildCopyButton, attachCopyHandler } from './popups.js';

export function registerAdminCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-notebook',
        callback: async () => {
            await showNotebookPopup();
            return '';
        },
        helpString: 'Open the Notebook editor for the current chat.',
        returns: 'Opens notebook popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-ai-notepad',
        callback: async (_args, value) => {
            const subcommand = (value || '').trim().toLowerCase();
            if (subcommand === 'clear') {
                const { chat_metadata, saveChatDebounced } = await import('../../../../../../script.js');
                chat_metadata.deeplore_ai_notepad = '';
                saveChatDebounced();
                toastr.success('AI Notepad cleared for this chat.', 'DeepLore Enhanced');
                return '';
            }
            await showAiNotepadPopup();
            return '';
        },
        helpString: 'View or clear AI-written session notes. Usage: /dle-ai-notepad [clear]',
        returns: 'Opens AI notepad popup or clears notes',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-status',
        callback: async () => {
            const settings = getSettings();
            const constants = vaultIndex.filter(e => e.constant).length;
            const seeds = vaultIndex.filter(e => e.seed).length;
            const bootstraps = vaultIndex.filter(e => e.bootstrap).length;
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            const lines = [
                `Enabled: ${settings.enabled}`,
                `Vaults: ${(settings.vaults || []).filter(v => v.enabled).map(v => `${v.name} (:${v.port})`).join(', ') || 'none'}`,
                `Lorebook Tag: #${settings.lorebookTag}`,
                `Always-Send Tag: ${settings.constantTag ? '#' + settings.constantTag : '(none)'}`,
                `Never-Insert Tag: ${settings.neverInsertTag ? '#' + settings.neverInsertTag : '(none)'}`,
                `Seed Tag: ${settings.seedTag ? '#' + settings.seedTag : '(none)'}`,
                `Bootstrap Tag: ${settings.bootstrapTag ? '#' + settings.bootstrapTag : '(none)'} (threshold: ${settings.newChatThreshold} messages)`,
                `Entries: ${vaultIndex.length} (${constants} always-send, ${seeds} seed, ${bootstraps} bootstrap, ~${totalTokens} tokens)`,
                `Budget: ${settings.unlimitedBudget ? 'unlimited' : settings.maxTokensBudget + ' tokens'}`,
                `Max Entries: ${settings.unlimitedEntries ? 'unlimited' : settings.maxEntries}`,
                `Recursive: ${settings.recursiveScan ? 'on (max ' + settings.maxRecursionSteps + ' steps)' : 'off'}`,
                `Cache: ${indexTimestamp ? Math.round((Date.now() - indexTimestamp) / 1000) + 's old' : 'none'} / TTL ${settings.cacheTTL} seconds`,
                `AI Search: ${settings.aiSearchEnabled ? 'on' : 'off'}`,
                `AI Stats: ${aiSearchStats.calls} calls, ${aiSearchStats.cachedHits} cache hits, ~${aiSearchStats.totalInputTokens} in / ~${aiSearchStats.totalOutputTokens} out tokens`,
                `Custom Fields: ${(() => { const defs = fieldDefinitions.length > 0 ? fieldDefinitions : []; return defs.length > 0 ? `${defs.length} (${defs.map(f => f.name).join(', ')})` : 'defaults'; })()}`,
                `Auto-Sync: ${settings.syncPollingInterval > 0 ? settings.syncPollingInterval + 's interval' : 'off'}`,
            ];
            const msg = lines.join('\n');
            const html = `<div class="dle-popup">${buildCopyButton(msg)}<pre class="dle-text-pre">${escapeHtml(msg)}</pre></div>`;
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                wide: true,
                onOpen: () => attachCopyHandler(document.querySelector('.popup')),
            });
            return msg;
        },
        helpString: 'Show DeepLore Enhanced connection status and index stats.',
        returns: 'Status information',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-scribe-history',
        callback: async () => {
            const settings = getSettings();
            if (!settings.scribeFolder) {
                toastr.warning('No scribe folder configured.', 'DeepLore Enhanced');
                return '';
            }

            toastr.info('Fetching session notes...', 'DeepLore Enhanced', { timeOut: 2000 });

            try {
                const histVault = getPrimaryVault(settings);
                const data = await fetchScribeNotes(histVault.host, histVault.port, histVault.apiKey, settings.scribeFolder);
                if (!data.ok) throw new Error(data.error || 'Failed to fetch notes');

                if (!data.notes || data.notes.length === 0) {
                    toastr.info('No session notes found.', 'DeepLore Enhanced');
                    return '';
                }

                const parsed = data.notes.map(note => {
                    const { frontmatter, body } = parseFrontmatter(note.content);
                    return {
                        filename: note.filename,
                        date: frontmatter.date || '',
                        character: frontmatter.character || '',
                        body: body.trim(),
                    };
                }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

                let html = '<div class="dle-popup">';
                html += `<h3>Session Notes (${parsed.length})</h3>`;

                for (const note of parsed) {
                    const dateDisplay = note.date ? new Date(note.date).toLocaleString() : 'Unknown date';
                    const preview = note.body.substring(0, 200).replace(/\n/g, ' ') + (note.body.length > 200 ? '...' : '');
                    const noteId = simpleHash(note.filename);

                    html += `<div class="dle-card dle-popup-section">`;
                    html += `<div class="dle_note_toggle dle-card-header" data-target="dle_note_${noteId}">`;
                    html += `<strong>${escapeHtml(note.character || 'Unknown')}</strong>`;
                    html += `<small class="dle-muted">${escapeHtml(dateDisplay)}</small>`;
                    html += `</div>`;
                    html += `<small class="dle-faint">${escapeHtml(preview)}</small>`;
                    html += `<div id="dle_note_${noteId}" class="dle-popup-detail">${escapeHtml(note.body)}</div>`;
                    html += `</div>`;
                }
                html += '</div>';

                const container = document.createElement('div');
                container.innerHTML = html;
                container.addEventListener('click', (e) => {
                    const toggle = e.target.closest('.dle_note_toggle');
                    if (!toggle) return;
                    const targetId = toggle.dataset.target;
                    const targetEl = document.getElementById(targetId);
                    if (targetEl) targetEl.style.display = targetEl.style.display === 'none' ? 'block' : 'none';
                });

                await callGenericPopup(container, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
            } catch (err) {
                console.error('[DLE] Scribe history error:', err);
                toastr.error(classifyError(err), 'DeepLore Enhanced');
            }
            return '';
        },
        helpString: 'Show all session notes from the scribe folder.',
        returns: 'Session timeline popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-analytics',
        callback: async () => {
            const settings = getSettings();
            const analytics = settings.analyticsData || {};
            const titles = Object.keys(analytics).sort((a, b) => (analytics[b].injected || 0) - (analytics[a].injected || 0));

            // Build plain-text version for clipboard
            const plainLines = ['Entry Analytics', '', 'Entry\tMatched\tInjected\tLast Used'];
            for (const title of titles) {
                const d = analytics[title];
                const lastUsed = d.lastTriggered ? new Date(d.lastTriggered).toLocaleString() : 'Never';
                plainLines.push(`${title}\t${d.matched || 0}\t${d.injected || 0}\t${lastUsed}`);
            }
            const neverInjected = vaultIndex.filter(e => !analytics[trackerKey(e)] || (analytics[trackerKey(e)].injected || 0) === 0);
            if (neverInjected.length > 0) {
                plainLines.push('', 'Never Injected:');
                for (const e of neverInjected) {
                    plainLines.push(`  ${e.title} (${e.keys.length} keys, priority ${e.priority})`);
                }
            }
            const plainText = plainLines.join('\n');

            let html = '<div class="dle-popup">';
            html += buildCopyButton(plainText);
            html += '<table class="dle-table">';
            html += '<tr><th>Entry</th><th>Matched</th><th>Injected</th><th>Last Used</th></tr>';

            for (const title of titles) {
                const d = analytics[title];
                const lastUsed = d.lastTriggered ? new Date(d.lastTriggered).toLocaleString() : 'Never';
                html += `<tr><td>${escapeHtml(title)}</td><td class="dle-text-center">${d.matched || 0}</td><td class="dle-text-center">${d.injected || 0}</td><td class="dle-text-center">${lastUsed}</td></tr>`;
            }
            html += '</table>';

            if (neverInjected.length > 0) {
                html += '<hr><h4>Never Injected</h4><ul>';
                for (const e of neverInjected) {
                    html += `<li>${escapeHtml(e.title)} (${e.keys.length} keys, priority ${e.priority})</li>`;
                }
                html += '</ul>';
            }

            if (titles.length === 0 && neverInjected.length === 0) {
                html = '<p>No analytics data yet. Generate some messages first.</p>';
            }

            html += '</div>';
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                wide: true, large: true, allowVerticalScrolling: true,
                onOpen: () => attachCopyHandler(document.querySelector('.popup')),
            });
            return '';
        },
        helpString: 'Show entry usage analytics: how often each entry was matched and injected.',
        returns: 'Analytics popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-health',
        callback: async () => {
            await ensureIndexFresh();

            const health = runHealthCheck();
            const { issues, errors, warnings } = health;
            const infos = issues.filter(i => i.severity === 'info').length;

            // Build plain-text version for clipboard
            const plainLines = [];
            if (issues.length === 0) {
                plainLines.push('Health Check: No issues found.');
            } else {
                plainLines.push(`Health Check: ${errors} errors, ${warnings} warnings, ${infos} info`, '');
                const grouped = {};
                for (const issue of issues) {
                    if (!grouped[issue.type]) grouped[issue.type] = [];
                    grouped[issue.type].push(issue);
                }
                for (const [type, items] of Object.entries(grouped)) {
                    plainLines.push(`[${type}] (${items.length})`);
                    for (const item of items) {
                        plainLines.push(`  [${item.severity}] ${item.entry}: ${item.detail}`);
                    }
                    plainLines.push('');
                }
            }
            const plainText = plainLines.join('\n');

            let html = '<div class="dle-popup">';

            if (issues.length === 0) {
                html += '<p class="dle-success">No issues found! All entries and settings look healthy.</p>';
            } else {
                html += `<h3>Health Check: ${errors} errors, ${warnings} warnings, ${infos} info</h3>`;
                html += buildCopyButton(plainText);

                const grouped2 = {};
                for (const issue of issues) {
                    if (!grouped2[issue.type]) grouped2[issue.type] = [];
                    grouped2[issue.type].push(issue);
                }

                const severityBadge = (sev) => {
                    const cls = { error: 'dle-error', warning: 'dle-warning', info: 'dle-info' };
                    return `<span class="dle-badge ${cls[sev] || ''}">[${sev}]</span>`;
                };

                for (const [type, items] of Object.entries(grouped2)) {
                    const typeErrors = items.filter(i => i.severity === 'error').length;
                    html += `<details ${typeErrors > 0 ? 'open' : ''}><summary style="cursor: pointer; margin: 8px 0;"><strong>${escapeHtml(type)}</strong> (${items.length})</summary>`;
                    html += `<ul style="margin: 4px 0 8px 20px;">`;
                    for (const item of items) {
                        html += `<li>${severityBadge(item.severity)} <strong>${escapeHtml(item.entry)}</strong>: ${escapeHtml(item.detail)}</li>`;
                    }
                    html += `</ul></details>`;
                }
            }

            html += '</div>';
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                wide: true, large: true, allowVerticalScrolling: true,
                onOpen: () => attachCopyHandler(document.querySelector('.popup')),
            });
            return '';
        },
        helpString: 'Run 30+ health checks on vault entries and settings: circular requires, duplicates, orphaned references, conflicting overrides, budget warnings, and more.',
        returns: 'Health check popup',
    }));

    // ── Setup Wizard ──

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-setup',
        callback: async () => {
            const settings = getSettings();

            // Step 1: Vault connection
            const step1Html = `
                <div class="dle-popup">
                    <h3>DeepLore Enhanced Setup (1/3): Vault Connection</h3>
                    <p>Connect to your Obsidian vault via the Local REST API plugin.</p>
                    <div class="dle-my-10">
                        <label>Vault Name:</label>
                        <input id="dle_setup_name" class="text_pole" type="text" value="${escapeHtml(settings.vaults?.[0]?.name || 'Primary')}" />
                    </div>
                    <div class="dle-my-10">
                        <label>Host (default: 127.0.0.1):</label>
                        <input id="dle_setup_host" class="text_pole" type="text" value="${escapeHtml(settings.vaults?.[0]?.host || '127.0.0.1')}" />
                    </div>
                    <div class="dle-my-10">
                        <label>Port (default: 27123):</label>
                        <input id="dle_setup_port" class="text_pole" type="number" value="${settings.vaults?.[0]?.port || 27123}" />
                    </div>
                    <div class="dle-my-10">
                        <label>API Key:</label>
                        <input id="dle_setup_key" class="text_pole" type="password" value="${escapeHtml(settings.vaults?.[0]?.apiKey || '')}" placeholder="From Obsidian REST API plugin settings" />
                    </div>
                </div>`;

            // Capture input values while popup is still open using onOpen + live binding
            let vaultName = 'Primary', host = '127.0.0.1', port = 27123, apiKey = '';
            const step1Ok = await callGenericPopup(step1Html, POPUP_TYPE.CONFIRM, '', {
                wide: true,
                onOpen: () => {
                    // Attach input handlers to capture values in real-time
                    const nameEl = document.getElementById('dle_setup_name');
                    const hostEl = document.getElementById('dle_setup_host');
                    const portEl = document.getElementById('dle_setup_port');
                    const keyEl = document.getElementById('dle_setup_key');
                    if (nameEl) { vaultName = nameEl.value.trim() || 'Primary'; nameEl.addEventListener('input', () => { vaultName = nameEl.value.trim() || 'Primary'; }); }
                    if (hostEl) { host = hostEl.value.trim() || '127.0.0.1'; hostEl.addEventListener('input', () => { host = hostEl.value.trim() || '127.0.0.1'; }); }
                    if (portEl) { port = parseInt(portEl.value) || 27123; portEl.addEventListener('input', () => { port = parseInt(portEl.value) || 27123; }); }
                    if (keyEl) { apiKey = keyEl.value.trim() || ''; keyEl.addEventListener('input', () => { apiKey = keyEl.value.trim() || ''; }); }
                },
            });
            if (!step1Ok) return '';

            // Test connection
            const { testConnection } = await import('../vault/obsidian-api.js');
            toastr.info('Testing connection...', 'DeepLore Enhanced', { timeOut: 2000 });
            const testResult = await testConnection(host, port, apiKey);
            if (!testResult.ok) {
                toastr.error(`Connection failed: ${testResult.error}. Check Obsidian and REST API plugin.`, 'DeepLore Enhanced');
                return '';
            }
            toastr.success('Connected to Obsidian!', 'DeepLore Enhanced');

            // Step 2: Tags and mode
            const step2Html = `
                <div class="dle-popup">
                    <h3>DeepLore Enhanced Setup (2/3): Configuration</h3>
                    <div class="dle-my-10">
                        <label>Lorebook Tag (entries must have this tag):</label>
                        <input id="dle_setup_tag" class="text_pole" type="text" value="${escapeHtml(settings.lorebookTag)}" />
                    </div>
                    <div class="dle-my-10">
                        <label>Search Mode:</label>
                        <select id="dle_setup_mode" class="text_pole">
                            <option value="keywords" ${!settings.aiSearchEnabled ? 'selected' : ''}>Keywords Only (no AI cost)</option>
                            <option value="two-stage" ${settings.aiSearchEnabled && settings.aiSearchMode === 'two-stage' ? 'selected' : ''}>Two-Stage (keywords + AI refinement)</option>
                            <option value="ai-only" ${settings.aiSearchEnabled && settings.aiSearchMode === 'ai-only' ? 'selected' : ''}>AI Only (full semantic search)</option>
                        </select>
                    </div>
                </div>`;

            let lorebookTag = settings.lorebookTag, searchMode = 'keywords';
            const step2Ok = await callGenericPopup(step2Html, POPUP_TYPE.CONFIRM, '', {
                wide: true,
                onOpen: () => {
                    const tagEl = document.getElementById('dle_setup_tag');
                    const modeEl = document.getElementById('dle_setup_mode');
                    if (tagEl) { lorebookTag = tagEl.value.trim() || 'lorebook'; tagEl.addEventListener('input', () => { lorebookTag = tagEl.value.trim() || 'lorebook'; }); }
                    if (modeEl) { searchMode = modeEl.value || 'keywords'; modeEl.addEventListener('change', () => { searchMode = modeEl.value || 'keywords'; }); }
                },
            });
            if (!step2Ok) return '';

            // Apply settings
            settings.enabled = true;
            settings.lorebookTag = lorebookTag;
            settings.vaults = [{ name: vaultName, host, port, apiKey, enabled: true }];
            settings.aiSearchEnabled = searchMode !== 'keywords';
            if (searchMode !== 'keywords') settings.aiSearchMode = searchMode;
            invalidateSettingsCache();
            saveSettingsDebounced();

            // Step 3: Verify — build index
            toastr.info('Building index...', 'DeepLore Enhanced', { timeOut: 3000 });
            setIndexTimestamp(0);
            await buildIndex();

            const step3Html = `
                <div class="dle-popup">
                    <h3>DeepLore Enhanced Setup (3/3): Verification</h3>
                    <p class="dle-success dle-text-lg">Setup complete!</p>
                    <ul>
                        <li>Vault: <b>${escapeHtml(vaultName)}</b> on ${escapeHtml(host)}:${port}</li>
                        <li>Lorebook tag: <b>#${escapeHtml(lorebookTag)}</b></li>
                        <li>Entries indexed: <b>${vaultIndex.length}</b></li>
                        <li>Mode: <b>${searchMode === 'keywords' ? 'Keywords Only' : searchMode === 'two-stage' ? 'Two-Stage' : 'AI Only'}</b></li>
                    </ul>
                    ${vaultIndex.length === 0 ? '<p class="dle-warning">No entries found. Make sure your Obsidian notes have the <code>#' + escapeHtml(lorebookTag) + '</code> tag.</p>' : ''}
                    <p>You can adjust all settings in the Extensions panel.</p>
                </div>`;

            await callGenericPopup(step3Html, POPUP_TYPE.TEXT, '', { wide: true });
            return '';
        },
        helpString: 'Walk through initial setup: connect vault, configure tags, verify index.',
        returns: 'Setup wizard',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-help',
        callback: async () => {
            const commands = [
                { cmd: '/dle-browse', desc: 'Search and preview vault entries' },
                { cmd: '/dle-why', desc: 'Show why entries would/wouldn\'t inject (no generation needed)' },
                { cmd: '/dle-inspect', desc: 'Inspect what happened in the last message' },
                { cmd: '/dle-health', desc: 'Run vault health check' },
                { cmd: '/dle-refresh', desc: 'Rebuild vault index from Obsidian' },
                { cmd: '/dle-status', desc: 'Show extension status and stats' },
                { cmd: '/dle-simulate', desc: 'Replay chat showing entry activation timeline' },
                { cmd: '/dle-graph', desc: 'Visualize entry relationships as a graph' },
                { cmd: '/dle-analytics', desc: 'View entry match/injection analytics' },
                { cmd: '/dle-notebook', desc: 'Edit the Notebook for this chat' },
                { cmd: '/dle-ai-notepad [clear]', desc: 'View or clear AI-written session notes' },
                { cmd: '/dle-scribe', desc: 'Run Session Scribe now' },
                { cmd: '/dle-scribe-history', desc: 'View past Scribe notes' },
                { cmd: '/dle-newlore', desc: 'AI suggests new lorebook entries from chat' },
                { cmd: '/dle-optimize-keys &lt;name&gt;', desc: 'AI keyword suggestions for an entry' },
                { cmd: '/dle-summarize', desc: 'AI-generate summary fields for all entries missing one' },
                { cmd: '/dle-review', desc: 'Send entire vault to AI for review and feedback' },
                { cmd: '/dle-import', desc: 'Import SillyTavern World Info into Obsidian vault' },
                { cmd: '/dle-setup', desc: 'Run guided setup wizard' },
                { sep: true, label: 'Per-Chat Overrides' },
                { cmd: '/dle-pin &lt;name&gt;', desc: 'Pin an entry (always inject in this chat)' },
                { cmd: '/dle-unpin &lt;name&gt;', desc: 'Remove a pin' },
                { cmd: '/dle-block &lt;name&gt;', desc: 'Block an entry (never inject in this chat)' },
                { cmd: '/dle-unblock &lt;name&gt;', desc: 'Remove a block' },
                { cmd: '/dle-pins', desc: 'Show all pins and blocks for this chat' },
                { sep: true, label: 'Contextual Gating' },
                { cmd: '/dle-set-field &lt;name&gt; [value]', desc: 'Set a custom gating field' },
                { cmd: '/dle-clear-field &lt;name&gt;', desc: 'Clear a custom gating field' },
                { cmd: '/dle-set-era [era]', desc: 'Set era filter (alias for /dle-set-field era)' },
                { cmd: '/dle-set-location [loc]', desc: 'Set location filter (alias for /dle-set-field location)' },
                { cmd: '/dle-set-scene [type]', desc: 'Set scene type filter (alias for /dle-set-field scene_type)' },
                { cmd: '/dle-set-characters &lt;names&gt;', desc: 'Set present characters (alias for /dle-set-field character_present)' },
                { cmd: '/dle-context-state', desc: 'Show current gating state' },
            ];
            let html = '<div class="dle-popup"><h3>DeepLore Enhanced Commands</h3>';
            for (const c of commands) {
                if (c.sep) {
                    html += `<h4 class="dle-muted" style="margin: var(--dle-space-3) 0 var(--dle-space-1);">${escapeHtml(c.label)}</h4>`;
                    continue;
                }
                html += `<div class="dle-mb-1"><code class="dle-muted">${c.cmd}</code> — ${escapeHtml(c.desc)}</div>`;
            }
            html += '</div>';
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
            return '';
        },
        helpString: 'Show all DeepLore Enhanced slash commands with descriptions.',
        returns: 'Help popup',
    }));
}
