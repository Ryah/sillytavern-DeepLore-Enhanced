/**
 * DeepLore Enhanced Core — Pipeline Helpers
 */

import { parseFrontmatter, extractWikiLinks, cleanContent, extractTitle } from './utils.js';
import { extractCustomFields } from '../src/fields.js';
// BUG-094: Use ST's canonical role name → enum mapper instead of a local positional map.
// Resolved lazily so unit tests / cold-start don't crash if ST isn't loaded yet.
let _getExtensionPromptRoleByName = null;
let _roleByNameAttempted = false;
const _ROLE_FALLBACK = { system: 0, user: 1, assistant: 2 };
function _resolveRoleByName(name) {
    if (typeof name !== 'string') return null;
    const lower = name.toLowerCase();
    if (!_roleByNameAttempted) {
        _roleByNameAttempted = true;
        try {
            // Probe the global ST namespace; the function is exported on script.js.
            // eslint-disable-next-line no-undef
            const g = (typeof window !== 'undefined' ? window : globalThis);
            if (g && typeof g.getExtensionPromptRoleByName === 'function') {
                _getExtensionPromptRoleByName = g.getExtensionPromptRoleByName;
            }
        } catch { /* ignore */ }
    }
    if (typeof _getExtensionPromptRoleByName === 'function') {
        const v = _getExtensionPromptRoleByName(lower);
        if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return _ROLE_FALLBACK[lower] ?? null;
}

/**
 * @typedef {object} VaultEntry
 * @property {string} filename - Full path in vault
 * @property {string} title - Display title (from H1 or filename)
 * @property {string[]} keys - Trigger keywords from frontmatter
 * @property {string} content - Cleaned markdown content (frontmatter stripped)
 * @property {string} summary - AI selection summary from frontmatter
 * @property {number} priority - Sort priority (lower = higher priority)
 * @property {boolean} constant - Always inject regardless of keywords
 * @property {boolean} seed - Content sent to AI as story context on new chats
 * @property {boolean} bootstrap - Force-inject when chat is short
 * @property {boolean} guide - Librarian-only writing/style/meta guide; never reaches the writing AI
 * @property {number} tokenEstimate - Rough token count estimate
 * @property {number|null} scanDepth - Per-entry scan depth override (null = use global)
 * @property {boolean} excludeRecursion - Don't scan this entry's content during recursion
 * @property {string[]} links - Wiki-link targets extracted before cleaning
 * @property {string[]} resolvedLinks - Links confirmed to match existing entry titles
 * @property {string[]} tags - All Obsidian tags (excluding the lorebook marker tag)
 * @property {string[]} requires - Entry titles that must all be matched for this entry to activate
 * @property {string[]} excludes - Entry titles that, if any matched, prevent this entry from activating
 * @property {string|null} outlet - Outlet name for macro-based injection (null = normal positional injection)
 * @property {number|null} injectionPosition - Per-entry injection position override (null = use global)
 * @property {number|null} injectionDepth - Per-entry injection depth override (null = use global)
 * @property {number|null} injectionRole - Per-entry injection role override (null = use global)
 * @property {number|null} cooldown - Generations to skip after triggering (null = no cooldown)
 * @property {number|null} warmup - Keyword hit count required before triggering (null = no warmup)
 * @property {number|null} probability - Chance of triggering when matched (0.0-1.0, null = always trigger)
 * @property {string|null} folderPath - Parent folder path within vault (null = vault root)
 * @property {string} vaultSource - Name of the vault this entry came from (multi-vault)
 * @property {Object<string, *>} customFields - User-defined custom fields extracted by field definitions
 * @property {boolean} graph - Whether this entry should appear in the relationship graph (default true)
 */

/**
 * @typedef {object} TagConfig
 * @property {string} lorebookTag - Tag that marks an entry as a lorebook entry
 * @property {string} constantTag - Tag for always-inject entries
 * @property {string} neverInsertTag - Tag for entries to skip
 * @property {string} [seedTag] - Tag for seed entries (Enhanced only)
 * @property {string} [bootstrapTag] - Tag for bootstrap entries (Enhanced only)
 * @property {string} [guideTag] - Tag for Librarian-only writing-guide entries
 */

/**
 * Canonical frontmatter field names DLE recognizes, keyed by their lowercased lookup
 * form. The value is the canonical spelling the parser reads — mostly lowercase, but
 * `scanDepth` / `excludeRecursion` stay camelCase because the readers below use
 * camelCase (they were grandfathered in before this alias table existed).
 */
const CANONICAL_FM_LOOKUP = {
    keys: 'keys',
    tags: 'tags',
    priority: 'priority',
    summary: 'summary',
    depth: 'depth',
    position: 'position',
    role: 'role',
    scandepth: 'scanDepth',
    cooldown: 'cooldown',
    warmup: 'warmup',
    probability: 'probability',
    requires: 'requires',
    excludes: 'excludes',
    refine_keys: 'refine_keys',
    cascade_links: 'cascade_links',
    enabled: 'enabled',
    constant: 'constant',
    seed: 'seed',
    bootstrap: 'bootstrap',
    guide: 'guide',
    outlet: 'outlet',
    era: 'era',
    location: 'location',
    scene_type: 'scene_type',
    character_present: 'character_present',
    graph: 'graph',
    excluderecursion: 'excludeRecursion',
};

/**
 * Normalize non-canonical case variants of known frontmatter keys in-place.
 * Pushes a `W_ALIAS_USED` warning for each rewrite. If both variants exist, canonical wins.
 * @param {object} fm - Frontmatter object (mutated)
 * @param {Array} warnings - Warning sink
 */
function normalizeFrontmatterKeys(fm, warnings) {
    for (const key of Object.keys(fm)) {
        const lower = key.toLowerCase();
        const canonical = CANONICAL_FM_LOOKUP[lower];
        if (!canonical || key === canonical) continue;
        if (Object.prototype.hasOwnProperty.call(fm, canonical)) {
            // Canonical already exists — drop the alias silently
            delete fm[key];
            continue;
        }
        fm[canonical] = fm[key];
        delete fm[key];
        warnings.push({
            code: 'W_ALIAS_USED',
            severity: 'warn',
            field: key,
            message: `Field '${key}' should be '${canonical}'.`,
            suggestedFix: `Rename '${key}:' to '${canonical}:'.`,
        });
    }
}

/**
 * Coerce a value to a number when lenient. Returns { value, warned } — `value` is
 * the coerced number if successful, or null if not coercible (caller keeps default).
 */
function coerceNumber(raw, fieldName, warnings, lenient) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw, warned: false };
    if (!lenient) return { value: null, warned: false };
    if (typeof raw === 'string' && raw.trim() !== '' && !isNaN(Number(raw))) {
        const coerced = Number(raw);
        warnings.push({
            code: 'W_COERCED_NUM',
            severity: 'warn',
            field: fieldName,
            message: `Field '${fieldName}' should be a number, got string "${raw}". Coerced to ${coerced}.`,
            suggestedFix: `Remove the quotes around ${fieldName}'s value.`,
        });
        return { value: coerced, warned: true };
    }
    return { value: null, warned: false };
}

/**
 * Parse a single vault file into a VaultEntry, or return null if it should be skipped.
 * @param {{ filename: string, content: string }} file - Raw file from server
 * @param {TagConfig} tagConfig - Tag configuration from settings
 * @param {import('../src/fields.js').FieldDefinition[]} [fieldDefinitions] - Custom field definitions (optional, for extracting customFields)
 * @param {{ lenientAuthoring?: boolean, onSkip?: (reason: string) => void }} [options] - Parser options
 * @returns {VaultEntry|null}
 */
export function parseVaultFile(file, tagConfig, fieldDefinitions, options = {}) {
    const lenient = options.lenientAuthoring !== false;
    const onSkip = typeof options.onSkip === 'function' ? options.onSkip : null;
    const warnings = [];

    const { frontmatter, body } = parseFrontmatter(file.content);

    // Lenient alias normalization — rewrite `Keys` → `keys`, etc.
    if (lenient) normalizeFrontmatterKeys(frontmatter, warnings);

    // Missing-frontmatter surfacing: no fences → parseFrontmatter returns {} for frontmatter.
    // We treat "no keys at all" as a skip signal only if there's also no lorebook tag (handled below).
    const hasAnyFrontmatter = Object.keys(frontmatter).length > 0;

    // Check if this file has the lorebook tag
    const tags = Array.isArray(frontmatter.tags)
        ? frontmatter.tags.map(t => String(t).toLowerCase())
        : (typeof frontmatter.tags === 'string' ? [frontmatter.tags.toLowerCase()] : []);

    const tagToMatch = tagConfig.lorebookTag.toLowerCase();
    const guideTagToMatch = tagConfig.guideTag ? tagConfig.guideTag.toLowerCase() : '';
    const hasGuideTag = !!(guideTagToMatch && tags.includes(guideTagToMatch));
    // Guide entries are admitted even without the lorebook tag — they live in the index for Emma's tools
    if (!tags.includes(tagToMatch) && !hasGuideTag) {
        if (onSkip) onSkip(hasAnyFrontmatter ? 'SKIP_NO_LOREBOOK_TAG' : 'SKIP_NO_FRONTMATTER');
        return null;
    }

    // Skip entries explicitly disabled via frontmatter
    if (frontmatter.enabled === false) {
        if (onSkip) onSkip('SKIP_ENABLED_FALSE');
        return null;
    }

    // Skip entries with the never-insert tag
    const neverInsertTagToMatch = tagConfig.neverInsertTag ? tagConfig.neverInsertTag.toLowerCase() : '';
    if (neverInsertTagToMatch && tags.includes(neverInsertTagToMatch)) {
        if (onSkip) onSkip('SKIP_NEVER_INSERT_TAG');
        return null;
    }

    // Extract keys — with lenient comma-string auto-split
    let keys;
    if (Array.isArray(frontmatter.keys)) {
        keys = frontmatter.keys.map(k => String(k));
    } else if (typeof frontmatter.keys === 'string') {
        const raw = frontmatter.keys;
        if (lenient && raw.includes(',')) {
            keys = raw.split(',').map(k => k.trim()).filter(Boolean);
            warnings.push({
                code: 'W_COMMA_SPLIT',
                severity: 'warn',
                field: 'keys',
                message: `'keys' was a comma-separated string ("${raw}"). Split into ${keys.length} keys.`,
                suggestedFix: 'Use a YAML list (one key per line with `- `) instead of a comma-separated string.',
            });
        } else {
            keys = [raw];
        }
    } else if (frontmatter.keys) {
        keys = [String(frontmatter.keys)];
    } else {
        keys = [];
    }

    const title = extractTitle(body, file.filename);
    const links = extractWikiLinks(body);
    const content = cleanContent(body);
    const priorityCoerced = coerceNumber(frontmatter.priority, 'priority', warnings, lenient);
    const priority = priorityCoerced.value !== null ? priorityCoerced.value : 100;

    const constantTagToMatch = tagConfig.constantTag ? tagConfig.constantTag.toLowerCase() : '';
    const constant = frontmatter.constant === true || (constantTagToMatch && tags.includes(constantTagToMatch));

    const seedTagToMatch = tagConfig.seedTag ? tagConfig.seedTag.toLowerCase() : '';
    const seed = !!(seedTagToMatch && tags.includes(seedTagToMatch));

    const bootstrapTagToMatch = tagConfig.bootstrapTag ? tagConfig.bootstrapTag.toLowerCase() : '';
    const bootstrap = !!(bootstrapTagToMatch && tags.includes(bootstrapTagToMatch));

    // Librarian-only guide flag (filtered out of every writing-AI path; only Emma's tools see these)
    const guide = hasGuideTag;

    const scanDepth = typeof frontmatter.scanDepth === 'number' ? frontmatter.scanDepth : null;
    const excludeRecursion = frontmatter.excludeRecursion === true;

    // Conditional gating
    // Helper: normalize a frontmatter field that should be an array but may be a scalar string in YAML
    const toArray = v => Array.isArray(v) ? v.map(r => String(r).trim()).filter(Boolean)
        : (v ? [String(v).trim()].filter(Boolean) : []);

    const requires = toArray(frontmatter.requires);
    const excludes = toArray(frontmatter.excludes);

    // Refine keys: require at least one to also match (AND_ANY mode)
    const refineKeys = toArray(frontmatter.refine_keys);

    // Cascade links: explicitly pull in linked entries when this entry matches
    const cascadeLinks = toArray(frontmatter.cascade_links);

    // Folder path for folder-based filtering (extracted from filename, not frontmatter)
    const folderPath = file.filename.includes('/') ? file.filename.split('/').slice(0, -1).join('/') : null;

    // Per-entry outlet (macro-based injection via {{outlet::name}})
    const outlet = typeof frontmatter.outlet === 'string' && frontmatter.outlet.trim()
        ? frontmatter.outlet.trim() : null;

    // Per-entry injection position overrides
    // BUG-093: position numbers still need a string→enum map (ST does not export
    // a public name resolver for positions); roles route through ST's helper.
    const positionMap = { before: 2, after: 0, in_chat: 1 };

    const injectionPosition = typeof frontmatter.position === 'string'
        ? (positionMap[frontmatter.position.toLowerCase()] ?? null) : null;
    // BUG-092: Clamp per-entry depth to MAX_INJECTION_DEPTH (10000) so a typo
    // like `depth: 50000` no longer makes the entry vanish silently.
    let injectionDepth = null;
    if (typeof frontmatter.depth === 'number' && Number.isFinite(frontmatter.depth)) {
        const d = frontmatter.depth;
        if (d < 0) {
            console.warn(`[DLE] entry "${file.filename}": depth ${d} < 0 — clamping to 0`);
            injectionDepth = 0;
        } else if (d > 10000) {
            console.warn(`[DLE] entry "${file.filename}": depth ${d} exceeds MAX_INJECTION_DEPTH (10000) — clamping`);
            injectionDepth = 10000;
        } else {
            injectionDepth = d;
        }
    }
    // BUG-094: Resolve role names through ST's helper (handles future role additions
    // without code changes here) instead of a static positional map.
    const injectionRole = typeof frontmatter.role === 'string'
        ? _resolveRoleByName(frontmatter.role) : null;

    // Per-entry cooldown and warmup (coerce string numbers in lenient mode)
    const cooldownCoerced = coerceNumber(frontmatter.cooldown, 'cooldown', warnings, lenient);
    const cooldown = cooldownCoerced.value !== null && cooldownCoerced.value > 0 ? cooldownCoerced.value : null;
    const warmupCoerced = coerceNumber(frontmatter.warmup, 'warmup', warnings, lenient);
    const warmup = warmupCoerced.value !== null && warmupCoerced.value > 0 ? warmupCoerced.value : null;

    // Per-entry probability (0.0-1.0), clamped to valid range
    const probabilityCoerced = coerceNumber(frontmatter.probability, 'probability', warnings, lenient);
    const probability = probabilityCoerced.value !== null
        ? Math.max(0, Math.min(1, probabilityCoerced.value))
        : null;

    // AI selection summary (dedicated frontmatter field, separate from injected content)
    // Coerce numeric summaries to string (YAML may parse "42" as a number)
    const summary = (typeof frontmatter.summary === 'string' || typeof frontmatter.summary === 'number')
        ? String(frontmatter.summary).trim() : '';

    // Custom fields extraction (driven by field definitions, replaces hardcoded era/location/sceneType/characterPresent)
    const customFields = extractCustomFields(frontmatter, fieldDefinitions || []);

    // C.3: Preserve WI import fields that DLE doesn't enforce yet. Round-trip-safe:
    // written by convertWiEntry, stored in customFields, flagged via W_NOT_IMPLEMENTED
    // so /dle-lint surfaces them. Covers BUG-047 (sticky), BUG-048 (delay), BUG-052
    // (group / group_weight).
    const WI_NOT_IMPLEMENTED_FIELDS = [
        { key: 'sticky', bug: 'BUG-047' },
        { key: 'delay', bug: 'BUG-048' },
        { key: 'group', bug: 'BUG-052' },
        { key: 'group_weight', bug: 'BUG-052' },
    ];
    for (const { key: fieldName, bug } of WI_NOT_IMPLEMENTED_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(frontmatter, fieldName)) {
            customFields[fieldName] = frontmatter[fieldName];
            warnings.push({
                code: 'W_NOT_IMPLEMENTED',
                severity: 'warn',
                field: fieldName,
                message: `Field '${fieldName}' preserved but not enforced yet (${bug}).`,
                suggestedFix: `Remove '${fieldName}' if you don't need it round-tripped.`,
            });
        }
    }

    // Preserve all tags except the lorebook/guide marker tags themselves
    const entryTags = tags.filter(t => t !== tagToMatch && t !== guideTagToMatch);

    return {
        filename: file.filename,
        title,
        keys,
        content,
        summary,
        priority,
        constant,
        seed,
        bootstrap,
        guide,
        tokenEstimate: 0,
        scanDepth,
        excludeRecursion,
        links,
        resolvedLinks: [],
        tags: entryTags,
        requires,
        excludes,
        refineKeys,
        cascadeLinks,
        outlet,
        injectionPosition,
        injectionDepth,
        injectionRole,
        cooldown,
        warmup,
        probability,
        folderPath,
        vaultSource: '',
        customFields,
        graph: frontmatter.graph !== false,
        _parserWarnings: warnings.length > 0 ? warnings : undefined,
    };
}

/**
 * Clear all DeepLore-managed extension prompts from the prompt dictionary.
 * @param {object} extensionPrompts - The extension_prompts dictionary
 * @param {string} promptTagPrefix - Prefix for prompt tags (e.g. 'deeplore_')
 * @param {string} promptTag - The main prompt tag (e.g. 'deeplore_enhanced')
 */
export function clearPrompts(extensionPrompts, promptTagPrefix, promptTag) {
    for (const key of Object.keys(extensionPrompts)) {
        if (key.startsWith(promptTagPrefix) || key === promptTag || key.startsWith('customWIOutlet_')) {
            delete extensionPrompts[key];
        }
    }
}
