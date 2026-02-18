import {
    setExtensionPrompt,
    getRequestHeaders,
    saveSettingsDebounced,
    sendMessageAsUser,
    Generate,
    amount_gen,
    main_api,
    chat,
} from '../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';

const MODULE_NAME = 'deeplore_enhanced';
const PROMPT_TAG = 'deeplore_enhanced';
const PLUGIN_BASE = '/api/plugins/deeplore-enhanced';

const DEFAULT_AI_SYSTEM_PROMPT = 'You are Claude Code. You are a lore librarian. Given recent chat messages and a manifest of available lore entries, identify which entries are relevant to the current conversation. Consider:\n- Direct references to characters, places, items, or events\n- Thematic relevance (e.g., a conversation about betrayal should surface entries about known traitors)\n- Implied context (e.g., if characters are in a location, surface entries about that location\'s history)\n\nRespond ONLY with a JSON array of entry titles. No explanation. Example: ["Entry One", "Entry Two"]\nIf no entries are relevant, respond with: []';

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
};

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
 */

/** @type {VaultEntry[]} */
let vaultIndex = [];
let indexTimestamp = 0;
let indexing = false;

/** Cached compact manifest for AI search */
let cachedManifest = '';

/** AI search result cache to avoid redundant API calls */
let aiSearchCache = { hash: '', results: [] };

/** Session-scoped AI search usage stats */
let aiSearchStats = { calls: 0, cachedHits: 0, totalInputTokens: 0, totalOutputTokens: 0 };

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
function buildManifest() {
    cachedManifest = vaultIndex
        .filter(e => !e.constant) // Constants are always injected, no need for AI to pick them
        .map(entry => {
            const summary = entry.content.substring(0, 200).replace(/\n+/g, ' ').trim();
            const keysStr = entry.keys.length > 0 ? `\nKeys: ${entry.keys.join(', ')}` : '';
            return `Title: ${entry.title}${keysStr}\nSummary: ${summary}`;
        })
        .join('\n---\n');

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
            const content = cleanContent(body);
            const priority = typeof frontmatter.priority === 'number' ? frontmatter.priority : 100;
            const constant = frontmatter.constant === true || (constantTagToMatch && tags.includes(constantTagToMatch));
            const scanDepth = typeof frontmatter.scanDepth === 'number' ? frontmatter.scanDepth : null;
            const excludeRecursion = frontmatter.excludeRecursion === true;

            entries.push({
                filename: file.filename,
                title,
                keys,
                content,
                priority,
                constant,
                tokenEstimate: Math.ceil(content.length / 3.5),
                scanDepth,
                excludeRecursion,
            });
        }

        vaultIndex = entries;
        indexTimestamp = Date.now();

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
        let newMatches = true;
        let step = 0;

        while (newMatches && step < settings.maxRecursionSteps) {
            newMatches = false;
            step++;

            // Build recursion scan text from all matched entries (that allow recursion)
            const recursionText = [...matchedSet]
                .filter(e => !e.excludeRecursion)
                .map(e => e.content)
                .join('\n');

            if (!recursionText.trim()) break;

            for (const entry of vaultIndex) {
                if (matchedSet.has(entry)) continue;
                if (entry.constant) continue; // Already added

                const key = testEntryMatch(entry, recursionText, settings);
                if (key) {
                    matchedSet.add(entry);
                    matchedKeys.set(entry.title, `${key} (recursion step ${step})`);
                    newMatches = true;
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
 * Perform AI-powered semantic search using Claude Haiku via the proxy.
 * @param {object[]} chat - Chat messages array
 * @returns {Promise<VaultEntry[]>} Matched entries from AI search
 */
async function aiSearch(chat) {
    const settings = getSettings();

    if (!settings.aiSearchEnabled || !cachedManifest) {
        return [];
    }

    const chatContext = buildScanText(chat, settings.aiSearchScanDepth);
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

        if (!data.ok || !Array.isArray(data.titles)) {
            if (settings.debugMode) {
                console.warn('[DLE] AI search returned error:', data.error || 'unknown');
            }
            return [];
        }

        // Map returned titles back to VaultEntry objects
        const titleSet = new Set(data.titles.map(t => t.toLowerCase()));
        const results = vaultIndex.filter(e => titleSet.has(e.title.toLowerCase()));

        // Cache the results
        aiSearchCache = { hash: cacheKey, results };

        if (settings.debugMode) {
            console.log(`[DLE] AI search found ${data.titles.length} titles, matched ${results.length} entries`);
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
 * @param {{ matched: VaultEntry[], matchedKeys: Map<string, string> }} keywordResult
 * @param {VaultEntry[]} aiEntries
 * @param {typeof defaultSettings} settings
 * @returns {{ merged: VaultEntry[], matchedKeys: Map<string, string> }}
 */
function mergeResults(keywordResult, aiEntries, settings) {
    const { matched: keywordMatched, matchedKeys } = keywordResult;
    const keywordTitles = new Set(keywordMatched.map(e => e.title));

    // AI-only entries (not already found by keyword matching)
    const aiOnly = aiEntries.filter(e => !keywordTitles.has(e.title));

    // Tag AI-only entries in matchedKeys for debug logging
    for (const entry of aiOnly) {
        matchedKeys.set(entry.title, '(AI search)');
    }

    // Build combined array with effective priority
    const combined = [
        ...keywordMatched.map(e => ({ entry: e, effectivePriority: e.priority })),
        ...aiOnly.map(e => ({ entry: e, effectivePriority: e.priority + settings.aiSearchPriorityOffset })),
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
        const chatContext = buildScanText(chat, settings.aiSearchScanDepth);

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

        console.log('[DLE] DeepLore Enhanced client extension initialized');
    } catch (err) {
        console.error('[DLE] Failed to initialize:', err);
    }
});
