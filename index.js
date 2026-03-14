import {
    setExtensionPrompt,
    extension_prompts,
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
import {
    parseFrontmatter, extractWikiLinks, cleanContent, extractTitle,
    truncateToSentence, simpleHash, escapeRegex,
    buildScanText, buildAiChatContext, validateSettings,
} from './core/utils.js';
import { testEntryMatch, countKeywordOccurrences, applyGating, resolveLinks, formatAndGroup } from './core/matching.js';
import { parseVaultFile, clearPrompts } from './core/pipeline.js';
import { takeIndexSnapshot, detectChanges } from './core/sync.js';

const MODULE_NAME = 'deeplore_enhanced';
const PROMPT_TAG = 'deeplore_enhanced';
const PROMPT_TAG_PREFIX = 'deeplore_';
const PLUGIN_BASE = '/api/plugins/deeplore-enhanced';

const DEFAULT_AI_SYSTEM_PROMPT = `You are Claude Code. You are a lore librarian for a roleplay session. Given recent chat messages and a manifest of lore entries, select which entries are most relevant to inject into the current conversation context.

You may select up to {{maxEntries}} entries. Select fewer if not all are relevant.

Each entry in the manifest is formatted as:
  EntryName (Ntok) → LinkedEntry1, LinkedEntry2
  Description text. May include structured metadata in [brackets] with fields like Triggers, Related, Who Knows, Category.

Selection criteria (in order of importance):
1. Direct references - Characters, places, items, or events explicitly mentioned
2. Active context - Entries about the current location, present characters, or ongoing events
3. Relationship chains - The → arrow shows linked entries; if entry A is relevant, consider linked entries too
4. Metadata triggers - If an entry's [Triggers: ...] field matches what's happening in the conversation, select it
5. Thematic relevance - Entries matching the tone or themes (betrayal, romance, combat, etc.)

Guidelines:
- Focus on what is relevant RIGHT NOW in the conversation
- Prefer fewer, highly relevant entries over many loosely related ones
- Consider the token cost (Ntok) shown for each entry when making selections
- Use [Related: ...] and → links to find connected lore

Respond with a JSON array of objects. Each object has:
- "title": exact entry name from the manifest
- "confidence": "high", "medium", or "low"
- "reason": brief phrase explaining why

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
    seedTag: 'lorebook-seed',
    bootstrapTag: 'lorebook-bootstrap',
    newChatThreshold: 3,
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
    aiSearchMode: 'two-stage',
    aiSearchScanDepth: 4,
    aiSearchSystemPrompt: '',
    aiSearchManifestSummaryLength: 600,
    // Context Cartographer settings
    showLoreSources: true,
    obsidianVaultName: '',
    // Session Scribe settings
    scribeEnabled: false,
    scribeInterval: 5,
    scribeFolder: 'Sessions',
    scribePrompt: '',
    // Vault Sync settings
    syncPollingInterval: 0,
    showSyncToasts: true,
    // Chat History Tracking
    reinjectionCooldown: 0,
    // Analytics
    analyticsData: {},
};

/** Validation constraints for numeric settings */
const settingsConstraints = {
    obsidianPort: { min: 1, max: 65535 },
    scanDepth: { min: 0, max: 100 },
    maxEntries: { min: 1, max: 100 },
    maxTokensBudget: { min: 100, max: 100000 },
    injectionDepth: { min: 0, max: 9999 },
    maxRecursionSteps: { min: 1, max: 10 },
    cacheTTL: { min: 0, max: 86400 },
    reviewResponseTokens: { min: 0, max: 100000 },
    aiSearchMaxTokens: { min: 64, max: 4096 },
    aiSearchTimeout: { min: 1000, max: 30000 },
    aiSearchScanDepth: { min: 1, max: 100 },
    aiSearchManifestSummaryLength: { min: 100, max: 1000 },
    scribeInterval: { min: 1, max: 50 },
    newChatThreshold: { min: 1, max: 20 },
    syncPollingInterval: { min: 0, max: 3600 },
    reinjectionCooldown: { min: 0, max: 50 },
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
    validateSettings(extension_settings[MODULE_NAME], settingsConstraints);
    return extension_settings[MODULE_NAME];
}

// ============================================================================
// Vault Index Cache
// ============================================================================

/** @type {import('./core/pipeline.js').VaultEntry[]} */
let vaultIndex = [];
let indexTimestamp = 0;
let indexing = false;

/** AI search result cache to avoid redundant API calls */
let aiSearchCache = { hash: '', results: [] };

/** Session-scoped AI search usage stats */
let aiSearchStats = { calls: 0, cachedHits: 0, totalInputTokens: 0, totalOutputTokens: 0 };

/** Context Cartographer: sources from the last generation interceptor run */
let lastInjectionSources = null;

/** Session Scribe: counter and lock */
let messagesSinceLastScribe = 0;
let scribeInProgress = false;

/** Vault Sync: previous index snapshot for change detection */
let previousIndexSnapshot = null;

/** Cooldown tracking: title → remaining generations to skip */
let cooldownTracker = new Map();

/** Generation counter (reset per chat) */
let generationCount = 0;

/** Re-injection tracking: title → generation number when last injected */
let injectionHistory = new Map();

/** Vault Sync: polling interval ID */
let syncIntervalId = null;


/**
 * Build a compact manifest from a specific set of candidate entries (for AI search).
 * Same format as the old buildManifest() but only includes the provided entries.
 * @param {VaultEntry[]} candidates - Entries to include (constants are filtered out)
 * @param {boolean} [excludeBootstrap=false] - Also exclude bootstrap entries (when they're being force-injected)
 * @returns {{ manifest: string, header: string }}
 */
function buildCandidateManifest(candidates, excludeBootstrap = false) {
    const settings = getSettings();
    const summaryLen = settings.aiSearchManifestSummaryLength || 600;

    const isForceInjected = e => e.constant || (excludeBootstrap && e.bootstrap);
    const selectable = candidates.filter(e => !isForceInjected(e));

    if (selectable.length === 0) return { manifest: '', header: '' };

    const manifest = selectable
        .map(entry => {
            const summaryText = entry.summary
                || truncateToSentence(entry.content.replace(/\n+/g, ' ').trim(), summaryLen);
            const links = entry.resolvedLinks && entry.resolvedLinks.length > 0
                ? ` → ${entry.resolvedLinks.join(', ')}`
                : '';
            const header = `${entry.title} (${entry.tokenEstimate}tok)${links}`;

            return `${header}\n${summaryText}`;
        })
        .join('\n---\n');

    const totalSelectable = vaultIndex.filter(e => !isForceInjected(e)).length;
    const forcedCount = candidates.filter(e => isForceInjected(e)).length;
    const forcedTokens = candidates.filter(e => isForceInjected(e)).reduce((s, e) => s + e.tokenEstimate, 0);
    const budgetInfo = settings.unlimitedBudget
        ? ''
        : `\nToken budget: ~${settings.maxTokensBudget} tokens total.`;

    const header = `Candidate entries: ${selectable.length} (from ${totalSelectable} total).`
        + (forcedCount > 0 ? `\n${forcedCount} entries are always included (~${forcedTokens} tokens).` : '')
        + budgetInfo;

    return { manifest, header };
}

// ============================================================================
// Vault Change Detection (core functions imported from ./core/sync.js)
// ============================================================================

/**
 * Show a toast notification summarizing vault changes.
 * @param {{ added: string[], removed: string[], modified: string[], keysChanged: string[] }} changes
 */
function showChangesToast(changes) {
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

    toastr.info(parts.join('<br>'), 'DeepLore Enhanced - Vault Updated', {
        timeOut: 8000,
        extendedTimeOut: 12000,
        progressBar: true,
        closeButton: true,
        enableHtml: true,
    });
}

/**
 * Set up or tear down periodic vault sync polling.
 */
function setupSyncPolling() {
    const settings = getSettings();

    if (syncIntervalId) {
        clearInterval(syncIntervalId);
        syncIntervalId = null;
    }

    if (settings.syncPollingInterval > 0 && settings.enabled) {
        syncIntervalId = setInterval(async () => {
            if (!settings.enabled || indexing) return;
            await buildIndex();
        }, settings.syncPollingInterval * 1000);
    }
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
        const tagConfig = {
            lorebookTag: settings.lorebookTag,
            constantTag: settings.constantTag,
            neverInsertTag: settings.neverInsertTag,
            seedTag: settings.seedTag,
            bootstrapTag: settings.bootstrapTag,
        };

        for (const file of data.files) {
            const entry = parseVaultFile(file, tagConfig);
            if (entry) {
                entries.push(entry);
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

        vaultIndex = entries;
        indexTimestamp = Date.now();

        // Resolve wiki-links to confirmed entry titles
        resolveLinks(vaultIndex);

        // Invalidate AI search cache on re-index
        aiSearchCache = { hash: '', results: [] };

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
        previousIndexSnapshot = newSnapshot;

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

    if (vaultIndex.length === 0 || ttlMs === 0 || now - indexTimestamp > ttlMs) {
        await buildIndex();
    }
}

// ============================================================================
// Keyword Matching (core functions imported from ./core/matching.js and ./core/utils.js)
// ============================================================================

/**
 * Match vault entries against chat messages, with recursive scanning support.
 * @param {object[]} chat - Chat messages array
 * @returns {{ matched: VaultEntry[], matchedKeys: Map<string, string> }} Matched entries sorted by priority, and which key matched each
 */
function matchEntries(chat) {
    const settings = getSettings();
    /** @type {Set<VaultEntry>} */
    const matchedSet = new Set();
    /** @type {Map<string, string>} entry title -> matched key */
    const matchedKeys = new Map();

    // Always collect constants regardless of scan depth
    for (const entry of vaultIndex) {
        if (entry.constant) {
            matchedSet.add(entry);
            matchedKeys.set(entry.title, '(constant)');
        }
    }

    // Collect bootstrap entries when chat is short (cold-start injection)
    if (chat.length <= settings.newChatThreshold) {
        for (const entry of vaultIndex) {
            if (entry.bootstrap && !matchedSet.has(entry)) {
                matchedSet.add(entry);
                matchedKeys.set(entry.title, '(bootstrap)');
            }
        }
    }

    // Keyword matching: skip entirely when scanDepth is 0 (AI-only mode)
    if (settings.scanDepth > 0) {
        const globalScanText = buildScanText(chat, settings.scanDepth);

        // Initial scan pass
        for (const entry of vaultIndex) {
            if (entry.constant) continue; // Already added above

            // Use per-entry scan depth if set, otherwise use global scan text
            const scanText = entry.scanDepth !== null
                ? buildScanText(chat, entry.scanDepth)
                : globalScanText;

            const key = testEntryMatch(entry, scanText, settings);
            if (key) {
                // Warmup check: require N keyword occurrences before triggering
                if (entry.warmup !== null) {
                    const occurrences = countKeywordOccurrences(entry, scanText, settings);
                    if (occurrences < entry.warmup) {
                        if (settings.debugMode) {
                            console.debug(`[DLE] Warmup: "${entry.title}" needs ${entry.warmup} occurrences, found ${occurrences} — skipping`);
                        }
                        continue;
                    }
                }

                // Cooldown check: skip entries still on cooldown
                const remaining = cooldownTracker.get(entry.title);
                if (remaining !== undefined && remaining > 0) {
                    if (settings.debugMode) {
                        console.debug(`[DLE] Cooldown: "${entry.title}" has ${remaining} generations remaining — skipping`);
                    }
                    continue;
                }

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
    }

    // Sort by priority (ascending - lower number = higher priority)
    const matched = [...matchedSet].sort((a, b) => a.priority - b.priority);

    return { matched, matchedKeys };
}

// ============================================================================
// AI Search
// ============================================================================


/**
 * @typedef {object} AiSearchMatch
 * @property {VaultEntry} entry
 * @property {string} confidence - "high", "medium", or "low"
 * @property {string} reason - Brief explanation
 */

/**
 * Perform AI-powered semantic search using Claude Haiku via the proxy.
 * @param {object[]} chat - Chat messages array
 * @param {string} candidateManifest - Manifest string of candidate entries
 * @param {string} candidateHeader - Header with metadata about candidates
 * @returns {Promise<{ results: AiSearchMatch[], error: boolean }>}
 */
async function aiSearch(chat, candidateManifest, candidateHeader) {
    const settings = getSettings();

    if (!settings.aiSearchEnabled || !candidateManifest) {
        return { results: [], error: false };
    }

    let chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);
    if (!chatContext.trim()) return { results: [], error: false };

    // Prepend seed entry content as story context on new chats
    const isNewChat = chat.length <= settings.newChatThreshold;
    if (isNewChat) {
        const seedEntries = vaultIndex.filter(e => e.seed);
        if (seedEntries.length > 0) {
            const seedContext = seedEntries.map(e => e.content).join('\n\n');
            chatContext = `[STORY CONTEXT — use this to understand the setting and make better selections]\n${seedContext}\n\n[RECENT CHAT]\n${chatContext}`;
            if (settings.debugMode) {
                console.log(`[DLE] New chat: injecting ${seedEntries.length} seed entries as AI context`);
            }
        }
    }

    // Check cache - skip API call if inputs haven't changed
    const cacheKey = simpleHash(chatContext + candidateManifest);
    if (cacheKey === aiSearchCache.hash && aiSearchCache.results.length > 0) {
        aiSearchStats.cachedHits++;
        updateAiStats();
        if (settings.debugMode) {
            console.debug('[DLE] AI search cache hit, skipping API call');
        }
        return { results: aiSearchCache.results, error: false };
    }

    let timeoutId;
    try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), settings.aiSearchTimeout);

        // Resolve system prompt with {{maxEntries}} placeholder
        const maxEntries = settings.unlimitedEntries ? 'as many as are relevant' : String(settings.maxEntries);
        let systemPrompt;
        if (settings.aiSearchSystemPrompt && settings.aiSearchSystemPrompt.trim()) {
            const userPrompt = settings.aiSearchSystemPrompt.trim();
            systemPrompt = userPrompt.startsWith('You are Claude Code')
                ? userPrompt
                : 'You are Claude Code. ' + userPrompt;
        } else {
            systemPrompt = DEFAULT_AI_SYSTEM_PROMPT;
        }
        systemPrompt = systemPrompt.replace(/\{\{maxEntries\}\}/g, maxEntries);

        // On new chats, tell AI to always fill to max selections
        if (isNewChat) {
            const constantCount = vaultIndex.filter(e => e.constant).length;
            const selectCount = Math.max(1, settings.maxEntries - constantCount);
            systemPrompt += '\n\nIMPORTANT: The conversation just started. You have story context above to help you understand the setting. Select exactly ' + selectCount + ' entries from the manifest — always fill to this count. The user needs rich context for the conversation start. Do not return fewer entries or an empty array.';
            if (settings.debugMode) {
                console.log(`[DLE] New chat: requesting ${selectCount} AI selections (${settings.maxEntries} max - ${constantCount} constants)`);
            }
        }

        const response = await fetch(`${PLUGIN_BASE}/ai-search`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                manifest: candidateManifest,
                manifestHeader: candidateHeader,
                chatContext: chatContext,
                proxyUrl: settings.aiSearchProxyUrl,
                model: settings.aiSearchModel,
                maxTokens: settings.aiSearchMaxTokens,
                systemPrompt: systemPrompt,
                timeout: settings.aiSearchTimeout,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.warn('[DLE] AI search server error:', response.status);
            return { results: [], error: true };
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
            return { results: [], error: true };
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

        return { results, error: false };
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            console.warn('[DLE] AI search timed out');
        } else {
            console.error('[DLE] AI search error:', err);
        }
        return { results: [], error: true };
    }
}

// applyGating and formatAndGroup imported from ./core/matching.js
// clearPrompts imported from ./core/pipeline.js

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

    // Clear stale source data (after quiet check so Scribe doesn't wipe real sources)
    lastInjectionSources = null;

    // Clear all previous DeepLore prompts
    clearPrompts(extension_prompts, PROMPT_TAG_PREFIX, PROMPT_TAG);

    try {
        // Ensure index is fresh
        await ensureIndexFresh();

        if (vaultIndex.length === 0) {
            if (settings.debugMode) {
                console.debug('[DLE] No entries indexed, skipping');
            }
            return;
        }

        let finalEntries;
        let matchedKeys = new Map();

        if (settings.aiSearchEnabled && settings.aiSearchMode === 'ai-only') {
            // ── AI-only mode: send full vault to Haiku ──
            const bootstrapActive = chat.length <= settings.newChatThreshold;
            const { manifest: candidateManifest, header: candidateHeader } = buildCandidateManifest(vaultIndex, bootstrapActive);
            const alwaysInject = vaultIndex.filter(e => e.constant || (bootstrapActive && e.bootstrap));

            // Mark bootstrap entries in matchedKeys
            if (bootstrapActive) {
                for (const e of alwaysInject) {
                    if (e.bootstrap && !e.constant) {
                        matchedKeys.set(e.title, '(bootstrap)');
                    }
                }
            }

            if (candidateManifest) {
                const aiResult = await aiSearch(chat, candidateManifest, candidateHeader);

                if (aiResult.error) {
                    // AI failed — fall back to keyword matching
                    console.warn('[DLE] AI search failed (ai-only mode), falling back to keyword results');
                    const keywordResult = matchEntries(chat);
                    finalEntries = keywordResult.matched;
                    matchedKeys = keywordResult.matchedKeys;
                } else if (aiResult.results.length === 0) {
                    // AI intentionally returned empty — keep always-inject entries only
                    finalEntries = alwaysInject;
                    if (settings.debugMode) {
                        console.log('[DLE] AI-only mode: selected 0 entries (AI decision), keeping constants' + (bootstrapActive ? ' + bootstraps' : '') + ' only');
                    }
                } else {
                    const isForceInjected = e => e.constant || (bootstrapActive && e.bootstrap);
                    finalEntries = [...alwaysInject, ...aiResult.results.map(r => r.entry).filter(e => !isForceInjected(e))];
                    for (const r of aiResult.results) {
                        matchedKeys.set(r.entry.title, `AI: ${r.reason} (${r.confidence})`);
                    }
                    if (settings.debugMode) {
                        const selectableCount = vaultIndex.filter(e => !isForceInjected(e)).length;
                        console.log(`[DLE] AI-only mode: selected ${aiResult.results.length} from ${selectableCount} entries` + (bootstrapActive ? ` (bootstrap active, ${alwaysInject.length} force-injected)` : ''));
                    }
                }
            } else {
                // All entries are constants/bootstraps
                finalEntries = alwaysInject;
            }

        } else if (settings.aiSearchEnabled && settings.aiSearchMode === 'two-stage') {
            // ── Two-stage mode: keywords → AI ──
            const bootstrapActive = chat.length <= settings.newChatThreshold;
            const keywordResult = matchEntries(chat);
            matchedKeys = keywordResult.matchedKeys;

            if (settings.debugMode) {
                const nonConstant = keywordResult.matched.filter(e => !e.constant && !e.bootstrap);
                const bootstrapCount = keywordResult.matched.filter(e => e.bootstrap && !e.constant).length;
                console.log(`[DLE] Stage 1 (keywords): ${nonConstant.length} keyword matches + ${keywordResult.matched.length - nonConstant.length - bootstrapCount} constants` + (bootstrapActive && bootstrapCount > 0 ? ` + ${bootstrapCount} bootstraps` : ''));
            }

            const { manifest: candidateManifest, header: candidateHeader } = buildCandidateManifest(keywordResult.matched, bootstrapActive);

            if (!candidateManifest) {
                // Only constants/bootstraps matched — no candidates for AI
                finalEntries = keywordResult.matched;
            } else {
                const aiResult = await aiSearch(chat, candidateManifest, candidateHeader);

                if (aiResult.error) {
                    // AI failed — fall back to keyword results
                    console.warn('[DLE] AI search failed, falling back to keyword results');
                    finalEntries = keywordResult.matched;
                } else if (aiResult.results.length === 0) {
                    // AI intentionally returned empty — keep constants + bootstraps only
                    finalEntries = keywordResult.matched.filter(e => e.constant || (bootstrapActive && e.bootstrap));
                    if (settings.debugMode) {
                        console.log('[DLE] Stage 2 (AI): selected 0 entries (AI decision), keeping constants' + (bootstrapActive ? ' + bootstraps' : '') + ' only');
                    }
                } else {
                    const isForceInjected = e => e.constant || (bootstrapActive && e.bootstrap);
                    const alwaysInject = keywordResult.matched.filter(e => isForceInjected(e));
                    finalEntries = [...alwaysInject, ...aiResult.results.map(r => r.entry).filter(e => !isForceInjected(e))];

                    // Update matchedKeys with AI reasons
                    for (const r of aiResult.results) {
                        const existing = matchedKeys.get(r.entry.title);
                        matchedKeys.set(r.entry.title, existing
                            ? `${existing} → AI: ${r.reason} (${r.confidence})`
                            : `AI: ${r.reason} (${r.confidence})`);
                    }

                    if (settings.debugMode) {
                        console.log(`[DLE] Stage 2 (AI): selected ${aiResult.results.length} from ${keywordResult.matched.filter(e => !isForceInjected(e)).length} candidates`);
                    }
                }
            }

        } else {
            // ── Keywords-only mode (AI disabled) ──
            const keywordResult = matchEntries(chat);
            finalEntries = keywordResult.matched;
            matchedKeys = keywordResult.matchedKeys;
        }

        if (finalEntries.length === 0) {
            if (settings.debugMode) {
                console.debug('[DLE] No entries matched');
            }
            return;
        }

        // Re-injection cooldown: filter out recently injected entries
        if (settings.reinjectionCooldown > 0) {
            const before = finalEntries.length;
            finalEntries = finalEntries.filter(e => {
                if (e.constant) return true; // Constants always pass
                const lastGen = injectionHistory.get(e.title);
                if (lastGen !== undefined && (generationCount - lastGen) < settings.reinjectionCooldown) {
                    if (settings.debugMode) {
                        console.debug(`[DLE] Re-injection cooldown: "${e.title}" was injected ${generationCount - lastGen} gens ago (cooldown: ${settings.reinjectionCooldown}) — skipping`);
                    }
                    return false;
                }
                return true;
            });
            if (settings.debugMode && finalEntries.length < before) {
                console.log(`[DLE] Re-injection cooldown removed ${before - finalEntries.length} entries`);
            }
        }

        if (finalEntries.length === 0) {
            if (settings.debugMode) {
                console.debug('[DLE] All entries removed by re-injection cooldown');
            }
            return;
        }

        // Apply conditional gating (requires/excludes)
        const gated = applyGating(finalEntries);

        if (settings.debugMode && gated.length < finalEntries.length) {
            const removed = finalEntries.filter(e => !gated.includes(e));
            console.log(`[DLE] Gating removed ${removed.length} entries:`,
                removed.map(e => ({ title: e.title, requires: e.requires, excludes: e.excludes })));
        }

        if (gated.length === 0) {
            if (settings.debugMode) {
                console.debug('[DLE] All entries removed by gating rules');
            }
            return;
        }

        // Format with budget, grouped by injection position
        const { groups, count: injectedCount, totalTokens } = formatAndGroup(gated, getSettings(), PROMPT_TAG_PREFIX);

        if (groups.length > 0) {
            for (const group of groups) {
                setExtensionPrompt(
                    group.tag,
                    group.text,
                    group.position,
                    group.depth,
                    settings.allowWIScan,
                    group.role,
                );
            }

            // Capture injection sources for Context Cartographer
            lastInjectionSources = gated.slice(0, injectedCount).map(e => ({
                title: e.title,
                filename: e.filename,
                matchedBy: matchedKeys.get(e.title) || '?',
                priority: e.priority,
                tokens: e.tokenEstimate,
            }));

            // Post-injection tracking
            generationCount++;

            // Decrement cooldown counters; remove expired ones
            for (const [title, remaining] of cooldownTracker) {
                if (remaining <= 1) {
                    cooldownTracker.delete(title);
                } else {
                    cooldownTracker.set(title, remaining - 1);
                }
            }

            // Set cooldown for newly injected entries that have a cooldown value
            const injectedEntries = gated.slice(0, injectedCount);
            for (const entry of injectedEntries) {
                if (entry.cooldown !== null && entry.cooldown > 0) {
                    cooldownTracker.set(entry.title, entry.cooldown);
                }
            }

            // Record injection history for re-injection cooldown
            for (const entry of injectedEntries) {
                injectionHistory.set(entry.title, generationCount);
            }

            // Update analytics data
            const analytics = settings.analyticsData;
            for (const entry of finalEntries) {
                if (!analytics[entry.title]) {
                    analytics[entry.title] = { matched: 0, injected: 0, lastTriggered: 0 };
                }
                analytics[entry.title].matched++;
                analytics[entry.title].lastTriggered = Date.now();
            }
            for (const entry of injectedEntries) {
                if (!analytics[entry.title]) {
                    analytics[entry.title] = { matched: 0, injected: 0, lastTriggered: 0 };
                }
                analytics[entry.title].injected++;
            }
            saveSettingsDebounced();

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
                console.log(`[DLE] ${finalEntries.length} selected, ${gated.length} after gating, ${injectedCount} injected (~${totalTokens} tokens) in ${groups.length} group(s)` +
                    (contextSize > 0 ? ` (${Math.round(totalTokens / contextSize * 100)}% of ${contextSize} context)` : ''));
                console.table(gated.slice(0, injectedCount).map(e => ({
                    title: e.title,
                    matchedBy: matchedKeys.get(e.title) || '?',
                    priority: e.priority,
                    tokens: e.tokenEstimate,
                    constant: e.constant,
                })));
                if (groups.length > 1) {
                    console.log('[DLE] Injection groups:', groups.map(g =>
                        `${g.tag}: pos=${g.position} depth=${g.depth} role=${g.role}`));
                }
            }
        }
    } catch (err) {
        console.error('[DLE] Error during generation:', err);
    }
}

// Register the interceptor on globalThis so SillyTavern can find it
globalThis.deepLoreEnhanced_onGenerate = onGenerate;

/**
 * External API: match vault entries against arbitrary text.
 * Used by other extensions (e.g. BurnerPhone) to get lore without going through the interceptor.
 * @param {string|object[]} scanInput - Text string or array of {name, mes, is_user} chat objects
 * @returns {Promise<{text: string, count: number, tokens: number}>}
 */
async function matchTextForExternal(scanInput) {
    const settings = getSettings();
    if (!settings.enabled) return { text: '', count: 0, tokens: 0 };

    await ensureIndexFresh();
    if (vaultIndex.length === 0) return { text: '', count: 0, tokens: 0 };

    const fakeChat = typeof scanInput === 'string'
        ? [{ name: 'context', mes: scanInput, is_user: true }]
        : scanInput;

    const { matched } = matchEntries(fakeChat);
    const gated = applyGating(matched);
    const { groups, count, totalTokens } = formatAndGroup(gated, getSettings(), PROMPT_TAG_PREFIX);

    const combinedText = groups.map(g => g.text).join('\n\n');
    return { text: combinedText, count, tokens: totalTokens };
}

globalThis.deepLoreEnhanced_matchText = matchTextForExternal;

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

        if (!response.ok) {
            throw new Error(`Server returned HTTP ${response.status}`);
        }

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
    $('#dle_seed_tag').val(settings.seedTag);
    $('#dle_bootstrap_tag').val(settings.bootstrapTag);
    $('#dle_new_chat_threshold').val(settings.newChatThreshold);
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
    $('input[name="dle_ai_mode"][value="' + settings.aiSearchMode + '"]').prop('checked', true);
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

    // Vault Sync settings
    $('#dle_sync_interval').val(settings.syncPollingInterval);
    $('#dle_show_sync_toasts').prop('checked', settings.showSyncToasts);

    // Chat History Tracking
    $('#dle_reinjection_cooldown').val(settings.reinjectionCooldown);

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

    $('#dle_seed_tag').on('input', function () {
        settings.seedTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#dle_bootstrap_tag').on('input', function () {
        settings.bootstrapTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#dle_new_chat_threshold').on('input', function () {
        settings.newChatThreshold = Number($(this).val()) || 3;
        saveSettingsDebounced();
    });

    $('#dle_scan_depth').on('input', function () {
        const val = Number($(this).val());
        settings.scanDepth = isNaN(val) ? 4 : val;
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
        const val = Number($(this).val());
        settings.injectionDepth = isNaN(val) ? 4 : val;
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
        const val = Number($(this).val());
        settings.cacheTTL = isNaN(val) ? 300 : val;
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

    $('input[name="dle_ai_mode"]').on('change', function () {
        settings.aiSearchMode = $('input[name="dle_ai_mode"]:checked').val();
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
        settings.aiSearchManifestSummaryLength = Number($(this).val()) || 600;
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

    // Vault Sync settings
    $('#dle_sync_interval').on('input', function () {
        const val = Number($(this).val());
        settings.syncPollingInterval = isNaN(val) ? 0 : val;
        saveSettingsDebounced();
        setupSyncPolling();
    });

    $('#dle_show_sync_toasts').on('change', function () {
        settings.showSyncToasts = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Chat History Tracking
    $('#dle_reinjection_cooldown').on('input', function () {
        const val = Number($(this).val());
        settings.reinjectionCooldown = isNaN(val) ? 0 : val;
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

            if (!response.ok) {
                throw new Error(`Server returned HTTP ${response.status}`);
            }

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

            if (!response.ok) {
                throw new Error(`Server returned HTTP ${response.status}`);
            }

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

        await ensureIndexFresh();
        if (vaultIndex.length === 0) {
            toastr.warning('No vault index. Click "Refresh Index" first.', 'DeepLore Enhanced');
            return;
        }

        // Build candidate manifest based on mode
        let candidateManifest, candidateHeader, modeLabel;
        if (settings.aiSearchMode === 'ai-only') {
            const result = buildCandidateManifest(vaultIndex);
            candidateManifest = result.manifest;
            candidateHeader = result.header;
            modeLabel = 'AI-only (full vault)';
        } else {
            const keywordResult = matchEntries(chat);
            const nonConstant = keywordResult.matched.filter(e => !e.constant);
            if (nonConstant.length === 0) {
                toastr.warning('No keyword matches found. The AI would receive no candidates.', 'DeepLore Enhanced');
                return;
            }
            const result = buildCandidateManifest(keywordResult.matched);
            candidateManifest = result.manifest;
            candidateHeader = result.header;
            modeLabel = `Two-stage (${nonConstant.length} keyword candidates)`;
        }

        // Build chat context (same as aiSearch)
        const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);

        // Resolve system prompt with {{maxEntries}}
        const maxEntries = settings.unlimitedEntries ? 'as many as are relevant' : String(settings.maxEntries);
        let systemPrompt;
        if (settings.aiSearchSystemPrompt && settings.aiSearchSystemPrompt.trim()) {
            const userPrompt = settings.aiSearchSystemPrompt.trim();
            systemPrompt = userPrompt.startsWith('You are Claude Code')
                ? userPrompt
                : 'You are Claude Code. ' + userPrompt;
        } else {
            systemPrompt = DEFAULT_AI_SYSTEM_PROMPT;
        }
        systemPrompt = systemPrompt.replace(/\{\{maxEntries\}\}/g, maxEntries);

        // Build user message (same format as server)
        const headerSection = candidateHeader ? `## Manifest Info\n${candidateHeader}\n\n` : '';
        const userMessage = `${headerSection}## Recent Chat\n${chatContext}\n\n## Candidate Lore Entries\n${candidateManifest}\n\nSelect the relevant entries as a JSON array.`;

        // Build preview HTML
        const previewHtml = `
            <div style="text-align: left; font-family: monospace; font-size: 0.85em;">
                <h3>Mode: ${escapeHtml(modeLabel)}</h3>
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

    // Test Match button — simulate matching pipeline and show results
    $('#dle_test_match').on('click', async function () {
        const settings = getSettings();

        if (!chat || chat.length === 0) {
            toastr.warning('No active chat. Start a conversation first.', 'DeepLore Enhanced');
            return;
        }

        try {
            toastr.info('Running match simulation...', 'DeepLore Enhanced', { timeOut: 2000 });

            await ensureIndexFresh();

            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed. Check your Obsidian connection and lorebook tag.', 'DeepLore Enhanced');
                return;
            }

            // Run the full matching pipeline (same as onGenerate but without injection)
            let finalEntries;
            let matchedKeys = new Map();
            let keywordCount = 0;
            let aiUsed = false;
            let aiError = false;
            let aiSelectedCount = 0;

            if (settings.aiSearchEnabled && settings.aiSearchMode === 'ai-only') {
                const bootstrapActive = chat.length <= settings.newChatThreshold;
                const { manifest: candidateManifest, header: candidateHeader } = buildCandidateManifest(vaultIndex, bootstrapActive);
                const alwaysInject = vaultIndex.filter(e => e.constant || (bootstrapActive && e.bootstrap));
                aiUsed = true;

                if (bootstrapActive) {
                    for (const e of alwaysInject) {
                        if (e.bootstrap && !e.constant) {
                            matchedKeys.set(e.title, '(bootstrap)');
                        }
                    }
                }

                if (candidateManifest) {
                    const aiResult = await aiSearch(chat, candidateManifest, candidateHeader);
                    if (aiResult.error) {
                        aiError = true;
                        const kwResult = matchEntries(chat);
                        finalEntries = kwResult.matched;
                        matchedKeys = kwResult.matchedKeys;
                    } else if (aiResult.results.length === 0) {
                        finalEntries = alwaysInject;
                    } else {
                        const isForceInjected = e => e.constant || (bootstrapActive && e.bootstrap);
                        finalEntries = [...alwaysInject, ...aiResult.results.map(r => r.entry).filter(e => !isForceInjected(e))];
                        aiSelectedCount = aiResult.results.length;
                        for (const r of aiResult.results) {
                            matchedKeys.set(r.entry.title, `AI: ${r.reason} (${r.confidence})`);
                        }
                    }
                } else {
                    finalEntries = alwaysInject;
                }

            } else if (settings.aiSearchEnabled && settings.aiSearchMode === 'two-stage') {
                const bootstrapActive = chat.length <= settings.newChatThreshold;
                const keywordResult = matchEntries(chat);
                matchedKeys = keywordResult.matchedKeys;
                keywordCount = keywordResult.matched.filter(e => !e.constant && !e.bootstrap).length;

                const { manifest: candidateManifest, header: candidateHeader } = buildCandidateManifest(keywordResult.matched, bootstrapActive);

                if (!candidateManifest) {
                    finalEntries = keywordResult.matched;
                } else {
                    aiUsed = true;
                    const aiResult = await aiSearch(chat, candidateManifest, candidateHeader);
                    if (aiResult.error) {
                        aiError = true;
                        finalEntries = keywordResult.matched;
                    } else if (aiResult.results.length === 0) {
                        finalEntries = keywordResult.matched.filter(e => e.constant || (bootstrapActive && e.bootstrap));
                    } else {
                        const isForceInjected = e => e.constant || (bootstrapActive && e.bootstrap);
                        const alwaysInject = keywordResult.matched.filter(e => isForceInjected(e));
                        finalEntries = [...alwaysInject, ...aiResult.results.map(r => r.entry).filter(e => !isForceInjected(e))];
                        aiSelectedCount = aiResult.results.length;
                        for (const r of aiResult.results) {
                            const existing = matchedKeys.get(r.entry.title);
                            matchedKeys.set(r.entry.title, existing
                                ? `${existing} → AI: ${r.reason} (${r.confidence})`
                                : `AI: ${r.reason} (${r.confidence})`);
                        }
                    }
                }

            } else {
                const keywordResult = matchEntries(chat);
                finalEntries = keywordResult.matched;
                matchedKeys = keywordResult.matchedKeys;
                keywordCount = keywordResult.matched.filter(e => !e.constant).length;
            }

            const gated = applyGating(finalEntries);
            const { groups, count: injectedCount, totalTokens } = formatAndGroup(gated, getSettings(), PROMPT_TAG_PREFIX);

            const gatedRemoved = finalEntries.filter(e => !gated.includes(e));
            const budgetRemoved = gated.slice(injectedCount);
            const injected = gated.slice(0, injectedCount);

            // Build popup HTML
            const positionLabels = { 0: 'After', 1: 'In-chat', 2: 'Before' };
            const roleLabels = { 0: 'System', 1: 'User', 2: 'Assistant' };

            let html = '<div style="text-align: left; font-family: monospace; font-size: 0.85em;">';

            // Summary
            html += `<h3>Match Summary</h3>`;
            html += `<div style="margin-bottom: 10px;">`;
            html += `<b>${vaultIndex.length}</b> indexed &rarr; `;
            if (settings.aiSearchMode === 'ai-only' && settings.aiSearchEnabled) {
                html += aiError
                    ? `<b style="color: #ff9800;">AI error (fallback to keywords)</b> &rarr; `
                    : `<b>${aiSelectedCount}</b> AI selected &rarr; `;
            } else if (settings.aiSearchEnabled) {
                html += `<b>${keywordCount}</b> keyword matched &rarr; `;
                if (aiUsed) {
                    html += aiError
                        ? `<b style="color: #ff9800;">AI error (fallback)</b> &rarr; `
                        : `<b>${aiSelectedCount}</b> AI selected &rarr; `;
                }
            } else {
                html += `<b>${keywordCount}</b> keyword matched &rarr; `;
            }
            html += `<b>${gated.length}</b> after gating &rarr; `;
            html += `<b style="color: #4caf50;">${injectedCount}</b> would inject (~${totalTokens} tokens)`;
            html += `</div>`;

            // Injected entries table
            if (injected.length > 0) {
                html += `<h3>Would Inject (${injectedCount} entries, ~${totalTokens} tokens)</h3>`;
                html += `<table style="width: 100%; border-collapse: collapse; margin-bottom: 15px;">`;
                html += `<tr style="border-bottom: 1px solid rgba(255,255,255,0.2);">`;
                html += `<th style="text-align: left; padding: 4px;">Title</th>`;
                html += `<th style="text-align: left; padding: 4px;">Matched By</th>`;
                html += `<th style="text-align: right; padding: 4px;">Priority</th>`;
                html += `<th style="text-align: right; padding: 4px;">Tokens</th>`;
                html += `<th style="text-align: left; padding: 4px;">Position</th>`;
                html += `</tr>`;
                for (const entry of injected) {
                    const pos = entry.injectionPosition ?? settings.injectionPosition;
                    const depth = entry.injectionDepth ?? settings.injectionDepth;
                    const role = entry.injectionRole ?? settings.injectionRole;
                    const posLabel = pos === 1
                        ? `In-chat @${depth} (${roleLabels[role] || '?'})`
                        : (positionLabels[pos] || '?');
                    html += `<tr style="border-bottom: 1px solid rgba(255,255,255,0.1);">`;
                    html += `<td style="padding: 4px;">${escapeHtml(entry.title)}</td>`;
                    html += `<td style="padding: 4px; opacity: 0.8;">${escapeHtml(matchedKeys.get(entry.title) || '?')}</td>`;
                    html += `<td style="text-align: right; padding: 4px;">${entry.priority}</td>`;
                    html += `<td style="text-align: right; padding: 4px;">${entry.tokenEstimate}</td>`;
                    html += `<td style="padding: 4px; opacity: 0.8;">${posLabel}</td>`;
                    html += `</tr>`;
                }
                html += `</table>`;
            } else {
                html += `<p style="color: #ff9800;">No entries would be injected.</p>`;
            }

            // Gating removed
            if (gatedRemoved.length > 0) {
                html += `<h3 style="color: #ff9800;">Removed by Gating (${gatedRemoved.length})</h3>`;
                html += `<ul style="margin: 0 0 15px 20px;">`;
                for (const entry of gatedRemoved) {
                    const reasons = [];
                    if (entry.requires.length > 0) reasons.push(`requires: ${entry.requires.join(', ')}`);
                    if (entry.excludes.length > 0) reasons.push(`excludes: ${entry.excludes.join(', ')}`);
                    html += `<li>${escapeHtml(entry.title)} — ${escapeHtml(reasons.join('; ') || 'dependency chain')}</li>`;
                }
                html += `</ul>`;
            }

            // Budget/max removed
            if (budgetRemoved.length > 0) {
                html += `<h3 style="color: #ff9800;">Cut by Budget/Max (${budgetRemoved.length})</h3>`;
                html += `<ul style="margin: 0 0 15px 20px;">`;
                for (const entry of budgetRemoved) {
                    html += `<li>${escapeHtml(entry.title)} (pri ${entry.priority}, ~${entry.tokenEstimate} tokens)</li>`;
                }
                html += `</ul>`;
            }

            // Unmatched entries with keys (diagnostic aid)
            const matchedTitles = new Set(finalEntries.map(e => e.title));
            const unmatchedWithKeys = vaultIndex.filter(e => !matchedTitles.has(e.title) && !e.constant && e.keys.length > 0);
            if (unmatchedWithKeys.length > 0) {
                html += `<details style="margin-top: 10px;"><summary style="cursor: pointer; opacity: 0.7;">Unmatched entries with keywords (${unmatchedWithKeys.length})</summary>`;
                html += `<ul style="margin: 5px 0 0 20px;">`;
                for (const entry of unmatchedWithKeys.slice(0, 30)) {
                    html += `<li>${escapeHtml(entry.title)} — keys: ${escapeHtml(entry.keys.join(', '))}</li>`;
                }
                if (unmatchedWithKeys.length > 30) {
                    html += `<li>...and ${unmatchedWithKeys.length - 30} more</li>`;
                }
                html += `</ul></details>`;
            }

            // Entries with no keys (potential misconfiguration)
            const noKeys = vaultIndex.filter(e => e.keys.length === 0 && !e.constant);
            if (noKeys.length > 0) {
                html += `<details style="margin-top: 10px;"><summary style="cursor: pointer; color: #ff9800;">Entries with no keywords (${noKeys.length})</summary>`;
                html += `<ul style="margin: 5px 0 0 20px;">`;
                for (const entry of noKeys.slice(0, 30)) {
                    html += `<li>${escapeHtml(entry.title)} (${escapeHtml(entry.filename)})</li>`;
                }
                if (noKeys.length > 30) {
                    html += `<li>...and ${noKeys.length - 30} more</li>`;
                }
                html += `</ul></details>`;
            }

            html += `</div>`;

            callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
        } catch (err) {
            console.error('[DLE] Test Match error:', err);
            toastr.error(String(err), 'DeepLore Enhanced');
        }
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
            const seeds = vaultIndex.filter(e => e.seed).length;
            const bootstraps = vaultIndex.filter(e => e.bootstrap).length;
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            const lines = [
                `Enabled: ${settings.enabled}`,
                `Port: ${settings.obsidianPort}`,
                `Lorebook Tag: #${settings.lorebookTag}`,
                `Always-Send Tag: ${settings.constantTag ? '#' + settings.constantTag : '(none)'}`,
                `Never-Insert Tag: ${settings.neverInsertTag ? '#' + settings.neverInsertTag : '(none)'}`,
                `Seed Tag: ${settings.seedTag ? '#' + settings.seedTag : '(none)'}`,
                `Bootstrap Tag: ${settings.bootstrapTag ? '#' + settings.bootstrapTag : '(none)'} (threshold: ${settings.newChatThreshold} messages)`,
                `Entries: ${vaultIndex.length} (${constants} always-send, ${seeds} seed, ${bootstraps} bootstrap, ~${totalTokens} tokens)`,
                `Budget: ${settings.unlimitedBudget ? 'unlimited' : settings.maxTokensBudget + ' tokens'}`,
                `Max Entries: ${settings.unlimitedEntries ? 'unlimited' : settings.maxEntries}`,
                `Recursive: ${settings.recursiveScan ? 'on (max ' + settings.maxRecursionSteps + ' steps)' : 'off'}`,
                `Cache: ${indexTimestamp ? Math.round((Date.now() - indexTimestamp) / 1000) + 's old' : 'none'} / TTL ${settings.cacheTTL}s`,
                `AI Search: ${settings.aiSearchEnabled ? 'on' : 'off'}`,
                `AI Stats: ${aiSearchStats.calls} calls, ${aiSearchStats.cachedHits} cache hits, ~${aiSearchStats.totalInputTokens} in / ~${aiSearchStats.totalOutputTokens} out tokens`,
                `Auto-Sync: ${settings.syncPollingInterval > 0 ? settings.syncPollingInterval + 's interval' : 'off'}`,
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

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-analytics',
        callback: async () => {
            const settings = getSettings();
            const analytics = settings.analyticsData || {};
            const titles = Object.keys(analytics).sort((a, b) => (analytics[b].injected || 0) - (analytics[a].injected || 0));

            let html = '<table style="width:100%;border-collapse:collapse;font-size:0.9em;">';
            html += '<tr><th style="text-align:left;border-bottom:1px solid #666;padding:4px;">Entry</th><th style="border-bottom:1px solid #666;padding:4px;">Matched</th><th style="border-bottom:1px solid #666;padding:4px;">Injected</th><th style="border-bottom:1px solid #666;padding:4px;">Last Used</th></tr>';

            for (const title of titles) {
                const d = analytics[title];
                const lastUsed = d.lastTriggered ? new Date(d.lastTriggered).toLocaleString() : 'Never';
                html += `<tr><td style="padding:4px;">${escapeHtml(title)}</td><td style="text-align:center;padding:4px;">${d.matched || 0}</td><td style="text-align:center;padding:4px;">${d.injected || 0}</td><td style="text-align:center;padding:4px;">${lastUsed}</td></tr>`;
            }
            html += '</table>';

            // Dead entries: indexed but never injected
            const neverInjected = vaultIndex.filter(e => !analytics[e.title] || (analytics[e.title].injected || 0) === 0);
            if (neverInjected.length > 0) {
                html += '<hr><h4>Never Injected</h4><ul>';
                for (const e of neverInjected) {
                    html += `<li>${escapeHtml(e.title)} (${e.keys.length} keys, priority ${e.priority})</li>`;
                }
                html += '</ul>';
            }

            if (titles.length === 0 && neverInjected.length === 0) {
                html = '<p>No analytics data yet. Generate some messages first.</p>';
            }

            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true });
            return '';
        },
        helpString: 'Show entry usage analytics: how often each entry was matched and injected.',
        returns: 'Analytics popup',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dle-health',
        callback: async () => {
            await ensureIndexFresh();
            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed.', 'DeepLore Enhanced');
                return '';
            }

            const issues = [];
            const allTitles = new Set(vaultIndex.map(e => e.title));
            const keywordMap = new Map(); // keyword → [titles]

            for (const entry of vaultIndex) {
                // Empty keys on non-constant entries
                if (!entry.constant && entry.keys.length === 0) {
                    issues.push({ type: 'Empty Keys', entry: entry.title, detail: 'No trigger keywords defined' });
                }

                // Orphaned requires
                for (const req of entry.requires) {
                    if (!allTitles.has(req)) {
                        issues.push({ type: 'Orphaned Requires', entry: entry.title, detail: `References "${req}" which doesn't exist` });
                    }
                }

                // Orphaned excludes
                for (const exc of entry.excludes) {
                    if (!allTitles.has(exc)) {
                        issues.push({ type: 'Orphaned Excludes', entry: entry.title, detail: `References "${exc}" which doesn't exist` });
                    }
                }

                // Oversized entries
                if (entry.tokenEstimate > 1500) {
                    issues.push({ type: 'Oversized', entry: entry.title, detail: `~${entry.tokenEstimate} tokens (>1500)` });
                }

                // Missing summary (Enhanced-specific)
                if ('summary' in entry && !entry.summary) {
                    issues.push({ type: 'Missing Summary', entry: entry.title, detail: 'No AI selection summary defined' });
                }

                // Build keyword map for duplicate detection
                for (const key of entry.keys) {
                    const lower = key.toLowerCase();
                    if (!keywordMap.has(lower)) keywordMap.set(lower, []);
                    keywordMap.get(lower).push(entry.title);
                }
            }

            // Duplicate keywords
            for (const [keyword, titles] of keywordMap) {
                if (titles.length > 1) {
                    issues.push({ type: 'Duplicate Keywords', entry: titles.join(', '), detail: `Keyword "${keyword}" shared by ${titles.length} entries` });
                }
            }

            let html;
            if (issues.length === 0) {
                html = '<p>No issues found! All entries look healthy.</p>';
            } else {
                const grouped = {};
                for (const issue of issues) {
                    if (!grouped[issue.type]) grouped[issue.type] = [];
                    grouped[issue.type].push(issue);
                }

                html = '';
                for (const [type, items] of Object.entries(grouped)) {
                    html += `<h4>${escapeHtml(type)} (${items.length})</h4><ul>`;
                    for (const item of items) {
                        html += `<li><strong>${escapeHtml(item.entry)}</strong>: ${escapeHtml(item.detail)}</li>`;
                    }
                    html += '</ul>';
                }
            }

            await callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true });
            return '';
        },
        helpString: 'Audit vault entries for common issues: empty keys, orphaned requires/excludes, oversized entries, duplicate keywords, missing summaries.',
        returns: 'Health check popup',
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
        setupSyncPolling();

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
            // Reset session-scoped tracking on chat change
            injectionHistory.clear();
            cooldownTracker.clear();
            generationCount = 0;
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
