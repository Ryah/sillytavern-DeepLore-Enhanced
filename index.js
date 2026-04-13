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
    saveChatDebounced,
    saveChatConditional,
    updateViewMessageIds,
    addOneMessage,
    saveReply,
    name2,
    setSendButtonState,
    activateSendButtons,
    deactivateSendButtons,
    getGeneratingApi,
    getGeneratingModel,
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
import { getSettings, PROMPT_TAG_PREFIX, PROMPT_TAG, invalidateSettingsCache, resolveConnectionConfig, DEFAULT_AI_NOTEPAD_PROMPT } from './settings.js';
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
    aiSearchCache, setAiSearchCache, setAutoSuggestMessageCount, autoSuggestMessageCount, setLastPipelineTrace,
    setScribeInProgress, setPreviousSources,
    notepadExtractInProgress, setNotepadExtractInProgress,
    notifyPipelineComplete, notifyInjectionSourcesReady, notifyGatingChanged,
    fieldDefinitions,
    folderList,
    setLoreGaps, setLoreGapSearchCount, setLibrarianChatStats,
    setGenerationLockTimestamp,
    setPipelinePhase,
    skipNextPipeline, setSkipNextPipeline,
    suppressNextAgenticLoop, setSuppressNextAgenticLoop,
    buildPromise,
} from './src/state.js';
import { DEFAULT_FIELD_DEFINITIONS } from './src/fields.js';
import { buildIndex, ensureIndexFresh, hydrateFromCache, buildIndexWithReuse } from './src/vault/vault.js';
import { resetAiThrottle, callAI } from './src/ai/ai.js';
import { runPipeline } from './src/pipeline/pipeline.js';
import { setupSyncPolling } from './src/vault/sync.js';
import { runScribe } from './src/ai/scribe.js';
import { pushEvent, consoleBuffer, networkBuffer, errorBuffer } from './src/diagnostics/interceptors.js';
import { generationBuffer } from './src/diagnostics/flight-recorder.js';
import { runAutoSuggest, showSuggestionPopup } from './src/ai/auto-suggest.js';
import { injectSourcesButton, showSourcesPopup, resetCartographer } from './src/ui/cartographer.js';
import { loadSettingsUI, bindSettingsEvents } from './src/ui/settings-ui.js';
import { registerSlashCommands } from './src/ui/commands.js';
import { dedupError, dedupWarning } from './src/toast-dedup.js';
import { createDrawerPanel, resetDrawerState, destroyDrawerPanel } from './src/drawer/drawer.js';
import { pushActivity } from './src/drawer/drawer-state.js';
import { extractAiNotes, normalizeLoreGap } from './src/helpers.js';
import { clearSessionActivityLog, persistGaps } from './src/librarian/librarian-tools.js';
import { injectLibrarianDropdown, removeLibrarianDropdown } from './src/librarian/librarian-ui.js';
import { clearSessionState as clearLibrarianSessionState } from './src/librarian/librarian-session.js';
import { runAgenticLoop } from './src/librarian/agentic-loop.js';
import { isToolCallingSupported, getActiveMaxTokens } from './src/librarian/agentic-api.js';
import { buildChatMessages } from './src/librarian/agentic-messages.js';

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

let _dleInitCount = 0;

function _teardownDleExtension() {
    try { pushEvent('teardown', { listenerCount: _dleListeners.eventSource.length }); } catch { /* noop */ }
    // Remove every tracked eventSource listener
    for (const { event, handler } of _dleListeners.eventSource) {
        try { eventSource.removeListener?.(event, handler); } catch { /* ignore */ }
    }
    _dleListeners.eventSource = [];
    // Tear down the drawer (removes its own listeners + DOM)
    try { destroyDrawerPanel(); } catch (err) { console.warn('[DLE] destroyDrawerPanel failed:', err?.message); }
    // BUG-062: detach Cartographer's namespaced delegated handler from #chat
    try { $('#chat').off('.dle-carto'); } catch { /* ignore */ }
    // Remove the beforeunload handler itself so it doesn't accumulate on re-init
    if (_dleBeforeUnloadHandler) {
        try { window.removeEventListener('beforeunload', _dleBeforeUnloadHandler); } catch { /* ignore */ }
        _dleBeforeUnloadHandler = null;
    }
    _dleInitialized = false;
}

// DEFAULT_AI_NOTEPAD_PROMPT moved to settings.js

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

// BUG-AUDIT-H08: Soft cap for deeplore_ai_notepad to prevent unbounded growth.
// Trim oldest block at paragraph boundary when exceeding 64 KB.
const AI_NOTEPAD_MAX_CHARS = 65536;
function capNotepad(text) {
    if (!text || text.length <= AI_NOTEPAD_MAX_CHARS) return text;
    const trimmed = text.slice(text.length - AI_NOTEPAD_MAX_CHARS);
    const boundary = trimmed.indexOf('\n\n');
    return boundary !== -1 ? trimmed.slice(boundary + 2) : trimmed;
}

// ============================================================================
// Pipeline Status Helpers (module scope — used by both onGenerate and init)
// ============================================================================

/** Show a pipeline status toast above the input box ("DeepLore: Choosing Lore…", etc.).
 *  Slides up from behind the send form on first call; subsequent calls swap text in-place. */
function _updatePipelineStatus(text) {
    let el = document.getElementById('dle-pipeline-status');
    if (!el) {
        el = document.createElement('div');
        el.id = 'dle-pipeline-status';
        // Anchor inside #form_sheld — positioned absolutely above the send form
        document.getElementById('form_sheld')?.prepend(el);
    }
    el.classList.remove('dle-toast-out');
    el.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> DeepLore: ${text}`;
}

/** Remove the pipeline status toast with a slide-down animation. */
function _removePipelineStatus() {
    const el = document.getElementById('dle-pipeline-status');
    if (!el) return;
    el.classList.add('dle-toast-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    // Safety: if animationend never fires (e.g. element detached), remove after timeout
    setTimeout(() => el?.remove(), 500);
}

// ============================================================================
// Generation Interceptor
// ============================================================================

/**
 * Called by SillyTavern's generation interceptor system.
 * @param {object[]} chatMessages - Filtered chat messages (coreChat — NOT the global chat array)
 * @param {number} contextSize - Context size
 * @param {function} abort - Abort callback
 * @param {string} type - Generation type
 */
async function onGenerate(chatMessages, contextSize, abort, type) {
    const settings = getSettings();

    if (type === 'quiet' || !settings.enabled) {
        return;
    }

    // Vault review bypass: skip the full pipeline when commanded (e.g. /dle-review)
    if (skipNextPipeline) {
        setSkipNextPipeline(false);
        if (settings.debugMode) console.debug('[DLE] Pipeline skipped (skipNextPipeline flag)');
        return;
    }

    // Skip full pipeline on tool-call continuations (ST re-calls Generate after each tool invocation).
    // ST always pushes a system message with tool_invocations as the very last item in chatMessages[]
    // before re-calling Generate(). A simple last-message check is the correct detection.
    // See gotchas.md #21 for why a backwards walk is wrong here.
    if (chatMessages.length > 0) {
        const lastMsg = chatMessages[chatMessages.length - 1];
        if (lastMsg?.extra?.tool_invocations || lastMsg?.is_system) {
            if (settings.debugMode) console.debug('[DLE] Skipping pipeline for tool-call continuation');
            try { generationBuffer.push({ t: Date.now(), skipped: true, reason: 'tool_call_continuation' }); } catch { /* noop */ }
            return;
        }
    }

    // BUG-058: Strip DLE tool-call messages AFTER the early-return guards but BEFORE the lock
    // check is moved here intentionally — see below. The actual chat splice now lives past the
    // generationLock guard so a contended-pipeline early return doesn't mutate `chat` and leak
    // the change to other ST interceptors.

    // Prevent concurrent onGenerate runs — warn the user instead of silently dropping lore
    if (generationLock) {
        // Auto-recover stale locks after 30 seconds
        const lockAge = Date.now() - generationLockTimestamp;
        if (lockAge > 30_000) {
            console.warn(`[DLE] Previous lore selection took too long (${Math.round(lockAge / 1000)}s) — releasing lock`);
            dedupWarning('Lore from the last message is taking longer than expected — check your AI timeout setting.', 'pipeline_lock_stale', { hint: 'Pipeline lock held past 30s.' });
            // BUG-274: Bump lockEpoch so the stuck pipeline (if it ever unsticks) can't win
            // commit order against this new pipeline. Releasing without the epoch bump would
            // let its late writes pass every `lockEpoch === generationLockEpoch` guard.
            try { generationBuffer.push({ t: Date.now(), forceRelease: true, lockAgeMs: lockAge, oldEpoch: generationLockEpoch, newEpoch: generationLockEpoch + 1 }); } catch { /* noop */ }
            setGenerationLockEpoch(generationLockEpoch + 1);
            setGenerationLock(false);
        } else {
            console.warn('[DLE] Generation lock active — another pipeline is still running. Lore skipped for this generation.');
            dedupWarning('Lore from the last message is still loading — reusing what we had.', 'pipeline_lock');
            try { generationBuffer.push({ t: Date.now(), skipped: true, reason: 'lock_contention', lockAgeMs: lockAge }); } catch { /* noop */ }
            return;
        }
    }
    setGenerationLock(true);
    setPipelinePhase('choosing');
    _updatePipelineStatus('Choosing Lore\u2026');

    // Reset librarian per-generation search counter
    setLoreGapSearchCount(0);

    // Per-message activity: clear gap records at generation start so only the latest
    // generation's gaps survive. New gaps are created by searchLoreAction/flagLoreAction.
    if (settings.librarianPerMessageActivity && settings.librarianEnabled) {
        persistGaps([]);
    }

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
    try { eventSource.on(event_types.GENERATION_STOPPED, onStop); } catch { console.warn('[DLE] Could not register GENERATION_STOPPED abort handler'); }
    try { eventSource.on(event_types.CHAT_CHANGED, onStop); } catch { console.warn('[DLE] Could not register CHAT_CHANGED abort handler'); }

    // Remove pipeline status on first streaming token (one-shot). Torn down in finally.
    const onFirstToken = () => { _removePipelineStatus(); };
    try { eventSource.once(event_types.STREAM_TOKEN_RECEIVED, onFirstToken); } catch { console.warn('[DLE] Could not register STREAM_TOKEN_RECEIVED handler'); }

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

        // Diagnostic breadcrumb: log pipeline entry state for first-gen investigation
        if (settings.debugMode) {
            console.debug('[DLE] Pipeline entry:', {
                generationCount, vaultSize: vaultIndex.length, indexEverLoaded,
                chatMsgCount: chatMessages.length, buildPending: !!buildPromise,
                cacheEmpty: !aiSearchCache.hash, epoch, chatEpoch,
            });
        }

        // BUG-299: CHAT_CHANGED may have fired during the (up to 60s) ensureIndexFresh await.
        // Bail before touching the swipe tracker snapshot so we don't tag a stale snapshot with
        // the new chat's swipe keys or pollute the new chat's cooldown/decay/injection maps.
        if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
            console.debug('[DLE] Chat changed during index refresh — discarding pipeline');
            try { generationBuffer.push({ t: Date.now(), discarded: true, reason: 'chat_changed_during_index' }); } catch { /* noop */ }
            return;
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
            const earlyIdx = chatMessages.length - 1;
            const earlySwipeId = earlyIdx >= 0 ? (chatMessages[earlyIdx]?.swipe_id ?? 0) : 0;
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

        const _pipelineStartMs = performance.now();
        const _pipelineOnStatus = (text) => { _updatePipelineStatus(text); if (text.includes('Consulting')) setPipelinePhase('consulting'); };
        const { finalEntries: pipelineEntries, matchedKeys, trace } = await runPipeline(chatMessages, vaultSnapshot, ctx, { pins, blocks, folderFilter, signal: pipelineAbort.signal, onStatus: _pipelineOnStatus });
        trace.totalMs = Math.round(performance.now() - _pipelineStartMs);
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
            // BUG-278/279: Guard trace publish + activity feed against stale pipelines.
            // Both write to session-global state that the drawer reads; a stale pipeline
            // landing here would overwrite the new chat's trace / push a stale activity row.
            if (epoch === chatEpoch && lockEpoch === generationLockEpoch) {
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
                // BUG-146: Forward allowWIScan + the group's resolved role so per-entry frontmatter
                // `role:` survives instead of being silently coerced to SYSTEM, and so outlet content
                // honors the global "allow WI to scan injected lore" toggle like positional groups do.
                if (group.position === -1) {
                    setExtensionPrompt(group.tag, group.text, -1, 0, settings.allowWIScan, group.role);
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
            // Notify drawer early so Why? tab populates before agentic loop / ST generation
            notifyInjectionSourcesReady();
        } else {
            // No lore groups — still clear stale prompts from previous generation
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            if (settings.injectionMode === 'prompt_list' && promptManager) {
                for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad']) {
                    const pmEntry = promptManager.getPromptById(id);
                    if (pmEntry) pmEntry.content = '';
                }
            }
            // Clear stale sources so Why? tab doesn't show previous generation's data
            setLastInjectionSources(null);
            setLastInjectionEpoch(epoch);
            notifyInjectionSourcesReady();
        }

        // BUG-147: Single fallback ladder for the four PM-or-extension_prompts inject paths
        // (notebook, notepad, plus the lore/constants pair handled above). Previously each
        // call site duplicated a 4-line "is prompt_list? → PM entry; else setExtensionPrompt"
        // ladder, which drifted (different fallback args, missing allowWIScan, etc.).
        const _injectAuxPrompt = (id, content, position, depth, role, allowWIScan = false) => {
            const usePromptList = settings.injectionMode === 'prompt_list';
            if (usePromptList && promptManager) {
                const pmEntry = promptManager.getPromptById(id);
                if (pmEntry) {
                    pmEntry.content = content;
                    return;
                }
                // Fallback: PM entry not registered for this id — use extension_prompts.
            }
            setExtensionPrompt(id, content, position, depth, allowWIScan, role);
        };

        // Author's Notebook injection (independent of entry pipeline)
        if (settings.notebookEnabled && chat_metadata?.deeplore_notebook?.trim()) {
            const notebookContent = chat_metadata.deeplore_notebook.trim();
            _injectAuxPrompt(
                'deeplore_notebook',
                notebookContent,
                settings.notebookPosition,
                settings.notebookDepth,
                settings.notebookRole,
            );
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
                // BUG-147: Routed through the shared ladder helper.
                _injectAuxPrompt(
                    'deeplore_ai_notepad',
                    notepadContent,
                    settings.aiNotepadPosition,
                    settings.aiNotepadDepth,
                    settings.aiNotepadRole,
                );
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
            const lastIdx = chatMessages.length - 1;
            const swipeId = lastIdx >= 0 ? (chatMessages[lastIdx]?.swipe_id ?? 0) : 0;
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
            const keepFromIdx = Math.max(0, chatMessages.length - 10);
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
                        `Your lore uses ${pct}% of your context window (~${totalTokens} tokens, ${injectedCount} entries). You can set a token budget in Settings to manage this.`,
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

        // Pipeline complete — show "Generating..." until first streaming token arrives.
        setPipelinePhase('generating');
        _updatePipelineStatus('Generating\u2026');

        // === Agentic Loop Dispatch ===
        // When Librarian is enabled and the active API supports tool calling, DLE runs its
        // own agentic loop instead of letting ST generate. This produces a single clean message
        // with no intermediate tool_invocation system messages.
        // Agentic loop produces complete responses — fall through to ST for continue/append.
        // One-shot suppression: reset flag regardless of whether we enter the agentic branch
        if (suppressNextAgenticLoop) {
            setSuppressNextAgenticLoop(false);
            if (settings.debugMode) console.debug('[DLE] Agentic loop suppressed for this generation (one-shot)');
        } else if (settings.librarianEnabled && isToolCallingSupported()
            && type !== 'continue' && type !== 'append' && type !== 'appendFinal') {
            abort(); // Prevent ST from generating

            // C1: Re-entrancy guard — abort() re-enables send via unblockGeneration(), lock it again
            setSendButtonState(true);
            deactivateSendButtons();

            // C6: Reset search counter for this generation (searchLoreAction reads it internally)
            setLoreGapSearchCount(0);

            // H6: Clear extension prompts — lore is embedded in the agentic system prompt,
            // so extension_prompts would duplicate it when CMRS.sendRequest builds the payload.
            clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
            if (settings.injectionMode === 'prompt_list' && promptManager) {
                for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`]) {
                    const pmEntry = promptManager.getPromptById(id);
                    if (pmEntry) pmEntry.content = '';
                }
            }
            // Also clear aux prompts (notebook, notepad) — they're in the agentic system prompt too
            for (const auxId of ['deeplore_notebook', 'deeplore_ai_notepad']) {
                if (extension_prompts[auxId]) delete extension_prompts[auxId];
                if (promptManager) {
                    const pmEntry = promptManager.getPromptById(auxId);
                    if (pmEntry) pmEntry.content = '';
                }
            }

            // H7: Declared outside try so catch can access it for save-on-error
            let proseMsg = null;

            try {
                const pipelineContext = groups.map(g => g.text).join('\n\n');
                const injTitles = new Set((acceptedEntries || []).map(e => (e.title || '').toLowerCase()));

                const agenticMessages = buildChatMessages(chatMessages, pipelineContext, injTitles, settings);

                const onProse = async (proseText) => {
                    if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) return;

                    // saveReply operates on the global chat[] (not the shadowed chatMessages
                    // parameter). It handles: message creation, chat.push, swipe_info setup,
                    // MESSAGE_RECEIVED (awaited), addOneMessage, CHARACTER_MESSAGE_RENDERED (awaited).
                    //
                    // The CHARACTER_MESSAGE_RENDERED handler (L1315) will:
                    //   - Attach deeplore_sources from lastInjectionSources
                    //   - Inject sources button
                    //   - Extract AI notes (modifies message.mes → cleaned text)
                    //
                    // After saveReply, swipes[0] = cleaned mes (AI notes stripped),
                    // swipe_info[0].extra contains deeplore_sources + deeplore_ai_notes.
                    await saveReply({ type, getMessage: proseText });

                    // Capture reference for later tool_calls attachment (post-loop)
                    proseMsg = chat[chat.length - 1];

                    _removePipelineStatus();
                    updateViewMessageIds();

                    // saveReply does NOT save to disk — ST's Generate() normally does that,
                    // but we called abort() so Generate returns without saving. Save immediately.
                    await saveChatConditional();
                };

                setPipelinePhase('writing');
                _updatePipelineStatus('Writing\u2026');
                const onAgenticStatus = (text) => {
                    _updatePipelineStatus(text);
                    // Update drawer phase from agentic loop status text
                    if (text.startsWith('Searching')) setPipelinePhase('searching');
                    else if (text.startsWith('Writing') || text.startsWith('Generating')) setPipelinePhase('writing');
                };
                const result = await runAgenticLoop({
                    messages: agenticMessages,
                    maxSearches: settings.librarianMaxSearches || 2,
                    searchEnabled: settings.librarianSearchEnabled !== false,
                    flagEnabled: settings.librarianFlagEnabled !== false,
                    maxTokens: getActiveMaxTokens(),
                    signal: pipelineAbort.signal,
                    epoch,
                    lockEpoch,
                    onStatus: onAgenticStatus,
                    onProse,
                    injectedTitles: injTitles,
                    settings,
                });

                // Stale check after the loop completes
                if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) return;

                if (proseMsg) {
                    // Attach tool activity to the already-displayed message.
                    // Lifecycle events already fired in onProse — just attach data and re-save.
                    proseMsg.extra.deeplore_tool_calls = result.toolActivity;
                    await saveChatConditional();

                    if (settings.librarianShowToolCalls && result.toolActivity.length > 0) {
                        injectLibrarianDropdown(chat.length - 1, result.toolActivity);
                    }
                } else if (result.prose) {
                    // Fallback: onProse never fired (text-only response without write() tool call).
                    // Use saveReply for proper message lifecycle (global chat, events, swipe_info).
                    await saveReply({ type, getMessage: result.prose });
                    const msg = chat[chat.length - 1];
                    msg.extra.deeplore_tool_calls = result.toolActivity;
                    updateViewMessageIds();
                    await saveChatConditional();

                    if (settings.librarianShowToolCalls && result.toolActivity.length > 0) {
                        injectLibrarianDropdown(chat.length - 1, result.toolActivity);
                    }
                } else {
                    dedupError('AI did not produce a response. Try again.', 'agentic_no_prose');
                }
            } catch (err) {
                if (err?.name !== 'AbortError' && !pipelineAbort.signal.aborted) {
                    console.error('[DLE] Agentic loop error:', err);
                    // If prose was already shown, the error is from FLAG phase — save what we have
                    if (proseMsg) {
                        await saveChatConditional();
                    } else {
                        dedupError('Generation failed \u2014 try again or disable Librarian.', 'agentic_error');
                    }
                }
            } finally {
                // C1: Re-enable sends
                setSendButtonState(false);
                activateSendButtons();
                _removePipelineStatus();
                // Wrap in try/catch — errors here must not propagate to the outer catch
                // (which would show a misleading "Couldn't load your lore" toast)
                try { await eventSource.emit(event_types.GENERATION_ENDED, chat.length); } catch { /* noop */ }
            }
            return; // Don't fall through to ST's generation
        }
        // === End Agentic Loop Dispatch ===

        // Warn if Librarian is on but tools aren't supported (silent fallback to normal generation)
        if (settings.librarianEnabled && !isToolCallingSupported() && !suppressNextAgenticLoop) {
            dedupWarning('Librarian is on but your connection doesn\'t support function calling — falling back to normal generation. Check DLE Settings → Connection.', 'librarian_no_tools');
        }

    } catch (err) {
        _removePipelineStatus();
        // BUG-233: User aborts are not errors — no toast, no log spam.
        if (err?.userAborted || err?.name === 'AbortError' || pipelineAbort.signal.aborted) {
            if (settings.debugMode) console.debug('[DLE] Pipeline aborted:', err?.message || 'user stop');
            // Record abort in flight recorder for diagnostic export
            try { const { recordAbort } = await import('./src/diagnostics/flight-recorder.js'); recordAbort(err?.message || 'user stop'); } catch { /* noop */ }
        } else {
            console.error('[DLE] Error during generation:', err);
            dedupError('Couldn\'t load your lore. Try /dle-refresh, or /dle-health for diagnostics.', 'pipeline', { hint: classifyError(err) });
        }
    } finally {
        // BUG-233: Always tear down the abort listeners to avoid accumulation across generations.
        try { eventSource.removeListener(event_types.GENERATION_STOPPED, onStop); } catch { /* noop */ }
        try { eventSource.removeListener(event_types.CHAT_CHANGED, onStop); } catch { /* noop */ }
        try { eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, onFirstToken); } catch { /* noop */ }
        // BUG-FIX-4/12: Always remove pipeline status on exit — covers all early return paths.
        _removePipelineStatus();
        // Generation tracking must always run when the pipeline was entered,
        // even if no entries matched — otherwise cooldown timers freeze permanently.
        // Wrapped in try/catch to prevent tracking errors from blocking ST generation.
        try {
            if (pipelineRan && epoch === chatEpoch && lockEpoch === generationLockEpoch) {
                setGenerationCount(generationCount + 1);
                decrementTrackers(cooldownTracker, decayTracker, injectedEntries, settings, consecutiveInjections);
            } else if (pipelineRan) {
                // Stale pipeline — tracking skipped, cooldowns will freeze
                console.debug('[DLE] Stale pipeline — generation tracking skipped');
                try { generationBuffer.push({ t: Date.now(), discarded: true, reason: 'stale_pipeline_tracking_skipped' }); } catch { /* noop */ }
            }
        } catch (trackingErr) {
            console.error('[DLE] Error in generation tracking:', trackingErr);
        }
        // Release lock and phase FIRST so pipeline-complete renders see correct state.
        // A force-released stale pipeline must NOT release the newer pipeline's lock.
        if (lockEpoch === generationLockEpoch) {
            setPipelinePhase('idle');
            setGenerationLock(false);
        } else {
            console.warn('[DLE] Stale pipeline did not release lock (epoch mismatch)');
            try { generationBuffer.push({ t: Date.now(), lockReleaseBlocked: true, reason: 'epoch_mismatch', staleEpoch: lockEpoch, currentEpoch: generationLockEpoch }); } catch { /* noop */ }
        }
        // BUG-277: Only notify drawer if WE are still the active pipeline. A stale
        // force-released pipeline finishing here must not fire complete-notifications
        // at the new chat's drawer — which is now rendering a different generation.
        if (lockEpoch === generationLockEpoch && epoch === chatEpoch) {
            notifyPipelineComplete();
        }
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
        // BUG-125: Also check localStorage sentinel in case settings save crashed
        const wizardCompleted = firstRunSettings._wizardCompleted || (typeof localStorage !== 'undefined' && localStorage.getItem('dle-wizard-completed') === '1');
        if (!hasEnabledVaults && !wizardCompleted) {
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
            // BUG-118: this once-registration sits after several awaits in init(); on a fast
            // machine APP_READY may have already fired and our `once` listener will never run.
            // Fire-once latch + fallback timer covers both ordering cases without double-launching.
            let _wizardLatched = false;
            const _wizardOnce = () => { if (_wizardLatched) return; _wizardLatched = true; setTimeout(launchWizard, 500); };
            _registerEs(event_types.APP_READY, _wizardOnce, { once: true });
            setTimeout(_wizardOnce, 3000);
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
            // BUG-118: same fast-machine race as the wizard registration above. Latch + fallback.
            let _autoConnectLatched = false;
            const _autoConnectOnce = async () => {
                if (_autoConnectLatched) return; _autoConnectLatched = true;
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
            };
            _registerEs(event_types.APP_READY, _autoConnectOnce, { once: true });
            setTimeout(_autoConnectOnce, 3000);
        }

        // BUG-062: Context Cartographer click/keydown delegation. Namespaced as `.dle-carto`
        // so _teardownDleExtension can detach via $('#chat').off('.dle-carto'). Without the
        // namespace, extension reload double-bound the handler and toggling showLoreSources
        // off had no detach path.
        $('#chat').off('.dle-carto');
        $('#chat').on('click.dle-carto keydown.dle-carto', '.mes_deeplore_sources', function (e) {
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
        // BUG-242: defensive top-level GENERATION_STOPPED listener. Per-onGenerate invocations
        // already install their own onStop (see runInjection ~L231), but this catches edge cases
        // where an await resolves between the pipeline's abort check and its commit phase — the
        // epoch bump invalidates any late writes the in-flight pipeline is about to do. Safe even
        // when no pipeline is running; cheap no-op.
        _registerEs(event_types.GENERATION_STOPPED, () => {
            try {
                _removePipelineStatus();
                setGenerationLockEpoch(generationLockEpoch + 1);
                if (generationLock) setGenerationLock(false);
                // BUG-FIX-6: Clear stale prompts so they don't bleed into the next generation.
                clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);
                const _settings = getSettings();
                if (_settings.injectionMode === 'prompt_list' && promptManager) {
                    for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook', 'deeplore_ai_notepad']) {
                        const pmEntry = promptManager.getPromptById(id);
                        if (pmEntry) pmEntry.content = '';
                    }
                }
            } catch (err) { console.warn('[DLE] GENERATION_STOPPED cleanup failed:', err?.message); }
        });

        _registerEs(event_types.GENERATION_ENDED, () => {
            const settings = getSettings();
            if (!settings.aiNotepadEnabled) return;
            const mode = settings.aiNotepadMode || 'tag';
            const lastMessage = chat[chat.length - 1];
            if (!lastMessage || lastMessage.is_user || !lastMessage.mes) return;

            if (mode === 'tag') {
                // Tag mode: extract <dle-notes> blocks
                // BUG-AUDIT-C01: Capture epoch before any writes — fast chat switch between
                // extractAiNotes() and the metadata write can land notes in the wrong chat.
                const tagEpoch = chatEpoch;
                const { notes, cleanedMessage } = extractAiNotes(lastMessage.mes);
                if (notes && tagEpoch === chatEpoch) {
                    lastMessage.mes = cleanedMessage;
                    lastMessage.extra = lastMessage.extra || {};
                    lastMessage.extra.deeplore_ai_notes = notes;
                    const existing = chat_metadata.deeplore_ai_notepad || '';
                    chat_metadata.deeplore_ai_notepad = capNotepad((existing + '\n' + notes).trim());
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
                // BUG-AUDIT-C04: Set flag INSIDE the try block so any sync throw
                // (e.g. resolveConnectionConfig) doesn't leak the flag forever.
                if (notepadExtractInProgress) return;
                const extractEpoch = chatEpoch;
                const msgIndex = chat.length - 1;
                const swipeIdAtStart = lastMessage.swipe_id;
                (async () => {
                    setNotepadExtractInProgress(true);
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
                        // BUG-AUDIT-CNEW01: Bail if message was swiped/deleted during extraction
                        const currentMsg = chat[msgIndex];
                        if (!currentMsg || currentMsg.swipe_id !== swipeIdAtStart) return;
                        if (responseText && responseText !== 'NOTHING_TO_NOTE') {
                            currentMsg.extra = currentMsg.extra || {};
                            currentMsg.extra.deeplore_ai_notes = responseText;
                            const existing = chat_metadata.deeplore_ai_notepad || '';
                            chat_metadata.deeplore_ai_notepad = capNotepad((existing + '\n' + responseText).trim());
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

        // NOTE: _updatePipelineStatus and _removePipelineStatus are at module scope
        // (above onGenerate) so both onGenerate and init-block handlers can access them.

        // Context Cartographer + Session Scribe: post-render handler
        _registerEs(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
            const settings = getSettings();
            const message = chat[messageId];

            // BUG-142: Each job is wrapped in try-catch so one failure doesn't abort the rest.

            // --- Context Cartographer: store sources and inject button ---
            try {
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
            } catch (err) { console.warn('[DLE] Cartographer render-handler failed:', err?.message); }

            // --- AI Notebook: fallback extraction (if GENERATION_ENDED missed it, e.g. swipe) ---
            try {
                if (settings.aiNotepadEnabled) {
                    // BUG-AUDIT-C02: Capture epoch before extraction — CHAT_CHANGED can race
                    // between extractAiNotes and the metadata append, writing to the wrong chat.
                    const renderEpoch = chatEpoch;
                    if (message && !message.is_user && message.mes) {
                        const { notes, cleanedMessage } = extractAiNotes(message.mes);
                        if (notes && renderEpoch === chatEpoch) {
                            message.mes = cleanedMessage;
                            message.extra = message.extra || {};
                            if (!message.extra.deeplore_ai_notes) {
                                message.extra.deeplore_ai_notes = notes;
                                const existing = chat_metadata.deeplore_ai_notepad || '';
                                chat_metadata.deeplore_ai_notepad = capNotepad((existing + '\n' + notes).trim());
                            }
                            saveMetadataDebounced();
                            const mesBlock = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
                            if (mesBlock) mesBlock.innerHTML = messageFormatting(cleanedMessage, message.name, message.is_system, message.is_user, messageId);
                        }
                    }
                }
            } catch (err) { console.warn('[DLE] AI Notebook render-handler failed:', err?.message); }


            // --- Session Scribe: track chat position and auto-trigger ---
            try {
                if (settings.enabled && settings.scribeEnabled && settings.scribeInterval > 0) {
                    const newMessages = chat.length - lastScribeChatLength;
                    if (newMessages >= settings.scribeInterval && !scribeInProgress) {
                        runScribe().catch(err => console.warn('[DLE] Scribe auto-trigger failed:', err?.message)); // fire-and-forget
                    }
                }
            } catch (err) { console.warn('[DLE] Scribe render-handler failed:', err?.message); }

            // --- Auto Lorebook: increment counter and auto-trigger every N messages ---
            try {
                if (settings.enabled && settings.autoSuggestEnabled && settings.autoSuggestInterval > 0) {
                    setAutoSuggestMessageCount(autoSuggestMessageCount + 1);
                    if (autoSuggestMessageCount >= settings.autoSuggestInterval) {
                        setAutoSuggestMessageCount(0);
                        (async () => {
                            try {
                                const suggestions = await runAutoSuggest();
                                if (suggestions && suggestions.length > 0) await showSuggestionPopup(suggestions);
                            } catch (err) { console.warn('[DLE] Auto-suggest auto-trigger failed:', err?.message); }
                        })();
                    }
                }
            } catch (err) { console.warn('[DLE] Auto-suggest render-handler failed:', err?.message); }
        });

        // Swipe handler: clear stale tool call data and sources from the swiped message
        _registerEs(event_types.MESSAGE_SWIPED, (messageId) => {
            // BUG-296: bounds check — ST can fire MESSAGE_SWIPED with a stale index after a
            // delete that coincided with a swipe navigation. Don't trust the index blindly.
            const idx = Number(messageId);
            if (!Number.isInteger(idx) || idx < 0 || idx >= (chat?.length || 0)) return;
            const message = chat[idx];
            if (!message || message.is_user) return;

            // BUG-FIX-2: Clean up any stale pipeline status on swipe.
            _removePipelineStatus();

            // Clear tool call dropdown data and DOM.
            // When perMessageActivity is enabled, keep dropdown data on swipe — it will be
            // replaced when a new generation runs. Only clear the pending buffer.
            if (!getSettings().librarianPerMessageActivity) {
                if (message.extra?.deeplore_tool_calls) {
                    delete message.extra.deeplore_tool_calls;
                    saveMetadataDebounced();
                }
            }
            // Always remove dropdown DOM on swipe — new swipe may not have tool calls.
            // Data is preserved when perMessageActivity is on (will be replaced on next gen).
            removeLibrarianDropdown(messageId);

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

            // BUG-294/300: rebuild chatInjectionCounts from the authoritative per-swipe map.
            // The prior swipe's injected keys are still tracked in perSwipeInjectedKeys; swiping
            // to a new (possibly un-generated) alternate must not leave those counts elevated.
            // Summing across each message slot's CURRENT swipe_id yields the correct live state
            // regardless of swipe direction, regen, or interleaving with in-flight pipelines.
            try {
                const rebuilt = new Map();
                for (let i = 0; i < chat.length; i++) {
                    const m = chat[i];
                    if (!m || m.is_user) continue;
                    const sKey = `${i}|${m.swipe_id ?? 0}`;
                    const keys = perSwipeInjectedKeys.get(sKey);
                    if (keys) {
                        for (const k of keys) rebuilt.set(k, (rebuilt.get(k) || 0) + 1);
                    }
                }
                setChatInjectionCounts(rebuilt);
                chat_metadata.deeplore_chat_counts = Object.fromEntries(rebuilt);
                saveMetadataDebounced();
            } catch (err) { console.warn('[DLE] MESSAGE_SWIPED count rebuild failed:', err?.message); }
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
                        `A connection profile used by ${cleared} DLE feature${cleared === 1 ? '' : 's'} was deleted. Re-bind in DLE settings.`,
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
                // BUG-AUDIT-H07: Use last-occurrence removal (same as MESSAGE_SWIPED BUG-290)
                // to avoid removing an earlier message's identical note instead of this one.
                const notes = message.extra.deeplore_ai_notes;
                const acc = chat_metadata?.deeplore_ai_notepad || '';
                if (acc.includes(notes)) {
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
                }
                delete message.extra.deeplore_ai_notes;
                saveMetadataDebounced();
            } catch (err) { console.warn('[DLE] MESSAGE_EDITED cleanup failed:', err.message); }
        });

        // Context Cartographer: re-inject buttons on chat load
        _registerEs(event_types.CHAT_CHANGED, () => {
            // Increment epoch first so any in-flight onGenerate sees the mismatch
            setChatEpoch(chatEpoch + 1);
            // Diagnostic breadcrumbs: mark chat boundary in ring buffers so exports are parseable
            pushEvent('chat_changed', { chatEpoch: chatEpoch });
            try {
                consoleBuffer.push({ t: Date.now(), level: 'info', msg: `--- CHAT_CHANGED (epoch ${chatEpoch}) ---`, dle: true });
                networkBuffer.push({ t: Date.now(), kind: 'marker', url: 'CHAT_CHANGED', chatEpoch: chatEpoch });
            } catch { /* never block chat switch */ }
            _removePipelineStatus();

            // Release generation lock so the new chat isn't blocked by a stale in-flight pipeline.
            // Bump the lock epoch to invalidate the old pipeline's commit phase.
            if (generationLock) {
                setGenerationLockEpoch(generationLockEpoch + 1);
                setPipelinePhase('idle');
                setGenerationLock(false);
            }

            // BUG-308: hydrate from chat_metadata if present so the "already scribed at N"
            // guard survives chat switches. Fall back to current chat length on first visit.
            {
                const persistedLen = chat_metadata?.deeplore_lastScribeChatLength;
                setLastScribeChatLength(
                    Number.isFinite(persistedLen) ? persistedLen : (chat ? chat.length : 0),
                );
            }
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
            // BUG-287: Tag the retry chain with the current chatEpoch so a second
            // CHAT_CHANGED (e.g. rapid chat switching) cancels a pending retry from
            // the previous chat instead of injecting UI into the wrong messages.
            const injectEpoch = chatEpoch;
            const injectAllChatLoadUI = (attempt = 0) => {
                if (injectEpoch !== chatEpoch) return;
                const chatEl = document.getElementById('chat');
                if (!chatEl?.children.length && attempt < 5) {
                    setTimeout(() => injectAllChatLoadUI(attempt + 1), 200 * (attempt + 1));
                    return;
                }
                requestAnimationFrame(() => { if (injectEpoch !== chatEpoch) return; try {
                    const settings = getSettings();
                    const start = Math.max(0, chat.length - 50);
                    let needsSave = false;

                    // BUG-126: Skip migration passes if already completed for this chat
                    const migrationDone = chat_metadata?.deeplore_migration_v2;

                    // ── Migration pass 1: tool_invocations → deeplore_tool_calls ──
                    if (settings.librarianEnabled && !migrationDone) {
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
                    // BUG-126: Skip if migration already done for this chat
                    for (let i = migrationDone ? chat.length : start; i < chat.length; i++) {
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

                    // BUG-126: Mark migration complete so it doesn't re-scan on next CHAT_CHANGED
                    if (needsSave && !migrationDone) {
                        chat_metadata.deeplore_migration_v2 = true;
                    }
                    if (needsSave) saveMetadataDebounced();
                } catch (err) { console.error('[DLE] Chat load UI injection error:', err); }
                });
            };
            setTimeout(() => { if (injectEpoch === chatEpoch) injectAllChatLoadUI(); }, 100);
        });

        // BUG-063: Wire page-unload teardown so tracked listeners + drawer DOM
        // are released cleanly on reload. No-op in environments where
        // beforeunload never fires (it always does in browsers).
        _dleBeforeUnloadHandler = () => { try { _teardownDleExtension(); } catch { /* ignore */ } };
        window.addEventListener('beforeunload', _dleBeforeUnloadHandler);

        _dleInitCount++;
        pushEvent('init', { initCount: _dleInitCount, vaultCount: (getSettings().vaults || []).filter(v => v.enabled).length });
        console.log('[DLE] DeepLore Enhanced client extension initialized');
    } catch (err) {
        console.error('[DLE] Failed to initialize:', err);
    }
});
