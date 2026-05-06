/**
 * DeepLore Enhanced — SillyTavern Lorebook Import Bridge (Lite)
 * Converts ST World Info JSON entries into Obsidian vault notes with frontmatter.
 */
import { writeNote, obsidianFetch, encodeVaultPath } from './obsidian-api.js';
import { getSettings, getPrimaryVault } from '../../settings.js';
import { convertWiEntry } from '../helpers.js';

/**
 * Import an array of ST World Info entries into the Obsidian vault.
 * @param {object[]} entries - Array of ST WI entry objects
 * @param {string} folder - Target folder in the vault
 * @param {function} [onProgress] - Optional callback(imported, total) for progress updates
 * @returns {Promise<{ imported: number, failed: number, errors: string[] }>}
 */
export async function importEntries(entries, folder, onProgress) {
    const settings = getSettings();
    const vault = getPrimaryVault(settings);
    const lorebookTag = settings.lorebookTag;

    let imported = 0;
    let failed = 0;
    const errors = [];

    let renamed = 0;
    for (const wiEntry of entries) {
        try {
            const { filename, content } = convertWiEntry(wiEntry, lorebookTag);
            let fullPath = folder ? `${folder}/${filename}` : filename;

            // Check existence to avoid silent overwrites.
            try {
                const checkResult = await obsidianFetch({
                    host: vault.host,
                    port: vault.port,
                    apiKey: vault.apiKey,
                    https: !!vault.https,
                    path: `/vault/${encodeVaultPath(fullPath)}`,
                    accept: 'text/markdown',
                });
                if (checkResult.status === 200) {
                    // Find a unique suffix (_imported, _imported_2, _imported_3, ...).
                    const base = filename.replace(/\.md$/, '');
                    let suffix = '_imported';
                    let attempt = 1;
                    let candidatePath;
                    const MAX_DEDUP_ATTEMPTS = 20;
                    while (attempt <= MAX_DEDUP_ATTEMPTS) {
                        const candidateFilename = `${base}${suffix}.md`;
                        candidatePath = folder ? `${folder}/${candidateFilename}` : candidateFilename;
                        try {
                            const dupCheck = await obsidianFetch({
                                host: vault.host,
                                port: vault.port,
                                apiKey: vault.apiKey,
                                https: !!vault.https,
                                path: `/vault/${encodeVaultPath(candidatePath)}`,
                                accept: 'text/markdown',
                            });
                            if (dupCheck.status === 200) {
                                attempt++;
                                suffix = `_imported_${attempt}`;
                                continue;
                            }
                        } catch (dupErr) {
                            // FIX-M6: skip on timeout, don't fall through with an undefined path.
                            if (dupErr.name === 'AbortError') {
                                candidatePath = undefined;
                            }
                            break;
                        }
                        break;
                    }
                    if (!candidatePath) {
                        errors.push(`${filename}: skipped — dedup check timed out`);
                        failed++;
                        continue;
                    }
                    if (attempt > MAX_DEDUP_ATTEMPTS) {
                        errors.push(`${filename}: exceeded ${MAX_DEDUP_ATTEMPTS} dedup attempts, skipping`);
                        failed++;
                        continue;
                    }
                    fullPath = candidatePath;
                    renamed++;
                }
            } catch (existErr) {
                // obsidianFetch returns {status, data} for all HTTP responses including 404,
                // so a thrown error is always a network/timeout problem.
                console.warn(`[DLE Import] Network error checking existence of "${fullPath}":`, existErr.message);
                errors.push(`${filename}: skipped — could not verify existence (${existErr.message})`);
                failed++;
                continue;
            }

            const result = await writeNote(vault.host, vault.port, vault.apiKey, fullPath, content, !!vault.https);
            if (result.ok) {
                imported++;
            } else {
                failed++;
                errors.push(`${filename}: ${result.error}`);
            }
        } catch (err) {
            failed++;
            errors.push(`Entry: ${err.message}`);
        }
        if (onProgress) onProgress(imported + failed, entries.length);
    }

    return { imported, failed, renamed, errors };
}

/**
 * Convert and upsert a single ST World Info entry into Obsidian.
 * This is intentionally generic so extensions can add custom
 * metadata/content without duplicating DLE connection logic.
 *
 * @param {object} wiEntry
 * @param {{
 *   folder?: string,
 *   filename?: string,
 *   transformContent?: ((markdown: string, entry: object) => string) | null,
 *   lorebookTag?: string,
 * }} [options]
 * @returns {Promise<{ok: boolean, path: string, error?: string}>}
 */
export async function upsertConvertedEntry(wiEntry, options = {}) {
    const settings = getSettings();
    const vault = getPrimaryVault(settings);

    if (!vault?.enabled) {
        return { ok: false, path: '', error: 'No enabled DeepLore vault is configured.' };
    }
    if (!vault.apiKey) {
        return { ok: false, path: '', error: 'DeepLore vault API key is missing.' };
    }

    const lorebookTag = options.lorebookTag || settings.lorebookTag;
    const converted = convertWiEntry(wiEntry, lorebookTag);
    const normalizedFolder = String(options.folder || '').trim().replace(/^\/+/g, '').replace(/\/+$/g, '');
    const filename = String(options.filename || converted.filename || '').trim();

    if (!filename) {
        return { ok: false, path: '', error: 'Missing filename for converted World Info entry.' };
    }

    let markdown = converted.content;
    if (typeof options.transformContent === 'function') {
        markdown = options.transformContent(markdown, wiEntry);
    }

    const fullPath = normalizedFolder ? `${normalizedFolder}/${filename}` : filename;
    const writeResult = await writeNote(
        vault.host,
        vault.port,
        vault.apiKey,
        fullPath,
        markdown,
        !!vault.https,
    );

    if (!writeResult.ok) {
        return { ok: false, path: fullPath, error: writeResult.error || 'Unknown write error' };
    }

    return { ok: true, path: fullPath };
}

/**
 * Parse ST World Info JSON (handles both export format and embedded character card format).
 * @param {string} jsonText - Raw JSON text
 * @returns {{ entries: object[], source: string }}
 */
export function parseWorldInfoJson(jsonText) {
    let data;
    try {
        data = JSON.parse(jsonText);
    } catch (e) {
        throw new Error('Invalid World Info JSON: ' + e.message);
    }

    const filterValid = (arr) => arr.filter(e => e && typeof e === 'object' && !Array.isArray(e));

    // Direct WI export { entries: { 0: {...}, 1: {...} } }
    if (data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)) {
        const entries = filterValid(Object.values(data.entries));
        return { entries, source: data.originalData?.name || 'World Info' };
    }

    if (Array.isArray(data)) {
        return { entries: filterValid(data), source: 'World Info Array' };
    }

    // V2 character card with embedded WI
    if (data.data?.character_book?.entries) {
        const raw = Array.isArray(data.data.character_book.entries)
            ? data.data.character_book.entries
            : Object.values(data.data.character_book.entries);
        const entries = filterValid(raw);
        return { entries, source: data.data?.name || 'Character Card' };
    }

    throw new Error('Unrecognized World Info format. Expected ST WI export JSON or V2 character card.');
}
