/**
 * DeepLore Enhanced — Entry Point
 * Wires up the generation interceptor, event listeners, and UI initialization.
 */
// MUST be the first import — installs console/fetch/XHR/error interceptors
// at module-eval time so we capture cold-start bugs in DLE and other extensions.
import './src/diagnostics/boot.js';
import {
    setExtensionPrompt,
    extension_prompts,
    saveSettingsDebounced,
    chat,
    chat_metadata,
    messageFormatting,
    saveMetadata,
} from '../../../../script.js';
import { renderExtensionTemplateAsync, saveMetadataDebounced } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { promptManager } from '../../../openai.js';
import { formatAndGroup } from './core/matching.js';
import { classifyError } from './core/utils.js';
import {
    buildExemptionPolicy, applyPinBlock, applyContextualGating,
    applyReinjectionCooldown, applyRequiresExcludesGating,
    applyStripDedup, trackGeneration, decrementTrackers, recordAnalytics,
} from './src/stages.js';
import { clearPrompts } from './core/pipeline.js';
import { getSettings, PROMPT_TAG_PREFIX, PROMPT_TAG, invalidateSettingsCache, resolveConnectionConfig } from './settings.js';
import {
    vaultIndex, getWriterVisibleEntries, indexEverLoaded, indexing,
    lastInjectionSources, lastInjectionEpoch, lastScribeChatLength, scribeInProgress,
    cooldownTracker, generationCount, injectionHistory, consecutiveInjections,
    chatInjectionCounts, setChatInjectionCounts, trackerKey,
    lastWarningRatio, decayTracker, chatEpoch,
    perSwipeInjectedKeys, setPerSwipeInjectedKeys,
    lastGenerationTrackerSnapshot, setLastGenerationTrackerSnapshot,
    setCooldownTracker, setDecayTracker, setConsecutiveInjections, setInjectionHistory,
    generationLock, generationLockTimestamp, generationLockEpoch, setGenerationLock, setGenerationLockEpoch,
    setLastInjectionSources, setLastInjectionEpoch, setLastScribeChatLength, setLastScribeSummary,
    setGenerationCount, setLastWarningRatio, setChatEpoch, setLastIndexGenerationCount,
    setAiSearchCache, setAutoSuggestMessageCount, autoSuggestMessageCount, setLastPipelineTrace,
    setScribeInProgress, setPreviousSources,
    notepadExtractInProgress, setNotepadExtractInProgress,
    notifyPipelineComplete, notifyGatingChanged,
    fieldDefinitions,
    folderList,
    setLoreGaps, setLoreGapSearchCount, setLibrarianChatStats,
    librarianToolsRegistered,
} from './src/state.js';
import { DEFAULT_FIELD_DEFINITIONS } from './src/fields.js';
import { buildIndex, ensureIndexFresh, hydrateFromCache, buildIndexWithReuse } from './src/vault/vault.js';
import { resetAiThrottle, callAI } from './src/ai/ai.js';
import { runPipeline } from './src/pipeline/pipeline.js';
import { setupSyncPolling } from './src/vault/sync.js';
import { runScribe } from './src/ai/scribe.js';
import { runAutoSuggest, showSuggestionPopup } from './src/ai/auto-suggest.js';
import { injectSourcesButton, showSourcesPopup, resetCartographer } from './src/ui/cartographer.js';
import { loadSettingsUI, bindSettingsEvents } from './src/ui/settings-ui.js';
import { registerSlashCommands } from './src/ui/commands.js';
import { dedupError, dedupWarning } from './src/toast-dedup.js';
import { createDrawerPanel, resetDrawerState, destroyDrawerPanel } from './src/drawer/drawer.js';
import { pushActivity } from './src/drawer/drawer-state.js';
import { extractAiNotes, normalizeLoreGap } from './src/helpers.js';
import { clearSessionActivityLog, consumePendingToolCalls, clearPendingToolCalls } from './src/librarian/librarian-tools.js';
import { injectLibrarianDropdown, removeLibrarianDropdown } from './src/librarian/librarian-ui.js';
import { registerLibrarianTools, ensureFunctionCallingEnabled } from './src/librarian/librarian.js';
import { clearSessionState as clearLibrarianSessionState } from './src/librarian/librarian-session.js';

// ============================================================================
// BUG-063: Lifecycle / teardown infrastructure
// ----------------------------------------------------------------------------
// Tracks every eventSource listener registered during init so they can be
// removed on extension teardown (beforeunload, or re-init if the module ever
// gets re-evaluated). Prevents duplicate handlers on reload and leaked
// closures on page unload. _registerEs is a thin wrapper: push + subscribe.
// _teardownDleExtension removes every tracked listener and tears down the
// drawer. _dleInitialized is the re-init guard — if init somehow runs twice,
// we tear down first before re-registering.
// ============================================================================
const _dleListeners = { eventSource: [] };
let _dleInitialized = false;
let _dleBeforeUnloadHandler = null;

function _registerEs(event, handler, { once = false } = {}) {
    if (!event) return; // feature-detect guard: skip if event type doesn't exist in this ST version
    _dleListeners.eventSource.push({ event, handler, once });
    if (once) eventSource.once(event, handler);
    else eventSource.on(event, handler);
}

function _teardownDleExtension() {
    // Remove every tracked eventSource listener
    for (const { event, handler } of _dleListeners.eventSource) {
        try { eventSource.removeListener?.(event, handler); } catch { /* ignore */ }
    }
    _dleListeners.eventSource = [];
    // Tear down the drawer (removes its own listeners + DOM)
    try { destroyDrawerPanel(); } catch (err) { console.warn('[DLE] destroyDrawerPanel failed:', err?.message); }
    // Remove the beforeunload handler itself so it doesn't accumulate on re-init
    if (_dleBeforeUnloadHandler) {
        try { window.removeEventListener('beforeunload', _dleBeforeUnloadHandler); } catch { /* ignore */ }
        _dleBeforeUnloadHandler = null;
    }
    _dleInitialized = false;
}

/** Default instruction prompt for the AI Notebook feature. */
const DEFAULT_AI_NOTEPAD_PROMPT = `[AI Notebook Instructions]
You have a private notebook. After your roleplay response, you may append a <dle-notes> block. This block is AUTOMATICALLY HIDDEN from the reader — they will never see it. Your notes are saved and returned to you in future messages as "[Your previous session notes]" above.

FORMAT — place this AFTER your entire response, on a new line:
<dle-notes>
- your notes here
</dle-notes>

RULES:
- The <dle-notes> block must be the LAST thing you write, after all roleplay prose
- Do NOT write notes as visible prose (no "Note to self:", "OOC:", or similar in your response)
- Do NOT mention the notebook, notes, or <dle-notes> tags in your roleplay prose

Use this space for anything you want to remember but can't put into the story right now — character motivations, unspoken thoughts, plot threads to revisit, world state, emotional arcs, planned callbacks, or anything else you find relevant.`;

/** Default extraction prompt for AI Notebook extract mode. */
const DEFAULT_AI_NOTEPAD_EXTRACT_PROMPT = `You are a session note-taker for a roleplay. Given the AI's latest response and (optionally) its previous session notes, extract anything worth remembering for future context.

Extract: character decisions, relationship shifts, emotional states, revealed information, plot developments, world state changes, unresolved threads, promises made, lies told, or anything else a writer would want to track.

If the response contains visible "notes to self", "OOC" commentary, or meta-commentary by the AI, extract the useful content from those too.

If there is nothing noteworthy, respond with exactly: NOTHING_TO_NOTE

Otherwise, respond with concise bullet points only — no preamble, no headers, no explanation. Just the notes.`;

/** Regex patterns for visible AI note-taking that should be stripped from the message. */
const VISIBLE_NOTES_PATTERNS = [
    /\[Note to self:[\s\S]*?\]/gi,
    /\[OOC:[\s\S]*?\]/gi,
    /\(OOC:[\s\S]*?\)/gi,
    /\[Author['']?s? note:[\s\S]*?\]/gi,
    /\[Session note:[\s\S]*?\]/gi,
    /\[Meta:[\s\S]*?\]/gi,
];

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

    // Skip full pipeline on tool-call continuations (ST re-calls Generate after each tool invocation).
    // The last chat message will have extra.tool_invocations when this is a tool-call continuation.
    // Lore from the original generation is still in context — re-running the pipeline would waste
    // tokens (especially the AI search sidecar) and produce misleading analytics.
    if (chat.length > 0) {
        const lastMsg = chat[chat.length - 1];
        if (lastMsg?.extra?.tool_invocations || lastMsg?.is_system) {
            if (settings.debugMode) console.debug('[DLE] Skipping pipeline for tool-call continuation');
            return;
        }
    }

    // Strip DLE tool call messages from previous generations so they don't bloat context.
    // Tool results are ephemeral (like lorebook injections) — they served their purpose and
    // should not persist. The continuation check above already returned for current-gen tool calls.
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg?.is_system || !Array.isArray(msg.extra?.tool_invocations)) continue;
        const invocations = msg.extra.tool_invocations;
        const allDle = invocations.every(inv => inv.name?.startsWith('dle_'));
        if (allDle) {
            chat.splice(i, 1);
        } else {
            msg.extra.tool_invocations = invocations.filter(inv => !inv.name?.startsWith('dle_'));
        }
    }

    // Lazy Librarian tool registration — ensures tools are registered even if init() ran
    // before settings were fully loaded (race condition with ST's extension_settings hydration)
    if (settings.librarianEnabled && !librarianToolsRegistered) {
        try { registerLibrarianTools(); } catch { /* logged inside */ }
    }

    // Prevent concurrent onGenerate runs — warn the user instead of silently dropping lore
    if (generationLock) {
        // Auto-recover stale locks after 30 seconds
        const lockAge = Date.now() - generationLockTimestamp;
        if (lockAge > 30_000) {
            console.warn(`[DLE] Previous lore selection took too long (${Math.round(lockAge / 1000)}s) — releasing lock`);
            dedupWarning('Lore from the last message is taking a while — check your AI timeout setting.', 'pipeline_lock_stale', { hint: 'Pipeline lock held past 30s.' });
            // BUG-274: Bump lockEpoch so the stuck pipeline (if it ever unsticks) can't win
            // commit order against this new pipeline. Releasing without the epoch bump would
            // let its late writes pass every `lockEpoch === generationLockEpoch` guard.
            setGenerationLockEpoch(generationLockEpoch + 1);
            setGenerationLock(false);
        } else {
            console.warn('[DLE] Generation lock active — another pipeline is still running. Lore skipped for this generation.');
            dedupWarning('Lore from the last message is still loading — reusing what we had.', 'pipeline_lock');
            return;
        }
    }
    setGenerationLock(true);

    // Reset librarian per-generation search counter
    setLoreGapSearchCount(0);

    // Capture chat epoch to detect stale writes if CHAT_CHANGED fires mid-generation
    const epoch = chatEpoch;
    // Capture lock epoch to detect if this pipeline has been superseded by a force-released lock
    const lockEpoch = generationLockEpoch;

    // Track whether the pipeline ran far enough to need generation tracking
    let pipelineRan = false;
    let injectedEntries = [];

    // BUG-233: Per-generation AbortController so ST's Stop button can cancel the pipeline.
    // Wired to GENERATION_STOPPED + CHAT_CHANGED; torn down in finally to avoid leaks.
    const pipelineAbort = new AbortController();
    const onStop = () => { try { pipelineAbort.abort(); } catch { /* noop */ } };
    try { eventSource.on(event_types.GENERATION_STOPPED, onStop); } catch { /* noop */ }
    try { eventSource.on(event_types.CHAT_CHANGED, onStop); } catch { /* noop */ }

    try {
        // Tag sources with this generation's epoch so CHARACTER_MESSAGE_RENDERED
        // only consumes sources from the correct generation (race condition fix).
        // We do NOT clear lastInjectionSources here — the render handler clears
        // them after reading, and the epoch tag prevents stale consumption.
        //
        // NOTE: clearPrompts is intentionally deferred to the commit phase below.
        // Clearing here caused silent lore loss when early returns fired (vault timeout,
        // empty vault, no matches) — the old prompts were destroyed with nothing replacing them.
        // On first generation after hydration, clear stale dedup logs
        // (cached _contentHash values may not match current Obsidian content)
        if (!indexEverLoaded && vaultIndex.length > 0 && chat_metadata?.deeplore_injection_log?.length > 0) {
            chat_metadata.deeplore_injection_log = [];
        }

        // Ensure index is fresh (with timeout to prevent indefinite hangs)
        const INDEX_TIMEOUT_MS = 60_000;
        try {
            let indexTimer;
            await Promise.race([
                ensureIndexFresh().finally(() => clearTimeout(indexTimer)),
                new Promise((_, reject) => { indexTimer = setTimeout(() => reject(new Error('Index refresh timed out')), INDEX_TIMEOUT_MS); }),
            ]);
        } catch (timeoutErr) {
            console.warn(`[DLE] ${timeoutErr.message} — proceeding with stale data`);
            if (vaultIndex.length === 0) {
                dedupWarning('Couldn\'t reach your vault and no cache to fall back on.', 'obsidian_no_cache_fallback', { hint: 'Obsidian connection timed out; check the Local REST API plugin.' });
                return;
            }
        }

        // Snapshot vaultIndex at pipeline start to avoid races with background rebuilds
        // Filter out lorebook-guide entries — they are Librarian-only and must never reach the writing AI.
        const vaultSnapshot = getWriterVisibleEntries();

        if (vaultSnapshot.length === 0) {
            if (!indexEverLoaded) {
                dedupWarning(
                    'No lorebook entries found. Run /dle-health to check your Obsidian connection and vault settings.',
                    'obsidian_empty_vault', { timeOut: 10000 },
                );
            }
            if (settings.debugMode) {
                console.debug('[DLE] No entries indexed, skipping');
            }
            return;
        }

        // From here on, generation tracking must run even if no entries match
        pipelineRan = true;

        // BUG-291/292: Swipe rollback by slot+swipe_id, not content hash. Content-hashing missed
        // alternate-swipe navigation (content changes → new hash → treated as fresh gen → drift)
        // and collided with delete+regen. The `${msgIdx}|${swipe_id}` key is stable across those.
        {
            const earlyIdx = chat.length - 1;
            const earlySwipeId = earlyIdx >= 0 ? (chat[earlyIdx]?.swipe_id ?? 0) : 0;
            const earlySwipeKey = `${earlyIdx}|${earlySwipeId}`;
            if (lastGenerationTrackerSnapshot && lastGenerationTrackerSnapshot.swipeKey === earlySwipeKey) {
                const snap = lastGenerationTrackerSnapshot;
                setCooldownTracker(new Map(snap.cooldown));
                setDecayTracker(new Map(snap.decay));
                setConsecutiveInjections(new Map(snap.consecutive));
                setInjectionHistory(new Map(snap.injectionHistory));
                setGenerationCount(snap.generationCount);
                if (settings.debugMode) console.debug('[DLE] Swipe detected — restored tracker snapshot');
            }
            // Take a fresh snapshot for THIS generation (tagged with the CURRENT swipe key).
            setLastGenerationTrackerSnapshot({
                swipeKey: earlySwipeKey,
                cooldown: new Map(cooldownTracker),
                decay: new Map(decayTracker),
                consecutive: new Map(consecutiveInjections),
                injectionHistory: new Map(injectionHistory),
                generationCount: generationCount,
            });
        }

        // Contextual gating context: passed to both pipeline (pre-filter) and post-pipeline stages
        const ctx = chat_metadata.deeplore_context || {};

        const pins = chat_metadata.deeplore_pins || [];
        const blocks = chat_metadata.deeplore_blocks || [];
        const folderFilter = chat_metadata.deeplore_folder_filter || null;

        const { finalEntries: pipelineEntries, matchedKeys, trace } = await runPipeline(chat, vaultSnapshot, ctx, { pins, blocks, folderFilter, signal: pipelineAbort.signal });
        if (pipelineAbort.signal.aborted) {
            if (settings.debugMode) console.debug('[DLE] Pipeline aborted by user before commit');
            return;
        }
        const policy = buildExemptionPolicy(vaultSnapshot, pins, blocks);

        // Stage 1: Pin/Block overrides
        let finalEntries = applyPinBlock(pipelineEntries, vaultSnapshot, policy, matchedKeys);

        // Stage 2: Contextual gating (driven by field definitions)
        const preContextual = new Set(finalEntries.map(e => e.title));
        const fieldDefs = fieldDefinitions.length > 0 ? fieldDefinitions : DEFAULT_FIELD_DEFINITIONS;
        finalEntries = applyContextualGating(finalEntries, ctx, policy, settings.debugMode, settings, fieldDefs);
        if (trace) {
            const postContextual = new Set(finalEntries.map(e => e.title));
            trace.contextualGatingRemoved = [...preContextual].filter(t => !postContextual.has(t));
        }

        if (trace?.aiFallback) {
            const aiErr = trace.aiError || '';
            let fallbackMsg = 'AI search failed';
            if (/timeout|timed out|abort/i.test(aiErr)) fallbackMsg += ' (timed out — try increasing the timeout in Settings > AI Search)';
            else if (/401|403|auth/i.test(aiErr)) fallbackMsg += ' (auth error — check your API key or connection profile)';
            else if (/not found|no.*profile/i.test(aiErr)) fallbackMsg += ' (connection profile not found — check Settings > AI Search)';
            else if (/ECONNREFUSED|Failed to fetch|NetworkError|fetch|network/i.test(aiErr)) fallbackMsg += ' (network error — check your AI connection settings)';
            else if (/5\d\d|502|503|server/i.test(aiErr)) fallbackMsg += ' (server error — try again later)';
            else if (aiErr) fallbackMsg += ` (${aiErr.slice(0, 80)})`;
            console.warn('[DLE] AI search error:', aiErr);
            dedupWarning(`${fallbackMsg} — falling back to keywords`, 'ai_search', { timeOut: 6000 });
        }

        if (settings.debugMode && trace) {
            console.log(`[DLE] Pipeline (${trace.mode}): ${trace.keywordMatched.length} keyword matches, ${trace.aiSelected.length} AI selected` + (trace.aiFallback ? ' (AI FALLBACK)' : ''));
        }

        if (finalEntries.length === 0) {
            if (settings.debugMode) {
                console.debug('[DLE] No entries matched');
            }
            // BUG-231: Guard clearPrompts against stale pipelines completing after chat-switch.
            // Without this, a slow pipeline for chat A can wipe chat B's freshly-committed prompts.
            if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
                console.warn('[DLE] Stale pipeline reached no-match branch — skipping clearPrompts');
                return;
            }
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            return;
        }

        // Stage 3: Re-injection cooldown
        const preCooldown = new Set(finalEntries.map(e => e.title));
        finalEntries = applyReinjectionCooldown(finalEntries, policy, injectionHistory, generationCount, settings.reinjectionCooldown, settings.debugMode);
        if (trace) {
            const postCooldown = new Set(finalEntries.map(e => e.title));
            trace.cooldownRemoved = [...preCooldown].filter(t => !postCooldown.has(t));
        }

        if (finalEntries.length === 0) {
            if (settings.debugMode) console.debug('[DLE] All entries removed by re-injection cooldown');
            // BUG-271: Same guard as BUG-231 — stale pipeline must not wipe the new chat's prompts.
            if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
                console.warn('[DLE] Stale pipeline reached cooldown-empty branch — skipping clearPrompts');
                return;
            }
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            return;
        }

        // Stage 4: Requires/excludes gating (forceInject entries exempt)
        const { result: gated, removed: gatingRemoved } = applyRequiresExcludesGating(finalEntries, policy, settings.debugMode);

        if (gated.length === 0) {
            if (settings.debugMode) console.debug('[DLE] All entries removed by gating rules');
            // BUG-271: Same guard as BUG-231 — stale pipeline must not wipe the new chat's prompts.
            if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
                console.warn('[DLE] Stale pipeline reached gating-empty branch — skipping clearPrompts');
                return;
            }
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            return;
        }

        // Stage 5: Strip duplicate injections
        let postDedup = gated;
        if (settings.stripDuplicateInjections) {
            postDedup = applyStripDedup(gated, policy, chat_metadata.deeplore_injection_log, settings.stripLookbackDepth, settings, settings.debugMode);
            if (trace) {
                const postDedupTitles = new Set(postDedup.map(e => e.title));
                trace.stripDedupRemoved = gated.filter(e => !postDedupTitles.has(e.title)).map(e => e.title);
            }
        }

        // Stage 6: Format with budget, grouped by injection position
        // BUG-014: Use the captured settings object (line 63) for consistent settings throughout pipeline
        const { groups, count: injectedCount, totalTokens, acceptedEntries } = formatAndGroup(postDedup, settings, PROMPT_TAG_PREFIX);

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

            // Activity feed: record pipeline run summary for drawer footer
            const aiUsed = trace.aiSelected?.length > 0;
            const modeLabel = trace.mode === 'keywords-only' ? 'Keywords'
                : aiUsed ? (trace.aiFallback ? 'Fallback' : 'AI')
                : 'Keywords';
            pushActivity({
                ts: Date.now(),
                injected: trace.injected?.length || 0,
                mode: modeLabel,
                tokens: trace.totalTokens || 0,
                folderFilter: trace.folderFilter?.folders || null,
            });
        }

        // BUG-AUDIT-5: Epoch guard on commit phase — prevent stale force-released pipelines
        // from wiping prompts that the new pipeline just set.
        if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
            console.warn('[DLE] Stale pipeline reached commit phase — discarding');
            return;
        }

        if (groups.length > 0) {
            // Final epoch check before committing — bail if chat changed or pipeline superseded.
            // clearPrompts is inside this block so we never wipe prompts without replacing them.
            if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
                console.warn('[DLE] Chat changed or pipeline superseded during commit — discarding results');
                return;
            }
            // Clear previous prompts only now that we have verified results to replace them.
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            if (settings.injectionMode === 'prompt_list' && promptManager) {
                for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad']) {
                    const pmEntry = promptManager.getPromptById(id);
                    if (pmEntry) pmEntry.content = '';
                }
            }
            const usePromptList = settings.injectionMode === 'prompt_list';
            for (const group of groups) {
                // Outlet groups bypass PM entirely — inject via extension_prompts for {{outlet::name}} macro
                if (group.position === -1) {
                    setExtensionPrompt(group.tag, group.text, -1, 0);
                    continue;
                }
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

            // Capture injection sources for Context Cartographer (epoch-tagged for race safety)
            setLastInjectionSources(injectedEntries.map(e => ({
                title: e.title,
                filename: e.filename,
                matchedBy: matchedKeys.get(e.title) || '?',
                priority: e.priority,
                tokens: e.tokenEstimate,
                vaultSource: e.vaultSource || '',
            })));
            setLastInjectionEpoch(epoch);
        } else {
            // No lore groups — still clear stale prompts from previous generation
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            if (settings.injectionMode === 'prompt_list' && promptManager) {
                for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad']) {
                    const pmEntry = promptManager.getPromptById(id);
                    if (pmEntry) pmEntry.content = '';
                }
            }
        }

        // Author's Notebook injection (independent of entry pipeline)
        if (settings.notebookEnabled && chat_metadata?.deeplore_notebook?.trim()) {
            const rawNotebook = chat_metadata.deeplore_notebook.trim();
            const notebookContent = rawNotebook;
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

        // AI Notebook injection
        // Tag mode: inject previous notes + instruction prompt (AI writes <dle-notes> tags)
        // Extract mode: inject previous notes only (no instruction — extraction happens post-gen)
        if (settings.aiNotepadEnabled) {
            const notepadMode = settings.aiNotepadMode || 'tag';
            const parts = [];
            const storedNotes = chat_metadata?.deeplore_ai_notepad?.trim();
            if (storedNotes) {
                parts.push(`[Your previous session notes]\n${storedNotes}\n[End of session notes]`);
            }
            if (notepadMode === 'tag') {
                // Tag mode: include instruction prompt so AI knows to use <dle-notes>
                const instructionPrompt = settings.aiNotepadPrompt?.trim() || DEFAULT_AI_NOTEPAD_PROMPT;
                parts.push(instructionPrompt);
            }
            // Only inject if we have content (extract mode with no existing notes = nothing to inject)
            if (parts.length > 0) {
                const notepadContent = parts.join('\n\n');
                const usePromptList = settings.injectionMode === 'prompt_list';
                if (usePromptList && promptManager) {
                    const pmEntry = promptManager.getPromptById('deeplore_ai_notepad');
                    if (pmEntry) {
                        pmEntry.content = notepadContent;
                    } else {
                        setExtensionPrompt('deeplore_ai_notepad', notepadContent, settings.aiNotepadPosition, settings.aiNotepadDepth, false, settings.aiNotepadRole);
                    }
                } else {
                    setExtensionPrompt('deeplore_ai_notepad', notepadContent, settings.aiNotepadPosition, settings.aiNotepadDepth, false, settings.aiNotepadRole);
                }
            }
        }

        // Stage 7: Track cooldowns and injection history (epoch-guarded, lock-guarded)
        // lockEpoch guard prevents a force-released stale pipeline from corrupting these Maps
        // concurrently with the active pipeline that superseded it.
        if (epoch === chatEpoch && lockEpoch === generationLockEpoch) {
            trackGeneration(injectedEntries, generationCount, cooldownTracker, decayTracker, injectionHistory, settings);
        }

        // Clear stale injection log when dedup is toggled off (epoch-guarded)
        if (!settings.stripDuplicateInjections && epoch === chatEpoch && chat_metadata.deeplore_injection_log?.length > 0) {
            chat_metadata.deeplore_injection_log = [];
            saveMetadataDebounced();
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
            saveMetadataDebounced();
        }

        // Stage 8: Analytics (use postDedup — entries that passed all gating — as "matched")
        // BUG-FIX: Epoch-guard analytics like Stages 7 and 9 to prevent cross-chat pollution
        if (postDedup.length > 0 && epoch === chatEpoch && lockEpoch === generationLockEpoch) {
            recordAnalytics(postDedup, injectedEntries, settings.analyticsData);
            // Only persist analytics every 5 generations to reduce write amplification
            if (generationCount % 5 === 0) {
                invalidateSettingsCache();
                saveSettingsDebounced();
            }
        }

        // Stage 9: Per-chat injection counts (epoch-guarded, lock-guarded, swipe-aware)
        //
        // BUG-291/292/293: Swipe dedup is now keyed by `${msgIdx}|${swipe_id}` with a
        // per-swipe map of injected trackerKeys. This correctly handles:
        //   - regen of the current swipe (key matches → decrement exactly the prior keys)
        //   - alternate-swipe navigation (different swipe_id → different key → no false decrement)
        //   - reload between generations (perSwipeInjectedKeys is persisted)
        if (epoch === chatEpoch && lockEpoch === generationLockEpoch) {
            const lastIdx = chat.length - 1;
            const swipeId = lastIdx >= 0 ? (chat[lastIdx]?.swipe_id ?? 0) : 0;
            const swipeKey = `${lastIdx}|${swipeId}`;

            const priorKeys = perSwipeInjectedKeys.get(swipeKey);
            if (priorKeys && priorKeys.size > 0) {
                for (const key of priorKeys) {
                    const cur = chatInjectionCounts.get(key) || 0;
                    if (cur > 0) chatInjectionCounts.set(key, cur - 1);
                }
            }

            // Track this round
            const thisRoundKeys = new Set();
            for (const entry of injectedEntries) {
                const key = trackerKey(entry);
                chatInjectionCounts.set(key, (chatInjectionCounts.get(key) || 0) + 1);
                thisRoundKeys.add(key);
            }
            perSwipeInjectedKeys.set(swipeKey, thisRoundKeys);

            // Prune: keep only recent message slots (bounded memory + metadata size).
            const keepFromIdx = Math.max(0, chat.length - 10);
            for (const k of [...perSwipeInjectedKeys.keys()]) {
                const mi = parseInt(k.split('|')[0], 10);
                if (!Number.isFinite(mi) || mi < keepFromIdx) perSwipeInjectedKeys.delete(k);
            }

            // Persist to chat_metadata every generation (counts are lost on chat switch otherwise)
            chat_metadata.deeplore_chat_counts = Object.fromEntries(chatInjectionCounts);
            chat_metadata.deeplore_swipe_injected_keys = Object.fromEntries(
                [...perSwipeInjectedKeys.entries()].map(([k, v]) => [k, [...v]])
            );
            // BUG-306: Prefer immediate save over debounced — the debounce can lose the race
            // with CHAT_CHANGED and never flush this chat's counts. Fire-and-forget; fall back
            // to debounced if saveMetadata throws synchronously (shouldn't, but belt-and-braces).
            try { saveMetadata(); } catch { saveMetadataDebounced(); }
        }

        if (groups.length > 0) {
            // Context usage warning — BUG 6 FIX: reset ratio when it drops below threshold
            if (contextSize > 0) {
                const ratio = totalTokens / contextSize;
                if (ratio > 0.20 && ratio > lastWarningRatio + 0.05) {
                    const pct = Math.round(ratio * 100);
                    toastr.warning(
                        `Lore is using ${pct}% of your context window (~${totalTokens} tokens, ${injectedCount} entries). You can set a token budget in Settings to manage this.`,
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
        // BUG-233: User aborts are not errors — no toast, no log spam.
        if (err?.userAborted || err?.name === 'AbortError' || pipelineAbort.signal.aborted) {
            if (settings.debugMode) console.debug('[DLE] Pipeline aborted:', err?.message || 'user stop');
        } else {
            console.error('[DLE] Error during generation:', err);
            dedupError('Couldn\'t load your lore. Try /dle-refresh, or /dle-health for diagnostics.', 'pipeline', { hint: classifyError(err) });
        }
    } finally {
        // BUG-233: Always tear down the abort listeners to avoid accumulation across generations.
        try { eventSource.removeListener(event_types.GENERATION_STOPPED, onStop); } catch { /* noop */ }
        try { eventSource.removeListener(event_types.CHAT_CHANGED, onStop); } catch { /* noop */ }
        // Generation tracking must always run when the pipeline was entered,
        // even if no entries matched — otherwise cooldown timers freeze permanently.
        // Wrapped in try/catch to prevent tracking errors from blocking ST generation.
        try {
            if (pipelineRan && epoch === chatEpoch && lockEpoch === generationLockEpoch) {
                setGenerationCount(generationCount + 1);
                decrementTrackers(cooldownTracker, decayTracker, injectedEntries, settings, consecutiveInjections);
            }
        } catch (trackingErr) {
            console.error('[DLE] Error in generation tracking:', trackingErr);
        }
        // Release lock FIRST so pipeline-complete renders see correct state.
        // A force-released stale pipeline must NOT release the newer pipeline's lock.
        if (lockEpoch === generationLockEpoch) {
            setGenerationLock(false);
        }
        // Notify drawer that pipeline is done (regardless of success/failure)
        notifyPipelineComplete();
    }
}

// Register the interceptor on globalThis so SillyTavern can find it
globalThis.deepLoreEnhanced_onGenerate = onGenerate;

// External API: match vault entries against arbitrary text
// (imported from pipeline.js, re-exported on globalThis)
import { matchTextForExternal } from './src/pipeline/pipeline.js';
globalThis.deepLoreEnhanced_matchText = matchTextForExternal;

// ============================================================================
// Initialization
// ============================================================================

jQuery(async function () {
    try {
        // BUG-063: Re-init guard. If the module somehow gets re-evaluated (hot
        // reload, duplicate load, etc.), tear down prior listeners/DOM before
        // registering fresh ones — otherwise every handler doubles.
        if (_dleInitialized) {
            console.warn('[DLE] init() called twice — tearing down prior instance before re-initializing');
            _teardownDleExtension();
        }
        _dleInitialized = true;

        const settingsHtml = await renderExtensionTemplateAsync(
            'third-party/sillytavern-DeepLore-Enhanced',
            'settings',
        );
        $('#extensions_settings2').append(settingsHtml);

        // Create the drawer panel in the top bar
        await createDrawerPanel();

        loadSettingsUI();
        bindSettingsEvents(buildIndex);
        registerSlashCommands();
        setupSyncPolling(buildIndex, buildIndexWithReuse);

        // Start the diagnostic flight recorder (always-on, debug-mode-independent).
        try {
            const { startFlightRecorder } = await import('./src/diagnostics/flight-recorder.js');
            startFlightRecorder();
        } catch (err) {
            console.warn('[DLE] Flight recorder failed to start:', err?.message);
        }

        // Register Librarian tools if enabled (also retried lazily in onGenerate)
        try {
            registerLibrarianTools();
        } catch (err) {
            console.warn('[DLE] Failed to initialize Librarian:', err.message);
        }

        // Apply Librarian visibility (hides drawer tab/panel when feature is off)
        try {
            const { applyLibrarianVisibility } = await import('./src/librarian/visibility.js');
            applyLibrarianVisibility(!!getSettings().librarianEnabled);
        } catch (err) {
            console.warn('[DLE] Librarian visibility init failed:', err.message);
        }

        // Pre-flight Claude adaptive-thinking misconfiguration sweep across all
        // 3 AI features so the user is warned at startup, not at first generation.
        try {
            const {
                detectClaudeAdaptiveIssue,
                buildClaudeAdaptiveMessage,
                shouldCheckClaudeAdaptiveForFeature,
                claimClaudeAdaptiveToastSlot,
            } = await import('./src/ai/claude-adaptive-check.js');
            const { setClaudeAutoEffortState } = await import('./src/state.js');
            const { dedupWarning } = await import('./src/toast-dedup.js');
            const s = getSettings();
            // Only check features whose effective connection mode is `profile`.
            // Proxy mode routes through a local proxy that handles thinking
            // itself, so the native-preset check is a false positive there.
            const checks = [
                { id: s.aiSearchProfileId, model: s.aiSearchModel, label: 'AI Search', feature: 'aiSearch' },
                { id: s.scribeProfileId, model: s.scribeModel, label: 'Session Scribe', feature: 'scribe' },
                { id: s.autoSuggestProfileId, model: s.autoSuggestModel, label: 'Auto Lorebook', feature: 'autoSuggest' },
            ].filter(c => shouldCheckClaudeAdaptiveForFeature(s, c.feature));
            let firstBad = null;
            for (const c of checks) {
                const d = detectClaudeAdaptiveIssue(c.id, c.model);
                if (d.bad) { firstBad = { ...d, feature: c.label }; break; }
            }
            if (firstBad) {
                // Persistent surfaces (drawer chip + settings banner) are driven
                // by this state. The toast is a one-shot heads-up only.
                setClaudeAutoEffortState(true, firstBad);
                if (claimClaudeAdaptiveToastSlot(firstBad)) {
                    dedupWarning(buildClaudeAdaptiveMessage(firstBad, 'toast'), 'claude_auto_effort', { timeOut: 12000 });
                }
            } else {
                setClaudeAutoEffortState(false, null);
            }
        } catch (err) {
            console.debug('[DLE] Claude adaptive-thinking pre-flight check skipped:', err?.message);
        }

        // First-run detection: if no vaults configured and wizard not completed, show wizard.
        // MUST wait for ST's APP_READY (fires after ST's own first-run onboarding popup is dismissed),
        // otherwise DLE's wizard lands on top of ST's persona-name popup on brand-new installs.
        const firstRunSettings = getSettings();
        const hasEnabledVaults = (firstRunSettings.vaults || []).some(v => v.enabled);
        if (!hasEnabledVaults && !firstRunSettings._wizardCompleted) {
            const launchWizard = async () => {
                try {
                    // Wait for ST's onboarding popup to be gone, in case APP_READY fired early
                    // or a future ST version moves onboarding to a non-blocking flow.
                    const onboardingVisible = () => {
                        const el = document.querySelector('#onboarding_template .onboarding')
                            || document.querySelector('dialog[open] .onboarding');
                        return el && el.offsetParent !== null;
                    };
                    let waited = 0;
                    while (onboardingVisible() && waited < 30000) {
                        await new Promise(r => setTimeout(r, 250));
                        waited += 250;
                    }
                    // Re-check settings — user may have configured a vault during the wait.
                    const s = getSettings();
                    if ((s.vaults || []).some(v => v.enabled) || s._wizardCompleted) return;
                    const { showSetupWizard } = await import('./src/ui/setup-wizard.js');
                    showSetupWizard();
                } catch (err) {
                    console.warn('[DLE] Setup wizard auto-open failed:', err?.message);
                }
            };
            // APP_READY fires after ST's getSettings() and its awaited doOnboarding() popup.
            _registerEs(event_types.APP_READY, () => setTimeout(launchWizard, 500), { once: true });
        }

        // Register PM prompts on init so they appear in the Prompt Manager immediately.
        // Content is written directly to PM entries at generation time (not via setExtensionPrompt),
        // so the PM collection order (user's drag position) controls placement.
        const initSettings = getSettings();
        if (initSettings.injectionMode === 'prompt_list') {
            // Register directly in PM (so entries appear in the list without generating first).
            // promptManager may not be initialized yet, so poll briefly.
            const PM_DISPLAY_NAMES = {
                [`${PROMPT_TAG_PREFIX}constants`]: 'DLE Constants',
                [`${PROMPT_TAG_PREFIX}lore`]: 'DLE Lore Entries',
                'deeplore_notebook': 'DLE Author\'s Notebook',
                'deeplore_ai_notepad': 'DLE AI Notebook',
            };
            const registerPmEntries = () => {
                if (!promptManager) return false;
                const ids = [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad'];
                for (const id of ids) {
                    const existing = promptManager.getPromptById(id);
                    if (!existing) {
                        promptManager.addPrompt({
                            name: PM_DISPLAY_NAMES[id] || id,
                            content: '',
                            system_prompt: true,
                            role: 'system',
                            marker: false,
                            enabled: true,
                            extension: true,
                        }, id);
                    } else {
                        // Patch legacy entries missing role or old display name
                        if (!existing.role) existing.role = 'system';
                        if (!existing.extension) existing.extension = true;
                        const friendlyName = PM_DISPLAY_NAMES[id];
                        if (friendlyName && existing.name !== friendlyName) existing.name = friendlyName;
                    }
                    // Add to active character's prompt order if not already there.
                    // Insert after 'main' or 'chatHistory' for a sensible default position
                    // instead of appending to the end (which puts entries after jailbreak).
                    if (promptManager.activeCharacter) {
                        const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
                        if (!order.find(e => e.identifier === id)) {
                            const anchorIdx = order.findIndex(e => e.identifier === 'main' || e.identifier === 'chatHistory');
                            if (anchorIdx >= 0) {
                                order.splice(anchorIdx + 1, 0, { identifier: id, enabled: true });
                            } else {
                                order.push({ identifier: id, enabled: true });
                            }
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
                }, 1000);
                // Stop trying after 10s
                setTimeout(() => clearInterval(interval), 10000);
            }
        }
        if (initSettings.enabled) {
            // Try instant hydration from IndexedDB, then validate against Obsidian in background
            _registerEs(event_types.APP_READY, async () => {
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
            }, { once: true });
        }

        // Context Cartographer: click + keyboard handler (event delegation — registered once)
        $('#chat').on('click keydown', '.mes_deeplore_sources', function (e) {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            if (e.type === 'keydown') e.preventDefault();
            const messageId = $(this).closest('.mes').attr('mesid');
            const message = chat[messageId];
            const sources = message?.extra?.deeplore_sources;
            if (!sources || sources.length === 0) return;
            showSourcesPopup(sources, { aiNotes: message?.extra?.deeplore_ai_notes });
        });

        // AI Notebook: GENERATION_ENDED handler for both tag and extract modes.
        // Tag mode: extract <dle-notes> from AI response before rendering.
        // Extract mode: strip visible notes, then fire async API call to extract session notes.
        _registerEs(event_types.GENERATION_ENDED, () => {
            const settings = getSettings();
            if (!settings.aiNotepadEnabled) return;
            const mode = settings.aiNotepadMode || 'tag';
            const lastMessage = chat[chat.length - 1];
            if (!lastMessage || lastMessage.is_user || !lastMessage.mes) return;

            if (mode === 'tag') {
                // Tag mode: extract <dle-notes> blocks
                const { notes, cleanedMessage } = extractAiNotes(lastMessage.mes);
                if (notes) {
                    lastMessage.mes = cleanedMessage;
                    lastMessage.extra = lastMessage.extra || {};
                    lastMessage.extra.deeplore_ai_notes = notes;
                    const existing = chat_metadata.deeplore_ai_notepad || '';
                    chat_metadata.deeplore_ai_notepad = (existing + '\n' + notes).trim();
                    saveMetadataDebounced();
                }
            } else if (mode === 'extract') {
                // Extract mode: strip visible note-taking prose, then async API extraction
                let cleaned = lastMessage.mes;
                for (const pattern of VISIBLE_NOTES_PATTERNS) {
                    cleaned = cleaned.replace(pattern, '');
                }
                cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trimEnd();
                if (cleaned !== lastMessage.mes) {
                    lastMessage.mes = cleaned;
                    saveMetadataDebounced();
                }

                // BUG-AUDIT-7: Fire-and-forget async extraction with epoch guard
                // to prevent writing notes to the wrong chat after a chat switch.
                if (notepadExtractInProgress) return;
                setNotepadExtractInProgress(true);
                const extractEpoch = chatEpoch;
                (async () => {
                    try {
                        const extractPrompt = settings.aiNotepadExtractPrompt?.trim() || DEFAULT_AI_NOTEPAD_EXTRACT_PROMPT;
                        const existingNotes = chat_metadata?.deeplore_ai_notepad?.trim();
                        let userMsg = `[Latest AI response]\n${lastMessage.mes}`;
                        if (existingNotes) {
                            userMsg = `[Previous session notes]\n${existingNotes}\n\n${userMsg}`;
                        }

                        const connectionConfig = { ...resolveConnectionConfig('aiNotepad'), skipThrottle: true };

                        const result = await callAI(extractPrompt, userMsg, connectionConfig);
                        const responseText = (result?.text || result || '').trim();

                        // BUG-AUDIT-7: Bail if chat changed during async extraction
                        if (extractEpoch !== chatEpoch) return;
                        if (responseText && responseText !== 'NOTHING_TO_NOTE') {
                            lastMessage.extra = lastMessage.extra || {};
                            lastMessage.extra.deeplore_ai_notes = responseText;
                            const existing = chat_metadata.deeplore_ai_notepad || '';
                            chat_metadata.deeplore_ai_notepad = (existing + '\n' + responseText).trim();
                            saveMetadataDebounced();
                        }
                    } catch (err) {
                        console.warn('[DLE] AI Notebook extract error:', err.message);
                    } finally {
                        setNotepadExtractInProgress(false);
                    }
                })();
            }
        });

        // Context Cartographer + Session Scribe: post-render handler
        _registerEs(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
            const settings = getSettings();
            const message = chat[messageId];

            // Skip intermediate empty messages created during tool-call sequences.
            // ST renders an empty assistant message (with reasoning/thinking) before processing
            // tool calls and recursing Generate(). If we consume data here, it ends up on the
            // wrong message and the final reply gets nothing.
            const isIntermediateToolMsg = message && !message.is_user && !message.mes?.trim();
            if (isIntermediateToolMsg) {
                // Still inject Cartographer buttons for messages that already have persisted sources
                // (from previous non-tool-call generations on chat reload).
                if (settings.showLoreSources) {
                    injectSourcesButton(messageId);
                }
                return;
            }

            // --- Context Cartographer: store sources and inject button ---
            // Only consume sources that belong to the current chat epoch (race condition guard:
            // prevents stale sources from a previous chat from being stored on the wrong message).
            // Sources are NOT nulled after consumption — the drawer reads them for the Why? tab.
            // Instead, track which message consumed them to prevent re-consumption on subsequent renders.
            if (settings.showLoreSources && lastInjectionSources && lastInjectionSources.length > 0) {
                if (lastInjectionEpoch === chatEpoch && lastInjectionSources._consumedByMesId !== messageId) {
                    if (message && !message.is_user) {
                        message.extra = message.extra || {};
                        message.extra.deeplore_sources = lastInjectionSources;
                        lastInjectionSources._consumedByMesId = messageId;
                        saveMetadataDebounced();
                    }
                }
            }

            if (settings.showLoreSources) {
                injectSourcesButton(messageId);
            }

            // --- AI Notebook: fallback extraction (if GENERATION_ENDED missed it, e.g. swipe) ---
            if (settings.aiNotepadEnabled) {
                if (message && !message.is_user && message.mes) {
                    const { notes, cleanedMessage } = extractAiNotes(message.mes);
                    if (notes) {
                        message.mes = cleanedMessage;
                        message.extra = message.extra || {};
                        if (!message.extra.deeplore_ai_notes) {
                            message.extra.deeplore_ai_notes = notes;
                            const existing = chat_metadata.deeplore_ai_notepad || '';
                            chat_metadata.deeplore_ai_notepad = (existing + '\n' + notes).trim();
                        }
                        saveMetadataDebounced();
                        const mesBlock = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
                        if (mesBlock) mesBlock.innerHTML = messageFormatting(cleanedMessage, message.name, message.is_system, message.is_user, messageId);
                    }
                }
            }

            // --- Librarian: consolidate tool call messages into reply dropdown ---
            // consumePendingToolCalls() returns ALL tool calls that accumulated since the last
            // non-intermediate render. Because we skip intermediates above, this naturally
            // collects searches+flags from all tool-call rounds into one batch.
            if (settings.librarianEnabled) {
                const pendingCalls = consumePendingToolCalls();
                if (pendingCalls.length > 0) {
                    if (message && !message.is_user) {
                        message.extra = message.extra || {};
                        message.extra.deeplore_tool_calls = pendingCalls;
                        saveMetadataDebounced();
                    }
                    injectLibrarianDropdown(messageId, pendingCalls);
                }
            }

            // --- Session Scribe: track chat position and auto-trigger ---
            if (settings.enabled && settings.scribeEnabled && settings.scribeInterval > 0) {
                const newMessages = chat.length - lastScribeChatLength;
                if (newMessages >= settings.scribeInterval && !scribeInProgress) {
                    runScribe(); // fire-and-forget
                }
            }

            // --- Auto Lorebook: increment counter and auto-trigger every N messages ---
            if (settings.enabled && settings.autoSuggestEnabled && settings.autoSuggestInterval > 0) {
                setAutoSuggestMessageCount(autoSuggestMessageCount + 1);
                if (autoSuggestMessageCount >= settings.autoSuggestInterval) {
                    setAutoSuggestMessageCount(0);
                    // Fire-and-forget: fetch suggestions then show popup (popup honors autoSuggestSkipReview)
                    (async () => {
                        try {
                            const suggestions = await runAutoSuggest();
                            if (suggestions && suggestions.length > 0) await showSuggestionPopup(suggestions);
                        } catch (err) { console.warn('[DLE] Auto-suggest auto-trigger failed:', err?.message); }
                    })();
                }
            }
        });

        // Swipe handler: clear stale tool call data and sources from the swiped message
        _registerEs(event_types.MESSAGE_SWIPED, (messageId) => {
            const message = chat[messageId];
            if (!message || message.is_user) return;

            // Clear tool call dropdown data and DOM
            if (message.extra?.deeplore_tool_calls) {
                delete message.extra.deeplore_tool_calls;
                saveMetadataDebounced();
            }
            removeLibrarianDropdown(messageId);
            clearPendingToolCalls();

            // BUG-290: AI Notepad swipe rollback — remove only the LAST occurrence, anchored on
            // '\n' + notes (matching the append pattern in CHARACTER_MESSAGE_RENDERED). The old
            // `String.replace` removed the first match and broke on duplicate-note collisions.
            if (message.extra?.deeplore_ai_notes) {
                const notes = message.extra.deeplore_ai_notes;
                const acc = chat_metadata.deeplore_ai_notepad || '';
                const anchored = '\n' + notes;
                let updated = acc;
                const aIdx = acc.lastIndexOf(anchored);
                if (aIdx !== -1) {
                    updated = acc.slice(0, aIdx) + acc.slice(aIdx + anchored.length);
                } else {
                    const nIdx = acc.lastIndexOf(notes);
                    if (nIdx !== -1) updated = acc.slice(0, nIdx) + acc.slice(nIdx + notes.length);
                }
                chat_metadata.deeplore_ai_notepad = updated.replace(/\n{3,}/g, '\n\n').trim();
                delete message.extra.deeplore_ai_notes;
            }

            // Clear stale Cartographer sources (new generation will set fresh ones)
            if (message.extra?.deeplore_sources) {
                delete message.extra.deeplore_sources;
                saveMetadataDebounced();
            }
        });

        // BUG-037: Subscribe to message lifecycle events that were previously ignored.
        // Without these, per-message stored extras (deeplore_sources, deeplore_ai_notes,
        // deeplore_tool_calls) and the AI Notepad accumulator drift permanently when users
        // delete/edit messages or dismiss alternate swipes.
        const _cleanupMessageExtras = (messageId, { alsoAiNotes = true } = {}) => {
            const message = chat?.[messageId];
            if (!message) return;
            let dirty = false;
            if (message.extra?.deeplore_tool_calls) {
                delete message.extra.deeplore_tool_calls;
                dirty = true;
            }
            removeLibrarianDropdown(messageId);
            if (alsoAiNotes && message.extra?.deeplore_ai_notes) {
                const notes = message.extra.deeplore_ai_notes;
                const acc = chat_metadata?.deeplore_ai_notepad || '';
                // BUG-290: last-occurrence, anchored — see MESSAGE_SWIPED handler above.
                const anchored = '\n' + notes;
                let updated = acc;
                const aIdx = acc.lastIndexOf(anchored);
                if (aIdx !== -1) {
                    updated = acc.slice(0, aIdx) + acc.slice(aIdx + anchored.length);
                } else {
                    const nIdx = acc.lastIndexOf(notes);
                    if (nIdx !== -1) updated = acc.slice(0, nIdx) + acc.slice(nIdx + notes.length);
                }
                if (updated !== acc && chat_metadata) {
                    chat_metadata.deeplore_ai_notepad = updated.replace(/\n{3,}/g, '\n\n').trim();
                    dirty = true;
                }
                delete message.extra.deeplore_ai_notes;
                dirty = true;
            }
            if (message.extra?.deeplore_sources) {
                delete message.extra.deeplore_sources;
                dirty = true;
            }
            if (dirty) saveMetadataDebounced();
        };

        _registerEs(event_types.MESSAGE_DELETED, (messageId) => {
            try { _cleanupMessageExtras(messageId); } catch (err) { console.warn('[DLE] MESSAGE_DELETED cleanup failed:', err.message); }
        });

        _registerEs(event_types.MESSAGE_SWIPE_DELETED, (messageId) => {
            // The swiped-away alternate is gone — its extras no longer apply.
            try { _cleanupMessageExtras(messageId); } catch (err) { console.warn('[DLE] MESSAGE_SWIPE_DELETED cleanup failed:', err.message); }
        });

        // BUG-038: Subscribe to chat deletion events. ST wipes chat_metadata itself, but
        // the Librarian session draft is stored in localStorage (see librarian-session.js
        // SESSION_STORAGE_KEY) and would otherwise linger as an orphan pointing at a
        // now-deleted chat. Clear it when the chat is deleted.
        const _onChatDeleted = () => {
            try { clearLibrarianSessionState(); } catch (err) { console.warn('[DLE] CHAT_DELETED cleanup failed:', err.message); }
        };
        _registerEs(event_types.CHAT_DELETED, _onChatDeleted);
        _registerEs(event_types.GROUP_CHAT_DELETED, _onChatDeleted);

        // BUG-039: Subscribe to connection profile lifecycle events. If a profile wired
        // into one of DLE's six profile fields (aiSearch, scribe, autoSuggest, aiNotepad,
        // librarian, optimizeKeys) gets deleted or renamed, the stored profileId becomes
        // a dangling reference. On delete, null any profileId that no longer resolves;
        // on update, invalidate the settings cache so fresh names are picked up. On both,
        // surface a user-visible toast so they know to rebind.
        const _profileIdFields = [
            'aiSearchProfileId', 'scribeProfileId', 'autoSuggestProfileId',
            'aiNotepadProfileId', 'librarianProfileId', 'optimizeKeysProfileId',
        ];
        const _onProfileDeleted = async (deleted) => {
            try {
                const s = getSettings();
                const deletedId = deleted?.id || deleted?.profileId || deleted;
                if (!deletedId) return;
                let cleared = 0;
                for (const field of _profileIdFields) {
                    if (s[field] === deletedId) {
                        s[field] = '';
                        cleared++;
                    }
                }
                if (cleared > 0) {
                    invalidateSettingsCache();
                    try { saveSettingsDebounced(); } catch { /* no-op */ }
                    dedupWarning(
                        `A connection profile wired into ${cleared} DLE feature${cleared === 1 ? '' : 's'} was deleted. Re-bind in DLE settings.`,
                        'profile_deleted',
                    );
                }
            } catch (err) { console.warn('[DLE] CONNECTION_PROFILE_DELETED cleanup failed:', err.message); }
        };
        const _onProfileUpdated = () => {
            try { invalidateSettingsCache(); } catch { /* no-op */ }
        };
        _registerEs(event_types.CONNECTION_PROFILE_DELETED, _onProfileDeleted);
        _registerEs(event_types.CONNECTION_PROFILE_UPDATED, _onProfileUpdated);

        // BUG-083: ST resets oai_settings.function_calling when the chat completion
        // source or model changes. Re-assert it so Librarian tools aren't silently
        // dropped from outbound requests after the user switches providers.
        const _onSourceOrModelChanged = () => {
            try {
                if (getSettings().librarianEnabled) ensureFunctionCallingEnabled();
            } catch (err) { console.warn('[DLE] source/model change re-assert failed:', err.message); }
        };
        _registerEs(event_types.CHATCOMPLETION_SOURCE_CHANGED, _onSourceOrModelChanged);
        _registerEs(event_types.MAIN_API_CHANGED, _onSourceOrModelChanged);

        // BUG-084: External mutations to extension_settings + saveSettingsDebounced() are
        // not observed by DLE's cache. Invalidate on every SETTINGS_UPDATED so the next
        // getSettings() call re-validates against the fresh store.
        _registerEs(event_types.SETTINGS_UPDATED, () => {
            try { invalidateSettingsCache(); } catch { /* no-op */ }
        });

        _registerEs(event_types.MESSAGE_EDITED, (messageId) => {
            // Edit preserves structural extras (sources, tool_calls) because the edit
            // is about the visible prose, not what was consulted. Only invalidate the
            // AI Notepad extraction since the visible prose is what it was extracted from.
            try {
                const message = chat?.[messageId];
                if (!message?.extra?.deeplore_ai_notes) return;
                const notes = message.extra.deeplore_ai_notes;
                const acc = chat_metadata?.deeplore_ai_notepad || '';
                if (acc.includes(notes)) {
                    chat_metadata.deeplore_ai_notepad = acc.replace(notes, '').replace(/\n{3,}/g, '\n\n').trim();
                }
                delete message.extra.deeplore_ai_notes;
                saveMetadataDebounced();
            } catch (err) { console.warn('[DLE] MESSAGE_EDITED cleanup failed:', err.message); }
        });

        // Context Cartographer: re-inject buttons on chat load
        _registerEs(event_types.CHAT_CHANGED, () => {
            // Increment epoch first so any in-flight onGenerate sees the mismatch
            setChatEpoch(chatEpoch + 1);

            // Release generation lock so the new chat isn't blocked by a stale in-flight pipeline.
            // Bump the lock epoch to invalidate the old pipeline's commit phase.
            if (generationLock) {
                setGenerationLockEpoch(generationLockEpoch + 1);
                setGenerationLock(false);
            }

            setLastScribeChatLength(chat ? chat.length : 0);
            setLastScribeSummary(chat_metadata?.deeplore_lastScribeSummary || '');
            // BUG-275: Do NOT reset scribeInProgress here. The in-flight scribe owns its
            // own flag and will release it in its own finally (see scribe.js). Resetting
            // here races with scribe A still mid-await and lets scribe B start concurrently
            // on re-entry to chat A → two writeNotes + two reindexes racing.
            // BUG-061: Reset notepad extract lock so new chat's extraction isn't blocked
            // by a stale in-flight extract from the previous chat. The in-flight extract's
            // epoch guard (at the post-await check) will still prevent it from writing to
            // the new chat's metadata.
            setNotepadExtractInProgress(false);
            // Reset per-chat tracking on chat change
            // Note: aiSearchStats is intentionally NOT reset — it tracks session-level cumulative stats
            injectionHistory.clear();
            cooldownTracker.clear();
            decayTracker.clear();
            consecutiveInjections.clear();
            // Hydrate per-chat injection counts from saved metadata (survives page reload)
            // BUG-072: Prune orphaned keys — entries deleted/renamed in the vault would
            // otherwise accumulate unbounded in chat_metadata across the chat's lifetime.
            // Only prune when vaultIndex is populated; during cold start CHAT_CHANGED may
            // fire before the index is built, and pruning against an empty index would wipe
            // all legitimate counts.
            const savedCounts = chat_metadata?.deeplore_chat_counts;
            if (savedCounts && vaultIndex.length > 0) {
                const validKeys = new Set(vaultIndex.map(e => trackerKey(e)));
                const filtered = new Map();
                for (const [k, v] of Object.entries(savedCounts)) {
                    if (validKeys.has(k)) filtered.set(k, v);
                }
                setChatInjectionCounts(filtered);
                // Persist pruned map so orphans don't keep hydrating next reload
                if (filtered.size !== Object.keys(savedCounts).length) {
                    chat_metadata.deeplore_chat_counts = Object.fromEntries(filtered);
                    saveMetadataDebounced();
                }
            } else {
                setChatInjectionCounts(savedCounts ? new Map(Object.entries(savedCounts)) : new Map());
            }

            // BUG-074: Validate deeplore_folder_filter against current folderList.
            // Stale folder names (after a rename/delete in the vault) would otherwise
            // silently filter out every entry. Only prune when folderList is populated;
            // during cold start CHAT_CHANGED may fire before the index is built.
            if (Array.isArray(chat_metadata?.deeplore_folder_filter) && folderList.length > 0) {
                const validFolders = new Set(folderList.map(f => f.path));
                const pruned = chat_metadata.deeplore_folder_filter.filter(f => validFolders.has(f));
                if (pruned.length !== chat_metadata.deeplore_folder_filter.length) {
                    chat_metadata.deeplore_folder_filter = pruned.length > 0 ? pruned : null;
                    saveMetadataDebounced();
                }
            }
            // BUG-293: Hydrate per-swipe injected-keys map from metadata so rollback works
            // across reloads. Shape on disk: { [swipeKey]: string[] of trackerKeys }.
            const savedSwipeKeys = chat_metadata?.deeplore_swipe_injected_keys;
            if (savedSwipeKeys && typeof savedSwipeKeys === 'object') {
                const m = new Map();
                for (const [k, arr] of Object.entries(savedSwipeKeys)) {
                    if (Array.isArray(arr)) m.set(k, new Set(arr));
                }
                setPerSwipeInjectedKeys(m);
            } else {
                setPerSwipeInjectedKeys(new Map());
            }
            setLastGenerationTrackerSnapshot(null);
            setGenerationCount(0);
            setLastIndexGenerationCount(0);
            setLastInjectionEpoch(-1);
            setLastWarningRatio(0);
            setAiSearchCache({ hash: '', manifestHash: '', chatLineCount: 0, results: [] });
            resetAiThrottle();
            setAutoSuggestMessageCount(0);
            setLastPipelineTrace(null);
            setLastInjectionSources(null);
            setPreviousSources(null);
            resetCartographer();

            // Librarian: hydrate gaps from chat_metadata, reset per-gen counter + per-chat stats
            // Run each saved gap through normalizeLoreGap so legacy statuses
            // (acknowledged / in_progress / rejected) collapse to the v2 set (pending ↔ written).
            const savedGaps = chat_metadata?.deeplore_lore_gaps;
            setLoreGaps(savedGaps ? savedGaps.map(normalizeLoreGap) : []);
            setLoreGapSearchCount(0);
            setLibrarianChatStats({ searchCalls: 0, flagCalls: 0, estimatedExtraTokens: 0 });
            clearSessionActivityLog();
            clearPendingToolCalls();

            // Reset drawer ephemeral state (browse filters, context tokens) and refresh
            resetDrawerState();
            notifyPipelineComplete();
            notifyGatingChanged();

            // Re-register PM entries for the new active character (prompt_list mode)
            if (getSettings().injectionMode === 'prompt_list' && promptManager?.activeCharacter) {
                const ids = [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad'];
                const pmNames = { [`${PROMPT_TAG_PREFIX}constants`]: 'DLE Constants', [`${PROMPT_TAG_PREFIX}lore`]: 'DLE Lore Entries', 'deeplore_notebook': 'DLE Author\'s Notebook', 'deeplore_ai_notepad': 'DLE AI Notebook' };
                for (const id of ids) {
                    const existing = promptManager.getPromptById(id);
                    if (!existing) {
                        promptManager.addPrompt({
                            name: pmNames[id] || id, content: '', system_prompt: true,
                            role: 'system', marker: false, enabled: true, extension: true,
                        }, id);
                    } else {
                        if (!existing.role) existing.role = 'system';
                        if (!existing.extension) existing.extension = true;
                        const friendlyName = pmNames[id];
                        if (friendlyName && existing.name !== friendlyName) existing.name = friendlyName;
                    }
                    const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter);
                    if (order && !order.find(e => e.identifier === id)) {
                        const anchorIdx = order.findIndex(e => e.identifier === 'main' || e.identifier === 'chatHistory');
                        if (anchorIdx >= 0) {
                            order.splice(anchorIdx + 1, 0, { identifier: id, enabled: true });
                        } else {
                            order.push({ identifier: id, enabled: true });
                        }
                    }
                }
            }

            // Chat load: migrate stale data, then inject all UI elements.
            // Migration MUST run before Cartographer button injection because old chats may have
            // deeplore_sources stuck on empty intermediate messages (from before the intermediate guard).
            // Similarly, tool_invocations need migrating to deeplore_tool_calls on the correct reply.
            // A single setTimeout + rAF block handles everything in the right order.
            const injectAllChatLoadUI = (attempt = 0) => {
                const chatEl = document.getElementById('chat');
                if (!chatEl?.children.length && attempt < 5) {
                    setTimeout(() => injectAllChatLoadUI(attempt + 1), 200 * (attempt + 1));
                    return;
                }
                requestAnimationFrame(() => { try {
                    const settings = getSettings();
                    const start = Math.max(0, chat.length - 50);
                    let needsSave = false;

                    // ── Migration pass 1: tool_invocations → deeplore_tool_calls ──
                    if (settings.librarianEnabled) {
                        const pendingMigration = [];
                        for (let i = start; i < chat.length; i++) {
                            const m = chat[i];
                            if (m?.extra?.tool_invocations) {
                                for (const inv of m.extra.tool_invocations) {
                                    if (inv.name === 'dle_search_lore' || inv.name === 'dle_flag_lore') {
                                        try {
                                            const params = JSON.parse(inv.parameters || '{}');
                                            const isSearch = inv.name === 'dle_search_lore';
                                            let resultTitles = [];
                                            let resultCount = 0;
                                            if (isSearch && inv.result && !inv.result.startsWith('No entries')) {
                                                const titleMatches = inv.result.match(/^## (.+)$/gm);
                                                resultTitles = titleMatches ? titleMatches.map(t => t.replace('## ', '')) : [];
                                                resultCount = resultTitles.length;
                                            }
                                            pendingMigration.push({
                                                type: isSearch ? 'search' : 'flag',
                                                query: isSearch ? params.query : params.title,
                                                resultCount,
                                                resultTitles,
                                                urgency: params.urgency || 'medium',
                                                tokens: 0,
                                                timestamp: 0,
                                            });
                                        } catch { /* skip malformed */ }
                                    }
                                }
                                continue;
                            }
                            if (pendingMigration.length > 0 && !m.is_user && !m.is_system && m.mes?.trim()) {
                                if (!m.extra?.deeplore_tool_calls?.length) {
                                    m.extra = m.extra || {};
                                    m.extra.deeplore_tool_calls = [...pendingMigration];
                                    needsSave = true;
                                }
                                pendingMigration.length = 0;
                            }
                        }
                    }

                    // ── Migration pass 2: deeplore_sources from empty intermediates → correct reply ──
                    for (let i = start; i < chat.length; i++) {
                        const m = chat[i];
                        if (!m.is_user && !m.is_system && !m.mes?.trim() && m.extra?.deeplore_sources) {
                            for (let j = i + 1; j < chat.length; j++) {
                                const target = chat[j];
                                if (target && !target.is_user && !target.is_system && target.mes?.trim()) {
                                    if (!target.extra?.deeplore_sources) {
                                        target.extra = target.extra || {};
                                        target.extra.deeplore_sources = m.extra.deeplore_sources;
                                    }
                                    break;
                                }
                            }
                            delete m.extra.deeplore_sources;
                            needsSave = true;
                        }
                    }

                    // ── Inject UI: Cartographer source buttons ──
                    if (settings.showLoreSources) {
                        for (let i = start; i < chat.length; i++) {
                            if (chat[i]?.extra?.deeplore_sources) {
                                injectSourcesButton(i);
                            }
                        }
                    }

                    // ── Inject UI: Librarian tool call dropdowns ──
                    if (settings.librarianEnabled && settings.librarianShowToolCalls) {
                        for (let i = start; i < chat.length; i++) {
                            if (chat[i]?.extra?.deeplore_tool_calls?.length) {
                                injectLibrarianDropdown(i, chat[i].extra.deeplore_tool_calls);
                            }
                        }
                    }

                    if (needsSave) saveMetadataDebounced();
                } catch (err) { console.error('[DLE] Chat load UI injection error:', err); }
                });
            };
            setTimeout(injectAllChatLoadUI, 100);
        });

        // BUG-063: Wire page-unload teardown so tracked listeners + drawer DOM
        // are released cleanly on reload. No-op in environments where
        // beforeunload never fires (it always does in browsers).
        _dleBeforeUnloadHandler = () => { try { _teardownDleExtension(); } catch { /* ignore */ } };
        window.addEventListener('beforeunload', _dleBeforeUnloadHandler);

        if (getSettings().debugMode) console.log('[DLE] DeepLore Enhanced client extension initialized');
    } catch (err) {
        console.error('[DLE] Failed to initialize:', err);
    }
});
