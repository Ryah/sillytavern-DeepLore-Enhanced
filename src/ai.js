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
    vaultIndex, aiSearchCache, aiSearchStats,
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
            const header = `${entry.title} (${entry.tokenEstimate}tok)${links}`;

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

    // Check cache - skip API call if inputs haven't changed (include mode in key to avoid collisions)
    const cacheKey = simpleHash(settings.aiSearchMode + chatContext + candidateManifest);
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

        // Build user message for AI (same format regardless of connection mode)
        const userMessageParts = [];
        if (candidateHeader) userMessageParts.push(`## Manifest Info\n${candidateHeader}`);
        userMessageParts.push(`## Recent Chat\n${chatContext}`);
        userMessageParts.push(`## Available Lore Entries\n${candidateManifest}`);
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
            const userMessageParts2 = [];
            if (candidateHeader) userMessageParts2.push(`## Manifest Info\n${candidateHeader}`);
            userMessageParts2.push(`## Recent Chat\n${chatContext}`);
            userMessageParts2.push(`## Available Lore Entries\n${candidateManifest}`);
            userMessageParts2.push('Select the relevant entries as a JSON array.');
            const proxyUserMessage = userMessageParts2.join('\n\n');

            const aiResult = await callProxyViaCorsBridge(
                settings.aiSearchProxyUrl,
                settings.aiSearchModel || 'claude-haiku-4-5-20251001',
                systemPrompt,
                proxyUserMessage,
                settings.aiSearchMaxTokens,
                settings.aiSearchTimeout,
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

        // Cache the results
        setAiSearchCache({ hash: cacheKey, results });

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
