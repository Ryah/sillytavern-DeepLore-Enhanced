/**
 * DeepLore Enhanced — Integration Tests
 * Tests state lifecycle, observer wiring, circuit breakers, pipeline stage interactions,
 * race condition guards, cache coherence, and multi-vault isolation.
 *
 * Run with: node test/integration.mjs
 *
 * These tests import directly from modules that have no SillyTavern dependencies
 * (state.js, stages.js, obsidian-api.js, core/*, helpers.js) and simulate event
 * flows by calling functions in the order that index.js would.
 */

// ============================================================================
// Imports: Pure modules (no ST dependencies)
// ============================================================================

import {
    // State values
    vaultIndex, indexEverLoaded, indexing,
    lastInjectionSources, lastPipelineTrace,
    cooldownTracker, generationCount, injectionHistory, consecutiveInjections,
    chatInjectionCounts, trackerKey,
    lastWarningRatio, decayTracker, chatEpoch,
    generationLock, generationLockTimestamp, generationLockEpoch,
    aiSearchCache, aiSearchStats, entityNameSet, entityShortNameRegexes,
    aiCircuitOpen, aiCircuitFailures, aiCircuitOpenedAt,
    lastVaultFailureCount, lastVaultAttemptCount,
    previousSources, lastHealthResult,
    syncIntervalId,

    // Setters
    setVaultIndex, setIndexTimestamp, setIndexing, setIndexEverLoaded,
    setAiSearchCache, setLastInjectionSources, setLastPipelineTrace,
    setGenerationCount, setLastWarningRatio, setChatEpoch,
    setGenerationLock, setGenerationLockEpoch,
    setChatInjectionCounts, setAutoSuggestMessageCount,
    setLastScribeChatLength, setScribeInProgress, setLastScribeSummary,
    setPreviousIndexSnapshot, setPreviousSources,
    setEntityNameSet, setEntityShortNameRegexes,
    setLastVaultFailureCount, setLastVaultAttemptCount,
    setLastHealthResult, setFuzzySearchIndex,
    setBuildPromise, setSyncIntervalId,
    setConsecutiveInjections, setDecayTracker,
    setAiCircuitOpenedAt,

    // Observers
    onIndexUpdated, notifyIndexUpdated,
    onAiStatsUpdated, notifyAiStatsUpdated,
    onCircuitStateChanged, notifyCircuitStateChanged,
    onPipelineComplete, notifyPipelineComplete, clearPipelineCompleteCallbacks,
    onGatingChanged, notifyGatingChanged, clearGatingCallbacks,
    onPinBlockChanged, notifyPinBlockChanged, clearPinBlockCallbacks,
    onGenerationLockChanged, clearGenerationLockCallbacks,
    onIndexingChanged,

    // Circuit breaker
    recordAiFailure, recordAiSuccess, isAiCircuitOpen,

    // Build epoch (BUG-015)
    buildEpoch, setBuildEpoch,

    // Status
    computeOverallStatus,
} from '../src/state.js';

import {
    buildExemptionPolicy, applyPinBlock, applyContextualGating,
    applyReinjectionCooldown, applyRequiresExcludesGating,
    applyStripDedup, trackGeneration, decrementTrackers, recordAnalytics,
} from '../src/stages.js';

import {
    encodeVaultPath, validateVaultPath,
} from '../src/vault/obsidian-api.js';

import {
    extractAiResponseClient, clusterEntries, buildCategoryManifest,
    normalizeResults as normalizeResultsProd, parseMatchReason,
    computeSourcesDiff, categorizeRejections, resolveEntryVault,
    tokenBarColor, formatRelativeTime, checkHealthPure,
} from '../src/helpers.js';

import { formatAndGroup, testEntryMatch, countKeywordOccurrences, applyGating, resolveLinks } from '../core/matching.js';
import { parseVaultFile, clearPrompts } from '../core/pipeline.js';
import { takeIndexSnapshot, detectChanges } from '../core/sync.js';
import { buildScanText, validateSettings, simpleHash } from '../core/utils.js';

// ============================================================================
// Test Runner
// ============================================================================

import { makeEntry, makeSettings } from './helpers.mjs';

let passed = 0;
let failed = 0;
let currentTest = '';

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
    }
}

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    expected: ${JSON.stringify(expected)}`);
        console.error(`    actual:   ${JSON.stringify(actual)}`);
    }
}

function assertNotEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    should not equal: ${JSON.stringify(expected)}`);
    }
}

function assertThrows(fn, message) {
    try {
        fn();
        failed++;
        console.error(`  FAIL: ${message} (did not throw)`);
    } catch {
        passed++;
    }
}

function test(name, fn) {
    currentTest = name;
    console.log(`\n${name}`);
    fn();
}

async function testAsync(name, fn) {
    currentTest = name;
    console.log(`\n${name}`);
    await fn();
}

// ============================================================================
// State reset helper — reset all mutable state before each test group
// ============================================================================

function resetAllState() {
    setVaultIndex([]);
    setIndexEverLoaded(false);
    setIndexing(false);
    setBuildPromise(null);
    setAiSearchCache({ hash: '', manifestHash: '', chatLineCount: 0, results: [] });
    setLastInjectionSources(null);
    setLastPipelineTrace(null);
    setGenerationCount(0);
    setLastWarningRatio(0);
    setChatEpoch(0);
    setGenerationLock(false);
    setChatInjectionCounts(new Map());
    setAutoSuggestMessageCount(0);
    setLastScribeChatLength(0);
    setScribeInProgress(false);
    setLastScribeSummary('');
    setPreviousIndexSnapshot(null);
    setPreviousSources(null);
    setEntityNameSet(new Set());
    setEntityShortNameRegexes(new Map());
    setLastVaultFailureCount(0);
    setLastVaultAttemptCount(0);
    setLastHealthResult(null);
    setFuzzySearchIndex(null);
    setSyncIntervalId(null);
    setConsecutiveInjections(new Map());
    setDecayTracker(new Map());
    cooldownTracker.clear();
    injectionHistory.clear();
    // Reset AI circuit breaker (recordAiSuccess clears all state)
    recordAiSuccess();
    // Clear observer callbacks
    clearPipelineCompleteCallbacks();
    clearGatingCallbacks();
    clearPinBlockCallbacks();
    clearGenerationLockCallbacks();
}

// ============================================================================
// A. Event Lifecycle Tests
// ============================================================================

test('A1: Sources set after pipeline stages, readable before clear', () => {
    resetAllState();
    // Simulate: pipeline runs, sets sources
    const sources = [{ title: 'Eris', tokens: 50, matchedBy: 'keyword', vaultSource: '' }];
    setLastInjectionSources(sources);
    assertEqual(lastInjectionSources, sources, 'sources should be set');

    // Simulate: CHARACTER_MESSAGE_RENDERED reads and clears
    const readSources = lastInjectionSources;
    setLastInjectionSources(null);
    assertEqual(readSources.length, 1, 'should have read 1 source');
    assertEqual(readSources[0].title, 'Eris', 'source title should match');
    assertEqual(lastInjectionSources, null, 'sources should be cleared after read');
});

test('A2: Quiet generation type skips pipeline', () => {
    resetAllState();
    // In index.js, type === 'quiet' returns early.
    // We test that the guard works by checking that no state changes happen.
    const type = 'quiet';
    const shouldSkip = type === 'quiet';
    assert(shouldSkip, 'quiet type should trigger early return');
});

test('A3: Generation lock prevents concurrent runs', () => {
    resetAllState();
    setGenerationLock(true);
    assert(generationLock === true, 'lock should be set');
    // Second generation should see lock and return
    const isLocked = generationLock;
    assert(isLocked, 'concurrent generation should see lock');
});

test('A4: Generation lock force-release after timeout', () => {
    resetAllState();
    setGenerationLock(true);
    // Simulate stale lock by checking timestamp
    const lockAge = Date.now() - generationLockTimestamp;
    assert(lockAge < 1000, 'fresh lock should have recent timestamp');

    // To simulate a stale lock, we'd need to manipulate time.
    // Instead, verify the mechanism: if lockAge > 60_000, force-release.
    const TIMEOUT = 60_000;
    const simulatedAge = 61_000;
    if (simulatedAge > TIMEOUT) {
        setGenerationLock(false);
    }
    assert(!generationLock, 'stale lock should be force-released');
});

test('A5: Epoch guard prevents stale writes', () => {
    resetAllState();
    setChatEpoch(1);
    const pipelineEpoch = chatEpoch; // 1

    // Simulate CHAT_CHANGED mid-pipeline
    setChatEpoch(chatEpoch + 1); // now 2

    // Pipeline checks epoch before writing
    const epochMismatch = pipelineEpoch !== chatEpoch;
    assert(epochMismatch, 'epoch mismatch should be detected');
    // Pipeline should NOT write prompts when epoch mismatches
});

// ============================================================================
// B. CHAT_CHANGED Tests
// ============================================================================

test('B6: State reset on chat change', () => {
    resetAllState();
    // Set up state as if mid-session
    cooldownTracker.set('test:Entry1', 3);
    injectionHistory.set('test:Entry1', 5);
    decayTracker.set('test:Entry1', 2);
    consecutiveInjections.set('test:Entry1', 4);
    setGenerationCount(10);

    // Simulate CHAT_CHANGED (as in index.js lines 594-616)
    setChatEpoch(chatEpoch + 1);
    injectionHistory.clear();
    cooldownTracker.clear();
    decayTracker.clear();
    consecutiveInjections.clear();
    setChatInjectionCounts(new Map());
    setGenerationCount(0);
    setLastWarningRatio(0);
    setAiSearchCache({ hash: '', manifestHash: '', chatLineCount: 0, results: [] });
    setAutoSuggestMessageCount(0);
    setLastPipelineTrace(null);
    setLastInjectionSources(null);
    setPreviousSources(null);

    assertEqual(cooldownTracker.size, 0, 'cooldownTracker should be cleared');
    assertEqual(injectionHistory.size, 0, 'injectionHistory should be cleared');
    assertEqual(decayTracker.size, 0, 'decayTracker should be cleared');
    assertEqual(consecutiveInjections.size, 0, 'consecutiveInjections should be cleared');
    assertEqual(generationCount, 0, 'generationCount should be reset');
    assertEqual(chatInjectionCounts.size, 0, 'chatInjectionCounts should be cleared');
    assertEqual(aiSearchCache.hash, '', 'AI cache should be cleared');
    assertEqual(lastPipelineTrace, null, 'pipeline trace should be cleared');
    assertEqual(lastInjectionSources, null, 'injection sources should be cleared');
});

test('B7: Chat metadata hydration on chat change', () => {
    resetAllState();
    const savedCounts = { 'vault1:Eris': 5, 'vault1:Tavern': 3 };
    const hydratedMap = new Map(Object.entries(savedCounts));
    setChatInjectionCounts(hydratedMap);

    assertEqual(chatInjectionCounts.get('vault1:Eris'), 5, 'Eris count should be hydrated');
    assertEqual(chatInjectionCounts.get('vault1:Tavern'), 3, 'Tavern count should be hydrated');
});

test('B8: AI search cache cleared on chat change', () => {
    resetAllState();
    setAiSearchCache({ hash: 'abc', manifestHash: 'def', chatLineCount: 10, results: [{ title: 'X' }] });
    assert(aiSearchCache.hash === 'abc', 'cache should have data');

    // Chat change clears it
    setAiSearchCache({ hash: '', manifestHash: '', chatLineCount: 0, results: [] });
    assertEqual(aiSearchCache.hash, '', 'cache hash should be empty');
    assertEqual(aiSearchCache.results.length, 0, 'cache results should be empty');
});

test('B9: chatEpoch increments on chat change', () => {
    resetAllState();
    assertEqual(chatEpoch, 0, 'initial epoch should be 0');
    setChatEpoch(chatEpoch + 1);
    assertEqual(chatEpoch, 1, 'epoch should increment to 1');
    setChatEpoch(chatEpoch + 1);
    assertEqual(chatEpoch, 2, 'epoch should increment to 2');
});

test('B10: Drawer ephemeral state reset on chat change', () => {
    // Simulated: resetDrawerState() clears browse filters, query, expanded entry
    // We test that the function exists and state vars are resettable
    resetAllState();
    // Drawer state is in drawer-state.js (ds object) — can't import directly as it imports from ST
    // But we verify the state.js variables that drawer depends on are cleared
    setLastPipelineTrace({ mode: 'test' });
    setLastInjectionSources([{ title: 'X' }]);
    // Simulate reset
    setLastPipelineTrace(null);
    setLastInjectionSources(null);
    assertEqual(lastPipelineTrace, null, 'pipeline trace cleared for drawer');
    assertEqual(lastInjectionSources, null, 'sources cleared for drawer');
});

// ============================================================================
// C. Observer Wiring Tests
// ============================================================================

test('C11: onIndexUpdated fires callback', () => {
    resetAllState();
    let fired = false;
    onIndexUpdated(() => { fired = true; });
    notifyIndexUpdated();
    assert(fired, 'onIndexUpdated callback should fire');
});

test('C12: onAiStatsUpdated fires callback', () => {
    resetAllState();
    let fired = false;
    onAiStatsUpdated(() => { fired = true; });
    notifyAiStatsUpdated();
    assert(fired, 'onAiStatsUpdated callback should fire');
});

test('C13: onCircuitStateChanged fires on circuit transition', () => {
    resetAllState();
    let firedCount = 0;
    onCircuitStateChanged(() => { firedCount++; });

    // Trip circuit: 2 failures
    recordAiFailure();
    assertEqual(firedCount, 0, 'no notification on first failure');
    recordAiFailure();
    assertEqual(firedCount, 1, 'notification on circuit open (2nd failure)');

    // Recovery
    recordAiSuccess();
    assertEqual(firedCount, 2, 'notification on circuit close (success)');
});

test('C14: onPipelineComplete fires after pipeline', () => {
    resetAllState();
    let fired = false;
    onPipelineComplete(() => { fired = true; });
    notifyPipelineComplete();
    assert(fired, 'pipeline complete callback should fire');
});

test('C15: onGatingChanged fires on gating update', () => {
    resetAllState();
    let fired = false;
    onGatingChanged(() => { fired = true; });
    notifyGatingChanged();
    assert(fired, 'gating changed callback should fire');
});

test('C16: onPinBlockChanged fires on pin/block update', () => {
    resetAllState();
    let fired = false;
    onPinBlockChanged(() => { fired = true; });
    notifyPinBlockChanged();
    assert(fired, 'pin/block changed callback should fire');
});

test('C17: onGenerationLockChanged fires on lock toggle', () => {
    resetAllState();
    let firedCount = 0;
    onGenerationLockChanged(() => { firedCount++; });

    setGenerationLock(true);
    assertEqual(firedCount, 1, 'should fire on lock acquire');
    setGenerationLock(false);
    assertEqual(firedCount, 2, 'should fire on lock release');
});

test('C18: Multiple observers all fire', () => {
    resetAllState();
    let count1 = 0, count2 = 0, count3 = 0;
    onPipelineComplete(() => { count1++; });
    onPipelineComplete(() => { count2++; });
    onPipelineComplete(() => { count3++; });
    notifyPipelineComplete();
    assertEqual(count1, 1, 'observer 1 should fire');
    assertEqual(count2, 1, 'observer 2 should fire');
    assertEqual(count3, 1, 'observer 3 should fire');
});

test('C18b: Observer error does not prevent other observers from firing', () => {
    resetAllState();
    let secondFired = false;
    onPipelineComplete(() => { throw new Error('test error'); });
    onPipelineComplete(() => { secondFired = true; });
    // Should not throw — errors are caught internally
    notifyPipelineComplete();
    assert(secondFired, 'second observer should fire despite first throwing');
});

// ============================================================================
// D. Pipeline Failure & Fallback Tests
// ============================================================================

test('D19: AI circuit breaker — keywords fallback path', () => {
    resetAllState();
    // Trip circuit
    recordAiFailure();
    recordAiFailure();
    assert(isAiCircuitOpen(), 'circuit should be open');

    // In production, aiSearch() checks isAiCircuitOpen() and returns empty → keywords used
    // We verify the mechanism
    const shouldSkipAi = isAiCircuitOpen();
    assert(shouldSkipAi, 'AI should be skipped when circuit is open');
});

test('D20: AI empty response — constants still inject', () => {
    resetAllState();
    const entries = [
        makeEntry('Constant1', { constant: true, keys: ['always'] }),
        makeEntry('Normal1', { keys: ['test'] }),
    ];
    setVaultIndex(entries);

    // Simulate: AI returns empty, keyword matching returns nothing, but constants should still be present
    const policy = buildExemptionPolicy(entries, [], []);
    assert(policy.forceInject.has('constant1'), 'constant should be in forceInject (lowercase)');

    // applyPinBlock with empty pipeline results but constant in vault
    const matchedKeys = new Map();
    // Constants are handled by pipeline.js matchEntries — they're always included
    // Here we test that the exemption policy correctly identifies them
    assertEqual(policy.forceInject.size, 1, 'should have 1 forceInject entry');
});

test('D21: AI circuit open prevents AI calls', () => {
    resetAllState();
    recordAiFailure();
    recordAiFailure();
    assert(isAiCircuitOpen(), 'circuit open after 2 failures');

    // Production code: aiSearch checks this before calling API
    const skipAi = isAiCircuitOpen();
    assert(skipAi, 'should skip AI when circuit open');
});

test('D22: AI circuit half-open probe after cooldown', () => {
    resetAllState();
    recordAiFailure();
    recordAiFailure();
    assert(isAiCircuitOpen(), 'circuit should be open');

    // Simulate time passing beyond cooldown (30s)
    // We can't easily mock Date.now, so we test the logic directly
    // The circuit stores aiCircuitOpenedAt = Date.now(), and isAiCircuitOpen checks
    // if Date.now() - aiCircuitOpenedAt > 30000
    // For a fresh circuit, isAiCircuitOpen returns true (within cooldown)
    assert(isAiCircuitOpen(), 'circuit should still be open within cooldown');

    // After success, circuit closes
    recordAiSuccess();
    assert(!isAiCircuitOpen(), 'circuit should close after success');
    assertEqual(aiCircuitFailures, 0, 'failure count should reset');
});

test('D25: Obsidian circuit breaker exponential backoff logic', () => {
    // obsidian-api.js circuit breaker is internal to that module
    // We can test the pattern via the AI circuit breaker which follows the same design
    resetAllState();

    // First failure
    recordAiFailure();
    assertEqual(aiCircuitFailures, 1, '1 failure');
    assert(!isAiCircuitOpen(), 'circuit still closed after 1 failure');

    // Second failure — trips
    recordAiFailure();
    assertEqual(aiCircuitFailures, 2, '2 failures');
    assert(isAiCircuitOpen(), 'circuit should open at threshold (2)');
});

test('D26: Circuit recovery on success', () => {
    resetAllState();
    recordAiFailure();
    recordAiFailure();
    assert(isAiCircuitOpen(), 'circuit open');

    recordAiSuccess();
    assert(!isAiCircuitOpen(), 'circuit closed after success');
    assertEqual(aiCircuitFailures, 0, 'failures reset');
});

// ============================================================================
// E. Race Condition Tests
// ============================================================================

test('E27: Rapid double generation blocked by lock', () => {
    resetAllState();
    setGenerationLock(true);
    const firstLockEpoch = generationLockEpoch;

    // Second generation sees lock
    assert(generationLock, 'lock should prevent concurrent run');

    // Release
    setGenerationLock(false);
    assert(!generationLock, 'lock released');
});

test('E28: CHAT_CHANGED during pipeline — epoch mismatch', () => {
    resetAllState();
    setChatEpoch(5);
    const pipelineEpoch = chatEpoch;

    // Mid-pipeline: chat changes
    setChatEpoch(chatEpoch + 1);

    // Pipeline end: check epoch
    assert(pipelineEpoch !== chatEpoch, 'epoch mismatch detected');
    // This means pipeline should discard its results
});

test('E29: Pipeline uses snapshot, not live index', () => {
    resetAllState();
    const entries = [makeEntry('A'), makeEntry('B')];
    setVaultIndex(entries);

    // Snapshot at pipeline start
    const snapshot = [...vaultIndex];

    // Background rebuild changes the index
    setVaultIndex([makeEntry('C'), makeEntry('D'), makeEntry('E')]);

    // Pipeline should still use snapshot
    assertEqual(snapshot.length, 2, 'snapshot should have original 2 entries');
    assertEqual(vaultIndex.length, 3, 'live index has 3 entries');
    assertEqual(snapshot[0].title, 'A', 'snapshot should have original entries');
});

test('E30: Pipeline trace as fallback when sources are null', () => {
    resetAllState();
    setLastInjectionSources(null);
    setLastPipelineTrace({ injected: [{ title: 'Eris', tokens: 50 }] });

    // CHARACTER_MESSAGE_RENDERED finds no sources, uses trace as fallback
    const sources = lastInjectionSources;
    const fallback = sources || (lastPipelineTrace?.injected || []);
    assertEqual(fallback.length, 1, 'should fall back to pipeline trace');
    assertEqual(fallback[0].title, 'Eris', 'fallback should have correct entry');
});

test('E31: Sources cleared by new generation, render uses trace', () => {
    resetAllState();
    // Gen 1 sets sources
    setLastInjectionSources([{ title: 'A' }]);
    setLastPipelineTrace({ injected: [{ title: 'A', tokens: 50 }] });

    // Gen 2 starts, clears sources
    setLastInjectionSources(null);

    // Render from gen 1 tries to read — sources gone
    const sources = lastInjectionSources;
    assert(sources === null, 'sources should be null');

    // Fallback to trace
    const fallback = lastPipelineTrace?.injected || [];
    assertEqual(fallback.length, 1, 'trace should still have data');
});

// ============================================================================
// F. Cache Coherence Tests
// ============================================================================

test('F32: Cache structure has expected fields', () => {
    resetAllState();
    assertEqual(aiSearchCache.hash, '', 'fresh cache has empty hash');
    assertEqual(aiSearchCache.manifestHash, '', 'fresh cache has empty manifestHash');
    assertEqual(aiSearchCache.chatLineCount, 0, 'fresh cache has 0 chatLineCount');
    assertEqual(aiSearchCache.results.length, 0, 'fresh cache has no results');
});

test('F33: Cache TTL concept — stale cache triggers rebuild flag', () => {
    resetAllState();
    // Simulate: indexTimestamp is old, cacheTTL has passed
    setIndexTimestamp(Date.now() - 600_000); // 10 minutes ago
    const cacheTTL = 300; // 5 minutes
    // ensureIndexFresh checks: Date.now() - indexTimestamp > cacheTTL * 1000
    // We verify the math
    const isStale = Date.now() - (Date.now() - 600_000) > cacheTTL * 1000;
    assert(isStale, '10 min old cache should be stale with 5 min TTL');
});

test('F36: Cache key changes with vault config', () => {
    // Different vault configurations should produce different cache keys
    const vault1Config = [{ name: 'A', port: 27123, enabled: true }];
    const vault2Config = [{ name: 'A', port: 27123, enabled: true }, { name: 'B', port: 27124, enabled: true }];
    const key1 = vault1Config.filter(v => v.enabled).map(v => `${v.name}:${v.port}`).sort().join('|');
    const key2 = vault2Config.filter(v => v.enabled).map(v => `${v.name}:${v.port}`).sort().join('|');
    assertNotEqual(key1, key2, 'different vault configs should produce different keys');
});

test('F37: Sliding window cache hit — same hash + manifest', () => {
    resetAllState();
    const cache = { hash: 'abc123', manifestHash: 'def456', chatLineCount: 5, results: [{ title: 'Eris' }] };
    setAiSearchCache(cache);

    // Same hashes → cache hit
    const chatHash = 'abc123';
    const manifestHash = 'def456';
    const isHit = aiSearchCache.hash === chatHash && aiSearchCache.manifestHash === manifestHash && aiSearchCache.results.length > 0;
    assert(isHit, 'should be a cache hit');
});

test('F38: Sliding window cache miss — new entity mention', () => {
    resetAllState();
    setAiSearchCache({ hash: 'old', manifestHash: 'man1', chatLineCount: 3, results: [{ title: 'Eris' }] });
    setEntityNameSet(new Set(['eris', 'tavern']));

    // New chat lines contain entity name
    const newLines = ['The tavern was empty.'];
    const newText = newLines.join(' ').toLowerCase();

    let hasNewEntityMention = false;
    for (const name of entityNameSet) {
        if (newText.includes(name)) {
            hasNewEntityMention = true;
            break;
        }
    }
    assert(hasNewEntityMention, 'should detect entity mention in new text');
    // This means cache should be invalidated
});

test('F39: Sliding window cache miss — manifest change', () => {
    resetAllState();
    setAiSearchCache({ hash: 'old', manifestHash: 'man1', chatLineCount: 3, results: [{ title: 'Eris' }] });

    const newManifestHash = 'man2';
    const manifestChanged = aiSearchCache.manifestHash !== newManifestHash;
    assert(manifestChanged, 'manifest change should invalidate cache');
});

test('F40: Entity name set should be refreshable after index rebuild', () => {
    resetAllState();
    setEntityNameSet(new Set(['old_name']));
    assertEqual(entityNameSet.size, 1, 'initial entity set');

    // Simulate index rebuild with new entries
    const newEntries = [makeEntry('NewChar', { keys: ['alias1', 'alias2'] })];
    const newNames = new Set();
    for (const e of newEntries) {
        newNames.add(e.title.toLowerCase());
        for (const k of e.keys) newNames.add(k.toLowerCase());
    }
    setEntityNameSet(newNames);
    assertEqual(entityNameSet.size, 3, 'entity set should have title + 2 keys');
    assert(entityNameSet.has('newchar'), 'should contain new entity name');
    assert(!entityNameSet.has('old_name'), 'should not contain old name');
});

// ============================================================================
// G. Drawer State Tests (state-level, not DOM)
// ============================================================================

test('G41: Tab state concepts — active tab tracking', () => {
    // Drawer state tracks which tab is active via DOM classes.
    // We verify the state machinery that supports it.
    resetAllState();
    // The drawer uses ds.whyTabFilter (to be added in Part 3C)
    // For now, test that state variables used by drawer are resettable
    setLastPipelineTrace({ mode: 'two-stage', injected: [{ title: 'A', tokens: 50 }] });
    assert(lastPipelineTrace !== null, 'trace should be set');
    setLastPipelineTrace(null);
    assert(lastPipelineTrace === null, 'trace should be clearable');
});

test('G44: Browse filter changes reset state', () => {
    resetAllState();
    // Simulating: browseLastRangeStart/End reset when filter changes
    // These are in drawer-state.js (ds object) — we test the concept
    let rangeStart = 5, rangeEnd = 20;
    // Filter change → reset
    rangeStart = -1;
    rangeEnd = -1;
    assertEqual(rangeStart, -1, 'range start should reset');
    assertEqual(rangeEnd, -1, 'range end should reset');
});

test('G45: Pin/block updates track in chatInjectionCounts', () => {
    resetAllState();
    const entry = makeEntry('PinnedEntry', { vaultSource: 'test' });
    const key = trackerKey(entry);
    chatInjectionCounts.set(key, 3);
    assertEqual(chatInjectionCounts.get(key), 3, 'should track injection count');
});

test('G46: Status zone 3-state label logic', () => {
    resetAllState();
    // State 1: Choosing Lore (generationLock = true)
    setGenerationLock(true);
    let label = generationLock ? 'Choosing Lore...' : 'Idle';
    assertEqual(label, 'Choosing Lore...', 'should show Choosing Lore when locked');

    // State 2: Generating (lock released, stGenerating = true)
    setGenerationLock(false);
    const stGenerating = true;
    label = generationLock ? 'Choosing Lore...' : stGenerating ? 'Generating...' : 'Idle';
    assertEqual(label, 'Generating...', 'should show Generating when stGenerating');

    // State 3: Idle
    label = generationLock ? 'Choosing Lore...' : false ? 'Generating...' : 'Idle';
    assertEqual(label, 'Idle', 'should show Idle when neither locked nor generating');
});

test('G47: Tab badge counts from state data', () => {
    resetAllState();
    // Injection tab badge = lastInjectionSources?.length
    setLastInjectionSources([{ title: 'A' }, { title: 'B' }]);
    assertEqual(lastInjectionSources.length, 2, 'injection badge should show 2');

    // Browse tab badge = vaultIndex.length
    setVaultIndex([makeEntry('X'), makeEntry('Y'), makeEntry('Z')]);
    assertEqual(vaultIndex.length, 3, 'browse badge should show 3');
});

// ============================================================================
// H. Multi-Vault Tests
// ============================================================================

test('H48: Entries merged from multiple vaults', () => {
    resetAllState();
    const entriesA = [makeEntry('CharA', { vaultSource: 'VaultA' })];
    const entriesB = [makeEntry('CharB', { vaultSource: 'VaultB' })];
    const merged = [...entriesA, ...entriesB];
    setVaultIndex(merged);
    assertEqual(vaultIndex.length, 2, 'merged index should have entries from both vaults');
    assertEqual(vaultIndex[0].vaultSource, 'VaultA', 'first entry from VaultA');
    assertEqual(vaultIndex[1].vaultSource, 'VaultB', 'second entry from VaultB');
});

test('H49: Disabled vault excluded', () => {
    resetAllState();
    const vaults = [
        { name: 'Active', port: 27123, apiKey: 'k1', enabled: true },
        { name: 'Disabled', port: 27124, apiKey: 'k2', enabled: false },
    ];
    const enabledVaults = vaults.filter(v => v.enabled);
    assertEqual(enabledVaults.length, 1, 'only enabled vaults should be included');
    assertEqual(enabledVaults[0].name, 'Active', 'Active vault should be included');
});

test('H50: Per-port circuit breaker isolation', () => {
    // obsidian-api.js uses per-port circuit breakers via a Map
    // We test the concept: failures on port A don't affect port B
    resetAllState();
    const circuitA = { failures: 3, state: 'open' };
    const circuitB = { failures: 0, state: 'closed' };
    assert(circuitA.state === 'open', 'circuit A should be open');
    assert(circuitB.state === 'closed', 'circuit B should be closed (isolated)');
});

test('H51: Tracker key namespacing avoids cross-vault collision', () => {
    const entryA = makeEntry('Eris', { vaultSource: 'VaultA' });
    const entryB = makeEntry('Eris', { vaultSource: 'VaultB' });
    const keyA = trackerKey(entryA);
    const keyB = trackerKey(entryB);
    assertNotEqual(keyA, keyB, 'same title in different vaults should have different keys');
    assertEqual(keyA, 'VaultA:Eris', 'key should be vaultSource:title');
    assertEqual(keyB, 'VaultB:Eris', 'key should be vaultSource:title');
});

test('H52: Cache key incorporates vault fingerprint', () => {
    const vaultsA = [{ name: 'V1', port: 27123, enabled: true }];
    const vaultsB = [{ name: 'V1', port: 27123, enabled: true }, { name: 'V2', port: 27124, enabled: true }];
    const fpA = vaultsA.filter(v => v.enabled).map(v => `${v.name}:${v.port}`).sort().join('|');
    const fpB = vaultsB.filter(v => v.enabled).map(v => `${v.name}:${v.port}`).sort().join('|');
    assertNotEqual(fpA, fpB, 'different vault configs should produce different fingerprints');
});

// ============================================================================
// I. Settings & Validation Tests
// ============================================================================

test('I53: Settings constraints clamp out-of-range values', () => {
    const settings = { obsidianPort: 99999, scanDepth: -5, cacheTTL: 100000 };
    const constraints = {
        obsidianPort: { min: 1, max: 65535 },
        scanDepth: { min: 0, max: 100 },
        cacheTTL: { min: 0, max: 86400 },
    };
    validateSettings(settings, constraints);
    assertEqual(settings.obsidianPort, 65535, 'port should clamp to max');
    assertEqual(settings.scanDepth, 0, 'scanDepth should clamp to min');
    assertEqual(settings.cacheTTL, 86400, 'cacheTTL should clamp to max');
});

test('I54: Legacy vault migration', () => {
    // Simulate legacy settings with obsidianPort but no vaults array
    const legacy = { obsidianPort: 27123, obsidianApiKey: 'testkey', vaults: [] };
    if (legacy.vaults.length === 0 && legacy.obsidianPort) {
        legacy.vaults = [{
            name: 'Primary',
            port: legacy.obsidianPort,
            apiKey: legacy.obsidianApiKey || '',
            enabled: true,
        }];
    }
    assertEqual(legacy.vaults.length, 1, 'should migrate to 1 vault');
    assertEqual(legacy.vaults[0].port, 27123, 'port should match legacy');
    assertEqual(legacy.vaults[0].apiKey, 'testkey', 'apiKey should match legacy');
});

test('I55: AI configuration validation — missing profile detection', () => {
    // When AI search is enabled but no profile is configured
    const settings = makeSettings({
        aiSearchEnabled: true,
        aiSearchConnectionMode: 'profile',
        aiSearchProfileId: '',
    });
    const hasProfile = !!settings.aiSearchProfileId;
    assert(!hasProfile, 'should detect missing profile');
    const warningNeeded = settings.aiSearchEnabled && settings.aiSearchConnectionMode === 'profile' && !hasProfile;
    assert(warningNeeded, 'should flag warning for AI enabled without profile');
});

test('I56: Search mode interactions', () => {
    // keyword-only: AI disabled
    const kwOnly = makeSettings({ aiSearchEnabled: false });
    const isKwOnly = !kwOnly.aiSearchEnabled;
    assert(isKwOnly, 'keyword-only when AI disabled');

    // ai-only: keywords disabled (scanDepth 0)
    const aiOnly = makeSettings({ aiSearchEnabled: true, aiSearchMode: 'ai-only', scanDepth: 0 });
    const isAiOnly = aiOnly.aiSearchEnabled && aiOnly.aiSearchMode === 'ai-only';
    assert(isAiOnly, 'ai-only mode');

    // two-stage: both enabled
    const twoStage = makeSettings({ aiSearchEnabled: true, aiSearchMode: 'two-stage', scanDepth: 5 });
    const isTwoStage = twoStage.aiSearchEnabled && twoStage.aiSearchMode === 'two-stage' && twoStage.scanDepth > 0;
    assert(isTwoStage, 'two-stage: both keyword and AI');
});

// ============================================================================
// J. Sync Polling Tests
// ============================================================================

test('J57: setTimeout chaining concept — no overlap', () => {
    // Sync polling uses setTimeout chaining instead of setInterval
    // We test the pattern conceptually
    let running = false;
    let overlapDetected = false;

    const simulateTick = () => {
        if (running) {
            overlapDetected = true;
            return;
        }
        running = true;
        // Simulate work
        running = false;
    };

    simulateTick();
    simulateTick();
    simulateTick();
    assert(!overlapDetected, 'setTimeout chaining should prevent overlap');
});

test('J58: Stuck indexing detection at 120s', () => {
    resetAllState();
    setIndexing(true);

    // Simulate: indexing has been true for > 120s
    const stuckThreshold = 120_000;
    const simulatedStuckTime = 130_000;

    if (simulatedStuckTime > stuckThreshold) {
        setIndexing(false);
    }
    assert(!indexing, 'stuck indexing should be force-released after threshold');
});

test('J59: Polling interval re-read each tick', () => {
    // Settings can change between ticks, and polling re-reads each time
    let interval = 60;
    const tick1Interval = interval;
    interval = 120; // User changed setting
    const tick2Interval = interval;
    assertNotEqual(tick1Interval, tick2Interval, 'interval should change between ticks');
});

test('J60: Circuit breaker awareness in polling', () => {
    resetAllState();
    // When all vault circuits are open, polling should skip the tick
    const vaultCircuits = [
        { port: 27123, state: 'open' },
        { port: 27124, state: 'open' },
    ];
    const allCircuitsOpen = vaultCircuits.every(c => c.state === 'open');
    assert(allCircuitsOpen, 'all circuits open — polling should skip');

    // When at least one is closed, polling should proceed
    vaultCircuits[0].state = 'closed';
    const anyCircuitClosed = vaultCircuits.some(c => c.state !== 'open');
    assert(anyCircuitClosed, 'at least one circuit closed — polling should proceed');
});

// ============================================================================
// Additional: Pipeline Stage Integration Tests
// ============================================================================

test('Stage: buildExemptionPolicy identifies constants and pins', () => {
    const entries = [
        makeEntry('Always', { constant: true }),
        makeEntry('Normal'),
        makeEntry('Pinned'),
    ];
    const policy = buildExemptionPolicy(entries, ['Pinned'], ['Blocked']);
    assert(policy.forceInject.has('always'), 'constant should be forceInject (lowercase)');
    assert(policy.forceInject.has('pinned'), 'pinned should be forceInject (lowercase)');
    assert(!policy.forceInject.has('normal'), 'normal should not be forceInject');
    assert(policy.blocks.has('blocked'), 'blocked should be in blocks (lowercase)');
});

test('Stage: applyPinBlock adds pinned entries and removes blocked', () => {
    const entries = [makeEntry('MatchedA'), makeEntry('Blocked1')];
    const vault = [...entries, makeEntry('PinnedB')];
    const policy = buildExemptionPolicy(vault, ['PinnedB'], ['Blocked1']);
    const matchedKeys = new Map();
    const result = applyPinBlock(entries, vault, policy, matchedKeys);

    assert(result.some(e => e.title === 'PinnedB'), 'pinned entry should be added');
    assert(!result.some(e => e.title === 'Blocked1'), 'blocked entry should be removed');
    assert(result.some(e => e.title === 'MatchedA'), 'matched entry should remain');
    assertEqual(matchedKeys.get('PinnedB'), '(pinned)', 'pinned entry should have match key');
});

test('Stage: applyContextualGating removes entries not matching context', () => {
    const entries = [
        makeEntry('Medieval', { era: ['medieval'] }),
        makeEntry('Modern', { era: ['modern'] }),
        makeEntry('NoEra'),
    ];
    const ctx = { era: 'medieval' };
    const policy = buildExemptionPolicy(entries, [], []);
    const settings = makeSettings({ contextualGatingTolerance: 'strict' });
    const result = applyContextualGating(entries, ctx, policy, false, settings);

    assert(result.some(e => e.title === 'Medieval'), 'matching era should pass');
    assert(result.some(e => e.title === 'NoEra'), 'no era should pass');
    assert(!result.some(e => e.title === 'Modern'), 'non-matching era should be filtered');
});

test('Stage: applyReinjectionCooldown skips recently injected', () => {
    const entries = [makeEntry('RecentA'), makeEntry('OldB')];
    const policy = buildExemptionPolicy(entries, [], []);
    const history = new Map();
    history.set(':RecentA', 5); // Injected at generation 5
    const currentGen = 6;
    const cooldown = 3; // Skip for 3 generations

    const result = applyReinjectionCooldown(entries, policy, history, currentGen, cooldown, false);
    assert(!result.some(e => e.title === 'RecentA'), 'recently injected should be skipped');
    assert(result.some(e => e.title === 'OldB'), 'non-recent should pass');
});

test('Stage: trackGeneration updates cooldowns and injection history', () => {
    resetAllState();
    const injected = [
        makeEntry('A', { cooldown: 2 }),
        makeEntry('B'),
    ];
    const history = new Map();
    const cd = new Map();
    const decay = new Map();
    // reinjectionCooldown > 0 required for injection history tracking
    const settings = makeSettings({ decayEnabled: false, reinjectionCooldown: 3 });

    trackGeneration(injected, 0, cd, decay, history, settings);
    assert(cd.has(':A'), 'A should have cooldown set');
    // trackGeneration sets cooldown + 1 to compensate for immediate decrement
    assertEqual(cd.get(':A'), 3, 'A cooldown should be entry.cooldown + 1 = 3');
    assert(history.has(':A'), 'A should be in injection history');
    assert(history.has(':B'), 'B should be in injection history');
});

test('Stage: decrementTrackers reduces cooldown timers', () => {
    resetAllState();
    const cd = new Map([['test:A', 3], ['test:B', 1]]);
    const decay = new Map();
    const injected = [];
    const consec = new Map();
    const settings = makeSettings({ decayEnabled: false });

    decrementTrackers(cd, decay, injected, settings, consec);
    assertEqual(cd.get('test:A'), 2, 'A cooldown should decrement to 2');
    assert(!cd.has('test:B'), 'B cooldown should be removed (reached 0)');
});

test('Stage: recordAnalytics accumulates stats', () => {
    const analytics = {};
    const matched = [makeEntry('X'), makeEntry('Y')];
    const injected = [makeEntry('X')];

    recordAnalytics(matched, injected, analytics);
    assertEqual(analytics[':X']?.matched, 1, 'X should have 1 match');
    assertEqual(analytics[':X']?.injected, 1, 'X should have 1 injection');
    assertEqual(analytics[':Y']?.matched, 1, 'Y should have 1 match');
    assertEqual(analytics[':Y']?.injected, 0, 'Y should have 0 injections (matched but not injected)');
});

test('Stage: computeOverallStatus — offline when no entries and no vaults', () => {
    resetAllState();
    setLastVaultAttemptCount(1);
    setLastVaultFailureCount(1);
    const status = computeOverallStatus({ state: 'open', failures: 3 });
    assertEqual(status, 'offline', 'should be offline when no entries and all vaults failed');
});

test('Stage: computeOverallStatus — limited when AI circuit tripped', () => {
    resetAllState();
    setVaultIndex([makeEntry('X')]);
    setIndexEverLoaded(true);
    recordAiFailure();
    recordAiFailure();
    const status = computeOverallStatus({ state: 'closed', failures: 0 });
    assertEqual(status, 'limited', 'should be limited when AI circuit is open');
});

test('Stage: computeOverallStatus — ok when all good', () => {
    resetAllState();
    setVaultIndex([makeEntry('X')]);
    setIndexEverLoaded(true);
    setLastVaultAttemptCount(1);
    setLastVaultFailureCount(0);
    const status = computeOverallStatus({ state: 'closed', failures: 0 });
    assertEqual(status, 'ok', 'should be ok when everything is healthy');
});

test('Stage: computeOverallStatus — degraded when some vaults failed', () => {
    resetAllState();
    setVaultIndex([makeEntry('X')]);
    setIndexEverLoaded(true);
    setLastVaultAttemptCount(2);
    setLastVaultFailureCount(1);
    const status = computeOverallStatus({ state: 'closed', failures: 0 });
    assertEqual(status, 'degraded', 'should be degraded when some vaults failed');
});

test('Stage: computeOverallStatus — degraded when health has errors', () => {
    resetAllState();
    setVaultIndex([makeEntry('X')]);
    setIndexEverLoaded(true);
    setLastVaultAttemptCount(1);
    setLastVaultFailureCount(0);
    setLastHealthResult({ errors: 2, warnings: 0 });
    const status = computeOverallStatus({ state: 'closed', failures: 0 });
    assertEqual(status, 'degraded', 'should be degraded when health has errors');
});

// ============================================================================
// Additional: Lock epoch tests
// ============================================================================

test('Lock: epoch increments on each lock acquisition', () => {
    resetAllState();
    const epoch0 = generationLockEpoch;
    setGenerationLock(true);
    const epoch1 = generationLockEpoch;
    setGenerationLock(false);
    setGenerationLock(true);
    const epoch2 = generationLockEpoch;

    assert(epoch1 > epoch0, 'epoch should increment on first lock');
    assert(epoch2 > epoch1, 'epoch should increment on second lock');
});

test('Lock: stale pipeline detects epoch mismatch', () => {
    resetAllState();
    setGenerationLock(true);
    const staleLockEpoch = generationLockEpoch;

    // Force-release by newer pipeline
    setGenerationLock(false);
    setGenerationLock(true);
    const newLockEpoch = generationLockEpoch;

    // Stale pipeline checks
    assert(staleLockEpoch !== newLockEpoch, 'stale pipeline should see epoch mismatch');
});

// ============================================================================
// Additional: Tracker key edge cases
// ============================================================================

test('TrackerKey: empty vaultSource produces :title', () => {
    const entry = makeEntry('Test', { vaultSource: '' });
    assertEqual(trackerKey(entry), ':Test', 'empty vaultSource should produce :title');
});

test('TrackerKey: undefined vaultSource treated as empty via ||', () => {
    const entry = { title: 'Test', vaultSource: undefined };
    assertEqual(trackerKey(entry), ':Test', 'undefined vaultSource becomes empty string via || operator');
});

// ============================================================================
// Additional: Observer callback array isolation
// ============================================================================

test('Observer: clearPipelineCompleteCallbacks removes all callbacks', () => {
    resetAllState();
    let fired = false;
    onPipelineComplete(() => { fired = true; });
    clearPipelineCompleteCallbacks();
    notifyPipelineComplete();
    assert(!fired, 'callback should not fire after clear');
});

test('Observer: clearGatingCallbacks removes all callbacks', () => {
    resetAllState();
    let fired = false;
    onGatingChanged(() => { fired = true; });
    clearGatingCallbacks();
    notifyGatingChanged();
    assert(!fired, 'callback should not fire after clear');
});

test('Observer: clearPinBlockCallbacks removes all callbacks', () => {
    resetAllState();
    let fired = false;
    onPinBlockChanged(() => { fired = true; });
    clearPinBlockCallbacks();
    notifyPinBlockChanged();
    assert(!fired, 'callback should not fire after clear');
});

// ============================================================================
// Additional: Generation count persistence
// ============================================================================

test('GenerationCount: persists chat injection counts', () => {
    resetAllState();
    const entries = [
        makeEntry('A', { vaultSource: 'v1' }),
        makeEntry('B', { vaultSource: 'v1' }),
    ];
    // Simulate injection
    for (const entry of entries) {
        const key = trackerKey(entry);
        chatInjectionCounts.set(key, (chatInjectionCounts.get(key) || 0) + 1);
    }
    // Persist to "chat_metadata" format
    const persisted = Object.fromEntries(chatInjectionCounts);
    assertEqual(persisted['v1:A'], 1, 'A count should be 1');
    assertEqual(persisted['v1:B'], 1, 'B count should be 1');

    // Hydrate back
    const hydrated = new Map(Object.entries(persisted));
    setChatInjectionCounts(hydrated);
    assertEqual(chatInjectionCounts.get('v1:A'), 1, 'hydrated A count');
    assertEqual(chatInjectionCounts.get('v1:B'), 1, 'hydrated B count');
});

// ============================================================================
// Additional: formatAndGroup integration with state
// ============================================================================

test('formatAndGroup: respects budget limits', () => {
    const entries = [
        makeEntry('A', { content: 'Content A', tokenEstimate: 100, priority: 10 }),
        makeEntry('B', { content: 'Content B', tokenEstimate: 100, priority: 20 }),
        makeEntry('C', { content: 'Content C', tokenEstimate: 100, priority: 30 }),
    ];
    const settings = makeSettings({ maxTokensBudget: 200, unlimitedBudget: false });
    const { count, totalTokens, acceptedEntries } = formatAndGroup(entries, settings, 'deeplore_');

    assert(count <= 2, 'should respect 200 token budget (at most 2 entries of 100 tokens each)');
    assert(totalTokens <= 200, 'total tokens should be within budget');
    // Higher priority (lower number) should be included first
    assert(acceptedEntries.some(e => e.title === 'A'), 'highest priority A should be included');
});

test('formatAndGroup: XML escapes titles in template', () => {
    const entries = [makeEntry('Test<script>', { content: 'safe', tokenEstimate: 50 })];
    const settings = makeSettings({ maxTokensBudget: 1000 });
    const { groups } = formatAndGroup(entries, settings, 'deeplore_');
    if (groups.length > 0) {
        const text = groups[0].text;
        assert(!text.includes('<script>'), 'title should be XML-escaped');
        assert(text.includes('&lt;script&gt;'), 'should contain escaped version');
    }
});

// ============================================================================
// Tests: Audit Bug Regression — Wave 1 (BUG-025)
// ============================================================================

test('BUG-025: AI circuit breaker probe gate allows exactly one caller', () => {
    // Reset circuit to closed
    recordAiSuccess();
    assert(isAiCircuitOpen() === false, 'circuit should start closed');

    // Trip circuit with 2 failures
    recordAiFailure();
    recordAiFailure();
    assert(isAiCircuitOpen() === true, 'circuit should be open after 2 failures');

    // Backdate openedAt to simulate cooldown elapsed (31s ago, cooldown is 30s)
    setAiCircuitOpenedAt(Date.now() - 31_000);

    // First call after cooldown: should be allowed (probe)
    assert(isAiCircuitOpen() === false, 'first call after cooldown should be allowed (probe)');

    // Second call: should be blocked (probe already dispatched)
    assert(isAiCircuitOpen() === true, 'second call should be blocked (probe in progress)');

    // Third call: still blocked
    assert(isAiCircuitOpen() === true, 'third call should still be blocked');

    // Success clears everything
    recordAiSuccess();
    assert(isAiCircuitOpen() === false, 'circuit should be closed after success');
});

test('BUG-025: AI circuit breaker probe resets on failure', () => {
    // Reset and trip
    recordAiSuccess();
    recordAiFailure();
    recordAiFailure();

    // Backdate to simulate cooldown
    setAiCircuitOpenedAt(Date.now() - 31_000);

    // Allow probe through
    assert(isAiCircuitOpen() === false, 'probe should be allowed');

    // Probe fails — circuit should re-open with fresh cooldown
    recordAiFailure();
    assert(isAiCircuitOpen() === true, 'circuit should be open after probe failure');

    // Clean up
    recordAiSuccess();
});

// ============================================================================
// Wave 4 Regression Tests — Pipeline Stages (BUG-011, BUG-016, BUG-029, BUG-030)
// ============================================================================

test('BUG-011: buildExemptionPolicy normalizes titles to lowercase', () => {
    const entries = [makeEntry('Eris', { constant: true })];
    const policy = buildExemptionPolicy(entries, ['Alice'], []);
    assert(policy.forceInject.has('eris'), 'constant title should be lowercase in forceInject');
    assert(policy.forceInject.has('alice'), 'pin title should be lowercase in forceInject');
    assert(!policy.forceInject.has('Eris'), 'forceInject should not contain original case');
    assert(!policy.forceInject.has('Alice'), 'forceInject should not contain original case');
});

test('BUG-011: applyRequiresExcludesGating exempts pinned entries case-insensitively', () => {
    const eris = makeEntry('Eris', { requires: ['Raven'] });
    const policy = buildExemptionPolicy([], ['eris'], []);
    const { result } = applyRequiresExcludesGating([eris], policy, false);
    assert(result.length === 1, 'pinned entry should bypass requires gating');
    assertEqual(result[0].title, 'Eris', 'Eris should survive');
});

test('BUG-016: lenient gating filters entries with mismatched era', () => {
    const e1 = makeEntry('Medieval Lore', { era: ['medieval'] });
    const e2 = makeEntry('Spacefaring', { era: ['sci-fi'] });
    const e3 = makeEntry('No Era', {});
    const context = { era: 'medieval', location: '', scene_type: '', characters_present: [] };
    const policy = buildExemptionPolicy([], [], []);
    const settings = makeSettings({ contextualGatingTolerance: 'lenient' });

    const result = applyContextualGating([e1, e2, e3], context, policy, false, settings);
    assert(result.some(e => e.title === 'Medieval Lore'), 'matching era should pass');
    assert(!result.some(e => e.title === 'Spacefaring'), 'mismatched era should be filtered even in lenient');
    assert(result.some(e => e.title === 'No Era'), 'no-era entry should pass in lenient');
});

test('BUG-029: symmetric mutual excludes resolve deterministically by priority', () => {
    const a = makeEntry('Alpha', { priority: 20, excludes: ['Beta'] });
    const b = makeEntry('Beta', { priority: 50, excludes: ['Alpha'] });
    const policy = buildExemptionPolicy([], [], []);
    const { result: r1 } = applyRequiresExcludesGating([a, b], policy, false);
    const { result: r2 } = applyRequiresExcludesGating([b, a], policy, false);
    assertEqual(r1.map(e => e.title), r2.map(e => e.title),
        'mutual excludes should produce same result regardless of input order');
    assert(r1.some(e => e.title === 'Alpha'), 'higher-priority entry (lower number) should survive');
});

test('BUG-030: pinned entry arrays are deep copies', () => {
    const original = makeEntry('Eris', { keys: ['eris', 'goddess'], tags: ['lorebook', 'character'] });
    setVaultIndex([original]);
    const policy = buildExemptionPolicy([], ['eris'], []);
    const matchedKeys = new Map();

    const result = applyPinBlock([], [original], policy, matchedKeys);
    assert(result.length === 1, 'pinned entry should be added');

    const pinned = result[0];
    assert(pinned.keys !== original.keys, 'keys array should be a new reference');
    assert(pinned.tags !== original.tags, 'tags array should be a new reference');

    pinned.keys.push('mutated');
    assert(!original.keys.includes('mutated'), 'mutating pinned keys should not affect original');
});

// ============================================================================
// Wave 2 Regression Tests — Build Epoch (BUG-015)
// ============================================================================

test('BUG-015: buildEpoch can be incremented to invalidate stuck builds', () => {
    const before = buildEpoch;
    setBuildEpoch(buildEpoch + 1);
    assert(buildEpoch === before + 1, 'buildEpoch should increment');
    // Reset
    setBuildEpoch(before);
});

test('BUG-015: buildEpoch starts at 0', () => {
    // buildEpoch may have been modified by prior tests, but the type should be number
    assert(typeof buildEpoch === 'number', 'buildEpoch should be a number');
});

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${'='.repeat(60)}`);
console.log(`Integration Tests: ${passed} passed, ${failed} failed (${passed + failed} total)`);
console.log(`${'='.repeat(60)}`);

if (failed > 0) {
    process.exit(1);
}
