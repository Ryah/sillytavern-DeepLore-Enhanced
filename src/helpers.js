/**
 * DeepLore Enhanced — Pure helper functions (no SillyTavern imports)
 * Functions here are importable in both browser and Node.js test environments.
 * Extracted from ST-dependent modules to enable direct testing.
 */
import { yamlEscape } from '../core/utils.js';

// ── Filename Sanitization ──

/**
 * Sanitize a title for use as an Obsidian vault filename.
 * Removes OS-reserved characters, leading/trailing dots, and Windows reserved names.
 * @param {string} title
 * @returns {string} Safe filename
 */
export function sanitizeFilename(title) {
    let safe = title.replace(/[<>:"/\\|?*]/g, '_');
    safe = safe.replace(/^\.+|\.+$/g, '');
    safe = safe.trimEnd();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safe)) safe = '_' + safe;
    return safe || 'Untitled';
}

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

    /** BUG-046: Validate that a parsed value is a usable results array — at least one valid element. */
    function isValidResultArray(val) {
        if (!Array.isArray(val)) return false;
        if (val.length === 0) return true; // valid empty response (AI says nothing relevant)
        return val.some(item =>
            typeof item === 'string'
            || (typeof item === 'object' && item !== null && (item.title || item.name)),
        );
    }

    // Try direct JSON parse
    try {
        const parsed = JSON.parse(text);
        if (isValidResultArray(parsed)) return parsed;
    } catch { /* noop */ }
    // Try markdown code fence
    const fenceMatch = text.match(/`{3,}(?:json)?\s*([\s\S]*?)`{3,}/);
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
            let depth = 1, inStr = false, inSingleStr = false, escape = false;
            for (let j = i + 1; j < text.length && depth > 0; j++) {
                const c = text[j];
                if (escape) { escape = false; continue; }
                if (c === '\\') { escape = true; continue; }
                if (c === '"' && !inSingleStr) { inStr = !inStr; continue; }
                if (c === "'" && !inStr) { inSingleStr = !inSingleStr; continue; }
                if (inStr || inSingleStr) continue;
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
    }).filter(r => r.title && r.title.trim() && r.title !== 'null' && r.title !== 'undefined');
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
    // Strip .md extension — Obsidian's URI handler expects paths without it
    const stripped = filename.replace(/\.md$/i, '');
    const encodedFile = stripped.split('/').map(s => encodeURIComponent(s)).join('/');
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
    // BUG-008: Handle both array and string key formats (older ST exports use comma-separated string)
    const keyArray = Array.isArray(wiEntry.key) ? wiEntry.key
        : (typeof wiEntry.key === 'string' ? wiEntry.key.split(',').map(k => k.trim()).filter(Boolean) : []);
    const title = ((wiEntry.comment || '').trim()
        || keyArray.join(', ').substring(0, 50)
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
    content = stripObsidianSyntax(content); // strip Templater, Dataview, CustomJS, obsidian:// links
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

// ── Cartographer Data Layer ──
// Shared data-preparation functions used by both the Context Cartographer popup
// (src/cartographer.js) and the drawer Why? tab (src/drawer-render.js).

/**
 * Parse a matchedBy string into a structured match reason.
 * Both renderers format this differently (popup: parenthetical, drawer: badge).
 * @param {string|null} matchedBy - Raw matchedBy string from pipeline
 * @returns {{ type: 'constant'|'pinned'|'bootstrap'|'seed'|'keyword_ai'|'keyword'|'ai'|'unknown', keyword: string|null }}
 */
export function parseMatchReason(matchedBy) {
    if (!matchedBy) return { type: 'unknown', keyword: null };
    const m = matchedBy.toLowerCase();
    if (m.includes('constant') || m.includes('always')) return { type: 'constant', keyword: null };
    if (m.includes('pin')) return { type: 'pinned', keyword: null };
    if (m.includes('bootstrap')) return { type: 'bootstrap', keyword: null };
    if (m.includes('seed')) return { type: 'seed', keyword: null };
    // "keyword → AI: reason" pattern (two-stage match)
    if (matchedBy.includes('→')) {
        const keyword = matchedBy.split('→')[0].trim();
        return { type: 'keyword_ai', keyword };
    }
    // Pure AI match
    if (m.startsWith('ai:') || m === 'ai selection' || m === 'ai') return { type: 'ai', keyword: null };
    // Bare keyword match
    if (matchedBy.trim()) return { type: 'keyword', keyword: matchedBy.trim() };
    return { type: 'unknown', keyword: null };
}

/**
 * Compute diff between current and previous injection sources.
 * @param {Array<{title: string, tokens?: number, matchedBy?: string}>} currentSources
 * @param {Array<{title: string, tokens?: number, matchedBy?: string}>|null} previousSources
 * @returns {{ added: Array, removed: Array<{title: string, tokens?: number, matchedBy?: string, removalReason: string}> }}
 */
export function computeSourcesDiff(currentSources, previousSources) {
    if (!previousSources) return { added: [], removed: [] };
    const prevMap = new Map(previousSources.map(s => [s.title, s]));
    const currTitles = new Set(currentSources.map(s => s.title));
    const added = currentSources.filter(s => !prevMap.has(s.title));
    const removed = previousSources.filter(s => !currTitles.has(s.title)).map(s => {
        const prevReason = (s.matchedBy || '').toLowerCase();
        let removalReason = 'No longer matched';
        if (prevReason.includes('bootstrap')) removalReason = 'Bootstrap fall-off';
        else if (prevReason.includes('constant') || prevReason.includes('always')) removalReason = 'Constant removed';
        return { ...s, removalReason };
    });
    return { added, removed };
}

/**
 * Parse a pipeline trace and categorize rejected entries by stage.
 * Handles mixed trace field shapes (some string arrays, some object arrays).
 * @param {object|null} trace - lastPipelineTrace from pipeline run
 * @param {Set<string>} injectedTitles - Titles of entries that were actually injected
 * @returns {Array<{ stage: string, label: string, icon: string, entries: Array<{title: string, reason: string}> }>}
 */
export function categorizeRejections(trace, injectedTitles) {
    if (!trace) return [];
    const groups = [];

    // Gated Out (requires/excludes)
    if (trace.gatedOut?.length > 0) {
        const entries = trace.gatedOut
            .filter(e => !injectedTitles.has(e.title))
            .map(e => {
                const parts = [];
                if (e.requires?.length) parts.push(`needs: ${e.requires.join(', ')}`);
                if (e.excludes?.length) parts.push(`blocked by: ${e.excludes.join(', ')}`);
                return { title: e.title, reason: parts.join('; ') || 'requires/excludes' };
            });
        if (entries.length > 0) groups.push({ stage: 'gated_out', label: 'Blocked by dependencies', icon: 'fa-lock', entries });
    }

    // Contextual Gating Removed (string array)
    if (trace.contextualGatingRemoved?.length > 0) {
        const entries = trace.contextualGatingRemoved
            .filter(t => !injectedTitles.has(t))
            .map(t => ({ title: t, reason: 'Filtered by era/location/scene/character' }));
        if (entries.length > 0) groups.push({ stage: 'contextual_gating', label: 'Filtered by context', icon: 'fa-filter', entries });
    }

    // AI Rejected — candidates that made it to manifest but AI didn't select
    if (trace.keywordMatched?.length > 0 && trace.aiSelected) {
        const aiSelectedTitles = new Set(trace.aiSelected.map(m => m.title));
        // Build set of entries accounted for by other stages
        const accountedTitles = new Set([
            ...(trace.gatedOut || []).map(e => e.title),
            ...(trace.contextualGatingRemoved || []),
            ...(trace.cooldownRemoved || []),
            ...(trace.stripDedupRemoved || []),
            ...(trace.probabilitySkipped || []).map(e => e.title),
            ...(trace.warmupFailed || []).map(e => e.title),
            ...(trace.budgetCut || []).map(e => e.title),
        ]);
        const entries = trace.keywordMatched
            .filter(m => !aiSelectedTitles.has(m.title) && !injectedTitles.has(m.title) && !accountedTitles.has(m.title))
            .map(m => ({ title: m.title, reason: 'AI did not select' }));
        if (entries.length > 0) groups.push({ stage: 'ai_rejected', label: 'AI Rejected', icon: 'fa-robot', entries });
    }

    // Cooldown Removed (string array)
    if (trace.cooldownRemoved?.length > 0) {
        const entries = trace.cooldownRemoved
            .filter(t => !injectedTitles.has(t))
            .map(t => ({ title: t, reason: 'Cooldown active' }));
        if (entries.length > 0) groups.push({ stage: 'cooldown', label: 'Cooldown Active', icon: 'fa-clock', entries });
    }

    // Budget/Max Cut (object array with title + tokens)
    if (trace.budgetCut?.length > 0) {
        const entries = trace.budgetCut
            .filter(e => !injectedTitles.has(e.title))
            .map(e => ({ title: e.title, reason: `Over budget${e.tokens ? ` (${e.tokens} tok)` : ''}` }));
        if (entries.length > 0) groups.push({ stage: 'budget_cut', label: 'Over budget', icon: 'fa-scissors', entries });
    }

    // Strip Dedup Removed (string array)
    if (trace.stripDedupRemoved?.length > 0) {
        const entries = trace.stripDedupRemoved
            .filter(t => !injectedTitles.has(t))
            .map(t => ({ title: t, reason: 'Already in context' }));
        if (entries.length > 0) groups.push({ stage: 'strip_dedup', label: 'Dedup Removed', icon: 'fa-copy', entries });
    }

    // Probability Skipped (object array)
    if (trace.probabilitySkipped?.length > 0) {
        const entries = trace.probabilitySkipped
            .filter(e => !injectedTitles.has(e.title))
            .map(e => ({ title: e.title, reason: 'Probability skipped' }));
        if (entries.length > 0) groups.push({ stage: 'probability_skipped', label: 'Probability Skipped', icon: 'fa-dice', entries });
    }

    // Warmup Not Met (object array)
    if (trace.warmupFailed?.length > 0) {
        const entries = trace.warmupFailed
            .filter(e => !injectedTitles.has(e.title))
            .map(e => ({ title: e.title, reason: 'Warmup not met' }));
        if (entries.length > 0) groups.push({ stage: 'warmup_failed', label: 'Warmup Not Met', icon: 'fa-temperature-low', entries });
    }

    // Refine Key Blocked (object array)
    if (trace.refineKeyBlocked?.length > 0) {
        const entries = trace.refineKeyBlocked
            .filter(e => !injectedTitles.has(e.title))
            .map(e => ({ title: e.title, reason: `Matched "${e.primaryKey}" but refine keys [${e.refineKeys.join(', ')}] not found` }));
        if (entries.length > 0) groups.push({ stage: 'refine_key_blocked', label: 'Refine Key Blocked', icon: 'fa-filter-circle-xmark', entries });
    }

    return groups;
}

/**
 * Resolve the vault name and Obsidian URI for a source entry.
 * Encapsulates the vault-lookup + URI-build pattern used by both renderers.
 * @param {{ vaultSource?: string, filename?: string }} source
 * @param {Array<{ name: string }>|undefined} vaults - settings.vaults
 * @returns {{ vaultName: string, uri: string|null }}
 */
export function resolveEntryVault(source, vaults) {
    const srcVault = source.vaultSource && vaults
        ? vaults.find(v => v.name === source.vaultSource)
        : null;
    const vaultName = srcVault ? srcVault.name : (source.vaultSource || vaults?.[0]?.name || '');
    const uri = source.filename ? buildObsidianURI(vaultName, source.filename) : null;
    return { vaultName, uri };
}

/**
 * Compute a color on a green→yellow→red gradient based on token count vs vault average.
 * Returns an HSL color string.
 * @param {number} tokens - Token count for this entry
 * @param {number} avgTokens - Average tokens across the vault
 * @returns {string} CSS color value
 */
export function tokenBarColor(tokens, avgTokens) {
    if (!avgTokens || avgTokens <= 0) return 'var(--SmartThemeQuoteColor, #4caf50)';
    const ratio = Math.min(tokens / avgTokens, 3.0);
    let hue;
    if (ratio <= 0.5) {
        hue = 120;
    } else if (ratio <= 1.0) {
        hue = 120 - ((ratio - 0.5) / 0.5) * 60; // 120 → 60
    } else {
        hue = 60 - (Math.min(ratio - 1.0, 1.0)) * 60; // 60 → 0
    }
    return `hsl(${Math.round(hue)}, 70%, 45%)`;
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

// ── Relative Time Formatting ──

/**
 * Format a timestamp as a human-readable relative time string.
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} e.g. "just now", "5m ago", "2h ago", "3d ago"
 */
export function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    if (diff < 0) return 'just now';
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
}

// ── Pin/Block Multi-Vault Helpers ──

/**
 * Normalize a pin/block item to structured form.
 * Legacy bare strings (from pre-H23 chat_metadata) get vaultSource=null (match any vault).
 * @param {string|{title:string, vaultSource?:string}} item
 * @returns {{ title: string, vaultSource: string|null }}
 */
export function normalizePinBlock(item) {
    if (typeof item === 'string') return { title: item, vaultSource: null };
    return { title: item.title || '', vaultSource: item.vaultSource || null };
}

/**
 * Check whether a pin/block item matches a vault entry.
 * If the pin/block has no vaultSource (legacy or single-vault), matches any vault.
 * @param {string|{title:string, vaultSource?:string}} pinBlock
 * @param {{ title: string, vaultSource?: string }} entry
 * @returns {boolean}
 */
export function matchesPinBlock(pinBlock, entry) {
    const pb = normalizePinBlock(pinBlock);
    if (pb.title.toLowerCase() !== entry.title.toLowerCase()) return false;
    if (pb.vaultSource && entry.vaultSource && pb.vaultSource !== entry.vaultSource) return false;
    return true;
}

// ── Force-Injection Predicate ──

/**
 * Determines whether an entry is force-injected (constant or active bootstrap).
 * Consolidates 4 call sites with a single predicate — each caller computes
 * `bootstrapActive` from its own context (chat length, settings, etc.).
 * @param {object} entry - VaultEntry with .constant and .bootstrap fields
 * @param {{ bootstrapActive: boolean }} context
 * @returns {boolean}
 */
export function isForceInjected(entry, context = {}) {
    return entry.constant || (context.bootstrapActive && entry.bootstrap);
}

// ── Fuzzy Title Matching ──

/**
 * Find the best fuzzy match for an AI-returned title among candidate entry titles.
 * Uses bigram similarity (Dice coefficient). Returns the match if similarity >= threshold.
 * @param {string} aiTitle - Title returned by AI
 * @param {string[]} candidateTitles - Available entry titles
 * @param {number} [threshold=0.6] - Minimum similarity (0-1)
 * @returns {{ title: string, similarity: number } | null}
 */
export function fuzzyTitleMatch(aiTitle, candidateTitles, threshold = 0.6) {
    const aBigrams = bigrams(aiTitle.toLowerCase());
    if (aBigrams.size === 0) return null;

    let bestTitle = null;
    let bestScore = 0;
    for (const candidate of candidateTitles) {
        const bBigrams = bigrams(candidate.toLowerCase());
        if (bBigrams.size === 0) continue;
        let overlap = 0;
        for (const bg of aBigrams) { if (bBigrams.has(bg)) overlap++; }
        const score = (2 * overlap) / (aBigrams.size + bBigrams.size);
        if (score > bestScore) { bestScore = score; bestTitle = candidate; }
    }
    return bestScore >= threshold ? { title: bestTitle, similarity: bestScore } : null;
}

/** @param {string} str @returns {Set<string>} */
function bigrams(str) {
    const set = new Set();
    for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
    return set;
}

// ── AI Notepad Extraction ──

/**
 * Extract AI notepad content from <dle-notes> tags in a message.
 * Returns the cleaned message (tags stripped) and the extracted notes.
 * @param {string} messageText - Raw AI response text
 * @returns {{ notes: string|null, cleanedMessage: string }}
 */
export function extractAiNotes(messageText) {
    if (!messageText) return { notes: null, cleanedMessage: messageText || '' };

    const noteRegex = /<dle-notes>([\s\S]*?)<\/dle-notes>/g;
    const extracted = [];
    let match;
    while ((match = noteRegex.exec(messageText)) !== null) {
        const content = match[1].trim();
        if (content) extracted.push(content);
    }

    if (extracted.length === 0) return { notes: null, cleanedMessage: messageText };

    const cleanedMessage = messageText.replace(noteRegex, '').replace(/\n{3,}/g, '\n\n').trimEnd();
    return { notes: extracted.join('\n'), cleanedMessage };
}

// ════════════════════════════════════════════════════════════════════════════
// Librarian: Session Response Parsing
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse the AI response text into a structured object.
 * Handles raw JSON, code-fenced JSON, and bracket-balanced extraction.
 * Pure function, no side effects. Importable in Node.js tests.
 * @param {string} text - Raw AI response
 * @returns {object|null} Parsed response or null on total failure
 */
export function parseSessionResponse(text) {
    if (!text || typeof text !== 'string') return null;

    // Try direct JSON parse
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch { /* noop */ }

    // Try code fence extraction
    const fenceMatch = text.match(/`{3,}(?:json)?\s*([\s\S]*?)`{3,}/);
    if (fenceMatch) {
        try {
            const parsed = JSON.parse(fenceMatch[1].trim());
            if (typeof parsed === 'object' && parsed !== null) return parsed;
        } catch { /* noop */ }
    }

    // Try finding first { ... } block via bracket balancing
    const firstBrace = text.indexOf('{');
    if (firstBrace >= 0) {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = firstBrace; i < text.length; i++) {
            const ch = text[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    try {
                        const parsed = JSON.parse(text.slice(firstBrace, i + 1));
                        if (typeof parsed === 'object' && parsed !== null) return parsed;
                    } catch { /* noop */ }
                    break;
                }
            }
        }
    }

    return null;
}

// ════════════════════════════════════════════════════════════════════════════
// Librarian: Session Response Validation
// ════════════════════════════════════════════════════════════════════════════

const VALID_ENTRY_TYPES = ['character', 'location', 'lore', 'organization', 'story'];
const VALID_SESSION_ACTIONS = ['update_draft', 'propose_queue', 'propose_options'];
const VALID_QUEUE_ACTIONS = ['create', 'update'];
const VALID_URGENCIES = ['low', 'medium', 'high'];

/**
 * Validate a parsed librarian session response.
 * Pure function, no side effects. Importable in Node.js tests.
 * @param {object} parsed - Parsed response object
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSessionResponse(parsed) {
    const errors = [];

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { valid: false, errors: ['Response must be a JSON object'] };
    }
    if (typeof parsed.message !== 'string' || !parsed.message.trim()) {
        errors.push("Missing required 'message' field (must be a non-empty string)");
    }
    if (parsed.action !== undefined && parsed.action !== null && !VALID_SESSION_ACTIONS.includes(parsed.action)) {
        errors.push(`'action' must be one of: update_draft, propose_queue, null. Got: '${parsed.action}'`);
    }

    if (parsed.draft !== undefined && parsed.draft !== null) {
        if (typeof parsed.draft !== 'object' || Array.isArray(parsed.draft)) {
            errors.push("'draft' must be an object or null");
        } else {
            const d = parsed.draft;
            if (!d.title || (typeof d.title === 'string' && !d.title.trim())) {
                errors.push('draft.title is required and cannot be empty');
            }
            if (d.type !== undefined && !VALID_ENTRY_TYPES.includes(d.type)) {
                errors.push(`draft.type must be one of: ${VALID_ENTRY_TYPES.join(', ')}. Got: '${d.type}'`);
            }
            if (d.priority !== undefined) {
                if (typeof d.priority !== 'number' || d.priority < 1 || d.priority > 100) {
                    errors.push(`draft.priority must be a number between 1 and 100. Got: '${d.priority}'`);
                }
            }
            if (d.keys !== undefined) {
                if (!Array.isArray(d.keys)) {
                    errors.push('draft.keys must be an array');
                } else if (d.keys.length === 0) {
                    errors.push('draft.keys must contain at least one keyword');
                } else {
                    const emptyIndices = d.keys.reduce((acc, k, i) => {
                        if (typeof k !== 'string' || !k.trim()) acc.push(i);
                        return acc;
                    }, []);
                    if (emptyIndices.length > 0) {
                        errors.push(`draft.keys contains empty strings at indices: ${emptyIndices.join(', ')}`);
                    }
                }
            }
            if (d.summary !== undefined && typeof d.summary === 'string' && d.summary.length > 600) {
                errors.push(`draft.summary exceeds 600 character limit (${d.summary.length} chars)`);
            }
            if (d.content !== undefined) {
                if (typeof d.content !== 'string' || d.content.length < 50) {
                    errors.push('draft.content is required and must be at least 50 characters');
                }
            }
        }
    }

    if (parsed.queue !== undefined && parsed.queue !== null) {
        if (!Array.isArray(parsed.queue)) {
            errors.push("'queue' must be an array");
        } else {
            for (let i = 0; i < parsed.queue.length; i++) {
                const item = parsed.queue[i];
                if (!item.title || (typeof item.title === 'string' && !item.title.trim())) {
                    errors.push(`queue[${i}].title is required`);
                }
                if (!VALID_QUEUE_ACTIONS.includes(item.action)) {
                    errors.push(`queue[${i}].action must be 'create' or 'update'. Got: '${item.action}'`);
                }
                if (!item.reason || (typeof item.reason === 'string' && !item.reason.trim())) {
                    errors.push(`queue[${i}].reason is required`);
                }
                if (item.urgency !== undefined && !VALID_URGENCIES.includes(item.urgency)) {
                    errors.push(`queue[${i}].urgency must be low, medium, or high. Got: '${item.urgency}'`);
                }
            }
        }
    }

    if (parsed.options !== undefined && parsed.options !== null) {
        if (!Array.isArray(parsed.options)) {
            errors.push("'options' must be an array");
        } else if (parsed.options.length === 0) {
            errors.push("'options' must contain at least one option");
        } else {
            for (let i = 0; i < parsed.options.length; i++) {
                const opt = parsed.options[i];
                if (!opt.label || (typeof opt.label === 'string' && !opt.label.trim())) {
                    errors.push(`options[${i}].label is required`);
                }
                if (!opt.fields || typeof opt.fields !== 'object' || Array.isArray(opt.fields)) {
                    errors.push(`options[${i}].fields must be an object with draft field values`);
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}
