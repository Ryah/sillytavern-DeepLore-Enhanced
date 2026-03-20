/**
 * DeepLore Enhanced — IndexedDB Persistent Vault Cache
 * Stores parsed vault index with content hashes for instant hydration on page load.
 * Validates against Obsidian in background after hydration.
 */

const DB_NAME = 'DeepLoreEnhanced';
const DB_VERSION = 1;
const STORE_NAME = 'vaultCache';
const CACHE_KEY = 'primaryIndex';

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

        // Store serializable entry data with content hashes for later validation
        const cacheData = {
            timestamp: Date.now(),
            entries: entries.map(e => ({
                filename: e.filename,
                title: e.title,
                keys: e.keys,
                content: e.content,
                summary: e.summary,
                priority: e.priority,
                constant: e.constant,
                seed: e.seed,
                bootstrap: e.bootstrap,
                tokenEstimate: e.tokenEstimate,
                scanDepth: e.scanDepth,
                excludeRecursion: e.excludeRecursion,
                links: e.links,
                resolvedLinks: e.resolvedLinks,
                tags: e.tags,
                requires: e.requires,
                excludes: e.excludes,
                refineKeys: e.refineKeys,
                cascadeLinks: e.cascadeLinks,
                injectionPosition: e.injectionPosition,
                injectionDepth: e.injectionDepth,
                injectionRole: e.injectionRole,
                cooldown: e.cooldown,
                warmup: e.warmup,
                probability: e.probability,
                vaultSource: e.vaultSource,
                era: e.era,
                location: e.location,
                sceneType: e.sceneType,
                characterPresent: e.characterPresent,
                _contentHash: e._contentHash || '',
            })),
        };

        store.put(cacheData, CACHE_KEY);

        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.warn('[DLE] Failed to save index to IndexedDB:', err.message);
    } finally {
        if (db) db.close();
    }
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
            const request = store.get(CACHE_KEY);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        if (!result || !Array.isArray(result.entries) || result.entries.length === 0) {
            return null;
        }

        return {
            entries: result.entries,
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
        tx.objectStore(STORE_NAME).delete(CACHE_KEY);
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
