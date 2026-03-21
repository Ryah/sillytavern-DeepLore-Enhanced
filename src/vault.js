/**
 * DeepLore Enhanced — Vault index building and cache management
 */
import { getTokenCountAsync } from '../../../../tokenizers.js';
import { oai_settings } from '../../../../openai.js';
import { main_api, amount_gen } from '../../../../../script.js';
import { getSettings } from '../settings.js';
import { simpleHash } from '../core/utils.js';
import { fetchAllMdFiles } from './obsidian-api.js';
import {
    vaultIndex, indexTimestamp, indexing, buildPromise, indexEverLoaded,
    aiSearchCache, previousIndexSnapshot, trackerKey,
    setVaultIndex, setIndexTimestamp, setIndexing, setBuildPromise,
    setIndexEverLoaded, setAiSearchCache, setPreviousIndexSnapshot,
    setEntityNameSet, setEntityShortNameRegexes, setVaultAvgTokens,
    notifyIndexUpdated,
} from './state.js';
import { resolveLinks } from '../core/matching.js';
import { parseVaultFile } from '../core/pipeline.js';
import { takeIndexSnapshot, detectChanges } from '../core/sync.js';
import { showChangesToast } from './sync.js';
import { saveIndexToCache, loadIndexFromCache } from './cache.js';
import { dedupError, dedupWarning } from './toast-dedup.js';

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

    // Pre-compute entity name Set for AI cache sliding window check
    const names = new Set();
    for (const entry of entries) {
        if (entry.title.length >= 1) names.add(entry.title.toLowerCase());
        for (const key of entry.keys) {
            if (key.length >= 2) names.add(key.toLowerCase());
        }
    }
    setEntityNameSet(names);

    // Pre-compile word-boundary regexes for short entity names (≤3 chars)
    // Avoids constructing new RegExp objects per-generation in the AI cache sliding window check
    const shortRegexes = new Map();
    for (const name of names) {
        if (name.length <= 3) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            shortRegexes.set(name, new RegExp(`\\b${escaped}\\b`, 'i'));
        }
    }
    setEntityShortNameRegexes(shortRegexes);

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

    // Prune analytics data for entries no longer in the vault
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
        console.debug('[DLE] Index build already in progress, awaiting existing build');
        return buildPromise;
    }

    setIndexing(true);
    const promise = (async () => {
    try {
        const settings = getSettings();
        const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
        if (enabledVaults.length === 0) {
            throw new Error('No enabled vaults configured');
        }

        const entries = [];
        const tagConfig = {
            lorebookTag: settings.lorebookTag,
            constantTag: settings.constantTag,
            neverInsertTag: settings.neverInsertTag,
            seedTag: settings.seedTag,
            bootstrapTag: settings.bootstrapTag,
        };

        let totalFiles = 0;
        let vaultFetchFailed = false;
        for (const vault of enabledVaults) {
            try {
                const data = await fetchAllMdFiles(vault.port, vault.apiKey);
                if (!data.files || !Array.isArray(data.files)) {
                    console.warn(`[DLE] Vault "${vault.name}" returned invalid data`);
                    continue;
                }

                totalFiles += data.total || data.files.length;

                // Warn if a significant portion of files failed to fetch
                if (data.failed > 0) {
                    const failRate = data.total > 0 ? data.failed / data.total : 0;
                    if (data.failed >= 5 || failRate >= 0.1) {
                        toastr.warning(
                            `Vault "${vault.name}": ${data.failed} of ${data.total} files failed to fetch.`,
                            'DeepLore Enhanced',
                            { timeOut: 8000, preventDuplicates: true },
                        );
                    }
                }

                for (const file of data.files) {
                    const entry = parseVaultFile(file, tagConfig);
                    if (entry) {
                        entry.vaultSource = vault.name;
                        entry._contentHash = simpleHash(file.content);
                        entries.push(entry);
                    }
                }
            } catch (vaultErr) {
                console.warn(`[DLE] Failed to index vault "${vault.name}":`, vaultErr.message);
                vaultFetchFailed = true;
                if (enabledVaults.length === 1) throw vaultErr;
            }
        }

        // Compute accurate token counts using SillyTavern's tokenizer
        await Promise.all(entries.map(async (entry) => {
            try {
                entry.tokenEstimate = await getTokenCountAsync(entry.content);
            } catch {
                // Fallback to rough estimate if tokenizer unavailable
                entry.tokenEstimate = Math.ceil(entry.content.length / 3.5);
            }
        }));

        setVaultIndex(entries);
        setIndexTimestamp(Date.now());

        console.log(`[DLE] Indexed ${entries.length} entries from ${totalFiles} vault files across ${enabledVaults.length} vault(s)`);

        await finalizeIndex({ entries, settings, skipCacheSave: vaultFetchFailed });
    } catch (err) {
        console.error('[DLE] Failed to build index:', err);
        const raw = String(err.message || err);
        let userMsg = raw;
        if (/ECONNREFUSED|Failed to fetch|NetworkError|fetch/i.test(raw)) {
            userMsg = `Connection failed. Check: (1) Obsidian is running, (2) Local REST API plugin enabled, (3) Port is correct.\n(${raw})`;
        } else if (/No enabled vaults/i.test(raw)) {
            userMsg = 'No enabled vaults configured. Go to DeepLore Enhanced settings → Vault Connections and add a vault.';
        } else if (/401|403|auth/i.test(raw)) {
            userMsg = `Authentication failed. Check your vault API key in settings.\n(${raw})`;
        } else if (/timeout|timed out/i.test(raw)) {
            userMsg = `Obsidian connection timed out. Check that the REST API plugin is running.\n(${raw})`;
        }
        dedupError(userMsg, 'obsidian_connect');
    } finally {
        setIndexing(false);
        setBuildPromise(null);
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
        // Note: indexEverLoaded is NOT set here — it's set in buildIndex() after
        // a successful Obsidian fetch confirms the vault is reachable.
        notifyIndexUpdated();

        console.log(`[DLE] Hydrated ${cached.entries.length} entries from IndexedDB cache`);

        // Background: rebuild from Obsidian to validate cache freshness
        buildIndex().catch(err => {
            console.warn('[DLE] Background rebuild after cache hydration failed:', err.message);
            if (vaultIndex.length > 0) {
                // Cached data exists — set a short-lived timestamp so ensureIndexFresh() retries after a cooldown
                // (not Date.now() which would prevent retries until TTL expires)
                const s = getSettings();
                setIndexTimestamp(Date.now() - (s.cacheTTL * 1000) + 30_000); // retry in ~30s
                dedupWarning('Using cached vault data — Obsidian is unreachable. Reconnect and refresh when ready.', 'obsidian_connect', { timeOut: 10000 });
            }
        });

        return true;
    } catch (err) {
        console.warn('[DLE] Cache hydration failed:', err.message);
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
    };

    // Snapshot vaultIndex to avoid races with concurrent builds
    const indexSnapshot = [...vaultIndex];

    const promise = (async () => {
    try {
        // Build lookup of existing entries by vault:filename → entry (with content hash)
        const existingMap = new Map();
        for (const entry of indexSnapshot) {
            existingMap.set(`${entry.vaultSource}\0${entry.filename}`, entry);
        }

        let hasChanges = false;
        let anyVaultFailed = false;
        let newCount = 0, modifiedCount = 0, removedCount = 0;
        const allEntries = [];

        for (const vault of enabledVaults) {
            try {
                // Fetch ALL file contents to detect content changes via hash comparison.
                // Local Obsidian fetch is fast; the savings are from skipping re-parse/tokenize for unchanged files.
                const data = await fetchAllMdFiles(vault.port, vault.apiKey);
                if (!data.files || !Array.isArray(data.files)) {
                    console.warn(`[DLE] Reuse sync: vault "${vault.name}" returned invalid data — carrying forward existing entries`);
                    anyVaultFailed = true;
                    // Carry forward existing entries for this vault (same as catch block)
                    for (const entry of vaultIndex) {
                        if (entry.vaultSource === vault.name) {
                            allEntries.push(entry);
                        }
                    }
                    continue;
                }

                const fetchedFilenames = new Set(data.files.map(f => f.filename));

                // Detect removals: entries in index but not in current vault
                for (const entry of vaultIndex) {
                    if (entry.vaultSource === vault.name && !fetchedFilenames.has(entry.filename)) {
                        hasChanges = true;
                        removedCount++;
                    }
                }

                for (const file of data.files) {
                    const key = `${vault.name}\0${file.filename}`;
                    const existing = existingMap.get(key);
                    const fileHash = simpleHash(file.content);

                    if (existing && existing._contentHash === fileHash) {
                        // Unchanged — reuse existing parsed entry
                        allEntries.push(existing);
                    } else {
                        // New or modified — re-parse
                        hasChanges = true;
                        const entry = parseVaultFile(file, tagConfig);
                        if (entry) {
                            entry.vaultSource = vault.name;
                            entry._contentHash = fileHash;
                            try {
                                entry.tokenEstimate = await getTokenCountAsync(entry.content);
                            } catch {
                                entry.tokenEstimate = Math.ceil(entry.content.length / 3.5);
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
                // Carry forward all existing entries for this vault to avoid silent data loss
                for (const entry of indexSnapshot) {
                    if (entry.vaultSource === vault.name) {
                        allEntries.push(entry);
                    }
                }
                continue;
            }
        }

        if (!hasChanges) {
            // If a vault failed, use a short-lived timestamp so retries happen sooner
            if (anyVaultFailed) {
                setIndexTimestamp(Date.now() - (settings.cacheTTL * 1000) + 30_000); // retry in ~30s
            } else {
                setIndexTimestamp(Date.now());
            }
            setIndexEverLoaded(true);
            if (settings.debugMode) {
                console.debug(`[DLE] Reuse sync: no changes detected${anyVaultFailed ? ' (some vaults failed)' : ''}`);
            }
            return true;
        }

        if (settings.debugMode) {
            console.log(`[DLE] Reuse sync: +${newCount} new, ~${modifiedCount} modified, -${removedCount} removed`);
        }

        // Apply changes
        setVaultIndex(allEntries);
        setIndexTimestamp(Date.now());

        await finalizeIndex({ entries: allEntries, settings });

        if (settings.debugMode) {
            console.log(`[DLE] Reuse sync: ${allEntries.length} entries after reuse rebuild`);
        }

        return true;
    } catch (err) {
        console.warn('[DLE] Reuse sync error:', err.message);
        return false;
    } finally {
        setIndexing(false);
        setBuildPromise(null);
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
    const ttlMs = settings.cacheTTL * 1000;
    const now = Date.now();

    // TTL=0 means "always fetch fresh" (rebuild every generation)
    if (vaultIndex.length === 0 || ttlMs === 0 || (ttlMs > 0 && now - indexTimestamp > ttlMs)) {
        await buildIndex();
    }
}
