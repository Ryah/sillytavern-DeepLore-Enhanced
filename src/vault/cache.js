/**
 * DeepLore Enhanced — IndexedDB Persistent Vault Cache
 * Stores parsed vault index with content hashes for instant hydration on page load.
 * Validates against Obsidian in background after hydration.
 */

import { getSettings } from '../../settings.js';
import { dedupWarning } from '../toast-dedup.js';
import { simpleHash } from '../../core/utils.js';
// Re-export from extracted pure module for backward compatibility
import { validateCachedEntry } from './cache-validate.js';
export { validateCachedEntry };

const DB_NAME = 'DeepLoreEnhanced';
const DB_VERSION = 1;
const STORE_NAME = 'vaultCache';
const CACHE_SCHEMA_VERSION = 3; // Bumped: per-vault cache keys

/**
 * Build a cache key incorporating enabled vault configuration.
 * Prevents multi-vault setups from serving vault A's cache as vault B's data.
 */
function getCacheKey() {
    try {
        const settings = getSettings();
        const fp = (settings.vaults || [])
            .filter(v => v.enabled)
            .map(v => `${v.name}:${v.host || '127.0.0.1'}:${v.port}:${v.https ? 'https' : 'http'}:${simpleHash(v.apiKey || '')}`)
            .sort()
            .join('|');
        return fp ? `index_${fp}` : 'primaryIndex';
    } catch {
        return 'primaryIndex';
    }
}

/**
 * Open (or create) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            console.warn('[DLE] IndexedDB open blocked — another tab may have an older version open');
            reject(new Error('IndexedDB open blocked by another connection'));
        };
    });
}

/**
 * Save the parsed vault index to IndexedDB.
 * Stores entry data + content hashes for validation on next load.
 * @param {import('../core/pipeline.js').VaultEntry[]} entries - Parsed vault entries
 * @returns {Promise<void>}
 */
export async function saveIndexToCache(entries) {
    let db;
    try {
        db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        const cacheData = {
            schemaVersion: CACHE_SCHEMA_VERSION,
            timestamp: Date.now(),
            entries: entries.map(e => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_') || k === '_contentHash' || k === '_originalRequires' || k === '_originalExcludes' || k === '_originalCascadeLinks'))),
        };

        store.put(cacheData, getCacheKey());

        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
    } catch (err) {
        if (err.name === 'QuotaExceededError' || (err.message && err.message.includes('quota'))) {
            console.warn('[DLE] IndexedDB storage quota exceeded — vault cache could not be saved. Consider clearing browser data.');
            try {
                dedupWarning(
                    'Browser storage full — vault cache could not be saved. Free space by clearing this site\'s data in your browser settings (Settings > Privacy > Site Data).',
                    'cache_quota',
                );
            } catch {
                // toastr may not be available in all contexts
            }
        } else {
            console.warn('[DLE] Failed to save index to IndexedDB:', err.message);
        }
    } finally {
        if (db) db.close();
    }
}

// validateCachedEntry — extracted to cache-validate.js, re-exported above

/**
 * Load the vault index from IndexedDB cache.
 * @returns {Promise<{ entries: import('../core/pipeline.js').VaultEntry[], timestamp: number } | null>}
 */
export async function loadIndexFromCache() {
    let db;
    try {
        db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);

        const result = await new Promise((resolve, reject) => {
            const request = store.get(getCacheKey());
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        if (!result || !Array.isArray(result.entries) || result.entries.length === 0) {
            return null;
        }

        // Schema version mismatch — cache is stale, force full rebuild
        if (result.schemaVersion !== CACHE_SCHEMA_VERSION) {
            if (getSettings().debugMode) console.log(`[DLE] Cache schema version mismatch (have ${result.schemaVersion}, want ${CACHE_SCHEMA_VERSION}) — rebuilding`);
            try { dedupWarning('Refreshing your lore cache after an update — back in a moment.', 'cache_schema'); } catch { /* toastr may not be ready */ }
            return null;
        }

        // Validate structural invariants — discard corrupt entries from browser crashes/quota pressure
        const validEntries = result.entries.filter(e => {
            const ok = validateCachedEntry(e);
            if (!ok) console.warn(`[DLE] Discarding corrupt cached entry: ${e?.title || '(no title)'}`);
            return ok;
        });
        if (validEntries.length === 0) return null;

        return {
            entries: validEntries,
            timestamp: result.timestamp || 0,
        };
    } catch (err) {
        console.warn('[DLE] Failed to load index from IndexedDB:', err.message);
        return null;
    } finally {
        if (db) db.close();
    }
}

/**
 * H20: Remove orphaned IndexedDB cache keys that don't match the current vault configuration.
 * Called after successful index builds to prevent stale cache entries from accumulating.
 * @returns {Promise<number>} Number of orphaned keys removed
 */
export async function pruneOrphanedCacheKeys() {
    let db;
    try {
        db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const currentKey = getCacheKey();

        const allKeys = await new Promise((resolve, reject) => {
            const request = store.getAllKeys();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        let pruned = 0;
        for (const key of allKeys) {
            if (key !== currentKey) {
                store.delete(key);
                pruned++;
            }
        }

        if (pruned > 0) {
            await new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            if (getSettings().debugMode) console.log(`[DLE] Pruned ${pruned} orphaned cache key(s)`);
        }
        return pruned;
    } catch (err) {
        console.warn('[DLE] Failed to prune orphaned cache keys:', err.message);
        return 0;
    } finally {
        if (db) db.close();
    }
}

/**
 * Clear the IndexedDB vault cache.
 * @returns {Promise<void>}
 */
export async function clearIndexCache() {
    let db;
    try {
        db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(getCacheKey());
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.warn('[DLE] Failed to clear IndexedDB cache:', err.message);
    } finally {
        if (db) db.close();
    }
}
