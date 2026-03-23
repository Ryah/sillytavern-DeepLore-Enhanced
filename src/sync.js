/**
 * DeepLore Enhanced — Vault change detection and sync polling
 */
import { escapeHtml } from '../../../../utils.js';
import { getSettings } from '../settings.js';
import { syncIntervalId, indexing, setSyncIntervalId, setIndexing } from './state.js';

// Track when we first observe indexing=true, to detect stuck builds
let _indexingSeenSince = 0;

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

    toastr.info(parts.join('<br>'), 'DeepLore Enhanced', {
        timeOut: 8000,
        extendedTimeOut: 12000,
        progressBar: true,
        closeButton: true,
        enableHtml: true,
    });
}

/**
 * Set up or tear down periodic vault sync polling.
 * Uses reuse sync when possible (fetch all, skip re-parse of unchanged),
 * falling back to full rebuild if reuse sync fails.
 * @param {Function} [buildIndexFn] - The buildIndex function
 * @param {Function} [buildIndexWithReuseFn] - The buildIndexWithReuse function (optional)
 */
export function setupSyncPolling(buildIndexFn, buildIndexWithReuseFn) {
    const settings = getSettings();

    if (syncIntervalId) {
        clearTimeout(syncIntervalId);
        setSyncIntervalId(null);
    }

    if (settings.syncPollingInterval > 0 && settings.enabled && buildIndexFn) {
        // Use setTimeout chaining instead of setInterval to prevent overlapping callbacks
        const scheduleNext = () => {
            // Re-read interval each tick so changes take effect without restarting polling
            const currentInterval = getSettings().syncPollingInterval;
            if (currentInterval <= 0) return; // Setting was changed to disabled mid-run
            setSyncIntervalId(setTimeout(async () => {
                const current = getSettings();
                if (!current.enabled) {
                    scheduleNext();
                    return;
                }
                // Guard against stuck indexing flag — force-release after 120s
                if (indexing) {
                    if (!_indexingSeenSince) _indexingSeenSince = Date.now();
                    if (Date.now() - _indexingSeenSince > 120_000) {
                        console.warn('[DLE] Sync: indexing flag stuck for >120s, force-releasing');
                        setIndexing(false);
                        _indexingSeenSince = 0;
                    } else {
                        scheduleNext();
                        return;
                    }
                } else {
                    _indexingSeenSince = 0;
                }

                try {
                    // Try reuse sync first (skip re-parse of unchanged), fall back to full rebuild
                    if (buildIndexWithReuseFn) {
                        const deltaOk = await buildIndexWithReuseFn();
                        if (deltaOk) { scheduleNext(); return; }
                    }
                    await buildIndexFn();
                } catch (err) {
                    console.warn('[DLE] Sync polling error:', err.message);
                }
                scheduleNext();
            }, currentInterval * 1000));
        };
        scheduleNext();
    }
}
