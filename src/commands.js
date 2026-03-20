/**
 * DeepLore Enhanced — Slash Commands
 */
import {
    sendMessageAsUser,
    Generate,
    chat,
    chat_metadata,
    name2,
} from '../../../../../script.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { escapeHtml } from '../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../slash-commands/SlashCommand.js';
import { parseFrontmatter, simpleHash, buildAiChatContext } from '../core/utils.js';
import { applyGating, formatAndGroup } from '../core/matching.js';
import { getSettings, getPrimaryVault, PROMPT_TAG_PREFIX, DEFAULT_AI_SYSTEM_PROMPT } from '../settings.js';
import { fetchScribeNotes } from './obsidian-api.js';
import {
    vaultIndex, aiSearchStats, indexTimestamp, scribeInProgress,
    lastPipelineTrace, injectionHistory, generationCount,
    setVaultIndex, setIndexTimestamp,
} from './state.js';
import { buildIndex, ensureIndexFresh, getMaxResponseTokens } from './vault.js';
import { buildCandidateManifest } from './ai.js';
import { matchEntries, runPipeline } from './pipeline.js';
import { runScribe } from './scribe.js';
import { runAutoSuggest, showSuggestionPopup } from './auto-suggest.js';
import { showSourcesPopup } from './cartographer.js';
import { runSimulation, showSimulationPopup, showGraphPopup, optimizeEntryKeys, showOptimizePopup, showNotebookPopup, showBrowsePopup } from './popups.js';
import { runHealthCheck } from './diagnostics.js';
import { parseWorldInfoJson, importEntries } from './import.js';

export function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-simulate',
        callback: async () => {
            if (!chat || chat.length === 0) {
                toastr.warning('No active chat.', 'DeepLore Enhanced');
                return '';
            }
            await ensureIndexFresh();
            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed.', 'DeepLore Enhanced');
                return '';
            }
            toastr.info('Running activation simulation...', 'DeepLore Enhanced', { timeOut: 2000 });
            const timeline = runSimulation(chat);
            showSimulationPopup(timeline);
            return '';
        },
        helpString: 'Replay chat history step-by-step showing which entries activate/deactivate at each message.',
        returns: 'Simulation timeline popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-graph',
        callback: async () => {
            await showGraphPopup();
            return '';
        },
        helpString: 'Visualize entry relationships as an interactive force-directed graph.',
        returns: 'Graph popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-optimize-keys',
        callback: async (_args, entryName) => {
            await ensureIndexFresh();
            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed.', 'DeepLore Enhanced');
                return '';
            }
            const name = (entryName || '').trim();
            if (!name) {
                toastr.warning('Usage: /dle-optimize-keys <entry name>', 'DeepLore Enhanced');
                return '';
            }
            const entry = vaultIndex.find(e => e.title.toLowerCase() === name.toLowerCase());
            if (!entry) {
                toastr.warning(`Entry "${name}" not found.`, 'DeepLore Enhanced');
                return '';
            }
            toastr.info(`Optimizing keywords for "${entry.title}"...`, 'DeepLore Enhanced', { timeOut: 3000 });
            try {
                const result = await optimizeEntryKeys(entry);
                await showOptimizePopup(entry, result);
            } catch (err) {
                console.error('[DLE] Optimize keys error:', err);
                toastr.error(`Error: ${err.message}`, 'DeepLore Enhanced');
            }
            return '';
        },
        helpString: 'AI suggests better keywords for an entry. Usage: /dle-optimize-keys <entry name>',
        returns: 'Optimization popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-suggest',
        callback: async () => {
            if (!chat || chat.length === 0) {
                toastr.warning('No active chat.', 'DeepLore Enhanced');
                return '';
            }
            toastr.info('Analyzing chat for new entries...', 'DeepLore Enhanced', { timeOut: 3000 });
            try {
                const suggestions = await runAutoSuggest();
                await showSuggestionPopup(suggestions);
            } catch (err) {
                console.error('[DLE] Auto-suggest error:', err);
                toastr.error(`Error: ${err.message}`, 'DeepLore Enhanced');
            }
            return '';
        },
        helpString: 'AI analyzes chat for entities not in the lorebook and suggests new entries with human review.',
        returns: 'Suggestion popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-context',
        callback: async () => {
            if (!chat || chat.length === 0) {
                toastr.warning('No active chat.', 'DeepLore Enhanced');
                return '';
            }
            await ensureIndexFresh();
            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed.', 'DeepLore Enhanced');
                return '';
            }

            const settings = getSettings();
            const { finalEntries, matchedKeys } = await runPipeline(chat);

            // Apply re-injection cooldown (matches onGenerate order)
            let filtered = finalEntries;
            if (settings.reinjectionCooldown > 0) {
                filtered = finalEntries.filter(e => {
                    if (e.constant) return true;
                    const lastGen = injectionHistory.get(e.title);
                    return lastGen === undefined || (generationCount - lastGen) >= settings.reinjectionCooldown;
                });
            }

            const gated = applyGating(filtered);
            const { count: injectedCount, totalTokens } = formatAndGroup(gated, settings, PROMPT_TAG_PREFIX);
            const injected = gated.slice(0, injectedCount);

            if (injected.length === 0) {
                toastr.info('No entries would be injected right now.', 'DeepLore Enhanced');
                return '';
            }

            const sources = injected.map(e => ({
                title: e.title,
                filename: e.filename,
                matchedBy: matchedKeys.get(e.title) || '?',
                priority: e.priority,
                tokens: e.tokenEstimate,
            }));
            showSourcesPopup(sources);
            return '';
        },
        helpString: 'Show what would be injected right now — runs the pipeline without generating.',
        returns: 'Context map popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-browse',
        callback: async () => {
            await showBrowsePopup();
            return '';
        },
        helpString: 'Open the entry browser — searchable, filterable popup of all indexed entries.',
        returns: 'Entry browser popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-notebook',
        callback: async () => {
            await showNotebookPopup();
            return '';
        },
        helpString: 'Open the AI Notebook editor for the current chat.',
        returns: 'Opens notebook popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-refresh',
        callback: async () => {
            setVaultIndex([]);
            setIndexTimestamp(0);
            await buildIndex();
            const msg = `Indexed ${vaultIndex.length} entries.`;
            toastr.success(msg, 'DeepLore Enhanced');
            return msg;
        },
        helpString: 'Force refresh the DeepLore Enhanced vault index cache.',
        returns: 'Status message',
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
                `Cache: ${indexTimestamp ? Math.round((Date.now() - indexTimestamp) / 1000) + 's old' : 'none'} / TTL ${settings.cacheTTL}s`,
                `AI Search: ${settings.aiSearchEnabled ? 'on' : 'off'}`,
                `AI Stats: ${aiSearchStats.calls} calls, ${aiSearchStats.cachedHits} cache hits, ~${aiSearchStats.totalInputTokens} in / ~${aiSearchStats.totalOutputTokens} out tokens`,
                `Auto-Sync: ${settings.syncPollingInterval > 0 ? settings.syncPollingInterval + 's interval' : 'off'}`,
            ];
            const msg = lines.join('\n');
            const html = `<pre style="white-space: pre-wrap; font-size: 0.9em;">${escapeHtml(msg)}</pre>`;
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true });
            return msg;
        },
        helpString: 'Show DeepLore Enhanced connection status and index stats.',
        returns: 'Status information',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-scribe',
        callback: async (_args, userPrompt) => {
            if (scribeInProgress) {
                toastr.warning('Session scribe already in progress.', 'DeepLore Enhanced');
                return '';
            }
            toastr.info('Writing session note...', 'DeepLore Enhanced');
            await runScribe(userPrompt?.trim() || '');
            return 'Session note written.';
        },
        helpString: 'Write a session summary to Obsidian. Optionally provide a focus topic, e.g. /dle-scribe What happened with the sword?',
        returns: 'Status message',
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
                const data = await fetchScribeNotes(histVault.port, histVault.apiKey, settings.scribeFolder);
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

                let html = '<div style="text-align: left;">';
                html += `<h3>Session Notes (${parsed.length})</h3>`;

                for (const note of parsed) {
                    const dateDisplay = note.date ? new Date(note.date).toLocaleString() : 'Unknown date';
                    const preview = note.body.substring(0, 200).replace(/\n/g, ' ') + (note.body.length > 200 ? '...' : '');
                    const noteId = simpleHash(note.filename);

                    html += `<div style="border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 5px; padding: 10px; margin-bottom: 8px;">`;
                    html += `<div style="display: flex; justify-content: space-between; cursor: pointer;" onclick="document.getElementById('dle_note_${noteId}').style.display = document.getElementById('dle_note_${noteId}').style.display === 'none' ? 'block' : 'none'">`;
                    html += `<strong>${escapeHtml(note.character || 'Unknown')}</strong>`;
                    html += `<small style="opacity: 0.7;">${escapeHtml(dateDisplay)}</small>`;
                    html += `</div>`;
                    html += `<small style="opacity: 0.6;">${escapeHtml(preview)}</small>`;
                    html += `<div id="dle_note_${noteId}" style="display: none; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--SmartThemeBorderColor, #333); white-space: pre-wrap; font-size: 0.9em;">${escapeHtml(note.body)}</div>`;
                    html += `</div>`;
                }
                html += '</div>';

                await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
            } catch (err) {
                console.error('[DLE] Scribe history error:', err);
                toastr.error(`Error: ${err.message}`, 'DeepLore Enhanced');
            }
            return '';
        },
        helpString: 'Show all session notes from the scribe folder.',
        returns: 'Session timeline popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-review',
        callback: async (_args, userPrompt) => {
            await ensureIndexFresh();

            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed. Check your connection and lorebook tag settings.', 'DeepLore Enhanced');
                return '';
            }

            const settings = getSettings();
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);

            const confirmed = await callGenericPopup(
                `<p>This will send <b>${vaultIndex.length}</b> entries (~${totalTokens} tokens) as a message and generate an AI response.</p><p>This may be expensive. Continue?</p>`,
                POPUP_TYPE.CONFIRM, '', {},
            );
            if (!confirmed) return '';

            const loreDump = vaultIndex.map(entry => {
                return `## ${entry.title}\n${entry.content}`;
            }).join('\n\n---\n\n');

            const responseTokens = settings.reviewResponseTokens > 0
                ? settings.reviewResponseTokens
                : getMaxResponseTokens();
            const budgetHint = `\n\nKeep your response under ${responseTokens} tokens.`;
            const defaultQuestion = 'Review this lorebook/world-building vault. Comment on consistency, gaps, interesting connections between entries, and any suggestions for improvement.';
            const question = (userPrompt && userPrompt.trim()) ? userPrompt.trim() : defaultQuestion;

            const message = `[DeepLore Enhanced Review — ${vaultIndex.length} entries, ~${totalTokens} tokens]\n\n${loreDump}\n\n---\n\n${question}${budgetHint}`;
            if (settings.debugMode) {
                console.log('[DLE] Lore review prompt:', message);
            }

            toastr.info(`Sending ${vaultIndex.length} entries (~${totalTokens} tokens)...`, 'DeepLore Enhanced', { timeOut: 5000 });

            await sendMessageAsUser(message, '');
            await Generate('normal');

            return '';
        },
        helpString: 'Send the entire Obsidian vault to the AI for review. Optionally provide a custom question, e.g. /dle-review What inconsistencies do you see?',
        returns: 'AI review posted to chat',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-analytics',
        callback: async () => {
            const settings = getSettings();
            const analytics = settings.analyticsData || {};
            const titles = Object.keys(analytics).sort((a, b) => (analytics[b].injected || 0) - (analytics[a].injected || 0));

            let html = '<table style="width:100%;border-collapse:collapse;font-size:0.9em;">';
            html += '<tr><th style="text-align:left;border-bottom:1px solid var(--SmartThemeBorderColor, #666);padding:4px;">Entry</th><th style="border-bottom:1px solid var(--SmartThemeBorderColor, #666);padding:4px;">Matched</th><th style="border-bottom:1px solid var(--SmartThemeBorderColor, #666);padding:4px;">Injected</th><th style="border-bottom:1px solid var(--SmartThemeBorderColor, #666);padding:4px;">Last Used</th></tr>';

            for (const title of titles) {
                const d = analytics[title];
                const lastUsed = d.lastTriggered ? new Date(d.lastTriggered).toLocaleString() : 'Never';
                html += `<tr><td style="padding:4px;">${escapeHtml(title)}</td><td style="text-align:center;padding:4px;">${d.matched || 0}</td><td style="text-align:center;padding:4px;">${d.injected || 0}</td><td style="text-align:center;padding:4px;">${lastUsed}</td></tr>`;
            }
            html += '</table>';

            const neverInjected = vaultIndex.filter(e => !analytics[e.title] || (analytics[e.title].injected || 0) === 0);
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

            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
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

            let html = '<div style="text-align: left;">';

            if (issues.length === 0) {
                html += '<p style="color: var(--SmartThemeQuoteColor, #4caf50);">No issues found! All entries and settings look healthy.</p>';
            } else {
                html += `<h3>Health Check: ${errors} errors, ${warnings} warnings, ${infos} info</h3>`;

                const grouped = {};
                for (const issue of issues) {
                    if (!grouped[issue.type]) grouped[issue.type] = [];
                    grouped[issue.type].push(issue);
                }

                const severityBadge = (sev) => {
                    const colors = { error: '#f44336', warning: '#ff9800', info: '#2196f3' };
                    return `<span style="color: ${colors[sev] || '#999'}; font-size: 0.8em; font-weight: bold;">[${sev}]</span>`;
                };

                for (const [type, items] of Object.entries(grouped)) {
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
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
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
                <div style="text-align: left;">
                    <h3>DeepLore Enhanced Setup (1/3): Vault Connection</h3>
                    <p>Connect to your Obsidian vault via the Local REST API plugin.</p>
                    <div style="margin: 10px 0;">
                        <label>Vault Name:</label>
                        <input id="dle_setup_name" class="text_pole" type="text" value="${escapeHtml(settings.vaults?.[0]?.name || 'Primary')}" />
                    </div>
                    <div style="margin: 10px 0;">
                        <label>Port (default: 27123):</label>
                        <input id="dle_setup_port" class="text_pole" type="number" value="${settings.vaults?.[0]?.port || 27123}" />
                    </div>
                    <div style="margin: 10px 0;">
                        <label>API Key:</label>
                        <input id="dle_setup_key" class="text_pole" type="password" value="${escapeHtml(settings.vaults?.[0]?.apiKey || '')}" placeholder="From Obsidian REST API plugin settings" />
                    </div>
                </div>`;

            const step1Ok = await callGenericPopup(step1Html, POPUP_TYPE.CONFIRM, '', { wide: true });
            if (!step1Ok) return '';

            const vaultName = document.getElementById('dle_setup_name')?.value?.trim() || 'Primary';
            const port = parseInt(document.getElementById('dle_setup_port')?.value) || 27123;
            const apiKey = document.getElementById('dle_setup_key')?.value?.trim() || '';

            // Test connection
            const { testConnection } = await import('./obsidian-api.js');
            toastr.info('Testing connection...', 'DeepLore Enhanced', { timeOut: 2000 });
            const testResult = await testConnection(port, apiKey);
            if (!testResult.ok) {
                toastr.error(`Connection failed: ${testResult.error}. Check Obsidian and REST API plugin.`, 'DeepLore Enhanced');
                return '';
            }
            toastr.success('Connected to Obsidian!', 'DeepLore Enhanced');

            // Step 2: Tags and mode
            const step2Html = `
                <div style="text-align: left;">
                    <h3>DeepLore Enhanced Setup (2/3): Configuration</h3>
                    <div style="margin: 10px 0;">
                        <label>Lorebook Tag (entries must have this tag):</label>
                        <input id="dle_setup_tag" class="text_pole" type="text" value="${escapeHtml(settings.lorebookTag)}" />
                    </div>
                    <div style="margin: 10px 0;">
                        <label>Search Mode:</label>
                        <select id="dle_setup_mode" class="text_pole">
                            <option value="keywords" ${!settings.aiSearchEnabled ? 'selected' : ''}>Keywords Only (no AI cost)</option>
                            <option value="two-stage" ${settings.aiSearchEnabled && settings.aiSearchMode === 'two-stage' ? 'selected' : ''}>Two-Stage (keywords + AI refinement)</option>
                            <option value="ai-only" ${settings.aiSearchEnabled && settings.aiSearchMode === 'ai-only' ? 'selected' : ''}>AI Only (full semantic search)</option>
                        </select>
                    </div>
                </div>`;

            const step2Ok = await callGenericPopup(step2Html, POPUP_TYPE.CONFIRM, '', { wide: true });
            if (!step2Ok) return '';

            const lorebookTag = document.getElementById('dle_setup_tag')?.value?.trim() || 'lorebook';
            const searchMode = document.getElementById('dle_setup_mode')?.value || 'keywords';

            // Apply settings
            settings.enabled = true;
            settings.lorebookTag = lorebookTag;
            settings.vaults = [{ name: vaultName, port, apiKey, enabled: true }];
            settings.aiSearchEnabled = searchMode !== 'keywords';
            if (searchMode !== 'keywords') settings.aiSearchMode = searchMode;
            saveSettingsDebounced();

            // Step 3: Verify — build index
            toastr.info('Building index...', 'DeepLore Enhanced', { timeOut: 3000 });
            setVaultIndex([]);
            setIndexTimestamp(0);
            await buildIndex();

            const step3Html = `
                <div style="text-align: left;">
                    <h3>DeepLore Enhanced Setup (3/3): Verification</h3>
                    <p style="color: #4caf50; font-size: 1.1em;">Setup complete!</p>
                    <ul>
                        <li>Vault: <b>${escapeHtml(vaultName)}</b> on port ${port}</li>
                        <li>Lorebook tag: <b>#${escapeHtml(lorebookTag)}</b></li>
                        <li>Entries indexed: <b>${vaultIndex.length}</b></li>
                        <li>Mode: <b>${searchMode === 'keywords' ? 'Keywords Only' : searchMode === 'two-stage' ? 'Two-Stage' : 'AI Only'}</b></li>
                    </ul>
                    ${vaultIndex.length === 0 ? '<p style="color: #ff9800;">No entries found. Make sure your Obsidian notes have the <code>#' + escapeHtml(lorebookTag) + '</code> tag.</p>' : ''}
                    <p>You can adjust all settings in the Extensions panel.</p>
                </div>`;

            await callGenericPopup(step3Html, POPUP_TYPE.TEXT, '', { wide: true });
            return '';
        },
        helpString: 'Walk through initial setup: connect vault, configure tags, verify index.',
        returns: 'Setup wizard',
    }));

    // ── Auto-Summary Generation ──

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-summarize',
        callback: async () => {
            await ensureIndexFresh();
            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed.', 'DeepLore Enhanced');
                return '';
            }

            const missingSummary = vaultIndex.filter(e => !e.summary || !e.summary.trim());
            if (missingSummary.length === 0) {
                toastr.success('All entries already have summaries.', 'DeepLore Enhanced');
                return '';
            }

            const confirmed = await callGenericPopup(
                `<p>Found <b>${missingSummary.length}</b> entries without AI search summaries.</p>
                <p>This will generate summaries using your AI search connection and present each for review before writing to Obsidian.</p>
                <p>Continue?</p>`,
                POPUP_TYPE.CONFIRM, '', {},
            );
            if (!confirmed) return '';

            const { callViaProfile, extractAiResponseClient } = await import('./ai.js');
            const { writeNote, obsidianFetch, encodeVaultPath } = await import('./obsidian-api.js');
            const settings = getSettings();
            const vault = getPrimaryVault(settings);

            let generated = 0;
            let skipped = 0;
            let failed = 0;

            for (let i = 0; i < missingSummary.length; i++) {
                const entry = missingSummary[i];
                toastr.info(`Generating summary ${i + 1}/${missingSummary.length}: "${entry.title}"...`, 'DeepLore Enhanced', { timeOut: 3000 });

                try {
                    const systemPrompt = 'You are a lore librarian. Write a concise AI search summary (max 600 chars) for the following lorebook entry. The summary should answer: What is this? When should it be selected? Key relationships? Do NOT include physical descriptions or atmospheric prose. Write for an AI that needs to decide whether to inject this entry.';
                    const userMsg = `Entry: ${entry.title}\n\nContent:\n${entry.content.substring(0, 3000)}`;

                    let responseText;
                    if (settings.aiSearchConnectionMode === 'profile' && settings.aiSearchProfileId) {
                        const result = await callViaProfile(systemPrompt, userMsg, 300, settings.aiSearchTimeout);
                        responseText = result.text;
                    } else {
                        const { callProxyViaCorsBridge } = await import('./proxy-api.js');
                        const result = await callProxyViaCorsBridge(
                            settings.aiSearchProxyUrl,
                            settings.aiSearchModel || 'claude-haiku-4-5-20251001',
                            systemPrompt, userMsg, 300, settings.aiSearchTimeout,
                        );
                        responseText = result.text;
                    }

                    const summary = responseText.trim().substring(0, 600);
                    if (!summary) {
                        failed++;
                        continue;
                    }

                    // Present for review
                    const reviewHtml = `
                        <div style="text-align: left;">
                            <h4>${escapeHtml(entry.title)} (${i + 1}/${missingSummary.length})</h4>
                            <p style="font-size: 0.85em; opacity: 0.7;">Entry content preview: ${escapeHtml(entry.content.substring(0, 200))}...</p>
                            <hr>
                            <p><b>Generated Summary:</b></p>
                            <textarea id="dle_summary_edit" class="text_pole" style="height: 100px; font-size: 0.9em;">${escapeHtml(summary)}</textarea>
                            <p style="font-size: 0.8em; opacity: 0.6;">Edit the summary above if needed. Click OK to write to Obsidian, Cancel to skip.</p>
                        </div>`;

                    const approved = await callGenericPopup(reviewHtml, POPUP_TYPE.CONFIRM, '', { wide: true });

                    if (!approved) {
                        skipped++;
                        continue;
                    }

                    const finalSummary = document.getElementById('dle_summary_edit')?.value?.trim() || summary;

                    // Read current file, inject summary into frontmatter, write back
                    const fileResult = await obsidianFetch({
                        port: vault.port,
                        apiKey: vault.apiKey,
                        path: `/vault/${encodeVaultPath(entry.filename)}`,
                        accept: 'text/markdown',
                    });

                    if (fileResult.status !== 200) {
                        failed++;
                        console.warn(`[DLE] Failed to read ${entry.filename}: HTTP ${fileResult.status}`);
                        continue;
                    }

                    // Insert summary into frontmatter
                    let fileContent = fileResult.data;
                    if (fileContent.startsWith('---')) {
                        const endIdx = fileContent.indexOf('---', 3);
                        if (endIdx > 0) {
                            const fmSection = fileContent.substring(0, endIdx);
                            const rest = fileContent.substring(endIdx);
                            // Remove existing summary line if present
                            const cleaned = fmSection.replace(/^summary:.*$/m, '').replace(/\n{3,}/g, '\n\n');
                            fileContent = cleaned + `summary: "${finalSummary.replace(/"/g, '\\"')}"\n` + rest;
                        }
                    }

                    const writeResult = await writeNote(vault.port, vault.apiKey, entry.filename, fileContent);
                    if (writeResult.ok) {
                        generated++;
                    } else {
                        failed++;
                    }
                } catch (err) {
                    console.error(`[DLE] Summary generation error for "${entry.title}":`, err);
                    failed++;
                }
            }

            const msg = `Done: ${generated} written, ${skipped} skipped, ${failed} failed.`;
            toastr.success(msg, 'DeepLore Enhanced');

            // Refresh index to pick up new summaries
            if (generated > 0) {
                setVaultIndex([]);
                setIndexTimestamp(0);
                await buildIndex();
            }
            return '';
        },
        helpString: 'Generate AI search summaries for entries that are missing them. Each summary is presented for review before writing.',
        returns: 'Summary generation status',
    }));

    // ── Lorebook Import ──

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-import',
        callback: async (_args, folderArg) => {
            const folder = (folderArg || '').trim();

            // Prompt user to paste JSON
            const jsonInput = await callGenericPopup(
                `<div style="text-align: left;">
                    <h3>Import SillyTavern World Info</h3>
                    <p>Paste the JSON content of a SillyTavern World Info export, or a V2 character card with an embedded lorebook.</p>
                    ${folder ? `<p>Target folder: <strong>${escapeHtml(folder)}</strong></p>` : '<p>Entries will be created in the vault root. Pass a folder name as argument, e.g. <code>/dle-import Imported</code></p>'}
                    <textarea id="dle_import_json" class="text_pole" style="height: 200px; font-family: monospace; font-size: 0.85em;" placeholder="Paste World Info JSON here..."></textarea>
                </div>`,
                POPUP_TYPE.CONFIRM, '', { wide: true },
            );

            if (!jsonInput) return '';

            const jsonText = document.getElementById('dle_import_json')?.value?.trim();
            if (!jsonText) {
                toastr.warning('No JSON provided.', 'DeepLore Enhanced');
                return '';
            }

            try {
                const { entries, source } = parseWorldInfoJson(jsonText);
                if (entries.length === 0) {
                    toastr.info('No entries found in the JSON.', 'DeepLore Enhanced');
                    return '';
                }

                // Confirm
                const confirmed = await callGenericPopup(
                    `<p>Found <b>${entries.length}</b> entries from "${escapeHtml(source)}".</p>
                    <p>Import to ${folder ? `folder <b>${escapeHtml(folder)}/</b>` : 'vault root'}?</p>`,
                    POPUP_TYPE.CONFIRM, '', {},
                );
                if (!confirmed) return '';

                toastr.info(`Importing ${entries.length} entries...`, 'DeepLore Enhanced', { timeOut: 5000 });
                const result = await importEntries(entries, folder);

                if (result.failed > 0) {
                    toastr.warning(`Imported ${result.imported}, failed ${result.failed}. Check console for details.`, 'DeepLore Enhanced');
                    console.warn('[DLE] Import errors:', result.errors);
                } else {
                    toastr.success(`Imported ${result.imported} entries.`, 'DeepLore Enhanced');
                }

                // Refresh index to pick up new entries
                setVaultIndex([]);
                setIndexTimestamp(0);
                await buildIndex();
            } catch (err) {
                console.error('[DLE] Import error:', err);
                toastr.error(`Import failed: ${err.message}`, 'DeepLore Enhanced');
            }
            return '';
        },
        helpString: 'Import SillyTavern World Info JSON into Obsidian vault. Optionally specify a target folder: /dle-import MyFolder',
        returns: 'Import status',
    }));

    // ── Per-Chat Pin/Block Commands ──

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-pin',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.warning('Usage: /dle-pin <entry name>', 'DeepLore Enhanced'); return ''; }
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
            saveSettingsDebounced();
            toastr.success(`Pinned "${entry.title}" for this chat.`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Pin an entry so it always injects in this chat. Usage: /dle-pin <entry name>',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-unpin',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.warning('Usage: /dle-unpin <entry name>', 'DeepLore Enhanced'); return ''; }
            if (!chat_metadata.deeplore_pins || chat_metadata.deeplore_pins.length === 0) {
                toastr.info('No pinned entries.', 'DeepLore Enhanced'); return '';
            }
            const idx = chat_metadata.deeplore_pins.findIndex(t => t.toLowerCase() === name.toLowerCase());
            if (idx === -1) { toastr.info(`"${name}" is not pinned.`, 'DeepLore Enhanced'); return ''; }
            const removed = chat_metadata.deeplore_pins.splice(idx, 1)[0];
            saveSettingsDebounced();
            toastr.success(`Unpinned "${removed}".`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Remove a per-chat pin. Usage: /dle-unpin <entry name>',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-block',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.warning('Usage: /dle-block <entry name>', 'DeepLore Enhanced'); return ''; }
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
            saveSettingsDebounced();
            toastr.success(`Blocked "${entry.title}" for this chat.`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Block an entry so it never injects in this chat. Usage: /dle-block <entry name>',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-unblock',
        callback: async (_args, entryName) => {
            const name = (entryName || '').trim();
            if (!name) { toastr.warning('Usage: /dle-unblock <entry name>', 'DeepLore Enhanced'); return ''; }
            if (!chat_metadata.deeplore_blocks || chat_metadata.deeplore_blocks.length === 0) {
                toastr.info('No blocked entries.', 'DeepLore Enhanced'); return '';
            }
            const idx = chat_metadata.deeplore_blocks.findIndex(t => t.toLowerCase() === name.toLowerCase());
            if (idx === -1) { toastr.info(`"${name}" is not blocked.`, 'DeepLore Enhanced'); return ''; }
            const removed = chat_metadata.deeplore_blocks.splice(idx, 1)[0];
            saveSettingsDebounced();
            toastr.success(`Unblocked "${removed}".`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Remove a per-chat block. Usage: /dle-unblock <entry name>',
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
            let html = '<div style="text-align: left;">';
            if (pins.length > 0) {
                html += `<h4>Pinned (${pins.length})</h4><ul>`;
                for (const p of pins) html += `<li style="color: #4caf50;">${escapeHtml(p)}</li>`;
                html += '</ul>';
            }
            if (blocks.length > 0) {
                html += `<h4>Blocked (${blocks.length})</h4><ul>`;
                for (const b of blocks) html += `<li style="color: #f44336;">${escapeHtml(b)}</li>`;
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

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-era',
        callback: async (_args, value) => {
            const ctx = ensureCtx();
            const v = (value || '').trim();
            if (!v) {
                ctx.era = '';
                saveSettingsDebounced();
                toastr.success('Era cleared.', 'DeepLore Enhanced');
                return '';
            }
            ctx.era = v;
            saveSettingsDebounced();
            toastr.success(`Era set to "${v}" for this chat.`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Set the current era/time period for contextual gating. Entries with a matching "era" frontmatter field will be prioritized. Use without args to clear.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-location',
        callback: async (_args, value) => {
            const ctx = ensureCtx();
            const v = (value || '').trim();
            if (!v) {
                ctx.location = '';
                saveSettingsDebounced();
                toastr.success('Location cleared.', 'DeepLore Enhanced');
                return '';
            }
            ctx.location = v;
            saveSettingsDebounced();
            toastr.success(`Location set to "${v}" for this chat.`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Set the current location for contextual gating. Entries with a matching "location" frontmatter field will be prioritized. Use without args to clear.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-scene',
        callback: async (_args, value) => {
            const ctx = ensureCtx();
            const v = (value || '').trim();
            if (!v) {
                ctx.scene_type = '';
                saveSettingsDebounced();
                toastr.success('Scene type cleared.', 'DeepLore Enhanced');
                return '';
            }
            ctx.scene_type = v;
            saveSettingsDebounced();
            toastr.success(`Scene type set to "${v}" for this chat.`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Set the current scene type (combat, exploration, social, etc.) for contextual gating. Use without args to clear.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-set-characters',
        callback: async (_args, value) => {
            const ctx = ensureCtx();
            const v = (value || '').trim();
            if (!v) {
                ctx.characters_present = [];
                saveSettingsDebounced();
                toastr.success('Present characters cleared.', 'DeepLore Enhanced');
                return '';
            }
            ctx.characters_present = v.split(',').map(c => c.trim()).filter(Boolean);
            saveSettingsDebounced();
            toastr.success(`Characters present: ${ctx.characters_present.join(', ')}`, 'DeepLore Enhanced');
            return '';
        },
        helpString: 'Set which characters are present (comma-separated). Entries with matching "character_present" frontmatter will inject. Use without args to clear.',
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

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-inspect',
        callback: async () => {
            if (!lastPipelineTrace) {
                toastr.info('No pipeline trace yet. Send a message first to populate the inspector.', 'DeepLore Enhanced');
                return '';
            }
            const t = lastPipelineTrace;
            const statusIcon = (ok) => ok ? '✓' : '✗';
            let html = `<div style="text-align: left; font-family: monospace; font-size: 0.85em;">`;
            html += `<h3>Pipeline Inspector</h3>`;
            html += `<p><b>Mode:</b> ${escapeHtml(t.mode)} | <b>Indexed:</b> ${t.indexed} | <b>Bootstrap active:</b> ${t.bootstrapActive ? 'yes' : 'no'} | <b>AI fallback:</b> ${t.aiFallback ? 'yes' : 'no'}</p>`;

            if (t.keywordMatched.length > 0) {
                html += `<h4>${statusIcon(true)} Keyword Matched (${t.keywordMatched.length})</h4><ul>`;
                for (const m of t.keywordMatched) {
                    html += `<li>${escapeHtml(m.title)} — ${escapeHtml(m.matchedBy)}</li>`;
                }
                html += '</ul>';
            }

            if (t.aiSelected.length > 0) {
                html += `<h4>${statusIcon(true)} AI Selected (${t.aiSelected.length})</h4><ul>`;
                for (const m of t.aiSelected) {
                    html += `<li>${escapeHtml(m.title)} [${escapeHtml(m.confidence)}] — ${escapeHtml(m.reason)}</li>`;
                }
                html += '</ul>';
            }

            if (t.aiFallback) {
                html += `<p style="color: var(--warning, #ff9800);">⚠ AI search failed — keyword results used as fallback</p>`;
            }

            html += '</div>';
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
            return '';
        },
        helpString: 'Show the last pipeline trace: which entries matched, why, and what the AI selected.',
        returns: 'Pipeline inspector popup',
    }));
}
