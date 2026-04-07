/**
 * state-snapshot.js — Capture a point-in-time snapshot of DLE + ST state.
 *
 * Pulls only metadata, counts, and structural info — never chat content,
 * never vault entry content. The result is then handed to scrubber.scrubDeep()
 * before being included in the export.
 */

import * as state from '../state.js';
import { getSettings } from '../../settings.js';
import { runHealthCheck } from '../ui/diagnostics.js';

/**
 * Summarize a single VaultEntry into metadata only.
 * NEVER include `content` or `summary` body text.
 */
function summarizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    return {
        title: e.title,
        filename: e.filename,
        vaultSource: e.vaultSource,
        priority: e.priority,
        constant: !!e.constant,
        seed: !!e.seed,
        bootstrap: !!e.bootstrap,
        tokenEstimate: e.tokenEstimate,
        keyCount: Array.isArray(e.keys) ? e.keys.length : 0,
        hasSummary: !!(e.summary && e.summary.length),
        tagCount: Array.isArray(e.tags) ? e.tags.length : 0,
        requiresCount: Array.isArray(e.requires) ? e.requires.length : 0,
        excludesCount: Array.isArray(e.excludes) ? e.excludes.length : 0,
        linksCount: Array.isArray(e.links) ? e.links.length : 0,
        scanDepth: e.scanDepth ?? null,
        injectionPosition: e.injectionPosition ?? null,
        cooldown: e.cooldown ?? null,
        warmup: e.warmup ?? null,
        probability: e.probability ?? null,
        eraCount: Array.isArray(e.era) ? e.era.length : 0,
        locationCount: Array.isArray(e.location) ? e.location.length : 0,
    };
}

/** Convert a Map to a plain object with at most `maxEntries` keys. */
function mapToObj(m, maxEntries = 200) {
    if (!m || typeof m.entries !== 'function') return null;
    const out = {};
    let n = 0;
    for (const [k, v] of m.entries()) {
        if (n++ >= maxEntries) { out.__truncated = true; break; }
        out[String(k)] = v;
    }
    return out;
}

/** Inventory of installed third-party extensions, if available via getContext(). */
function extensionInventory() {
    try {
        const ctx = (typeof globalThis.SillyTavern?.getContext === 'function')
            ? globalThis.SillyTavern.getContext()
            : null;
        const ext = ctx?.extensionSettings || globalThis.extension_settings;
        if (!ext || typeof ext !== 'object') return null;
        return Object.keys(ext).sort();
    } catch { return null; }
}

/** chat_metadata snapshot — only DLE keys + lightweight ST metadata. */
function chatMetadataSnapshot() {
    try {
        const cm = globalThis.chat_metadata || {};
        const dleKeys = Object.keys(cm).filter(k => k.startsWith('deeplore_'));
        const out = {};
        for (const k of dleKeys) {
            const v = cm[k];
            // Don't include chat-content-ish things — even DLE keys could have user text.
            // Just record shape: type, length, key count.
            if (v == null) { out[k] = null; continue; }
            if (Array.isArray(v)) { out[k] = { __type: 'array', length: v.length }; continue; }
            if (typeof v === 'object') { out[k] = { __type: 'object', keys: Object.keys(v) }; continue; }
            if (typeof v === 'string') { out[k] = { __type: 'string', length: v.length }; continue; }
            out[k] = v;
        }
        return out;
    } catch { return null; }
}

function systemInfo() {
    try {
        return {
            userAgent: (typeof navigator !== 'undefined') ? navigator.userAgent : null,
            language: (typeof navigator !== 'undefined') ? navigator.language : null,
            platform: (typeof navigator !== 'undefined') ? navigator.platform : null,
            url: (typeof location !== 'undefined') ? `${location.protocol}//${location.host}${location.pathname}` : null,
            screen: (typeof screen !== 'undefined') ? { w: screen.width, h: screen.height } : null,
        };
    } catch { return null; }
}

/**
 * Build the full state snapshot. Returned object is NOT yet scrubbed —
 * the export pipeline runs scrubDeep() on the whole thing before serializing.
 */
export function captureStateSnapshot() {
    const snap = {
        capturedAt: new Date().toISOString(),
        capturedAtMs: Date.now(),
        system: systemInfo(),
        extensionInventory: extensionInventory(),
    };

    // Settings (full — scrubber redacts API keys by name)
    try { snap.settings = getSettings(); } catch (e) { snap.settings = { __error: String(e) }; }

    // Manifest version
    try { snap.dleVersion = '1.0.0-beta'; /* TODO: read manifest dynamically if needed */ } catch {}

    // Vault index summary
    try {
        const idx = state.vaultIndex || [];
        snap.vault = {
            entryCount: idx.length,
            indexTimestamp: state.indexTimestamp,
            indexEverLoaded: state.indexEverLoaded,
            indexing: state.indexing,
            avgTokens: state.vaultAvgTokens,
            constantCount: idx.filter(e => e.constant).length,
            seedCount: idx.filter(e => e.seed).length,
            bootstrapCount: idx.filter(e => e.bootstrap).length,
            withSummary: idx.filter(e => e.summary && e.summary.length).length,
            withRequires: idx.filter(e => Array.isArray(e.requires) && e.requires.length).length,
            withExcludes: idx.filter(e => Array.isArray(e.excludes) && e.excludes.length).length,
            withoutKeys: idx.filter(e => !Array.isArray(e.keys) || e.keys.length === 0).length,
            // Per-entry metadata for the first ~200 entries (oldest-first arbitrary order — fine for diag)
            entries: idx.slice(0, 200).map(summarizeEntry),
            entriesTruncated: idx.length > 200,
        };
    } catch (e) { snap.vault = { __error: String(e) }; }

    // Pipeline runtime state
    try {
        snap.pipeline = {
            generationCount: state.generationCount,
            chatEpoch: state.chatEpoch,
            cooldownTracker: mapToObj(state.cooldownTracker),
            chatInjectionCounts: mapToObj(state.chatInjectionCounts),
            consecutiveInjections: mapToObj(state.consecutiveInjections),
            decayTracker: mapToObj(state.decayTracker),
            injectionHistory: mapToObj(state.injectionHistory),
            generationLock: state.generationLock,
            generationLockEpoch: state.generationLockEpoch,
            generationLockTimestamp: state.generationLockTimestamp,
            lastIndexGenerationCount: state.lastIndexGenerationCount,
            lastWarningRatio: state.lastWarningRatio,
            lastPipelineTrace: state.lastPipelineTrace, // raw — scrubber will handle nested strings
        };
    } catch (e) { snap.pipeline = { __error: String(e) }; }

    // AI subsystem
    try {
        snap.ai = {
            cache: state.aiSearchCache ? {
                hash: state.aiSearchCache.hash,
                manifestHash: state.aiSearchCache.manifestHash,
                chatLineCount: state.aiSearchCache.chatLineCount,
                resultCount: Array.isArray(state.aiSearchCache.results) ? state.aiSearchCache.results.length : 0,
            } : null,
            stats: state.aiSearchStats,
            circuit: {
                open: state.aiCircuitOpen,
                failures: state.aiCircuitFailures,
                openedAt: state.aiCircuitOpenedAt,
            },
        };
    } catch (e) { snap.ai = { __error: String(e) }; }

    // Vault fetch failures
    try {
        snap.vaultFetch = {
            lastVaultFailureCount: state.lastVaultFailureCount,
            lastVaultAttemptCount: state.lastVaultAttemptCount,
        };
    } catch {}

    // Health check
    try { snap.health = runHealthCheck(); } catch (e) { snap.health = { __error: String(e) }; }

    // chat_metadata
    try { snap.chatMetadata = chatMetadataSnapshot(); } catch (e) { snap.chatMetadata = { __error: String(e) }; }

    return snap;
}
