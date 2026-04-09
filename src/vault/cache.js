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
 * BUG-371: Tracks whether the most recent saveIndexToCache call actually persisted.
 * pruneOrphanedCacheKeys reads this to avoid wiping every cache key when the new
 * index failed to land (quota/blocked). null = no save attempted yet this session
 * (prune is safe — it can only remove keys for vaults the user no longer has).
 */
let _lastSaveSucceeded = null;

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
function openDBOnce() {
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
            reject(Object.assign(new Error('IndexedDB open blocked by another connection'), { code: 'BLOCKED' }));
        };
    });
}

/**
 * Open IndexedDB with one-shot backoff retry on blocked. BUG-379.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    return openDBOnce().catch(async (err) => {
        if (err && err.code === 'BLOCKED') {
            console.warn('[DLE] IndexedDB blocked — retrying in 250ms');
            try {
                dedupWarning(
                    'Vault cache database is blocked by another tab. Close other SillyTavern tabs if lore fails to load.',
                    'cache_blocked',
                );
            } catch { /* toastr may not be ready */ }
            await new Promise(r => setTimeout(r, 250));
            return openDBOnce();
        }
        throw err;
    });
}

/**
 * Save the parsed vault index to IndexedDB.
 * Stores entry data + content hashes for validation on next load.
 * @param {import('../core/pipeline.js').VaultEntry[]} entries - Parsed vault entries
 * @returns {Promise<boolean>} true if the cache was successfully persisted; false on quota/other failure
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
        _lastSaveSucceeded = true;
        return true;
    } catch (err) {
        _lastSaveSucceeded = false;
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
        return false;
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
 *
 * BUG-371: Must be guarded against the case where the new index failed to persist
 * (quota, blocked, etc.). Defaults to reading the module-level `_lastSaveSucceeded`
 * flag set by saveIndexToCache. If that flag is explicitly false, pruning is a no-op —
 * otherwise we'd wipe every cache key and leave the user with no valid cache at all.
 * Callers may pass an explicit boolean to override (tests, manual invocation).
 *
 * @param {boolean} [saveSucceeded] - Override the module-level save-success flag.
 * @returns {Promise<number>} Number of orphaned keys removed
 */
export async function pruneOrphanedCacheKeys(saveSucceeded) {
    const effective = (saveSucceeded === undefined) ? _lastSaveSucceeded : saveSucceeded;
    if (effective === false) {
        console.warn('[DLE] Skipping orphan prune — prior saveIndexToCache did not succeed (would have wiped valid cache)');
        return 0;
    }
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

        // BUG-380: always await the transaction before db.close(), regardless of whether
        // any deletes were actually issued — closing a db with an in-flight transaction
        // can cause the transaction to abort.
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
        if (pruned > 0 && getSettings().debugMode) console.log(`[DLE] Pruned ${pruned} orphaned cache key(s)`);
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
    // BUG-123: Clear ALL cache keys, not just the current fingerprint.
    // Old fingerprints from previous vault configs would otherwise linger
    // until pruning runs after a successful build.
    let db;
    try {
        db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
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
