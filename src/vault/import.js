/**
 * DeepLore Enhanced — SillyTavern Lorebook Import Bridge (Lite)
 * Converts ST World Info JSON entries into Obsidian vault notes with frontmatter.
 */
import { writeNote, obsidianFetch, encodeVaultPath } from './obsidian-api.js';
import { getSettings, getPrimaryVault } from '../../settings.js';
// Re-export from helpers.js (moved there for testability in Node.js)
export { convertWiEntry } from '../helpers.js';
import { convertWiEntry } from '../helpers.js';

/**
 * Map a SillyTavern World Info entry to Obsidian frontmatter + content.
 * @param {object} wiEntry - ST World Info entry object
 * @param {string} lorebookTag - The lorebook tag to add
 * @returns {{ filename: string, content: string }}
 */
// convertWiEntry — re-exported from ./helpers.js above

/**
 * Import an array of ST World Info entries into the Obsidian vault.
 * @param {object[]} entries - Array of ST WI entry objects
 * @param {string} folder - Target folder in the vault
 * @returns {Promise<{ imported: number, failed: number, errors: string[] }>}
 */
export async function importEntries(entries, folder) {
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

            // Check if file already exists to avoid silent overwrites
            try {
                const checkResult = await obsidianFetch({
                    host: vault.host,
                    port: vault.port,
                    apiKey: vault.apiKey,
                    path: `/vault/${encodeVaultPath(fullPath)}`,
                    accept: 'text/markdown',
                });
                if (checkResult.status === 200) {
                    // File exists — find a unique suffix (_imported, _imported_2, _imported_3, ...)
                    const base = filename.replace(/\.md$/, '');
                    let suffix = '_imported';
                    let attempt = 1;
                    let candidatePath;
                    const MAX_DEDUP_ATTEMPTS = 20;
                    // eslint-disable-next-line no-constant-condition
                    while (attempt <= MAX_DEDUP_ATTEMPTS) {
                        const candidateFilename = `${base}${suffix}.md`;
                        candidatePath = folder ? `${folder}/${candidateFilename}` : candidateFilename;
                        try {
                            const dupCheck = await obsidianFetch({
                                host: vault.host,
                                port: vault.port,
                                apiKey: vault.apiKey,
                                path: `/vault/${encodeVaultPath(candidatePath)}`,
                                accept: 'text/markdown',
                            });
                            if (dupCheck.status === 200) {
                                // This suffix is also taken — try next
                                attempt++;
                                suffix = `_imported_${attempt}`;
                                continue;
                            }
                        } catch (dupErr) {
                            // BUG-M6: Timeout (AbortError) should break immediately, not continue.
                            // Non-timeout errors (e.g. 404 response) mean file doesn't exist — safe to use this name.
                            break;
                        }
                        break;
                    }
                    if (attempt > MAX_DEDUP_ATTEMPTS) {
                        errors.push(`${filename}: exceeded ${MAX_DEDUP_ATTEMPTS} dedup attempts, skipping`);
                        failed++;
                        continue; // continues the outer for-of loop
                    }
                    fullPath = candidatePath;
                    renamed++;
                }
            } catch (existErr) {
                // obsidianFetch returns {status, data} for all HTTP responses including 404,
                // so a thrown error is always a network/timeout problem
                console.warn(`[DLE Import] Network error checking existence of "${fullPath}":`, existErr.message);
                errors.push(`${filename}: skipped — could not verify existence (${existErr.message})`);
                failed++;
                continue;
            }

            const result = await writeNote(vault.host, vault.port, vault.apiKey, fullPath, content);
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
    }

    return { imported, failed, renamed, errors };
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

    // Validate that entries are non-null objects
    const filterValid = (arr) => arr.filter(e => e && typeof e === 'object' && !Array.isArray(e));

    // Format 1: Direct WI export { entries: { 0: {...}, 1: {...} } }
    if (data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries)) {
        const entries = filterValid(Object.values(data.entries));
        return { entries, source: data.originalData?.name || 'World Info' };
    }

    // Format 2: Array of entries
    if (Array.isArray(data)) {
        return { entries: filterValid(data), source: 'World Info Array' };
    }

    // Format 3: V2 character card with embedded WI
    if (data.data?.character_book?.entries) {
        const raw = Array.isArray(data.data.character_book.entries)
            ? data.data.character_book.entries
            : Object.values(data.data.character_book.entries);
        const entries = filterValid(raw);
        return { entries, source: data.data?.name || 'Character Card' };
    }

    throw new Error('Unrecognized World Info format. Expected ST WI export JSON or V2 character card.');
}
