/**
 * DeepLore Enhanced — Vault index building and cache management
 */
import { getRequestHeaders } from '../../../../script.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { oai_settings } from '../../../openai.js';
import { main_api, amount_gen } from '../../../../script.js';
import { getSettings, PLUGIN_BASE } from '../settings.js';
import {
    vaultIndex, indexTimestamp, indexing, buildPromise, indexEverLoaded,
    aiSearchCache, previousIndexSnapshot,
    setVaultIndex, setIndexTimestamp, setIndexing, setBuildPromise,
    setIndexEverLoaded, setAiSearchCache, setPreviousIndexSnapshot,
} from './state.js';
import { resolveLinks } from '../core/matching.js';
import { parseVaultFile } from '../core/pipeline.js';
import { takeIndexSnapshot, detectChanges } from '../core/sync.js';
import { showChangesToast } from './sync.js';
import { updateIndexStats } from './settings-ui.js';
import { runHealthCheck } from './diagnostics.js';

/**
 * Build the vault index by fetching all files from the server plugin.
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
                const response = await fetch(`${PLUGIN_BASE}/index`, {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        port: vault.port,
                        apiKey: vault.apiKey,
                    }),
                });

                if (!response.ok) {
                    console.warn(`[DLE] Vault "${vault.name}" returned HTTP ${response.status}`);
                    continue;
                }

                const data = await response.json();
                if (!data.files || !Array.isArray(data.files)) {
                    console.warn(`[DLE] Vault "${vault.name}" returned invalid data`);
                    continue;
                }

                totalFiles += data.total || data.files.length;

                for (const file of data.files) {
                    const entry = parseVaultFile(file, tagConfig);
                    if (entry) {
                        entry.vaultSource = vault.name;
                        entry._rawContent = file.content;
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

        // Invalidate AI search cache on re-index
        setAiSearchCache({ hash: '', results: [] });

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
            const activeTitles = new Set(vaultIndex.map(e => e.title));
            for (const title of Object.keys(analytics)) {
                if (!activeTitles.has(title)) delete analytics[title];
            }
        }

        console.log(`[DLE] Indexed ${entries.length} entries from ${totalFiles} vault files across ${enabledVaults.length} vault(s)`);
        updateIndexStats();

        // Auto health check after index build (silent, toast only if issues)
        const health = runHealthCheck();
        if (health.errors > 0) {
            toastr.error(`${health.errors} errors, ${health.warnings} warnings found. Run /dle-health for details.`, 'DeepLore Enhanced', { timeOut: 8000, preventDuplicates: true });
        } else if (health.warnings > 3) {
            toastr.warning(`${health.warnings} warnings found. Run /dle-health for details.`, 'DeepLore Enhanced', { timeOut: 5000, preventDuplicates: true });
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
 * Ensure the vault index is fresh, rebuilding if cache has expired.
 */
export async function ensureIndexFresh() {
    const settings = getSettings();
    const ttlMs = settings.cacheTTL * 1000;
    const now = Date.now();

    if (vaultIndex.length === 0 || ttlMs === 0 || now - indexTimestamp > ttlMs) {
        await buildIndex();
    }
}
