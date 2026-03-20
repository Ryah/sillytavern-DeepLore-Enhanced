/**
 * DeepLore Enhanced — CORS-Bridged AI Proxy Module
 * Routes proxy-mode AI calls through SillyTavern's built-in CORS proxy (/proxy/:url).
 * Requires enableCorsProxy: true in SillyTavern's config.yaml.
 */

/**
 * Call an Anthropic-compatible API through the ST CORS proxy.
 * @param {string} proxyUrl - Base URL of the AI proxy (e.g. http://localhost:42069)
 * @param {string} model - Model identifier
 * @param {string} systemPrompt - System prompt text
 * @param {string} userMessage - User message content
 * @param {number} maxTokens - Max tokens for response
 * @param {number} [timeout=15000] - Timeout in ms
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>}
 */
export async function callProxyViaCorsBridge(proxyUrl, model, systemPrompt, userMessage, maxTokens, timeout = 15000) {
    const targetUrl = proxyUrl.replace(/\/+$/, '') + '/v1/messages';
    // Encode the target URL to prevent Express from collapsing :// to :/
    const corsProxyUrl = `/proxy/${encodeURIComponent(targetUrl)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(corsProxyUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                system: [{ type: 'text', text: systemPrompt }],
                messages: [{ role: 'user', content: userMessage }],
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            const text = await response.text();
            // 404 with CORS proxy disabled message → give a helpful error
            if (response.status === 404 && text.includes('CORS proxy is disabled')) {
                throw new Error('SillyTavern CORS proxy is not enabled. Set enableCorsProxy: true in config.yaml, or use a Connection Profile instead of Custom Proxy mode.');
            }
            throw new Error(`Proxy returned HTTP ${response.status}: ${text.substring(0, 200)}`);
        }

        const parsed = await response.json();
        if (parsed.error) {
            throw new Error(parsed.error.message || JSON.stringify(parsed.error));
        }

        return {
            text: parsed.content?.[0]?.text || '',
            usage: parsed.usage || { input_tokens: 0, output_tokens: 0 },
        };
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Proxy request timed out (${Math.round(timeout / 1000)}s)`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Test connection to the AI proxy through the ST CORS proxy.
 * @param {string} proxyUrl - Base URL of the AI proxy
 * @param {string} model - Model identifier to test with
 * @returns {Promise<{ok: boolean, response?: string, error?: string}>}
 */
export async function testProxyConnection(proxyUrl, model) {
    try {
        const result = await callProxyViaCorsBridge(
            proxyUrl,
            model,
            'You are Claude Code. Respond with exactly: {"status":"ok"}',
            'Test connection. Respond with exactly: {"status":"ok"}',
            32,
            15000,
        );
        return { ok: true, response: result.text.substring(0, 100) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}
