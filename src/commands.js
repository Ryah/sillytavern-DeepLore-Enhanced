/**
 * DeepLore Enhanced — Slash Commands
 */
import {
    getRequestHeaders,
    sendMessageAsUser,
    Generate,
    chat,
    chat_metadata,
    name2,
} from '../../../../script.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { escapeHtml } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { parseFrontmatter, simpleHash, buildAiChatContext } from '../core/utils.js';
import { applyGating, formatAndGroup } from '../core/matching.js';
import { getSettings, getPrimaryVault, PLUGIN_BASE, PROMPT_TAG_PREFIX, DEFAULT_AI_SYSTEM_PROMPT } from '../settings.js';
import {
    vaultIndex, aiSearchStats, indexTimestamp, scribeInProgress,
    lastPipelineTrace,
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

            const { finalEntries, matchedKeys } = await runPipeline(chat);
            const gated = applyGating(finalEntries);
            const { count: injectedCount, totalTokens } = formatAndGroup(gated, getSettings(), PROMPT_TAG_PREFIX);
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
                const response = await fetch(`${PLUGIN_BASE}/scribe-notes`, {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        port: histVault.port,
                        apiKey: histVault.apiKey,
                        folder: settings.scribeFolder,
                    }),
                });

                if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
                const data = await response.json();
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
