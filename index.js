import {
    setExtensionPrompt,
    getRequestHeaders,
    saveSettingsDebounced,
    saveChatDebounced,
    sendMessageAsUser,
    Generate,
    generateQuietPrompt,
    amount_gen,
    main_api,
    chat,
    name2,
} from '../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { oai_settings } from '../../../openai.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';

const MODULE_NAME = 'deeplore_enhanced';
const PROMPT_TAG = 'deeplore_enhanced';
const PLUGIN_BASE = '/api/plugins/deeplore-enhanced';

const DEFAULT_AI_SYSTEM_PROMPT = `You are Claude Code. You are a lore librarian for a roleplay session. Given recent chat messages and a manifest of available lore entries, identify which entries are relevant to the current conversation.

Selection criteria (in order of importance):
1. Direct references - Characters, places, items, or events explicitly mentioned
2. Active context - Entries about the current location, present characters, or ongoing events
3. Relationship chains - If entry A is relevant and links to entry B, consider B as well
4. Thematic relevance - Entries that match the tone or themes of the conversation (betrayal, romance, combat, etc.)

Guidelines:
- Prefer fewer, highly relevant entries over many loosely related ones
- Consider the token cost shown for each entry when making selections
- Entries marked "Links to:" indicate relationships; use these to find connected lore

Respond with a JSON array of objects. Each object has:
- "title": exact entry title from the manifest
- "confidence": "high", "medium", or "low"
- "reason": brief phrase explaining why (e.g. "directly mentioned", "location of current scene", "linked from Eris entry")

Example: [{"title": "Eris", "confidence": "high", "reason": "directly mentioned by name"}, {"title": "The Dark Council", "confidence": "medium", "reason": "linked from Eris, thematically relevant"}]
If no entries are relevant, respond with: []`;

// ============================================================================
// Settings
// ============================================================================

const defaultSettings = {
    enabled: false,
    obsidianPort: 27123,
    obsidianApiKey: '',
    lorebookTag: 'lorebook',
    constantTag: 'lorebook-always',
    neverInsertTag: 'lorebook-never',
    scanDepth: 4,
    maxEntries: 10,
    unlimitedEntries: true,
    maxTokensBudget: 2048,
    unlimitedBudget: true,
    injectionPosition: 1,   // extension_prompt_types.IN_CHAT
    injectionDepth: 4,
    injectionRole: 0,        // extension_prompt_roles.SYSTEM
    injectionTemplate: '<{{title}}>\n{{content}}\n</{{title}}>',
    allowWIScan: false,
    recursiveScan: false,
    maxRecursionSteps: 3,
    matchWholeWords: false,
    caseSensitive: false,
    cacheTTL: 300,
    reviewResponseTokens: 0,
    debugMode: false,
    // AI Search settings
    aiSearchEnabled: false,
    aiSearchProxyUrl: 'http://localhost:42069',
    aiSearchModel: 'claude-haiku-4-5-20251001',
    aiSearchMaxTokens: 1024,
    aiSearchTimeout: 10000,
    aiSearchPriorityOffset: 50,
    aiSearchScanDepth: 4,
    aiSearchSystemPrompt: '',
    aiSearchManifestSummaryLength: 400,
    // Context Cartographer settings
    showLoreSources: true,
    obsidianVaultName: '',
    // Session Scribe settings
    scribeEnabled: false,
    scribeInterval: 5,
    scribeFolder: 'Sessions',
    scribePrompt: '',
};

/** Validation constraints for numeric settings */
const settingsConstraints = {
    obsidianPort: { min: 1, max: 65535 },
    scanDepth: { min: 1, max: 100 },
    maxEntries: { min: 1, max: 100 },
    maxTokensBudget: { min: 100, max: 100000 },
    injectionDepth: { min: 0, max: 9999 },
    maxRecursionSteps: { min: 1, max: 10 },
    cacheTTL: { min: 0, max: 86400 },
    reviewResponseTokens: { min: 0, max: 100000 },
    aiSearchMaxTokens: { min: 64, max: 4096 },
    aiSearchTimeout: { min: 1000, max: 30000 },
    aiSearchPriorityOffset: { min: 0, max: 1000 },
    aiSearchScanDepth: { min: 1, max: 100 },
    aiSearchManifestSummaryLength: { min: 100, max: 800 },
    scribeInterval: { min: 1, max: 50 },
};

/**
 * Validate and clamp settings to their allowed ranges.
 * @param {object} settings
 */
function validateSettings(settings) {
    for (const [key, { min, max }] of Object.entries(settingsConstraints)) {
        if (typeof settings[key] === 'number') {
            settings[key] = Math.max(min, Math.min(max, Math.round(settings[key])));
        }
    }
    // Ensure tags are trimmed strings
    if (typeof settings.lorebookTag === 'string') {
        settings.lorebookTag = settings.lorebookTag.trim() || 'lorebook';
    }
}

/** @returns {typeof defaultSettings} */
function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    // Fill in any missing defaults
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    validateSettings(extension_settings[MODULE_NAME]);
    return extension_settings[MODULE_NAME];
}

// ============================================================================
// Vault Index Cache
// ============================================================================

/**
 * @typedef {object} VaultEntry
 * @property {string} filename - Full path in vault
 * @property {string} title - Display title (from H1 or filename)
 * @property {string[]} keys - Trigger keywords from frontmatter
 * @property {string} content - Cleaned markdown content (frontmatter stripped)
 * @property {number} priority - Sort priority (lower = higher priority)
 * @property {boolean} constant - Always inject regardless of keywords
 * @property {number} tokenEstimate - Rough token count estimate
 * @property {number|null} scanDepth - Per-entry scan depth override (null = use global)
 * @property {boolean} excludeRecursion - Don't scan this entry's content during recursion
 * @property {string[]} links - Wiki-link targets extracted before cleaning
 * @property {string[]} resolvedLinks - Links confirmed to match existing entry titles
 * @property {string[]} tags - All Obsidian tags (excluding the lorebook marker tag)
 */

/** @type {VaultEntry[]} */
let vaultIndex = [];
let indexTimestamp = 0;
let indexing = false;

/** Cached compact manifest for AI search */
let cachedManifest = '';

/** Cached manifest header with entry count and budget info */
let cachedManifestHeader = '';

/** AI search result cache to avoid redundant API calls */
let aiSearchCache = { hash: '', results: [] };

/** Session-scoped AI search usage stats */
let aiSearchStats = { calls: 0, cachedHits: 0, totalInputTokens: 0, totalOutputTokens: 0 };

/** Context Cartographer: sources from the last generation interceptor run */
let lastInjectionSources = null;

/** Session Scribe: counter and lock */
let messagesSinceLastScribe = 0;
let scribeInProgress = false;

/**
 * Parse simple YAML frontmatter from markdown content.
 * Handles basic key-value pairs and arrays (indented with - ).
 * @param {string} content - Raw markdown content
 * @returns {{ frontmatter: object, body: string }}
 */
function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return { frontmatter: {}, body: content };
    }

    const yamlText = match[1];
    const body = match[2];
    const frontmatter = {};
    let currentKey = null;
    let currentArray = null;

    for (const line of yamlText.split('\n')) {
        const trimmed = line.trimEnd();

        // Array item: "  - value"
        if (/^\s+-\s+/.test(trimmed) && currentKey) {
            const value = trimmed.replace(/^\s+-\s+/, '').trim();
            if (!currentArray) {
                currentArray = [];
                frontmatter[currentKey] = currentArray;
            }
            currentArray.push(value);
            continue;
        }

        // Key-value pair: "key: value" or "key:"
        const kvMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)/);
        if (kvMatch) {
            currentKey = kvMatch[1];
            const rawValue = kvMatch[2].trim();
            currentArray = null;

            if (rawValue === '' || rawValue === '[]') {
                // Value will come as array items on next lines, or is empty
                frontmatter[currentKey] = [];
                currentArray = frontmatter[currentKey];
            } else if (rawValue === 'true') {
                frontmatter[currentKey] = true;
            } else if (rawValue === 'false') {
                frontmatter[currentKey] = false;
            } else if (/^\d+$/.test(rawValue)) {
                frontmatter[currentKey] = parseInt(rawValue, 10);
            } else {
                // Strip surrounding quotes if present
                frontmatter[currentKey] = rawValue.replace(/^['"]|['"]$/g, '');
            }
        }
    }

    return { frontmatter, body };
}

/**
 * Extract wiki-link targets from raw markdown body before cleaning.
 * Handles [[Target]] and [[Target|Display]] forms.
 * Excludes image embeds (![[...]]).
 * @param {string} body - Raw markdown body (before cleanContent)
 * @returns {string[]} Deduplicated array of link target page names
 */
function extractWikiLinks(body) {
    const links = new Set();
    const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = regex.exec(body)) !== null) {
        // Skip image embeds (prefixed with !)
        if (match.index > 0 && body[match.index - 1] === '!') continue;
        links.add(match[1].trim());
    }
    return [...links];
}

/**
 * Clean markdown content for prompt injection.
 * @param {string} content - Raw markdown body (frontmatter already stripped)
 * @returns {string} Cleaned content
 */
function cleanContent(content) {
    let cleaned = content;

    // Strip image embeds: ![[image.png]] or ![alt](url)
    cleaned = cleaned.replace(/!\[\[.*?\]\]/g, '');
    cleaned = cleaned.replace(/!\[.*?\]\(.*?\)/g, '');

    // Convert wiki links: [[Link|Display]] -> Display, [[Link]] -> Link
    cleaned = cleaned.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
    cleaned = cleaned.replace(/\[\[([^\]]+)\]\]/g, '$1');

    // Collapse excessive blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
}

/**
 * Extract title from markdown content.
 * @param {string} body - Markdown body
 * @param {string} filename - Fallback filename
 * @returns {string}
 */
function extractTitle(body, filename) {
    const h1Match = body.match(/^#\s+(.+)$/m);
    if (h1Match) {
        return h1Match[1].trim();
    }
    // Fallback: filename without extension and path
    const parts = filename.split('/');
    const name = parts[parts.length - 1];
    return name.replace(/\.md$/, '');
}

/**
 * Build a compact manifest of vault entries for AI search.
 * Called after buildIndex() updates the vault index.
 */
function truncateToSentence(text, maxLen) {
    if (text.length <= maxLen) return text;
    const truncated = text.substring(0, maxLen);
    // Find the last sentence boundary (., !, ?) before the limit
    const lastSentence = truncated.search(/[.!?][^.!?]*$/);
    if (lastSentence > maxLen * 0.4) {
        return truncated.substring(0, lastSentence + 1);
    }
    // No good sentence boundary found; fall back to hard cut with ellipsis
    return truncated.trimEnd() + '...';
}

/**
 * Resolve raw wiki-link targets to confirmed entry titles in the vault index.
 * Must be called after vaultIndex is fully populated.
 */
function resolveLinks() {
    const titleMap = new Map(vaultIndex.map(e => [e.title.toLowerCase(), e.title]));
    for (const entry of vaultIndex) {
        entry.resolvedLinks = entry.links
            .map(l => titleMap.get(l.toLowerCase()))
            .filter(Boolean);
    }
}

function buildManifest() {
    const settings = getSettings();
    const summaryLen = settings.aiSearchManifestSummaryLength || 400;

    const entries = vaultIndex
        .filter(e => !e.constant) // Constants are always injected, no need for AI to pick them
        .map(entry => {
            const flat = entry.content.replace(/\n+/g, ' ').trim();
            const summary = truncateToSentence(flat, summaryLen);
            const parts = [`Title: ${entry.title}`];

            if (entry.keys.length > 0) {
                parts.push(`Keys: ${entry.keys.join(', ')}`);
            }
            if (entry.tags && entry.tags.length > 0) {
                parts.push(`Tags: ${entry.tags.join(', ')}`);
            }
            if (entry.resolvedLinks && entry.resolvedLinks.length > 0) {
                parts.push(`Links to: ${entry.resolvedLinks.join(', ')}`);
            }
            parts.push(`Tokens: ~${entry.tokenEstimate}`);
            parts.push(`Summary: ${summary}`);

            return parts.join('\n');
        })
        .join('\n---\n');

    cachedManifest = entries;

    // Build header with metadata the AI can use for context
    const constantCount = vaultIndex.filter(e => e.constant).length;
    const constantTokens = vaultIndex.filter(e => e.constant).reduce((s, e) => s + e.tokenEstimate, 0);
    const budgetInfo = settings.unlimitedBudget
        ? ''
        : `\nToken budget: ~${settings.maxTokensBudget} tokens total.`;

    cachedManifestHeader = `Entry count: ${vaultIndex.filter(e => !e.constant).length} selectable entries.`
        + (constantCount > 0 ? `\n${constantCount} entries are always included (~${constantTokens} tokens).` : '')
        + budgetInfo;

    // Invalidate AI search cache when manifest changes
    aiSearchCache = { hash: '', results: [] };
}

/**
 * Build the vault index by fetching all files from the server plugin.
 */
async function buildIndex() {
    const settings = getSettings();

    if (indexing) {
        console.debug('[DLE] Index build already in progress');
        return;
    }

    indexing = true;

    try {
        const response = await fetch(`${PLUGIN_BASE}/index`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                port: settings.obsidianPort,
                apiKey: settings.obsidianApiKey,
            }),
        });

        if (!response.ok) {
            throw new Error(`Server plugin returned HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data.files || !Array.isArray(data.files)) {
            throw new Error('Invalid response from server plugin');
        }

        const entries = [];
        const tagToMatch = settings.lorebookTag.toLowerCase();
        const constantTagToMatch = settings.constantTag ? settings.constantTag.toLowerCase() : '';
        const neverInsertTagToMatch = settings.neverInsertTag ? settings.neverInsertTag.toLowerCase() : '';

        for (const file of data.files) {
            const { frontmatter, body } = parseFrontmatter(file.content);

            // Check if this file has the lorebook tag
            const tags = Array.isArray(frontmatter.tags)
                ? frontmatter.tags.map(t => String(t).toLowerCase())
                : [];

            if (!tags.includes(tagToMatch)) {
                continue;
            }

            // Skip entries explicitly disabled via frontmatter
            if (frontmatter.enabled === false) {
                continue;
            }

            // Skip entries with the never-insert tag
            if (neverInsertTagToMatch && tags.includes(neverInsertTagToMatch)) {
                continue;
            }

            // Extract keys
            const keys = Array.isArray(frontmatter.keys)
                ? frontmatter.keys.map(k => String(k))
                : [];

            const title = extractTitle(body, file.filename);
            const links = extractWikiLinks(body);
            const content = cleanContent(body);
            const priority = typeof frontmatter.priority === 'number' ? frontmatter.priority : 100;
            const constant = frontmatter.constant === true || (constantTagToMatch && tags.includes(constantTagToMatch));
            const scanDepth = typeof frontmatter.scanDepth === 'number' ? frontmatter.scanDepth : null;
            const excludeRecursion = frontmatter.excludeRecursion === true;

            // Preserve all tags except the lorebook marker tag itself
            const entryTags = tags.filter(t => t !== tagToMatch);

            entries.push({
                filename: file.filename,
                title,
                keys,
                content,
                priority,
                constant,
                tokenEstimate: 0,
                scanDepth,
                excludeRecursion,
                links,
                resolvedLinks: [],
                tags: entryTags,
            });
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

        vaultIndex = entries;
        indexTimestamp = Date.now();

        // Resolve wiki-links to confirmed entry titles
        resolveLinks();

        // Build manifest for AI search
        buildManifest();

        console.log(`[DLE] Indexed ${entries.length} entries from ${data.total} vault files`);
        updateIndexStats();
    } catch (err) {
        console.error('[DLE] Failed to build index:', err);
        toastr.error(String(err), 'DeepLore Enhanced', { preventDuplicates: true });
    } finally {
        indexing = false;
    }
}

/**
 * Get the max response token length from the current connection profile.
 * @returns {number}
 */
function getMaxResponseTokens() {
    return main_api === 'openai' ? oai_settings.openai_max_tokens : amount_gen;
}

/**
 * Ensure the vault index is fresh, rebuilding if cache has expired.
 */
async function ensureIndexFresh() {
    const settings = getSettings();
    const ttlMs = settings.cacheTTL * 1000;
    const now = Date.now();

    if (vaultIndex.length === 0 || (ttlMs > 0 && now - indexTimestamp > ttlMs)) {
        await buildIndex();
    }
}

// ============================================================================
// Keyword Matching
// ============================================================================

/**
 * Escape a string for use in a regex.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build scan text from chat messages.
 * @param {object[]} chat - Chat messages array
 * @param {number} depth - Number of recent messages to scan
 * @returns {string}
 */
function buildScanText(chat, depth) {
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages
        .map(m => `${m.name || ''}: ${m.mes || ''}`)
        .join('\n');
}

/**
 * Build annotated chat context for AI search.
 * Marks speakers as (user) or (character) to clarify conversation roles.
 * @param {object[]} chat - Chat messages array
 * @param {number} depth - Number of recent messages to scan
 * @returns {string}
 */
function buildAiChatContext(chat, depth) {
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages
        .map(m => {
            const speaker = m.name || 'Unknown';
            const role = m.is_user ? '(user)' : '(character)';
            return `${speaker} ${role}: ${m.mes || ''}`;
        })
        .join('\n');
}

/**
 * Test if an entry's keys match against the given text.
 * @param {VaultEntry} entry
 * @param {string} scanText
 * @param {typeof defaultSettings} settings
 * @returns {string|null} The matched key, or null if no match
 */
function testEntryMatch(entry, scanText, settings) {
    if (entry.keys.length === 0) return null;

    const haystack = settings.caseSensitive ? scanText : scanText.toLowerCase();

    for (const rawKey of entry.keys) {
        const key = settings.caseSensitive ? rawKey : rawKey.toLowerCase();

        if (settings.matchWholeWords) {
            const regex = new RegExp(`\\b${escapeRegex(key)}\\b`, settings.caseSensitive ? '' : 'i');
            if (regex.test(scanText)) return rawKey;
        } else {
            if (haystack.includes(key)) return rawKey;
        }
    }
    return null;
}

/**
 * Match vault entries against chat messages, with recursive scanning support.
 * @param {object[]} chat - Chat messages array
 * @returns {{ matched: VaultEntry[], matchedKeys: Map<string, string> }} Matched entries sorted by priority, and which key matched each
 */
function matchEntries(chat) {
    const settings = getSettings();
    const globalScanText = buildScanText(chat, settings.scanDepth);
    /** @type {Set<VaultEntry>} */
    const matchedSet = new Set();
    /** @type {Map<string, string>} entry title -> matched key */
    const matchedKeys = new Map();

    // Initial scan pass
    for (const entry of vaultIndex) {
        if (entry.constant) {
            matchedSet.add(entry);
            matchedKeys.set(entry.title, '(constant)');
            continue;
        }

        // Use per-entry scan depth if set, otherwise use global scan text
        const scanText = entry.scanDepth !== null
            ? buildScanText(chat, entry.scanDepth)
            : globalScanText;

        const key = testEntryMatch(entry, scanText, settings);
        if (key) {
            matchedSet.add(entry);
            matchedKeys.set(entry.title, key);
        }
    }

    // Recursive scanning: scan matched entry content for more matches
    if (settings.recursiveScan && settings.maxRecursionSteps > 0) {
        let step = 0;
        /** @type {Set<VaultEntry>} Entries added in the previous step (seed with initial matches) */
        let newlyMatched = new Set(matchedSet);

        while (newlyMatched.size > 0 && step < settings.maxRecursionSteps) {
            step++;

            // Only scan content from entries added in the previous step
            const recursionText = [...newlyMatched]
                .filter(e => !e.excludeRecursion)
                .map(e => e.content)
                .join('\n');

            if (!recursionText.trim()) break;

            newlyMatched = new Set();

            for (const entry of vaultIndex) {
                if (matchedSet.has(entry)) continue;
                if (entry.constant) continue; // Already added

                const key = testEntryMatch(entry, recursionText, settings);
                if (key) {
                    matchedSet.add(entry);
                    newlyMatched.add(entry);
                    matchedKeys.set(entry.title, `${key} (recursion step ${step})`);
                }
            }
        }
    }

    // Sort by priority (ascending - lower number = higher priority)
    const matched = [...matchedSet].sort((a, b) => a.priority - b.priority);

    return { matched, matchedKeys };
}

// ============================================================================
// AI Search
// ============================================================================

/**
 * Compute a simple hash for cache comparison.
 * @param {string} text
 * @returns {string}
 */
function simpleHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32-bit integer
    }
    return `${text.length}:${hash}`;
}

/**
 * @typedef {object} AiSearchMatch
 * @property {VaultEntry} entry
 * @property {string} confidence - "high", "medium", or "low"
 * @property {string} reason - Brief explanation
 */

/**
 * Perform AI-powered semantic search using Claude Haiku via the proxy.
 * @param {object[]} chat - Chat messages array
 * @returns {Promise<AiSearchMatch[]>} Matched entries with confidence and reason
 */
async function aiSearch(chat) {
    const settings = getSettings();

    if (!settings.aiSearchEnabled || !cachedManifest) {
        return [];
    }

    const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);
    if (!chatContext.trim()) return [];

    // Check cache - skip API call if chat context hasn't changed
    const cacheKey = simpleHash(chatContext + cachedManifest);
    if (cacheKey === aiSearchCache.hash && aiSearchCache.results.length >= 0) {
        aiSearchStats.cachedHits++;
        updateAiStats();
        if (settings.debugMode) {
            console.debug('[DLE] AI search cache hit, skipping API call');
        }
        return aiSearchCache.results;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), settings.aiSearchTimeout);

        const response = await fetch(`${PLUGIN_BASE}/ai-search`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                manifest: cachedManifest,
                manifestHeader: cachedManifestHeader,
                chatContext: chatContext,
                proxyUrl: settings.aiSearchProxyUrl,
                model: settings.aiSearchModel,
                maxTokens: settings.aiSearchMaxTokens,
                systemPrompt: settings.aiSearchSystemPrompt,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.warn('[DLE] AI search server error:', response.status);
            return [];
        }

        const data = await response.json();

        // Track usage
        aiSearchStats.calls++;
        if (data.usage) {
            aiSearchStats.totalInputTokens += data.usage.input_tokens || 0;
            aiSearchStats.totalOutputTokens += data.usage.output_tokens || 0;
        }
        updateAiStats();

        // Handle new structured format (data.results) with backward compat (data.titles)
        let aiResults;
        if (data.ok && Array.isArray(data.results)) {
            aiResults = data.results;
        } else if (data.ok && Array.isArray(data.titles)) {
            // Legacy server response — normalize to structured format
            aiResults = data.titles.map(t => ({ title: t, confidence: 'medium', reason: 'AI search' }));
        } else {
            if (settings.debugMode) {
                console.warn('[DLE] AI search returned error:', data.error || 'unknown');
            }
            return [];
        }

        // Map returned results back to VaultEntry objects with confidence/reason
        const aiResultMap = new Map();
        for (const r of aiResults) {
            aiResultMap.set(r.title.toLowerCase(), r);
        }

        /** @type {AiSearchMatch[]} */
        const results = [];
        for (const entry of vaultIndex) {
            const aiResult = aiResultMap.get(entry.title.toLowerCase());
            if (aiResult) {
                results.push({
                    entry,
                    confidence: aiResult.confidence || 'medium',
                    reason: aiResult.reason || 'AI search',
                });
            }
        }

        // Cache the results
        aiSearchCache = { hash: cacheKey, results };

        if (settings.debugMode) {
            console.log(`[DLE] AI search found ${aiResults.length} titles, matched ${results.length} entries`);
            console.table(results.map(r => ({
                title: r.entry.title,
                confidence: r.confidence,
                reason: r.reason,
            })));
        }

        return results;
    } catch (err) {
        if (err.name === 'AbortError') {
            console.warn('[DLE] AI search timed out');
        } else {
            console.error('[DLE] AI search error:', err);
        }
        return [];
    }
}

/**
 * Merge keyword matching results with AI search results.
 * Uses confidence levels to adjust AI entry priority offsets:
 * - high: offset × 0 (treated same as keyword matches)
 * - medium: offset × 1 (default behavior)
 * - low: offset × 2 (pushed further down)
 * @param {{ matched: VaultEntry[], matchedKeys: Map<string, string> }} keywordResult
 * @param {AiSearchMatch[]} aiResults
 * @param {typeof defaultSettings} settings
 * @returns {{ merged: VaultEntry[], matchedKeys: Map<string, string> }}
 */
function mergeResults(keywordResult, aiResults, settings) {
    const { matched: keywordMatched, matchedKeys } = keywordResult;
    const keywordTitles = new Set(keywordMatched.map(e => e.title));

    // AI-only results (not already found by keyword matching)
    const aiOnly = aiResults.filter(r => !keywordTitles.has(r.entry.title));

    // Tag AI-only entries in matchedKeys with their reason and confidence
    for (const r of aiOnly) {
        matchedKeys.set(r.entry.title, `AI: ${r.reason} (${r.confidence})`);
    }

    // For entries found by BOTH keywords and AI, enrich the matchedKeys info
    for (const r of aiResults) {
        if (keywordTitles.has(r.entry.title)) {
            const existing = matchedKeys.get(r.entry.title);
            matchedKeys.set(r.entry.title, `${existing} + AI: ${r.reason}`);
        }
    }

    // Confidence-based priority offset: high=0×, medium=1×, low=2×
    const confidenceMultiplier = { high: 0, medium: 1, low: 2 };

    // Build combined array with effective priority
    const combined = [
        ...keywordMatched.map(e => ({ entry: e, effectivePriority: e.priority })),
        ...aiOnly.map(r => ({
            entry: r.entry,
            effectivePriority: r.entry.priority + settings.aiSearchPriorityOffset * (confidenceMultiplier[r.confidence] ?? 1),
        })),
    ];

    // Sort by effective priority (ascending - lower = higher priority)
    combined.sort((a, b) => a.effectivePriority - b.effectivePriority);

    return { merged: combined.map(c => c.entry), matchedKeys };
}

/**
 * Format matched entries for injection, respecting budget limits.
 * @param {VaultEntry[]} entries - Matched entries sorted by priority
 * @returns {{ text: string, count: number, totalTokens: number }} Injection text and stats
 */
function formatWithBudget(entries) {
    const settings = getSettings();
    const template = settings.injectionTemplate || '<{{title}}>\n{{content}}\n</{{title}}>';
    const parts = [];
    let totalTokens = 0;
    let count = 0;

    for (const entry of entries) {
        if (!settings.unlimitedEntries && count >= settings.maxEntries) break;
        if (!settings.unlimitedBudget && totalTokens + entry.tokenEstimate > settings.maxTokensBudget && count > 0) break;

        const text = template
            .replace(/\{\{title\}\}/g, entry.title)
            .replace(/\{\{content\}\}/g, entry.content);

        parts.push(text);
        totalTokens += entry.tokenEstimate;
        count++;
    }

    return { text: parts.join('\n\n'), count, totalTokens };
}

// ============================================================================
// Generation Interceptor
// ============================================================================

/** Track last warning ratio to avoid spamming toasts */
let lastWarningRatio = 0;

/**
 * Called by SillyTavern's generation interceptor system.
 * @param {object[]} chat - Array of chat messages
 * @param {number} contextSize - Context size
 * @param {function} abort - Abort callback
 * @param {string} type - Generation type
 */
async function onGenerate(chat, contextSize, abort, type) {
    const settings = getSettings();

    // Clear stale source data from any previous generation
    lastInjectionSources = null;

    if (type === 'quiet' || !settings.enabled) {
        return;
    }

    // Clear previous injection
    setExtensionPrompt(PROMPT_TAG, '', settings.injectionPosition, settings.injectionDepth, false, settings.injectionRole);

    try {
        // Ensure index is fresh
        await ensureIndexFresh();

        if (vaultIndex.length === 0) {
            if (settings.debugMode) {
                console.debug('[DLE] No entries indexed, skipping');
            }
            return;
        }

        // Check scan text exists
        const scanText = buildScanText(chat, settings.scanDepth);
        if (!scanText.trim()) {
            return;
        }

        // Run keyword matching and AI search in parallel
        const [keywordResult, aiEntries] = await Promise.all([
            Promise.resolve(matchEntries(chat)),
            aiSearch(chat),
        ]);

        // Merge results
        const { merged, matchedKeys } = mergeResults(keywordResult, aiEntries, settings);

        if (merged.length === 0) {
            if (settings.debugMode) {
                console.debug('[DLE] No entries matched (keyword + AI)');
            }
            return;
        }

        // Format with budget
        const { text: injectionText, count: injectedCount, totalTokens } = formatWithBudget(merged);

        if (injectionText) {
            setExtensionPrompt(
                PROMPT_TAG,
                injectionText,
                settings.injectionPosition,
                settings.injectionDepth,
                settings.allowWIScan,
                settings.injectionRole,
            );

            // Capture injection sources for Context Cartographer
            lastInjectionSources = merged.slice(0, injectedCount).map(e => ({
                title: e.title,
                filename: e.filename,
                matchedBy: matchedKeys.get(e.title) || '?',
                priority: e.priority,
                tokens: e.tokenEstimate,
            }));

            // Context usage warning
            if (contextSize > 0) {
                const ratio = totalTokens / contextSize;
                if (ratio > 0.20 && ratio > lastWarningRatio + 0.05) {
                    const pct = Math.round(ratio * 100);
                    toastr.warning(
                        `${injectedCount} entries injected (~${totalTokens} tokens, ${pct}% of context). Consider setting a token budget.`,
                        'DeepLore Enhanced',
                        { preventDuplicates: true, timeOut: 8000 },
                    );
                    lastWarningRatio = ratio;
                }
            }

            if (settings.debugMode) {
                const aiCount = aiEntries.length;
                const kwCount = keywordResult.matched.length;
                console.log(`[DLE] ${merged.length} total (${kwCount} keyword, ${aiCount} AI), ${injectedCount} injected, ~${totalTokens} tokens` +
                    (contextSize > 0 ? ` (${Math.round(totalTokens / contextSize * 100)}% of ${contextSize} context)` : ''));
                console.table(merged.slice(0, injectedCount).map(e => ({
                    title: e.title,
                    matchedBy: matchedKeys.get(e.title) || '?',
                    priority: e.priority,
                    tokens: e.tokenEstimate,
                    constant: e.constant,
                })));
            }
        }
    } catch (err) {
        console.error('[DLE] Error during generation:', err);
    }
}

// Register the interceptor on globalThis so SillyTavern can find it
globalThis.deepLoreEnhanced_onGenerate = onGenerate;

// ============================================================================
// Context Cartographer
// ============================================================================

/**
 * Build an obsidian:// URI to open a note in Obsidian.
 * @param {string} vaultName - Name of the Obsidian vault
 * @param {string} filename - File path within the vault
 * @returns {string|null} URI string, or null if vault name not configured
 */
function buildObsidianURI(vaultName, filename) {
    if (!vaultName) return null;
    const encodedVault = encodeURIComponent(vaultName);
    const encodedFile = filename.split('/').map(s => encodeURIComponent(s)).join('/');
    return `obsidian://open?vault=${encodedVault}&file=${encodedFile}`;
}

/**
 * Inject a "Lore Sources" button into a message's action bar.
 * @param {number} messageId - Index in the chat array
 */
function injectSourcesButton(messageId) {
    const mesEl = $(`.mes[mesid="${messageId}"]`);
    if (mesEl.length === 0) return;
    if (mesEl.find('.mes_deeplore_sources').length > 0) return;

    const btn = $('<div title="Lore Sources" class="mes_button mes_deeplore_sources fa-solid fa-book-open"></div>');
    mesEl.find('.extraMesButtons').prepend(btn);
}

/**
 * Show a popup with lore source details for a message.
 * @param {Array<{title: string, filename: string, matchedBy: string, priority: number, tokens: number}>} sources
 */
function showSourcesPopup(sources) {
    const settings = getSettings();
    const vaultName = settings.obsidianVaultName;
    const totalTokens = sources.reduce((sum, s) => sum + s.tokens, 0);

    let rows = '';
    for (const src of sources) {
        const uri = buildObsidianURI(vaultName, src.filename);
        const titleHtml = uri
            ? `<a href="${escapeHtml(uri)}" target="_blank" style="color: var(--SmartThemeQuoteColor, #aac8ff); text-decoration: none;">${escapeHtml(src.title)}</a>`
            : escapeHtml(src.title);

        rows += `<tr>
            <td style="padding: 4px 8px;">${titleHtml}</td>
            <td style="padding: 4px 8px; max-width: 280px; word-wrap: break-word;">${escapeHtml(src.matchedBy)}</td>
            <td style="padding: 4px 8px; text-align: center;">${src.priority}</td>
            <td style="padding: 4px 8px; text-align: right;">~${src.tokens}</td>
        </tr>`;
    }

    const html = `
        <div style="text-align: left;">
            <h3>Lore Sources (${sources.length} entries, ~${totalTokens} tokens)</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">
                <thead>
                    <tr style="border-bottom: 1px solid var(--SmartThemeBorderColor, #555);">
                        <th style="padding: 4px 8px; text-align: left;">Entry</th>
                        <th style="padding: 4px 8px; text-align: left;">Matched By</th>
                        <th style="padding: 4px 8px; text-align: center;">Priority</th>
                        <th style="padding: 4px 8px; text-align: right;">Tokens</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            ${vaultName ? '<p style="opacity: 0.6; font-size: 0.8em; margin-top: 8px;">Click entry names to open in Obsidian.</p>' : '<p style="opacity: 0.6; font-size: 0.8em; margin-top: 8px;">Set Obsidian Vault Name in settings to enable deep links.</p>'}
        </div>`;

    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
}

// ============================================================================
// Session Scribe
// ============================================================================

const DEFAULT_SCRIBE_PROMPT = 'Summarize the recent events in this roleplay session. Focus on:\n- New facts established about characters, locations, or items\n- Character relationship changes\n- Plot developments and decisions made\nFormat as concise bullet points under clear headings.';

/**
 * Run Session Scribe: summarize recent chat and write to Obsidian.
 * @param {string} [customPrompt] - Optional custom focus/question
 */
async function runScribe(customPrompt) {
    if (scribeInProgress) return;
    scribeInProgress = true;

    try {
        const settings = getSettings();
        if (!chat || chat.length === 0) {
            toastr.warning('No active chat to summarize.', 'DeepLore Enhanced');
            return;
        }

        // Build context from last 20 messages
        const contextMessages = chat.slice(-20);
        const context = contextMessages
            .map(m => `${m.name || 'Unknown'}: ${m.mes || ''}`)
            .join('\n');

        // Build prompt
        const basePrompt = settings.scribePrompt?.trim() || DEFAULT_SCRIBE_PROMPT;
        const customPart = customPrompt ? `\n\nAdditional focus: ${customPrompt}` : '';
        const quietPrompt = `Here is the recent conversation:\n\n${context}\n\n---\n\n${basePrompt}${customPart}`;

        // Generate summary silently
        const summary = await generateQuietPrompt({ quietPrompt, skipWIAN: true, responseLength: 512 });

        if (!summary || !summary.trim()) {
            toastr.warning('Scribe generated an empty summary.', 'DeepLore Enhanced');
            return;
        }

        // Build filename and content
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = now.toTimeString().slice(0, 5).replace(':', '-');
        const charName = name2 || 'Unknown';
        const filename = `${settings.scribeFolder}/${charName} - ${dateStr} ${timeStr}.md`;

        const noteContent = `---\ntags:\n  - lorebook-session\ndate: ${now.toISOString()}\ncharacter: ${charName}\n---\n# Session: ${charName} - ${dateStr} ${timeStr}\n\n${summary.trim()}\n`;

        // Write to Obsidian via server plugin
        const response = await fetch(`${PLUGIN_BASE}/write-note`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                port: settings.obsidianPort,
                apiKey: settings.obsidianApiKey,
                filename,
                content: noteContent,
            }),
        });

        const data = await response.json();

        if (data.ok) {
            toastr.success(`Session note saved: ${filename}`, 'DeepLore Enhanced', { timeOut: 5000 });
        } else {
            toastr.error(`Failed to save session note: ${data.error}`, 'DeepLore Enhanced');
        }
    } catch (err) {
        console.error('[DLE] Session Scribe error:', err);
        toastr.error(`Scribe error: ${err.message}`, 'DeepLore Enhanced');
    } finally {
        scribeInProgress = false;
    }
}

// ============================================================================
// UI & Settings Binding
// ============================================================================

function updateIndexStats() {
    const statsEl = document.getElementById('dle_index_stats');
    if (statsEl) {
        if (vaultIndex.length > 0) {
            const totalKeys = vaultIndex.reduce((sum, e) => sum + e.keys.length, 0);
            const constants = vaultIndex.filter(e => e.constant).length;
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            statsEl.textContent = `${vaultIndex.length} entries (${totalKeys} keywords, ${constants} always-send, ~${totalTokens} total tokens)`;
        } else {
            statsEl.textContent = 'No index loaded.';
        }
    }
}

function updateAiStats() {
    const statsEl = document.getElementById('dle_ai_stats');
    if (statsEl) {
        statsEl.textContent = `AI calls: ${aiSearchStats.calls} | Cache hits: ${aiSearchStats.cachedHits} | Tokens: ~${aiSearchStats.totalInputTokens} in / ~${aiSearchStats.totalOutputTokens} out`;
    }
}

function loadSettingsUI() {
    const settings = getSettings();

    $('#dle_enabled').prop('checked', settings.enabled);
    $('#dle_port').val(settings.obsidianPort);
    $('#dle_api_key').val(settings.obsidianApiKey);
    $('#dle_tag').val(settings.lorebookTag);
    $('#dle_constant_tag').val(settings.constantTag);
    $('#dle_never_insert_tag').val(settings.neverInsertTag);
    $('#dle_scan_depth').val(settings.scanDepth);
    $('#dle_max_entries').val(settings.maxEntries);
    $('#dle_unlimited_entries').prop('checked', settings.unlimitedEntries);
    $('#dle_max_entries').prop('disabled', settings.unlimitedEntries);
    $('#dle_token_budget').val(settings.maxTokensBudget);
    $('#dle_unlimited_budget').prop('checked', settings.unlimitedBudget);
    $('#dle_token_budget').prop('disabled', settings.unlimitedBudget);
    $('#dle_template').val(settings.injectionTemplate);
    $(`input[name="dle_position"][value="${settings.injectionPosition}"]`).prop('checked', true);
    $('#dle_depth').val(settings.injectionDepth);
    $('#dle_role').val(settings.injectionRole);
    $('#dle_allow_wi_scan').prop('checked', settings.allowWIScan);
    $('#dle_recursive_scan').prop('checked', settings.recursiveScan);
    $('#dle_max_recursion').val(settings.maxRecursionSteps);
    $('#dle_max_recursion').prop('disabled', !settings.recursiveScan);
    $('#dle_cache_ttl').val(settings.cacheTTL);
    $('#dle_review_tokens').val(settings.reviewResponseTokens);
    $('#dle_case_sensitive').prop('checked', settings.caseSensitive);
    $('#dle_match_whole_words').prop('checked', settings.matchWholeWords);
    $('#dle_debug').prop('checked', settings.debugMode);

    // AI Search settings
    $('#dle_ai_enabled').prop('checked', settings.aiSearchEnabled);
    $('#dle_ai_proxy_url').val(settings.aiSearchProxyUrl);
    $('#dle_ai_model').val(settings.aiSearchModel);
    $('#dle_ai_max_tokens').val(settings.aiSearchMaxTokens);
    $('#dle_ai_timeout').val(settings.aiSearchTimeout);
    $('#dle_ai_priority_offset').val(settings.aiSearchPriorityOffset);
    $('#dle_ai_scan_depth').val(settings.aiSearchScanDepth);
    $('#dle_ai_system_prompt').val(settings.aiSearchSystemPrompt);
    $('#dle_ai_summary_length').val(settings.aiSearchManifestSummaryLength);

    // Context Cartographer settings
    $('#dle_show_sources').prop('checked', settings.showLoreSources);
    $('#dle_vault_name').val(settings.obsidianVaultName);

    // Session Scribe settings
    $('#dle_scribe_enabled').prop('checked', settings.scribeEnabled);
    $('#dle_scribe_interval').val(settings.scribeInterval);
    $('#dle_scribe_folder').val(settings.scribeFolder);
    $('#dle_scribe_prompt').val(settings.scribePrompt);

    updateIndexStats();
    updateAiStats();
}

function bindSettingsEvents() {
    const settings = getSettings();

    $('#dle_enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#dle_port').on('input', function () {
        settings.obsidianPort = Number($(this).val()) || 27123;
        saveSettingsDebounced();
    });

    $('#dle_api_key').on('input', function () {
        settings.obsidianApiKey = String($(this).val());
        saveSettingsDebounced();
    });

    $('#dle_tag').on('input', function () {
        settings.lorebookTag = String($(this).val()).trim() || 'lorebook';
        saveSettingsDebounced();
    });

    $('#dle_constant_tag').on('input', function () {
        settings.constantTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#dle_never_insert_tag').on('input', function () {
        settings.neverInsertTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#dle_scan_depth').on('input', function () {
        settings.scanDepth = Number($(this).val()) || 4;
        saveSettingsDebounced();
    });

    $('#dle_max_entries').on('input', function () {
        settings.maxEntries = Number($(this).val()) || 10;
        saveSettingsDebounced();
    });

    $('#dle_unlimited_entries').on('change', function () {
        settings.unlimitedEntries = $(this).prop('checked');
        $('#dle_max_entries').prop('disabled', settings.unlimitedEntries);
        saveSettingsDebounced();
    });

    $('#dle_token_budget').on('input', function () {
        settings.maxTokensBudget = Number($(this).val()) || 2048;
        saveSettingsDebounced();
    });

    $('#dle_unlimited_budget').on('change', function () {
        settings.unlimitedBudget = $(this).prop('checked');
        $('#dle_token_budget').prop('disabled', settings.unlimitedBudget);
        saveSettingsDebounced();
    });

    $('#dle_template').on('input', function () {
        settings.injectionTemplate = String($(this).val());
        saveSettingsDebounced();
    });

    $('input[name="dle_position"]').on('change', function () {
        settings.injectionPosition = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#dle_depth').on('input', function () {
        settings.injectionDepth = Number($(this).val()) || 4;
        saveSettingsDebounced();
    });

    $('#dle_role').on('change', function () {
        settings.injectionRole = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#dle_allow_wi_scan').on('change', function () {
        settings.allowWIScan = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#dle_recursive_scan').on('change', function () {
        settings.recursiveScan = $(this).prop('checked');
        $('#dle_max_recursion').prop('disabled', !settings.recursiveScan);
        saveSettingsDebounced();
    });

    $('#dle_max_recursion').on('input', function () {
        settings.maxRecursionSteps = Number($(this).val()) || 3;
        saveSettingsDebounced();
    });

    $('#dle_cache_ttl').on('input', function () {
        settings.cacheTTL = Number($(this).val()) || 300;
        saveSettingsDebounced();
    });

    $('#dle_review_tokens').on('input', function () {
        settings.reviewResponseTokens = Number($(this).val()) || 0;
        saveSettingsDebounced();
    });

    $('#dle_case_sensitive').on('change', function () {
        settings.caseSensitive = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#dle_match_whole_words').on('change', function () {
        settings.matchWholeWords = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#dle_debug').on('change', function () {
        settings.debugMode = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // AI Search settings
    $('#dle_ai_enabled').on('change', function () {
        settings.aiSearchEnabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#dle_ai_proxy_url').on('input', function () {
        settings.aiSearchProxyUrl = String($(this).val()).trim() || 'http://localhost:42069';
        saveSettingsDebounced();
    });

    $('#dle_ai_model').on('input', function () {
        settings.aiSearchModel = String($(this).val()).trim() || 'claude-haiku-4-5-20251001';
        saveSettingsDebounced();
    });

    $('#dle_ai_max_tokens').on('input', function () {
        settings.aiSearchMaxTokens = Number($(this).val()) || 1024;
        saveSettingsDebounced();
    });

    $('#dle_ai_timeout').on('input', function () {
        settings.aiSearchTimeout = Number($(this).val()) || 10000;
        saveSettingsDebounced();
    });

    $('#dle_ai_priority_offset').on('input', function () {
        settings.aiSearchPriorityOffset = Number($(this).val()) || 0;
        saveSettingsDebounced();
    });

    $('#dle_ai_scan_depth').on('input', function () {
        settings.aiSearchScanDepth = Number($(this).val()) || 4;
        saveSettingsDebounced();
    });

    $('#dle_ai_system_prompt').on('input', function () {
        settings.aiSearchSystemPrompt = String($(this).val());
        saveSettingsDebounced();
    });

    $('#dle_ai_summary_length').on('input', function () {
        settings.aiSearchManifestSummaryLength = Number($(this).val()) || 400;
        saveSettingsDebounced();
    });

    // Context Cartographer settings
    $('#dle_show_sources').on('change', function () {
        settings.showLoreSources = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#dle_vault_name').on('input', function () {
        settings.obsidianVaultName = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    // Session Scribe settings
    $('#dle_scribe_enabled').on('change', function () {
        settings.scribeEnabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#dle_scribe_interval').on('input', function () {
        settings.scribeInterval = Number($(this).val()) || 5;
        saveSettingsDebounced();
    });

    $('#dle_scribe_folder').on('input', function () {
        settings.scribeFolder = String($(this).val()).trim() || 'Sessions';
        saveSettingsDebounced();
    });

    $('#dle_scribe_prompt').on('input', function () {
        settings.scribePrompt = String($(this).val());
        saveSettingsDebounced();
    });

    // Test Connection button
    $('#dle_test_connection').on('click', async function () {
        const statusEl = $('#dle_connection_status');
        statusEl.text('Testing...').removeClass('success failure');

        try {
            const response = await fetch(`${PLUGIN_BASE}/test`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    port: settings.obsidianPort,
                    apiKey: settings.obsidianApiKey,
                }),
            });

            const data = await response.json();

            if (data.ok) {
                const authStatus = data.authenticated ? 'authenticated' : 'not authenticated';
                statusEl.text(`Connected (${authStatus})`).addClass('success').removeClass('failure');
            } else {
                statusEl.text(`Failed: ${data.error}`).addClass('failure').removeClass('success');
            }
        } catch (err) {
            statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success');
        }
    });

    // Test AI Search button
    $('#dle_test_ai').on('click', async function () {
        const statusEl = $('#dle_ai_status');
        statusEl.text('Testing...').removeClass('success failure');

        try {
            const response = await fetch(`${PLUGIN_BASE}/ai-test`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    proxyUrl: settings.aiSearchProxyUrl,
                    model: settings.aiSearchModel,
                }),
            });

            const data = await response.json();

            if (data.ok) {
                statusEl.text('Connected').addClass('success').removeClass('failure');
            } else {
                statusEl.text(`Failed: ${data.error}`).addClass('failure').removeClass('success');
            }
        } catch (err) {
            statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success');
        }
    });

    // Preview AI Prompt button
    $('#dle_preview_ai').on('click', async function () {
        const settings = getSettings();

        if (!chat || chat.length === 0) {
            toastr.warning('No active chat. Start a conversation first.', 'DeepLore Enhanced');
            return;
        }

        if (!cachedManifest) {
            toastr.warning('No vault index. Click "Refresh Index" first.', 'DeepLore Enhanced');
            return;
        }

        // Build chat context (same as aiSearch)
        const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);

        // Resolve system prompt (same logic as server)
        let systemPrompt;
        if (settings.aiSearchSystemPrompt && settings.aiSearchSystemPrompt.trim()) {
            const userPrompt = settings.aiSearchSystemPrompt.trim();
            systemPrompt = userPrompt.startsWith('You are Claude Code')
                ? userPrompt
                : 'You are Claude Code. ' + userPrompt;
        } else {
            systemPrompt = DEFAULT_AI_SYSTEM_PROMPT;
        }

        // Build user message (same format as server)
        const userMessage = `## Recent Chat\n${chatContext}\n\n## Available Lore Entries\n${cachedManifest}\n\nWhich entries are relevant to the current conversation?`;

        // Build preview HTML
        const previewHtml = `
            <div style="text-align: left; font-family: monospace; font-size: 0.85em;">
                <h3>System Prompt</h3>
                <div style="background: var(--SmartThemeBlurTintColor, #1a1a2e); padding: 10px; border-radius: 5px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; margin-bottom: 15px;">${escapeHtml(systemPrompt)}</div>
                <h3>User Message</h3>
                <div style="background: var(--SmartThemeBlurTintColor, #1a1a2e); padding: 10px; border-radius: 5px; white-space: pre-wrap; max-height: 400px; overflow-y: auto;">${escapeHtml(userMessage)}</div>
            </div>
        `;

        callGenericPopup(previewHtml, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    });

    // Refresh Index button
    $('#dle_refresh').on('click', async function () {
        $('#dle_index_stats').text('Refreshing...');
        vaultIndex = [];
        indexTimestamp = 0;
        await buildIndex();
    });
}

// ============================================================================
// Slash Commands
// ============================================================================

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-refresh',
        callback: async () => {
            vaultIndex = [];
            indexTimestamp = 0;
            await buildIndex();
            const msg = `Indexed ${vaultIndex.length} entries.`;
            toastr.success(msg, 'DeepLore Enhanced');
            return msg;
        },
        helpString: 'Force refresh the DeepLore Enhanced vault index cache.',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-status',
        callback: async () => {
            const settings = getSettings();
            const constants = vaultIndex.filter(e => e.constant).length;
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            const lines = [
                `Enabled: ${settings.enabled}`,
                `Port: ${settings.obsidianPort}`,
                `Lorebook Tag: #${settings.lorebookTag}`,
                `Always-Send Tag: ${settings.constantTag ? '#' + settings.constantTag : '(none)'}`,
                `Never-Insert Tag: ${settings.neverInsertTag ? '#' + settings.neverInsertTag : '(none)'}`,
                `Entries: ${vaultIndex.length} (${constants} always-send, ~${totalTokens} tokens)`,
                `Budget: ${settings.unlimitedBudget ? 'unlimited' : settings.maxTokensBudget + ' tokens'}`,
                `Max Entries: ${settings.unlimitedEntries ? 'unlimited' : settings.maxEntries}`,
                `Recursive: ${settings.recursiveScan ? 'on (max ' + settings.maxRecursionSteps + ' steps)' : 'off'}`,
                `Cache: ${indexTimestamp ? Math.round((Date.now() - indexTimestamp) / 1000) + 's old' : 'none'} / TTL ${settings.cacheTTL}s`,
                `AI Search: ${settings.aiSearchEnabled ? 'on' : 'off'}`,
                `AI Stats: ${aiSearchStats.calls} calls, ${aiSearchStats.cachedHits} cache hits, ~${aiSearchStats.totalInputTokens} in / ~${aiSearchStats.totalOutputTokens} out tokens`,
            ];
            const msg = lines.join('\n');
            toastr.info(msg, 'DeepLore Enhanced', { timeOut: 10000 });
            return msg;
        },
        helpString: 'Show DeepLore Enhanced connection status and index stats.',
        returns: 'Status information',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-scribe',
        callback: async (_args, userPrompt) => {
            if (scribeInProgress) {
                toastr.warning('Session scribe already in progress.', 'DeepLore Enhanced');
                return '';
            }
            toastr.info('Writing session note...', 'DeepLore Enhanced');
            await runScribe(userPrompt?.trim() || '');
            return 'Session note written.';
        },
        helpString: 'Write a session summary to Obsidian. Optionally provide a focus topic, e.g. /dle-scribe What happened with the sword?',
        returns: 'Status message',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-review',
        callback: async (_args, userPrompt) => {
            await ensureIndexFresh();

            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed. Check your connection and lorebook tag settings.', 'DeepLore Enhanced');
                return '';
            }

            const loreDump = vaultIndex.map(entry => {
                return `## ${entry.title}\n${entry.content}`;
            }).join('\n\n---\n\n');

            const settings = getSettings();
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            const responseTokens = settings.reviewResponseTokens > 0
                ? settings.reviewResponseTokens
                : getMaxResponseTokens();
            const budgetHint = `\n\nKeep your response under ${responseTokens} tokens.`;
            const defaultQuestion = 'Review this lorebook/world-building vault. Comment on consistency, gaps, interesting connections between entries, and any suggestions for improvement.';
            const question = (userPrompt && userPrompt.trim()) ? userPrompt.trim() : defaultQuestion;

            const message = `[DeepLore Enhanced Review — ${vaultIndex.length} entries, ~${totalTokens} tokens]\n\n${loreDump}\n\n---\n\n${question}${budgetHint}`;
            if (settings.debugMode) {
                console.log('[DLE] Lore review prompt:', message);
            }

            toastr.info(`Sending ${vaultIndex.length} entries (~${totalTokens} tokens)...`, 'DeepLore Enhanced', { timeOut: 5000 });

            await sendMessageAsUser(message, '');
            await Generate('normal');

            return '';
        },
        helpString: 'Send the entire Obsidian vault to the AI for review. Optionally provide a custom question, e.g. /dle-review What inconsistencies do you see?',
        returns: 'AI review posted to chat',
    }));
}

// ============================================================================
// Initialization
// ============================================================================

jQuery(async function () {
    try {
        const settingsHtml = await renderExtensionTemplateAsync(
            'third-party/sillytavern-DeepLore-Enhanced',
            'settings',
        );
        $('#extensions_settings2').append(settingsHtml);

        loadSettingsUI();
        bindSettingsEvents();
        registerSlashCommands();

        // Context Cartographer: click handler (event delegation — registered once)
        $(document).on('click', '.mes_deeplore_sources', function () {
            const messageId = $(this).closest('.mes').attr('mesid');
            const message = chat[messageId];
            const sources = message?.extra?.deeplore_sources;
            if (!sources || sources.length === 0) return;
            showSourcesPopup(sources);
        });

        // Context Cartographer + Session Scribe: post-render handler
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
            const settings = getSettings();

            // --- Context Cartographer: store sources and inject button ---
            if (settings.showLoreSources && lastInjectionSources && lastInjectionSources.length > 0) {
                const message = chat[messageId];
                if (message && !message.is_user) {
                    message.extra = message.extra || {};
                    message.extra.deeplore_sources = lastInjectionSources;
                    lastInjectionSources = null;
                    saveChatDebounced();
                }
            }

            if (settings.showLoreSources) {
                injectSourcesButton(messageId);
            }

            // --- Session Scribe: count messages and auto-trigger ---
            if (settings.enabled && settings.scribeEnabled && settings.scribeInterval > 0) {
                messagesSinceLastScribe++;
                if (messagesSinceLastScribe >= settings.scribeInterval && !scribeInProgress) {
                    messagesSinceLastScribe = 0;
                    runScribe(); // fire-and-forget
                }
            }
        });

        // Context Cartographer: re-inject buttons on chat load
        eventSource.on(event_types.CHAT_CHANGED, () => {
            messagesSinceLastScribe = 0;
            setTimeout(() => {
                const settings = getSettings();
                if (!settings.showLoreSources) return;
                for (let i = 0; i < chat.length; i++) {
                    if (chat[i]?.extra?.deeplore_sources) {
                        injectSourcesButton(i);
                    }
                }
            }, 100);
        });

        console.log('[DLE] DeepLore Enhanced client extension initialized');
    } catch (err) {
        console.error('[DLE] Failed to initialize:', err);
    }
});
