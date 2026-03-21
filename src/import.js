/**
 * DeepLore Enhanced — SillyTavern Lorebook Import Bridge (Lite)
 * Converts ST World Info JSON entries into Obsidian vault notes with frontmatter.
 */
import { writeNote, obsidianFetch, encodeVaultPath } from './obsidian-api.js';
import { getSettings, getPrimaryVault } from '../settings.js';

/**
 * Escape a string for safe use as a YAML value.
 * Wraps in double quotes if the string contains special YAML characters.
 */
function yamlEscape(str) {
    if (/[:#\[\]{}&*!|>'"%@`\n\r\t]/.test(str) || str.trim() !== str) {
        return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return str;
}

/**
 * Map a SillyTavern World Info entry to Obsidian frontmatter + content.
 * @param {object} wiEntry - ST World Info entry object
 * @param {string} lorebookTag - The lorebook tag to add
 * @returns {{ filename: string, content: string }}
 */
export function convertWiEntry(wiEntry, lorebookTag) {
    // Extract title from comment field (ST convention) or first key
    const title = (wiEntry.comment || '').trim()
        || (wiEntry.key || []).join(', ').substring(0, 50)
        || `Entry_${wiEntry.uid || Date.now()}`;

    // Clean title for filename
    let safeTitle = title.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
    if (!safeTitle) safeTitle = 'Untitled';

    // Build keys from ST's key and keysecondary
    const keys = [];
    if (Array.isArray(wiEntry.key)) {
        keys.push(...wiEntry.key.filter(k => k && k.trim()));
    } else if (typeof wiEntry.key === 'string' && wiEntry.key.trim()) {
        keys.push(...wiEntry.key.split(',').map(k => k.trim()).filter(Boolean));
    }

    // Map ST position to DLE position (lossy: ST has 5 values, DLE has 3)
    // ST: 0=after_char, 1=before_char, 2=before_AN, 3=after_AN, 4=in_chat
    const positionMap = { 0: 'after', 1: 'before', 2: 'before', 3: 'after', 4: 'in_chat' };
    const position = positionMap[wiEntry.position] || null;

    // Build frontmatter
    const fm = [];
    fm.push('---');
    fm.push(`type: lore`);
    fm.push(`status: active`);
    if (wiEntry.position !== undefined) fm.push(`# original_st_position: ${wiEntry.position}`);
    fm.push(`priority: ${wiEntry.order ?? 50}`);
    fm.push(`tags:`);
    fm.push(`  - ${lorebookTag}`);
    if (wiEntry.constant) fm.push(`  - lorebook-always`);
    if (keys.length > 0) {
        fm.push(`keys:`);
        for (const k of keys) {
            fm.push(`  - ${yamlEscape(k)}`);
        }
    }
    if (wiEntry.keysecondary && wiEntry.keysecondary.length > 0) {
        const secondary = Array.isArray(wiEntry.keysecondary)
            ? wiEntry.keysecondary.filter(k => k && k.trim())
            : wiEntry.keysecondary.split(',').map(k => k.trim()).filter(Boolean);
        if (secondary.length > 0) {
            fm.push(`refine_keys:`);
            for (const k of secondary) {
                fm.push(`  - ${yamlEscape(k)}`);
            }
        }
    }
    if (position) fm.push(`position: ${position}`);
    if (wiEntry.depth != null && wiEntry.depth > 0) fm.push(`depth: ${wiEntry.depth}`);
    if (wiEntry.probability != null && wiEntry.probability < 100) {
        fm.push(`probability: ${(wiEntry.probability / 100).toFixed(2)}`);
    }
    if (wiEntry.scanDepth) fm.push(`scanDepth: ${wiEntry.scanDepth}`);
    fm.push(`summary: "Imported from SillyTavern World Info"`);
    fm.push('---');

    // Build content — sanitize to prevent YAML/control sequence injection
    let content = wiEntry.content || '';
    content = content.replace(/^---$/gm, '- - -'); // prevent YAML frontmatter delimiter injection
    content = content.replace(/%%deeplore-exclude%%[\s\S]*?%%\/deeplore-exclude%%/g, ''); // strip control sequences
    content = content.replace(/^%%[\s\S]*?^%%/gm, ''); // strip Obsidian comment blocks
    const fullContent = `${fm.join('\n')}\n\n# ${title}\n\n${content}`;

    return { filename: `${safeTitle}.md`, content: fullContent };
}

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
                            // Network error during uniqueness check — bail out of loop
                            if (dupErr.name !== 'AbortError') {
                                break;
                            }
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

            const result = await writeNote(vault.port, vault.apiKey, fullPath, content);
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
