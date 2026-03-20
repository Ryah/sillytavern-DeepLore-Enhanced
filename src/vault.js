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
    setLastHealthResult, setEntityNameSet,
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
    const settings = getSettings();
    try {
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
                        entry._rawContent = file.content;
                        entry._contentHash = simpleHash(file.content);
                        entries.push(entry);
                    }
                }
            } catch (vaultErr) {
                console.warn(`[DLE] Failed to index vault "${vault.name}":`, vaultErr.message);
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

        // Resolve wiki-links to confirmed entry titles
        resolveLinks(vaultIndex);

        // Pre-compute entity name Set for AI cache sliding window check
        const names = new Set();
        for (const entry of entries) {
            if (entry.title.length >= 1) names.add(entry.title.toLowerCase());
            for (const key of entry.keys) {
                if (key.length >= 3) names.add(key.toLowerCase());
            }
        }
        setEntityNameSet(names);

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
        saveIndexToCache(entries).catch(() => {});

        // Auto health check after index build — store for settings badge
        const health = runHealthCheck();
        setLastHealthResult(health);
        if (health.errors > 0 || health.warnings > 0) {
            console.log(`[DLE] Health: ${health.errors} errors, ${health.warnings} warnings. Run /dle-health for details.`);
        }
    } catch (err) {
        console.error('[DLE] Failed to build index:', err);
        toastr.error(String(err), 'DeepLore Enhanced', { preventDuplicates: true });
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
        buildIndex().catch(err => console.warn('[DLE] Background rebuild after cache hydration failed:', err.message));

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

    const tagConfig = {
        lorebookTag: settings.lorebookTag,
        constantTag: settings.constantTag,
        neverInsertTag: settings.neverInsertTag,
        seedTag: settings.seedTag,
        bootstrapTag: settings.bootstrapTag,
    };

    setIndexing(true);
    const promise = (async () => {
    try {
        // Build lookup of existing entries by vault:filename → entry (with content hash)
        const existingMap = new Map();
        for (const entry of vaultIndex) {
            existingMap.set(`${entry.vaultSource}\0${entry.filename}`, entry);
        }

        let hasChanges = false;
        let newCount = 0, modifiedCount = 0, removedCount = 0;
        const allEntries = [];

        for (const vault of enabledVaults) {
            try {
                // Fetch ALL file contents to detect content changes via hash comparison.
                // Local Obsidian fetch is fast; the savings are from skipping re-parse/tokenize for unchanged files.
                const data = await fetchAllMdFiles(vault.port, vault.apiKey);
                if (!data.files || !Array.isArray(data.files)) {
                    console.warn(`[DLE] Delta: vault "${vault.name}" returned invalid data`);
                    return false;
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
                            entry._rawContent = file.content;
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
                return false; // Fall back to full rebuild
            }
        }

        if (!hasChanges) {
            setIndexTimestamp(Date.now());
            if (settings.debugMode) {
                console.debug('[DLE] Delta sync: no changes detected');
            }
            return true;
        }

        if (settings.debugMode) {
            console.log(`[DLE] Delta sync: +${newCount} new, ~${modifiedCount} modified, -${removedCount} removed`);
        }

        // Apply changes
        setVaultIndex(allEntries);
        setIndexTimestamp(Date.now());
        resolveLinks(vaultIndex);

        // Pre-compute entity name Set for AI cache sliding window check
        const deltaNames = new Set();
        for (const entry of allEntries) {
            if (entry.title.length >= 1) deltaNames.add(entry.title.toLowerCase());
            for (const key of entry.keys) {
                if (key.length >= 3) deltaNames.add(key.toLowerCase());
            }
        }
        setEntityNameSet(deltaNames);

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

        const health = runHealthCheck();
        setLastHealthResult(health);

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
