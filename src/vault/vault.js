/**
 * DeepLore Enhanced — Vault index building and cache management
 */
import { getTokenCountAsync } from '../../../../../tokenizers.js';
import { oai_settings } from '../../../../../openai.js';
import { main_api, amount_gen } from '../../../../../../script.js';
import { getSettings } from '../../settings.js';
import { simpleHash } from '../../core/utils.js';
import { fetchAllMdFiles, fetchFieldDefinitions, diagnoseFetchFailure } from './obsidian-api.js';
import {
    vaultIndex, indexTimestamp, indexing, buildPromise, indexEverLoaded,
    aiSearchCache, previousIndexSnapshot, trackerKey,
    setVaultIndex, setIndexTimestamp, setIndexing, setBuildPromise,
    setIndexEverLoaded, setAiSearchCache, resetAiSearchCache, setPreviousIndexSnapshot,
    setEntityNameSet, setEntityShortNameRegexes, setVaultAvgTokens,
    setFuzzySearchIndex, setMentionWeights, setFolderList,
    setLastVaultFailureCount, setLastVaultAttemptCount,
    notifyIndexUpdated,
    generationCount, lastIndexGenerationCount, setLastIndexGenerationCount,
    chatEpoch, buildEpoch,
    fieldDefinitions, setFieldDefinitions,
    setIndexBuildReport,
    entityRegexVersion,
} from '../state.js';
import { DEFAULT_FIELD_DEFINITIONS, parseFieldDefinitionYaml } from '../fields.js';
import { resolveLinks } from '../../core/matching.js';
import { parseVaultFile } from '../../core/pipeline.js';
import { takeIndexSnapshot, detectChanges } from '../../core/sync.js';
import { showChangesToast } from './sync.js';
import { saveIndexToCache, loadIndexFromCache, pruneOrphanedCacheKeys } from './cache.js';
import { dedupError, dedupWarning } from '../toast-dedup.js';
import { pushEvent } from '../diagnostics/interceptors.js';
// BM25 pure functions extracted to bm25.js for testability
import { buildBM25Index, setDebugMode as setBm25DebugMode } from './bm25.js';
// bm25 functions imported for internal use; consumers should import directly from ./bm25.js

// Pure functions extracted to vault-pure.js for testability
import { computeEntityDerivedState, deduplicateMultiVault, detectCrossVaultDuplicates } from './vault-pure.js';
export { computeEntityDerivedState, deduplicateMultiVault, detectCrossVaultDuplicates };

// ─── Constants ───
// BUG-381: Renamed from OBSIDIAN_FETCH_TIMEOUT — used only as a toastr `timeOut`
// (display duration in ms), never as an actual fetch/abort timeout.
const OBSIDIAN_TOAST_TIMEOUT = 15000;
const CACHE_FALLBACK_TOAST_TIMEOUT = 10000;

// computeEntityDerivedState and deduplicateMultiVault — extracted to vault-pure.js, imported above

/**
 * Shared post-processing after entries are parsed (used by both buildIndex and buildIndexWithReuse).
 * Computes derived state, invalidates caches, prunes analytics, persists to IndexedDB,
 * and notifies the UI layer (stats, health checks) via registered callbacks.
 *
 * @param {object} options
 * @param {Array} options.entries - The parsed VaultEntry array (already set into vaultIndex)
 * @param {object} options.settings - Current extension settings
 * @param {boolean} [options.skipCacheSave=false] - If true, skip persisting to IndexedDB (e.g. when a vault fetch failed)
 */
/**
 * BUG-370: Compute derived index fields (mentionWeights, folderList, vaultAvgTokens)
 * Shared between finalizeIndex (after full build) and hydrateFromCache (cold start)
 * so cache-hydrated sessions aren't stuck with degraded scoring until a full rebuild.
 */
function computeDerivedIndexFields(entries, settings) {
    // Propagate debug mode to BM25 module (no ST dependency in test environments)
    setBm25DebugMode(settings?.debugMode);

    // Compute vault average token count for Context Map coloring
    const totalTokens = entries.reduce((sum, e) => sum + (e.tokenEstimate || 0), 0);
    setVaultAvgTokens(entries.length > 0 ? totalTokens / entries.length : 0);

    // Build cross-entry mention weight table.
    // BUG-374: Precompile one combined regex per target entry and pre-lowercase content once,
    // so it's O(N × total_content) instead of O(N × M_names × content).
    {
        const weights = new Map();
        const targetNames = new Map(); // targetTitle → string[]
        for (const entry of entries) {
            const names = [entry.title.toLowerCase()];
            for (const key of entry.keys) {
                const keyLc = key.toLowerCase();
                if (keyLc.length >= 2) names.push(keyLc);
            }
            targetNames.set(entry.title, names);
        }
        const targetRegexes = new Map();
        for (const [title, names] of targetNames) {
            const parts = names.map(name => {
                const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return name.length <= 3 ? `\\b${escaped}\\b` : escaped;
            });
            parts.sort((a, b) => b.length - a.length);
            targetRegexes.set(title, new RegExp(parts.join('|'), 'gi'));
        }
        const contentLower = new Map();
        for (const source of entries) {
            contentLower.set(source.title, source.content.toLowerCase());
        }
        for (const source of entries) {
            const content = contentLower.get(source.title);
            const sourceName = source.title;
            for (const [targetTitle, regex] of targetRegexes) {
                if (targetTitle === sourceName) continue;
                regex.lastIndex = 0;
                let count = 0;
                while (regex.exec(content) !== null) count++;
                if (count > 0) {
                    weights.set(`${sourceName}\0${targetTitle}`, count);
                }
            }
        }
        setMentionWeights(weights);
        if (settings?.debugMode) {
            console.debug(`[DLE] Built mention weights: ${weights.size} pairs`);
        }
    }

    // Compute folder list from vault entries for folder-based filtering UI
    {
        const folderCounts = new Map();
        for (const entry of entries) {
            if (entry.folderPath) {
                const parts = entry.folderPath.split('/');
                for (let i = 1; i <= parts.length; i++) {
                    const ancestor = parts.slice(0, i).join('/');
                    folderCounts.set(ancestor, (folderCounts.get(ancestor) || 0) + 1);
                }
            }
        }
        const list = [...folderCounts.entries()]
            .map(([path, entryCount]) => ({ path, entryCount }))
            .sort((a, b) => b.entryCount - a.entryCount);
        setFolderList(list);
    }
}

async function finalizeIndex({ entries, settings, skipCacheSave = false }) {
    // BUG-370: derived fields now shared with hydrateFromCache via computeDerivedIndexFields.
    // (vaultAvgTokens set inside the helper.)

    // Resolve wiki-links to confirmed entry titles
    resolveLinks(vaultIndex);

    // Strip dangling requires/excludes/cascade_links references so the pipeline
    // doesn't trip over them every generation. Originals are preserved on parallel
    // _original* fields so the health check can still surface broken refs.
    {
        const validTitles = new Set(entries.map(e => e.title.toLowerCase()));
        const filterValid = (arr) => arr.filter(ref => validTitles.has(String(ref).toLowerCase()));
        for (const entry of entries) {
            if (Array.isArray(entry.requires) && entry.requires.length) {
                const cleaned = filterValid(entry.requires);
                if (cleaned.length !== entry.requires.length) {
                    entry._originalRequires = entry.requires.slice();
                    entry.requires = cleaned;
                }
            }
            if (Array.isArray(entry.excludes) && entry.excludes.length) {
                const cleaned = filterValid(entry.excludes);
                if (cleaned.length !== entry.excludes.length) {
                    entry._originalExcludes = entry.excludes.slice();
                    entry.excludes = cleaned;
                }
            }
            if (Array.isArray(entry.cascadeLinks) && entry.cascadeLinks.length) {
                const cleaned = filterValid(entry.cascadeLinks);
                if (cleaned.length !== entry.cascadeLinks.length) {
                    entry._originalCascadeLinks = entry.cascadeLinks.slice();
                    entry.cascadeLinks = cleaned;
                }
            }
        }
    }

    // BUG-370/374: mentionWeights, folderList, vaultAvgTokens computed in shared helper
    computeDerivedIndexFields(entries, settings);

    // Capture pre-rebuild state for cache-invalidation diagnostic.
    const _preRegexVersion = entityRegexVersion;
    const _preCacheResultCount = aiSearchCache?.results?.length ?? 0;
    const _preCacheHadHash = !!aiSearchCache?.hash;

    // Pre-compute entity names and short-name regexes for AI cache sliding window
    computeEntityDerivedState(entries);

    // Build BM25 index if fuzzy search or Librarian search is enabled
    if (settings.fuzzySearchEnabled || settings.librarianSearchEnabled) {
        setFuzzySearchIndex(buildBM25Index(entries));
    } else {
        setFuzzySearchIndex(null);
    }

    // Invalidate AI search cache on re-index. Log the reason so "why did my cache
    // go stale mid-session" is diagnosable post-facto without repro.
    if (_preCacheHadHash || _preCacheResultCount > 0) {
        pushEvent('cache_invalidate', {
            trigger: 'index_rebuild',
            regexVersionBefore: _preRegexVersion,
            regexVersionAfter: entityRegexVersion,
            cachedResultsCleared: _preCacheResultCount,
            entriesAfter: entries.length,
        });
        console.debug('[DLE][DIAG] aiSearchCache cleared: trigger=index_rebuild regex v%d→v%d cachedResults=%d entriesAfter=%d',
            _preRegexVersion, entityRegexVersion, _preCacheResultCount, entries.length);
    }
    resetAiSearchCache();

    // Vault change detection
    const newSnapshot = takeIndexSnapshot(vaultIndex);
    if (previousIndexSnapshot) {
        const changes = detectChanges(previousIndexSnapshot, newSnapshot);
        if (changes.hasChanges) {
            if (settings.showSyncToasts) {
                showChangesToast(changes);
            }
            if (settings.debugMode) {
                console.log('[DLE] Vault changes detected:', changes);
            }
        }
    }
    setPreviousIndexSnapshot(newSnapshot);

    setIndexEverLoaded(true);

    // One-time large vault performance hint
    if (entries.length >= 500 && !finalizeIndex._largeVaultWarned) {
        finalizeIndex._largeVaultWarned = true;
        toastr.info(
            `Large vault detected (${entries.length} entries). Consider using folder filtering or reducing scan depth for better performance.`,
            'DeepLore Enhanced',
            { timeOut: 8000 },
        );
    }

    // BUG-370: folder list already computed in computeDerivedIndexFields above.

    // BUG-026: Prune analytics data for entries no longer in the vault.
    // This intentionally mutates the live settings.analyticsData object — the pruned data
    // is persisted by saveSettingsDebounced() later in the pipeline. Removing stale entries
    // here prevents unbounded growth when vault entries are renamed or deleted.
    const analytics = settings.analyticsData;
    if (analytics) {
        const activeKeys = new Set(vaultIndex.map(e => trackerKey(e)));
        for (const key of Object.keys(analytics)) {
            // BUG-AUDIT-DP01: Skip sub-objects like _librarian — they aren't tracker keys
            // and were being silently wiped on every vault rebuild.
            if (key.startsWith('_')) continue;
            if (!activeKeys.has(key)) delete analytics[key];
        }
    }

    // Persist to IndexedDB for instant hydration on next page load
    if (!skipCacheSave) {
        saveIndexToCache(entries).catch(err => console.warn('[DLE] Cache save failed:', err?.message));
        // H20: Clean up orphaned cache keys from previous vault configurations
        pruneOrphanedCacheKeys().catch(err => console.warn('[DLE] Cache prune failed:', err?.message));
    }

    // Diagnostic breadcrumb: record index build completion
    pushEvent('index_build', { entryCount: entries.length, skipCacheSave });

    // Notify UI layer (stats display, health check badge, etc.)
    // Callbacks are registered by settings-ui.js during init — this avoids
    // the data layer (vault.js) importing from the UI layer (settings-ui.js).
    notifyIndexUpdated();
}

/**
 * Build the vault index by fetching all files directly from Obsidian.
 */
export async function buildIndex() {
    if (indexing) {
        if (getSettings().debugMode) console.debug('[DLE] Index build already in progress, awaiting existing build');
        return buildPromise;
    }

    // BUG-010: Atomically set buildPromise BEFORE setIndexing(true) so any synchronous
    // observer that reads `indexing===true` always finds a populated `buildPromise`
    // (never the stale/null previous value). Use a deferred promise pattern: the outer
    // promise is created and installed synchronously, then the IIFE resolves/rejects it.
    let _buildResolve, _buildReject;
    const promise = new Promise((res, rej) => { _buildResolve = res; _buildReject = rej; });
    setBuildPromise(promise);
    setIndexing(true);
    let capturedEpoch = buildEpoch;
    (async () => {
    const _buildStart = performance.now();
    const settings = getSettings();
    const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
    try {
        capturedEpoch = buildEpoch;
        const isZombie = () => buildEpoch !== capturedEpoch;
        if (enabledVaults.length === 0) {
            throw new Error('No enabled vaults configured');
        }

        // ── Load custom field definitions ──
        // BUG-F4: Resolve into a local variable first, then set state ONCE before parsing.
        // This prevents entries from being parsed with inconsistent definitions if fallback logic triggers.
        const primaryVault = enabledVaults[0];
        const fieldDefPath = settings.fieldDefinitionsPath || 'DeepLore/field-definitions.yaml';
        let loadedFieldDefs = [...DEFAULT_FIELD_DEFINITIONS];
        try {
            const fdResult = await fetchFieldDefinitions(primaryVault.host, primaryVault.port, primaryVault.apiKey, fieldDefPath, !!primaryVault.https);
            if (fdResult.ok && fdResult.content) {
                const { definitions, errors } = parseFieldDefinitionYaml(fdResult.content);
                if (definitions.length > 0) {
                    loadedFieldDefs = definitions;
                    if (settings.debugMode) console.log(`[DLE] Loaded ${definitions.length} custom field definitions from ${fieldDefPath}`);
                    if (errors.length > 0) console.warn('[DLE] Field definition warnings:', errors);
                } else {
                    if (settings.debugMode) console.log('[DLE] Field definitions file empty, using defaults');
                }
            } else {
                if (fdResult.error === 'not_found') {
                    if (settings.debugMode) console.log('[DLE] Field definitions file not found — using defaults');
                } else if (settings.debugMode) {
                    console.warn('[DLE] Could not load field definitions:', fdResult.error, '— using defaults');
                }
            }
        } catch (err) {
            console.warn('[DLE] Error loading field definitions:', err.message, '— using defaults');
        }
        // BUG-305: Defer publishing loadedFieldDefs into state until we know we're going
        // to commit a new vaultIndex. Publishing here meant that if all vaults failed in
        // multi-vault mode (early-return at L350) the new fieldDefinitions would be live
        // against the OLD preserved vaultIndex — a mismatched combination where the index
        // was parsed with the old defs but gating runs against the new ones. Parse with
        // loadedFieldDefs locally, then publish atomically alongside setVaultIndex below.
        if (isZombie()) return;

        let entries = [];
        const tagConfig = {
            lorebookTag: settings.lorebookTag,
            constantTag: settings.constantTag,
            neverInsertTag: settings.neverInsertTag,
            seedTag: settings.seedTag,
            bootstrapTag: settings.bootstrapTag,
            guideTag: settings.librarianGuideTag,
        };

        // B.1/B.4: Per-build parser ledger. Populated by parseVaultFile's onSkip
        // callback + per-entry `_parserWarnings`. Published via setIndexBuildReport
        // before finalizeIndex so /dle-lint and the summary toast can read it.
        const buildReport = {
            okCount: 0,
            warnCount: 0,
            skipCount: 0,
            skipped: [],
            entriesWithWarnings: [],
        };
        const lenientAuthoring = settings.lenientAuthoring !== false;

        let totalFiles = 0;
        let vaultFetchFailed = false;
        let vaultFailCount = 0;
        // BUG-366/367: Snapshot the prior live index BEFORE fetching so we can carry
        // forward per-vault slices if a vault comes back partial or successful-but-empty.
        const priorIndexSnapshot = [...vaultIndex];
        setLastVaultAttemptCount(enabledVaults.length);
        for (const vault of enabledVaults) {
            try {
                const data = await fetchAllMdFiles(vault.host, vault.port, vault.apiKey, !!vault.https);
                if (!data.files || !Array.isArray(data.files)) {
                    console.warn(`[DLE] Vault "${vault.name}" returned invalid data`);
                    continue;
                }

                // BUG-366: Partial directory listing — don't commit a truncated view on top
                // of a known-good index. Carry forward previous entries for this vault.
                if (data.partial) {
                    console.warn(`[DLE] Vault "${vault.name}" returned a partial directory listing — preserving previous entries for this vault`);
                    vaultFetchFailed = true;
                    vaultFailCount++;
                    dedupWarning(
                        `Some folders in "${vault.name}" couldn't be listed — keeping the previously indexed entries for this vault.`,
                        'vault_fetch_partial',
                    );
                    for (const entry of priorIndexSnapshot) {
                        if (entry.vaultSource === vault.name) entries.push(entry);
                    }
                    continue;
                }

                // BUG-367: Successful-but-empty preserve guard. If Obsidian returned zero
                // files but we previously had entries for this vault, treat as transient
                // and carry forward rather than silently wiping a valid index.
                if (data.files.length === 0) {
                    const priorForThisVault = priorIndexSnapshot.filter(e => e.vaultSource === vault.name);
                    if (priorForThisVault.length > 0) {
                        console.warn(`[DLE] Vault "${vault.name}" returned 0 files but prior index had ${priorForThisVault.length} entries — preserving`);
                        vaultFetchFailed = true;
                        vaultFailCount++;
                        dedupWarning(
                            `"${vault.name}" returned no files — keeping the ${priorForThisVault.length} previously indexed entries.`,
                            'vault_empty_preserve',
                        );
                        for (const entry of priorForThisVault) entries.push(entry);
                        continue;
                    }
                }

                totalFiles += data.total || data.files.length;

                // Warn if a significant portion of files failed to fetch
                if (data.failed > 0) {
                    const failRate = data.total > 0 ? data.failed / data.total : 0;
                    if (data.failed >= 5 || failRate >= 0.1) {
                        dedupWarning(
                            `Some entries in "${vault.name}" couldn't be loaded (${data.failed} of ${data.total}). They'll be included on the next refresh.`,
                            'vault_fetch_partial',
                        );
                    }
                }

                for (const file of data.files) {
                    // BUG-305: parse with the locally-loaded defs, not the (possibly stale) global.
                    const entry = parseVaultFile(file, tagConfig, loadedFieldDefs, {
                        lenientAuthoring,
                        onSkip: (reason) => {
                            buildReport.skipped.push({ filename: file.filename, reason });
                            buildReport.skipCount++;
                        },
                    });
                    if (entry) {
                        entry.vaultSource = vault.name;
                        entry._contentHash = simpleHash(file.content);
                        if (entry._parserWarnings && entry._parserWarnings.length > 0) {
                            buildReport.warnCount++;
                            buildReport.entriesWithWarnings.push({
                                filename: file.filename,
                                title: entry.title,
                                warnings: entry._parserWarnings,
                            });
                        } else {
                            buildReport.okCount++;
                        }
                        entries.push(entry);
                    }
                }
            } catch (vaultErr) {
                console.warn(`[DLE] Failed to index vault "${vault.name}":`, vaultErr.message);
                vaultFetchFailed = true;
                vaultFailCount++;
                // Surface auth errors as user-facing toasts even in multi-vault mode
                // (otherwise a misconfigured API key silently produces zero entries)
                if (/401|403/.test(String(vaultErr.message))) {
                    dedupWarning(`Vault "${vault.name}" rejected the API key.`, 'vault_auth', { hint: 'Check the API key in Connection → Obsidian.' });
                }
                if (enabledVaults.length === 1) throw vaultErr;
            }
        }
        setLastVaultFailureCount(vaultFailCount);

        // BUG-001: If ALL enabled vaults failed in multi-vault mode, preserve existing index
        // instead of replacing it with an empty array (which would destroy valid cached data)
        if (vaultFailCount > 0 && vaultFailCount === enabledVaults.length && enabledVaults.length > 1) {
            if (isZombie()) return;
            dedupError(
                'Couldn\'t reach any of your vaults — keeping the lore you already had.',
                'obsidian_connect',
                { hint: `${enabledVaults.length} vaults failed; existing ${vaultIndex.length} entries preserved.` },
            );
            // Set short-lived timestamp so ensureIndexFresh retries soon
            const ttl = settings.cacheTTL * 1000;
            setIndexTimestamp(Date.now() - ttl + 30_000); // retry in ~30s
            setIndexing(false);
            setBuildPromise(null);
            return;
        }

        // Compute accurate token counts using SillyTavern's tokenizer
        let _tokenizerFailCount = 0;
        await Promise.all(entries.map(async (entry) => {
            try {
                entry.tokenEstimate = await getTokenCountAsync(entry.content);
            } catch {
                // Fallback to rough estimate if tokenizer unavailable
                entry.tokenEstimate = Math.ceil(entry.content.length / 4.0);
                _tokenizerFailCount++;
            }
        }));
        if (_tokenizerFailCount > 0) {
            console.warn(`[DLE] Tokenizer failed for ${_tokenizerFailCount}/${entries.length} entries — using character-based estimates (budget accuracy degraded)`);
        }

        // Warn about cross-vault duplicate titles (forbidden — causes Map key collisions)
        if (enabledVaults.length > 1) {
            const dupes = detectCrossVaultDuplicates(entries);
            if (dupes.length > 0) {
                const listing = dupes.slice(0, 5).map(d => `"${d.title}" (${d.vaults.join(', ')})`).join('; ');
                const more = dupes.length > 5 ? ` …and ${dupes.length - 5} more` : '';
                dedupWarning(
                    `Duplicate entry titles across vaults: ${listing}${more}. Keeping the first vault's copy. Rename one copy to avoid issues.`,
                    'cross_vault_dupes',
                    { timeOut: OBSIDIAN_TOAST_TIMEOUT },
                );
            }
        }

        // E6: Multi-vault conflict resolution dedup pass (BUG-007: shared with buildIndexWithReuse)
        entries = deduplicateMultiVault(entries, settings.multiVaultConflictResolution);

        if (isZombie()) return;
        // BUG-305: atomically publish fieldDefinitions together with the new vaultIndex.
        // Both are committed together so no intermediate state can observe new defs with
        // old entries or vice versa.
        setFieldDefinitions(loadedFieldDefs);
        setVaultIndex(entries);
        setIndexTimestamp(Date.now());

        if (settings.debugMode) console.log(`[DLE] Indexed ${entries.length} entries from ${totalFiles} vault files across ${enabledVaults.length} vault(s)`);
        console.log('[DLE] Index built: %d entries in %dms (mode: fresh)', entries.length, Math.round(performance.now() - _buildStart));

        if (isZombie()) return;
        // B.1/B.4: publish parser ledger BEFORE finalizeIndex so any observer
        // triggered by finalize (stats refresh, health check) can read it.
        setIndexBuildReport(buildReport);
        await finalizeIndex({ entries, settings, skipCacheSave: vaultFetchFailed });

        // B.5: Loud summary toast when the parser flagged warnings or skips.
        if (buildReport.warnCount > 0 || buildReport.skipCount > 0) {
            const parts = [`DLE indexed ${entries.length} entries.`];
            if (buildReport.warnCount > 0) parts.push(`${buildReport.warnCount} warning${buildReport.warnCount === 1 ? '' : 's'}`);
            if (buildReport.skipCount > 0) parts.push(`${buildReport.skipCount} skipped`);
            dedupWarning(
                `${parts.join(', ').replace(/,([^,]*)$/, ';$1')}. Run /dle-lint for details.`,
                'parser_ledger_summary',
                { timeOut: OBSIDIAN_TOAST_TIMEOUT },
            );
        }

        // Zero-entry warning when connection succeeded but no lorebook-tagged entries found
        if (entries.length === 0 && !vaultFetchFailed) {
            const tag = settings.lorebookTag || 'lorebook';
            dedupWarning(
                `Connected to Obsidian but found 0 entries with the '${tag}' tag. Add \`tags: [${tag}]\` to your note frontmatter to make entries visible to DeepLore.`,
                'zero_entries',
                { timeOut: OBSIDIAN_TOAST_TIMEOUT },
            );
        }
    } catch (err) {
        console.error('[DLE] Failed to build index:', err);
        const raw = String(err.message || err);
        let userMsg = raw;

        // Check for HTTPS cert failure on any enabled HTTPS vault
        const httpsVaults = enabledVaults.filter(v => v.https);
        if (httpsVaults.length > 0 && /Failed to fetch|TypeError|NetworkError/i.test(raw)) {
            try {
                const v = httpsVaults[0];
                const probe = await diagnoseFetchFailure(v.host, v.port, v.apiKey);
                if (probe.diagnosis === 'cert') {
                    userMsg = `HTTPS certificate not trusted. Switch to HTTP in vault settings (uncheck HTTPS, port ${probe.httpPort}), or trust the certificate. Run /dle-health for help.`;
                } else if (probe.diagnosis === 'auth') {
                    userMsg = `Connected via HTTP but authentication failed. Check your vault API key. Run /dle-health for help.`;
                } else {
                    userMsg = `Cannot reach Obsidian on either HTTPS or HTTP. Check that Obsidian is running with the Local REST API plugin enabled. Run /dle-health for diagnostics.`;
                }
            } catch { /* probe failed, fall through to generic classification */ }
        }

        if (userMsg === raw) {
            if (/ECONNREFUSED|Failed to fetch|NetworkError|fetch/i.test(raw)) {
                userMsg = `Connection failed. Check: (1) Obsidian is running, (2) Local REST API plugin is enabled, (3) port is correct. Run /dle-health for diagnostics. (${raw})`;
            } else if (/No enabled vaults/i.test(raw)) {
                userMsg = 'No enabled vaults configured. Go to DeepLore Enhanced settings → Vault Connections and add a vault.';
            } else if (/401|403|auth/i.test(raw)) {
                userMsg = `Authentication failed. Check your vault API key in settings. Run /dle-health for diagnostics. (${raw})`;
            } else if (/timeout|timed out/i.test(raw)) {
                userMsg = `Obsidian connection timed out. Check that the REST API plugin is running. Run /dle-health for diagnostics. (${raw})`;
            }
        }
        dedupError(userMsg, 'obsidian_build_fail');
    } finally {
        if (buildEpoch === capturedEpoch) {
            setIndexing(false);
            setBuildPromise(null); // BUG-044: Clear stale buildPromise
        }
        _buildResolve();
    }
    })().catch(err => { _buildReject(err); });
    // Note: the IIFE catches its own errors and resolves the deferred in finally.
    // The outer .catch is a safety net for any truly unexpected sync throw.
    return promise;
}

/**
 * Get the max response token length from the current connection profile.
 * @returns {number}
 */
export function getMaxResponseTokens() {
    return main_api === 'openai' ? oai_settings.openai_max_tokens : amount_gen;
}

/**
 * Hydrate the vault index from IndexedDB cache for instant startup.
 * After hydration, triggers a background rebuild to validate against Obsidian.
 * @returns {Promise<boolean>} True if cache was loaded
 */
export async function hydrateFromCache() {
    try {
        const cached = await loadIndexFromCache();
        if (!cached || cached.entries.length === 0) return false;

        setVaultIndex(cached.entries);
        // Set timestamp to 0 so ensureIndexFresh() always triggers a rebuild
        // (the cache is a fast approximation — Obsidian is the source of truth)
        setIndexTimestamp(0);
        resolveLinks(vaultIndex);
        // Compute entity name set for AI cache sliding window validation on cold start
        computeEntityDerivedState(cached.entries);
        // BUG-370: Compute mentionWeights, folderList, vaultAvgTokens so cold-start
        // generations don't run with degraded scoring until a full rebuild completes.
        const hydrateSettings = getSettings();
        computeDerivedIndexFields(cached.entries, hydrateSettings);
        // Build BM25 index during hydration so fuzzy search and Librarian tools
        // are available immediately, before the background rebuild completes
        if (hydrateSettings.fuzzySearchEnabled || hydrateSettings.librarianSearchEnabled) {
            setFuzzySearchIndex(buildBM25Index(cached.entries));
        }
        // Note: indexEverLoaded is NOT set here — it's set in buildIndex() after
        // a successful Obsidian fetch confirms the vault is reachable.
        notifyIndexUpdated();

        if (getSettings().debugMode) console.log(`[DLE] Hydrated ${cached.entries.length} entries from IndexedDB cache`);

        // Background: rebuild from Obsidian to validate cache freshness
        // H3: Capture epoch so stale background rebuilds don't apply to a different chat
        const hydrateEpoch = chatEpoch;
        buildIndex().then(() => {
            // BUG-377: Guard success continuation with the same chat-epoch check as the
            // catch branch. If the chat changed while the background rebuild was in flight,
            // any post-rebuild continuation (notifications, UI refresh) for the stale chat
            // must be skipped.
            if (chatEpoch !== hydrateEpoch) return;
        }).catch(err => {
            console.warn('[DLE] Background rebuild after cache hydration failed:', err.message);
            if (chatEpoch !== hydrateEpoch) return; // Chat changed — skip stale retry logic
            if (vaultIndex.length > 0) {
                // Cached data exists — set a short-lived timestamp so ensureIndexFresh() retries after a cooldown
                // (not Date.now() which would prevent retries until TTL expires)
                const s = getSettings();
                setIndexTimestamp(Date.now() - (s.cacheTTL * 1000) + 30_000); // retry in ~30s
                dedupWarning('Couldn\'t reach your vault — using your saved cache for now.', 'obsidian_cache_fallback', { timeOut: CACHE_FALLBACK_TOAST_TIMEOUT, hint: 'Check that Obsidian is running, then /dle-refresh.' });
            }
        });

        return true;
    } catch (err) {
        console.warn('[DLE] Failed to load cached vault data:', err.message);
        return false;
    }
}

/**
 * Rebuild vault index with reuse: fetches ALL file contents from every vault,
 * but skips re-parsing/tokenizing entries whose content hash is unchanged.
 * Despite fetching everything, this is faster than buildIndex() because
 * parse + tokenize is the expensive part — not the Obsidian fetch.
 * Falls back to full buildIndex if detection fails.
 * @returns {Promise<boolean>} True if rebuild-with-reuse was sufficient (no full rebuild needed)
 */
export async function buildIndexWithReuse() {
    if (indexing || vaultIndex.length === 0) {
        // If a build is in progress, await it — index is now fresh, no need for caller to rebuild.
        // BUG-AUDIT-CNEW03: Previously returned false, causing callers to trigger redundant full rebuilds.
        if (buildPromise) { await buildPromise; return true; }
        return false;
    }

    const settings = getSettings();
    const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
    if (enabledVaults.length === 0) return false;

    // BUG-010: Atomically install buildPromise before setIndexing(true) so sync observers
    // that see indexing===true always find a populated buildPromise.
    let _reuseResolve, _reuseReject;
    const promise = new Promise((res, rej) => { _reuseResolve = res; _reuseReject = rej; });
    setBuildPromise(promise);
    setIndexing(true);

    // BUG-AUDIT-C05: Capture buildEpoch so force-release (which bumps epoch) can signal
    // this build to bail out before committing stale results — same pattern as buildIndex().
    const capturedBuildEpoch = buildEpoch;
    const isZombie = () => buildEpoch !== capturedBuildEpoch;

    const tagConfig = {
        lorebookTag: settings.lorebookTag,
        constantTag: settings.constantTag,
        neverInsertTag: settings.neverInsertTag,
        seedTag: settings.seedTag,
        bootstrapTag: settings.bootstrapTag,
        guideTag: settings.librarianGuideTag,
    };

    // Snapshot vaultIndex to avoid races with concurrent builds
    const indexSnapshot = [...vaultIndex];

    (async () => {
    const _buildStart = performance.now();
    let _reuseResult = false;
    try {
        // BUG-F3: Reload field definitions during incremental sync (was only loaded in full buildIndex)
        // BUG-008: Resolve into a local variable first. Do NOT mutate shared `fieldDefinitions`
        // state mid-parse — doing so creates a half-stale window where reused entries still
        // carry customFields parsed under the old schema while newly-parsed entries use the new
        // schema, and concurrent readers of state see inconsistent definitions. Commit to state
        // once after parsing is complete (below, just before finalizeIndex).
        //
        // BUG-375: `oldFieldDefsHash` is captured HERE (reading the shared `fieldDefinitions`
        // state) before any possible setter call. The setter lives below after the parse loop
        // (`setFieldDefinitions(newFieldDefs)`), so the "old" hash is unambiguously the hash
        // of the pre-sync schema. Keep this ordering: moving the hash capture below the setter
        // would make it equal to `newFieldDefsHash` and break `fieldDefsChanged` detection.
        const oldFieldDefsHash = simpleHash(JSON.stringify(fieldDefinitions.map(f => f.name + f.type + (f.multi || ''))));
        // BUG-368: Capture prior previousIndexSnapshot so we can restore per-vault slices for
        // vaults that came from the carry-forward (failure) branch. finalizeIndex below
        // overwrites previousIndexSnapshot wholesale; we patch it back for failed vaults so
        // edits made to those vaults while they were unreachable aren't permanently masked.
        const priorPrevSnapshot = previousIndexSnapshot;
        const failedVaultNames = new Set();
        let newFieldDefs = fieldDefinitions; // default: keep existing (for non-404 fetch errors)
        const primaryVault = enabledVaults[0];
        const fieldDefPath = settings.fieldDefinitionsPath || 'DeepLore/field-definitions.yaml';
        try {
            const fdResult = await fetchFieldDefinitions(primaryVault.host, primaryVault.port, primaryVault.apiKey, fieldDefPath, !!primaryVault.https);
            if (fdResult.ok && fdResult.content) {
                const { definitions } = parseFieldDefinitionYaml(fdResult.content);
                if (definitions.length > 0) {
                    newFieldDefs = definitions;
                } else {
                    newFieldDefs = [...DEFAULT_FIELD_DEFINITIONS];
                }
            } else if (fdResult.error === 'not_found') {
                // 404 — file genuinely missing, fall back to defaults
                newFieldDefs = [...DEFAULT_FIELD_DEFINITIONS];
            }
            // Other errors (5xx, network): keep existing field definitions to avoid clobbering user schema
        } catch (err) {
            // Keep existing field definitions on error
            if (settings.debugMode) console.warn('[DLE] Failed to load field definitions during reuse-sync:', err?.message);
        }

        // Build lookup of existing entries by vault:filename → entry (with content hash)
        const existingMap = new Map();
        for (const entry of indexSnapshot) {
            existingMap.set(`${entry.vaultSource}\0${entry.filename}`, entry);
        }

        // If field definitions changed, force all entries to re-parse so customFields update
        const newFieldDefsHash = simpleHash(JSON.stringify(newFieldDefs.map(f => f.name + f.type + (f.multi || ''))));
        const fieldDefsChanged = oldFieldDefsHash !== newFieldDefsHash;
        let hasChanges = fieldDefsChanged;
        let anyVaultFailed = false;
        let vaultFailCount = 0;
        let newCount = 0, modifiedCount = 0, removedCount = 0;
        let _reuseTokenizerFailCount = 0;
        const allEntries = [];
        // B.1/B.4: parser ledger for the reuse path. Only re-parsed files contribute
        // warnings/skips; unchanged reused entries carry forward their own
        // `_parserWarnings` from the previous build (which are already reflected in
        // the prior indexBuildReport).
        const buildReport = {
            okCount: 0,
            warnCount: 0,
            skipCount: 0,
            skipped: [],
            entriesWithWarnings: [],
        };
        const lenientAuthoring = settings.lenientAuthoring !== false;
        setLastVaultAttemptCount(enabledVaults.length);

        for (const vault of enabledVaults) {
            // BUG-AUDIT-C05: Bail if force-release bumped epoch during vault fetch loop
            if (isZombie()) { _reuseResult = false; return; }
            try {
                // Fetch ALL file contents to detect content changes via hash comparison.
                // Local Obsidian fetch is fast; the savings are from skipping re-parse/tokenize for unchanged files.
                const data = await fetchAllMdFiles(vault.host, vault.port, vault.apiKey, !!vault.https);
                if (isZombie()) { _reuseResult = false; return; }
                if (!data.files || !Array.isArray(data.files)) {
                    console.warn(`[DLE] Reuse sync: vault "${vault.name}" returned invalid data — carrying forward existing entries`);
                    anyVaultFailed = true;
                    vaultFailCount++;
                    failedVaultNames.add(vault.name);
                    // Carry forward existing entries for this vault (same as catch block)
                    for (const entry of indexSnapshot) {
                        if (entry.vaultSource === vault.name) {
                            allEntries.push(entry);
                            if (entry._parserWarnings && entry._parserWarnings.length > 0) {
                                buildReport.warnCount++;
                                buildReport.entriesWithWarnings.push({
                                    filename: entry.filename,
                                    title: entry.title,
                                    warnings: entry._parserWarnings,
                                });
                            } else {
                                buildReport.okCount++;
                            }
                        }
                    }
                    continue;
                }

                const fetchedFilenames = new Set(data.files.map(f => f.filename));

                // Detect removals: entries in index but not in current vault
                for (const entry of indexSnapshot) {
                    if (entry.vaultSource === vault.name && !fetchedFilenames.has(entry.filename)) {
                        hasChanges = true;
                        removedCount++;
                    }
                }

                for (const file of data.files) {
                    const key = `${vault.name}\0${file.filename}`;
                    const existing = existingMap.get(key);
                    const fileHash = simpleHash(file.content);

                    if (existing && existing._contentHash === fileHash && !fieldDefsChanged) {
                        // Unchanged — reuse existing parsed entry.
                        // B.1/B.4: roll forward cached `_parserWarnings` into this
                        // build's ledger so /dle-lint still shows them even on
                        // reuse-sync builds.
                        allEntries.push(existing);
                        if (existing._parserWarnings && existing._parserWarnings.length > 0) {
                            buildReport.warnCount++;
                            buildReport.entriesWithWarnings.push({
                                filename: existing.filename,
                                title: existing.title,
                                warnings: existing._parserWarnings,
                            });
                        } else {
                            buildReport.okCount++;
                        }
                    } else {
                        // New or modified — re-parse
                        hasChanges = true;
                        const entry = parseVaultFile(file, tagConfig, newFieldDefs, {
                            lenientAuthoring,
                            onSkip: (reason) => {
                                buildReport.skipped.push({ filename: file.filename, reason });
                                buildReport.skipCount++;
                            },
                        });
                        if (entry) {
                            entry.vaultSource = vault.name;
                            entry._contentHash = fileHash;
                            try {
                                entry.tokenEstimate = await getTokenCountAsync(entry.content);
                            } catch {
                                entry.tokenEstimate = Math.ceil(entry.content.length / 4.0);
                                _reuseTokenizerFailCount++;
                            }
                            if (entry._parserWarnings && entry._parserWarnings.length > 0) {
                                buildReport.warnCount++;
                                buildReport.entriesWithWarnings.push({
                                    filename: file.filename,
                                    title: entry.title,
                                    warnings: entry._parserWarnings,
                                });
                            } else {
                                buildReport.okCount++;
                            }
                            allEntries.push(entry);
                            if (existing) modifiedCount++;
                            else newCount++;
                        }
                    }
                }
            } catch (vaultErr) {
                console.warn(`[DLE] Reuse sync failed for vault "${vault.name}":`, vaultErr.message);
                anyVaultFailed = true;
                vaultFailCount++;
                failedVaultNames.add(vault.name);
                // Carry forward all existing entries for this vault to avoid silent data loss
                for (const entry of indexSnapshot) {
                    if (entry.vaultSource === vault.name) {
                        allEntries.push(entry);
                        if (entry._parserWarnings && entry._parserWarnings.length > 0) {
                            buildReport.warnCount++;
                            buildReport.entriesWithWarnings.push({
                                filename: entry.filename,
                                title: entry.title,
                                warnings: entry._parserWarnings,
                            });
                        } else {
                            buildReport.okCount++;
                        }
                    }
                }
                continue;
            }
        }

        setLastVaultFailureCount(vaultFailCount);
        if (_reuseTokenizerFailCount > 0) {
            console.warn(`[DLE] Tokenizer failed for ${_reuseTokenizerFailCount} re-parsed entries — using character-based estimates (budget accuracy degraded)`);
        }

        if (!hasChanges) {
            // If a vault failed, use a short-lived timestamp so retries happen sooner
            if (anyVaultFailed) {
                setIndexTimestamp(Date.now() - (settings.cacheTTL * 1000) + 30_000); // retry in ~30s
            } else {
                setIndexTimestamp(Date.now());
                // Only mark as ever-loaded when all vaults confirmed reachable —
                // finalizeIndex() already sets it after a successful full build.
                setIndexEverLoaded(true);
            }
            // B.1/B.4: publish ledger even on no-change early-return so /dle-lint
            // still reflects the live index's warning state after a reuse-sync tick.
            setIndexBuildReport(buildReport);
            if (settings.debugMode) {
                console.debug(`[DLE] Reuse sync: no changes detected${anyVaultFailed ? ' (some vaults failed)' : ''}`);
            }
            _reuseResult = true;
            return;
        }

        if (settings.debugMode) {
            console.log(`[DLE] Reuse sync: +${newCount} new, ~${modifiedCount} modified, -${removedCount} removed`);
        }

        // Warn about cross-vault duplicate titles (forbidden — causes Map key collisions)
        {
            const enabledCount = (getSettings().vaults || []).filter(v => v.enabled).length;
            if (enabledCount > 1) {
                const dupes = detectCrossVaultDuplicates(allEntries);
                if (dupes.length > 0) {
                    const listing = dupes.slice(0, 5).map(d => `"${d.title}" (${d.vaults.join(', ')})`).join('; ');
                    const more = dupes.length > 5 ? ` …and ${dupes.length - 5} more` : '';
                    dedupWarning(
                        `Duplicate entry titles across vaults: ${listing}${more}. Keeping the first vault's copy. Rename one copy to avoid issues.`,
                        'cross_vault_dupes',
                        { timeOut: 15000 },
                    );
                }
            }
        }

        // BUG-007: Apply multi-vault dedup (was missing from reuse path)
        const dedupedEntries = deduplicateMultiVault(allEntries, settings.multiVaultConflictResolution);

        // BUG-008: Commit new field definitions to shared state ONCE, after parsing is complete.
        // This closes the half-stale window that existed when setFieldDefinitions was called
        // before the parse loop.
        if (fieldDefsChanged) {
            setFieldDefinitions(newFieldDefs);
        }

        // BUG-AUDIT-C05: Final zombie check before committing — if force-release fired
        // during the parse/dedup phase, bail to avoid overwriting the new build's results.
        if (isZombie()) { _reuseResult = false; return; }

        // Apply changes
        setVaultIndex(dedupedEntries);
        setIndexTimestamp(Date.now());

        // B.1/B.4: publish parser ledger BEFORE finalizeIndex so observers that
        // fire on finalize can read it consistently with buildIndex semantics.
        setIndexBuildReport(buildReport);
        // Intentional asymmetry with buildIndex: no skipCacheSave here. The reuse
        // path carries forward last-known entries for failed vaults via dedupedEntries,
        // so the cache already represents the best known state and is safe to persist.
        // (buildIndex passes skipCacheSave:vaultFetchFailed because a full rebuild with
        // a failed vault could write an empty or partial cache.)
        await finalizeIndex({ entries: dedupedEntries, settings });

        // B.5: summary toast — mirrors buildIndex. Only fires when we actually
        // re-parsed something (hasChanges === true path) AND there's news to share.
        if (buildReport.warnCount > 0 || buildReport.skipCount > 0) {
            const parts = [`DLE indexed ${dedupedEntries.length} entries.`];
            if (buildReport.warnCount > 0) parts.push(`${buildReport.warnCount} warning${buildReport.warnCount === 1 ? '' : 's'}`);
            if (buildReport.skipCount > 0) parts.push(`${buildReport.skipCount} skipped`);
            dedupWarning(
                `${parts.join(', ').replace(/,([^,]*)$/, ';$1')}. Run /dle-lint for details.`,
                'parser_ledger_summary',
                { timeOut: OBSIDIAN_TOAST_TIMEOUT },
            );
        }

        // BUG-368: finalizeIndex has now replaced previousIndexSnapshot with one built from
        // (fresh entries + carried-forward entries). For vaults that FAILED this cycle, we must
        // NOT update the snapshot — otherwise, when the vault recovers, edits made during the
        // outage are permanently masked because the new comparison baseline already contains
        // the carried-forward (post-edit) state. Restore those vaults' filename-keyed snapshot
        // entries from the prior snapshot so the next successful poll can detect the drift.
        if (failedVaultNames.size > 0 && priorPrevSnapshot) {
            const newSnap = previousIndexSnapshot;
            if (newSnap) {
                const failedFilenames = new Set(
                    dedupedEntries
                        .filter(e => failedVaultNames.has(e.vaultSource))
                        .map(e => e.filename),
                );
                for (const fname of failedFilenames) {
                    if (priorPrevSnapshot.contentHashes.has(fname)) {
                        newSnap.contentHashes.set(fname, priorPrevSnapshot.contentHashes.get(fname));
                    } else {
                        newSnap.contentHashes.delete(fname);
                    }
                    if (priorPrevSnapshot.titleMap.has(fname)) {
                        newSnap.titleMap.set(fname, priorPrevSnapshot.titleMap.get(fname));
                    } else {
                        newSnap.titleMap.delete(fname);
                    }
                    if (priorPrevSnapshot.keyMap.has(fname)) {
                        newSnap.keyMap.set(fname, priorPrevSnapshot.keyMap.get(fname));
                    } else {
                        newSnap.keyMap.delete(fname);
                    }
                }
            }
        }

        if (settings.debugMode) {
            console.log(`[DLE] Reuse sync: ${allEntries.length} entries after reuse rebuild`);
        }
        console.log('[DLE] Index built: %d entries in %dms (mode: reuse)', dedupedEntries.length, Math.round(performance.now() - _buildStart));

        _reuseResult = true;
    } catch (err) {
        console.warn('[DLE] Reuse sync error:', err.message);
        _reuseResult = false;
    } finally {
        setIndexing(false);
        setBuildPromise(null); // BUG-044: Clear stale buildPromise
        _reuseResolve(_reuseResult);
    }
    })().catch(err => { _reuseReject(err); });
    return promise;
}

/**
 * Ensure the vault index is fresh, rebuilding if cache has expired.
 */
export async function ensureIndexFresh() {
    const settings = getSettings();
    const now = Date.now();
    const rebuildTrigger = settings.indexRebuildTrigger || 'ttl';

    // E9: Index rebuild trigger logic
    if (rebuildTrigger === 'manual') {
        // Only rebuild if index is empty — never auto-rebuild
        if (vaultIndex.length === 0) {
            await buildIndex();
            setLastIndexGenerationCount(generationCount);
        }
        return;
    }

    if (rebuildTrigger === 'generation') {
        const interval = settings.indexRebuildGenerationInterval || 10;
        const shouldRebuild = vaultIndex.length === 0 || (generationCount - lastIndexGenerationCount >= interval);
        if (shouldRebuild) {
            if (vaultIndex.length > 0) {
                const usedReuse = await buildIndexWithReuse();
                if (usedReuse) { setLastIndexGenerationCount(generationCount); return; }
            }
            await buildIndex();
            setLastIndexGenerationCount(generationCount);
        }
        return;
    }

    // Default: 'ttl' — current behavior
    const ttlMs = settings.cacheTTL * 1000;

    // TTL=0 means "always fetch fresh" (rebuild every generation)
    if (vaultIndex.length === 0 || ttlMs === 0 || (ttlMs > 0 && now - indexTimestamp > ttlMs)) {
        // Use reuse path when index already exists (faster: skips re-parse/tokenize for unchanged entries)
        if (vaultIndex.length > 0) {
            const usedReuse = await buildIndexWithReuse();
            if (usedReuse) { setLastIndexGenerationCount(generationCount); return; }
            // BUG-003: Re-check TTL after reuse — buildIndexWithReuse may have updated the timestamp
            // (e.g. no-changes path sets indexTimestamp = Date.now()), preventing a redundant full rebuild
            if (ttlMs > 0 && Date.now() - indexTimestamp <= ttlMs) {
                setLastIndexGenerationCount(generationCount);
                return;
            }
        }
        await buildIndex();
        setLastIndexGenerationCount(generationCount);
    }
}
