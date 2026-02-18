const http = require('node:http');

const info = {
    id: 'deeplore-enhanced',
    name: 'DeepLore Enhanced',
    description: 'Proxies requests to the Obsidian Local REST API with AI-powered semantic search via Claude',
};

const DEFAULT_AI_SYSTEM_PROMPT = 'You are Claude Code. You are a lore librarian. Given recent chat messages and a manifest of available lore entries, identify which entries are relevant to the current conversation. Consider:\n- Direct references to characters, places, items, or events\n- Thematic relevance (e.g., a conversation about betrayal should surface entries about known traitors)\n- Implied context (e.g., if characters are in a location, surface entries about that location\'s history)\n\nRespond ONLY with a JSON array of entry titles. No explanation. Example: ["Entry One", "Entry Two"]\nIf no entries are relevant, respond with: []';

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
function obsidianRequest({ port, apiKey, path, method = 'GET', accept = 'application/json' }) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: path,
            method: method,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': accept,
            },
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
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
        });

        const options = {
            hostname: url.hostname,
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
 * Extract a JSON array from text that may contain markdown code fences.
 * @param {string} text - Raw text from LLM response
 * @returns {string[]|null} Parsed array of strings, or null
 */
function extractJsonArray(text) {
    // Try direct parse first
    try {
        const parsed = JSON.parse(text.trim());
        if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through */ }

    // Try extracting from markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        try {
            const parsed = JSON.parse(fenceMatch[1].trim());
            if (Array.isArray(parsed)) return parsed.map(String);
        } catch { /* fall through */ }
    }

    // Try finding any JSON array in the text
    const arrayMatch = text.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
        try {
            const parsed = JSON.parse(arrayMatch[0]);
            if (Array.isArray(parsed)) return parsed.map(String);
        } catch { /* fall through */ }
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
     * POST /ai-search - Use Claude Haiku to find relevant vault entries
     */
    router.post('/ai-search', async (req, res) => {
        try {
            const { manifest, chatContext, proxyUrl, model, maxTokens, systemPrompt } = req.body;

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

            const userMessage = `## Recent Chat\n${chatContext}\n\n## Available Lore Entries\n${manifest}\n\nWhich entries are relevant to the current conversation?`;

            const result = await callProxy(
                proxyUrl,
                model,
                finalSystemPrompt,
                userMessage,
                maxTokens || 1024,
            );

            const titles = extractJsonArray(result.text);

            if (titles === null) {
                console.warn('[DeepLore Enhanced] AI search returned non-JSON response:', result.text.substring(0, 200));
                return res.json({ ok: false, error: 'AI returned invalid response format', usage: result.usage });
            }

            return res.json({ ok: true, titles, usage: result.usage });
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
