/**
 * DeepLore Enhanced — Pure helper functions (no SillyTavern imports)
 * Functions here are importable in both browser and Node.js test environments.
 * Extracted from ST-dependent modules to enable direct testing.
 */
import { yamlEscape } from '../core/utils.js';

// ── Content Sanitization ──

/**
 * Strip Obsidian-interpretable syntax from AI-generated content before writing to vault.
 * Prevents Templater expressions, dataview queries, and comment blocks from executing
 * when the note is opened in Obsidian.
 * @param {string} text - AI-generated content
 * @returns {string} Sanitized text
 */
export function stripObsidianSyntax(text) {
    if (!text || typeof text !== 'string') return text || '';
    let result = text;
    // Strip Templater expressions: {{...}} (single-line and multi-line)
    result = result.replace(/\{\{[\s\S]*?\}\}/g, '');
    // Strip Templater alternative syntax: <%...%> (single-line and multi-line)
    result = result.replace(/<%[\s\S]*?%>/g, '');
    // Strip Obsidian comments: %%...%% (single-line and multi-line)
    result = result.replace(/%%[\s\S]*?%%/g, '');
    // Strip dataview inline queries: `= ... ` (backtick-wrapped, starts with =)
    result = result.replace(/`=\s[^`]*`/g, '');
    // Strip dataview/dataviewjs code blocks
    result = result.replace(/```(?:dataview|dataviewjs)\s*\n[\s\S]*?```/gi, '');
    // Strip obsidian:// protocol links that could trigger vault actions
    result = result.replace(/\[([^\]]*)\]\(obsidian:\/\/[^)]*\)/g, '$1');
    // Strip Buttons plugin syntax
    result = result.replace(/```button\s*\n[\s\S]*?```/gi, '');
    // Strip CustomJS blocks
    result = result.replace(/```customjs\s*\n[\s\S]*?```/gi, '');
    return result;
}

// ── AI Response Parsing ──

/**
 * Extract AI response JSON from text (handles direct JSON, markdown code fences, raw arrays).
 * Uses non-greedy regex and tries last match first.
 * @param {string} text - Raw AI response text
 * @returns {Array|null} Parsed JSON array of results
 */
export function extractAiResponseClient(text) {
    if (!text || typeof text !== 'string') return null;

    /** Validate that a parsed value is a usable results array (strings or objects with title/name). */
    function isValidResultArray(val) {
        if (!Array.isArray(val)) return false;
        if (val.length === 0) return true; // valid empty response (AI says nothing relevant)
        const first = val[0];
        return typeof first === 'string'
            || (typeof first === 'object' && first !== null && (first.title || first.name));
    }

    // Try direct JSON parse
    try {
        const parsed = JSON.parse(text);
        if (isValidResultArray(parsed)) return parsed;
    } catch { /* noop */ }
    // Try markdown code fence
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        try {
            const parsed = JSON.parse(fenceMatch[1]);
            if (isValidResultArray(parsed)) return parsed;
        } catch { /* noop */ }
    }
    // Find bracket-balanced JSON arrays, prefer last (largest) match
    // Non-greedy regex fails on nested arrays like ["a", ["b"]] — use bracket counting instead
    const candidates = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '[') {
            let depth = 1, inStr = false, escape = false;
            for (let j = i + 1; j < text.length && depth > 0; j++) {
                const c = text[j];
                if (escape) { escape = false; continue; }
                if (c === '\\') { escape = true; continue; }
                if (c === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (c === '[') depth++;
                else if (c === ']') depth--;
                if (depth === 0) {
                    candidates.push(text.substring(i, j + 1));
                    break;
                }
            }
        }
    }
    // Try largest candidates first (outer arrays before inner)
    candidates.sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (isValidResultArray(parsed)) return parsed;
        } catch { /* noop */ }
    }
    return null;
}

/**
 * Normalize AI search results to a consistent format.
 * Handles string items, objects with title/name, and mixed arrays.
 * @param {Array} arr - Raw parsed AI response array
 * @returns {Array<{title: string, confidence: string, reason: string}>}
 */
export function normalizeResults(arr) {
    return arr.map(item => {
        if (typeof item === 'string') {
            return { title: item, confidence: 'medium', reason: 'AI search' };
        }
        if (typeof item === 'object' && item !== null && (item.title || item.name)) {
            return {
                title: item.title || item.name || '',
                confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium',
                reason: typeof item.reason === 'string' ? item.reason : 'AI search',
            };
        }
        return { title: String(item), confidence: 'medium', reason: 'AI search' };
    });
}

// ── Hierarchical Clustering ──

/**
 * Cluster entries by type/tag for hierarchical manifest (large vaults).
 * @param {import('../core/pipeline.js').VaultEntry[]} entries - Selectable entries (non-constant)
 * @returns {Map<string, import('../core/pipeline.js').VaultEntry[]>} Category name → entries in that category
 */
export function clusterEntries(entries) {
    const clusters = new Map();
    for (const entry of entries) {
        // Use first meaningful tag, or type frontmatter field, or 'Uncategorized'
        let category = 'Uncategorized';
        if (entry.tags && entry.tags.length > 0) {
            // Use the most specific tag (first non-generic tag)
            category = entry.tags[0];
        }
        if (!clusters.has(category)) clusters.set(category, []);
        clusters.get(category).push(entry);
    }
    return clusters;
}

/**
 * Build a compact category manifest for the first stage of hierarchical search.
 * Lists category names with entry count and sample titles.
 * @param {Map<string, import('../core/pipeline.js').VaultEntry[]>} clusters
 * @returns {string}
 */
export function buildCategoryManifest(clusters) {
    const lines = [];
    for (const [category, entries] of clusters) {
        const samples = entries.slice(0, 5).map(e => e.title).join(', ');
        const more = entries.length > 5 ? ` (+${entries.length - 5} more)` : '';
        lines.push(`[${category}] (${entries.length} entries): ${samples}${more}`);
    }
    return lines.join('\n');
}

// ── Obsidian URI ──

/**
 * Build an obsidian:// URI to open a file in a specific vault.
 * @param {string} vaultName - Obsidian vault name
 * @param {string} filename - File path within vault
 * @returns {string|null} URI string or null if no vault name
 */
export function buildObsidianURI(vaultName, filename) {
    if (!vaultName) return null;
    const encodedVault = encodeURIComponent(vaultName);
    const encodedFile = filename.split('/').map(s => encodeURIComponent(s)).join('/');
    return `obsidian://open?vault=${encodedVault}&file=${encodedFile}`;
}

// ── World Info Import ──

/**
 * Convert a SillyTavern World Info entry into an Obsidian vault note with frontmatter.
 * @param {object} wiEntry - SillyTavern World Info entry object
 * @param {string} lorebookTag - Tag to apply (e.g. 'lorebook')
 * @returns {{filename: string, content: string}}
 */
export function convertWiEntry(wiEntry, lorebookTag) {
    // Extract title from comment field (ST convention) or first key
    // Strip newlines to prevent H1 heading injection
    const title = ((wiEntry.comment || '').trim()
        || (wiEntry.key || []).join(', ').substring(0, 50)
        || `Entry_${wiEntry.uid || Date.now()}`).replace(/[\r\n]+/g, ' ');

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
    fm.push(`priority: ${Math.max(0, Math.min(999, Math.round(Number(wiEntry.order) || 50)))}`);
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

// ── Health Check Pure Functions ──

/**
 * Portable health check for vault entries. Runs the same detection logic as
 * runHealthCheck() in diagnostics.js but takes explicit parameters instead of
 * reading global state, making it importable and testable in Node.js.
 *
 * Tests a subset (8 per-entry checks + 2 aggregate checks) of the production
 * function's 30+ checks. The production function calls these same checks.
 *
 * @param {Array} vaultIndex - All parsed VaultEntry objects
 * @param {object} [settings] - Settings object (for budget checks)
 * @returns {Array<{type: string, entry: string, [target]: string, [ref]: string, [tokens]: number}>}
 */
export function checkHealthPure(vaultIndex, settings = {}) {
    const issues = [];
    const allTitles = new Set(vaultIndex.map(e => e.title));
    const titleCounts = new Map();

    for (const entry of vaultIndex) {
        titleCounts.set(entry.title, (titleCounts.get(entry.title) || 0) + 1);

        // Circular requires
        for (const req of entry.requires) {
            const target = vaultIndex.find(e => e.title.toLowerCase() === req.toLowerCase());
            if (target && target.requires.some(r => r.toLowerCase() === entry.title.toLowerCase())) {
                if (entry.title < target.title) {
                    issues.push({ type: 'circular_requires', entry: entry.title, target: target.title });
                }
            }
        }

        // Requires AND excludes same title
        for (const req of entry.requires) {
            if (entry.excludes.some(exc => exc.toLowerCase() === req.toLowerCase())) {
                issues.push({ type: 'requires_excludes_conflict', entry: entry.title, ref: req });
            }
        }

        // Orphaned cascade_links
        if (entry.cascadeLinks) {
            for (const cl of entry.cascadeLinks) {
                if (!allTitles.has(cl)) {
                    issues.push({ type: 'orphaned_cascade', entry: entry.title, ref: cl });
                }
            }
        }

        // Cooldown on constant
        if (entry.constant && entry.cooldown !== null) {
            issues.push({ type: 'cooldown_on_constant', entry: entry.title });
        }

        // Depth override without in_chat
        if (entry.injectionDepth !== null && entry.injectionPosition !== 1) {
            issues.push({ type: 'depth_without_inchat', entry: entry.title });
        }

        // Empty content
        if (!entry.content || !entry.content.trim()) {
            issues.push({ type: 'empty_content', entry: entry.title });
        }

        // Probability zero
        if (entry.probability === 0) {
            issues.push({ type: 'probability_zero', entry: entry.title });
        }
    }

    // Duplicate titles
    for (const [title, count] of titleCounts) {
        if (count > 1) {
            issues.push({ type: 'duplicate_title', entry: title });
        }
    }

    // Constants exceeding budget
    if (settings.maxTokensBudget && !settings.unlimitedBudget) {
        const constantTokens = vaultIndex.filter(e => e.constant).reduce((s, e) => s + e.tokenEstimate, 0);
        if (constantTokens > settings.maxTokensBudget) {
            issues.push({ type: 'constants_over_budget', tokens: constantTokens });
        }
    }

    return issues;
}

// ── Shared Stage Colors ──

/**
 * Diagnostic stage → CSS color mapping used by browse popup, test-match, and settings UI.
 * Extracted here to avoid duplication across popups.js, commands.js, and settings-ui.js.
 */
export const STAGE_COLORS = {
    keyword_miss: 'var(--dle-warning, #ff9800)',
    no_keywords: 'var(--dle-error, #f44336)',
    scan_depth_zero: 'var(--dle-error, #f44336)',
    warmup: 'var(--dle-warning, #ff9800)',
    cooldown: 'var(--dle-warning, #ff9800)',
    reinjection_cooldown: 'var(--dle-warning, #ff9800)',
    probability: 'var(--dle-accent, #9c27b0)',
    refine_keys: 'var(--dle-warning, #ff9800)',
    gating_requires: 'var(--dle-error, #f44336)',
    gating_excludes: 'var(--dle-error, #f44336)',
    ai_rejected: 'var(--dle-info, #2196f3)',
    budget_cut: 'var(--dle-warning, #ff9800)',
};
