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
 * @param {AbortSignal} [externalSignal] - Optional AbortSignal for caller-initiated cancellation
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>}
 */
/**
 * Validate a proxy/base URL against SSRF targets (cloud metadata, private ranges, octal/decimal IP shorthand).
 * Throws on bad URL; safe to call from any module that builds outbound HTTP from a user-supplied URL.
 * Allows 127.0.0.1 (local proxies) but blocks broader 127.0.0.0/8 and all RFC1918/CGNAT/link-local ranges.
 * @param {string} url
 */
export function validateProxyUrl(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return; /* invalid format — let downstream fail */ }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const blockedHosts = ['169.254.169.254', 'metadata.google.internal', '100.100.100.200'];
    if (blockedHosts.includes(hostname)) {
        throw new Error(`Proxy URL "${hostname}" is blocked (potential SSRF target)`);
    }
    if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1'
        || hostname === '::ffff:127.0.0.1') {
        throw new Error(`Proxy URL "${hostname}" is blocked — use 127.0.0.1 for local proxies`);
    }
    const privatePatterns = [
        /^10\./,
        /^127\./,
        /^172\.(1[6-9]|2\d|3[01])\./,
        /^192\.168\./,
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
        /^169\.254\./,
        /^0\./,
        /^::ffff:/,
        /^fd[0-9a-f]{2}:/,
        /^fe80:/,
    ];
    if (privatePatterns.some(p => p.test(hostname)) && hostname !== '127.0.0.1') {
        throw new Error(`Proxy URL "${hostname}" points to a private/reserved network address`);
    }
    if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
        throw new Error(`Proxy URL "${hostname}" uses a numeric IP shorthand — use dotted notation`);
    }
    if (/(?:^|\.)0\d+(?:\.|$)/.test(hostname)) {
        throw new Error(`Proxy URL "${hostname}" uses octal IP notation — use standard dotted decimal`);
    }
}

export async function callProxyViaCorsBridge(proxyUrl, model, systemPrompt, userMessage, maxTokens, timeout = 15000, cacheHints, externalSignal) {
    validateProxyUrl(proxyUrl);

    const targetUrl = proxyUrl.replace(/\/+$/, '') + '/v1/messages';
    // Encode the target URL to prevent Express from collapsing :// to :/
    const corsProxyUrl = `/proxy/${encodeURIComponent(targetUrl)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // Wire external signal (user cancellation) to our internal controller
    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort();
        } else {
            externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }
    }

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
            const safeText = text.substring(0, 150)
                .replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***')          // Anthropic
                .replace(/sk-proj-[a-zA-Z0-9_-]{10,}/g, 'sk-proj-***') // OpenAI
                .replace(/AIza[a-zA-Z0-9_-]{10,}/g, 'AIza***')         // Google
                .replace(/gsk_[a-zA-Z0-9_-]{10,}/g, 'gsk_***')         // Groq
                .replace(/Bearer\s+[A-Za-z0-9_\-./]{10,}/g, 'Bearer ***'); // Generic Bearer tokens
            throw new Error(`Proxy returned HTTP ${response.status}: ${safeText}`);
        }

        // BUG-041: Separate network read (response.text) from JSON parse to get distinct errors
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

        return {
            text: parsed.content?.[0]?.text || '',
            usage: parsed.usage || { input_tokens: 0, output_tokens: 0 },
        };
    } catch (err) {
        if (err.name === 'AbortError') {
            if (externalSignal?.aborted) {
                const abortErr = new Error('Request aborted by user');
                abortErr.name = 'AbortError';
                throw abortErr;
            }
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
