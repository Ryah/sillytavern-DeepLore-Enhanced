/**
 * DeepLore Enhanced — AI Search module
 * aiSearch, callViaProfile, extractAiResponseClient, profile dropdowns,
 * buildCandidateManifest
 */
import { ConnectionManagerRequestService } from '../../../shared.js';
import { truncateToSentence, simpleHash, buildAiChatContext } from '../core/utils.js';
import { getSettings, DEFAULT_AI_SYSTEM_PROMPT } from '../settings.js';
import { callProxyViaCorsBridge } from './proxy-api.js';
import {
    vaultIndex, aiSearchCache, aiSearchStats, decayTracker, lastScribeSummary,
    setAiSearchCache,
} from './state.js';
import { updateAiStats } from './settings-ui.js';

/**
 * Extract AI response JSON from text (handles direct JSON, markdown code fences, raw arrays).
 * Ported from server/index.js extractAiResponse() for client-side profile mode.
 * BUG 4 FIX: Uses non-greedy regex and tries last match first.
 * @param {string} text - Raw AI response text
 * @returns {Array} Parsed JSON array of results
 */
export function extractAiResponseClient(text) {
    if (!text || typeof text !== 'string') return null;

    /** Validate that a parsed value is a usable results array (strings or objects with title/name). */
    function isValidResultArray(val) {
        if (!Array.isArray(val) || val.length === 0) return false;
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
    // Try all JSON arrays (non-greedy), prefer last match (AIs put results at the end)
    const arrayMatches = [...text.matchAll(/\[[\s\S]*?\]/g)];
    for (let i = arrayMatches.length - 1; i >= 0; i--) {
        try {
            const parsed = JSON.parse(arrayMatches[i][0]);
            if (isValidResultArray(parsed)) return parsed;
        } catch { /* noop */ }
    }
    return null;
}

/**
 * Get the model name from the selected Connection Manager profile.
 * @returns {string} Model name or empty string
 */
export function getProfileModelHint() {
    const settings = getSettings();
    if (!settings.aiSearchProfileId) return '';
    try {
        const profile = ConnectionManagerRequestService.getProfile(settings.aiSearchProfileId);
        return profile.model || '';
    } catch {
        return '';
    }
}

/**
 * Make an API call via a SillyTavern Connection Manager profile.
 * Used by both AI Search and Session Scribe.
 * @param {string} systemPrompt - System prompt text
 * @param {string} userMessage - User message content
 * @param {number} maxTokens - Max tokens for response
 * @param {number} timeout - Timeout in milliseconds
 * @param {string} [profileId] - Profile ID (defaults to aiSearchProfileId)
 * @param {string} [modelOverride] - Model override (defaults to aiSearchModel)
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>}
 */
export async function callViaProfile(systemPrompt, userMessage, maxTokens, timeout, profileId, modelOverride) {
    const settings = getSettings();
    const resolvedProfileId = profileId || settings.aiSearchProfileId;
    const resolvedModel = modelOverride !== undefined ? modelOverride : settings.aiSearchModel;
    if (!resolvedProfileId) throw new Error('No connection profile selected.');

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const result = await ConnectionManagerRequestService.sendRequest(
            resolvedProfileId,
            messages,
            maxTokens,
            {
                stream: false,
                signal: controller.signal,
                extractData: true,
                includePreset: false,
                includeInstruct: false,
            },
            // Override model if user specified one
            resolvedModel ? { model: resolvedModel } : {},
        );

        return {
            text: result.content || '',
            usage: { input_tokens: 0, output_tokens: 0 },
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Populate the profile dropdown with saved Connection Manager profiles.
 */
export function populateProfileDropdown() {
    const select = document.getElementById('dle_ai_profile_select');
    if (!select) return;

    const settings = getSettings();
    const currentId = settings.aiSearchProfileId;

    select.innerHTML = '<option value="">— Select a profile —</option>';
    try {
        const profiles = ConnectionManagerRequestService.getSupportedProfiles();
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.api}${p.model ? ' / ' + p.model : ''})`;
            if (p.id === currentId) opt.selected = true;
            select.appendChild(opt);
        }
    } catch {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Connection Manager not available';
        opt.disabled = true;
        select.appendChild(opt);
    }
}

/**
 * Update the visibility of AI search connection fields based on selected mode.
 */
export function updateAiConnectionVisibility() {
    const settings = getSettings();
    const isProfile = settings.aiSearchConnectionMode === 'profile';
    $('#dle_ai_profile_row').toggle(isProfile);
    $('#dle_ai_proxy_row').toggle(!isProfile);

    // Update model placeholder based on mode
    const modelInput = $('#dle_ai_model');
    if (isProfile) {
        const hint = getProfileModelHint();
        modelInput.attr('placeholder', hint ? `Profile: ${hint}` : 'Leave empty to use profile model');
    } else {
        modelInput.attr('placeholder', 'claude-haiku-4-5-20251001');
    }
}

/**
 * Populate the Scribe profile dropdown with saved Connection Manager profiles.
 */
export function populateScribeProfileDropdown() {
    const select = document.getElementById('dle_scribe_profile_select');
    if (!select) return;

    const settings = getSettings();
    const currentId = settings.scribeProfileId;

    select.innerHTML = '<option value="">— Select a profile —</option>';
    try {
        const profiles = ConnectionManagerRequestService.getSupportedProfiles();
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.api}${p.model ? ' / ' + p.model : ''})`;
            if (p.id === currentId) opt.selected = true;
            select.appendChild(opt);
        }
    } catch {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Connection Manager not available';
        opt.disabled = true;
        select.appendChild(opt);
    }
}

/**
 * Update the visibility of Scribe connection fields based on selected mode.
 */
export function updateScribeConnectionVisibility() {
    const settings = getSettings();
    const mode = settings.scribeConnectionMode || 'st';
    const isProfile = mode === 'profile';
    const isProxy = mode === 'proxy';
    const isExternal = isProfile || isProxy;

    $('#dle_scribe_profile_row').toggle(isProfile);
    $('#dle_scribe_proxy_row').toggle(isProxy);
    $('#dle_scribe_model_row').toggle(isExternal);
    $('#dle_scribe_advanced_row').toggle(isExternal);

    // Update model placeholder based on mode
    const modelInput = $('#dle_scribe_model');
    if (isProfile) {
        let hint = '';
        try {
            if (settings.scribeProfileId) {
                const profile = ConnectionManagerRequestService.getProfile(settings.scribeProfileId);
                hint = profile.model || '';
            }
        } catch { /* noop */ }
        modelInput.attr('placeholder', hint ? `Profile: ${hint}` : 'Leave empty to use profile model');
    } else if (isProxy) {
        modelInput.attr('placeholder', 'claude-haiku-4-5-20251001');
    }
}

/**
 * Build a compact manifest from a specific set of candidate entries (for AI search).
 * @param {VaultEntry[]} candidates - Entries to include (constants are filtered out)
 * @param {boolean} [excludeBootstrap=false] - Also exclude bootstrap entries (when they're being force-injected)
 * @returns {{ manifest: string, header: string }}
 */
export function buildCandidateManifest(candidates, excludeBootstrap = false) {
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
            // Decay/freshness annotation: hint to AI about stale or frequently-injected entries
            let decayHint = '';
            if (settings.decayEnabled && decayTracker.size > 0) {
                const staleness = decayTracker.get(entry.title);
                if (staleness !== undefined && staleness >= settings.decayBoostThreshold) {
                    decayHint = ' [STALE — consider refreshing]';
                }
            }
            const header = `${entry.title} (${entry.tokenEstimate}tok)${links}${decayHint}`;

            return `${header}\n${summaryText}`;
        })
        .join('\n---\n');

    const totalSelectable = candidates.filter(e => !isForceInjected(e)).length;
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

/**
 * Cluster entries by type/tag for hierarchical manifest (large vaults).
 * @param {VaultEntry[]} entries - Selectable entries (non-constant)
 * @returns {Map<string, VaultEntry[]>} Category name → entries in that category
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
 * @param {Map<string, VaultEntry[]>} clusters
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

/** Threshold for enabling hierarchical two-call search */
const HIERARCHICAL_THRESHOLD = 40;

/**
 * Pre-filter candidates using hierarchical category selection for large vaults.
 * Call 1: asks AI which categories are relevant to the current chat.
 * Returns filtered candidates containing only entries from selected categories.
 * @param {VaultEntry[]} candidates - All selectable entries
 * @param {object[]} chat - Chat messages array
 * @returns {Promise<VaultEntry[]|null>} Filtered candidates, or null to skip (use all)
 */
export async function hierarchicalPreFilter(candidates, chat) {
    const settings = getSettings();
    const isForceInjected = e => e.constant || e.bootstrap;
    const selectable = candidates.filter(e => !isForceInjected(e));

    if (selectable.length < HIERARCHICAL_THRESHOLD) return null; // Too few, skip clustering

    const clusters = clusterEntries(selectable);
    if (clusters.size <= 3) return null; // Not enough categories to benefit

    const categoryManifest = buildCategoryManifest(clusters);
    const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);

    const categoryPrompt = 'You are a lore retrieval assistant. Given categories of lore entries and recent chat, select which categories are relevant. Return a JSON array of category names (strings). Be inclusive — select all categories that might be relevant.';
    const categoryUserMessage = `## Categories\n${categoryManifest}\n\n## Recent Chat\n${chatContext}`;

    try {
        let responseText;
        if (settings.aiSearchConnectionMode === 'profile') {
            const result = await callViaProfile(categoryPrompt, categoryUserMessage, 512, settings.aiSearchTimeout);
            responseText = result.text;
        } else {
            const result = await callProxyViaCorsBridge(
                settings.aiSearchProxyUrl,
                settings.aiSearchModel || 'claude-haiku-4-5-20251001',
                categoryPrompt,
                categoryUserMessage,
                512,
                settings.aiSearchTimeout,
            );
            responseText = result.text;
        }

        aiSearchStats.calls++;
        updateAiStats();

        const parsed = extractAiResponseClient(responseText);
        if (!parsed || parsed.length === 0) return null;

        // parsed should be an array of category name strings
        const selectedCategories = new Set(
            parsed.map(item => (typeof item === 'string' ? item : item.title || item.name || '').toLowerCase()).filter(Boolean),
        );

        if (selectedCategories.size === 0) return null;

        // Filter candidates to only those in selected categories
        const filtered = selectable.filter(entry => {
            const category = (entry.tags && entry.tags.length > 0) ? entry.tags[0].toLowerCase() : 'uncategorized';
            return selectedCategories.has(category);
        });

        // Always include force-injected entries
        const forceInjected = candidates.filter(e => isForceInjected(e));
        const result = [...forceInjected, ...filtered];

        if (settings.debugMode) {
            console.log(`[DLE] Hierarchical pre-filter: ${clusters.size} categories → ${selectedCategories.size} selected, ${selectable.length} → ${filtered.length} entries`);
        }

        // If filtering removed too many entries (>80%), skip — the AI was probably too aggressive
        if (filtered.length < selectable.length * 0.2) {
            if (settings.debugMode) console.log('[DLE] Hierarchical pre-filter too aggressive, using full manifest');
            return null;
        }

        return result;
    } catch (err) {
        if (settings.debugMode) console.warn('[DLE] Hierarchical pre-filter failed:', err.message);
        return null; // Fall back to single-call
    }
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
 * @param {string} candidateManifest - Manifest string of candidate entries
 * @param {string} candidateHeader - Header with metadata about candidates
 * @returns {Promise<{ results: AiSearchMatch[], error: boolean }>}
 */
export async function aiSearch(chat, candidateManifest, candidateHeader) {
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

    // Scribe-informed retrieval: append session summary for broader context awareness
    if (settings.scribeInformedRetrieval && lastScribeSummary && lastScribeSummary.trim()) {
        chatContext += `\n\n[SESSION SUMMARY — broader context beyond the recent chat window]\n${lastScribeSummary.trim()}`;
        if (settings.debugMode) {
            console.log('[DLE] Scribe summary injected into AI search context');
        }
    }

    // Sliding window cache: hash manifest + chat messages separately.
    // If only the newest chat message changed and contains no entity names from the manifest,
    // we can safely serve cached results (the new message doesn't reference any lore).
    const manifestHash = simpleHash(settings.aiSearchMode + candidateManifest);
    const chatLines = chatContext.split('\n').filter(l => l.trim());
    const chatHash = simpleHash(chatContext);

    if (aiSearchCache.hash === chatHash && aiSearchCache.manifestHash === manifestHash && aiSearchCache.results.length > 0) {
        // Exact match — nothing changed at all
        aiSearchStats.cachedHits++;
        updateAiStats();
        if (settings.debugMode) console.debug('[DLE] AI search cache hit (exact)');
        return { results: aiSearchCache.results, error: false };
    }

    // Sliding window: manifest unchanged + only newest message(s) differ
    if (aiSearchCache.manifestHash === manifestHash
        && aiSearchCache.results.length > 0
        && aiSearchCache.chatLineCount > 0
        && chatLines.length > aiSearchCache.chatLineCount) {
        // Extract only the new lines added since last cache
        const newLines = chatLines.slice(aiSearchCache.chatLineCount);
        const newText = newLines.join(' ').toLowerCase();

        // Check if any vault entry title or key appears in the new text
        const entryNames = new Set();
        for (const entry of vaultIndex) {
            entryNames.add(entry.title.toLowerCase());
            for (const key of entry.keys) {
                if (key.length >= 3) entryNames.add(key.toLowerCase());
            }
        }

        let hasNewEntityMention = false;
        for (const name of entryNames) {
            if (newText.includes(name)) {
                hasNewEntityMention = true;
                break;
            }
        }

        if (!hasNewEntityMention) {
            aiSearchStats.cachedHits++;
            updateAiStats();
            if (settings.debugMode) console.debug(`[DLE] AI search cache hit (sliding window: ${newLines.length} new lines, no entity mentions)`);
            return { results: aiSearchCache.results, error: false };
        }
    }

    let timeoutId;
    try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), settings.aiSearchTimeout);

        // Resolve system prompt with {{maxEntries}} placeholder
        // Request 2x max entries so low-confidence candidates can fill remaining budget
        const requestedEntries = settings.unlimitedEntries ? 0 : Math.min(settings.maxEntries * 2, vaultIndex.length);
        const maxEntries = settings.unlimitedEntries ? 'as many as are relevant' : String(requestedEntries);
        let systemPrompt;
        if (settings.aiSearchSystemPrompt && settings.aiSearchSystemPrompt.trim()) {
            const userPrompt = settings.aiSearchSystemPrompt.trim();
            if (settings.aiSearchClaudeCodePrefix && settings.aiSearchConnectionMode === 'proxy') {
                systemPrompt = userPrompt.startsWith('You are Claude Code')
                    ? userPrompt
                    : 'You are Claude Code. ' + userPrompt;
            } else {
                systemPrompt = userPrompt;
            }
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

        // Build user message for AI — manifest FIRST (stable across turns) for prompt caching,
        // chat context LAST (changes every turn)
        const userMessageParts = [];
        if (candidateHeader) userMessageParts.push(`## Manifest Info\n${candidateHeader}`);
        userMessageParts.push(`## Available Lore Entries\n${candidateManifest}`);
        userMessageParts.push(`## Recent Chat\n${chatContext}`);
        const userMessage = userMessageParts.join('\n\n');

        let aiResults;

        if (settings.aiSearchConnectionMode === 'profile') {
            // ── Profile mode: call via ConnectionManagerRequestService ──
            const aiResult = await callViaProfile(systemPrompt, userMessage, settings.aiSearchMaxTokens, settings.aiSearchTimeout);
            clearTimeout(timeoutId);

            aiSearchStats.calls++;
            updateAiStats();

            const parsed = extractAiResponseClient(aiResult.text);
            if (!parsed) {
                if (settings.debugMode) console.warn('[DLE] AI search: could not parse response as JSON array');
                return { results: [], error: true };
            }
            // Normalize to structured format
            aiResults = parsed.map(item => {
                if (typeof item === 'string') return { title: item, confidence: 'medium', reason: 'AI search' };
                return { title: item.title || '', confidence: item.confidence || 'medium', reason: item.reason || 'AI search' };
            });
        } else {
            // ── Proxy mode: call via CORS proxy bridge ──
            // Manifest before chat context for prompt caching (stable prefix)
            const userMessageParts2 = [];
            if (candidateHeader) userMessageParts2.push(`## Manifest Info\n${candidateHeader}`);
            userMessageParts2.push(`## Available Lore Entries\n${candidateManifest}`);
            // Cache breakpoint: everything above is stable across turns
            const cacheBreakIndex = userMessageParts2.length;
            userMessageParts2.push(`## Recent Chat\n${chatContext}`);
            userMessageParts2.push('Select the relevant entries as a JSON array.');
            const proxyUserMessage = userMessageParts2.join('\n\n');

            // Build cache-aware user content for proxy mode
            const stablePrefix = userMessageParts2.slice(0, cacheBreakIndex).join('\n\n');
            const dynamicSuffix = userMessageParts2.slice(cacheBreakIndex).join('\n\n');

            const aiResult = await callProxyViaCorsBridge(
                settings.aiSearchProxyUrl,
                settings.aiSearchModel || 'claude-haiku-4-5-20251001',
                systemPrompt,
                proxyUserMessage,
                settings.aiSearchMaxTokens,
                settings.aiSearchTimeout,
                // Pass cache-aware content blocks for Anthropic prompt caching
                { stablePrefix, dynamicSuffix },
            );
            clearTimeout(timeoutId);

            aiSearchStats.calls++;
            if (aiResult.usage) {
                aiSearchStats.totalInputTokens += aiResult.usage.input_tokens || 0;
                aiSearchStats.totalOutputTokens += aiResult.usage.output_tokens || 0;
            }
            updateAiStats();

            const parsed = extractAiResponseClient(aiResult.text);
            if (!parsed) {
                if (settings.debugMode) console.warn('[DLE] AI search: could not parse proxy response as JSON array');
                return { results: [], error: true };
            }
            aiResults = parsed.map(item => {
                if (typeof item === 'string') return { title: item, confidence: 'medium', reason: 'AI search' };
                return { title: item.title || '', confidence: item.confidence || 'medium', reason: item.reason || 'AI search' };
            }).filter(r => r.title && r.title.trim() !== '' && r.title !== 'null' && r.title !== 'undefined');
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

        // Sort by confidence tier: high > medium > low (budget will naturally cut low-confidence)
        const confidenceOrder = { high: 0, medium: 1, low: 2 };
        results.sort((a, b) => (confidenceOrder[a.confidence] ?? 1) - (confidenceOrder[b.confidence] ?? 1));

        // Cache the results with sliding window metadata
        setAiSearchCache({
            hash: chatHash,
            manifestHash,
            chatLineCount: chatLines.length,
            results,
        });

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
