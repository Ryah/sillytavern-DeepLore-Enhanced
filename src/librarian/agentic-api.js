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
import { abortWith } from '../diagnostics/interceptors.js';

// ════════════════════════════════════════════════════════════════════════════
// Provider Detection
// ════════════════════════════════════════════════════════════════════════════

/** No-tool-calling providers (chat completion sources that don't support tools). */
const NO_TOOLS_SOURCES = new Set([
    'ai21', 'perplexity', 'nanogpt', 'pollinations', 'moonshot',
]);

/**
 * Reasoning-only models that silently fail when sent `tools` payload — no
 * tool_calls returned, reasoning narrative leaks as prose. ST has no per-model
 * gate (verified against ST staging tool-calling.js, 2026-04-24), so DLE must
 * maintain this list. Source-prefixed entries cover OpenRouter relays.
 *
 * BUG-AUDIT (Fix 29): narrowed from `^o[1-9]` to `^o1` only. OpenAI's o3, o3-mini,
 * and o4-mini all support function calling per current model docs — the broad
 * pattern was over-blocking and forcing Librarian fallback for tool-capable models.
 * o1 (and only o1) is the genuine reasoning-only OpenAI model.
 */
const NO_TOOLS_MODELS = [
    /^deepseek-reasoner/i,
    /^deepseek\/.*r1/i,
    /-r1(-|$|:)/i,
    /^o1(-|$)/i,
    /^openai\/o1/i,
    /^anthropic\/.*-thinking/i,
];

/**
 * Test a model id against NO_TOOLS_MODELS.
 * @param {string} model
 * @returns {boolean}
 */
export function isReasoningOnlyModel(model) {
    if (!model || typeof model !== 'string') return false;
    return NO_TOOLS_MODELS.some(re => re.test(model));
}

/**
 * Resolve the active model id for the Librarian connection.
 * Proxy mode: Librarian's configured model. Profile mode: CMRS profile model
 * first (most accurate), then `oai_settings.{source}_model` fallback.
 * @returns {string} model id, or '' if unresolvable
 */
export function getResolvedModel() {
    if (getLibrarianMode() === 'proxy') {
        return resolveConnectionConfig('librarian').model || '';
    }
    try {
        const profileId = getActiveProfileId();
        if (profileId) {
            const profile = ConnectionManagerRequestService.getProfile?.(profileId);
            if (profile?.model) return profile.model;
        }
    } catch { /* noop */ }
    const source = oai_settings?.chat_completion_source;
    if (source) return oai_settings[`${source}_model`] || '';
    return '';
}

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
 * Profile mode checks the main ST chat completion source AND the resolved
 * model against NO_TOOLS_MODELS — reasoner-only models (deepseek-reasoner,
 * o-series, *-r1, etc.) silently fail tool calls and leak reasoning as prose.
 * @param {string} [model] Optional explicit model id; resolved if omitted.
 * @returns {boolean}
 */
export function isToolCallingSupported(model) {
    // BUG-AUDIT (Fix 1): use the resolved mode so inherit→profile is also gated.
    // Calling getActiveProfileId() throws when no profile is selected; reach into
    // the context directly so this gate can return false without raising.
    const resolved = resolveConnectionConfig('librarian');
    if (resolved.mode === 'proxy') {
        if (!resolved.proxyUrl || !resolved.model) return false;
        if (isReasoningOnlyModel(resolved.model)) return false;
        return true;
    }
    if (main_api !== 'openai') return false;
    const source = oai_settings?.chat_completion_source;
    if (!source) return false;
    if (NO_TOOLS_SOURCES.has(source)) return false;
    if (resolved.mode === 'profile') {
        const ctx = getContext();
        if (!ctx?.extensionSettings?.connectionManager?.selectedProfile) return false;
    }
    const resolvedModel = model || getResolvedModel();
    if (resolvedModel && isReasoningOnlyModel(resolvedModel)) return false;
    return true;
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
 * Detect Claude regardless of source — covers OpenRouter relays
 * (`anthropic/claude-*`) that the source-only `getProviderFormat()` misses.
 * Used to gate Claude-specific request mitigations (thinking-vs-tool_choice
 * 400, json_schema skip) without changing the message-shape parser, which
 * must stay OpenAI-shape for OR responses.
 * @param {string} [model] Optional explicit model id; resolved if omitted.
 * @returns {boolean}
 */
export function isUnderlyingClaude(model) {
    const m = model || getResolvedModel();
    if (!m || typeof m !== 'string') return false;
    return /^claude-/i.test(m) || /^anthropic\/claude/i.test(m);
}

/**
 * Get max response tokens for Librarian calls.
 * BUG-AUDIT (Fix 33): always honor `librarianSessionMaxTokens` (resolved via the
 * 'librarian' connection alias, default 4096). Previously profile mode read
 * `oai_settings.openai_max_tokens` — the user's main chat preset, often a low
 * fallback like 300 — which made the dedicated Librarian budget setting dead
 * in profile mode. CMRS accepts the third argument as a real override, so this
 * reaches the wire as intended.
 * @returns {number}
 */
export function getActiveMaxTokens() {
    return resolveConnectionConfig('librarian').maxTokens || 4096;
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
    const timer = setTimeout(() => abortWith(controller, 'agentic-api:timeout'), timeout);
    let onExternalAbort = null;

    if (signal) {
        if (signal.aborted) {
            const reason = signal.reason?.message || 'agentic-api:external_pre_aborted';
            abortWith(controller, reason);
        } else {
            onExternalAbort = () => {
                const reason = signal.reason?.message || 'agentic-api:external';
                abortWith(controller, reason);
            };
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
        const controllerReason = controller.signal.reason?.message || null;
        const externalReason = signal?.reason?.message || null;
        const abortReason = controllerReason || externalReason || null;
        if (err.name === 'AbortError') {
            if (signal?.aborted) {
                const abortErr = new Error('Request aborted by user');
                abortErr.name = 'AbortError';
                abortErr.userAborted = true;
                abortErr.abortReason = abortReason;
                throw abortErr;
            }
            const timeoutErr = new Error(`Proxy request timed out (${Math.round(timeout / 1000)}s)`, { cause: err });
            timeoutErr.name = 'AbortError';
            timeoutErr.timedOut = true;
            timeoutErr.abortReason = abortReason;
            throw timeoutErr;
        }
        if (abortReason) err.abortReason = abortReason;
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
    // Google backend: ST's chat-completions.js translates string tool_choice
    // ('auto'/'required'/'none') → body.toolConfig.functionCallingConfig with the
    // proper Gemini AUTO/ANY/NONE mapping. The adapter's `typeof === 'string'`
    // check rejects object form, so DLE must NOT pre-translate to {mode:'AUTO'}
    // — that bypasses the adapter and makes required/none silently degrade to
    // Gemini's default (AUTO). Pass the raw string. (Fix 32)
    // OpenAI/others: pass through as-is.
    let normalizedToolChoice = toolChoice;
    if (typeof toolChoice === 'string') {
        if (format === 'claude') {
            // ST wraps in {type: X}, so pass Claude's raw type strings ('auto'|'any'|'none')
            const claudeModeMap = { auto: 'auto', required: 'any', none: 'none' };
            normalizedToolChoice = claudeModeMap[toolChoice] || 'auto';
        }
        // google / openai / cohere: string values pass through as-is.
    }

    const overridePayload = {
        tools,
        ...(normalizedToolChoice != null && { tool_choice: normalizedToolChoice }),
    };

    // Anthropic API rejects forced tool_choice when extended thinking is enabled
    // ("Thinking may not be enabled when tool_choice forces tool use." — 400). Even
    // with tool_choice='auto', ST may translate `json_schema` from the active preset
    // into a forced tool_choice on Claude. Setting `reasoning_effort: 'auto'` makes
    // ST's calculateClaudeBudgetTokens (prompt-converters.js) return null → ST does
    // NOT add `requestBody.thinking`, sidestepping the conflict. Per-request only —
    // doesn't mutate the user's preset.
    //
    // OR-Claude: source is `openrouter` so `format === 'openai'`, but the underlying
    // model is Claude and OpenRouter forwards `reasoning.effort` to Anthropic. Without
    // the second arm, OR users on `anthropic/claude-*` hit the same 400. Parser stays
    // OpenAI-shape because OpenRouter returns OpenAI-shape responses regardless of
    // the upstream provider.
    if (format === 'claude' || isUnderlyingClaude()) {
        overridePayload.reasoning_effort = 'auto';
    }

    let result;
    try {
        result = await ConnectionManagerRequestService.sendRequest(
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
    } catch (err) {
        // Tag Gemini safety blocks distinctly. ST returns blockReason / SAFETY /
        // RECITATION / promptFeedback in the error message body; without typed
        // throw, callers show generic "Couldn't load your lore" toast which
        // hides the actual user-actionable cause (relax safety, rephrase).
        // Also covers ST's "Candidate text empty" which fires when Gemini returns
        // only thought parts — distinct user guidance is helpful there too.
        //
        // BUG-AUDIT (Fix 31): walk the `cause` chain. CMRS wraps backend failures
        // as `new Error('API request failed', { cause: realError })`, so reading
        // `err.message` alone always gets "API request failed" and the regex never
        // matches. The actual provider-specific detail lives in `err.cause`.
        // Bounded depth prevents pathological cycles.
        const messages = [];
        let cur = err;
        let depth = 0;
        while (cur && depth++ < 10) {
            if (cur.message) messages.push(String(cur.message));
            cur = cur.cause;
        }
        const combined = messages.join(' | ');
        if (/blocked|SAFETY|RECITATION|promptFeedback|Candidate text empty/i.test(combined)) {
            const tagged = new Error(messages[0] || 'Safety block');
            tagged.name = 'SafetyBlockError';
            tagged.cause = err;
            throw tagged;
        }
        throw err;
    }

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
    // Stamp synthetic ID onto the raw part so buildAssistantMessage can reuse
    // the same id for the OpenAI-shape `tool_calls[].id`. This closes the
    // round-trip — buildToolResults emits `tool_call_id` matching the assistant
    // message's tool_calls[].id, and ST's convertGooglePrompt.toolNameMap
    // resolves the function name from the id when sending the next turn.
    if (data.responseContent?.parts) {
        const functionCalls = data.responseContent.parts.filter(p => p.functionCall);
        if (functionCalls.length > 0) {
            return functionCalls.map(p => {
                const id = p._dleSyntheticId || `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                p._dleSyntheticId = id;
                return { id, name: p.functionCall.name, input: p.functionCall.args || {} };
            });
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
 * Strip reasoning markers that leak into prose. Thinking-capable but
 * tool-supporting models (Claude 3.7+, deepseek-chat with thinking on,
 * GLM-4.6) emit `<think>...</think>` blocks even when caller wants only
 * the final reply. Reasoning-only models (deepseek-reasoner, o-series)
 * are gated upstream by isToolCallingSupported, so this is a defensive
 * second pass for the partial-reasoning case.
 */
function stripReasoningTags(text) {
    if (!text || typeof text !== 'string') return text || '';
    return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '');
}

/**
 * Extract text content from a raw API response (excluding tool calls).
 * Filters Gemini `thought` parts (2.5/3 emit `p.thought=true` for reasoning
 * blocks) and strips `<think>` tags from prose.
 * @param {object} data - Raw API response
 * @returns {string}
 */
export function getTextContent(data) {
    if (!data) return '';

    let text = '';

    // Claude: text blocks in content array
    if (Array.isArray(data.content)) {
        const textBlocks = data.content.filter(b => b.type === 'text');
        if (textBlocks.length > 0) text = textBlocks.map(b => b.text).join('');
    }
    // Google: text parts (filter thought parts so reasoning doesn't leak)
    else if (data.responseContent?.parts) {
        const textParts = data.responseContent.parts.filter(p => p.text != null && p.thought !== true);
        if (textParts.length > 0) text = textParts.map(p => p.text).join('');
    }
    // OpenAI-compatible
    else if (data.choices?.[0]?.message?.content != null) {
        text = data.choices[0].message.content;
    }
    // Cohere
    else if (data.message?.content?.[0]?.text != null) {
        text = data.message.content[0].text;
    }

    return stripReasoningTags(text);
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
        // Emit OpenAI shape so ST's convertGooglePrompt translates correctly.
        // Native {role:'model', parts:[]} shape is silently dropped by
        // convertGooglePrompt — it only reads message.content (verified ST
        // staging prompt-converters.js, 2026-04-24). Without this, every
        // assistant turn after the first becomes parts:[{text:''}], breaking
        // multi-turn tool loops on Gemini entirely.
        const parts = data.responseContent?.parts || [];
        const textParts = parts.filter(p => typeof p.text === 'string' && p.thought !== true);
        const fnParts = parts.filter(p => p.functionCall);
        const result = { role: 'assistant' };
        if (textParts.length > 0) result.content = textParts.map(p => p.text).join('\n\n');
        if (fnParts.length > 0) {
            result.tool_calls = fnParts.map((p, i) => {
                // Reuse the synthetic id stamped by parseToolCalls so the round-trip
                // matches when buildToolResults emits tool_call_id.
                const id = p._dleSyntheticId || `gemini-${Date.now()}-${i}`;
                return {
                    id,
                    type: 'function',
                    function: {
                        name: p.functionCall.name,
                        arguments: JSON.stringify(p.functionCall.args || {}),
                    },
                };
            });
        }
        return result;
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
        // Emit OpenAI shape — matches buildAssistantMessage google branch
        // which emits {role:'assistant', tool_calls:[{id, ...}]}. ST's
        // convertGooglePrompt resolves tool_call_id → function name via its
        // toolNameMap built from the prior assistant turn's tool_calls.
        return results.map(r => ({
            role: 'tool',
            tool_call_id: r.id,
            content: r.result,
        }));
    }

    // OpenAI / Cohere: array of tool messages
    return results.map(r => ({
        role: 'tool',
        tool_call_id: r.id,
        content: r.result,
    }));
}
