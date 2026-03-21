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

/** Last health check result for settings badge */
export let lastHealthResult = null;

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
export function setLastHealthResult(v) { lastHealthResult = v; }
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
}
export function setGenerationLockEpoch(v) { generationLockEpoch = v; }

/** Pre-computed entity name Set for AI cache sliding window check */
export let entityNameSet = new Set();
export function setEntityNameSet(v) { entityNameSet = v; }

/** Pre-compiled word-boundary regexes for short entity names (≤3 chars) */
export let entityShortNameRegexes = new Map();
export function setEntityShortNameRegexes(v) { entityShortNameRegexes = v; }

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
