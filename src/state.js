/**
 * DeepLore Enhanced — Shared mutable state
 * All globals live here; modules import and read/write directly.
 */

/** @type {import('../core/pipeline.js').VaultEntry[]} */
export let vaultIndex = [];
export let indexTimestamp = 0;
export let indexing = false;
/** @type {Promise<void>|null} In-progress build promise for deduplication */
export let buildPromise = null;
/** Whether vault has ever successfully loaded */
export let indexEverLoaded = false;

/** AI search result cache (sliding window: tracks manifest + chat lines separately) */
export let aiSearchCache = { hash: '', manifestHash: '', chatLineCount: 0, results: [] };

/** Session-scoped AI search usage stats */
export let aiSearchStats = { calls: 0, cachedHits: 0, totalInputTokens: 0, totalOutputTokens: 0 };

/** Context Cartographer: sources from the last generation interceptor run */
export let lastInjectionSources = null;

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
export function setIndexTimestamp(v) { indexTimestamp = v; }
export function setIndexing(v) { indexing = v; }
export function setBuildPromise(v) { buildPromise = v; }
export function setIndexEverLoaded(v) { indexEverLoaded = v; }
export function setAiSearchCache(v) { aiSearchCache = v; }
export function setLastInjectionSources(v) { lastInjectionSources = v; }
export function setLastScribeChatLength(v) { lastScribeChatLength = v; }
export function setScribeInProgress(v) { scribeInProgress = v; }
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

/** Pre-computed entity name Set for AI cache sliding window check */
export let entityNameSet = new Set();
export function setEntityNameSet(v) { entityNameSet = v; }

/** Pre-compiled word-boundary regexes for short entity names (≤3 chars) */
export let entityShortNameRegexes = new Map();
export function setEntityShortNameRegexes(v) { entityShortNameRegexes = v; }

/** BM25 fuzzy search index: { idf: Map<term, number>, docs: Map<title, {tf: Map<term, number>, len: number}>, avgDl: number } */
export let fuzzySearchIndex = null;
export function setFuzzySearchIndex(v) { fuzzySearchIndex = v; }

// ── AI service circuit breaker ──
// Prevents repeated full-timeout waits when AI services are down.
// Mirrors the per-vault Obsidian circuit breaker pattern.
export let aiCircuitOpen = false;
export let aiCircuitFailures = 0;
export let aiCircuitOpenedAt = 0;
const AI_CIRCUIT_THRESHOLD = 2;      // consecutive failures to trip
const AI_CIRCUIT_COOLDOWN = 30_000;  // ms before half-open probe

export function recordAiFailure() {
    const wasClosed = !aiCircuitOpen;
    aiCircuitFailures++;
    if (aiCircuitFailures >= AI_CIRCUIT_THRESHOLD) {
        aiCircuitOpen = true;
        // Always refresh the opened-at timestamp so the cooldown resets on each failure
        aiCircuitOpenedAt = Date.now();
    }
    // Notify observers if state changed (closed → open)
    if (wasClosed && aiCircuitOpen) notifyCircuitStateChanged();
}
export function recordAiSuccess() {
    const wasOpen = aiCircuitOpen;
    aiCircuitFailures = 0;
    aiCircuitOpen = false;
    aiCircuitOpenedAt = 0;
    // Notify observers if state changed (open → closed)
    if (wasOpen) notifyCircuitStateChanged();
}
export function isAiCircuitOpen() {
    if (!aiCircuitOpen) return false;
    // Half-open: allow a probe after cooldown
    if (Date.now() - aiCircuitOpenedAt > AI_CIRCUIT_COOLDOWN) return false;
    return true;
}

// ── Index lifecycle callbacks ──
// Registered by the UI layer so the data layer (vault.js) can notify without importing UI modules.
// This breaks the vault.js → settings-ui.js inverted dependency.

/** @type {Array<() => void>} */
const indexUpdatedCallbacks = [];

/** Register a callback to run after the vault index is updated (built, delta-synced, or hydrated). */
export function onIndexUpdated(callback) {
    indexUpdatedCallbacks.push(callback);
}


/** Invoke all registered index-updated callbacks. Called by vault.js after index changes. */
export function notifyIndexUpdated() {
    for (const cb of indexUpdatedCallbacks) {
        try { cb(); } catch (err) { console.warn('[DLE] Index update callback error:', err.message); }
    }
}

// ── AI stats lifecycle callbacks ──
// Same observer pattern: breaks the ai.js → settings-ui.js circular dependency.

/** @type {Array<() => void>} */
const aiStatsCallbacks = [];

/** Register a callback to run when AI search stats are updated. */
export function onAiStatsUpdated(callback) {
    aiStatsCallbacks.push(callback);
}


/** Invoke all registered AI stats callbacks. Called by ai.js after stats change. */
export function notifyAiStatsUpdated() {
    for (const cb of aiStatsCallbacks) {
        try { cb(); } catch (err) { console.warn('[DLE] AI stats callback error:', err.message); }
    }
}

// ── AI circuit breaker state callbacks ──
// Same observer pattern: notifies UI when the circuit breaker opens or closes.

/** @type {Array<() => void>} */
const circuitStateCallbacks = [];

/** Register a callback to run when the AI circuit breaker state changes. */
export function onCircuitStateChanged(callback) {
    circuitStateCallbacks.push(callback);
}


/** Invoke all registered circuit state callbacks. Called by recordAiFailure/recordAiSuccess on state transitions. */
export function notifyCircuitStateChanged() {
    for (const cb of circuitStateCallbacks) {
        try { cb(); } catch (err) { console.warn('[DLE] Circuit state callback error:', err.message); }
    }
}

// ── Pipeline complete callbacks ──
// Fired after onGenerate completes (success or failure). Drawer uses this to update injection tab, status zone.

/** @type {Array<() => void>} */
const pipelineCompleteCallbacks = [];

export function onPipelineComplete(callback) {
    pipelineCompleteCallbacks.push(callback);
}

export function clearPipelineCompleteCallbacks() { pipelineCompleteCallbacks.length = 0; }

export function notifyPipelineComplete() {
    for (const cb of pipelineCompleteCallbacks) {
        try { cb(); } catch (err) { console.warn('[DLE] Pipeline complete callback error:', err.message); }
    }
}

// ── Gating changed callbacks ──
// Fired after gating commands modify chat_metadata.deeplore_context.

/** @type {Array<() => void>} */
const gatingChangedCallbacks = [];

export function onGatingChanged(callback) {
    gatingChangedCallbacks.push(callback);
}

export function clearGatingCallbacks() { gatingChangedCallbacks.length = 0; }

export function notifyGatingChanged() {
    for (const cb of gatingChangedCallbacks) {
        try { cb(); } catch (err) { console.warn('[DLE] Gating changed callback error:', err.message); }
    }
}

// ── Pin/block changed callbacks ──
// Fired after pin/block commands modify chat_metadata.deeplore_pins/blocks.

/** @type {Array<() => void>} */
const pinBlockChangedCallbacks = [];

export function onPinBlockChanged(callback) {
    pinBlockChangedCallbacks.push(callback);
}

export function clearPinBlockCallbacks() { pinBlockChangedCallbacks.length = 0; }

export function notifyPinBlockChanged() {
    for (const cb of pinBlockChangedCallbacks) {
        try { cb(); } catch (err) { console.warn('[DLE] Pin/block changed callback error:', err.message); }
    }
}

// ── Generation lock changed callbacks ──
// Fired when generationLock toggles (pipeline start/end). Drawer uses this for the "Choosing Lore..." label.

/** @type {Array<() => void>} */
const generationLockCallbacks = [];

export function onGenerationLockChanged(callback) {
    generationLockCallbacks.push(callback);
}

export function clearGenerationLockCallbacks() { generationLockCallbacks.length = 0; }

function notifyGenerationLockChanged() {
    for (const cb of generationLockCallbacks) {
        try { cb(); } catch (err) { console.warn('[DLE] Generation lock callback error:', err.message); }
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
