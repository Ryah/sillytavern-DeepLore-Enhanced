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
 * @param {{ stablePrefix?: string, dynamicSuffix?: string }} [cacheHints] - Optional cache-aware content blocks for Anthropic prompt caching
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>}
 */
export async function callProxyViaCorsBridge(proxyUrl, model, systemPrompt, userMessage, maxTokens, timeout = 15000, cacheHints) {
    // Validate proxy URL to prevent SSRF via internal network
    try {
        const parsed = new URL(proxyUrl);
        const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
        // Block cloud metadata endpoints
        const blockedHosts = ['169.254.169.254', 'metadata.google.internal', '100.100.100.200'];
        if (blockedHosts.includes(hostname)) {
            throw new Error(`Proxy URL "${hostname}" is blocked (potential SSRF target)`);
        }
        // Block localhost variants (except 127.0.0.1 which is required for local proxies)
        if ((hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1'
            || hostname === '::ffff:127.0.0.1' || hostname === '[::1]') && hostname !== '127.0.0.1') {
            throw new Error(`Proxy URL "${hostname}" is blocked — use 127.0.0.1 for local proxies`);
        }
        // Block private/reserved IP ranges (RFC 1918, RFC 6598, link-local)
        const privatePatterns = [
            /^10\./, // 10.0.0.0/8
            /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
            /^192\.168\./, // 192.168.0.0/16
            /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 (CGNAT)
            /^169\.254\./, // 169.254.0.0/16 (link-local)
            /^0\./, // 0.0.0.0/8
            /^::ffff:/, // IPv4-mapped IPv6
            /^fd[0-9a-f]{2}:/, // IPv6 ULA
            /^fe80:/, // IPv6 link-local
        ];
        if (privatePatterns.some(p => p.test(hostname)) && hostname !== '127.0.0.1') {
            throw new Error(`Proxy URL "${hostname}" points to a private/reserved network address`);
        }
        // Block numeric IP shorthand forms (decimal, hex, octal)
        if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
            throw new Error(`Proxy URL "${hostname}" uses a numeric IP shorthand — use dotted notation`);
        }
    } catch (e) {
        if (e.message.includes('blocked') || e.message.includes('private') || e.message.includes('numeric') || e.message.includes('shorthand')) throw e;
        // Invalid URL format — let it fail naturally downstream
    }

    const targetUrl = proxyUrl.replace(/\/+$/, '') + '/v1/messages';
    // Encode the target URL to prevent Express from collapsing :// to :/
    const corsProxyUrl = `/proxy/${encodeURIComponent(targetUrl)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // Build user content — if cache hints provided, split into blocks with cache_control
    let userContent;
    if (cacheHints && cacheHints.stablePrefix && cacheHints.dynamicSuffix) {
        userContent = [
            { type: 'text', text: cacheHints.stablePrefix, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: cacheHints.dynamicSuffix },
        ];
    } else {
        userContent = userMessage;
    }

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
                system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
                messages: [{ role: 'user', content: userContent }],
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            const text = await response.text();
            // 404 with CORS proxy disabled message → give a helpful error
            if (response.status === 404 && text.includes('CORS proxy is disabled')) {
                throw new Error('SillyTavern CORS proxy is not enabled. Set enableCorsProxy: true in config.yaml, or use a Connection Profile instead of Custom Proxy mode.');
            }
            // Truncate and scrub error response to avoid leaking sensitive data
            const safeText = text.substring(0, 150).replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***');
            throw new Error(`Proxy returned HTTP ${response.status}: ${safeText}`);
        }

        let parsed;
        try {
            const text = await response.text();
            parsed = JSON.parse(text);
        } catch (e) {
            throw new Error(`Failed to parse proxy response as JSON: ${e.message}`);
        }
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
            'Reply OK.',
            'ping',
            8,
            15000,
        );
        return { ok: true, response: result.text.substring(0, 100) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}
