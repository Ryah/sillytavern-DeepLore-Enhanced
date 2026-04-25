/**
 * state-snapshot.js — Capture a point-in-time snapshot of DLE + ST state.
 *
 * Pulls only metadata, counts, and structural info — never chat content,
 * never vault entry content. The result is then handed to scrubber.scrubDeep()
 * before being included in the export.
 */

import * as state from '../state.js';
import { getSettings, resolveConnectionConfig } from '../../settings.js';
import { runHealthCheck } from '../ui/diagnostics.js';
import { getAllCircuitStates } from '../vault/obsidian-api.js';

// DLE version — fetched once from our own manifest.json and cached.
let _cachedDleVersion = null;
try {
    // Relative to the extension root: we're in src/diagnostics/, manifest is at ../../manifest.json
    fetch(new URL('../../manifest.json', import.meta.url))
        .then(r => r.ok ? r.json() : null)
        .then(m => { if (m?.version) _cachedDleVersion = m.version; })
        .catch(() => {});
} catch { /* noop — import.meta.url may not be available */ }

/**
 * Partial-mask a string: show first `keep` chars, replace rest with `*` per char.
 * Preserves length information while hiding the full value.
 * E.g., maskString("John's Claude Key", 4) → "John**************"
 *
 * Collision handling: if two different strings produce the same masked output,
 * a random word is appended to disambiguate (e.g., "John***-oak", "John***-elm").
 */
const _maskCache = new Map(); // masked → original
const _maskResult = new Map(); // original → result
const DECOLIDE_WORDS = [
    'oak', 'elm', 'ash', 'bay', 'fir', 'yew', 'ivy', 'rue', 'fox', 'owl',
    'jay', 'wren', 'lark', 'dove', 'hare', 'moth', 'fern', 'moss', 'reed', 'sage',
];
let _decolideIdx = 0;
function maskString(s, keep = 4) {
    if (!s || typeof s !== 'string') return s;
    // Return cached result for same original
    if (_maskResult.has(s)) return _maskResult.get(s);
    const masked = s.length <= keep
        ? '*'.repeat(s.length)
        : s.slice(0, keep) + '*'.repeat(s.length - keep);
    // Check for collision with a different original
    const existing = _maskCache.get(masked);
    if (existing !== undefined && existing !== s) {
        // Collision — add a random word
        const word = DECOLIDE_WORDS[_decolideIdx++ % DECOLIDE_WORDS.length];
        const result = `${masked}-${word}`;
        _maskResult.set(s, result);
        return result;
    }
    _maskCache.set(masked, s);
    _maskResult.set(s, masked);
    return masked;
}
/** Reset mask caches per snapshot (fresh aliases each export). */
function resetMaskCaches() {
    _maskCache.clear();
    _maskResult.clear();
    _decolideIdx = 0;
}

// Per-snapshot title pseudonymizer. Fresh per captureStateSnapshot() call.
// Preserves cardinality so "entry X was selected → entry X hit cooldown" is traceable.
let _titleMap, _titleCounter;
function pseudonymizeTitle(title) {
    if (!title) return null;
    let p = _titleMap.get(title);
    if (!p) {
        p = `<title-${++_titleCounter}>`;
        _titleMap.set(title, p);
    }
    return p;
}

// Per-snapshot vaultSource pseudonymizer. The vaultSource is the user's vault
// name (story/project name) and leaks PII just like titles. Same cardinality
// preservation pattern as titles. Empty vaultSource (single-vault setups)
// passes through unchanged.
let _vaultSourceMap, _vaultSourceCounter;
function pseudonymizeVaultSource(vs) {
    if (!vs) return vs;
    let p = _vaultSourceMap.get(vs);
    if (!p) {
        p = `<vault-${++_vaultSourceCounter}>`;
        _vaultSourceMap.set(vs, p);
    }
    return p;
}

/**
 * Summarize a single VaultEntry into metadata only.
 * NEVER include `content` or `summary` body text.
 * Titles and filenames are pseudonymized to prevent PII leakage.
 */
function summarizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    return {
        title: pseudonymizeTitle(e.title),
        filename: pseudonymizeTitle(e.filename),
        vaultSource: pseudonymizeVaultSource(e.vaultSource),
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

/** Convert a Map to a plain object with at most `maxEntries` keys.
 *  Tracker keys (vaultSource:title) have BOTH portions pseudonymized — vault
 *  name leaks story/project identity just like titles do. */
function mapToObj(m, maxEntries = 200) {
    if (!m || typeof m.entries !== 'function') return null;
    const out = {};
    let n = 0;
    for (const [k, v] of m.entries()) {
        if (n++ >= maxEntries) { out.__truncated = true; break; }
        const ks = String(k);
        const colonIdx = ks.indexOf(':');
        const safeKey = colonIdx >= 0
            ? `${pseudonymizeVaultSource(ks.slice(0, colonIdx))}:${pseudonymizeTitle(ks.slice(colonIdx + 1))}`
            : ks;
        out[safeKey] = v;
    }
    return out;
}

/** Pseudonymize entry titles within a pipeline trace object (shallow copy). */
function pseudonymizeTrace(trace) {
    if (!trace || typeof trace !== 'object') return trace;
    const copy = { ...trace };
    const entryArrayKeys = [
        'keywordMatched', 'aiSelected', 'gatedOut', 'contextualGatingRemoved',
        'cooldownRemoved', 'warmupFailed', 'refineKeyBlocked', 'stripDedupRemoved',
        'budgetCut', 'injected',
    ];
    for (const key of entryArrayKeys) {
        if (!Array.isArray(copy[key])) continue;
        copy[key] = copy[key].map(e => {
            if (!e || typeof e !== 'object') return e;
            const out = { ...e, title: pseudonymizeTitle(e.title), filename: pseudonymizeTitle(e.filename) };
            // Pseudonymize keyword triggers — these are often character/location names
            if (out.matchedBy) out.matchedBy = pseudonymizeTitle(out.matchedBy);
            // AI selection reasons may contain character names — scrub against known title map
            if (typeof out.reason === 'string') {
                for (const [real, pseudo] of _titleMap.entries()) {
                    if (out.reason.includes(real)) {
                        out.reason = out.reason.replaceAll(real, pseudo);
                    }
                }
            }
            return out;
        });
    }
    return copy;
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
        // ST version from the #version_display element (set by ST at runtime)
        let stVersion = null;
        try {
            const el = document.querySelector('#version_display');
            if (el) stVersion = el.textContent?.trim() || null;
        } catch { /* noop */ }
        return {
            userAgent: (typeof navigator !== 'undefined') ? navigator.userAgent : null,
            language: (typeof navigator !== 'undefined') ? navigator.language : null,
            platform: (typeof navigator !== 'undefined') ? navigator.platform : null,
            url: (typeof location !== 'undefined') ? `${location.protocol}//${location.host}${location.pathname}` : null,
            screen: (typeof screen !== 'undefined') ? { w: screen.width, h: screen.height } : null,
            stVersion,
        };
    } catch { return null; }
}

/** Safely look up a connection profile by ID from ST's Connection Manager. */
function lookupProfile(profileId) {
    try {
        const ctx = (typeof globalThis.SillyTavern?.getContext === 'function')
            ? globalThis.SillyTavern.getContext() : null;
        const ext = ctx?.extensionSettings || globalThis.extension_settings;
        const profiles = ext?.connectionManager?.profiles;
        if (!Array.isArray(profiles) || !profileId) return null;
        return profiles.find(p => p.id === profileId) || null;
    } catch { return null; }
}

/** Summarize a ST connection profile for diagnostics (strip secrets, mask freeform names). */
function summarizeProfile(profile) {
    if (!profile) return null;
    return {
        id: profile.id,
        name: maskString(profile.name),
        api: profile.api,
        model: profile.model,
        preset: profile.preset,
        proxy: profile.proxy, // proxy preset name, not the URL
        instruct: profile.instruct,
        context: profile.context,
        tokenizer: profile.tokenizer,
        'api-url': profile['api-url'],  // scrubber will pseudonymize the hostname
        'instruct-state': profile['instruct-state'],
        'reasoning-template': profile['reasoning-template'],
    };
}

/** Resolve CONNECT_API_MAP for a profile's api type, if available. */
function resolveApiMap(apiType) {
    try {
        const ctx = (typeof globalThis.SillyTavern?.getContext === 'function')
            ? globalThis.SillyTavern.getContext() : null;
        const map = ctx?.CONNECT_API_MAP;
        if (!map || !apiType) return null;
        const entry = map[apiType];
        if (!entry) return { __error: `'${apiType}' not in CONNECT_API_MAP` };
        return { selected: entry.selected, source: entry.source, type: entry.type };
    } catch { return null; }
}

/**
 * Capture DLE + ST connection state for diagnostics.
 * Shows the resolved config for every DLE tool, the underlying ST profile objects,
 * ST's active main API state, and flags missing/stale profiles.
 */
function connectionSnapshot() {
    try {
        const toolKeys = ['aiSearch', 'scribe', 'autoSuggest', 'aiNotepad', 'librarian', 'optimizeKeys'];
        const tools = {};
        const seenProfileIds = new Set();
        const issues = [];

        for (const key of toolKeys) {
            try {
                const resolved = resolveConnectionConfig(key);
                const tool = {
                    effectiveMode: resolved.mode,
                    profileId: resolved.profileId || null,
                    proxyUrl: resolved.proxyUrl || null,
                    model: resolved.model || null,
                    maxTokens: resolved.maxTokens,
                    timeout: resolved.timeout,
                };

                // If profile mode, check if the profile actually exists
                if (resolved.mode === 'profile' && resolved.profileId) {
                    const profile = lookupProfile(resolved.profileId);
                    if (!profile) {
                        tool.profileExists = false;
                        issues.push(`${key}: profileId '${resolved.profileId}' not found in Connection Manager`);
                    } else {
                        tool.profileExists = true;
                        tool.profileName = maskString(profile.name);
                        tool.profileApi = profile.api;
                        tool.profileModel = profile.model;
                        seenProfileIds.add(resolved.profileId);
                    }
                }

                tools[key] = tool;
            } catch (e) {
                tools[key] = { __error: String(e) };
            }
        }

        // Full profile objects for referenced profiles (deduplicated)
        const profiles = {};
        for (const id of seenProfileIds) {
            const p = lookupProfile(id);
            if (p) profiles[id] = summarizeProfile(p);
        }

        // Resolve CONNECT_API_MAP for each referenced profile
        const apiMapResolutions = {};
        for (const [id, prof] of Object.entries(profiles)) {
            if (prof?.api) {
                apiMapResolutions[id] = resolveApiMap(prof.api);
            }
        }

        // ST's active main API state — what 'inherit'/'st' mode actually hits
        let stActiveConnection = null;
        try {
            const ctx = (typeof globalThis.SillyTavern?.getContext === 'function')
                ? globalThis.SillyTavern.getContext() : null;
            const oai = ctx?.chatCompletionSettings;
            stActiveConnection = {
                mainApi: ctx?.mainApi || null,
                chatCompletionSource: oai?.chat_completion_source || null,
                reverseProxy: oai?.reverse_proxy || null,
                openrouterModel: oai?.openrouter_model || null,
                selectedModel: oai?.openai_model || null,
                claudeModel: oai?.claude_model || null,
            };
            // Also check ST's own selected connection profile
            const ext = ctx?.extensionSettings || globalThis.extension_settings;
            stActiveConnection.selectedProfileId = ext?.connectionManager?.selectedProfile || null;
            stActiveConnection.totalProfiles = Array.isArray(ext?.connectionManager?.profiles)
                ? ext.connectionManager.profiles.length : 0;
        } catch { /* noop */ }

        return {
            tools,
            profiles,
            apiMapResolutions,
            stActiveConnection,
            issues: issues.length > 0 ? issues : null,
        };
    } catch (e) { return { __error: String(e) }; }
}

/**
 * Build the full state snapshot. Returned object is NOT yet scrubbed —
 * the export pipeline runs scrubDeep() on the whole thing before serializing.
 */
export function captureStateSnapshot() {
    // Fresh pseudonym/mask tables per snapshot — aliases are NOT correlated across exports
    _titleMap = new Map();
    _titleCounter = 0;
    _vaultSourceMap = new Map();
    _vaultSourceCounter = 0;
    resetMaskCaches();

    const snap = {
        capturedAt: new Date().toISOString(),
        capturedAtMs: Date.now(),
        system: systemInfo(),
        extensionInventory: extensionInventory(),
    };

    // Settings (full — scrubber redacts API keys by name)
    // Captured early so setupState and uiCascadeState can reference it (avoids double getSettings() TOCTOU)
    try { snap.settings = getSettings(); } catch (e) { snap.settings = { __error: String(e) }; }

    // Setup wizard + migration state
    try {
        const s = snap.settings && !snap.settings.__error ? snap.settings : getSettings();
        snap.setupState = {
            wizardCompleted: !!s._wizardCompleted,
            localStorageSentinel: typeof localStorage !== 'undefined' && localStorage.getItem('dle-wizard-completed') === '1',
            settingsVersion: s.settingsVersion ?? null,
            vaultsMigrated: !!s._vaultsMigrated,
            advancedVisibleMigrated: !!s._advancedVisibleMigratedD4,
            hasEnabledVaults: Array.isArray(s.vaults) ? s.vaults.some(v => v.enabled) : false,
            vaultCount: Array.isArray(s.vaults) ? s.vaults.length : 0,
            vaultSummary: Array.isArray(s.vaults) ? s.vaults.map(v => ({
                enabled: !!v.enabled,
                hasHost: !!(v.host || v.url),
                hasApiKey: !!(v.apiKey),
                name: maskString(v.name) || null,
            })) : [],
            indexEverLoaded: state.indexEverLoaded,
            // Mismatch: wizard says done but no vaults enabled = likely skipped or partial
            possiblyIncomplete: !!s._wizardCompleted && !(Array.isArray(s.vaults) && s.vaults.some(v => v.enabled)),
        };
    } catch (e) { snap.setupState = { __error: String(e) }; }

    // Connection profiles — resolved per-tool config + ST profile objects + active main API
    try { snap.connections = connectionSnapshot(); } catch (e) { snap.connections = { __error: String(e) }; }

    // Derived UI cascade state — explains why specific controls are disabled/hidden
    try {
        const s = snap.settings || {};
        snap.uiCascadeState = {
            maxEntries: { disabled: !!s.unlimitedEntries, reason: 'unlimitedEntries' },
            maxTokensBudget: { disabled: !!s.unlimitedBudget, reason: 'unlimitedBudget' },
            aiNotepadConnection: { hidden: s.aiNotepadMode === 'tag', reason: 'aiNotepadMode=tag' },
            keywordMatchingSettings: { disabled: s.aiSearchEnabled && s.aiSearchMode === 'ai-only', reason: 'aiSearchMode=ai-only' },
            scanDepth: { hidden: s.aiSearchEnabled && s.aiSearchMode === 'ai-only', reason: 'aiSearchMode=ai-only' },
            fuzzyMinScore: { hidden: !s.fuzzySearchEnabled, reason: 'fuzzySearchEnabled' },
            maxRecursion: { disabled: !s.recursiveScan, reason: 'recursiveScan' },
            stripLookback: { disabled: !s.stripDuplicateInjections, reason: 'stripDuplicateInjections' },
        };
    } catch (e) { snap.uiCascadeState = { __error: String(e) }; }

    // Manifest version — read from our own manifest.json (cached after first load)
    try {
        snap.dleVersion = _cachedDleVersion || 'unknown';
    } catch { snap.dleVersion = 'unknown'; }

    // Vault index summary
    try {
        const idx = state.vaultIndex || [];
        snap.vault = {
            entryCount: idx.length,
            indexTimestamp: state.indexTimestamp,
            indexEverLoaded: state.indexEverLoaded,
            indexing: state.indexing,
            buildPromiseActive: state.buildPromise !== null,
            buildEpoch: state.buildEpoch,
            syncActive: state.syncIntervalId !== null,
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
            folderDistribution: (state.folderList || []).map(f => ({
                path: pseudonymizeTitle(f.path || '?'),
                entryCount: f.entryCount ?? 0,
            })),
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
            notepadExtractInProgress: state.notepadExtractInProgress,
            scribeInProgress: state.scribeInProgress,
            lastScribeChatLength: state.lastScribeChatLength ?? null,
            hasLastScribeSummary: !!state.lastScribeSummary,
            perSwipeInjectedKeysCount: state.perSwipeInjectedKeys?.size ?? 0,
            lastPipelineTrace: pseudonymizeTrace(state.lastPipelineTrace),
            // Injection sources — count and epoch for verifying pipeline output vs actual injection
            lastInjectionSourceCount: Array.isArray(state.lastInjectionSources) ? state.lastInjectionSources.length : 0,
            lastInjectionEpoch: state.lastInjectionEpoch ?? null,
            injectionEpochMatchesChatEpoch: state.lastInjectionEpoch === state.chatEpoch,
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
        if (state.claudeAutoEffortBad !== undefined) {
            snap.ai.claudeAutoEffortBad = state.claudeAutoEffortBad;
            snap.ai.claudeAutoEffortDetail = state.claudeAutoEffortDetail;
        }
    } catch (e) { snap.ai = { __error: String(e) }; }

    // Librarian subsystem
    try {
        snap.librarian = {
            sessionStats: state.librarianSessionStats,
            chatStats: state.librarianChatStats,
            loreGapsCount: Array.isArray(state.loreGaps) ? state.loreGaps.length : 0,
            loreGapSearchCount: state.loreGapSearchCount,
        };
    } catch (e) { snap.librarian = { __error: String(e) }; }

    // Entity matching state
    try {
        snap.matching = {
            entityNameSetSize: state.entityNameSet?.size ?? 0,
            entityRegexCount: state.entityShortNameRegexes?.size ?? 0,
            entityRegexVersion: state.entityRegexVersion,
            fieldDefinitionsCount: Array.isArray(state.fieldDefinitions) ? state.fieldDefinitions.length : 0,
            fieldDefinitionsLoaded: state.fieldDefinitionsLoaded,
            mentionWeightsCount: state.mentionWeights?.size ?? 0,
            fuzzySearchIndexBuilt: !!state.fuzzySearchIndex,
        };
    } catch (e) { snap.matching = { __error: String(e) }; }

    // Auto-suggest subsystem
    try {
        const s = snap.settings && !snap.settings.__error ? snap.settings : {};
        snap.autoSuggest = {
            enabled: !!s.autoSuggestEnabled,
            interval: s.autoSuggestInterval ?? null,
            messageCount: state.autoSuggestMessageCount ?? 0,
            messagesUntilTrigger: s.autoSuggestEnabled
                ? Math.max(0, (s.autoSuggestInterval ?? 10) - (state.autoSuggestMessageCount ?? 0))
                : null,
            skipReview: !!s.autoSuggestSkipReview,
            folder: s.autoSuggestFolder || null,
        };
    } catch (e) { snap.autoSuggest = { __error: String(e) }; }

    // Staleness indicator — was snapshot captured during active generation?
    try {
        snap.staleness = {
            capturedDuringGeneration: !!state.generationLock,
            generationLockAgeMs: state.generationLock ? Date.now() - state.generationLockTimestamp : null,
            generationLockZombie: state.generationLock && (Date.now() - state.generationLockTimestamp > 60000),
            capturedDuringIndexBuild: !!state.indexing || state.buildPromise !== null,
        };
    } catch {}

    // Vault fetch failures + per-vault Obsidian circuit breaker state
    try {
        snap.vaultFetch = {
            lastVaultFailureCount: state.lastVaultFailureCount,
            lastVaultAttemptCount: state.lastVaultAttemptCount,
        };
    } catch {}
    try {
        const perVault = getAllCircuitStates();
        if (Object.keys(perVault).length > 0) {
            // Pseudonymize host:port keys to prevent IP/hostname leakage
            // Use <vault-N> aliases keyed by original host:port
            const masked = {};
            let vaultIdx = 0;
            for (const [key, val] of Object.entries(perVault)) {
                masked[`<vault-${++vaultIdx}>`] = val;
            }
            snap.obsidianCircuitBreakers = masked;
        } else {
            snap.obsidianCircuitBreakers = null;
        }
    } catch (e) { snap.obsidianCircuitBreakers = { __error: String(e) }; }

    // Chat context at generation time — character, group, chat length, last message role
    try {
        const ctx = (typeof globalThis.SillyTavern?.getContext === 'function')
            ? globalThis.SillyTavern.getContext() : null;
        if (ctx) {
            const chatArr = ctx.chat;
            const lastMsg = Array.isArray(chatArr) && chatArr.length > 0 ? chatArr[chatArr.length - 1] : null;
            snap.chatContext = {
                characterId: ctx.characterId ?? null,
                characterName: maskString(ctx.name2) ?? null,
                groupId: ctx.groupId ?? null,
                isGroupChat: !!ctx.groupId,
                chatLength: Array.isArray(chatArr) ? chatArr.length : 0,
                lastMessageRole: lastMsg?.is_user ? 'user' : lastMsg?.is_system ? 'system' : lastMsg ? 'assistant' : null,
                lastMessageHasContent: lastMsg ? !!(lastMsg.mes && lastMsg.mes.length > 0) : null,
            };
        }
    } catch (e) { snap.chatContext = { __error: String(e) }; }

    // Note: Agentic loop manages its own API calls — no ToolManager registration needed.

    // AI cache version mismatch detection
    try {
        if (snap.ai && typeof snap.ai === 'object' && !snap.ai.__error
            && state.aiSearchCache && state.entityRegexVersion !== undefined) {
            const cacheRegexVersion = state.aiSearchCache.entityRegexVersion;
            snap.ai.cacheRegexVersionMatch = cacheRegexVersion === state.entityRegexVersion;
            snap.ai.cacheRegexVersion = cacheRegexVersion;
            snap.ai.currentRegexVersion = state.entityRegexVersion;
        }
    } catch {}

    // Lore gap hidden/dismissed counts from chat_metadata
    try {
        if (snap.librarian && typeof snap.librarian === 'object' && !snap.librarian.__error) {
            const cm = globalThis.chat_metadata || {};
            const hidden = cm.deeplore_lore_gaps_hidden;
            const dismissed = cm.deeplore_lore_gaps_dismissed;
            snap.librarian.gapsHiddenCount = Array.isArray(hidden) ? hidden.length : 0;
            snap.librarian.gapsDismissedCount = Array.isArray(dismissed) ? dismissed.length : 0;
        }
    } catch {}

    // Actually-registered DLE extension prompts — verifies pipeline output vs prompt injection
    try {
        const ep = globalThis.extension_prompts || {};
        const dlePrompts = Object.entries(ep)
            .filter(([k]) => k.startsWith('deeplore'))
            .map(([k, v]) => ({ tag: k, length: (v?.value || '').length, position: v?.position, depth: v?.depth, role: v?.role }));
        snap.registeredPrompts = {
            count: dlePrompts.length,
            prompts: dlePrompts,
        };
    } catch (e) { snap.registeredPrompts = { __error: String(e) }; }

    // Contextual gating state — era, location, sceneType, characterPresent, custom fields
    // These are user-set metadata (not PII) and are critical for diagnosing "why didn't entry X fire?"
    try {
        const cm = globalThis.chat_metadata || {};
        const gatingCtx = cm.deeplore_context;
        if (gatingCtx && typeof gatingCtx === 'object') {
            snap.gatingContext = { ...gatingCtx };
            // Pseudonymize characterPresent values (could be character names)
            if (Array.isArray(snap.gatingContext.characterPresent)) {
                snap.gatingContext.characterPresent = snap.gatingContext.characterPresent.map(c => pseudonymizeTitle(c));
            }
        } else {
            snap.gatingContext = null;
        }
    } catch (e) { snap.gatingContext = { __error: String(e) }; }

    // Health check
    try { snap.health = runHealthCheck(); } catch (e) { snap.health = { __error: String(e) }; }

    // chat_metadata
    try { snap.chatMetadata = chatMetadataSnapshot(); } catch (e) { snap.chatMetadata = { __error: String(e) }; }

    return snap;
}
