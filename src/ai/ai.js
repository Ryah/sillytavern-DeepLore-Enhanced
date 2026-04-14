/**
 * DeepLore Enhanced — AI Search module
 * aiSearch, callViaProfile, extractAiResponseClient, buildCandidateManifest,
 * hierarchicalPreFilter, getProfileModelHint
 */
import { ConnectionManagerRequestService } from '../../../../shared.js';
import { truncateToSentence, simpleHash, buildAiChatContext, escapeXml } from '../../core/utils.js';
import { getSettings, DEFAULT_AI_SYSTEM_PROMPT } from '../../settings.js';
import { callProxyViaCorsBridge } from './proxy-api.js';
import {
    vaultIndex, aiSearchCache, aiSearchStats, decayTracker, lastScribeSummary,
    trackerKey, setAiSearchCache, entityNameSet, entityShortNameRegexes, consecutiveInjections,
    entityRegexVersion, generationCount,
    notifyAiStatsUpdated,
    isAiCircuitOpen, tryAcquireHalfOpenProbe, recordAiSuccess, recordAiFailure, releaseHalfOpenProbe,
    fieldDefinitions,
} from '../state.js';
import { dedupWarning, dedupError } from '../toast-dedup.js';
import { aiCallBuffer } from '../diagnostics/interceptors.js';
// Re-export pure functions from helpers.js for consumers that import from ai.js
import { extractAiResponseClient, clusterEntries, buildCategoryManifest, normalizeResults, isForceInjected, fuzzyTitleMatch, LOREBOOK_INFRA_TAGS } from '../helpers.js';
// buildCandidateManifest extracted to manifest.js for testability
import { buildCandidateManifest as _buildCandidateManifest } from './manifest.js';

// ── AI call throttle ──
// Minimum 2 seconds between actual AI API calls to prevent rapid-generation spam.
// Cache hits and circuit breaker skips are not throttled (they don't make API calls).
let _lastAiCallTimestamp = 0;
const AI_CALL_MIN_INTERVAL_MS = 500;
const AI_PREFILTER_MAX_TOKENS = 512;

/** Reset AI call throttle — call on chat change to avoid cross-chat penalty. */
export function resetAiThrottle() { _lastAiCallTimestamp = 0; }

/**
 * Get the model name from the selected Connection Manager profile.
 * @returns {string} Model name or empty string
 */
export function getProfileModelHint() {
    const settings = getSettings();
    if (!settings.aiSearchProfileId) return '';
    try {
        const profile = ConnectionManagerRequestService.getProfile(settings.aiSearchProfileId);
        return profile.model || '';
    } catch (err) {
        if (settings.debugMode) console.debug('[DLE] Could not read profile model hint:', err.message);
        return '';
    }
}

/**
 * Make an API call via a SillyTavern Connection Manager profile.
 * Used by both AI Search and Session Scribe.
 * @param {string} systemPrompt - System prompt text
 * @param {string} userMessage - User message content
 * @param {number} maxTokens - Max tokens for response
 * @param {number} timeout - Timeout in milliseconds
 * @param {string} [profileId] - Profile ID (defaults to aiSearchProfileId)
 * @param {string} [modelOverride] - Model override (defaults to aiSearchModel)
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>}
 */
export async function callViaProfile(systemPrompt, userMessage, maxTokens, timeout, profileId, modelOverride, externalSignal) {
    const settings = getSettings();
    const resolvedProfileId = profileId || settings.aiSearchProfileId;
    const resolvedModel = modelOverride !== undefined ? modelOverride : settings.aiSearchModel;
    if (!resolvedProfileId) throw new Error('No connection profile selected.');

    // Validate profile exists before making the API call
    try {
        const profile = ConnectionManagerRequestService.getProfile(resolvedProfileId);
        if (!profile) throw new Error(`Connection profile not found. Select one in AI Search settings, or create one in SillyTavern's Connection Manager.`);
    } catch (e) {
        if (e.message.includes('not found') || e.message.includes('Connection Manager')) throw e;
        throw new Error(`Connection profile not found or invalid. Select one in AI Search settings, or create one in SillyTavern's Connection Manager.`);
    }

    // Pre-flight: detect Claude adaptive-thinking misconfiguration. We do NOT
    // toast here — the persistent surfaces (drawer chip + settings banner)
    // handle visibility, and the catch block below rewrites the actual 400
    // error message into something actionable. callViaProfile is only invoked
    // when the feature is in `profile` mode, so the proxy false-positive case
    // can't reach this code path.
    let claudeAdaptiveDetail = null;
    try {
        const { detectClaudeAdaptiveIssue, claimClaudeAdaptiveToastSlot, buildClaudeAdaptiveMessage } = await import('./claude-adaptive-check.js');
        const detail = detectClaudeAdaptiveIssue(resolvedProfileId, resolvedModel);
        if (detail.bad) {
            claudeAdaptiveDetail = detail;
            const { setClaudeAutoEffortState } = await import('../state.js');
            setClaudeAutoEffortState(true, detail);
            // One-shot heads-up toast per (profile,model,preset) per session.
            // After the first time, the chip + banner are the signal.
            if (claimClaudeAdaptiveToastSlot(detail)) {
                dedupWarning(buildClaudeAdaptiveMessage(detail, 'toast'), 'claude_auto_effort', { timeOut: 12000 });
            }
        }
    } catch (_) { /* detection must never block the call */ }

    // Some providers (e.g. Anthropic) require system prompt separately, not as a message.
    // ConnectionManagerRequestService handles this via the options parameter.
    // When aiForceUserRole is enabled, merge system prompt into user message for providers
    // that can't handle the system role at all (e.g. some Z.AI GLM versions).
    const messages = settings.aiForceUserRole
        ? [{ role: 'user', content: `[Instructions]\n${systemPrompt}\n\n---\n\n${userMessage}` }]
        : [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let onExternalAbort = null;
    // Wire external signal (user cancellation) to abort the internal controller
    if (externalSignal) {
        if (externalSignal.aborted) { clearTimeout(timer); const err = new Error('Request aborted'); err.name = 'AbortError'; throw err; }
        onExternalAbort = () => controller.abort();
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let backupTimer;
    let settled = false;
    try {
        // BUG-028: Use Promise.race to enforce timeout even if CMRS ignores AbortSignal
        const timeoutPromise = new Promise((_, reject) => {
            backupTimer = setTimeout(() => {
                if (!settled) reject(Object.assign(new Error(`Request timed out (${Math.round(timeout / 1000)}s)`), { name: 'AbortError' }));
            }, timeout + 500);
        });
        const result = await Promise.race([
            ConnectionManagerRequestService.sendRequest(
                resolvedProfileId,
                messages,
                maxTokens,
                {
                    stream: false,
                    signal: controller.signal,
                    extractData: true,
                    includePreset: false,
                    includeInstruct: false,
                },
                // Override model if user specified one
                resolvedModel ? { model: resolvedModel } : {},
            ),
            timeoutPromise,
        ]);
        settled = true;

        return {
            text: result.content || '',
            usage: {
                input_tokens: result.usage?.input_tokens || result.usage?.prompt_tokens || 0,
                output_tokens: result.usage?.output_tokens || result.usage?.completion_tokens || 0,
            },
        };
    } catch (err) {
        // Enhance error with profile context for diagnosability
        const profileLabel = resolvedProfileId ? ` [profile: ${resolvedProfileId}]` : '';
        const modelLabel = resolvedModel ? ` [model: ${resolvedModel}]` : '';
        // BUG-234/251/252: Distinguish user-abort from timeout. Preserve err.name='AbortError'
        // on both so downstream checks work without regex fallback. Only rewrite message as
        // "Request timed out" when the cause was actually our timeout timer, not a user Stop.
        if (err.name === 'AbortError') {
            if (externalSignal?.aborted) {
                const abortErr = new Error(`Request aborted by user${profileLabel}${modelLabel}`);
                abortErr.name = 'AbortError';
                abortErr.userAborted = true;
                throw abortErr;
            }
            const timeoutErr = new Error(`Request timed out (${Math.round(timeout / 1000)}s)${profileLabel}${modelLabel}`);
            timeoutErr.name = 'AbortError';
            timeoutErr.timedOut = true;
            throw timeoutErr;
        }
        // Detect role-related failures and surface targeted guidance
        const msg = (err.message || '').toLowerCase();
        if (/incorrect.?role|invalid.?role|system.*not.?supported|unsupported.*role|role.*not.?allow/i.test(msg)) {
            console.warn('[DLE] Role-related API error detected:', err.message);
            dedupWarning(
                'AI search couldn\'t talk to your provider. Try switching Prompt Post-Processing to Semi or Strict in your Connection profile.',
                'callViaProfile_role_error',
                { timeOut: 10000 },
            );
        }
        // Claude adaptive-thinking error rewrite — only if pre-flight flagged it AND
        // the error looks like the 400/top_k/thinking signature.
        if (claudeAdaptiveDetail && /400|bad request|top_k|thinking|reasoning_effort/i.test(err.message || '')) {
            // BUG-069: Import wrapped separately so a module-load failure doesn't mask the
            // original AI error. If the dynamic import fails, we log and fall through to the
            // generic rethrow below which preserves the original error context.
            let buildClaudeAdaptiveMessage;
            try {
                ({ buildClaudeAdaptiveMessage } = await import('./claude-adaptive-check.js'));
            } catch (importErr) {
                console.warn('[DLE] Could not load claude-adaptive-check.js:', importErr.message);
            }
            if (buildClaudeAdaptiveMessage) {
                throw new Error(buildClaudeAdaptiveMessage(claudeAdaptiveDetail, 'error') + profileLabel + modelLabel);
            }
        }
        // Preserve err.name on generic rethrow so AbortError/etc. classification survives.
        const rethrow = new Error(`${err.message}${profileLabel}${modelLabel}`);
        if (err.name && err.name !== 'Error') rethrow.name = err.name;
        if (err.status) rethrow.status = err.status;
        throw rethrow;
    } finally {
        if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
        clearTimeout(timer);
        clearTimeout(backupTimer);
    }
}

/**
 * Unified AI connection router. Routes calls to either a Connection Manager profile
 * or the CORS proxy bridge, based on connectionConfig.mode.
 * Eliminates duplicated if/else routing across aiSearch, callScribe, callAutoSuggest.
 *
 * @param {string} systemPrompt - System prompt text
 * @param {string} userMessage - User message content
 * @param {object} connectionConfig
 * @param {string} connectionConfig.mode - 'profile' or 'proxy'
 * @param {string} [connectionConfig.profileId] - Profile ID (for profile mode)
 * @param {string} [connectionConfig.proxyUrl] - Proxy URL (for proxy mode)
 * @param {string} [connectionConfig.model] - Model override
 * @param {number} connectionConfig.maxTokens - Max tokens for response
 * @param {number} connectionConfig.timeout - Timeout in ms
 * @param {object} [connectionConfig.cacheHints] - Optional cache hints for proxy mode
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>}
 */
export async function callAI(systemPrompt, userMessage, connectionConfig) {
    // BUG-006: Allow callers to skip throttle (e.g. hierarchicalPreFilter which chains with aiSearch)
    if (!connectionConfig.skipThrottle) {
        // Throttle: enforce minimum interval between API calls to prevent rapid-generation spam.
        // Throws a distinct error type so callers can distinguish throttle from real failure
        // (throttle should NOT trip the circuit breaker).
        const now = Date.now();
        if (now - _lastAiCallTimestamp < AI_CALL_MIN_INTERVAL_MS) {
            const err = new Error(`AI call throttled — minimum ${AI_CALL_MIN_INTERVAL_MS}ms between calls`);
            err.throttled = true;
            throw err;
        }
    }

    const { mode, profileId, proxyUrl, model, maxTokens, timeout, cacheHints, signal } = connectionConfig;

    // Check if already aborted before making the call
    if (signal?.aborted) {
        const err = new Error('Request aborted');
        err.name = 'AbortError';
        throw err;
    }

    // BUG-039 + BUG-H1: Set throttle timestamp only on SUCCESS.
    // Failed calls must not consume the throttle window (prevents blocking retries).
    const _callStart = Date.now();
    const _callEntry = {
        t: _callStart, caller: connectionConfig.caller || 'unknown',
        mode, model: model || null, timeoutMs: timeout,
        systemLen: systemPrompt?.length ?? 0, userLen: userMessage?.length ?? 0,
    };
    let result;
    try {
        if (mode === 'profile') {
            result = await callViaProfile(systemPrompt, userMessage, maxTokens, timeout, profileId, model, signal);
        } else {
            // Proxy mode
            result = await callProxyViaCorsBridge(
                proxyUrl,
                model || 'claude-haiku-4-5-20251001',
                systemPrompt,
                userMessage,
                maxTokens,
                timeout,
                cacheHints,
                signal,
            );
        }
        _callEntry.durationMs = Date.now() - _callStart;
        _callEntry.status = 'ok';
        _callEntry.responseLen = result?.text?.length ?? 0;
        _callEntry.inputTokens = result?.usage?.input_tokens ?? null;
        _callEntry.outputTokens = result?.usage?.output_tokens ?? null;
    } catch (err) {
        _callEntry.durationMs = Date.now() - _callStart;
        _callEntry.status = err.timedOut ? 'timeout' : err.userAborted ? 'aborted' : 'error';
        _callEntry.error = (err?.message || String(err)).slice(0, 200);
        try { aiCallBuffer.push(_callEntry); } catch { /* noop */ }
        throw err;
    }
    try { aiCallBuffer.push(_callEntry); } catch { /* noop */ }
    // Only stamp throttle on success, and only for non-skipped calls
    if (!connectionConfig.skipThrottle) {
        _lastAiCallTimestamp = Date.now();
    }
    return result;
}

/**
 * Build a compact manifest from a specific set of candidate entries (for AI search).
 * @param {VaultEntry[]} candidates - Entries to include (constants are filtered out)
 * @param {boolean} [excludeBootstrap=false] - Also exclude bootstrap entries (when they're being force-injected)
 * @returns {{ manifest: string, header: string }}
 */
/** Build candidate manifest — delegates to extracted pure function with settings injection. */
export function buildCandidateManifest(candidates, excludeBootstrap = false) {
    return _buildCandidateManifest(candidates, excludeBootstrap, getSettings());
}

// clusterEntries, buildCategoryManifest — imported from ./helpers.js

/** Threshold for enabling hierarchical two-call search */
const HIERARCHICAL_THRESHOLD = 40;

/**
 * Pre-filter candidates using hierarchical category selection for large vaults.
 * Call 1: asks AI which categories are relevant to the current chat.
 * Returns filtered candidates containing only entries from selected categories.
 * @param {VaultEntry[]} candidates - All selectable entries
 * @param {object[]} chat - Chat messages array
 * @returns {Promise<VaultEntry[]|null>} Filtered candidates, or null to skip (use all)
 */
export async function hierarchicalPreFilter(candidates, chat, signal) {
    const settings = getSettings();
    if (!settings.hierarchicalPreFilter) return null; // Disabled by default — let the AI see all candidates
    const bootstrapActive = chat.length <= settings.newChatThreshold;
    let selectable = candidates.filter(e => !isForceInjected(e, { bootstrapActive }));

    // BUG-387: in summary_only mode, cluster vote must match manifest filter
    if (settings.manifestSummaryMode === 'summary_only') {
        selectable = selectable.filter(e => e.summary && e.summary.trim());
    }

    if (selectable.length < HIERARCHICAL_THRESHOLD) return null; // Too few, skip clustering

    const clusters = clusterEntries(selectable);
    if (clusters.size <= 3) return null; // Not enough categories to benefit

    const categoryManifest = buildCategoryManifest(clusters);
    const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);

    const categoryPrompt = `You are a lore retrieval assistant. Given categories of lore entries and recent chat context, identify which categories are relevant to the current conversation.

A category is relevant if:
1. Characters, places, or concepts from that category are explicitly mentioned in the chat
2. The category's theme (e.g., combat, politics, magic) matches the current scene
3. The category could provide useful background context for what is happening

Be inclusive — when in doubt, include the category. A second stage will filter individual entries.
If no categories are relevant, return an empty array.

Respond with ONLY a JSON array of category name strings.
Example: ["Characters - Inner Circle", "Locations - Districts", "Lore - Magic Systems"]`;
    const categoryUserMessage = `## Categories\n${categoryManifest}\n\n## Recent Chat\n${chatContext}`;

    // BUG-AUDIT-1: Use tryAcquireHalfOpenProbe for actual AI calls (not pure query)
    if (!tryAcquireHalfOpenProbe()) {
        dedupWarning('AI search is resting after errors — using keywords for now.', 'circuit-prefilter', { hint: 'Circuit breaker open during hierarchical pre-filter.' });
        return null;
    }

    try {
        const result = await callAI(categoryPrompt, categoryUserMessage, {
            caller: 'hierarchicalPreFilter',
            mode: settings.aiSearchConnectionMode,
            profileId: settings.aiSearchProfileId,
            proxyUrl: settings.aiSearchProxyUrl,
            model: settings.aiSearchModel,
            maxTokens: AI_PREFILTER_MAX_TOKENS,
            timeout: settings.aiSearchTimeout,
            skipThrottle: true, // BUG-006: Don't throttle hierarchical pre-filter (it chains with aiSearch)
            signal, // BUG-233: propagate user-abort signal
        });
        const responseText = result.text;
        const usage = result.usage;

        // BUG-017: Don't increment aiSearchStats.calls here — only count in aiSearch()
        // to avoid double-counting when hierarchical + main search both run.
        // BUG-393: But we DO need to count this call somewhere so token averages don't
        // divide by the wrong N. Use a dedicated hierarchicalCalls counter.
        if (usage) {
            aiSearchStats.totalInputTokens += usage.input_tokens || 0;
            aiSearchStats.totalOutputTokens += usage.output_tokens || 0;
            aiSearchStats.hierarchicalCalls = (aiSearchStats.hierarchicalCalls || 0) + 1;
        }
        notifyAiStatsUpdated();

        let parsed = extractAiResponseClient(responseText);
        if (!parsed) return null;

        // BUG-027: Handle object format responses (e.g. {"categories": ["cat1", "cat2"]})
        if (!Array.isArray(parsed) && typeof parsed === 'object') {
            // Try common wrapper keys
            let arrayValue = parsed.categories || parsed.labels || parsed.selected || Object.values(parsed).find(Array.isArray);
            // Flatten nested arrays (e.g. [["cat1", "cat2"]] → ["cat1", "cat2"])
            if (Array.isArray(arrayValue) && arrayValue.length > 0 && Array.isArray(arrayValue[0])) {
                arrayValue = arrayValue.flat();
            }
            if (Array.isArray(arrayValue)) {
                parsed = arrayValue;
            } else {
                if (settings.debugMode) console.warn('[DLE] Hierarchical response: unexpected object format, skipping');
                return null;
            }
        }
        if (!Array.isArray(parsed) || parsed.length === 0) return null;

        // parsed should be an array of category name strings
        const selectedCategories = new Set(
            parsed.map(item => (typeof item === 'string' ? item : item.title || item.name || item.category || item.label || '').toLowerCase()).filter(Boolean),
        );

        if (selectedCategories.size === 0) return null;

        // Filter candidates to only those in selected categories.
        // BUG-385: Use exact case-insensitive match. Substring matching caused generic
        // category names like "lore" or "l" to match every category in the vault.
        // Re-derive category the same way clusterEntries does (see helpers.js/clusterEntries).
        const pickCategory = (entry) => {
            if (entry.tags && entry.tags.length > 0) {
                const firstReal = entry.tags.find(t => !LOREBOOK_INFRA_TAGS.has(String(t).toLowerCase()));
                if (firstReal) return firstReal.toLowerCase();
            }
            return 'uncategorized';
        };
        const filtered = selectable.filter(entry => selectedCategories.has(pickCategory(entry)));

        // BUG-396: Rescue entries whose primary keywords are explicitly mentioned in chat.
        // The pre-filter selects by category, but categories are broad — an entry whose keyword
        // literally appears in conversation should always reach the AI for evaluation.
        const filteredSet = new Set(filtered);
        const chatTextLower = chatContext.toLowerCase();
        const rescued = [];
        for (const entry of selectable) {
            if (filteredSet.has(entry)) continue; // Already included
            if (entry.keys && entry.keys.some(k => k && chatTextLower.includes(k.toLowerCase()))) {
                rescued.push(entry);
            }
        }

        // Always include force-injected entries
        const forceInjected = candidates.filter(e => isForceInjected(e, { bootstrapActive }));
        const filteredResult = [...forceInjected, ...filtered, ...rescued];

        if (settings.debugMode) {
            console.log(`[DLE] Hierarchical pre-filter: ${clusters.size} categories → ${selectedCategories.size} selected, ${selectable.length} → ${filtered.length} entries` + (rescued.length > 0 ? ` (+${rescued.length} keyword-rescued: ${rescued.map(e => e.title).join(', ')})` : ''));
        }

        // If filtering removed too many entries (>80% by default), skip — the AI was probably too aggressive
        // BUG-396: Use filteredResult count (category + rescued) for retention check
        const effectiveFiltered = filtered.length + rescued.length;
        const minRetention = 1 - (settings.hierarchicalAggressiveness ?? 0.8);
        if (effectiveFiltered < selectable.length * minRetention) {
            if (settings.debugMode) console.log('[DLE] Hierarchical pre-filter too aggressive, using full manifest');
            return null;
        }

        // BUG-H3: Warn when pre-filter drops >50% of candidates (even if within threshold)
        if (effectiveFiltered < selectable.length * 0.5 && settings.debugMode) {
            console.warn(`[DLE] Hierarchical pre-filter dropped ${selectable.length - effectiveFiltered}/${selectable.length} candidates — consider lowering aggressiveness`);
        }

        // Release the half-open probe without affecting circuit state —
        // the main aiSearch() call handles its own probing independently.
        releaseHalfOpenProbe();

        return filteredResult;
    } catch (err) {
        // Release the probe without recording success or failure — pre-filter is optional
        // and its outcome shouldn't cascade to the circuit breaker state machine.
        if (!err.throttled) releaseHalfOpenProbe();
        if (settings.debugMode) console.warn('[DLE] Hierarchical pre-filter failed:', err.message);
        return null; // Fall back to single-call
    }
}

/**
 * @typedef {object} AiSearchMatch
 * @property {VaultEntry} entry
 * @property {string} confidence - "high", "medium", or "low"
 * @property {string} reason - Brief explanation
 */

/**
 * Perform AI-powered semantic search using Claude Haiku via the proxy.
 * @param {object[]} chat - Chat messages array
 * @param {string} candidateManifest - Manifest string of candidate entries
 * @param {string} candidateHeader - Header with metadata about candidates
 * @param {VaultEntry[]} [snapshot] - Vault index snapshot (avoids stale global reads after await)
 * @returns {Promise<{ results: AiSearchMatch[], error: boolean }>}
 */
export async function aiSearch(chat, candidateManifest, candidateHeader, snapshot, candidateEntries, signal) {
    const settings = getSettings();

    if (!settings.aiSearchEnabled || !candidateManifest) {
        return { results: [], error: false };
    }

    // BUG-AUDIT-1: Use tryAcquireHalfOpenProbe for actual AI calls (not pure query)
    if (!tryAcquireHalfOpenProbe()) {
        if (settings.debugMode) console.debug('[DLE] AI circuit breaker open — skipping AI search');
        dedupWarning('AI search is resting after errors — using keywords for now.', 'ai_circuit', { timeOut: 8000, hint: 'Circuit breaker tripped after 2 consecutive failures; retrying in ~30s.' });
        return { results: [], error: true, cached: false, errorMessage: 'AI search temporarily paused' };
    }

    // BUG-CACHE-FIX: Strip trailing assistant slot before hashing.
    // During onGenerate, chat[] may or may not yet contain a pending assistant slot
    // depending on call timing. On swipe/regen, the prior assistant turn is in chat[]
    // but was NOT present when the cache was populated → hash & line-count both drift,
    // missing the cache. Excluding the trailing assistant message normalizes both
    // populating and lookup sides so swipe/regen become exact-hit cases.
    let chatForCache = chat;
    if (chat && chat.length > 0) {
        const last = chat[chat.length - 1];
        if (last && !last.is_user && !last.is_system) {
            chatForCache = chat.slice(0, -1);
        }
    }
    let chatContext = buildAiChatContext(chatForCache, settings.aiSearchScanDepth);
    if (!chatContext.trim()) return { results: [], error: false, cached: false };

    // Prepend seed entry content as story context on new chats.
    // BUG-390: compute from chatForCache (same source as the sliding-window cache)
    // so boundary turns don't flip between new/not-new.
    const isNewChat = chatForCache.length <= settings.newChatThreshold;
    if (isNewChat) {
        const seedEntries = (snapshot || vaultIndex).filter(e => e.seed);
        if (seedEntries.length > 0) {
            const seedContext = seedEntries.map(e => e.content).join('\n\n');
            chatContext = `[STORY CONTEXT — use this to understand the setting and make better selections]\n${seedContext}\n\n[RECENT CHAT]\n${chatContext}`;
            if (settings.debugMode) {
                console.log(`[DLE] New chat: injecting ${seedEntries.length} seed entries as AI context`);
            }
        }
    }

    // Scribe-informed retrieval: append session summary for broader context awareness
    if (settings.scribeInformedRetrieval && lastScribeSummary && lastScribeSummary.trim()) {
        chatContext += `\n\n[SESSION SUMMARY — broader context beyond the recent chat window]\n${lastScribeSummary.trim()}`;
        if (settings.debugMode) {
            console.log('[DLE] Scribe summary injected into AI search context');
        }
    }

    // Sliding window cache invariant:
    // The cache stores {hash, manifestHash, chatLineCount, results} from the last AI call.
    // It is valid when: (a) the manifest hasn't changed (same entries, same settings), AND
    // (b) new chat messages since the cached call don't mention any entity names from the vault.
    // This avoids redundant AI calls when the user sends messages unrelated to lore.
    // Cache is invalidated on: settings change, vault re-index, entity name mention, or chat switch.
    // Short entity names (<=3 chars) use pre-compiled word-boundary regexes to avoid false matches.
    // BUG-019: Include aiConfidenceThreshold in cache key (changing threshold must invalidate cache)
    // BUG-020: Hash the system prompt content (not just length) to detect meaningful changes
    // BUG-021: Include manifestSummaryMode and summaryLength in cache key
    const promptHash = simpleHash(settings.aiSearchSystemPrompt || '');
    const settingsKey = `${settings.aiSearchMode}|${settings.aiSearchScanDepth}|${settings.maxEntries}|${settings.unlimitedEntries}|${promptHash}|${settings.aiSearchConnectionMode}|${settings.aiSearchProfileId}|${settings.aiSearchModel}|${settings.aiConfidenceThreshold || 'low'}|${settings.manifestSummaryMode || 'prefer_summary'}|${settings.aiSearchManifestSummaryLength || 600}`;
    const manifestHash = simpleHash(settingsKey + candidateManifest);
    const chatHash = simpleHash(chatContext);
    // Defer chatLines split until after exact cache hit check (avoid unnecessary work)
    let chatLines = null;
    const getChatLines = () => { if (!chatLines) chatLines = chatContext.split('\n').filter(l => l.trim()); return chatLines; };

    // Resolve cached title-based results back to current VaultEntry objects.
    // BUG-382: Replay ONLY against the current candidate set — never against the full
    // vault index. Using vaultIndex here leaks blocked/gated entries to drawer/Carto
    // (the cache was built from a narrower set; widening it at read time defeats that).
    const resolveCachedResults = (cached) => {
        const replayPool = Array.isArray(candidateEntries) && candidateEntries.length > 0
            ? candidateEntries
            : (snapshot || vaultIndex);
        const titleMap = new Map(replayPool.map(e => [e.title.toLowerCase(), e]));
        return cached
            .map(r => ({ entry: titleMap.get(r.title.toLowerCase()), confidence: r.confidence, reason: r.reason }))
            .filter(r => r.entry);
    };

    // Diagnostic breadcrumb: log AI search state for first-gen investigation
    if (settings.debugMode) {
        console.debug('[DLE] AI search entry:', {
            manifestEntries: candidateEntries?.length ?? 0,
            chatContextLen: chatContext.length,
            chatForCacheLen: chatForCache.length,
            isNewChat,
            cacheHash: aiSearchCache.hash ? 'set' : 'empty',
            cacheManifestHash: aiSearchCache.manifestHash ? 'set' : 'empty',
            cacheChatLineCount: aiSearchCache.chatLineCount,
            generationCount,
        });
    }

    if (settings.debugMode) {
        console.debug('[DLE][DIAG] ai-cache-pre-check', {
            chatHash: chatHash?.substring(0, 12),
            manifestHash: manifestHash?.substring(0, 12),
            cachedHash: aiSearchCache.hash?.substring(0, 12) || 'EMPTY',
            cachedManifestHash: aiSearchCache.manifestHash?.substring(0, 12) || 'EMPTY',
            cachedChatLineCount: aiSearchCache.chatLineCount,
            cachedResultCount: aiSearchCache.results?.length ?? 0,
            cachedResultTitles: aiSearchCache.results?.map(r => r.title) ?? [],
            hashMatch: aiSearchCache.hash === chatHash,
            manifestMatch: aiSearchCache.manifestHash === manifestHash,
        });
    }

    if (aiSearchCache.hash === chatHash && aiSearchCache.manifestHash === manifestHash && aiSearchCache.chatLineCount > 0) {
        // Exact match — nothing changed at all (includes cached empty results)
        aiSearchStats.cachedHits++;
        notifyAiStatsUpdated();
        if (settings.debugMode) console.debug('[DLE][DIAG] ai-cache-exact HIT — returning %d cached results', aiSearchCache.results?.length);
        return { results: resolveCachedResults(aiSearchCache.results), error: false, cached: true };
    }
    if (settings.debugMode) console.debug('[DLE][DIAG] ai-cache-exact MISS');

    // Keyword-set stability check: manifest unchanged and current keyword-matched
    // candidate set is a subset of the cached one. Catches typo fixes, prose edits,
    // "ok continue", reaction messages — anything that doesn't introduce a new lore
    // mention. Skipped in ai-only mode (those users opted into "always ask AI").
    if (settings.aiSearchMode !== 'ai-only'
        && aiSearchCache.manifestHash === manifestHash
        && aiSearchCache.matchedEntrySet
        && Array.isArray(candidateEntries)) {
        const cachedSet = aiSearchCache.matchedEntrySet;
        let isSubset = true;
        for (const e of candidateEntries) {
            const t = (e?.title || '').toLowerCase();
            if (t && !cachedSet.has(t)) { isSubset = false; break; }
        }
        if (isSubset) {
            aiSearchStats.cachedHits++;
            notifyAiStatsUpdated();
            if (settings.debugMode) console.debug('[DLE][DIAG] ai-cache-keyword-stable HIT');
            return { results: resolveCachedResults(aiSearchCache.results), error: false, cached: true };
        }
        if (settings.debugMode) console.debug('[DLE][DIAG] ai-cache-keyword-stable MISS — new candidates not subset of cached set');
    }

    // Defensive sliding-window degenerate case: manifest unchanged and chat shorter
    // or equal to cached count (e.g. user deleted messages, or scanDepth changed).
    // After the trailing-assistant strip above, normal swipe/regen should already
    // hit the exact-match branch — this is a safety net.
    // BUG-396b: Also verify prefix content — if the user edited a message mid-chat
    // and the line count happened to stay the same or shrink, we must not cache-hit.
    if (aiSearchCache.manifestHash === manifestHash
        && aiSearchCache.chatLineCount > 0
        && getChatLines().length <= aiSearchCache.chatLineCount) {
        // Verify content integrity: hash the current lines and compare to stored prefix
        const currentContentHash = simpleHash(getChatLines().join('\n'));
        if (aiSearchCache.prefixHash && currentContentHash !== aiSearchCache.prefixHash) {
            if (settings.debugMode) console.debug('[DLE][DIAG] ai-cache-swipe-regen MISS — content changed (edit detected)');
        } else {
            aiSearchStats.cachedHits++;
            notifyAiStatsUpdated();
            if (settings.debugMode) console.debug(`[DLE][DIAG] ai-cache-swipe-regen HIT (${getChatLines().length} lines vs cached ${aiSearchCache.chatLineCount})`);
            return { results: resolveCachedResults(aiSearchCache.results), error: false, cached: true };
        }
    }
    if (settings.debugMode && !(aiSearchCache.manifestHash === manifestHash && aiSearchCache.chatLineCount > 0 && getChatLines().length <= aiSearchCache.chatLineCount)) {
        console.debug('[DLE][DIAG] ai-cache-swipe-regen MISS');
    }

    // Sliding window: manifest unchanged + only newest message(s) differ.
    // BUG-394: If entityShortNameRegexes was rebuilt since the cache was written,
    // the sliding-window entity-mention scan would use a stale regex set — skip.
    // BUG-396b: Also verify the prefix content hasn't changed (edit-in-place detection).
    // Without this, editing a message mid-chat causes a stale cache hit because the
    // sliding window only checks NEW lines at the end, not changes within existing lines.
    if (aiSearchCache.manifestHash === manifestHash
        && aiSearchCache.chatLineCount > 0
        && getChatLines().length > aiSearchCache.chatLineCount
        && (aiSearchCache.entityRegexVersion ?? -1) === entityRegexVersion) {
        // Verify prefix content integrity — if existing lines changed, this is NOT
        // a simple append and the cache is stale.
        const prefixLines = getChatLines().slice(0, aiSearchCache.chatLineCount);
        const prefixHash = simpleHash(prefixLines.join('\n'));
        if (aiSearchCache.prefixHash && prefixHash !== aiSearchCache.prefixHash) {
            if (settings.debugMode) console.debug('[DLE][DIAG] ai-cache-sliding-window MISS — prefix content changed (edit detected)');
            // Fall through to full AI call
        } else {
        // Extract only the new lines added since last cache
        const newLines = getChatLines().slice(aiSearchCache.chatLineCount);
        const newText = newLines.join(' ').toLowerCase();

        // Check if any vault entry title or key appears in the new text (word-boundary match)
        // Uses pre-computed entityNameSet from buildIndex (titles min 1 char, keys min 2 chars)
        let hasNewEntityMention = false;
        for (const name of entityNameSet) {
            // Use pre-compiled word boundary regex for ALL names to avoid false positives
            // (e.g. "an" in "want", "Arch" in "monarch", "Eris" in "characteristics")
            const regex = entityShortNameRegexes.get(name);
            if (regex && regex.test(newText)) {
                hasNewEntityMention = true;
                break;
            }
        }

        if (!hasNewEntityMention) {
            aiSearchStats.cachedHits++;
            notifyAiStatsUpdated();
            if (settings.debugMode) console.debug(`[DLE][DIAG] ai-cache-sliding-window HIT (${newLines.length} new lines, no entity mentions)`);
            return { results: resolveCachedResults(aiSearchCache.results), error: false, cached: true };
        }
        if (settings.debugMode) console.debug('[DLE][DIAG] ai-cache-sliding-window MISS — new entity mention found in new lines');
        } // end prefix-intact else
    }

    if (settings.debugMode) console.debug('[DLE][DIAG] ai-cache-full-miss — all 4 tiers missed, calling AI');

    try {
        // Resolve system prompt with {{maxEntries}} placeholder
        // Request 2x max entries so low-confidence candidates can fill remaining budget
        const indexToUse = snapshot || vaultIndex;
        const requestedEntries = settings.unlimitedEntries ? 0 : Math.min(settings.maxEntries * 2, indexToUse.length);
        const maxEntries = settings.unlimitedEntries ? 'as many as are relevant' : String(requestedEntries);
        let systemPrompt;
        if (settings.aiSearchSystemPrompt && settings.aiSearchSystemPrompt.trim()) {
            systemPrompt = settings.aiSearchSystemPrompt.trim();
        } else {
            systemPrompt = DEFAULT_AI_SYSTEM_PROMPT;
        }
        systemPrompt = systemPrompt.replace(/\{\{maxEntries\}\}/g, maxEntries);

        // Apply Claude Code prefix in proxy mode when enabled
        if (settings.aiSearchClaudeCodePrefix && settings.aiSearchConnectionMode === 'proxy' && !systemPrompt.startsWith('You are Claude Code')) {
            systemPrompt = 'You are Claude Code. ' + systemPrompt;
        }

        // On new chats, tell AI to always fill to max selections.
        // BUG-386: Skip when unlimitedEntries is active — "select exactly N" directly
        // contradicts the unlimited instruction added upstream.
        if (isNewChat && !settings.unlimitedEntries) {
            const constantCount = indexToUse.filter(e => e.constant).length;
            const selectCount = Math.max(1, settings.maxEntries - constantCount);
            systemPrompt += '\n\nIMPORTANT: The conversation just started. You have story context above to help you understand the setting. Select exactly ' + selectCount + ' entries from the manifest — always fill to this count. The user needs rich context for the conversation start. Do not return fewer entries or an empty array.';
            if (settings.debugMode) {
                console.log(`[DLE] New chat: requesting ${selectCount} AI selections (${settings.maxEntries} max - ${constantCount} constants)`);
            }
        }

        // Build user message for AI — manifest FIRST (stable across turns) for prompt caching,
        // chat context LAST (changes every turn)
        const userMessageParts = [];
        if (candidateHeader) userMessageParts.push(`## Manifest Info\n${candidateHeader}`);
        userMessageParts.push(`## Available Lore Entries\n${candidateManifest}`);
        userMessageParts.push(`## Recent Chat\n${chatContext}`);
        const userMessage = userMessageParts.join('\n\n');

        // Build cache hints for proxy mode (stable manifest prefix + dynamic chat suffix)
        let cacheHints;
        let effectiveUserMessage = userMessage;
        if (settings.aiSearchConnectionMode === 'proxy') {
            const userMessageParts2 = [];
            if (candidateHeader) userMessageParts2.push(`## Manifest Info\n${candidateHeader}`);
            userMessageParts2.push(`## Available Lore Entries\n${candidateManifest}`);
            const cacheBreakIndex = userMessageParts2.length;
            userMessageParts2.push(`## Recent Chat\n${chatContext}`);
            userMessageParts2.push('Select the relevant entries as a JSON array.');
            effectiveUserMessage = userMessageParts2.join('\n\n');
            const stablePrefix = userMessageParts2.slice(0, cacheBreakIndex).join('\n\n');
            const dynamicSuffix = userMessageParts2.slice(cacheBreakIndex).join('\n\n');
            cacheHints = { stablePrefix, dynamicSuffix };
        }

        const aiResult = await callAI(systemPrompt, effectiveUserMessage, {
            caller: 'aiSearch',
            mode: settings.aiSearchConnectionMode,
            profileId: settings.aiSearchProfileId,
            proxyUrl: settings.aiSearchProxyUrl,
            model: settings.aiSearchModel,
            maxTokens: settings.aiSearchMaxTokens,
            timeout: settings.aiSearchTimeout,
            cacheHints,
            signal, // BUG-233: propagate user-abort signal
        });

        aiSearchStats.calls++;
        if (aiResult.usage) {
            aiSearchStats.totalInputTokens += aiResult.usage.input_tokens || 0;
            aiSearchStats.totalOutputTokens += aiResult.usage.output_tokens || 0;
        }
        notifyAiStatsUpdated();

        let parsed = extractAiResponseClient(aiResult.text);
        // BUG-383: Handle object-shaped AI responses (e.g. {"results": [...]}) and trip
        // the circuit breaker on persistent format drift so it can open after 2 failures.
        if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') {
            const arrayValue = parsed.results || parsed.entries || parsed.titles || parsed.selected
                || Object.values(parsed).find(Array.isArray);
            if (Array.isArray(arrayValue)) {
                parsed = arrayValue;
            } else {
                if (settings.debugMode) console.warn('[DLE] AI search: unrecognized object-shaped response, treating as failure');
                recordAiFailure();
                dedupWarning('AI search returned an unrecognized response shape — falling back to keywords.', 'aiSearch_shape_failure', { hint: 'extractAiResponseClient returned a non-array object with no known wrapper key.' });
                return { results: [], error: true, errorMessage: 'AI response shape unrecognized' };
            }
        }
        if (!parsed) {
            // BUG-M7: Log truncated response for debugging parse failures
            if (settings.debugMode) {
                const preview = (aiResult.text || '').slice(0, 300);
                console.warn(`[DLE] AI search: could not parse response as JSON array. Response preview: ${preview}`);
            }
            recordAiFailure(); // BUG-010: Parse failures should trip circuit breaker
            dedupWarning('AI search returned an unparseable response — falling back to keywords.', 'aiSearch_parse_failure', { hint: 'extractAiResponseClient returned null; see debug log for response preview.' });
            return { results: [], error: true, errorMessage: 'Failed to parse AI response as JSON' };
        }
        const aiResults = normalizeResults(parsed)
            .filter(r => r.title && r.title.trim() !== '' && r.title !== 'null' && r.title !== 'undefined');
        // BUG-383: If parsed had items but normalizeResults produced nothing, the AI
        // returned an array of unrecognized shapes (numbers, nested arrays, objects
        // without title/name). Treat as format-drift failure so the breaker can trip.
        if (Array.isArray(parsed) && parsed.length > 0 && aiResults.length === 0) {
            if (settings.debugMode) console.warn('[DLE] AI search: normalizeResults produced zero items from non-empty response');
            recordAiFailure();
            dedupWarning('AI search response had no usable entries — falling back to keywords.', 'aiSearch_normalize_empty', { hint: 'normalizeResults returned empty from a non-empty parsed array (format drift).' });
            return { results: [], error: true, errorMessage: 'AI response had no usable entries' };
        }

        // Map returned results back to VaultEntry objects with confidence/reason
        const aiResultMap = new Map();
        for (const r of aiResults) {
            aiResultMap.set(r.title.toLowerCase(), r);
        }

        /** @type {AiSearchMatch[]} */
        const results = [];
        const indexToSearch = candidateEntries || snapshot || vaultIndex;
        const matchedAiTitles = new Set();
        for (const entry of indexToSearch) {
            const aiResult = aiResultMap.get(entry.title.toLowerCase());
            if (aiResult) {
                results.push({
                    entry,
                    confidence: aiResult.confidence || 'medium',
                    reason: aiResult.reason || 'AI search',
                });
                matchedAiTitles.add(aiResult.title.toLowerCase());
            }
        }

        // H12: Fuzzy-match any AI titles that didn't get an exact match
        const candidateTitles = indexToSearch.map(e => e.title);
        const entryByLower = new Map(indexToSearch.map(e => [e.title.toLowerCase(), e]));
        for (const [lowerTitle, r] of aiResultMap) {
            if (matchedAiTitles.has(lowerTitle)) continue;
            const fuzzy = fuzzyTitleMatch(r.title, candidateTitles);
            if (fuzzy && !matchedAiTitles.has(fuzzy.title.toLowerCase())) {
                const entry = entryByLower.get(fuzzy.title.toLowerCase());
                if (entry) {
                    results.push({
                        entry,
                        confidence: r.confidence || 'medium',
                        reason: r.reason || 'AI search (fuzzy)',
                    });
                    matchedAiTitles.add(fuzzy.title.toLowerCase());
                    if (settings.debugMode) console.debug(`[DLE] AI fuzzy match: "${r.title}" → "${fuzzy.title}" (${(fuzzy.similarity * 100).toFixed(0)}%)`);
                }
            } else if (settings.debugMode) {
                console.debug(`[DLE] AI title unmatched: "${r.title}" — no entry found in vault`);
            }
        }

        // Sort by confidence tier: high > medium > low (budget will naturally cut low-confidence)
        const confidenceOrder = { high: 0, medium: 1, low: 2 };
        results.sort((a, b) => (confidenceOrder[a.confidence] ?? 1) - (confidenceOrder[b.confidence] ?? 1));

        // E1: Filter by confidence threshold
        const threshold = settings.aiConfidenceThreshold || 'low';
        const filteredResults = threshold === 'low'
            ? results
            : results.filter(r => {
                const allowedTiers = threshold === 'high' ? ['high'] : ['high', 'medium'];
                return allowedTiers.includes(r.confidence);
            });

        // Cache results by title (not entry reference) to survive index rebuilds.
        // Also store the keyword-matched candidate set so subsequent calls can do
        // cheap subset checks ("keyword-stable hit") even when chat hash drifts.
        const matchedEntrySet = Array.isArray(candidateEntries)
            ? new Set(candidateEntries.map(e => (e?.title || '').toLowerCase()).filter(Boolean))
            : null;
        const _cachePayload = {
            hash: chatHash,
            manifestHash,
            chatLineCount: getChatLines().length,
            // BUG-396b: Store prefix hash for sliding-window content integrity check.
            // If existing chat lines are edited in-place, the prefix hash will differ
            // and the sliding window will correctly miss instead of returning stale results.
            prefixHash: simpleHash(getChatLines().join('\n')),
            results: filteredResults.map(r => ({ title: r.entry.title, confidence: r.confidence, reason: r.reason })),
            matchedEntrySet,
            // BUG-394: stamp regex version so sliding-window hits are skipped when
            // entityShortNameRegexes has been rebuilt since this cache entry was written.
            entityRegexVersion,
        };
        setAiSearchCache(_cachePayload);
        if (settings.debugMode) {
            console.debug('[DLE][DIAG] ai-cache-write', {
                hash: chatHash?.substring(0, 12),
                manifestHash: manifestHash?.substring(0, 12),
                chatLineCount: _cachePayload.chatLineCount,
                resultCount: _cachePayload.results.length,
                resultTitles: _cachePayload.results.map(r => r.title),
            });
        }

        if (settings.debugMode) {
            console.log(`[DLE] AI search found ${aiResults.length} titles, matched ${results.length} entries${threshold !== 'low' ? `, ${filteredResults.length} after confidence threshold (${threshold})` : ''}`);
            console.table(filteredResults.map(r => ({
                title: r.entry.title,
                confidence: r.confidence,
                reason: r.reason,
            })));
        }

        recordAiSuccess();
        return { results: filteredResults, error: false, cached: false };
    } catch (err) {
        // BUG-005: Detect timeouts from both profile mode (AbortError) and proxy mode (message-based)
        // BUG-252: user aborts are distinct from timeouts — both skip circuit-break, but user
        // aborts should not log as "timed out".
        const isUserAbort = err.userAborted === true || err.name === 'AbortError' && /aborted by user/i.test(err.message || '');
        const isTimeout = !isUserAbort && (err.timedOut === true || err.name === 'AbortError' || /timed?\s*out/i.test(err.message));
        // BUG-020: Classify HTTP errors — surface auth failures immediately (no circuit trip),
        // treat 429 as rate-limit (no circuit trip, transient), let 5xx/network trip the circuit.
        const status = Number(err.status) || Number((err.message || '').match(/\b(4\d\d|5\d\d)\b/)?.[1]) || 0;
        const isRateLimit = status === 429 || /rate.?limit|too many requests/i.test(err.message || '');
        const isAuthError = status === 401 || status === 403 || /unauthoriz|forbidden|invalid api key|auth/i.test(err.message || '');
        // Don't trip circuit breaker for throttle, timeout, rate-limit, or auth errors
        if (!err.throttled && !isTimeout && !isUserAbort && !isRateLimit && !isAuthError) recordAiFailure();
        if (isUserAbort) {
            if (settings.debugMode) console.debug('[DLE] AI search aborted by user');
        } else if (isTimeout) {
            console.warn('[DLE] AI search timed out');
        } else if (err.throttled) {
            if (settings.debugMode) console.debug('[DLE] AI search throttled — using cache/keywords');
        } else if (isAuthError) {
            console.error('[DLE] AI search auth error:', err);
            dedupError(`AI search authentication failed (${status || 'check API key'}). Verify your profile credentials.`, 'aiSearch_auth_error', { hint: err.message || String(err), timeOut: 15000 });
        } else if (isRateLimit) {
            console.warn('[DLE] AI search rate-limited:', err.message);
            dedupWarning('AI search rate-limited by provider — falling back to keywords.', 'aiSearch_rate_limit', { hint: err.message || String(err) });
        } else {
            console.error('[DLE] AI search error:', err);
        }
        // BUG-004: Include error message for pipeline trace enrichment
        return { results: [], error: true, cached: false, errorMessage: err.message || String(err) };
    }
}
