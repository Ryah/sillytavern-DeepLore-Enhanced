/**
 * DeepLore Enhanced — Shared mutable state
 * All globals live here; modules import and read/write directly.
 */
// Late-bound reference to pushEvent — avoids circular import at module eval time.
// Populated lazily on first use; interceptors.js has no deps on state.js at eval time.
let _pushEventRef = null;
function pushEventSafe(kind, data) {
    try {
        if (!_pushEventRef) {
            // Dynamic import returns a promise — fire-and-forget on first call, sync on subsequent
            import('./diagnostics/interceptors.js').then(m => { _pushEventRef = m.pushEvent; });
            return;
        }
        _pushEventRef(kind, data);
    } catch { /* never block state mutations for diagnostic logging */ }
}

/** @type {import('../core/pipeline.js').VaultEntry[]} */
export let vaultIndex = [];
/** Computed folder list from vault index: [{path, entryCount}] sorted by count desc */
export let folderList = [];
export let indexTimestamp = 0;
export let indexing = false;
/** @type {Promise<void>|null} In-progress build promise for deduplication */
export let buildPromise = null;
/** Whether vault has ever successfully loaded */
export let indexEverLoaded = false;

/** AI search result cache (sliding window: tracks manifest + chat lines separately) */
export let aiSearchCache = { hash: '', manifestHash: '', chatLineCount: 0, results: [], matchedEntrySet: null };

/** Session-scoped AI search usage stats */
export let aiSearchStats = { calls: 0, cachedHits: 0, totalInputTokens: 0, totalOutputTokens: 0, hierarchicalCalls: 0 };

/** Context Cartographer: sources from the last generation interceptor run */
export let lastInjectionSources = null;
/** Epoch at which lastInjectionSources was set (race condition guard: CHARACTER_MESSAGE_RENDERED
 *  only consumes sources when this matches chatEpoch, preventing stale cross-chat writes) */
export let lastInjectionEpoch = -1;

/** Session Scribe: chat position tracking, lock, and prior note context */
export let lastScribeChatLength = 0;
export let scribeInProgress = false;
export let lastScribeSummary = '';

/** Vault Sync: previous index snapshot for change detection */
export let previousIndexSnapshot = null;

/** Cooldown tracking: title → remaining generations to skip */
export let cooldownTracker = new Map();

/** Generation counter (reset per chat) */
export let generationCount = 0;

/** Re-injection tracking: title → generation number when last injected */
export let injectionHistory = new Map();

/** Vault Sync: polling interval ID */
export let syncIntervalId = null;

/** Track last warning ratio to avoid spamming toasts */
export let lastWarningRatio = 0;

/** Last pipeline trace for /dle-inspect command */
export let lastPipelineTrace = null;

/** Auto Lorebook: message counter */
export let autoSuggestMessageCount = 0;

/** Entry Decay: title → generations since last injection (reset per chat) */
export let decayTracker = new Map();

/** Consecutive injection counter: title → consecutive generations injected (reset per chat) */
export let consecutiveInjections = new Map();

/** Per-chat injection counts: trackerKey → number of generations this entry was injected (reset per chat) */
export let chatInjectionCounts = new Map();

/** Last health check result for settings badge */
export let lastHealthResult = null;

/** Tracker snapshot for swipe rollback: pre-mutation state of cooldown/decay/consecutive/injectionHistory/generationCount.
 * Captured at the start of each generation; restored at the start of the next generation if it's detected as a swipe. */
export let lastGenerationTrackerSnapshot = null;
export function setLastGenerationTrackerSnapshot(v) { lastGenerationTrackerSnapshot = v; }

/** Vault fetch failure tracking: how many enabled vaults failed during the last index build */
export let lastVaultFailureCount = 0;
/** How many vaults were attempted during the last index build */
export let lastVaultAttemptCount = 0;

/** Context Cartographer: previous sources for diff display */
export let previousSources = null;

/** Average token estimate across all vault entries (computed at index build) */
export let vaultAvgTokens = 0;

/** Chat epoch counter — increments on every CHAT_CHANGED to detect stale onGenerate writes */
export let chatEpoch = 0;

// ── Utility: consistent tracker key for Maps (cooldown, injection, decay, analytics) ──
// Uses vaultSource:title to avoid collisions when the same title exists in multiple vaults.
export function trackerKey(entry) {
    return `${entry.vaultSource || ''}:${entry.title}`;
}

// ── Setter functions ──
// ES modules export live bindings but `let` exports can only be reassigned
// from within the module that declared them. These setters allow other
// modules to update the state.

export function setVaultIndex(v) { vaultIndex = v; }

/**
 * Returns vault entries that are safe to show to the writing AI.
 * Filters out `lorebook-guide` entries (Librarian-only meta/style guides).
 *
 * **Use this everywhere except:** Emma's Librarian chat tools, the drawer Browse tab,
 * the graph, and diagnostics. Anything that produces content the writing AI may see —
 * pipeline matching, AI candidate manifest, dle_search_lore, scribe, auto-suggest —
 * MUST go through this function instead of reading `vaultIndex` directly.
 *
 * @returns {Array} Filtered vault index excluding guide entries.
 */
export function getWriterVisibleEntries() {
    return vaultIndex.filter(e => !e.guide);
}
export function setFolderList(v) { folderList = v; }
export function setIndexTimestamp(v) { indexTimestamp = v; }
export function setIndexing(v) { indexing = v; notifyIndexingChanged(); }
export function setBuildPromise(v) { buildPromise = v; }
export function setIndexEverLoaded(v) { indexEverLoaded = v; }
export function setAiSearchCache(v) { aiSearchCache = v; }
export function setLastInjectionSources(v) { lastInjectionSources = v; }
export function setLastInjectionEpoch(v) { lastInjectionEpoch = v; }
export function setLastScribeChatLength(v) { lastScribeChatLength = v; }
export function setScribeInProgress(v) { scribeInProgress = v; }

/** AI Notepad extract lock — prevents concurrent extraction calls */
export let notepadExtractInProgress = false;
export function setNotepadExtractInProgress(v) { notepadExtractInProgress = v; }

/** Claude adaptive-thinking misconfiguration flag (any feature in bad combo) */
export let claudeAutoEffortBad = false;
export let claudeAutoEffortDetail = null;
const claudeAutoEffortObservers = new Set();
export function setClaudeAutoEffortState(bad, detail) {
    claudeAutoEffortBad = !!bad;
    claudeAutoEffortDetail = detail || null;
    for (const cb of claudeAutoEffortObservers) {
        try { cb(claudeAutoEffortBad, claudeAutoEffortDetail); } catch (e) { console.warn('[DLE] Claude auto-effort observer callback error:', e?.message); }
    }
}
export function onClaudeAutoEffortChanged(cb) { claudeAutoEffortObservers.add(cb); return () => claudeAutoEffortObservers.delete(cb); }
export function setLastScribeSummary(v) { lastScribeSummary = v; }
export function setPreviousIndexSnapshot(v) { previousIndexSnapshot = v; }
export function setCooldownTracker(v) { cooldownTracker = v; }
export function setGenerationCount(v) { generationCount = v; }
export function setInjectionHistory(v) { injectionHistory = v; }
export function setSyncIntervalId(v) { syncIntervalId = v; }
export function setLastWarningRatio(v) { lastWarningRatio = v; }
export function setLastPipelineTrace(v) { lastPipelineTrace = v; }
export function setAutoSuggestMessageCount(v) { autoSuggestMessageCount = v; }
export function setDecayTracker(v) { decayTracker = v; }
export function setConsecutiveInjections(v) { consecutiveInjections = v; }
export function setChatInjectionCounts(v) { chatInjectionCounts = v; }
export function setLastHealthResult(v) { lastHealthResult = v; }
export function setLastVaultFailureCount(v) { lastVaultFailureCount = v; }
export function setLastVaultAttemptCount(v) { lastVaultAttemptCount = v; }
export function setPreviousSources(v) { previousSources = v; }
export function setVaultAvgTokens(v) { vaultAvgTokens = v; }
export function setChatEpoch(v) { chatEpoch = v; }

/** BUG-291/292/293: Per-swipe injected keys, identified by `${msgIdx}|${swipe_id}`.
 * Replaces the old content-hash + single-Set approach which:
 *   - missed alternate-swipe navigation (content changes → thought it was a new gen)
 *   - collided with delete-then-regenerate
 *   - decremented the wrong keys (last gen's, not the swipe actually being replaced)
 * Persisted to chat_metadata.deeplore_swipe_injected_keys so rollback survives reload.
 * Pruned on write to keep only recent message slots. */
export let perSwipeInjectedKeys = new Map();
export function setPerSwipeInjectedKeys(v) { perSwipeInjectedKeys = v; }

/** E9: Generation count at last index rebuild (for generation-based rebuild trigger) */
export let lastIndexGenerationCount = 0;
export function setLastIndexGenerationCount(v) { lastIndexGenerationCount = v; }

/** BUG-015: Build epoch — increments on force-release of stuck indexing flag.
 *  In-progress builds capture epoch at start; if epoch changes mid-build, the build bails. */
export let buildEpoch = 0;
export function setBuildEpoch(v) { buildEpoch = v; }

/** Generation lock to prevent concurrent onGenerate runs */
export let generationLock = false;
export let generationLockTimestamp = 0;
/** Epoch counter for the generation lock — increments on each lock acquisition (including force-release).
 *  Stale pipelines check this before writing prompts to bail if superseded. */
export let generationLockEpoch = 0;
export function setGenerationLock(v) {
    generationLock = v;
    generationLockTimestamp = v ? Date.now() : 0;
    if (v) generationLockEpoch++;
    notifyGenerationLockChanged();
}
export function setGenerationLockEpoch(v) { generationLockEpoch = v; }
/** Update lock timestamp without toggling the lock itself (C9: agentic loop keepalive). */
export function setGenerationLockTimestamp(v) { generationLockTimestamp = v; }

/** Pipeline phase for drawer status display.
 *  @type {'idle'|'choosing'|'generating'|'writing'|'searching'|'flagging'} */
export let pipelinePhase = 'idle';

/** @type {Set<() => void>} */
const pipelinePhaseCallbacks = new Set();

export function setPipelinePhase(phase) {
    if (pipelinePhase === phase) return;
    pipelinePhase = phase;
    for (const cb of [...pipelinePhaseCallbacks]) {
        try { cb(); } catch (err) { console.warn('[DLE] Pipeline phase callback error:', err.message); }
    }
}

export function onPipelinePhaseChanged(cb) {
    pipelinePhaseCallbacks.add(cb);
    return () => pipelinePhaseCallbacks.delete(cb);
}

/** Pre-computed entity name Set for AI cache sliding window check */
export let entityNameSet = new Set();
export function setEntityNameSet(v) { entityNameSet = v; }

/** Pre-compiled word-boundary regexes for short entity names (≤3 chars) */
export let entityShortNameRegexes = new Map();
/** Monotonic version counter bumped whenever entityShortNameRegexes is rebuilt.
 *  Consumers (e.g. aiSearchCache) can stamp this at write time and compare on read
 *  to detect post-rebuild staleness. (BUG-394) */
export let entityRegexVersion = 0;
export function setEntityShortNameRegexes(v) { entityShortNameRegexes = v; entityRegexVersion++; }

/** BM25 fuzzy search index: { idf: Map<term, number>, docs: Map<title, {tf: Map<term, number>, len: number}>, avgDl: number } */
export let fuzzySearchIndex = null;
export function setFuzzySearchIndex(v) { fuzzySearchIndex = v; }

// ── Librarian: tool-assisted lore retrieval + gap detection ──

/** Librarian: gap records for current chat (hydrated from chat_metadata.deeplore_lore_gaps) */
export let loreGaps = [];
export function setLoreGaps(v) { loreGaps = v; notifyLoreGapsChanged(); }

/** Librarian: per-generation search_lore call counter (reset at generation start) */
export let loreGapSearchCount = 0;
export function setLoreGapSearchCount(v) { loreGapSearchCount = v; }

/** Librarian: session-scoped stats (reset on page load, NOT persisted) */
export let librarianSessionStats = { searchCalls: 0, flagCalls: 0, estimatedExtraTokens: 0 };
export function setLibrarianSessionStats(v) { librarianSessionStats = v; }

/** Librarian: per-chat stats (reset on CHAT_CHANGED) */
export let librarianChatStats = { searchCalls: 0, flagCalls: 0, estimatedExtraTokens: 0 };
export function setLibrarianChatStats(v) { librarianChatStats = v; }

/** Custom field definitions: loaded from Obsidian YAML or defaults */
/** @type {import('./fields.js').FieldDefinition[]} */
export let fieldDefinitions = [];
export let fieldDefinitionsLoaded = false;
export function setFieldDefinitions(v) { fieldDefinitions = v; fieldDefinitionsLoaded = true; notifyFieldDefinitionsUpdated(); }
export function setFieldDefinitionsLoaded(v) { fieldDefinitionsLoaded = v; }

/** Cross-entry mention weights: Map<"sourceTitle\0targetTitle", count>
 *  Counts how many times each entry's content mentions another entry's title/keys.
 *  Built during finalizeIndex(), cached in IndexedDB with the rest of the index. */
export let mentionWeights = new Map();
export function setMentionWeights(v) { mentionWeights = v; }

// ── AI service circuit breaker ──
// Prevents repeated full-timeout waits when AI services are down.
// Mirrors the per-vault Obsidian circuit breaker pattern.
export let aiCircuitOpen = false;
export let aiCircuitFailures = 0;
export let aiCircuitOpenedAt = 0;
/** BUG-025: Half-open probe gate — allows exactly one caller through after cooldown */
let aiCircuitHalfOpenProbe = false;
const AI_CIRCUIT_THRESHOLD = 2;      // consecutive failures to trip
const AI_CIRCUIT_COOLDOWN = 30_000;  // ms before half-open probe
export function setAiCircuitOpenedAt(v) { aiCircuitOpenedAt = v; }

export function recordAiFailure() {
    const wasClosed = !aiCircuitOpen;
    if (aiCircuitHalfOpenProbe) {
        aiCircuitHalfOpenProbe = false;
        aiCircuitProbeTimestamp = 0;
    }
    aiCircuitFailures++;
    if (aiCircuitFailures >= AI_CIRCUIT_THRESHOLD) {
        aiCircuitOpen = true;
        // Always refresh the opened-at timestamp so the cooldown resets on each failure
        aiCircuitOpenedAt = Date.now();
    }
    // Notify observers if state changed (closed → open)
    if (wasClosed && aiCircuitOpen) {
        pushEventSafe('ai_circuit', { from: 'closed', to: 'open', failures: aiCircuitFailures });
        notifyCircuitStateChanged();
    }
}
export function recordAiSuccess() {
    const wasOpen = aiCircuitOpen;
    aiCircuitHalfOpenProbe = false;
    aiCircuitProbeTimestamp = 0;
    aiCircuitFailures = 0;
    aiCircuitOpen = false;
    aiCircuitOpenedAt = 0;
    // Notify observers if state changed (open → closed)
    if (wasOpen) {
        pushEventSafe('ai_circuit', { from: 'open', to: 'closed' });
        notifyCircuitStateChanged();
    }
}
/** Release the half-open probe without recording success or failure.
 *  Used by hierarchicalPreFilter: its outcome shouldn't affect the circuit breaker
 *  since the main aiSearch() call handles its own probing independently. */
export function releaseHalfOpenProbe() {
    aiCircuitHalfOpenProbe = false;
    aiCircuitProbeTimestamp = 0;
}
/**
 * Circuit breaker state machine (3 states):
 *   CLOSED  — aiCircuitOpen=false, all calls pass through normally.
 *   OPEN    — aiCircuitOpen=true, cooldown not expired. All calls blocked.
 *   HALF-OPEN — aiCircuitOpen=true, cooldown expired. Exactly ONE probe call
 *              is allowed through (via atomic aiCircuitHalfOpenProbe flag).
 *              If the probe succeeds → recordAiSuccess() → CLOSED.
 *              If the probe fails → recordAiFailure() → OPEN (timer reset).
 *
 * The atomic probe flag (BUG-025) prevents thundering herd: if multiple
 * callers check simultaneously after cooldown, only the first gets through.
 *
 * BUG-AUDIT-1: Split into pure query (isAiCircuitOpen) vs probe acquisition
 * (tryAcquireHalfOpenProbe). UI code must use isAiCircuitOpen() which never
 * mutates state. AI callers use tryAcquireHalfOpenProbe() to claim the probe.
 * BUG-AUDIT-2: Probe has a 60s timeout — if neither success nor failure is
 * recorded, the probe flag auto-resets so the circuit can retry.
 */
const AI_PROBE_TIMEOUT = 60_000; // ms before stale probe auto-resets
let aiCircuitProbeTimestamp = 0;

/** Pure query: is the circuit breaker blocking calls? Does NOT mutate state.
 *  Use this in UI rendering, status checks, and non-AI code paths. */
export function isAiCircuitOpen() {
    if (!aiCircuitOpen) return false;
    if (Date.now() - aiCircuitOpenedAt > AI_CIRCUIT_COOLDOWN) {
        // Cooldown expired — half-open state. If probe is dispatched and not stale, block.
        if (aiCircuitHalfOpenProbe) {
            // BUG-FIX: Stale probe detection moved to tryAcquireHalfOpenProbe() —
            // query functions must not mutate state to avoid races between concurrent callers.
            if (Date.now() - aiCircuitProbeTimestamp > AI_PROBE_TIMEOUT) {
                return false; // probe looks stale — report as open for new probe (actual reset in tryAcquire)
            }
            return true; // probe in flight, block others
        }
        return false; // no probe dispatched — caller should use tryAcquireHalfOpenProbe
    }
    return true; // still in cooldown
}

/** Attempt to acquire the half-open probe slot. Returns true if this caller
 *  got the probe (should proceed with AI call). Returns false if blocked.
 *  Only call this from actual AI call paths (aiSearch, hierarchicalPreFilter). */
export function tryAcquireHalfOpenProbe() {
    if (!aiCircuitOpen) return true; // circuit closed, all pass
    if (Date.now() - aiCircuitOpenedAt > AI_CIRCUIT_COOLDOWN) {
        if (aiCircuitHalfOpenProbe) {
            // Check for stale probe before blocking
            if (Date.now() - aiCircuitProbeTimestamp > AI_PROBE_TIMEOUT) {
                // Stale probe — reset and fall through to re-acquire atomically
            } else {
                return false; // probe already dispatched, block
            }
        }
        // Atomic acquire: set both flag and timestamp together before returning
        aiCircuitHalfOpenProbe = true;
        aiCircuitProbeTimestamp = Date.now();
        return true; // acquired probe — caller must call recordAiSuccess or recordAiFailure
    }
    return false; // still in cooldown
}

// ── Observer callbacks ──
// DLE uses a simple observer pattern to break circular dependencies between data
// and UI layers. Producers (vault.js, ai.js, pipeline.js) call notify*() functions;
// consumers (drawer, settings-ui) register via on*() during init.
//
// The clear*Callbacks() functions exist for completeness but are intentionally never
// called — the extension initializes once when SillyTavern loads and never tears down.
// There is no unmount/destroy lifecycle for ST extensions, so callbacks accumulate
// exactly once and persist for the page lifetime. This is by design, not a leak.

// ── Index lifecycle callbacks ──
// Registered by the UI layer so the data layer (vault.js) can notify without importing UI modules.
// This breaks the vault.js → settings-ui.js inverted dependency.

// BUG-026: All observer registries use Set + return-unsubscribe. This mirrors
// the canonical claudeAutoEffortObservers pattern (line 134 above) and makes
// callers responsible for releasing their subscriptions on teardown. Existing
// clear*Callbacks exports are retained for CHAT_CHANGED flushes and test setup.

/** @type {Set<() => void>} */
const indexUpdatedCallbacks = new Set();

/** Register a callback; returns an unsubscribe function. */
export function onIndexUpdated(callback) {
    indexUpdatedCallbacks.add(callback);
    return () => indexUpdatedCallbacks.delete(callback);
}

export function notifyIndexUpdated() {
    for (const cb of [...indexUpdatedCallbacks]) {
        try { cb(); } catch (err) { console.warn('[DLE] Index update callback error:', err.message); }
    }
}

// ── AI stats lifecycle callbacks ──

/** @type {Set<() => void>} */
const aiStatsCallbacks = new Set();

export function onAiStatsUpdated(callback) {
    aiStatsCallbacks.add(callback);
    return () => aiStatsCallbacks.delete(callback);
}

export function notifyAiStatsUpdated() {
    for (const cb of [...aiStatsCallbacks]) {
        try { cb(); } catch (err) { console.warn('[DLE] AI stats callback error:', err.message); }
    }
}

// ── AI circuit breaker state callbacks ──

/** @type {Set<() => void>} */
const circuitStateCallbacks = new Set();

export function onCircuitStateChanged(callback) {
    circuitStateCallbacks.add(callback);
    return () => circuitStateCallbacks.delete(callback);
}

export function notifyCircuitStateChanged() {
    for (const cb of [...circuitStateCallbacks]) {
        try { cb(); } catch (err) { console.warn('[DLE] Circuit state callback error:', err.message); }
    }
}

// ── Pipeline complete callbacks ──

/** @type {Set<() => void>} */
const pipelineCompleteCallbacks = new Set();

export function onPipelineComplete(callback) {
    pipelineCompleteCallbacks.add(callback);
    return () => pipelineCompleteCallbacks.delete(callback);
}

export function clearPipelineCompleteCallbacks() { pipelineCompleteCallbacks.clear(); }

export function notifyPipelineComplete() {
    for (const cb of [...pipelineCompleteCallbacks]) {
        try { cb(); } catch (err) { console.warn('[DLE] Pipeline complete callback error:', err.message); }
    }
}

// ── Injection sources ready callbacks ──
// Fires when lastInjectionSources is set, BEFORE notifyPipelineComplete.
// Used by the drawer to populate the Why? tab early (before agentic loop / ST generation).

/** @type {Set<() => void>} */
const injectionSourcesReadyCallbacks = new Set();

export function onInjectionSourcesReady(callback) {
    injectionSourcesReadyCallbacks.add(callback);
    return () => injectionSourcesReadyCallbacks.delete(callback);
}

export function notifyInjectionSourcesReady() {
    for (const cb of [...injectionSourcesReadyCallbacks]) {
        try { cb(); } catch (err) { console.warn('[DLE] Injection sources ready callback error:', err.message); }
    }
}

// ── Gating changed callbacks ──

/** @type {Set<() => void>} */
const gatingChangedCallbacks = new Set();

export function onGatingChanged(callback) {
    gatingChangedCallbacks.add(callback);
    return () => gatingChangedCallbacks.delete(callback);
}

export function clearGatingCallbacks() { gatingChangedCallbacks.clear(); }

export function notifyGatingChanged() {
    setAiSearchCache({ hash: '', manifestHash: '', chatLineCount: 0, results: [], matchedEntrySet: null });
    for (const cb of [...gatingChangedCallbacks]) {
        try { cb(); } catch (err) { console.warn('[DLE] Gating changed callback error:', err.message); }
    }
}

// ── Pin/block changed callbacks ──

/** @type {Set<() => void>} */
const pinBlockChangedCallbacks = new Set();

export function onPinBlockChanged(callback) {
    pinBlockChangedCallbacks.add(callback);
    return () => pinBlockChangedCallbacks.delete(callback);
}

export function clearPinBlockCallbacks() { pinBlockChangedCallbacks.clear(); }

export function notifyPinBlockChanged() {
    setAiSearchCache({ hash: '', manifestHash: '', chatLineCount: 0, results: [], matchedEntrySet: null });
    for (const cb of [...pinBlockChangedCallbacks]) {
        try { cb(); } catch (err) { console.warn('[DLE] Pin/block changed callback error:', err.message); }
    }
}

// ── Generation lock changed callbacks ──

/** @type {Set<() => void>} */
const generationLockCallbacks = new Set();

export function onGenerationLockChanged(callback) {
    generationLockCallbacks.add(callback);
    return () => generationLockCallbacks.delete(callback);
}

export function clearGenerationLockCallbacks() { generationLockCallbacks.clear(); }

function notifyGenerationLockChanged() {
    for (const cb of [...generationLockCallbacks]) {
        try { cb(); } catch (err) { console.warn('[DLE] Generation lock callback error:', err.message); }
    }
}

// ── Field definitions changed callbacks ──

/** @type {Set<() => void>} */
const fieldDefinitionsCallbacks = new Set();

export function onFieldDefinitionsUpdated(callback) {
    fieldDefinitionsCallbacks.add(callback);
    return () => fieldDefinitionsCallbacks.delete(callback);
}

function notifyFieldDefinitionsUpdated() {
    setAiSearchCache({ hash: '', manifestHash: '', chatLineCount: 0, results: [], matchedEntrySet: null });
    for (const cb of [...fieldDefinitionsCallbacks]) {
        try { cb(); } catch (err) { console.warn('[DLE] Field definitions callback error:', err.message); }
    }
}

// ── Indexing state changed callbacks ──

/** @type {Set<() => void>} */
const indexingChangedCallbacks = new Set();

export function onIndexingChanged(callback) {
    indexingChangedCallbacks.add(callback);
    return () => indexingChangedCallbacks.delete(callback);
}

function notifyIndexingChanged() {
    for (const cb of [...indexingChangedCallbacks]) {
        try { cb(); } catch (err) { console.warn('[DLE] Indexing changed callback error:', err.message); }
    }
}

// ── Lore gaps changed callbacks ──

/** @type {Set<() => void>} */
const loreGapsChangedCallbacks = new Set();

export function onLoreGapsChanged(callback) {
    loreGapsChangedCallbacks.add(callback);
    return () => loreGapsChangedCallbacks.delete(callback);
}

export function clearLoreGapsCallbacks() { loreGapsChangedCallbacks.clear(); }

export function notifyLoreGapsChanged() {
    for (const cb of [...loreGapsChangedCallbacks]) {
        try { cb(); } catch (err) { console.warn('[DLE] Lore gaps changed callback error:', err.message); }
    }
}

// ── Overall status computation ──

/**
 * Compute the overall system status for the header badge.
 * Pure function that reads current state values.
 * @param {{ state: string, failures: number }} [obsidianCircuitState] - Aggregate Obsidian circuit breaker state (from getCircuitState())
 * @returns {'ok'|'degraded'|'limited'|'offline'}
 */
export function computeOverallStatus(obsidianCircuitState) {
    const hasEntries = vaultIndex.length > 0;
    const allVaultsFailed = lastVaultAttemptCount > 0 && lastVaultFailureCount >= lastVaultAttemptCount;
    const someVaultsFailed = lastVaultFailureCount > 0 && lastVaultFailureCount < lastVaultAttemptCount;
    const circuitTripped = isAiCircuitOpen();
    const usingStaleCache = hasEntries && !indexEverLoaded;
    const obsidianDown = obsidianCircuitState?.state === 'open';

    // Red: no vaults reachable AND no cached data
    if (!hasEntries && (allVaultsFailed || obsidianDown || lastVaultAttemptCount === 0)) {
        return 'offline';
    }

    // Orange: AI circuit breaker tripped, Obsidian circuit open, or running from stale cache only
    if (circuitTripped || obsidianDown || usingStaleCache) {
        return 'limited';
    }

    // Yellow: some vaults unreachable, or health grade is B/C/D
    if (someVaultsFailed) {
        return 'degraded';
    }
    if (lastHealthResult) {
        const { errors, warnings } = lastHealthResult;
        // Grade B or worse: errors > 0, or warnings > 3
        if (errors > 0 || warnings > 3) {
            return 'degraded';
        }
    }

    // Green: all good
    return 'ok';
}
