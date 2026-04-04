/**
 * DeepLore Enhanced — Slash Commands: Pipeline Inspection
 * /dle-simulate, /dle-why, /dle-inspect
 */
import { chat, chat_metadata } from '../../../../../../script.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { NO_ENTRIES_MSG, classifyError } from '../../core/utils.js';
import { formatAndGroup } from '../../core/matching.js';
import { buildExemptionPolicy, applyRequiresExcludesGating, applyContextualGating } from '../stages.js';
import { getSettings, PROMPT_TAG_PREFIX } from '../../settings.js';
import {
    vaultIndex, lastPipelineTrace, injectionHistory, generationCount,
    generationLock, trackerKey, buildPromise, fieldDefinitions,
} from '../state.js';
import { DEFAULT_FIELD_DEFINITIONS } from '../fields.js';
import { ensureIndexFresh } from '../vault/vault.js';
import { runPipeline } from '../pipeline/pipeline.js';
import { showSourcesPopup } from './cartographer.js';
import { runSimulation, showSimulationPopup, buildCopyButton, attachCopyHandler } from './popups.js';

export function registerPipelineCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-simulate',
        callback: async () => {
            if (!chat || chat.length === 0) {
                toastr.info('No active chat.', 'DeepLore Enhanced');
                return '';
            }
            try { await ensureIndexFresh(); } catch (err) {
                toastr.error(`Could not refresh vault: ${classifyError(err)}`, 'DeepLore Enhanced');
                console.error('[DLE] ensureIndexFresh failed in /dle-simulate:', err);
                return '';
            }
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
            try { await ensureIndexFresh(); } catch (err) {
                toastr.error(`Could not refresh vault: ${classifyError(err)}`, 'DeepLore Enhanced');
                console.error('[DLE] ensureIndexFresh failed in /dle-why:', err);
                return '';
            }
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
            // BUG-F2: Pass context/pins/blocks to runPipeline so AI pre-filter respects gating
            const gatingContext = chat_metadata?.deeplore_context || {};
            const cmdPins = chat_metadata.deeplore_pins || [];
            const cmdBlocks = chat_metadata.deeplore_blocks || [];
            const { finalEntries, matchedKeys } = await runPipeline(chat, [...vaultIndex], gatingContext, { pins: cmdPins, blocks: cmdBlocks });

            // Apply re-injection cooldown (matches onGenerate order)
            let filtered = finalEntries;
            if (settings.reinjectionCooldown > 0) {
                filtered = finalEntries.filter(e => {
                    if (e.constant) return true;
                    const lastGen = injectionHistory.get(trackerKey(e));
                    return lastGen === undefined || (generationCount - lastGen) >= settings.reinjectionCooldown;
                });
            }

            // Post-filter contextual gating (matches onGenerate's post-pipeline gating)
            if (gatingContext && Object.keys(gatingContext).length > 0) {
                const fieldDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
                const cmdPolicy = buildExemptionPolicy(vaultIndex, cmdPins, cmdBlocks);
                filtered = applyContextualGating(filtered, gatingContext, cmdPolicy, settings.debugMode, settings, fieldDefs);
            }

            const cmdPolicy2 = buildExemptionPolicy(vaultIndex, cmdPins, cmdBlocks);
            const { result: gated } = applyRequiresExcludesGating(filtered, cmdPolicy2, settings.debugMode);
            const { count: injectedCount, totalTokens, acceptedEntries } = formatAndGroup(gated, settings, PROMPT_TAG_PREFIX);
            const injected = acceptedEntries || gated.slice(0, injectedCount);

            if (injected.length === 0) {
                toastr.info('No entries would be injected right now — no keywords or fuzzy matches found in the current chat.', 'DeepLore Enhanced');
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
        name: 'dle-inspect',
        aliases: ['dle-i'],
        callback: async () => {
            if (!lastPipelineTrace) {
                toastr.info('No inspection data available yet. Send a chat message first so DeepLore can process entries.', 'DeepLore Enhanced');
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
                ...(t.aiPreFilter?.removed > 0 ? [`AI pre-filter: ${t.aiPreFilter.removed} entries hidden from AI by contextual gating (${t.aiPreFilter.before} → ${t.aiPreFilter.after})`] : []),
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
            if (t.fuzzyStats?.active) {
                plainLines.push(`Fuzzy Search: ${t.fuzzyStats.matched} matched from ${t.fuzzyStats.candidates} candidates (threshold: ${t.fuzzyStats.threshold})`);
                plainLines.push('');
            }
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
                const gatingCtx = chat_metadata?.deeplore_context || {};
                const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
                for (const title of t.contextualGatingRemoved) {
                    const entry = vaultIndex.find(e => e.title === title);
                    const reasons = [];
                    if (entry?.customFields) {
                        for (const fd of allDefs) {
                            if (!fd.gating?.enabled) continue;
                            const ev = entry.customFields[fd.name];
                            const av = gatingCtx[fd.contextKey];
                            if (ev == null || ev === '' || (Array.isArray(ev) && !ev.length)) continue;
                            const evStr = Array.isArray(ev) ? ev.join(',') : String(ev);
                            const avStr = av == null || av === '' || (Array.isArray(av) && !av.length) ? '(not set)' : (Array.isArray(av) ? av.join(',') : String(av));
                            if (avStr === '(not set)' || evStr !== avStr) reasons.push(`${fd.name}: ${evStr} ≠ ${avStr}`);
                        }
                    }
                    plainLines.push(`  ${title}${reasons.length ? ' — ' + reasons.join(', ') : ''}`);
                }
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
            if (t.refineKeyBlocked && t.refineKeyBlocked.length > 0) {
                plainLines.push(`Refine Key Blocked (${t.refineKeyBlocked.length}):`);
                for (const e of t.refineKeyBlocked) plainLines.push(`  ${e.title} — matched "${e.primaryKey}" but none of [${e.refineKeys.join(', ')}] found`);
                plainLines.push('');
            }
            const plainText = plainLines.join('\n');

            let html = `<div class="dle-popup">`;
            html += `<h3>Entry Inspector</h3>`;
            html += buildCopyButton(plainText);
            html += `<p><b>Mode:</b> ${escapeHtml(t.mode)} | <b>Indexed:</b> ${t.indexed} | <b>Bootstrap active:</b> ${t.bootstrapActive ? 'yes' : 'no'} | <b>AI fallback:</b> ${t.aiFallback ? 'yes' : 'no'}</p>`;
            if (t.aiPreFilter?.removed > 0) {
                html += `<p class="dle-text-xs dle-dimmed">AI pre-filter: ${t.aiPreFilter.removed} entries hidden from AI by contextual gating (${t.aiPreFilter.before} → ${t.aiPreFilter.after})</p>`;
            }

            // Check for completely empty pipeline
            const nothingMatched = t.keywordMatched.length === 0 && t.aiSelected.length === 0
                && (!t.injected || t.injected.length === 0);

            if (nothingMatched) {
                html += `<p class="dle-text-warning">No entries matched. Check scan depth (currently ${settings.scanDepth}), keyword coverage, or run /dle-health.</p>`;
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
                html += `<p class="dle-text-xs dle-dimmed dle-mt-1"><b>Confidence:</b> HIGH = strong match, MEDIUM = likely relevant, LOW = tangential or speculative</p>`;
            }

            if (t.aiFallback) {
                html += `<p class="dle-text-warning">⚠ AI search failed — keyword results used as fallback</p>`;
            }

            // Fuzzy search stats
            if (t.fuzzyStats?.active) {
                const fIcon = t.fuzzyStats.matched > 0 ? statusIcon(true) : 'ℹ';
                html += `<h4>${fIcon} Fuzzy Search (BM25)</h4>`;
                html += `<p>${t.fuzzyStats.matched} entries matched from ${t.fuzzyStats.candidates} candidates (min score threshold: ${t.fuzzyStats.threshold})</p>`;
            }

            // Injected entries (post-budget)
            if (t.injected && t.injected.length > 0) {
                const budgetLabel = t.budgetLimit ? ` / ${t.budgetLimit} budget` : '';
                html += `<h4>${statusIcon(true)} Injected (${t.injected.length}, ~${t.totalTokens || '?'} tokens${budgetLabel})</h4><ul>`;
                for (const e of t.injected) {
                    const truncLabel = e.truncated ? ` <span class="dle-text-warning">[truncated from ~${e.originalTokens}]</span>` : '';
                    html += `<li>${escapeHtml(e.title)} (~${e.tokens} tokens)${truncLabel}</li>`;
                }
                html += '</ul>';
            }

            // Contextual gating removals (with per-field mismatch details)
            if (t.contextualGatingRemoved && t.contextualGatingRemoved.length > 0) {
                html += `<h4 class="dle-text-warning">${statusIcon(false)} Contextual Gating Removed (${t.contextualGatingRemoved.length})</h4><ul>`;
                const gatingCtx = chat_metadata?.deeplore_context || {};
                const allDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
                for (const title of t.contextualGatingRemoved) {
                    const entry = vaultIndex.find(e => e.title === title);
                    const reasons = [];
                    if (entry?.customFields) {
                        for (const fd of allDefs) {
                            if (!fd.gating?.enabled) continue;
                            const ev = entry.customFields[fd.name];
                            const av = gatingCtx[fd.contextKey];
                            if (ev == null || ev === '' || (Array.isArray(ev) && !ev.length)) continue;
                            const evStr = Array.isArray(ev) ? ev.join(',') : String(ev);
                            const avStr = av == null || av === '' || (Array.isArray(av) && !av.length) ? '(not set)' : (Array.isArray(av) ? av.join(',') : String(av));
                            if (avStr === '(not set)' || evStr !== avStr) reasons.push(`${escapeHtml(fd.name)}: ${escapeHtml(evStr)} ≠ ${escapeHtml(avStr)}`);
                        }
                    }
                    const detail = reasons.length ? ` — ${reasons.join(', ')}` : ' — filtered by contextual gating';
                    html += `<li>${escapeHtml(title)}${detail}</li>`;
                }
                html += '</ul>';
            }

            // Re-injection cooldown removals
            if (t.cooldownRemoved && t.cooldownRemoved.length > 0) {
                html += `<h4 class="dle-text-warning">${statusIcon(false)} Re-injection Cooldown (${t.cooldownRemoved.length})</h4><ul>`;
                for (const title of t.cooldownRemoved) {
                    html += `<li>${escapeHtml(title)} — recently injected, on cooldown</li>`;
                }
                html += '</ul>';
            }

            // Gated out entries (requires/excludes) with cross-referencing
            if (t.gatedOut && t.gatedOut.length > 0) {
                html += `<h4 class="dle-text-warning">${statusIcon(false)} Gated Out (${t.gatedOut.length})</h4><ul>`;
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
                html += `<h4 class="dle-text-warning">${statusIcon(false)} Strip Dedup Removed (${t.stripDedupRemoved.length})</h4><ul>`;
                for (const title of t.stripDedupRemoved) {
                    html += `<li>${escapeHtml(title)} — already injected in recent generation(s)</li>`;
                }
                html += '</ul>';
            }

            // Probability skips
            if (t.probabilitySkipped && t.probabilitySkipped.length > 0) {
                html += `<h4 class="dle-text-warning">${statusIcon(false)} Probability Skipped (${t.probabilitySkipped.length})</h4><ul>`;
                for (const e of t.probabilitySkipped) {
                    const rollLabel = e.probability === 0 ? 'probability is 0 (never fires)' : `rolled ${e.roll.toFixed(3)} > ${e.probability}`;
                    html += `<li>${escapeHtml(e.title)} — ${rollLabel}</li>`;
                }
                html += '</ul>';
            }

            // Warmup failures
            if (t.warmupFailed && t.warmupFailed.length > 0) {
                html += `<h4 class="dle-text-warning">${statusIcon(false)} Warmup Not Met (${t.warmupFailed.length})</h4><ul>`;
                for (const e of t.warmupFailed) {
                    html += `<li>${escapeHtml(e.title)} — needs ${e.needed} keyword occurrences, found ${e.found}</li>`;
                }
                html += '</ul>';
            }

            // Budget/max cut entries
            if (t.budgetCut && t.budgetCut.length > 0) {
                html += `<h4 class="dle-text-warning">${statusIcon(false)} Budget/Max Cut (${t.budgetCut.length})</h4><ul>`;
                for (const e of t.budgetCut) {
                    html += `<li>${escapeHtml(e.title)} (pri ${e.priority}, ~${e.tokens} tokens)</li>`;
                }
                html += '</ul>';
            }

            // Refine key blocked entries
            if (t.refineKeyBlocked && t.refineKeyBlocked.length > 0) {
                html += `<h4 class="dle-text-warning">${statusIcon(false)} Refine Key Blocked (${t.refineKeyBlocked.length})</h4><ul>`;
                for (const e of t.refineKeyBlocked) {
                    html += `<li>${escapeHtml(e.title)} — matched "<b>${escapeHtml(e.primaryKey)}</b>" but none of [${e.refineKeys.map(k => escapeHtml(k)).join(', ')}] found in scan text</li>`;
                }
                html += '</ul>';
                html += `<p class="dle-text-xs dle-dimmed">Refine keys (AND_ANY mode): primary keyword must match AND at least one refine key must also appear.</p>`;
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
}
