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
    setLastHealthResult, setEntityNameSet, setEntityShortNameRegexes, setVaultAvgTokens,
} from './state.js';
import { resolveLinks } from '../core/matching.js';
import { parseVaultFile } from '../core/pipeline.js';
import { takeIndexSnapshot, detectChanges } from '../core/sync.js';
import { showChangesToast } from './sync.js';
import { updateIndexStats } from './settings-ui.js';
import { runHealthCheck } from './diagnostics.js';
import { saveIndexToCache, loadIndexFromCache } from './cache.js';

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

        console.log(`[DLE] Indexed ${entries.length} entries from ${totalFiles} vault files across ${enabledVaults.length} vault(s)`);
        updateIndexStats();

        // Persist to IndexedDB for instant hydration on next page load
        // Skip if any vault failed to avoid caching incomplete data
        if (!vaultFetchFailed) {
            saveIndexToCache(entries).catch(() => {});
        }

        // Auto health check after index build — deferred to avoid blocking the pipeline
        setTimeout(() => {
            try {
                const health = runHealthCheck();
                setLastHealthResult(health);
                if (health.errors > 0 || health.warnings > 0) {
                    console.log(`[DLE] Health: ${health.errors} error(s), ${health.warnings} warning(s). Run /dle-health for details.`);
                }
            } catch (healthErr) {
                console.warn('[DLE] Health check error:', healthErr.message);
            }
        }, 0);
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
        toastr.error(userMsg, 'DeepLore Enhanced', { preventDuplicates: true, timeOut: 10000 });
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
        updateIndexStats();

        console.log(`[DLE] Hydrated ${cached.entries.length} entries from IndexedDB cache`);

        // Background: rebuild from Obsidian to validate cache freshness
        buildIndex().catch(err => {
            console.warn('[DLE] Background rebuild after cache hydration failed:', err.message);
            if (vaultIndex.length > 0) {
                // Cached data exists — set a short-lived timestamp so ensureIndexFresh() retries after a cooldown
                // (not Date.now() which would prevent retries until TTL expires)
                const s = getSettings();
                setIndexTimestamp(Date.now() - (s.cacheTTL * 1000) + 30_000); // retry in ~30s
                toastr.warning('Using cached vault data — Obsidian is unreachable. Reconnect and refresh when ready.', 'DeepLore Enhanced', { timeOut: 10000, preventDuplicates: true });
            }
        });

        return true;
    } catch (err) {
        console.warn('[DLE] Cache hydration failed:', err.message);
        return false;
    }
}

/**
 * Incremental delta sync: fetch file listing, detect added/removed files,
 * only re-fetch content for new files. Existing entries are preserved.
 * Falls back to full buildIndex if delta detection fails.
 * @returns {Promise<boolean>} True if delta sync was sufficient (no full rebuild needed)
 */
export async function buildIndexDelta() {
    if (indexing || vaultIndex.length === 0) {
        // If a build is in progress, await it and report that delta didn't run
        if (buildPromise) await buildPromise;
        return false;
    }

    const settings = getSettings();
    const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
    if (enabledVaults.length === 0) return false;

    // Set indexing flag BEFORE any async work to prevent concurrent delta calls
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
                    console.warn(`[DLE] Delta: vault "${vault.name}" returned invalid data — carrying forward existing entries`);
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
                console.warn(`[DLE] Delta sync failed for vault "${vault.name}":`, vaultErr.message);
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
                console.debug(`[DLE] Delta sync: no changes detected${anyVaultFailed ? ' (some vaults failed)' : ''}`);
            }
            return true;
        }

        if (settings.debugMode) {
            console.log(`[DLE] Delta sync: +${newCount} new, ~${modifiedCount} modified, -${removedCount} removed`);
        }

        // Apply changes
        setVaultIndex(allEntries);
        setIndexTimestamp(Date.now());
        setIndexEverLoaded(true);
        resolveLinks(vaultIndex);

        // Recompute vault average token count
        const deltaTotalTokens = allEntries.reduce((sum, e) => sum + (e.tokenEstimate || 0), 0);
        setVaultAvgTokens(allEntries.length > 0 ? deltaTotalTokens / allEntries.length : 0);

        // Pre-compute entity name Set for AI cache sliding window check
        const deltaNames = new Set();
        for (const entry of allEntries) {
            if (entry.title.length >= 1) deltaNames.add(entry.title.toLowerCase());
            for (const key of entry.keys) {
                if (key.length >= 2) deltaNames.add(key.toLowerCase());
            }
        }
        setEntityNameSet(deltaNames);

        // Pre-compile word-boundary regexes for short entity names (≤3 chars)
        const deltaShortRegexes = new Map();
        for (const name of deltaNames) {
            if (name.length <= 3) {
                const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                deltaShortRegexes.set(name, new RegExp(`\\b${escaped}\\b`, 'i'));
            }
        }
        setEntityShortNameRegexes(deltaShortRegexes);

        setAiSearchCache({ hash: '', manifestHash: '', chatLineCount: 0, results: [] });

        // Prune analytics data for entries no longer in the vault
        const analytics = settings.analyticsData;
        if (analytics) {
            const activeKeys = new Set(vaultIndex.map(e => trackerKey(e)));
            for (const key of Object.keys(analytics)) {
                if (!activeKeys.has(key)) delete analytics[key];
            }
        }

        // Change detection
        const newSnapshot = takeIndexSnapshot(vaultIndex);
        if (previousIndexSnapshot) {
            const changes = detectChanges(previousIndexSnapshot, newSnapshot);
            if (changes.hasChanges && settings.showSyncToasts) {
                showChangesToast(changes);
            }
        }
        setPreviousIndexSnapshot(newSnapshot);

        updateIndexStats();
        saveIndexToCache(allEntries).catch(() => {});

        // Defer health check to avoid blocking the pipeline (matches buildIndex behavior)
        setTimeout(() => {
            try {
                const health = runHealthCheck();
                setLastHealthResult(health);
                if (health.errors > 0 || health.warnings > 0) {
                    console.log(`[DLE] Health: ${health.errors} error(s), ${health.warnings} warning(s). Run /dle-health for details.`);
                }
            } catch (healthErr) {
                console.warn('[DLE] Health check error:', healthErr.message);
            }
        }, 0);

        if (settings.debugMode) {
            console.log(`[DLE] Delta sync: ${allEntries.length} entries after delta`);
        }

        return true;
    } catch (err) {
        console.warn('[DLE] Delta sync error:', err.message);
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
