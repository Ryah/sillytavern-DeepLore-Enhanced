/**
 * DeepLore Enhanced — IndexedDB Persistent Vault Cache
 * Stores parsed vault index with content hashes for instant hydration on page load.
 * Validates against Obsidian in background after hydration.
 */

import { getSettings } from '../settings.js';

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
            .map(v => `${v.name}:${v.port}`)
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
            entries: entries.map(e => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_') || k === '_contentHash'))),
        };

        store.put(cacheData, getCacheKey());

        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        if (err.name === 'QuotaExceededError' || (err.message && err.message.includes('quota'))) {
            console.warn('[DLE] IndexedDB storage quota exceeded — vault cache could not be saved. Consider clearing browser data.');
            try {
                toastr.warning(
                    'Browser storage quota exceeded. Vault cache could not be saved. Try clearing browser site data.',
                    'DeepLore Enhanced',
                    { timeOut: 10000 },
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

/**
 * Validate a cached entry has the structural invariants needed by the pipeline.
 * Discards corrupt entries (from browser crashes, quota pressure, etc.) rather than
 * letting them propagate through the system.
 * @param {object} entry
 * @returns {boolean}
 */
function validateCachedEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.title !== 'string' || !entry.title) return false;
    if (!Array.isArray(entry.keys)) return false;
    if (typeof entry.content !== 'string') return false;
    if (typeof entry.tokenEstimate !== 'number' || entry.tokenEstimate < 0) return false;
    if (entry.links !== undefined && !Array.isArray(entry.links)) return false;
    if (entry.tags !== undefined && !Array.isArray(entry.tags)) return false;
    // Default critical fields that may be missing from partial writes
    if (typeof entry.priority !== 'number') entry.priority = 50;
    if (typeof entry.constant !== 'boolean') entry.constant = false;
    if (entry.requires !== undefined && !Array.isArray(entry.requires)) entry.requires = [];
    if (entry.excludes !== undefined && !Array.isArray(entry.excludes)) entry.excludes = [];
    if (entry.probability !== undefined && entry.probability !== null && typeof entry.probability !== 'number') entry.probability = null;
    // Default array fields if missing or corrupt (defend against partial IndexedDB writes)
    for (const field of ['era', 'location', 'sceneType', 'characterPresent', 'links', 'resolvedLinks', 'tags']) {
        if (!Array.isArray(entry[field])) entry[field] = [];
    }
    return true;
}

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
            console.log(`[DLE] Cache schema version mismatch (have ${result.schemaVersion}, want ${CACHE_SCHEMA_VERSION}) — rebuilding`);
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
