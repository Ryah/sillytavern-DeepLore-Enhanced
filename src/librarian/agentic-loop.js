/**
 * DeepLore Enhanced — Agentic Loop
 * Core state machine: SEARCH → FLAG → DONE.
 * Replaces ST's ToolManager-based tool calling with a DLE-owned generation loop.
 */
import {
    callWithTools, parseToolCalls, getTextContent, getUsage,
    buildAssistantMessage, buildToolResults, getProviderFormat,
} from './agentic-api.js';
import { searchLoreAction, flagLoreAction } from './librarian-tools.js';
import { getSettings } from '../../settings.js';
import {
    chatEpoch, generationLockEpoch,
    setGenerationLockTimestamp,
} from '../state.js';

// ════════════════════════════════════════════════════════════════════════════
// Tool Definitions (OpenAI function calling format)
// ════════════════════════════════════════════════════════════════════════════

const TOOL_SEARCH = {
    type: 'function',
    function: {
        name: 'search',
        description: 'Search the lore vault for entries not already in your context. Use when the conversation references characters, places, or concepts not covered by pre-selected lore.',
        parameters: {
            type: 'object',
            properties: {
                queries: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Topics, names, or concepts to search for (up to 4)',
                },
            },
            required: ['queries'],
        },
    },
};

const TOOL_WRITE = {
    type: 'function',
    function: {
        name: 'write',
        description: 'Submit your final prose/story response. The content argument IS your story text. Put ALL prose here, not in your text response.',
        parameters: {
            type: 'object',
            properties: {
                content: {
                    type: 'string',
                    description: 'Your complete prose/story response',
                },
            },
            required: ['content'],
        },
    },
};

const TOOL_FLAG = {
    type: 'function',
    function: {
        name: 'flag',
        description: 'Flag a lore gap or entry needing updates. Only flag genuine gaps where you had to invent or guess details that should exist in the vault.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Topic or concept name' },
                reason: { type: 'string', description: 'Why this gap matters' },
                urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
                flag_type: { type: 'string', enum: ['gap', 'update'] },
                entry_title: { type: 'string', description: 'Existing entry title (for update type)' },
            },
            required: ['title', 'reason'],
        },
    },
};

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const MAX_ITERATIONS = 15;
const MAX_FLAG_CALLS = 5;
const PHASE_SEARCH = 'SEARCH';
const PHASE_FLAG = 'FLAG';

// ════════════════════════════════════════════════════════════════════════════
// Main Loop
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run the agentic generation loop.
 * @param {object} options
 * @param {Array} options.messages - Initial messages array from buildChatMessages()
 * @param {number} options.maxSearches - Max search calls (from settings.librarianMaxSearches)
 * @param {boolean} options.searchEnabled - Whether search tool is available
 * @param {boolean} options.flagEnabled - Whether flag tool is available
 * @param {number} options.maxTokens - Max response tokens
 * @param {AbortSignal} options.signal - Abort signal for stop/chat-switch
 * @param {number} options.epoch - chatEpoch snapshot
 * @param {number} options.lockEpoch - generationLockEpoch snapshot
 * @param {function} options.onStatus - Status callback for UI
 * @param {function} options.onProse - Called with prose text when write() fires (for immediate display)
 * @param {Set<string>} options.injectedTitles - Titles already in context (lowercased)
 * @param {object} options.settings - DLE settings snapshot
 * @returns {Promise<{prose: string, toolActivity: Array, usage: {totalInput: number, totalOutput: number}, error?: string}>}
 */
export async function runAgenticLoop(options) {
    const {
        messages, maxSearches, searchEnabled, flagEnabled,
        maxTokens, signal, epoch, lockEpoch,
        onStatus, onProse, injectedTitles, settings,
    } = options;

    let phase = PHASE_SEARCH;
    let searchCount = 0;
    let flagCount = 0;
    let prose = null;
    let writeDone = false; // H4: double-write guard
    const toolActivity = [];
    const usage = { totalInput: 0, totalOutput: 0 };
    const debug = settings.debugMode;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        // Epoch guards — bail if chat changed or lock was force-released
        if (epoch !== chatEpoch || lockEpoch !== generationLockEpoch) {
            if (debug) console.debug('[DLE] Agentic loop: epoch mismatch, aborting');
            break;
        }
        if (signal.aborted) {
            const err = new Error('Agentic loop aborted');
            err.name = 'AbortError';
            throw err;
        }

        // Build available tools for this phase
        const tools = [];
        if (phase === PHASE_SEARCH) {
            // Write is always available in SEARCH phase
            tools.push(TOOL_WRITE);
            if (searchEnabled && searchCount < maxSearches) {
                tools.push(TOOL_SEARCH);
            }
        } else if (phase === PHASE_FLAG) {
            if (flagEnabled && flagCount < MAX_FLAG_CALLS) {
                tools.push(TOOL_FLAG);
            }
        }

        // No tools available = done
        if (tools.length === 0) break;

        // H1: Always use 'auto' — 'required'/'any' conflicts with thinking/extended thinking
        // on Claude and potentially Gemini. The system prompt already instructs the AI to
        // call write when it's the only available tool, so forcing is unnecessary.
        const toolChoice = 'auto';

        // C9: Keep generation lock alive before API call
        setGenerationLockTimestamp(Date.now());

        if (debug) console.debug(`[DLE] Agentic loop: iteration ${iteration}, phase=${phase}, tools=[${tools.map(t => t.function.name)}]`);

        // H8: FLAG phase is best-effort — prose is already delivered, so errors here
        // should not crash the generation. Wrap the entire FLAG iteration in try/catch.
        if (phase === PHASE_FLAG) {
            try {
                await _runFlagIteration(messages, tools, toolChoice, maxTokens, signal, toolActivity, settings, debug);
            } catch (flagErr) {
                if (flagErr?.name === 'AbortError') throw flagErr;
                console.warn('[DLE] Flag phase error (prose already delivered):', flagErr?.message || flagErr);
            }
            // FLAG phase always runs at most one iteration — break after
            break;
        }

        // SEARCH phase — errors here ARE fatal (no prose yet)
        const response = await callWithTools(messages, tools, toolChoice, maxTokens, signal);

        // Accumulate usage
        const responseUsage = getUsage(response);
        usage.totalInput += responseUsage.input_tokens;
        usage.totalOutput += responseUsage.output_tokens;

        // Parse tool calls from response
        const toolCalls = parseToolCalls(response);

        // No tool calls = AI ended its turn
        if (toolCalls.length === 0) {
            // Capture any text as fallback prose
            if (!prose) {
                const text = getTextContent(response);
                if (text?.trim()) prose = text;
            }
            break;
        }

        // Append assistant message to conversation (preserves provider-native format)
        const assistantMsg = buildAssistantMessage(response);
        messages.push(assistantMsg);

        // C9: Keep lock alive before processing tools
        setGenerationLockTimestamp(Date.now());

        // Process all tool calls, collect results
        const results = [];
        for (const tc of toolCalls) {
            switch (tc.name) {
                case 'search': {
                    if (phase !== PHASE_SEARCH || !searchEnabled) {
                        results.push({ id: tc.id, name: tc.name, result: 'Search is not available in this phase.' });
                        break;
                    }
                    if (searchCount >= maxSearches) {
                        results.push({ id: tc.id, name: tc.name, result: `Search limit reached (${maxSearches}). Use write to submit your response.` });
                        break;
                    }
                    searchCount++;
                    onStatus?.(`Searching\u2026 (${searchCount}/${maxSearches})`);

                    // Call the existing searchLoreAction — it handles BM25, gap tracking, analytics
                    const searchResult = await searchLoreAction({ queries: tc.input.queries || [] });
                    results.push({ id: tc.id, name: tc.name, result: searchResult });

                    // Record activity for dropdown — resultTitles required by librarian-ui.js
                    // Best hit uses `### title` format; linked entries use `<entry name="title">`
                    const headingTitles = [...(searchResult.matchAll(/^### (.+)$/gm) || [])]
                        .map(m => m[1]).filter(t => t !== 'Related entries:');
                    const entryTitles = [...(searchResult.matchAll(/name="([^"]+)"/g) || [])].map(m => m[1]);
                    const titleMatches = [...headingTitles, ...entryTitles];
                    toolActivity.push({
                        type: 'search',
                        query: (tc.input.queries || []).join(', '),
                        resultCount: titleMatches.length,
                        resultTitles: titleMatches,
                        timestamp: Date.now(),
                    });
                    break;
                }

                case 'write': {
                    // H4: Double-write guard
                    if (writeDone) {
                        results.push({ id: tc.id, name: tc.name, result: 'Error: Response already submitted. Use flag to record any issues, then end your turn.' });
                        break;
                    }
                    prose = tc.input.content || '';
                    writeDone = true;
                    phase = PHASE_FLAG; // Phase transition

                    // H7: Show prose to user immediately — flagging is a silent wrap-up.
                    // Status is cleared by the onProse callback (which calls _removePipelineStatus).
                    // Awaited so saveReply + saveChatConditional complete before FLAG phase.
                    await onProse?.(prose);

                    // Return flagging instructions as the tool result
                    const flagInstructions = buildFlaggingInstructions(settings);
                    results.push({ id: tc.id, name: tc.name, result: flagInstructions });
                    break;
                }

                case 'flag': {
                    // Edge case: AI called write + flag in the same response.
                    // Phase is now FLAG (set by write above), handle inline.
                    if (phase !== PHASE_FLAG || !flagEnabled) {
                        results.push({ id: tc.id, name: tc.name, result: 'Flag is not available yet. Call write first.' });
                        break;
                    }
                    const flagResult = await flagLoreAction(tc.input || {});
                    results.push({ id: tc.id, name: tc.name, result: flagResult || 'Flag recorded.' });
                    toolActivity.push({
                        type: 'flag',
                        query: tc.input?.title || '',
                        subtype: tc.input?.flag_type || 'gap',
                        urgency: tc.input?.urgency || 'medium',
                        timestamp: Date.now(),
                    });
                    break;
                }

                default:
                    results.push({ id: tc.id, name: tc.name, result: `Unknown tool: ${tc.name}` });
            }
        }

        // C4: Batch ALL tool results into one message (or array for OpenAI)
        const toolResultMsg = buildToolResults(results);
        if (Array.isArray(toolResultMsg)) {
            messages.push(...toolResultMsg);
        } else {
            messages.push(toolResultMsg);
        }
    }

    // Fallback: if write was never called but there's text content in the last response
    if (!prose) {
        if (debug) console.debug('[DLE] Agentic loop: no write() call detected, checking for text fallback');
    }

    return { prose: prose || '', toolActivity, usage };
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run a single FLAG phase iteration. Best-effort — errors are caught by the caller.
 * Loops internally to handle multiple flag calls from one response.
 * @param {Array} messages - Conversation messages (mutated)
 * @param {Array} tools - Available tools (just TOOL_FLAG)
 * @param {string} toolChoice - Tool choice string
 * @param {number} maxTokens - Max tokens
 * @param {AbortSignal} signal - Abort signal
 * @param {Array} toolActivity - Activity log (mutated)
 * @param {object} settings - DLE settings
 * @param {boolean} debug - Debug mode
 */
async function _runFlagIteration(messages, tools, toolChoice, maxTokens, signal, toolActivity, settings, debug) {
    const response = await callWithTools(messages, tools, toolChoice, maxTokens, signal);
    const toolCalls = parseToolCalls(response);
    if (toolCalls.length === 0) return; // AI chose not to flag — done

    const assistantMsg = buildAssistantMessage(response);
    messages.push(assistantMsg);

    const results = [];
    let flagCount = 0;
    for (const tc of toolCalls) {
        if (tc.name !== 'flag' || flagCount >= MAX_FLAG_CALLS) {
            results.push({ id: tc.id, name: tc.name, result: 'End your turn now.' });
            continue;
        }
        flagCount++;
        const flagResult = await flagLoreAction(tc.input || {});
        results.push({ id: tc.id, name: tc.name, result: flagResult || 'Flag recorded.' });
        toolActivity.push({
            type: 'flag',
            query: tc.input?.title || '',
            subtype: tc.input?.flag_type || 'gap',
            urgency: tc.input?.urgency || 'medium',
            timestamp: Date.now(),
        });
    }
    // Send results back (not continuing the loop — one flag iteration only)
    const toolResultMsg = buildToolResults(results);
    if (Array.isArray(toolResultMsg)) {
        messages.push(...toolResultMsg);
    } else {
        messages.push(toolResultMsg);
    }
    if (debug) console.debug(`[DLE] Flag phase: processed ${flagCount} flag(s)`);
}

/**
 * Build flagging instructions returned as the write() tool result.
 * Tells the AI what flag types are available and how to use them.
 * @param {object} settings - DLE settings
 * @returns {string}
 */
function buildFlaggingInstructions(settings) {
    const flagEnabled = settings.librarianFlagEnabled !== false;

    if (!flagEnabled) {
        return 'Response recorded. Your turn is complete \u2014 end now.';
    }

    return [
        'Response recorded successfully.',
        '',
        'If you noticed any lore gaps or entries that need updating, use the flag tool now.',
        'Flag types:',
        '- **gap**: Missing lore \u2014 you had to invent or guess a detail that should exist in the vault.',
        '- **update**: Existing entry is outdated, incomplete, or contradicts what happened in the story.',
        '',
        'Urgency levels: low (minor), medium (noticeable gap), high (major inconsistency).',
        '',
        'If nothing to flag, end your turn now.',
    ].join('\n');
}
