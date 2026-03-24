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
import { saveSettingsDebounced, saveChatDebounced } from '../../../../../script.js';
import { escapeHtml } from '../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../slash-commands/SlashCommand.js';
import { parseFrontmatter, simpleHash, buildAiChatContext, classifyError, NO_ENTRIES_MSG } from '../core/utils.js';
import { formatAndGroup } from '../core/matching.js';
import { buildExemptionPolicy, applyRequiresExcludesGating, applyContextualGating } from './stages.js';
import { getSettings, getPrimaryVault, PROMPT_TAG_PREFIX, DEFAULT_AI_SYSTEM_PROMPT, invalidateSettingsCache } from '../settings.js';
import { fetchScribeNotes } from './obsidian-api.js';
import {
    vaultIndex, aiSearchStats, indexTimestamp, scribeInProgress, buildPromise,
    lastPipelineTrace, injectionHistory, generationCount, generationLock,
    trackerKey, setIndexTimestamp,
    notifyGatingChanged, notifyPinBlockChanged,
} from './state.js';
import { buildIndex, ensureIndexFresh, getMaxResponseTokens } from './vault.js';
import { buildCandidateManifest } from './ai.js';
import { matchEntries, runPipeline } from './pipeline.js';
import { runScribe } from './scribe.js';
import { runAutoSuggest, showSuggestionPopup } from './auto-suggest.js';
import { showSourcesPopup } from './cartographer.js';
import { runSimulation, showSimulationPopup, showGraphPopup, optimizeEntryKeys, showOptimizePopup, showNotebookPopup, showBrowsePopup, buildCopyButton, attachCopyHandler } from './popups.js';
import { runHealthCheck } from './diagnostics.js';
import { parseWorldInfoJson, importEntries } from './import.js';
import { world_names, loadWorldInfo } from '../../../../world-info.js';

export function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-simulate',
        callback: async () => {
            if (!chat || chat.length === 0) {
                toastr.info('No active chat.', 'DeepLore Enhanced');
                return '';
            }
            await ensureIndexFresh();
            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
                return '';
            }
            toastr.info('Running activation simulation...', 'DeepLore Enhanced', { timeOut: 2000 });
            const timeline = runSimulation(chat);
            showSimulationPopup(timeline);
            return '';
        },
        helpString: 'Replay chat history step-by-step, showing which entries activate and deactivate at each message.',
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
                toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
                return '';
            }
            const name = (entryName || '').trim();
            if (!name) {
                toastr.info('Usage: /dle-optimize-keys <entry name>', 'DeepLore Enhanced');
                return '';
            }
            const entry = vaultIndex.find(e => e.title.toLowerCase() === name.toLowerCase());
            if (!entry) {
                toastr.warning(`Entry "${name}" not found.`, 'DeepLore Enhanced');
                return '';
            }
            const loadingToast = toastr.info(`Optimizing keywords for "${entry.title}"...`, 'DeepLore Enhanced', { timeOut: 0, extendedTimeOut: 0 });
            try {
                const result = await optimizeEntryKeys(entry);
                toastr.clear(loadingToast);
                await showOptimizePopup(entry, result);
            } catch (err) {
                toastr.clear(loadingToast);
                console.error('[DLE] Optimize keys error:', err);
                toastr.error(classifyError(err), 'DeepLore Enhanced');
            }
            return '';
        },
        helpString: 'Suggest better keywords for an entry using AI. Usage: /dle-optimize-keys <entry name>.',
        returns: 'Optimization popup',
    }));

    const newloreCallback = async () => {
        if (!chat || chat.length === 0) {
            toastr.info('No active chat.', 'DeepLore Enhanced');
            return '';
        }
        const loadingToast = toastr.info('Analyzing chat for new entries...', 'DeepLore Enhanced', { timeOut: 0, extendedTimeOut: 0 });
        try {
            const suggestions = await runAutoSuggest();
            toastr.clear(loadingToast);
            await showSuggestionPopup(suggestions);
        } catch (err) {
            toastr.clear(loadingToast);
            console.error('[DLE] Auto-suggest error:', err);
            toastr.error(classifyError(err), 'DeepLore Enhanced');
        }
        return '';
    };
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-newlore',
        callback: newloreCallback,
        helpString: 'Analyze the chat for characters, locations, and concepts not in your lorebook, and suggest new entries to create.',
        returns: 'Suggestion popup',
    }));
    // Backwards-compatible alias
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-suggest',
        callback: newloreCallback,
        helpString: 'Analyze the chat and suggest new lorebook entries. Alias for /dle-newlore.',
        returns: 'Suggestion popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-why',
        aliases: ['dle-context'],
        callback: async () => {
            if (!chat || chat.length === 0) {
                toastr.info('No active chat.', 'DeepLore Enhanced');
                return '';
            }
            if (generationLock) {
                toastr.warning('A generation is in progress — wait for it to finish.', 'DeepLore Enhanced');
                return '';
            }
            // Await any in-progress index build to prevent concurrent pipeline execution
            if (buildPromise) await buildPromise;
            await ensureIndexFresh();
            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
                return '';
            }

            const settings = getSettings();
            // Confirm if AI search is enabled — this command makes real API calls
            if (settings.aiSearchEnabled) {
                const proceed = await callGenericPopup('This will make a live AI search call and use API tokens. Continue?', POPUP_TYPE.CONFIRM);
                if (!proceed) return '';
            }
            const { finalEntries, matchedKeys } = await runPipeline(chat);

            // Apply re-injection cooldown (matches onGenerate order)
            let filtered = finalEntries;
            if (settings.reinjectionCooldown > 0) {
                filtered = finalEntries.filter(e => {
                    if (e.constant) return true;
                    const lastGen = injectionHistory.get(trackerKey(e));
                    return lastGen === undefined || (generationCount - lastGen) >= settings.reinjectionCooldown;
                });
            }

            // Apply contextual gating (era/location/scene/character) — matches onGenerate order
            const gatingContext = chat_metadata?.deeplore_context;
            if (gatingContext) {
                filtered = applyContextualGating(filtered, gatingContext, { forceInject: new Set() }, settings.debugMode, settings);
            }

            const cmdPins = chat_metadata.deeplore_pins || [];
            const cmdBlocks = chat_metadata.deeplore_blocks || [];
            const cmdPolicy = buildExemptionPolicy(vaultIndex, cmdPins, cmdBlocks);
            const { result: gated } = applyRequiresExcludesGating(filtered, cmdPolicy, settings.debugMode);
            const { count: injectedCount, totalTokens, acceptedEntries } = formatAndGroup(gated, settings, PROMPT_TAG_PREFIX);
            const injected = acceptedEntries || gated.slice(0, injectedCount);

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
        helpString: 'Preview which entries would be included in the next message, and why. Alias: /dle-context',
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
        helpString: 'Open the Notebook editor for the current chat.',
        returns: 'Opens notebook popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-refresh',
        callback: async () => {
            // Don't pre-clear vaultIndex — buildIndex replaces it atomically.
            // Pre-clearing would give zero entries to any generation during rebuild.
            setIndexTimestamp(0);
            await buildIndex();
            const msg = `Indexed ${vaultIndex.length} entries.`;
            toastr.success(msg, 'DeepLore Enhanced');
            return msg;
        },
        helpString: 'Rebuild the vault index by re-fetching all entries from Obsidian.',
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
                `Cache: ${indexTimestamp ? Math.round((Date.now() - indexTimestamp) / 1000) + 's old' : 'none'} / TTL ${settings.cacheTTL} seconds`,
                `AI Search: ${settings.aiSearchEnabled ? 'on' : 'off'}`,
                `AI Stats: ${aiSearchStats.calls} calls, ${aiSearchStats.cachedHits} cache hits, ~${aiSearchStats.totalInputTokens} in / ~${aiSearchStats.totalOutputTokens} out tokens`,
                `Auto-Sync: ${settings.syncPollingInterval > 0 ? settings.syncPollingInterval + 's interval' : 'off'}`,
            ];
            const msg = lines.join('\n');
            const html = `<div class="dle-popup">${buildCopyButton(msg)}<pre style="white-space: pre-wrap; font-size: 0.9em;">${escapeHtml(msg)}</pre></div>`;
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
        helpString: 'Write a session summary note to Obsidian. Usage: /dle-scribe <focus topic>. Example: /dle-scribe What happened with the sword?',
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

                let html = '<div class="dle-popup">';
                html += `<h3>Session Notes (${parsed.length})</h3>`;

                for (const note of parsed) {
                    const dateDisplay = note.date ? new Date(note.date).toLocaleString() : 'Unknown date';
                    const preview = note.body.substring(0, 200).replace(/\n/g, ' ') + (note.body.length > 200 ? '...' : '');
                    const noteId = simpleHash(note.filename);

                    html += `<div class="dle-card" style="padding: 10px; margin-bottom: var(--dle-space-2);">`;
                    html += `<div class="dle_note_toggle dle-card-header" data-target="dle_note_${noteId}">`;
                    html += `<strong>${escapeHtml(note.character || 'Unknown')}</strong>`;
                    html += `<small class="dle-muted">${escapeHtml(dateDisplay)}</small>`;
                    html += `</div>`;
                    html += `<small class="dle-faint">${escapeHtml(preview)}</small>`;
                    html += `<div id="dle_note_${noteId}" style="display: none; margin-top: var(--dle-space-2); padding-top: var(--dle-space-2); border-top: 1px solid var(--dle-border); white-space: pre-wrap; font-size: 0.9em;">${escapeHtml(note.body)}</div>`;
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
        name: 'dle-review',
        callback: async (_args, userPrompt) => {
            await ensureIndexFresh();

            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
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
        helpString: 'Send the entire vault to the AI for review and feedback. Usage: /dle-review <question>. Example: /dle-review What inconsistencies do you see?',
        returns: 'AI review posted to chat',
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
                html += `<tr><td>${escapeHtml(title)}</td><td style="text-align:center;">${d.matched || 0}</td><td style="text-align:center;">${d.injected || 0}</td><td style="text-align:center;">${lastUsed}</td></tr>`;
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

            // Capture input values while popup is still open using onOpen + live binding
            let vaultName = 'Primary', port = 27123, apiKey = '';
            const step1Ok = await callGenericPopup(step1Html, POPUP_TYPE.CONFIRM, '', {
                wide: true,
                onOpen: () => {
                    // Attach input handlers to capture values in real-time
                    const nameEl = document.getElementById('dle_setup_name');
                    const portEl = document.getElementById('dle_setup_port');
                    const keyEl = document.getElementById('dle_setup_key');
                    if (nameEl) { vaultName = nameEl.value.trim() || 'Primary'; nameEl.addEventListener('input', () => { vaultName = nameEl.value.trim() || 'Primary'; }); }
                    if (portEl) { port = parseInt(portEl.value) || 27123; portEl.addEventListener('input', () => { port = parseInt(portEl.value) || 27123; }); }
                    if (keyEl) { apiKey = keyEl.value.trim() || ''; keyEl.addEventListener('input', () => { apiKey = keyEl.value.trim() || ''; }); }
                },
            });
            if (!step1Ok) return '';

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
                <div class="dle-popup">
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
            settings.vaults = [{ name: vaultName, port, apiKey, enabled: true }];
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
                        <li>Vault: <b>${escapeHtml(vaultName)}</b> on port ${port}</li>
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

    // ── Auto-Summary Generation ──

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-summarize',
        callback: async () => {
            await ensureIndexFresh();
            if (vaultIndex.length === 0) {
                toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
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
                toastr.info(`Generating summary ${i + 1}/${missingSummary.length}: "${entry.title}"...`, 'DeepLore Enhanced', { timeOut: 0, extendedTimeOut: 0 });

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
                        <div class="dle-popup">
                            <h4>${escapeHtml(entry.title)} (${i + 1}/${missingSummary.length})</h4>
                            <p class="dle-text-sm dle-muted">Entry content preview: ${escapeHtml(entry.content.substring(0, 200))}...</p>
                            <hr>
                            <p><b>Generated Summary:</b></p>
                            <textarea id="dle_summary_edit" class="text_pole" style="height: 100px; font-size: 0.9em;">${escapeHtml(summary)}</textarea>
                            <p class="dle-text-xs dle-faint">Edit the summary above if needed. Click OK to write to Obsidian, Cancel to skip.</p>
                        </div>`;

                    let capturedTextarea = null;
                    const approved = await callGenericPopup(reviewHtml, POPUP_TYPE.CONFIRM, '', {
                        wide: true,
                        onOpen: () => { capturedTextarea = document.getElementById('dle_summary_edit'); },
                    });

                    if (!approved) {
                        skipped++;
                        continue;
                    }

                    const finalSummary = capturedTextarea?.value?.trim() || summary;

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

            // Build lorebook dropdown options
            const hasLorebooks = Array.isArray(world_names) && world_names.length > 0;
            const lbOptions = hasLorebooks
                ? world_names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')
                : '';

            // Capture JSON in closure — popup DOM is removed before callGenericPopup resolves
            let capturedJson = '';

            // Show popup with three input methods
            const jsonInput = await callGenericPopup(
                `<div class="dle-popup">
                    <h3>Import SillyTavern World Info</h3>
                    <p>Import entries from an existing SillyTavern lorebook, a local JSON file, or paste JSON directly.</p>
                    ${folder ? `<p>Target folder: <strong>${escapeHtml(folder)}</strong></p>` : '<p>Entries will be created in the vault root. Pass a folder name as argument, e.g. <code>/dle-import Imported</code></p>'}

                    <!-- Lorebook dropdown -->
                    <div id="dle_import_lb_section" style="margin-bottom: 8px;${hasLorebooks ? '' : ' display: none;'}">
                        <label><small>Select a SillyTavern Lorebook</small></label>
                        <select id="dle_import_lorebook" class="text_pole">
                            <option value="">— Select a lorebook —</option>
                            ${lbOptions}
                        </select>
                    </div>

                    <!-- File browse button -->
                    <div style="margin-bottom: 8px;">
                        <input type="file" id="dle_import_file" accept=".json" style="display: none;" />
                        <div id="dle_import_browse" class="menu_button menu_button_icon" style="display: inline-flex;">
                            <i class="fa-solid fa-file-import"></i>
                            <span>Browse local JSON file...</span>
                        </div>
                    </div>

                    <!-- Textarea for manual paste -->
                    <label><small>Or paste JSON below</small></label>
                    <textarea id="dle_import_json" class="text_pole" style="height: 200px; font-family: monospace; font-size: 0.85em;" placeholder="Paste World Info JSON here..."></textarea>
                </div>`,
                POPUP_TYPE.CONFIRM, '', { wide: true, onOpen: () => {
                    const lbSelect = document.getElementById('dle_import_lorebook');
                    const textarea = document.getElementById('dle_import_json');

                    // Capture manual paste/typing
                    if (textarea) {
                        textarea.addEventListener('input', () => { capturedJson = textarea.value; });
                    }

                    // Wire lorebook dropdown → load and fill textarea
                    if (lbSelect) {
                        lbSelect.addEventListener('change', async () => {
                            const name = lbSelect.value;
                            if (!name) return;
                            try {
                                const data = await loadWorldInfo(name);
                                if (!data) {
                                    toastr.error(`Failed to load lorebook "${name}".`, 'DeepLore Enhanced');
                                    return;
                                }
                                const json = JSON.stringify(data, null, 2);
                                if (textarea) textarea.value = json;
                                capturedJson = json;
                            } catch (err) {
                                console.error('[DLE] loadWorldInfo error:', err);
                                toastr.error(classifyError(err), 'DeepLore Enhanced');
                            }
                        });
                    }

                    // Wire browse button → hidden file input
                    const browseBtn = document.getElementById('dle_import_browse');
                    const fileInput = document.getElementById('dle_import_file');
                    if (browseBtn && fileInput) {
                        browseBtn.addEventListener('click', () => fileInput.click());
                        fileInput.addEventListener('change', () => {
                            const file = fileInput.files?.[0];
                            if (!file) return;
                            const reader = new FileReader();
                            reader.onload = () => {
                                const text = /** @type {string} */ (reader.result);
                                if (textarea) textarea.value = text;
                                capturedJson = text;
                            };
                            reader.onerror = () => {
                                toastr.error('Failed to read file.', 'DeepLore Enhanced');
                            };
                            reader.readAsText(file);
                        });
                    }
                } },
            );

            if (!jsonInput) return '';

            // ── Validation ──
            const jsonText = capturedJson.trim();
            if (!jsonText) {
                toastr.warning('No JSON provided.', 'DeepLore Enhanced');
                return '';
            }

            // File size check (> 10 MB)
            if (jsonText.length > 10 * 1024 * 1024) {
                const proceed = await callGenericPopup(
                    '<p>The input is larger than 10 MB. This may take a while to process. Continue?</p>',
                    POPUP_TYPE.CONFIRM, '', {},
                );
                if (!proceed) return '';
            }

            // JSON parse validation
            try {
                JSON.parse(jsonText);
            } catch (parseErr) {
                toastr.error(`Invalid JSON: ${parseErr.message}`, 'DeepLore Enhanced');
                return '';
            }

            try {
                const { entries, source } = parseWorldInfoJson(jsonText);
                if (entries.length === 0) {
                    toastr.info('No entries found in the JSON.', 'DeepLore Enhanced');
                    return '';
                }

                // Warn about empty entries (no content AND no keys)
                const emptyCount = entries.filter(e =>
                    (!e.content || !e.content.trim()) && (!e.key || !e.key.length || e.key.every(k => !k.trim())),
                ).length;
                if (emptyCount > 0) {
                    toastr.warning(`${emptyCount} entries have no content and no keys — they will be imported but may be empty.`, 'DeepLore Enhanced');
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

                const renamedNote = result.renamed > 0 ? ` (${result.renamed} renamed to avoid overwrite)` : '';
                if (result.failed > 0) {
                    toastr.warning(`Imported ${result.imported}, failed ${result.failed}${renamedNote}. Check console for details.`, 'DeepLore Enhanced');
                    console.warn('[DLE] Import errors:', result.errors);
                } else {
                    toastr.success(`Imported ${result.imported} entries${renamedNote}.`, 'DeepLore Enhanced');
                }

                // Refresh index to pick up new entries
                setIndexTimestamp(0);
                await buildIndex();
            } catch (err) {
                console.error('[DLE] Import error:', err);
                toastr.error(classifyError(err), 'DeepLore Enhanced');
            }
            return '';
        },
        helpString: 'Import SillyTavern World Info JSON into the Obsidian vault. Usage: /dle-import <folder>. Example: /dle-import Imported.',
        returns: 'Import status',
    }));

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
     * Fields (era, location, sceneType) are string arrays on VaultEntry.
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
     * @param {string} label - Display label (e.g. "Era", "Location", "Scene Type")
     * @param {string} entryField - VaultEntry field name (e.g. "era", "location", "sceneType")
     * @param {string} ctxField - chat_metadata.deeplore_context field name (e.g. "era", "location", "scene_type")
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

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-inspect',
        callback: async () => {
            if (!lastPipelineTrace) {
                toastr.info('No trace data yet. Send a message first, then inspect.', 'DeepLore Enhanced');
                return '';
            }
            const t = lastPipelineTrace;
            const settings = getSettings();
            const statusIcon = (ok) => ok ? '✓' : '✗';

            // Helper: build a set of keyword-matched titles for cross-referencing gated entries
            const keywordMatchedTitles = new Set(t.keywordMatched.map(m => m.title.toLowerCase()));

            // Build plain-text version for clipboard
            const plainLines = [
                'Entry Inspector',
                `Mode: ${t.mode} | Indexed: ${t.indexed} | Bootstrap active: ${t.bootstrapActive ? 'yes' : 'no'} | AI fallback: ${t.aiFallback ? 'yes' : 'no'}`,
                '',
            ];
            if (t.keywordMatched.length > 0) {
                plainLines.push(`Keyword Matched (${t.keywordMatched.length}):`);
                for (const m of t.keywordMatched) plainLines.push(`  ${m.title} — ${m.matchedBy}`);
                plainLines.push('');
            }
            if (t.aiSelected.length > 0) {
                plainLines.push(`AI Selected (${t.aiSelected.length}):`);
                for (const m of t.aiSelected) plainLines.push(`  ${m.title} [${m.confidence}] — ${m.reason}`);
                plainLines.push('');
            }
            if (t.aiFallback) plainLines.push('WARNING: AI search failed — keyword results used as fallback', '');
            if (t.injected && t.injected.length > 0) {
                const budgetLabel = t.budgetLimit ? ` / ${t.budgetLimit} budget` : '';
                plainLines.push(`Injected (${t.injected.length}, ~${t.totalTokens || '?'} tokens${budgetLabel}):`);
                for (const e of t.injected) {
                    const truncLabel = e.truncated ? ` [truncated from ~${e.originalTokens}]` : '';
                    plainLines.push(`  ${e.title} (~${e.tokens} tokens)${truncLabel}`);
                }
                plainLines.push('');
            }
            if (t.contextualGatingRemoved && t.contextualGatingRemoved.length > 0) {
                plainLines.push(`Contextual Gating Removed (${t.contextualGatingRemoved.length}):`);
                for (const title of t.contextualGatingRemoved) plainLines.push(`  ${title}`);
                plainLines.push('');
            }
            if (t.cooldownRemoved && t.cooldownRemoved.length > 0) {
                plainLines.push(`Re-injection Cooldown Removed (${t.cooldownRemoved.length}):`);
                for (const title of t.cooldownRemoved) plainLines.push(`  ${title}`);
                plainLines.push('');
            }
            if (t.gatedOut && t.gatedOut.length > 0) {
                plainLines.push(`Gated Out (${t.gatedOut.length}):`);
                for (const e of t.gatedOut) {
                    const reasons = [];
                    if (e.requires?.length > 0) reasons.push(`requires: ${e.requires.join(', ')}`);
                    if (e.excludes?.length > 0) reasons.push(`excludes: ${e.excludes.join(', ')}`);
                    plainLines.push(`  ${e.title} — ${reasons.join('; ') || 'gating rule'}`);
                }
                plainLines.push('');
            }
            if (t.stripDedupRemoved && t.stripDedupRemoved.length > 0) {
                plainLines.push(`Strip Dedup Removed (${t.stripDedupRemoved.length}):`);
                for (const title of t.stripDedupRemoved) plainLines.push(`  ${title}`);
                plainLines.push('');
            }
            if (t.probabilitySkipped && t.probabilitySkipped.length > 0) {
                plainLines.push(`Probability Skipped (${t.probabilitySkipped.length}):`);
                for (const e of t.probabilitySkipped) plainLines.push(`  ${e.title} (probability: ${e.probability}, rolled: ${e.roll.toFixed(3)})`);
                plainLines.push('');
            }
            if (t.warmupFailed && t.warmupFailed.length > 0) {
                plainLines.push(`Warmup Not Met (${t.warmupFailed.length}):`);
                for (const e of t.warmupFailed) plainLines.push(`  ${e.title} (needed: ${e.needed}, found: ${e.found})`);
                plainLines.push('');
            }
            if (t.budgetCut && t.budgetCut.length > 0) {
                plainLines.push(`Budget/Max Cut (${t.budgetCut.length}):`);
                for (const e of t.budgetCut) plainLines.push(`  ${e.title} (pri ${e.priority}, ~${e.tokens} tokens)`);
                plainLines.push('');
            }
            const plainText = plainLines.join('\n');

            let html = `<div class="dle-popup dle-popup--mono">`;
            html += `<h3>Entry Inspector</h3>`;
            html += buildCopyButton(plainText);
            html += `<p><b>Mode:</b> ${escapeHtml(t.mode)} | <b>Indexed:</b> ${t.indexed} | <b>Bootstrap active:</b> ${t.bootstrapActive ? 'yes' : 'no'} | <b>AI fallback:</b> ${t.aiFallback ? 'yes' : 'no'}</p>`;

            // Check for completely empty pipeline
            const nothingMatched = t.keywordMatched.length === 0 && t.aiSelected.length === 0
                && (!t.injected || t.injected.length === 0);

            if (nothingMatched) {
                html += `<p style="color: var(--dle-warning);">No entries matched. Check scan depth (currently ${settings.scanDepth}), keyword coverage, or run /dle-health.</p>`;
            }

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
                html += `<p class="dle-text-xs dle-dimmed" style="margin-top: 2px;"><b>Confidence:</b> HIGH = strong match, MEDIUM = likely relevant, LOW = tangential or speculative</p>`;
            }

            if (t.aiFallback) {
                html += `<p style="color: var(--dle-warning);">⚠ AI search failed — keyword results used as fallback</p>`;
            }

            // Injected entries (post-budget)
            if (t.injected && t.injected.length > 0) {
                const budgetLabel = t.budgetLimit ? ` / ${t.budgetLimit} budget` : '';
                html += `<h4>${statusIcon(true)} Injected (${t.injected.length}, ~${t.totalTokens || '?'} tokens${budgetLabel})</h4><ul>`;
                for (const e of t.injected) {
                    const truncLabel = e.truncated ? ` <span style="color: var(--dle-warning);">[truncated from ~${e.originalTokens}]</span>` : '';
                    html += `<li>${escapeHtml(e.title)} (~${e.tokens} tokens)${truncLabel}</li>`;
                }
                html += '</ul>';
            }

            // Contextual gating removals
            if (t.contextualGatingRemoved && t.contextualGatingRemoved.length > 0) {
                html += `<h4 style="color: var(--dle-warning);">${statusIcon(false)} Contextual Gating Removed (${t.contextualGatingRemoved.length})</h4><ul>`;
                for (const title of t.contextualGatingRemoved) {
                    html += `<li>${escapeHtml(title)} — filtered by era/location/scene/character gate</li>`;
                }
                html += '</ul>';
            }

            // Re-injection cooldown removals
            if (t.cooldownRemoved && t.cooldownRemoved.length > 0) {
                html += `<h4 style="color: var(--dle-warning);">${statusIcon(false)} Re-injection Cooldown (${t.cooldownRemoved.length})</h4><ul>`;
                for (const title of t.cooldownRemoved) {
                    html += `<li>${escapeHtml(title)} — recently injected, on cooldown</li>`;
                }
                html += '</ul>';
            }

            // Gated out entries (requires/excludes) with cross-referencing
            if (t.gatedOut && t.gatedOut.length > 0) {
                html += `<h4 style="color: var(--dle-warning);">${statusIcon(false)} Gated Out (${t.gatedOut.length})</h4><ul>`;
                for (const e of t.gatedOut) {
                    const reasons = [];
                    if (e.requires?.length > 0) {
                        const missing = e.requires.filter(r => !keywordMatchedTitles.has(r.toLowerCase()));
                        if (missing.length > 0) {
                            reasons.push(`requires: ${e.requires.join(', ')} (missing: ${missing.join(', ')})`);
                        } else {
                            reasons.push(`requires: ${e.requires.join(', ')} (all present but removed by later stage)`);
                        }
                    }
                    if (e.excludes?.length > 0) {
                        const blocking = e.excludes.filter(r => keywordMatchedTitles.has(r.toLowerCase()));
                        if (blocking.length > 0) {
                            reasons.push(`excludes: ${e.excludes.join(', ')} (blocking: ${blocking.join(', ')})`);
                        } else {
                            reasons.push(`excludes: ${e.excludes.join(', ')}`);
                        }
                    }
                    html += `<li>${escapeHtml(e.title)} — ${escapeHtml(reasons.join('; ') || 'gating rule')}</li>`;
                }
                html += '</ul>';
            }

            // Strip dedup removals
            if (t.stripDedupRemoved && t.stripDedupRemoved.length > 0) {
                html += `<h4 style="color: var(--dle-warning);">${statusIcon(false)} Strip Dedup Removed (${t.stripDedupRemoved.length})</h4><ul>`;
                for (const title of t.stripDedupRemoved) {
                    html += `<li>${escapeHtml(title)} — already injected in recent generation(s)</li>`;
                }
                html += '</ul>';
            }

            // Probability skips
            if (t.probabilitySkipped && t.probabilitySkipped.length > 0) {
                html += `<h4 style="color: var(--dle-warning);">${statusIcon(false)} Probability Skipped (${t.probabilitySkipped.length})</h4><ul>`;
                for (const e of t.probabilitySkipped) {
                    const rollLabel = e.probability === 0 ? 'probability is 0 (never fires)' : `rolled ${e.roll.toFixed(3)} > ${e.probability}`;
                    html += `<li>${escapeHtml(e.title)} — ${rollLabel}</li>`;
                }
                html += '</ul>';
            }

            // Warmup failures
            if (t.warmupFailed && t.warmupFailed.length > 0) {
                html += `<h4 style="color: var(--dle-warning);">${statusIcon(false)} Warmup Not Met (${t.warmupFailed.length})</h4><ul>`;
                for (const e of t.warmupFailed) {
                    html += `<li>${escapeHtml(e.title)} — needs ${e.needed} keyword occurrences, found ${e.found}</li>`;
                }
                html += '</ul>';
            }

            // Budget/max cut entries
            if (t.budgetCut && t.budgetCut.length > 0) {
                html += `<h4 style="color: var(--dle-warning);">${statusIcon(false)} Budget/Max Cut (${t.budgetCut.length})</h4><ul>`;
                for (const e of t.budgetCut) {
                    html += `<li>${escapeHtml(e.title)} (pri ${e.priority}, ~${e.tokens} tokens)</li>`;
                }
                html += '</ul>';
            }

            html += '</div>';
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', {
                wide: true, allowVerticalScrolling: true,
                onOpen: () => attachCopyHandler(document.querySelector('.popup')),
            });
            return '';
        },
        helpString: 'Show which entries matched, why, and what the AI selected in the last message.',
        returns: 'Entry inspector popup',
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
                { cmd: '/dle-set-era [era]', desc: 'Set era filter (no arg = browse values)' },
                { cmd: '/dle-set-location [loc]', desc: 'Set location filter (no arg = browse values)' },
                { cmd: '/dle-set-scene [type]', desc: 'Set scene type filter (no arg = browse values)' },
                { cmd: '/dle-set-characters &lt;names&gt;', desc: 'Set present characters' },
                { cmd: '/dle-context-state', desc: 'Show current gating state' },
            ];
            let html = '<div class="dle-popup"><h3>DeepLore Enhanced Commands</h3>';
            for (const c of commands) {
                if (c.sep) {
                    html += `<h4 class="dle-muted" style="margin: var(--dle-space-3) 0 var(--dle-space-1);">${escapeHtml(c.label)}</h4>`;
                    continue;
                }
                html += `<div style="margin-bottom: var(--dle-space-1);"><code class="dle-muted">${c.cmd}</code> — ${escapeHtml(c.desc)}</div>`;
            }
            html += '</div>';
            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
            return '';
        },
        helpString: 'Show all DeepLore Enhanced slash commands with descriptions.',
        returns: 'Help popup',
    }));
}
