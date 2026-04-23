/**
 * DeepLore Enhanced — Agentic Loop API Layer
 * Wraps ConnectionManagerRequestService for tool-calling requests.
 * Handles 4 provider formats: Claude, Google (Gemini/Vertex), OpenAI-compatible, Cohere.
 * Supports proxy mode (direct Anthropic Messages API via CORS bridge).
 */
import { ConnectionManagerRequestService } from '../../../../shared.js';
import { oai_settings } from '../../../../../openai.js';
import { main_api, amount_gen } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { resolveConnectionConfig } from '../../settings.js';
import { validateProxyUrl } from '../ai/proxy-api.js';

// ════════════════════════════════════════════════════════════════════════════
// Provider Detection
// ════════════════════════════════════════════════════════════════════════════

/** No-tool-calling providers (chat completion sources that don't support tools). */
const NO_TOOLS_SOURCES = new Set([
    'ai21', 'perplexity', 'nanogpt', 'pollinations', 'moonshot',
]);

/**
 * Get the resolved Librarian connection mode.
 * @returns {'proxy'|'profile'|'inherit'}
 */
function getLibrarianMode() {
    return resolveConnectionConfig('librarian').mode;
}

/**
 * Check if the current connection supports tool calling.
 * Proxy mode always supports tools (Anthropic Messages API).
 * Profile mode checks the main ST chat completion source.
 * @returns {boolean}
 */
export function isToolCallingSupported() {
    if (getLibrarianMode() === 'proxy') {
        // Pre-validate proxy config so dispatch doesn't start an agentic loop that
        // would throw mid-flight via validateProxyUrl, after abort() + button-flip.
        const cfg = resolveConnectionConfig('librarian');
        if (!cfg.proxyUrl || !cfg.model) return false;
        return true;
    }
    if (main_api !== 'openai') return false;
    const source = oai_settings?.chat_completion_source;
    if (!source) return false;
    return !NO_TOOLS_SOURCES.has(source);
}

/**
 * Get the provider message format based on connection mode.
 * Proxy mode always uses Claude format.
 * @returns {'claude'|'google'|'openai'}
 */
export function getProviderFormat() {
    if (getLibrarianMode() === 'proxy') return 'claude';
    const source = oai_settings?.chat_completion_source;
    if (source === 'claude') return 'claude';
    if (source === 'makersuite' || source === 'vertexai') return 'google';
    return 'openai';
}

/**
 * Get max response tokens.
 * Proxy mode uses the Librarian's configured maxTokens.
 * Profile mode uses the active ST preset.
 * @returns {number}
 */
export function getActiveMaxTokens() {
    if (getLibrarianMode() === 'proxy') {
        const config = resolveConnectionConfig('librarian');
        return config.maxTokens || 4096;
    }
    return main_api === 'openai'
        ? (oai_settings?.openai_max_tokens || 300)
        : (amount_gen || 300);
}

/**
 * Get the active ST connection profile ID (the user's main chat connection).
 * Used only in profile mode — proxy mode bypasses ConnectionManagerRequestService.
 * @returns {string}
 * @throws {Error} If no profile is selected
 */
export function getActiveProfileId() {
    const ctx = getContext();
    const profileId = ctx.extensionSettings?.connectionManager?.selectedProfile;
    if (!profileId) {
        throw new Error('No active connection profile selected in SillyTavern. Select one in the Connection Manager.');
    }
    return profileId;
}

// ════════════════════════════════════════════════════════════════════════════
// API Call
// ════════════════════════════════════════════════════════════════════════════

/**
 * Convert OpenAI function-calling tool definitions to Anthropic format.
 * @param {Array<object>} tools - [{type:'function', function:{name, description, parameters}}]
 * @returns {Array<object>} [{name, description, input_schema}]
 */
function toAnthropicTools(tools) {
    return tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
    }));
}

/**
 * Convert a tool_choice string to Anthropic format.
 * @param {string|object|null} toolChoice
 * @returns {object|undefined}
 */
function toAnthropicToolChoice(toolChoice) {
    if (toolChoice == null) return undefined;
    if (typeof toolChoice === 'string') {
        const map = { auto: 'auto', required: 'any', none: 'none' };
        return { type: map[toolChoice] || 'auto' };
    }
    return toolChoice;
}

/**
 * Send a tool-calling request directly to an Anthropic-compatible proxy via CORS bridge.
 * Used when the Librarian connection mode is 'proxy'.
 * @param {object} connConfig - Resolved connection config {proxyUrl, model, maxTokens, timeout}
 * @param {Array<{role: string, content: any}>} messages - Chat messages (may include system at [0])
 * @param {Array<object>} tools - Tool definitions (OpenAI function calling format)
 * @param {string|object|null} toolChoice - Tool choice
 * @param {number} maxTokens - Max response tokens
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<object>} Raw Anthropic API response
 */
async function callWithToolsViaProxy(connConfig, messages, tools, toolChoice, maxTokens, signal) {
    const { proxyUrl, model, timeout = 120000 } = connConfig;
    validateProxyUrl(proxyUrl);

    if (!model) throw new Error('Librarian proxy mode requires a model name. Set it in DLE Librarian settings.');

    // Extract system message(s) from the messages array
    let systemContent = [];
    const apiMessages = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            systemContent.push({ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } });
        } else {
            apiMessages.push(msg);
        }
    }

    const targetUrl = proxyUrl.replace(/\/+$/, '') + '/v1/messages';
    const corsProxyUrl = `/proxy/${encodeURIComponent(targetUrl)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let onExternalAbort = null;

    if (signal) {
        if (signal.aborted) {
            controller.abort();
        } else {
            onExternalAbort = () => controller.abort();
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }

    const body = {
        model,
        max_tokens: maxTokens,
        ...(systemContent.length > 0 && { system: systemContent }),
        messages: apiMessages,
        tools: toAnthropicTools(tools),
    };
    const anthropicToolChoice = toAnthropicToolChoice(toolChoice);
    if (anthropicToolChoice) body.tool_choice = anthropicToolChoice;

    try {
        const response = await fetch(corsProxyUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            const text = await response.text();
            if (response.status === 404 && text.includes('CORS proxy is disabled')) {
                throw new Error('SillyTavern CORS proxy is not enabled. Set enableCorsProxy: true in config.yaml, or use a Connection Profile instead of Custom Proxy mode.');
            }
            const safeText = text.substring(0, 200)
                .replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***')
                .replace(/Bearer\s+[A-Za-z0-9_\-./]{10,}/g, 'Bearer ***');
            throw new Error(`Proxy returned HTTP ${response.status}: ${safeText}`);
        }

        const text = await response.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            throw new Error(`Failed to parse proxy response as JSON: ${e.message}`);
        }
        if (parsed.error) {
            throw new Error(parsed.error.message || JSON.stringify(parsed.error));
        }

        // Return raw Anthropic response — parseToolCalls/getTextContent/getUsage handle Claude format
        return parsed;
    } catch (err) {
        if (err.name === 'AbortError') {
            if (signal?.aborted) {
                const abortErr = new Error('Request aborted by user');
                abortErr.name = 'AbortError';
                abortErr.userAborted = true;
                throw abortErr;
            }
            const timeoutErr = new Error(`Proxy request timed out (${Math.round(timeout / 1000)}s)`, { cause: err });
            timeoutErr.name = 'AbortError';
            timeoutErr.timedOut = true;
            throw timeoutErr;
        }
        throw err;
    } finally {
        if (signal && onExternalAbort) signal.removeEventListener('abort', onExternalAbort);
        clearTimeout(timer);
    }
}

/**
 * Send a tool-calling request. Routes to proxy or ConnectionManager based on Librarian config.
 * @param {Array<{role: string, content: any}>} messages - Chat messages array
 * @param {Array<object>} tools - Tool definitions (OpenAI function calling format)
 * @param {string|object|null} toolChoice - Tool choice ('auto', 'required', or provider-specific)
 * @param {number} maxTokens - Max response tokens
 * @param {AbortSignal} signal - Abort signal
 * @returns {Promise<object>} Raw API response (extractData: false)
 */
export async function callWithTools(messages, tools, toolChoice, maxTokens, signal) {
    // Proxy mode: direct Anthropic Messages API with native tool calling
    const connConfig = resolveConnectionConfig('librarian');
    if (connConfig.mode === 'proxy') {
        return callWithToolsViaProxy(connConfig, messages, tools, toolChoice, maxTokens, signal);
    }

    // Profile mode: route through ST's ConnectionManagerRequestService
    const format = getProviderFormat();

    // Normalize tool_choice for provider-specific formats.
    // ST's server wraps the value for each provider — we must match what each backend expects.
    // Claude backend: `{ type: request.body.tool_choice }` — expects a Claude type string.
    // Google backend: does its own mapping from OpenAI strings.
    // OpenAI/others: pass through as-is.
    let normalizedToolChoice = toolChoice;
    if (typeof toolChoice === 'string') {
        if (format === 'claude') {
            // ST wraps in {type: X}, so pass Claude's raw type strings ('auto'|'any'|'none')
            const claudeModeMap = { auto: 'auto', required: 'any', none: 'none' };
            normalizedToolChoice = claudeModeMap[toolChoice] || 'auto';
        } else if (format === 'google') {
            // G6: Google Gemini uses {mode: 'AUTO'|'ANY'|'NONE'}
            const geminiModeMap = { auto: 'AUTO', required: 'ANY', none: 'NONE' };
            normalizedToolChoice = { mode: geminiModeMap[toolChoice] || 'AUTO' };
        }
        // OpenAI/Cohere: string values ('auto', 'required', 'none') pass through as-is
    }

    const overridePayload = {
        tools,
        ...(normalizedToolChoice != null && { tool_choice: normalizedToolChoice }),
    };

    const result = await ConnectionManagerRequestService.sendRequest(
        getActiveProfileId(),
        messages,
        maxTokens,
        {
            stream: false,
            signal,
            extractData: false,
            includePreset: true,
            includeInstruct: true,
        },
        overridePayload,
    );

    return result;
}

// ════════════════════════════════════════════════════════════════════════════
// Response Parsing (replicates ST's private ToolManager.#getToolCallsFromData)
// ════════════════════════════════════════════════════════════════════════════

/** Safely parse tool call arguments, falling back on malformed JSON. */
function safeParseArgs(args, fallbackInput) {
    if (typeof args === 'string') {
        try { return JSON.parse(args); }
        catch { console.warn('[DLE] Malformed tool call arguments, skipping:', args.slice(0, 200)); }
    }
    return args || fallbackInput || {};
}

/**
 * Extract tool calls from a raw API response.
 * Handles 4 provider formats, normalizes to [{id, name, input}].
 * @param {object} data - Raw API response
 * @returns {Array<{id: string, name: string, input: object}>}
 */
export function parseToolCalls(data) {
    if (!data) return [];

    // 1. Claude: data.content[].type === 'tool_use'
    if (Array.isArray(data.content)) {
        const toolUses = data.content.filter(c => c.type === 'tool_use');
        if (toolUses.length > 0) {
            return toolUses.map(t => ({
                id: t.id,
                name: t.name,
                input: t.input || {},
            }));
        }
    }

    // 2. Google Gemini/Vertex: data.responseContent.parts[].functionCall
    if (data.responseContent?.parts) {
        const functionCalls = data.responseContent.parts.filter(p => p.functionCall);
        if (functionCalls.length > 0) {
            return functionCalls.map(p => ({
                id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                name: p.functionCall.name,
                input: p.functionCall.args || {},
            }));
        }
    }

    // 3. OpenAI-compatible: data.choices[0].message.tool_calls
    if (data.choices?.[0]?.message?.tool_calls) {
        return data.choices[0].message.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: safeParseArgs(tc.function?.arguments, tc.input),
        }));
    }

    // 4. Cohere: data.message.tool_calls
    if (data.message?.tool_calls) {
        return data.message.tool_calls.map(tc => ({
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: safeParseArgs(tc.function?.arguments, tc.input),
        }));
    }

    return [];
}

/**
 * Extract text content from a raw API response (excluding tool calls).
 * @param {object} data - Raw API response
 * @returns {string}
 */
export function getTextContent(data) {
    if (!data) return '';

    // Claude: text blocks in content array
    if (Array.isArray(data.content)) {
        const textBlocks = data.content.filter(b => b.type === 'text');
        if (textBlocks.length > 0) return textBlocks.map(b => b.text).join('');
    }

    // Google: text parts
    if (data.responseContent?.parts) {
        const textParts = data.responseContent.parts.filter(p => p.text != null);
        if (textParts.length > 0) return textParts.map(p => p.text).join('');
    }

    // OpenAI-compatible
    if (data.choices?.[0]?.message?.content != null) {
        return data.choices[0].message.content;
    }

    // Cohere
    if (data.message?.content?.[0]?.text != null) {
        return data.message.content[0].text;
    }

    return '';
}

/**
 * Extract usage statistics from a raw API response.
 * @param {object} data - Raw API response
 * @returns {{input_tokens: number, output_tokens: number}}
 */
export function getUsage(data) {
    if (!data) return { input_tokens: 0, output_tokens: 0 };

    const u = data.usage || data.usageMetadata || {};
    return {
        input_tokens: u.input_tokens || u.prompt_tokens || u.promptTokenCount || 0,
        output_tokens: u.output_tokens || u.completion_tokens || u.candidatesTokenCount || 0,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// Message Building (provider-native formats for multi-turn tool conversations)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the assistant message for multi-turn conversation.
 * Preserves provider-native format so the API sees its own output format.
 * @param {object} data - Raw API response
 * @returns {object} Message object to append to messages array
 */
export function buildAssistantMessage(data) {
    const format = getProviderFormat();

    if (format === 'claude') {
        return { role: 'assistant', content: data.content };
    }

    if (format === 'google') {
        return { role: 'model', parts: data.responseContent?.parts || [] };
    }

    // OpenAI / Cohere
    const msg = data.choices?.[0]?.message || data.message;
    const result = { role: 'assistant' };
    if (msg?.content) result.content = msg.content;
    if (msg?.tool_calls) result.tool_calls = msg.tool_calls;
    return result;
}

/**
 * Build tool result message(s) for ALL tool calls in one assistant turn.
 * C4: Claude requires all tool_result blocks in ONE user message.
 * @param {Array<{id: string, name: string, result: string}>} results - Tool execution results
 * @returns {object|Array<object>} Message(s) to append to messages array
 */
export function buildToolResults(results) {
    const format = getProviderFormat();

    if (format === 'claude') {
        // Single user message with all tool_result blocks
        return {
            role: 'user',
            content: results.map(r => ({
                type: 'tool_result',
                tool_use_id: r.id,
                content: r.result,
            })),
        };
    }

    if (format === 'google') {
        return {
            role: 'function',
            parts: results.map(r => ({
                functionResponse: {
                    name: r.name,
                    response: { content: r.result },
                },
            })),
        };
    }

    // OpenAI / Cohere: array of tool messages
    return results.map(r => ({
        role: 'tool',
        tool_call_id: r.id,
        content: r.result,
    }));
}
