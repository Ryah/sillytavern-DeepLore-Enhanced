const http = require('node:http');

const info = {
    id: 'deeplore-enhanced',
    name: 'DeepLore Enhanced',
    description: 'Proxies requests to the Obsidian Local REST API with AI-powered semantic search via Claude',
};

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
// Obsidian REST API Helpers
// ============================================================================

/**
 * Makes an HTTP request to the Obsidian Local REST API.
 * @param {object} options
 * @param {number} options.port - Obsidian REST API port
 * @param {string} options.apiKey - Bearer token
 * @param {string} options.path - API path (e.g. /vault/)
 * @param {string} [options.method='GET'] - HTTP method
 * @param {string} [options.accept='application/json'] - Accept header
 * @returns {Promise<{status: number, data: string}>}
 */
function obsidianRequest({ port, apiKey, path, method = 'GET', accept = 'application/json', body = null, contentType = null }) {
    return new Promise((resolve, reject) => {
        const headers = {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': accept,
        };

        if (body !== null && contentType) {
            headers['Content-Type'] = contentType;
            headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: path,
            method: method,
            headers: headers,
            timeout: 30000,
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({ status: res.statusCode, data: data });
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });

        if (body !== null) {
            req.write(body);
        }

        req.end();
    });
}

/**
 * Encode a vault path for use in the Obsidian REST API URL.
 * Encodes each path segment individually to preserve slashes.
 * @param {string} vaultPath - Path like "LA World/Characters/Alice.md"
 * @returns {string} URL-encoded path like "LA%20World/Characters/Alice.md"
 */
function encodeVaultPath(vaultPath) {
    return vaultPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

/**
 * Recursively collects all file paths from the Obsidian vault directory listing.
 * The Obsidian REST API returns { files: [...] } where entries ending in / are directories.
 * Note: The API returns paths relative to the queried directory.
 * @param {number} port
 * @param {string} apiKey
 * @param {string} directory - Directory path (e.g. '' for root, 'LA World')
 * @returns {Promise<string[]>} Array of full file paths
 */
async function listAllFiles(port, apiKey, directory = '') {
    const urlPath = directory ? `/vault/${encodeVaultPath(directory)}/` : '/vault/';
    const res = await obsidianRequest({ port, apiKey, path: urlPath });

    if (res.status !== 200) {
        throw new Error(`Failed to list files at "${directory}": HTTP ${res.status}`);
    }

    const listing = JSON.parse(res.data);
    const files = listing.files || [];
    const allFiles = [];
    const prefix = directory ? directory + '/' : '';

    for (const file of files) {
        if (file.endsWith('/')) {
            // It's a directory, recurse with the full path
            const dirName = file.slice(0, -1); // Remove trailing /
            const fullDirPath = prefix + dirName;
            const subFiles = await listAllFiles(port, apiKey, fullDirPath);
            allFiles.push(...subFiles);
        } else {
            allFiles.push(prefix + file);
        }
    }

    return allFiles;
}

// ============================================================================
// Claude Proxy Helpers
// ============================================================================

/**
 * Call the claude-code-proxy with an Anthropic Messages API request.
 * @param {string} proxyUrl - Base URL of the proxy (e.g. http://localhost:42069)
 * @param {string} model - Model identifier
 * @param {string} systemPrompt - System prompt text
 * @param {string} userMessage - User message content
 * @param {number} maxTokens - Max tokens for response
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>}
 */
function callProxy(proxyUrl, model, systemPrompt, userMessage, maxTokens) {
    return new Promise((resolve, reject) => {
        const url = new URL(proxyUrl + '/v1/messages');
        const payload = JSON.stringify({
            model: model,
            max_tokens: maxTokens,
            system: [{ type: 'text', text: systemPrompt }],
            messages: [{ role: 'user', content: userMessage }],
        });

        // Force IPv4 for localhost to avoid ::1 ECONNREFUSED issues
        const hostname = (url.hostname === 'localhost') ? '127.0.0.1' : url.hostname;

        const options = {
            hostname: hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'Content-Length': Buffer.byteLength(payload),
            },
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);

                    if (parsed.error) {
                        return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
                    }

                    const text = parsed.content?.[0]?.text || '';
                    const usage = parsed.usage || { input_tokens: 0, output_tokens: 0 };
                    resolve({ text, usage });
                } catch (e) {
                    reject(new Error(`Failed to parse proxy response: ${e.message}`));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(15000, () => {
            req.destroy(new Error('Proxy request timed out (15s)'));
        });
        req.write(payload);
        req.end();
    });
}

/**
 * @typedef {object} AiSearchResult
 * @property {string} title
 * @property {string} confidence - "high", "medium", or "low"
 * @property {string} reason - Brief explanation of why the entry was selected
 */

/**
 * Try to parse JSON text, returning null on failure.
 * @param {string} text
 * @returns {Array|null}
 */
function tryParseJson(text) {
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
    return null;
}

/**
 * Normalize parsed array items to structured AiSearchResult format.
 * Handles both legacy ["Title"] and new [{"title","confidence","reason"}] formats.
 * @param {Array} arr - Parsed JSON array
 * @returns {AiSearchResult[]}
 */
function normalizeResults(arr) {
    return arr.map(item => {
        if (typeof item === 'string') {
            // Legacy flat format
            return { title: item, confidence: 'medium', reason: 'AI search' };
        }
        if (typeof item === 'object' && item !== null && typeof item.title === 'string') {
            return {
                title: item.title,
                confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium',
                reason: typeof item.reason === 'string' ? item.reason : 'AI search',
            };
        }
        // Unknown format, try to coerce
        return { title: String(item), confidence: 'medium', reason: 'AI search' };
    });
}

/**
 * Extract AI search results from LLM response text.
 * Supports structured objects, legacy flat arrays, and markdown-fenced JSON.
 * @param {string} text - Raw text from LLM response
 * @returns {AiSearchResult[]|null}
 */
function extractAiResponse(text) {
    // Try direct parse first
    const direct = tryParseJson(text.trim());
    if (direct) return normalizeResults(direct);

    // Try extracting from markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        const fenced = tryParseJson(fenceMatch[1].trim());
        if (fenced) return normalizeResults(fenced);
    }

    // Try finding any JSON array in the text (greedy to handle nested objects)
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
        const found = tryParseJson(arrayMatch[0]);
        if (found) return normalizeResults(found);
    }

    return null;
}

// ============================================================================
// Plugin Init
// ============================================================================

async function init(router) {
    const express = require('express');
    router.use(express.json({ limit: '5mb' }));

    /**
     * POST /test - Test connection to Obsidian REST API
     */
    router.post('/test', async (req, res) => {
        try {
            const { port, apiKey } = req.body;

            if (!port) {
                return res.status(400).json({ error: 'Missing port' });
            }

            const result = await obsidianRequest({
                port,
                apiKey: apiKey || '',
                path: '/',
            });

            if (result.status === 200) {
                const serverInfo = JSON.parse(result.data);
                return res.json({
                    ok: true,
                    authenticated: serverInfo.authenticated || false,
                    versions: serverInfo.versions || {},
                });
            }

            return res.json({ ok: false, error: `HTTP ${result.status}` });
        } catch (err) {
            return res.json({ ok: false, error: err.message });
        }
    });

    /**
     * POST /files - List all files in the vault
     */
    router.post('/files', async (req, res) => {
        try {
            const { port, apiKey } = req.body;

            if (!port || !apiKey) {
                return res.status(400).json({ error: 'Missing port or apiKey' });
            }

            const files = await listAllFiles(port, apiKey);
            return res.json({ files });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /file - Get a single file's content
     */
    router.post('/file', async (req, res) => {
        try {
            const { port, apiKey, filename } = req.body;

            if (!port || !apiKey || !filename) {
                return res.status(400).json({ error: 'Missing port, apiKey, or filename' });
            }

            const result = await obsidianRequest({
                port,
                apiKey,
                path: `/vault/${encodeVaultPath(filename)}`,
                accept: 'text/markdown',
            });

            if (result.status === 200) {
                return res.json({ content: result.data });
            }

            return res.status(result.status).json({ error: `HTTP ${result.status}` });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /index - Fetch all .md files and return their contents
     */
    router.post('/index', async (req, res) => {
        try {
            const { port, apiKey } = req.body;

            if (!port || !apiKey) {
                return res.status(400).json({ error: 'Missing port or apiKey' });
            }

            const allFiles = await listAllFiles(port, apiKey);
            const mdFiles = allFiles.filter(f => f.endsWith('.md'));

            // Fetch content in parallel batches of 10
            const BATCH_SIZE = 10;
            const results = [];

            for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
                const batch = mdFiles.slice(i, i + BATCH_SIZE);
                const batchResults = await Promise.all(
                    batch.map(async (filename) => {
                        try {
                            const result = await obsidianRequest({
                                port,
                                apiKey,
                                path: `/vault/${encodeVaultPath(filename)}`,
                                accept: 'text/markdown',
                            });
                            if (result.status === 200) {
                                return { filename, content: result.data };
                            }
                            return null;
                        } catch {
                            return null;
                        }
                    }),
                );
                results.push(...batchResults.filter(Boolean));
            }

            return res.json({ files: results, total: mdFiles.length });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    /**
     * POST /write-note - Write a markdown note to the vault
     */
    router.post('/write-note', async (req, res) => {
        try {
            const { port, apiKey, filename, content } = req.body;

            if (!port || !apiKey || !filename || content === undefined) {
                return res.status(400).json({ ok: false, error: 'Missing required fields (port, apiKey, filename, content)' });
            }

            const result = await obsidianRequest({
                port,
                apiKey,
                path: `/vault/${encodeVaultPath(filename)}`,
                method: 'PUT',
                body: content,
                contentType: 'text/markdown',
                accept: 'text/markdown',
            });

            if (result.status === 200 || result.status === 204) {
                return res.json({ ok: true });
            }

            return res.json({ ok: false, error: `HTTP ${result.status}` });
        } catch (err) {
            return res.json({ ok: false, error: err.message });
        }
    });

    /**
     * POST /ai-search - Use Claude Haiku to find relevant vault entries
     */
    router.post('/ai-search', async (req, res) => {
        try {
            const { manifest, manifestHeader, chatContext, proxyUrl, model, maxTokens, systemPrompt } = req.body;

            if (!manifest || !chatContext || !proxyUrl || !model) {
                return res.status(400).json({ ok: false, error: 'Missing required fields (manifest, chatContext, proxyUrl, model)' });
            }

            // Build system prompt - always ensure "You are Claude Code" is present (proxy requirement)
            let finalSystemPrompt;
            if (systemPrompt && systemPrompt.trim()) {
                const userPrompt = systemPrompt.trim();
                finalSystemPrompt = userPrompt.startsWith('You are Claude Code')
                    ? userPrompt
                    : 'You are Claude Code. ' + userPrompt;
            } else {
                finalSystemPrompt = DEFAULT_AI_SYSTEM_PROMPT;
            }

            // Build user message with optional manifest header
            const headerSection = manifestHeader ? `## Manifest Info\n${manifestHeader}\n\n` : '';
            const userMessage = `${headerSection}## Recent Chat\n${chatContext}\n\n## Available Lore Entries\n${manifest}\n\nSelect the relevant entries as a JSON array.`;

            const result = await callProxy(
                proxyUrl,
                model,
                finalSystemPrompt,
                userMessage,
                maxTokens || 1024,
            );

            const aiResults = extractAiResponse(result.text);

            if (aiResults === null) {
                console.warn('[DeepLore Enhanced] AI search returned non-JSON response:', result.text.substring(0, 200));
                return res.json({ ok: false, error: 'AI returned invalid response format', usage: result.usage });
            }

            return res.json({ ok: true, results: aiResults, usage: result.usage });
        } catch (err) {
            console.error('[DeepLore Enhanced] AI search error:', err.message);
            return res.json({ ok: false, error: err.message });
        }
    });

    /**
     * POST /ai-test - Test connection to the Claude proxy
     */
    router.post('/ai-test', async (req, res) => {
        try {
            const { proxyUrl, model } = req.body;

            if (!proxyUrl || !model) {
                return res.status(400).json({ ok: false, error: 'Missing proxyUrl or model' });
            }

            const result = await callProxy(
                proxyUrl,
                model,
                'You are Claude Code. Respond with exactly: {"status":"ok"}',
                'Test connection. Respond with exactly: {"status":"ok"}',
                32,
            );

            return res.json({ ok: true, response: result.text.substring(0, 100) });
        } catch (err) {
            return res.json({ ok: false, error: err.message });
        }
    });

    console.log('[DeepLore Enhanced] Server plugin initialized');
}

async function exit() {
    console.log('[DeepLore Enhanced] Server plugin shutting down');
}

module.exports = { info, init, exit };
