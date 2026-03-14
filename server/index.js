const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { obsidianRequest, encodeVaultPath, listAllFiles } = require('./core/obsidian');

const info = {
    id: 'deeplore-enhanced',
    name: 'DeepLore Enhanced',
    description: 'Proxies requests to Obsidian Local REST API with AI-powered semantic search via Claude',
};

// Fallback system prompt used only when client sends none
const FALLBACK_SYSTEM_PROMPT = 'You are a lorebook search assistant. Return a JSON array of relevant entries.';

// Obsidian REST API helpers imported from ./core/obsidian.js

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
function callProxy(proxyUrl, model, systemPrompt, userMessage, maxTokens, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const url = new URL(proxyUrl.replace(/\/+$/, '') + '/v1/messages');
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

        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`Proxy returned HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                }
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
        req.setTimeout(timeout, () => {
            req.destroy(new Error(`Proxy request timed out (${Math.round(timeout / 1000)}s)`));
        });
        try {
            req.write(payload);
            req.end();
        } catch (e) {
            req.destroy();
            reject(new Error(`Failed to send proxy request: ${e.message}`));
        }
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
    }).filter(r => r.title && r.title !== 'null' && r.title !== 'undefined' && r.title.trim() !== '');
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

    // Try all JSON arrays, searching from the last one (most likely to be the actual result)
    const arrayMatches = [...text.matchAll(/\[[\s\S]*?\]/g)];
    for (let i = arrayMatches.length - 1; i >= 0; i--) {
        const found = tryParseJson(arrayMatches[i][0]);
        if (found && Array.isArray(found) && found.length > 0 && (typeof found[0] === 'object' ? found[0].name || found[0].title : typeof found[0] === 'string')) {
            return normalizeResults(found);
        }
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

            const normalizedFile = path.normalize(filename).replace(/\\/g, '/');
            if (normalizedFile.startsWith('..') || path.isAbsolute(normalizedFile) || normalizedFile.includes('/../')) {
                return res.status(400).json({ error: 'Invalid filename: path traversal not allowed' });
            }

            const result = await obsidianRequest({
                port,
                apiKey,
                path: `/vault/${encodeVaultPath(normalizedFile)}`,
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

            let failed = 0;
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
                            console.warn(`[DeepLore] Failed to fetch "${filename}": HTTP ${result.status}`);
                            failed++;
                            return null;
                        } catch (err) {
                            console.warn(`[DeepLore] Failed to fetch "${filename}": ${err.message}`);
                            failed++;
                            return null;
                        }
                    }),
                );
                results.push(...batchResults.filter(Boolean));
            }

            return res.json({ files: results, total: mdFiles.length, failed });
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

            const normalizedWrite = path.normalize(filename).replace(/\\/g, '/');
            if (normalizedWrite.startsWith('..') || path.isAbsolute(normalizedWrite) || normalizedWrite.includes('/../')) {
                return res.status(400).json({ ok: false, error: 'Invalid filename: path traversal not allowed' });
            }

            const result = await obsidianRequest({
                port,
                apiKey,
                path: `/vault/${encodeVaultPath(normalizedWrite)}`,
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
            const { manifest, manifestHeader, chatContext, proxyUrl, model, maxTokens, systemPrompt, timeout } = req.body;

            if (!manifest || !chatContext || !proxyUrl || !model) {
                return res.status(400).json({ ok: false, error: 'Missing required fields (manifest, chatContext, proxyUrl, model)' });
            }

            // Use system prompt from client; fall back to minimal fallback
            const finalSystemPrompt = (systemPrompt && systemPrompt.trim()) ? systemPrompt.trim() : FALLBACK_SYSTEM_PROMPT;

            // Build user message with optional manifest header
            const headerSection = manifestHeader ? `## Manifest Info\n${manifestHeader}\n\n` : '';
            const userMessage = `${headerSection}## Recent Chat\n${chatContext}\n\n## Available Lore Entries\n${manifest}\n\nSelect the relevant entries as a JSON array.`;

            const proxyTimeout = Math.min(Math.max(timeout || 15000, 5000), 60000);
            const result = await callProxy(
                proxyUrl,
                model,
                finalSystemPrompt,
                userMessage,
                maxTokens || 1024,
                proxyTimeout,
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
