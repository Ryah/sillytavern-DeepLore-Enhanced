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
import { applyGating, formatAndGroup } from './core/matching.js';
import { clearPrompts } from './core/pipeline.js';
import { getSettings, PROMPT_TAG_PREFIX, PROMPT_TAG } from './settings.js';
import {
    vaultIndex, indexEverLoaded,
    lastInjectionSources, lastScribeChatLength, scribeInProgress,
    cooldownTracker, generationCount, injectionHistory,
    lastWarningRatio, decayTracker,
    setLastInjectionSources, setLastScribeChatLength, setLastScribeSummary,
    setGenerationCount, setLastWarningRatio,
} from './src/state.js';
import { buildIndex, ensureIndexFresh, hydrateFromCache, buildIndexDelta } from './src/vault.js';
import { runPipeline } from './src/pipeline.js';
import { setupSyncPolling } from './src/sync.js';
import { runScribe } from './src/scribe.js';
import { injectSourcesButton, showSourcesPopup } from './src/cartographer.js';
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

    // Clear stale source data (after quiet check so Scribe doesn't wipe real sources)
    setLastInjectionSources(null);

    // Clear all previous DeepLore prompts
    clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);

    // In prompt_list mode, also clear PM entry content from previous generation
    if (settings.injectionMode === 'prompt_list' && promptManager) {
        for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`]) {
            const pmEntry = promptManager.getPromptById(id);
            if (pmEntry) pmEntry.content = '';
        }
    }

    // Track whether the pipeline ran far enough to need generation tracking
    let pipelineRan = false;
    let injectedEntries = [];

    try {
        // Ensure index is fresh
        await ensureIndexFresh();

        if (vaultIndex.length === 0) {
            if (!indexEverLoaded) {
                toastr.warning('No vault entries loaded. Check Obsidian connection.', 'DeepLore Enhanced', { timeOut: 8000, preventDuplicates: true });
            }
            if (settings.debugMode) {
                console.debug('[DLE] No entries indexed, skipping');
            }
            return;
        }

        // From here on, generation tracking must run even if no entries match
        pipelineRan = true;

        const { finalEntries: pipelineEntries, matchedKeys, trace } = await runPipeline(chat);
        let finalEntries = pipelineEntries;

        // Per-chat pin/block overrides (stored in chat_metadata)
        const pins = chat_metadata.deeplore_pins || [];
        const blocks = chat_metadata.deeplore_blocks || [];
        if (pins.length > 0) {
            const pinSet = new Set(pins.map(t => t.toLowerCase()));
            for (const entry of vaultIndex) {
                if (pinSet.has(entry.title.toLowerCase()) && !finalEntries.includes(entry)) {
                    finalEntries.push(entry);
                    matchedKeys.set(entry.title, '(pinned)');
                }
            }
        }
        if (blocks.length > 0) {
            const blockSet = new Set(blocks.map(t => t.toLowerCase()));
            finalEntries = finalEntries.filter(e => !blockSet.has(e.title.toLowerCase()));
        }

        // Contextual gating: era, location, scene_type, character_present
        const ctx = chat_metadata.deeplore_context || {};
        const activeEra = (ctx.era || '').toLowerCase();
        const activeLocation = (ctx.location || '').toLowerCase();
        const activeScene = (ctx.scene_type || '').toLowerCase();
        const presentChars = (ctx.characters_present || []).map(c => c.toLowerCase());

        if (activeEra || activeLocation || activeScene || presentChars.length > 0) {
            const beforeCtx = finalEntries.length;
            finalEntries = finalEntries.filter(e => {
                if (e.constant) return true; // Constants bypass gating
                // Era gating: if entry has era field, current era must match one
                if (e.era && e.era.length > 0 && activeEra) {
                    if (!e.era.includes(activeEra)) return false;
                } else if (e.era && e.era.length > 0 && !activeEra) {
                    return false; // Entry requires an era but none is set
                }
                // Location gating
                if (e.location && e.location.length > 0 && activeLocation) {
                    if (!e.location.includes(activeLocation)) return false;
                } else if (e.location && e.location.length > 0 && !activeLocation) {
                    return false;
                }
                // Scene type gating
                if (e.sceneType && e.sceneType.length > 0 && activeScene) {
                    if (!e.sceneType.includes(activeScene)) return false;
                } else if (e.sceneType && e.sceneType.length > 0 && !activeScene) {
                    return false;
                }
                // Character present gating
                if (e.characterPresent && e.characterPresent.length > 0) {
                    if (presentChars.length === 0) return false;
                    if (!e.characterPresent.some(c => presentChars.includes(c))) return false;
                }
                return true;
            });
            if (settings.debugMode && finalEntries.length < beforeCtx) {
                console.log(`[DLE] Contextual gating removed ${beforeCtx - finalEntries.length} entries (era: ${activeEra || 'none'}, location: ${activeLocation || 'none'}, scene: ${activeScene || 'none'})`);
            }
        }

        if (trace?.aiFallback) {
            console.warn('[DLE] AI search failed, using fallback results');
            toastr.warning('AI search unavailable — using keyword fallback', 'DeepLore Enhanced', { timeOut: 5000, preventDuplicates: true });
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

        // Re-injection cooldown: filter out recently injected entries
        if (settings.reinjectionCooldown > 0) {
            const before = finalEntries.length;
            finalEntries = finalEntries.filter(e => {
                if (e.constant) return true; // Constants always pass
                const lastGen = injectionHistory.get(e.title);
                if (lastGen !== undefined && (generationCount - lastGen) < settings.reinjectionCooldown) {
                    if (settings.debugMode) {
                        console.debug(`[DLE] Re-injection cooldown: "${e.title}" was injected ${generationCount - lastGen} gens ago (cooldown: ${settings.reinjectionCooldown}) — skipping`);
                    }
                    return false;
                }
                return true;
            });
            if (settings.debugMode && finalEntries.length < before) {
                console.log(`[DLE] Re-injection cooldown removed ${before - finalEntries.length} entries`);
            }
        }

        if (finalEntries.length === 0) {
            if (settings.debugMode) {
                console.debug('[DLE] All entries removed by re-injection cooldown');
            }
            return;
        }

        // Apply conditional gating (requires/excludes)
        let gated = applyGating(finalEntries);

        if (settings.debugMode && gated.length < finalEntries.length) {
            const removed = finalEntries.filter(e => !gated.includes(e));
            console.log(`[DLE] Gating removed ${removed.length} entries:`,
                removed.map(e => ({ title: e.title, requires: e.requires, excludes: e.excludes })));
        }

        if (gated.length === 0) {
            if (settings.debugMode) {
                console.debug('[DLE] All entries removed by gating rules');
            }
            return;
        }

        // Strip duplicate injections from recent generations
        if (settings.stripDuplicateInjections && chat_metadata.deeplore_injection_log?.length > 0) {
            const recentEntries = new Set();
            const lookback = settings.stripLookbackDepth;
            const log = chat_metadata.deeplore_injection_log;
            const recentLogs = log.slice(-lookback);
            for (const logEntry of recentLogs.flatMap(l => l.entries)) {
                recentEntries.add(`${logEntry.title}|${logEntry.pos}|${logEntry.depth}|${logEntry.role}`);
            }

            const before = gated.length;
            gated = gated.filter(e => {
                if (e.constant) return true; // Constants always inject
                const key = `${e.title}|${e.injectionPosition ?? settings.injectionPosition}|${e.injectionDepth ?? settings.injectionDepth}|${e.injectionRole ?? settings.injectionRole}`;
                if (recentEntries.has(key)) {
                    if (settings.debugMode) {
                        console.debug(`[DLE] Strip: "${e.title}" already injected in recent ${lookback} gen(s) — skipping`);
                    }
                    return false;
                }
                return true;
            });
            if (settings.debugMode && gated.length < before) {
                console.log(`[DLE] Strip dedup removed ${before - gated.length} entries`);
            }
        }

        // Format with budget, grouped by injection position
        const { groups, count: injectedCount, totalTokens } = formatAndGroup(gated, getSettings(), PROMPT_TAG_PREFIX);

        injectedEntries = gated.slice(0, injectedCount);

        if (groups.length > 0) {
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

        // AI Notebook injection (independent of entry pipeline)
        if (settings.notebookEnabled && chat_metadata?.deeplore_notebook?.trim()) {
            setExtensionPrompt(
                'deeplore_notebook',
                chat_metadata.deeplore_notebook.trim(),
                settings.notebookPosition,
                settings.notebookDepth,
                false, // no WI scan
                settings.notebookRole,
            );
        }

        // Set cooldown for injected entries that have a cooldown value
        for (const entry of injectedEntries) {
            if (entry.cooldown !== null && entry.cooldown > 0) {
                cooldownTracker.set(entry.title, entry.cooldown);
            }
        }

        // Record injection history for re-injection cooldown
        // Uses generationCount + 1 because the increment happens in finally
        for (const entry of injectedEntries) {
            injectionHistory.set(entry.title, generationCount + 1);
        }

        // Record injection for deduplication
        if (settings.stripDuplicateInjections) {
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
                })),
            });
            const maxHistory = settings.stripLookbackDepth + 1;
            if (chat_metadata.deeplore_injection_log.length > maxHistory) {
                chat_metadata.deeplore_injection_log = chat_metadata.deeplore_injection_log.slice(-maxHistory);
            }
            saveChatDebounced();
        }

        // Update analytics data
        if (finalEntries.length > 0) {
            const analytics = settings.analyticsData;
            for (const entry of finalEntries) {
                if (!analytics[entry.title]) {
                    analytics[entry.title] = { matched: 0, injected: 0, lastTriggered: 0 };
                }
                analytics[entry.title].matched++;
                analytics[entry.title].lastTriggered = Date.now();
            }
            for (const entry of injectedEntries) {
                if (!analytics[entry.title]) {
                    analytics[entry.title] = { matched: 0, injected: 0, lastTriggered: 0 };
                }
                analytics[entry.title].injected++;
            }
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
                console.log(`[DLE] ${finalEntries.length} selected, ${gated.length} after gating, ${injectedCount} injected (~${totalTokens} tokens) in ${groups.length} group(s)` +
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
    } finally {
        // Generation tracking must always run when the pipeline was entered,
        // even if no entries matched — otherwise cooldown timers freeze permanently
        if (pipelineRan) {
            setGenerationCount(generationCount + 1);

            // Decrement cooldown counters; remove expired ones
            for (const [title, remaining] of cooldownTracker) {
                if (remaining <= 1) {
                    cooldownTracker.delete(title);
                } else {
                    cooldownTracker.set(title, remaining - 1);
                }
            }

            // Entry decay/freshness tracking
            if (settings.decayEnabled) {
                const injectedTitles = new Set(injectedEntries.map(e => e.title));
                for (const entry of vaultIndex) {
                    if (injectedTitles.has(entry.title)) {
                        decayTracker.set(entry.title, 0); // Reset staleness on injection
                    } else {
                        decayTracker.set(entry.title, (decayTracker.get(entry.title) || 0) + 1);
                    }
                }
            }
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
                const ids = [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`];
                for (const id of ids) {
                    if (!promptManager.getPromptById(id)) {
                        promptManager.addPrompt({
                            name: id,
                            content: '',
                            system_prompt: true,
                            marker: false,
                            enabled: true,
                            extension: true,
                        }, id);
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
        $(document).on('click', '.mes_deeplore_sources', function () {
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
            setLastScribeChatLength(chat ? chat.length : 0);
            setLastScribeSummary(chat_metadata?.deeplore_lastScribeSummary || '');
            // Reset per-chat tracking on chat change
            // Note: aiSearchStats is intentionally NOT reset — it tracks session-level cumulative stats
            injectionHistory.clear();
            cooldownTracker.clear();
            decayTracker.clear();
            setGenerationCount(0);
            setLastWarningRatio(0);
            setTimeout(() => {
                const settings = getSettings();
                if (!settings.showLoreSources) return;
                for (let i = 0; i < chat.length; i++) {
                    if (chat[i]?.extra?.deeplore_sources) {
                        injectSourcesButton(i);
                    }
                }
            }, 100);
        });

        console.log('[DLE] DeepLore Enhanced client extension initialized');
    } catch (err) {
        console.error('[DLE] Failed to initialize:', err);
    }
});
