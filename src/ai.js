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
    trackerKey, setAiSearchCache, entityNameSet, entityShortNameRegexes, consecutiveInjections,
} from './state.js';
import { updateAiStats } from './settings-ui.js';
// Re-export pure functions from helpers.js (moved there for testability in Node.js)
export { extractAiResponseClient, clusterEntries, buildCategoryManifest } from './helpers.js';

// extractAiResponseClient — imported from ./helpers.js

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

    // Validate profile exists before making the API call
    try {
        const profile = ConnectionManagerRequestService.getProfile(resolvedProfileId);
        if (!profile) throw new Error(`Connection profile not found. Select one in AI Search settings, or create one in SillyTavern's Connection Manager.`);
    } catch (e) {
        if (e.message.includes('not found') || e.message.includes('Connection Manager')) throw e;
        throw new Error(`Connection profile not found or invalid. Select one in AI Search settings, or create one in SillyTavern's Connection Manager.`);
    }

    // Some providers (e.g. Anthropic) require system prompt separately, not as a message.
    // ConnectionManagerRequestService handles this via the options parameter.
    // Pass system as first user message with clear framing as fallback for providers that
    // don't extract system messages, while also providing it in options for those that do.
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
            usage: {
                input_tokens: result.usage?.input_tokens || result.usage?.prompt_tokens || 0,
                output_tokens: result.usage?.output_tokens || result.usage?.completion_tokens || 0,
            },
        };
    } catch (err) {
        // Enhance error with profile context for diagnosability
        const profileLabel = resolvedProfileId ? ` [profile: ${resolvedProfileId}]` : '';
        const modelLabel = resolvedModel ? ` [model: ${resolvedModel}]` : '';
        if (err.name === 'AbortError') {
            throw new Error(`Request timed out (${Math.round(timeout / 1000)}s)${profileLabel}${modelLabel}`);
        }
        throw new Error(`${err.message}${profileLabel}${modelLabel}`);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Populate a profile dropdown with saved Connection Manager profiles.
 * @param {string} selectElementId - DOM id of the <select> element
 * @param {string} settingsKey - Settings property holding the current profile ID
 */
export function populateProfileDropdown(selectElementId, settingsKey) {
    const select = document.getElementById(selectElementId);
    if (!select) return;

    const settings = getSettings();
    const currentId = settings[settingsKey];

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
 * Update visibility of connection fields based on connection mode.
 *
 * @param {object} config
 * @param {string} config.modeSettingsKey - Settings key for the connection mode value
 * @param {string} config.profileRowSelector - jQuery selector for the profile row
 * @param {string} config.proxyRowSelector - jQuery selector for the proxy row
 * @param {string} [config.modelInputSelector] - jQuery selector for the model input (for placeholder updates)
 * @param {string} [config.profileIdSettingsKey] - Settings key for the profile ID (for model hint lookup)
 * @param {string[]} [config.externalOnlySelectors] - jQuery selectors to show only when mode is profile or proxy (not 'st')
 * @param {boolean} [config.hasStMode=false] - Whether this feature supports an 'st' mode (3-way: st/profile/proxy)
 */
export function updateConnectionVisibility(config) {
    const settings = getSettings();
    const mode = settings[config.modeSettingsKey] || (config.hasStMode ? 'st' : 'profile');
    const isProfile = mode === 'profile';
    const isProxy = mode === 'proxy';

    $(config.profileRowSelector).toggle(isProfile);
    $(config.proxyRowSelector).toggle(isProxy);

    // Show/hide rows that only apply to external (non-ST) modes
    if (config.externalOnlySelectors) {
        const isExternal = isProfile || isProxy;
        for (const sel of config.externalOnlySelectors) {
            $(sel).toggle(isExternal);
        }
    }

    // Update model placeholder based on mode
    if (config.modelInputSelector) {
        const modelInput = $(config.modelInputSelector);
        if (isProfile) {
            let hint = '';
            if (config.profileIdSettingsKey) {
                try {
                    const profileId = settings[config.profileIdSettingsKey];
                    if (profileId) {
                        const profile = ConnectionManagerRequestService.getProfile(profileId);
                        hint = profile.model || '';
                    }
                } catch { /* noop */ }
            }
            modelInput.attr('placeholder', hint ? `Profile: ${hint}` : 'Leave empty to use profile model');
        } else if (isProxy) {
            modelInput.attr('placeholder', 'claude-haiku-4-5-20251001');
        }
    }
}

// ── Convenience wrappers (preserve call-site readability) ──

/** Populate the AI Search profile dropdown. */
export function populateAiProfileDropdown() {
    populateProfileDropdown('dle_ai_profile_select', 'aiSearchProfileId');
}

/** Populate the Session Scribe profile dropdown. */
export function populateScribeProfileDropdown() {
    populateProfileDropdown('dle_scribe_profile_select', 'scribeProfileId');
}

/** Populate the Auto Lorebook profile dropdown. */
export function populateAutoSuggestProfileDropdown() {
    populateProfileDropdown('dle_autosuggest_profile', 'autoSuggestProfileId');
}

/** Update AI Search connection field visibility. */
export function updateAiConnectionVisibility() {
    updateConnectionVisibility({
        modeSettingsKey: 'aiSearchConnectionMode',
        profileRowSelector: '#dle_ai_profile_row',
        proxyRowSelector: '#dle_ai_proxy_row',
        modelInputSelector: '#dle_ai_model',
        profileIdSettingsKey: 'aiSearchProfileId',
    });
}

/** Update Session Scribe connection field visibility. */
export function updateScribeConnectionVisibility() {
    updateConnectionVisibility({
        modeSettingsKey: 'scribeConnectionMode',
        profileRowSelector: '#dle_scribe_profile_row',
        proxyRowSelector: '#dle_scribe_proxy_row',
        modelInputSelector: '#dle_scribe_model',
        profileIdSettingsKey: 'scribeProfileId',
        externalOnlySelectors: ['#dle_scribe_model_row', '#dle_scribe_advanced_row'],
        hasStMode: true,
    });
}

/** Update Auto Lorebook connection field visibility. */
export function updateAutoSuggestConnectionVisibility() {
    updateConnectionVisibility({
        modeSettingsKey: 'autoSuggestConnectionMode',
        profileRowSelector: '#dle_autosuggest_profile_container',
        proxyRowSelector: '#dle_autosuggest_proxy_container',
    });
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
            const safeSummary = summaryText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const links = entry.resolvedLinks && entry.resolvedLinks.length > 0
                ? ` → ${entry.resolvedLinks.join(', ')}`
                : '';
            // Decay/freshness annotation: hint to AI about stale or frequently-injected entries
            let decayHint = '';
            if (settings.decayEnabled && decayTracker.size > 0) {
                const staleness = decayTracker.get(trackerKey(entry));
                if (staleness !== undefined && staleness >= settings.decayBoostThreshold) {
                    decayHint = ' [STALE — consider refreshing]';
                }
                // Penalty: entries injected many consecutive times get a nudge.
                if (!decayHint && settings.decayPenaltyThreshold > 0) {
                    const streak = consecutiveInjections.get(trackerKey(entry));
                    if (streak !== undefined && streak >= settings.decayPenaltyThreshold) {
                        decayHint = ' [FREQUENT — consider diversifying]';
                    }
                }
            }
            // Escape XML-like characters in title to prevent prompt structure injection
            const safeTitle = entry.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const header = `${safeTitle} (${entry.tokenEstimate}tok)${links}${decayHint}`;

            // Wrap each entry in structural delimiters to prevent summary content
            // from being interpreted as manifest-level instructions
            return `<entry name="${safeTitle}">\n${header}\n${safeSummary}\n</entry>`;
        })
        .join('\n');

    const totalSelectable = selectable.length;
    const forcedCount = candidates.length - selectable.length;
    let forcedTokens = 0;
    for (const e of candidates) { if (isForceInjected(e)) forcedTokens += e.tokenEstimate; }
    const budgetInfo = settings.unlimitedBudget
        ? ''
        : `\nToken budget: ~${settings.maxTokensBudget} tokens total.`;

    const header = `Candidate entries: ${selectable.length} (from ${totalSelectable} total).`
        + (forcedCount > 0 ? `\n${forcedCount} entries are always included (~${forcedTokens} tokens).` : '')
        + budgetInfo;

    return { manifest, header };
}

// clusterEntries, buildCategoryManifest — imported from ./helpers.js

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
    const isForceInjected = e => e.constant || (e.bootstrap && chat.length <= settings.newChatThreshold);
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
        let usage;
        if (settings.aiSearchConnectionMode === 'profile') {
            const result = await callViaProfile(categoryPrompt, categoryUserMessage, 512, settings.aiSearchTimeout);
            responseText = result.text;
            usage = result.usage;
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
            usage = result.usage;
        }

        aiSearchStats.calls++;
        if (usage) {
            aiSearchStats.totalInputTokens += usage.input_tokens || 0;
            aiSearchStats.totalOutputTokens += usage.output_tokens || 0;
        }
        updateAiStats();

        const parsed = extractAiResponseClient(responseText);
        if (!parsed || parsed.length === 0) return null;

        // parsed should be an array of category name strings
        const selectedCategories = new Set(
            parsed.map(item => (typeof item === 'string' ? item : item.title || item.name || '').toLowerCase()).filter(Boolean),
        );

        if (selectedCategories.size === 0) return null;

        // Filter candidates to only those in selected categories
        // Fuzzy match: check if any selected category is a substring or the entry's category is a substring
        const filtered = selectable.filter(entry => {
            const category = (entry.tags && entry.tags.length > 0) ? entry.tags[0].toLowerCase() : 'uncategorized';
            return [...selectedCategories].some(sc => category.includes(sc) || sc.includes(category));
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
 * @param {VaultEntry[]} [snapshot] - Vault index snapshot (avoids stale global reads after await)
 * @returns {Promise<{ results: AiSearchMatch[], error: boolean }>}
 */
export async function aiSearch(chat, candidateManifest, candidateHeader, snapshot) {
    const settings = getSettings();

    if (!settings.aiSearchEnabled || !candidateManifest) {
        return { results: [], error: false };
    }

    let chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);
    if (!chatContext.trim()) return { results: [], error: false };

    // Prepend seed entry content as story context on new chats
    const isNewChat = chat.length <= settings.newChatThreshold;
    if (isNewChat) {
        const seedEntries = (snapshot || vaultIndex).filter(e => e.seed);
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
    const settingsKey = `${settings.aiSearchMode}|${settings.aiSearchScanDepth}|${settings.maxEntries}|${settings.unlimitedEntries}|${settings.aiSearchSystemPrompt?.length || 0}|${settings.aiSearchConnectionMode}|${settings.aiSearchProfileId}|${settings.aiSearchModel}`;
    const manifestHash = simpleHash(settingsKey + candidateManifest);
    const chatHash = simpleHash(chatContext);
    // Defer chatLines split until after exact cache hit check (avoid unnecessary work)
    let chatLines = null;
    const getChatLines = () => { if (!chatLines) chatLines = chatContext.split('\n').filter(l => l.trim()); return chatLines; };

    // Resolve cached title-based results back to current VaultEntry objects
    const resolveCachedResults = (cached) => {
        const indexToSearch = snapshot || vaultIndex;
        const titleMap = new Map(indexToSearch.map(e => [e.title.toLowerCase(), e]));
        return cached
            .map(r => ({ entry: titleMap.get(r.title.toLowerCase()), confidence: r.confidence, reason: r.reason }))
            .filter(r => r.entry);
    };

    if (aiSearchCache.hash === chatHash && aiSearchCache.manifestHash === manifestHash && aiSearchCache.results.length > 0) {
        // Exact match — nothing changed at all
        aiSearchStats.cachedHits++;
        updateAiStats();
        if (settings.debugMode) console.debug('[DLE] AI search cache hit (exact)');
        return { results: resolveCachedResults(aiSearchCache.results), error: false };
    }

    // Sliding window: manifest unchanged + only newest message(s) differ
    if (aiSearchCache.manifestHash === manifestHash
        && aiSearchCache.results.length > 0
        && aiSearchCache.chatLineCount > 0
        && getChatLines().length > aiSearchCache.chatLineCount) {
        // Extract only the new lines added since last cache
        const newLines = getChatLines().slice(aiSearchCache.chatLineCount);
        const newText = newLines.join(' ').toLowerCase();

        // Check if any vault entry title or key appears in the new text (word-boundary match)
        // Uses pre-computed entityNameSet from buildIndex (titles min 1 char, keys min 2 chars)
        let hasNewEntityMention = false;
        for (const name of entityNameSet) {
            // Use pre-compiled word boundary regex for short names to avoid false positives
            // (e.g. "an" matching inside "want", "Kai" matching inside "okay")
            if (name.length <= 3) {
                const regex = entityShortNameRegexes.get(name);
                if (regex && regex.test(newText)) {
                    hasNewEntityMention = true;
                    break;
                }
            } else if (newText.includes(name)) {
                hasNewEntityMention = true;
                break;
            }
        }

        if (!hasNewEntityMention) {
            aiSearchStats.cachedHits++;
            updateAiStats();
            if (settings.debugMode) console.debug(`[DLE] AI search cache hit (sliding window: ${newLines.length} new lines, no entity mentions)`);
            return { results: resolveCachedResults(aiSearchCache.results), error: false };
        }
    }

    try {
        // Resolve system prompt with {{maxEntries}} placeholder
        // Request 2x max entries so low-confidence candidates can fill remaining budget
        const indexToUse = snapshot || vaultIndex;
        const requestedEntries = settings.unlimitedEntries ? 0 : Math.min(settings.maxEntries * 2, indexToUse.length);
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
            const constantCount = indexToUse.filter(e => e.constant).length;
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
            // (timeout handled internally by callViaProfile/callProxyViaCorsBridge)

            aiSearchStats.calls++;
            if (aiResult.usage) {
                aiSearchStats.totalInputTokens += aiResult.usage.input_tokens || 0;
                aiSearchStats.totalOutputTokens += aiResult.usage.output_tokens || 0;
            }
            updateAiStats();

            const parsed = extractAiResponseClient(aiResult.text);
            if (!parsed) {
                if (settings.debugMode) console.warn('[DLE] AI search: could not parse response as JSON array');
                return { results: [], error: true };
            }
            // Normalize to structured format
            aiResults = parsed.map(item => {
                if (typeof item === 'string') return { title: item, confidence: 'medium', reason: 'AI search' };
                return { title: item.title || item.name || '', confidence: item.confidence || 'medium', reason: item.reason || 'AI search' };
            }).filter(r => r.title && r.title.trim() !== '' && r.title !== 'null' && r.title !== 'undefined');
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
            // (timeout handled internally by callViaProfile/callProxyViaCorsBridge)

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
                return { title: item.title || item.name || '', confidence: item.confidence || 'medium', reason: item.reason || 'AI search' };
            }).filter(r => r.title && r.title.trim() !== '' && r.title !== 'null' && r.title !== 'undefined');
        }

        // Map returned results back to VaultEntry objects with confidence/reason
        const aiResultMap = new Map();
        for (const r of aiResults) {
            aiResultMap.set(r.title.toLowerCase(), r);
        }

        /** @type {AiSearchMatch[]} */
        const results = [];
        const indexToSearch = snapshot || vaultIndex;
        for (const entry of indexToSearch) {
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

        // Cache results by title (not entry reference) to survive index rebuilds
        setAiSearchCache({
            hash: chatHash,
            manifestHash,
            chatLineCount: getChatLines().length,
            results: results.map(r => ({ title: r.entry.title, confidence: r.confidence, reason: r.reason })),
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
        if (err.name === 'AbortError') {
            console.warn('[DLE] AI search timed out');
        } else {
            console.error('[DLE] AI search error:', err);
        }
        return { results: [], error: true };
    }
}
