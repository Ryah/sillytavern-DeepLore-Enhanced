/**
 * DeepLore Enhanced — Vault change detection and sync polling
 */
import { escapeHtml } from '../../../../utils.js';
import { getSettings } from '../settings.js';
import { syncIntervalId, indexing, setSyncIntervalId } from './state.js';

/**
 * Show a toast notification summarizing vault changes.
 * @param {{ added: string[], removed: string[], modified: string[], keysChanged: string[] }} changes
 */
export function showChangesToast(changes) {
    const truncList = (arr, max = 3) => {
        const shown = arr.slice(0, max).map(s => escapeHtml(s)).join(', ');
        return arr.length > max ? shown + '...' : shown;
    };

    const parts = [];
    if (changes.added.length > 0) {
        parts.push(`+${changes.added.length} new: ${truncList(changes.added)}`);
    }
    if (changes.removed.length > 0) {
        parts.push(`-${changes.removed.length} removed: ${truncList(changes.removed)}`);
    }
    if (changes.modified.length > 0) {
        parts.push(`~${changes.modified.length} modified: ${truncList(changes.modified)}`);
    }
    if (changes.keysChanged.length > 0) {
        parts.push(`Keys changed: ${truncList(changes.keysChanged)}`);
    }

    toastr.info(parts.join('<br>'), 'DeepLore Enhanced - Vault Updated', {
        timeOut: 8000,
        extendedTimeOut: 12000,
        progressBar: true,
        closeButton: true,
        enableHtml: true,
    });
}

/**
 * Set up or tear down periodic vault sync polling.
 * Uses delta sync when possible (lightweight file listing check),
 * falling back to full rebuild if delta sync fails.
 * @param {Function} [buildIndexFn] - The buildIndex function
 * @param {Function} [buildIndexDeltaFn] - The buildIndexDelta function (optional)
 */
export function setupSyncPolling(buildIndexFn, buildIndexDeltaFn) {
    const settings = getSettings();

    if (syncIntervalId) {
        clearTimeout(syncIntervalId);
        setSyncIntervalId(null);
    }

    if (settings.syncPollingInterval > 0 && settings.enabled && buildIndexFn) {
        // Use setTimeout chaining instead of setInterval to prevent overlapping callbacks
        const scheduleNext = () => {
            setSyncIntervalId(setTimeout(async () => {
                const current = getSettings();
                if (!current.enabled || indexing) {
                    scheduleNext();
                    return;
                }

                try {
                    // Try delta sync first (lightweight), fall back to full rebuild
                    if (buildIndexDeltaFn) {
                        const deltaOk = await buildIndexDeltaFn();
                        if (deltaOk) { scheduleNext(); return; }
                    }
                    await buildIndexFn();
                } catch (err) {
                    console.warn('[DLE] Sync polling error:', err.message);
                }
                scheduleNext();
            }, settings.syncPollingInterval * 1000));
        };
        scheduleNext();
    }
}
