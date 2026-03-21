/**
 * DeepLore Enhanced — Entry Point
 * Wires up the generation interceptor, event listeners, and UI initialization.
 */
import {
    setExtensionPrompt,
    extension_prompts,
    saveSettingsDebounced,
    saveChatDebounced,
    chat,
    chat_metadata,
} from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { promptManager } from '../../../openai.js';
import { formatAndGroup } from './core/matching.js';
import {
    buildExemptionPolicy, applyPinBlock, applyContextualGating,
    applyReinjectionCooldown, applyRequiresExcludesGating,
    applyStripDedup, trackGeneration, decrementTrackers, recordAnalytics,
} from './src/stages.js';
import { clearPrompts } from './core/pipeline.js';
import { getSettings, PROMPT_TAG_PREFIX, PROMPT_TAG, invalidateSettingsCache } from './settings.js';
import {
    vaultIndex, indexEverLoaded, indexing,
    lastInjectionSources, lastScribeChatLength, scribeInProgress,
    cooldownTracker, generationCount, injectionHistory,
    lastWarningRatio, decayTracker, chatEpoch,
    generationLock, generationLockTimestamp, generationLockEpoch, setGenerationLock,
    setLastInjectionSources, setLastScribeChatLength, setLastScribeSummary,
    setGenerationCount, setLastWarningRatio, setChatEpoch,
    setAiSearchCache, setAutoSuggestMessageCount, setLastPipelineTrace,
    setScribeInProgress,
} from './src/state.js';
import { buildIndex, ensureIndexFresh, hydrateFromCache, buildIndexDelta } from './src/vault.js';
import { runPipeline } from './src/pipeline.js';
import { setupSyncPolling } from './src/sync.js';
import { runScribe } from './src/scribe.js';
import { injectSourcesButton, showSourcesPopup, resetCartographer } from './src/cartographer.js';
import { loadSettingsUI, bindSettingsEvents } from './src/settings-ui.js';
import { registerSlashCommands } from './src/commands.js';

// ============================================================================
// Generation Interceptor
// ============================================================================

/**
 * Called by SillyTavern's generation interceptor system.
 * @param {object[]} chat - Array of chat messages
 * @param {number} contextSize - Context size
 * @param {function} abort - Abort callback
 * @param {string} type - Generation type
 */
async function onGenerate(chat, contextSize, abort, type) {
    const settings = getSettings();

    if (type === 'quiet' || !settings.enabled) {
        return;
    }

    // Prevent concurrent onGenerate runs — warn the user instead of silently dropping lore
    if (generationLock) {
        // Auto-recover stale locks after 60 seconds
        const lockAge = Date.now() - generationLockTimestamp;
        if (lockAge > 60_000) {
            console.warn(`[DLE] Generation lock stale (${Math.round(lockAge / 1000)}s) — force-releasing`);
            setGenerationLock(false);
        } else {
            console.warn('[DLE] Generation lock active — another pipeline is still running. Lore skipped for this generation.');
            toastr.warning('Previous lore retrieval still in progress — this generation may lack lore context. If stuck, run /dle-refresh.', 'DeepLore Enhanced', { timeOut: 5000, preventDuplicates: true });
            return;
        }
    }
    setGenerationLock(true);

    // Capture chat epoch to detect stale writes if CHAT_CHANGED fires mid-generation
    const epoch = chatEpoch;
    // Capture lock epoch to detect if this pipeline has been superseded by a force-released lock
    const lockEpoch = generationLockEpoch;

    // Track whether the pipeline ran far enough to need generation tracking
    let pipelineRan = false;
    let injectedEntries = [];

    try {
        // Clear stale source data (after quiet check so Scribe doesn't wipe real sources)
        setLastInjectionSources(null);

        // Clear all previous DeepLore prompts
        clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);

        // In prompt_list mode, also clear PM entry content from previous generation
        if (settings.injectionMode === 'prompt_list' && promptManager) {
            for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook']) {
                const pmEntry = promptManager.getPromptById(id);
                if (pmEntry) pmEntry.content = '';
            }
        }
        // Ensure index is fresh (with timeout to prevent indefinite hangs)
        const INDEX_TIMEOUT_MS = 60_000;
        try {
            await Promise.race([
                ensureIndexFresh(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Index refresh timed out')), INDEX_TIMEOUT_MS)),
            ]);
        } catch (timeoutErr) {
            console.warn(`[DLE] ${timeoutErr.message} — proceeding with stale data`);
            if (vaultIndex.length === 0) {
                toastr.warning('Obsidian connection timed out and no cached data available. Check that Obsidian is running with the REST API plugin.', 'DeepLore Enhanced', { timeOut: 8000, preventDuplicates: true });
                return;
            }
        }

        // Snapshot vaultIndex at pipeline start to avoid races with background rebuilds
        const vaultSnapshot = [...vaultIndex];

        if (vaultSnapshot.length === 0) {
            if (!indexEverLoaded) {
                toastr.warning(
                    'No vault entries loaded. Possible causes: (1) No notes tagged with your lorebook tag, (2) Obsidian connection failed, (3) Wrong tag name in settings. Run /dle-health for diagnostics.',
                    'DeepLore Enhanced', { timeOut: 10000, preventDuplicates: true },
                );
            }
            if (settings.debugMode) {
                console.debug('[DLE] No entries indexed, skipping');
            }
            return;
        }

        // From here on, generation tracking must run even if no entries match
        pipelineRan = true;

        const { finalEntries: pipelineEntries, matchedKeys, trace } = await runPipeline(chat, vaultSnapshot);

        // Build ExemptionPolicy: single source of truth for what skips all gating
        const pins = chat_metadata.deeplore_pins || [];
        const blocks = chat_metadata.deeplore_blocks || [];
        const policy = buildExemptionPolicy(vaultSnapshot, pins, blocks);

        // Stage 1: Pin/Block overrides
        let finalEntries = applyPinBlock(pipelineEntries, vaultSnapshot, policy, matchedKeys);

        // Stage 2: Contextual gating (era, location, scene, character)
        const ctx = chat_metadata.deeplore_context || {};
        finalEntries = applyContextualGating(finalEntries, ctx, policy, settings.debugMode);

        if (trace?.aiFallback) {
            const aiErr = trace.aiError || '';
            let fallbackMsg = 'AI search failed';
            if (/timeout|timed out|abort/i.test(aiErr)) fallbackMsg += ' (timed out — try increasing AI Search timeout)';
            else if (/401|403|auth/i.test(aiErr)) fallbackMsg += ' (auth error — check API key or profile)';
            else if (/not found|no.*profile/i.test(aiErr)) fallbackMsg += ' (connection profile not found — check AI Search settings)';
            else if (/ECONNREFUSED|Failed to fetch|NetworkError|fetch|network/i.test(aiErr)) fallbackMsg += ' (network error — check proxy URL or profile)';
            else if (/5\d\d|502|503|server/i.test(aiErr)) fallbackMsg += ' (server error — try again later)';
            else if (aiErr) fallbackMsg += ` (${aiErr.slice(0, 80)})`;
            console.warn('[DLE] AI search error:', aiErr);
            toastr.warning(`${fallbackMsg} — using keyword fallback`, 'DeepLore Enhanced', { timeOut: 6000, preventDuplicates: true });
        }

        if (settings.debugMode && trace) {
            console.log(`[DLE] Pipeline (${trace.mode}): ${trace.keywordMatched.length} keyword matches, ${trace.aiSelected.length} AI selected` + (trace.aiFallback ? ' (AI FALLBACK)' : ''));
        }

        if (finalEntries.length === 0) {
            if (settings.debugMode) {
                console.debug('[DLE] No entries matched');
            }
            return;
        }

        // Stage 3: Re-injection cooldown
        finalEntries = applyReinjectionCooldown(finalEntries, policy, injectionHistory, generationCount, settings.reinjectionCooldown, settings.debugMode);

        if (finalEntries.length === 0) {
            if (settings.debugMode) console.debug('[DLE] All entries removed by re-injection cooldown');
            return;
        }

        // Stage 4: Requires/excludes gating (forceInject entries exempt)
        const { result: gated, removed: gatingRemoved } = applyRequiresExcludesGating(finalEntries, policy, settings.debugMode);

        if (gated.length === 0) {
            if (settings.debugMode) console.debug('[DLE] All entries removed by gating rules');
            return;
        }

        // Stage 5: Strip duplicate injections
        let postDedup = gated;
        if (settings.stripDuplicateInjections) {
            postDedup = applyStripDedup(gated, policy, chat_metadata.deeplore_injection_log, settings.stripLookbackDepth, settings, settings.debugMode);
        }

        // Stage 6: Format with budget, grouped by injection position
        const { groups, count: injectedCount, totalTokens, acceptedEntries } = formatAndGroup(postDedup, getSettings(), PROMPT_TAG_PREFIX);

        injectedEntries = acceptedEntries;

        // Enrich pipeline trace with post-pipeline info
        if (trace) {
            trace.gatedOut = gatingRemoved.map(e => ({
                title: e.title, requires: e.requires, excludes: e.excludes,
            }));
            const acceptedTitles = new Set(acceptedEntries.map(e => e.title));
            trace.budgetCut = postDedup.filter(e => !acceptedTitles.has(e.title))
                .map(e => ({ title: e.title, tokens: e.tokenEstimate, priority: e.priority }));
            trace.injected = acceptedEntries.map(e => ({
                title: e.title,
                tokens: e.tokenEstimate,
                truncated: !!e._truncated,
                originalTokens: e._originalTokens || e.tokenEstimate,
            }));
            trace.totalTokens = totalTokens;
            trace.budgetLimit = settings.maxTokensBudget;
            setLastPipelineTrace(trace);
        }

        if (groups.length > 0) {
            // Bail if this pipeline was superseded by a force-released stale lock
            if (lockEpoch !== generationLockEpoch) {
                console.warn('[DLE] Pipeline superseded by newer generation (lock epoch mismatch) — discarding results');
                return;
            }
            const usePromptList = settings.injectionMode === 'prompt_list';
            for (const group of groups) {
                if (usePromptList && promptManager) {
                    // Prompt List mode: write content directly to the PM entry.
                    // The PM collection order (user's drag position) controls placement.
                    const pmEntry = promptManager.getPromptById(group.tag);
                    if (pmEntry) {
                        pmEntry.content = group.text;
                        // Don't call setExtensionPrompt — it would override PM positioning
                        continue;
                    }
                    // Fallback: PM entry not found, use setExtensionPrompt
                }
                setExtensionPrompt(
                    group.tag,
                    group.text,
                    group.position,
                    group.depth,
                    settings.allowWIScan,
                    group.role,
                );
            }

            // Capture injection sources for Context Cartographer
            setLastInjectionSources(injectedEntries.map(e => ({
                title: e.title,
                filename: e.filename,
                matchedBy: matchedKeys.get(e.title) || '?',
                priority: e.priority,
                tokens: e.tokenEstimate,
                vaultSource: e.vaultSource || '',
            })));
        }

        // Author's Notebook injection (independent of entry pipeline)
        if (settings.notebookEnabled && chat_metadata?.deeplore_notebook?.trim()) {
            const notebookContent = chat_metadata.deeplore_notebook.trim();
            const usePromptList = settings.injectionMode === 'prompt_list';
            if (usePromptList && promptManager) {
                const pmEntry = promptManager.getPromptById('deeplore_notebook');
                if (pmEntry) {
                    pmEntry.content = notebookContent;
                } else {
                    // Fallback: PM entry not found
                    setExtensionPrompt('deeplore_notebook', notebookContent, settings.notebookPosition, settings.notebookDepth, false, settings.notebookRole);
                }
            } else {
                setExtensionPrompt('deeplore_notebook', notebookContent, settings.notebookPosition, settings.notebookDepth, false, settings.notebookRole);
            }
        }

        // Stage 7: Track cooldowns and injection history (epoch-guarded)
        if (epoch === chatEpoch) {
            trackGeneration(injectedEntries, generationCount, cooldownTracker, decayTracker, injectionHistory, settings);
        }

        // Record injection for deduplication (epoch-guarded to avoid writing to wrong chat)
        if (settings.stripDuplicateInjections && epoch === chatEpoch) {
            if (!chat_metadata.deeplore_injection_log) {
                chat_metadata.deeplore_injection_log = [];
            }
            chat_metadata.deeplore_injection_log.push({
                gen: generationCount + 1,
                entries: injectedEntries.map(e => ({
                    title: e.title,
                    pos: e.injectionPosition ?? settings.injectionPosition,
                    depth: e.injectionDepth ?? settings.injectionDepth,
                    role: e.injectionRole ?? settings.injectionRole,
                    contentHash: e._contentHash || '',
                })),
            });
            const maxHistory = settings.stripLookbackDepth + 1;
            if (chat_metadata.deeplore_injection_log.length > maxHistory) {
                chat_metadata.deeplore_injection_log = chat_metadata.deeplore_injection_log.slice(-maxHistory);
            }
            saveChatDebounced();
        }

        // Stage 8: Analytics
        if (finalEntries.length > 0) {
            recordAnalytics(finalEntries, injectedEntries, settings.analyticsData);
            invalidateSettingsCache();
            saveSettingsDebounced();
        }

        if (groups.length > 0) {
            // Context usage warning — BUG 6 FIX: reset ratio when it drops below threshold
            if (contextSize > 0) {
                const ratio = totalTokens / contextSize;
                if (ratio > 0.20 && ratio > lastWarningRatio + 0.05) {
                    const pct = Math.round(ratio * 100);
                    toastr.warning(
                        `${injectedCount} entries injected (~${totalTokens} tokens, ${pct}% of context). Consider setting a token budget.`,
                        'DeepLore Enhanced',
                        { preventDuplicates: true, timeOut: 8000 },
                    );
                    setLastWarningRatio(ratio);
                } else if (ratio <= 0.15) {
                    // Reset when ratio drops well below threshold to allow re-warning if it climbs again
                    setLastWarningRatio(0);
                }
            }

            if (settings.debugMode) {
                console.log(`[DLE] ${finalEntries.length} selected, ${postDedup.length} after gating+dedup, ${injectedCount} injected (~${totalTokens} tokens) in ${groups.length} group(s)` +
                    (contextSize > 0 ? ` (${Math.round(totalTokens / contextSize * 100)}% of ${contextSize} context)` : ''));
                console.table(injectedEntries.map(e => ({
                    title: e.title,
                    matchedBy: matchedKeys.get(e.title) || '?',
                    priority: e.priority,
                    tokens: e.tokenEstimate,
                    constant: e.constant,
                })));
                if (groups.length > 1) {
                    console.log('[DLE] Injection groups:', groups.map(g =>
                        `${g.tag}: pos=${g.position} depth=${g.depth} role=${g.role}`));
                }
            }
        }

    } catch (err) {
        console.error('[DLE] Error during generation:', err);
        toastr.error('Lore injection failed — check console for details.', 'DeepLore Enhanced', { timeOut: 8000, preventDuplicates: true });
    } finally {
        // Generation tracking must always run when the pipeline was entered,
        // even if no entries matched — otherwise cooldown timers freeze permanently.
        // Wrapped in try/catch to prevent tracking errors from blocking ST generation.
        try {
            if (pipelineRan && epoch === chatEpoch && lockEpoch === generationLockEpoch) {
                setGenerationCount(generationCount + 1);
                decrementTrackers(cooldownTracker, decayTracker, injectedEntries, settings);
            }
        } catch (trackingErr) {
            console.error('[DLE] Error in generation tracking:', trackingErr);
        }
        // Only release lock if this pipeline still owns it (epoch matches).
        // A force-released stale pipeline must NOT release the newer pipeline's lock.
        if (lockEpoch === generationLockEpoch) {
            setGenerationLock(false);
        }
    }
}

// Register the interceptor on globalThis so SillyTavern can find it
globalThis.deepLoreEnhanced_onGenerate = onGenerate;

// External API: match vault entries against arbitrary text
// (imported from pipeline.js, re-exported on globalThis)
import { matchTextForExternal } from './src/pipeline.js';
globalThis.deepLoreEnhanced_matchText = matchTextForExternal;

// ============================================================================
// Initialization
// ============================================================================

jQuery(async function () {
    try {
        const settingsHtml = await renderExtensionTemplateAsync(
            'third-party/sillytavern-DeepLore-Enhanced',
            'settings',
        );
        $('#extensions_settings2').append(settingsHtml);

        loadSettingsUI();
        bindSettingsEvents(buildIndex);
        registerSlashCommands();
        setupSyncPolling(buildIndex, buildIndexDelta);

        // Register PM prompts on init so they appear in the Prompt Manager immediately.
        // Content is written directly to PM entries at generation time (not via setExtensionPrompt),
        // so the PM collection order (user's drag position) controls placement.
        const initSettings = getSettings();
        if (initSettings.injectionMode === 'prompt_list') {
            // Register directly in PM (so entries appear in the list without generating first).
            // promptManager may not be initialized yet, so poll briefly.
            const registerPmEntries = () => {
                if (!promptManager) return false;
                const ids = [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook'];
                for (const id of ids) {
                    const existing = promptManager.getPromptById(id);
                    if (!existing) {
                        promptManager.addPrompt({
                            name: id,
                            content: '',
                            system_prompt: true,
                            role: 'system',
                            position: 'end',
                            marker: false,
                            enabled: true,
                            extension: true,
                        }, id);
                    } else {
                        // Patch legacy entries missing role or position
                        if (!existing.role) existing.role = 'system';
                        if (!existing.position) existing.position = 'end';
                        if (!existing.extension) existing.extension = true;
                    }
                    // Add to active character's prompt order if not already there
                    if (promptManager.activeCharacter) {
                        const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
                        if (!order.find(e => e.identifier === id)) {
                            order.push({ identifier: id, enabled: true });
                        }
                    }
                }
                promptManager.render(false);
                return true;
            };
            if (!registerPmEntries()) {
                // PM not ready yet — retry after a short delay
                const interval = setInterval(() => {
                    if (registerPmEntries()) clearInterval(interval);
                }, 500);
                // Stop trying after 10s
                setTimeout(() => clearInterval(interval), 10000);
            }
        }
        if (initSettings.enabled) {
            // Try instant hydration from IndexedDB, then validate against Obsidian in background
            setTimeout(async () => {
                // Skip if a build was already triggered (e.g. by early user generation)
                if (indexEverLoaded || indexing) return;
                try {
                    const hydrated = await hydrateFromCache();
                    if (!hydrated) {
                        // No cache — do a full build
                        await buildIndex();
                    }
                    // If hydrated, hydrateFromCache already triggers a background buildIndex
                } catch (err) {
                    console.warn('[DLE] Auto-connect:', err.message);
                }
            }, 3000);
        }

        // Context Cartographer: click handler (event delegation — registered once)
        $('#chat').on('click', '.mes_deeplore_sources', function () {
            const messageId = $(this).closest('.mes').attr('mesid');
            const message = chat[messageId];
            const sources = message?.extra?.deeplore_sources;
            if (!sources || sources.length === 0) return;
            showSourcesPopup(sources);
        });

        // Context Cartographer + Session Scribe: post-render handler
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
            const settings = getSettings();

            // --- Context Cartographer: store sources and inject button ---
            if (settings.showLoreSources && lastInjectionSources && lastInjectionSources.length > 0) {
                const message = chat[messageId];
                if (message && !message.is_user) {
                    message.extra = message.extra || {};
                    message.extra.deeplore_sources = lastInjectionSources;
                    setLastInjectionSources(null);
                    saveChatDebounced();
                }
            }

            if (settings.showLoreSources) {
                injectSourcesButton(messageId);
            }

            // --- Session Scribe: track chat position and auto-trigger ---
            if (settings.enabled && settings.scribeEnabled && settings.scribeInterval > 0) {
                const newMessages = chat.length - lastScribeChatLength;
                if (newMessages >= settings.scribeInterval && !scribeInProgress) {
                    runScribe(); // fire-and-forget
                }
            }
        });

        // Context Cartographer: re-inject buttons on chat load
        eventSource.on(event_types.CHAT_CHANGED, () => {
            // Increment epoch first so any in-flight onGenerate sees the mismatch
            setChatEpoch(chatEpoch + 1);

            setLastScribeChatLength(chat ? chat.length : 0);
            setLastScribeSummary(chat_metadata?.deeplore_lastScribeSummary || '');
            setScribeInProgress(false); // Reset scribe lock so auto-scribe works in new chat
            // Reset per-chat tracking on chat change
            // Note: aiSearchStats is intentionally NOT reset — it tracks session-level cumulative stats
            injectionHistory.clear();
            cooldownTracker.clear();
            decayTracker.clear();
            setGenerationCount(0);
            setLastWarningRatio(0);
            setAiSearchCache({ hash: '', manifestHash: '', chatLineCount: 0, results: [] });
            setAutoSuggestMessageCount(0);
            setLastPipelineTrace(null);
            setLastInjectionSources(null);
            resetCartographer();

            // Re-register PM entries for the new active character (prompt_list mode)
            if (getSettings().injectionMode === 'prompt_list' && promptManager?.activeCharacter) {
                const ids = [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook'];
                for (const id of ids) {
                    const existing = promptManager.getPromptById(id);
                    if (!existing) {
                        promptManager.addPrompt({
                            name: id, content: '', system_prompt: true,
                            role: 'system', position: 'end', marker: false, enabled: true, extension: true,
                        }, id);
                    } else {
                        if (!existing.role) existing.role = 'system';
                        if (!existing.position) existing.position = 'end';
                        if (!existing.extension) existing.extension = true;
                    }
                    const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
                    if (order && !order.find(e => e.identifier === id)) {
                        order.push({ identifier: id, enabled: true });
                    }
                }
            }

            // Retry with backoff to handle slow DOM rendering on large chats
            const injectAllSourceButtons = (attempt = 0) => {
                const settings = getSettings();
                if (!settings.showLoreSources) return;
                const chatEl = document.getElementById('chat');
                if (!chatEl?.children.length && attempt < 5) {
                    setTimeout(() => injectAllSourceButtons(attempt + 1), 200 * (attempt + 1));
                    return;
                }
                for (let i = 0; i < chat.length; i++) {
                    if (chat[i]?.extra?.deeplore_sources) {
                        injectSourcesButton(i);
                    }
                }
            };
            setTimeout(injectAllSourceButtons, 100);
        });

        console.log('[DLE] DeepLore Enhanced client extension initialized');
    } catch (err) {
        console.error('[DLE] Failed to initialize:', err);
    }
});
