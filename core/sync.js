/**
 * DeepLore Enhanced Core — Vault Change Detection
 */

import { simpleHash } from './utils.js';

/**
 * Compose the canonical sync-snapshot key for an entry.
 * BUG-AUDIT: keyed by `vaultSource:filename` to avoid multi-vault collisions
 * when two vaults contain the same relative path. Filename-only keys would
 * misclassify edits/removals across vaults. Pure helper — exported so
 * callers (e.g. vault.js's BUG-368 carry-forward loop) can reproduce the
 * exact format.
 * @param {{ vaultSource?: string, filename: string }} entry
 * @returns {string}
 */
export function snapshotKey(entry) {
    return `${entry.vaultSource || ''}:${entry.filename}`;
}

/**
 * Take a snapshot of the current vault index for change detection.
 * Keys are vaultSource:filename — see snapshotKey().
 * @param {import('./pipeline.js').VaultEntry[]} vaultIndex
 * @returns {{ contentHashes: Map<string, string>, titleMap: Map<string, string>, keyMap: Map<string, string>, timestamp: number }}
 */
export function takeIndexSnapshot(vaultIndex) {
    const snapshot = {
        contentHashes: new Map(),
        titleMap: new Map(),
        keyMap: new Map(),
        timestamp: Date.now(),
    };

    for (const entry of vaultIndex) {
        const key = snapshotKey(entry);
        snapshot.contentHashes.set(key, simpleHash(entry.content));
        snapshot.titleMap.set(key, entry.title);
        snapshot.keyMap.set(key, JSON.stringify(entry.keys));
    }

    return snapshot;
}

/**
 * Detect changes between two vault index snapshots.
 * @param {{ contentHashes: Map, titleMap: Map, keyMap: Map }|null} oldSnapshot
 * @param {{ contentHashes: Map, titleMap: Map, keyMap: Map }} newSnapshot
 * @returns {{ added: string[], removed: string[], modified: string[], keysChanged: string[], hasChanges: boolean }}
 */
export function detectChanges(oldSnapshot, newSnapshot) {
    const changes = { added: [], removed: [], modified: [], keysChanged: [], hasChanges: false };

    if (!oldSnapshot) return changes;

    const oldFiles = new Set(oldSnapshot.contentHashes.keys());
    const newFiles = new Set(newSnapshot.contentHashes.keys());

    // New entries
    for (const file of newFiles) {
        if (!oldFiles.has(file)) {
            changes.added.push(newSnapshot.titleMap.get(file) || file);
        }
    }

    // Removed entries
    for (const file of oldFiles) {
        if (!newFiles.has(file)) {
            changes.removed.push(oldSnapshot.titleMap.get(file) || file);
        }
    }

    // Modified entries (exist in both, content hash differs)
    for (const file of newFiles) {
        if (oldFiles.has(file)) {
            if (oldSnapshot.contentHashes.get(file) !== newSnapshot.contentHashes.get(file)) {
                changes.modified.push(newSnapshot.titleMap.get(file) || file);
            }
            // Keyword changes (separate from content)
            if (oldSnapshot.keyMap.get(file) !== newSnapshot.keyMap.get(file)) {
                const title = newSnapshot.titleMap.get(file) || file;
                if (!changes.modified.includes(title)) {
                    changes.keysChanged.push(title);
                }
            }
        }
    }

    changes.hasChanges = changes.added.length > 0 || changes.removed.length > 0
        || changes.modified.length > 0 || changes.keysChanged.length > 0;

    return changes;
}
