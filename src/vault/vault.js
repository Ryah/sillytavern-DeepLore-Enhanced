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
    setIndexEverLoaded, setAiSearchCache, setPreviousIndexSnapshot,
    setEntityNameSet, setEntityShortNameRegexes, setVaultAvgTokens,
    setFuzzySearchIndex, setMentionWeights, setFolderList,
    setLastVaultFailureCount, setLastVaultAttemptCount,
    notifyIndexUpdated,
    generationCount, lastIndexGenerationCount, setLastIndexGenerationCount,
    chatEpoch, buildEpoch,
    fieldDefinitions, setFieldDefinitions,
} from '../state.js';
import { DEFAULT_FIELD_DEFINITIONS, parseFieldDefinitionYaml } from '../fields.js';
import { resolveLinks } from '../../core/matching.js';
import { parseVaultFile } from '../../core/pipeline.js';
import { takeIndexSnapshot, detectChanges } from '../../core/sync.js';
import { showChangesToast } from './sync.js';
import { saveIndexToCache, loadIndexFromCache, pruneOrphanedCacheKeys } from './cache.js';
import { dedupError, dedupWarning } from '../toast-dedup.js';
// BM25 pure functions extracted to bm25.js for testability
import { buildBM25Index } from './bm25.js';
// bm25 functions imported for internal use; consumers should import directly from ./bm25.js

// Pure functions extracted to vault-pure.js for testability
import { computeEntityDerivedState, deduplicateMultiVault } from './vault-pure.js';
export { computeEntityDerivedState, deduplicateMultiVault };

// ─── Constants ───
const OBSIDIAN_FETCH_TIMEOUT = 15000;
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
async function finalizeIndex({ entries, settings, skipCacheSave = false }) {
    // Compute vault average token count for Context Map coloring
    const totalTokens = entries.reduce((sum, e) => sum + (e.tokenEstimate || 0), 0);
    setVaultAvgTokens(entries.length > 0 ? totalTokens / entries.length : 0);

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

    // Build cross-entry mention weight table
    // Counts how many times each entry's content mentions another entry's title/keys.
    // Optimized: group names by target title and build one combined regex per target,
    // so we scan each content string once per target (not once per name).
    {
        const weights = new Map();
        // Group names by target title: targetTitle → [lowercased names]
        const targetNames = new Map(); // targetTitle → string[]
        for (const entry of entries) {
            const names = [entry.title.toLowerCase()];
            for (const key of entry.keys) {
                const keyLc = key.toLowerCase();
                if (keyLc.length >= 2) names.push(keyLc);
            }
            targetNames.set(entry.title, names);
        }

        // Pre-compile one combined regex per target entry: matches any of its names.
        // Short names (≤3 chars) use \b word boundaries; longer names use plain alternation.
        const targetRegexes = new Map();
        for (const [title, names] of targetNames) {
            const parts = names.map(name => {
                const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return name.length <= 3 ? `\\b${escaped}\\b` : escaped;
            });
            // Sort longest first within the alternation so greedy match prefers longer names
            parts.sort((a, b) => b.length - a.length);
            targetRegexes.set(title, new RegExp(parts.join('|'), 'gi'));
        }

        // Pre-lowercase all content once to avoid redundant .toLowerCase() per source×target
        const contentLower = new Map();
        for (const source of entries) {
            contentLower.set(source.title, source.content.toLowerCase());
        }

        for (const source of entries) {
            const content = contentLower.get(source.title);
            const sourceName = source.title;
            for (const [targetTitle, regex] of targetRegexes) {
                if (targetTitle === sourceName) continue; // skip self-mentions
                regex.lastIndex = 0;
                let count = 0;
                while (regex.exec(content) !== null) count++;
                if (count > 0) {
                    weights.set(`${sourceName}\0${targetTitle}`, count);
                }
            }
        }
        setMentionWeights(weights);
        if (settings.debugMode) {
            console.debug(`[DLE] Built mention weights: ${weights.size} pairs`);
        }
    }

    // Pre-compute entity names and short-name regexes for AI cache sliding window
    computeEntityDerivedState(entries);

    // Build BM25 index if fuzzy search or Librarian search is enabled
    if (settings.fuzzySearchEnabled || settings.librarianSearchEnabled) {
        setFuzzySearchIndex(buildBM25Index(entries));
    } else {
        setFuzzySearchIndex(null);
    }

    // Invalidate AI search cache on re-index
    setAiSearchCache({ hash: '', manifestHash: '', chatLineCount: 0, results: [] });

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

    // Compute folder list from vault entries for folder-based filtering UI
    {
        const folderCounts = new Map();
        for (const entry of entries) {
            if (entry.folderPath) {
                // Count both the direct folder and all ancestor folders
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

    // BUG-026: Prune analytics data for entries no longer in the vault.
    // This intentionally mutates the live settings.analyticsData object — the pruned data
    // is persisted by saveSettingsDebounced() later in the pipeline. Removing stale entries
    // here prevents unbounded growth when vault entries are renamed or deleted.
    const analytics = settings.analyticsData;
    if (analytics) {
        const activeKeys = new Set(vaultIndex.map(e => trackerKey(e)));
        for (const key of Object.keys(analytics)) {
            if (!activeKeys.has(key)) delete analytics[key];
        }
    }

    // Persist to IndexedDB for instant hydration on next page load
    if (!skipCacheSave) {
        saveIndexToCache(entries).catch(() => {});
        // H20: Clean up orphaned cache keys from previous vault configurations
        pruneOrphanedCacheKeys().catch(() => {});
    }

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

    setIndexing(true);
    const promise = (async () => {
    const settings = getSettings();
    const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
    try {
        const capturedEpoch = buildEpoch;
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
        // Set state once, before any parsing begins
        if (isZombie()) return;
        setFieldDefinitions(loadedFieldDefs);

        let entries = [];
        const tagConfig = {
            lorebookTag: settings.lorebookTag,
            constantTag: settings.constantTag,
            neverInsertTag: settings.neverInsertTag,
            seedTag: settings.seedTag,
            bootstrapTag: settings.bootstrapTag,
            guideTag: settings.librarianGuideTag,
        };

        let totalFiles = 0;
        let vaultFetchFailed = false;
        let vaultFailCount = 0;
        setLastVaultAttemptCount(enabledVaults.length);
        for (const vault of enabledVaults) {
            try {
                const data = await fetchAllMdFiles(vault.host, vault.port, vault.apiKey, !!vault.https);
                if (!data.files || !Array.isArray(data.files)) {
                    console.warn(`[DLE] Vault "${vault.name}" returned invalid data`);
                    continue;
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
                    const entry = parseVaultFile(file, tagConfig, fieldDefinitions);
                    if (entry) {
                        entry.vaultSource = vault.name;
                        entry._contentHash = simpleHash(file.content);
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
        await Promise.all(entries.map(async (entry) => {
            try {
                entry.tokenEstimate = await getTokenCountAsync(entry.content);
            } catch {
                // Fallback to rough estimate if tokenizer unavailable
                entry.tokenEstimate = Math.ceil(entry.content.length / 4.0);
            }
        }));

        // E6: Multi-vault conflict resolution dedup pass (BUG-007: shared with buildIndexWithReuse)
        entries = deduplicateMultiVault(entries, settings.multiVaultConflictResolution);

        if (isZombie()) return;
        setVaultIndex(entries);
        setIndexTimestamp(Date.now());

        if (settings.debugMode) console.log(`[DLE] Indexed ${entries.length} entries from ${totalFiles} vault files across ${enabledVaults.length} vault(s)`);

        if (isZombie()) return;
        await finalizeIndex({ entries, settings, skipCacheSave: vaultFetchFailed });

        // Zero-entry warning when connection succeeded but no lorebook-tagged entries found
        if (entries.length === 0 && !vaultFetchFailed) {
            const tag = settings.lorebookTag || 'lorebook';
            dedupWarning(
                `Connected to Obsidian but found 0 entries with the '${tag}' tag. Add \`tags: [${tag}]\` to your note frontmatter to make entries visible to DeepLore.`,
                'zero_entries',
                { timeOut: OBSIDIAN_FETCH_TIMEOUT },
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
        dedupError(userMsg, 'obsidian_connect');
    } finally {
        if (buildEpoch === capturedEpoch) {
            setIndexing(false);
            setBuildPromise(null); // BUG-044: Clear stale buildPromise
        }
    }
    })();
    setBuildPromise(promise);
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
        // Build BM25 index during hydration so fuzzy search and Librarian tools
        // are available immediately, before the background rebuild completes
        const hydrateSettings = getSettings();
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
        buildIndex().catch(err => {
            console.warn('[DLE] Background rebuild after cache hydration failed:', err.message);
            if (chatEpoch !== hydrateEpoch) return; // Chat changed — skip stale retry logic
            if (vaultIndex.length > 0) {
                // Cached data exists — set a short-lived timestamp so ensureIndexFresh() retries after a cooldown
                // (not Date.now() which would prevent retries until TTL expires)
                const s = getSettings();
                setIndexTimestamp(Date.now() - (s.cacheTTL * 1000) + 30_000); // retry in ~30s
                dedupWarning('Couldn\'t reach your vault — using your saved cache for now.', 'obsidian_connect', { timeOut: CACHE_FALLBACK_TOAST_TIMEOUT, hint: 'Check that Obsidian is running, then /dle-refresh.' });
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
        // If a build is in progress, await it and report that delta didn't run
        if (buildPromise) await buildPromise;
        return false;
    }

    const settings = getSettings();
    const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
    if (enabledVaults.length === 0) return false;

    // Set indexing flag BEFORE any async work to prevent concurrent reuse sync calls
    setIndexing(true);

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

    const promise = (async () => {
    try {
        // BUG-F3: Reload field definitions during incremental sync (was only loaded in full buildIndex)
        const oldFieldDefsHash = simpleHash(JSON.stringify(fieldDefinitions.map(f => f.name + f.type + (f.multi || ''))));
        const primaryVault = enabledVaults[0];
        const fieldDefPath = settings.fieldDefinitionsPath || 'DeepLore/field-definitions.yaml';
        try {
            const fdResult = await fetchFieldDefinitions(primaryVault.host, primaryVault.port, primaryVault.apiKey, fieldDefPath, !!primaryVault.https);
            if (fdResult.ok && fdResult.content) {
                const { definitions } = parseFieldDefinitionYaml(fdResult.content);
                if (definitions.length > 0) {
                    setFieldDefinitions(definitions);
                } else {
                    setFieldDefinitions([...DEFAULT_FIELD_DEFINITIONS]);
                }
            } else if (fdResult.error === 'not_found') {
                // 404 — file genuinely missing, fall back to defaults
                setFieldDefinitions([...DEFAULT_FIELD_DEFINITIONS]);
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
        const newFieldDefsHash = simpleHash(JSON.stringify(fieldDefinitions.map(f => f.name + f.type + (f.multi || ''))));
        const fieldDefsChanged = oldFieldDefsHash !== newFieldDefsHash;
        let hasChanges = fieldDefsChanged;
        let anyVaultFailed = false;
        let vaultFailCount = 0;
        let newCount = 0, modifiedCount = 0, removedCount = 0;
        const allEntries = [];
        setLastVaultAttemptCount(enabledVaults.length);

        for (const vault of enabledVaults) {
            try {
                // Fetch ALL file contents to detect content changes via hash comparison.
                // Local Obsidian fetch is fast; the savings are from skipping re-parse/tokenize for unchanged files.
                const data = await fetchAllMdFiles(vault.host, vault.port, vault.apiKey, !!vault.https);
                if (!data.files || !Array.isArray(data.files)) {
                    console.warn(`[DLE] Reuse sync: vault "${vault.name}" returned invalid data — carrying forward existing entries`);
                    anyVaultFailed = true;
                    vaultFailCount++;
                    // Carry forward existing entries for this vault (same as catch block)
                    for (const entry of indexSnapshot) {
                        if (entry.vaultSource === vault.name) {
                            allEntries.push(entry);
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
                        // Unchanged — reuse existing parsed entry
                        allEntries.push(existing);
                    } else {
                        // New or modified — re-parse
                        hasChanges = true;
                        const entry = parseVaultFile(file, tagConfig, fieldDefinitions);
                        if (entry) {
                            entry.vaultSource = vault.name;
                            entry._contentHash = fileHash;
                            try {
                                entry.tokenEstimate = await getTokenCountAsync(entry.content);
                            } catch {
                                entry.tokenEstimate = Math.ceil(entry.content.length / 4.0);
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
                // Carry forward all existing entries for this vault to avoid silent data loss
                for (const entry of indexSnapshot) {
                    if (entry.vaultSource === vault.name) {
                        allEntries.push(entry);
                    }
                }
                continue;
            }
        }

        setLastVaultFailureCount(vaultFailCount);

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
            if (settings.debugMode) {
                console.debug(`[DLE] Reuse sync: no changes detected${anyVaultFailed ? ' (some vaults failed)' : ''}`);
            }
            return true;
        }

        if (settings.debugMode) {
            console.log(`[DLE] Reuse sync: +${newCount} new, ~${modifiedCount} modified, -${removedCount} removed`);
        }

        // BUG-007: Apply multi-vault dedup (was missing from reuse path)
        const dedupedEntries = deduplicateMultiVault(allEntries, settings.multiVaultConflictResolution);

        // Apply changes
        setVaultIndex(dedupedEntries);
        setIndexTimestamp(Date.now());

        await finalizeIndex({ entries: dedupedEntries, settings });

        if (settings.debugMode) {
            console.log(`[DLE] Reuse sync: ${allEntries.length} entries after reuse rebuild`);
        }

        return true;
    } catch (err) {
        console.warn('[DLE] Reuse sync error:', err.message);
        return false;
    } finally {
        setIndexing(false);
        setBuildPromise(null); // BUG-044: Clear stale buildPromise
    }
    })();
    setBuildPromise(promise);
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
