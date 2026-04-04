/**
 * DeepLore Enhanced — Client-Side Obsidian REST API Module
 * Direct browser → Obsidian communication (CORS enabled by Obsidian REST API plugin).
 */

const DEFAULT_TIMEOUT = 30000;
const OBSIDIAN_BATCH_SIZE = 50;

// ── Circuit Breaker (per-vault) ──
// Prevents hammering Obsidian when it's down. Short backoffs (it's local and free).
// Each vault gets its own circuit breaker keyed by "host:port" string for multi-vault
// and remote Obsidian isolation (e.g., "127.0.0.1:27123", "192.168.1.5:27124").

/** @type {Map<string, {failures: number, maxFailures: number, state: string, openedAt: number, baseBackoff: number, maxBackoff: number}>} */
const circuitBreakers = new Map();

function getCircuitBreaker(key) {
    if (!circuitBreakers.has(key)) {
        circuitBreakers.set(key, {
            failures: 0,
            maxFailures: 3,
            state: 'closed',
            openedAt: 0,
            baseBackoff: 2000,
            maxBackoff: 15000,
            halfOpenProbe: false, // Only one request allowed through in half-open state
        });
    }
    return circuitBreakers.get(key);
}

/**
 * Get the current circuit breaker state (for UI display).
 * @param {string|number} [port] - Vault key (host:port string or legacy port number). If omitted, returns aggregate worst state.
 * @returns {{ state: string, failures: number, backoffRemaining: number }}
 */
export function getCircuitState(port) {
    if (port !== undefined) {
        return _getCircuitStateForBreaker(getCircuitBreaker(port));
    }
    // Aggregate: return worst state across all vaults
    let worst = { state: 'closed', failures: 0, backoffRemaining: 0 };
    for (const cb of circuitBreakers.values()) {
        const s = _getCircuitStateForBreaker(cb);
        if (s.state === 'open' || (s.state === 'half-open' && worst.state === 'closed')) {
            worst = s;
        }
    }
    return worst;
}

/**
 * BUG-045: Prune stale circuit breaker entries for hosts no longer in active vault config.
 * Call this from settings-ui when vault configuration changes.
 * @param {Set<string>} activeKeys - Set of active "host:port" keys
 */
export function pruneCircuitBreakers(activeKeys) {
    for (const key of circuitBreakers.keys()) {
        if (!activeKeys.has(key)) circuitBreakers.delete(key);
    }
}

function _getCircuitStateForBreaker(cb) {
    if (cb.state === 'open') {
        const elapsed = Date.now() - cb.openedAt;
        const backoff = Math.min(
            cb.baseBackoff * Math.pow(2, Math.min(cb.failures - cb.maxFailures, 3)),
            cb.maxBackoff,
        );
        const remaining = Math.max(0, backoff - elapsed);
        const effectiveState = remaining === 0 ? 'half-open' : 'open';
        return { state: effectiveState, failures: cb.failures, backoffRemaining: remaining };
    }
    return { state: cb.state, failures: cb.failures, backoffRemaining: 0 };
}

function recordSuccess(port) {
    const cb = getCircuitBreaker(port);
    cb.failures = 0;
    cb.state = 'closed';
    cb.halfOpenProbe = false;
}

function recordFailure(port) {
    const cb = getCircuitBreaker(port);
    cb.failures++;
    cb.halfOpenProbe = false;
    if (cb.failures >= cb.maxFailures) {
        // Reset openedAt on every transition to open (including half-open → open)
        // so exponential backoff recalculates from this failure, not the original one
        cb.openedAt = Date.now();
        cb.state = 'open';
    }
}

function circuitAllows(port) {
    const cb = getCircuitBreaker(port);
    if (cb.state === 'closed') return true;
    // BUG-038: Removed dead code — half-open with !halfOpenProbe is unreachable
    // (recordFailure always transitions half-open → open, recordSuccess → closed)
    if (cb.state === 'half-open') {
        return !cb.halfOpenProbe ? (cb.halfOpenProbe = true, true) : false;
    }
    const elapsed = Date.now() - cb.openedAt;
    const backoff = Math.min(
        cb.baseBackoff * Math.pow(2, Math.min(cb.failures - cb.maxFailures, 3)),
        cb.maxBackoff,
    );
    if (elapsed >= backoff) {
        cb.state = 'half-open';
        cb.halfOpenProbe = true; // First request is the probe
        return true;
    }
    return false;
}

/**
 * Encode a vault path for use in the Obsidian REST API URL.
 * Encodes each path segment individually to preserve slashes.
 * @param {string} vaultPath - Path like "LA World/Characters/Alice.md"
 * @returns {string} URL-encoded path like "LA%20World/Characters/Alice.md"
 */
export function encodeVaultPath(vaultPath) {
    return vaultPath.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

/**
 * Validate a vault path to prevent directory traversal.
 * @param {string} filename
 * @returns {string} Normalized filename
 * @throws {Error} If path traversal is detected
 */
export function validateVaultPath(filename) {
    const normalized = filename.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (normalized.startsWith('/') || segments.some(s => s === '..' || s === '.')) {
        throw new Error('Invalid filename: path traversal not allowed');
    }
    return normalized;
}

/**
 * Make an HTTP/HTTPS request to the Obsidian Local REST API.
 * @param {object} options
 * @param {string} [options.host='127.0.0.1'] - Obsidian host (IP or hostname)
 * @param {number} options.port - Obsidian REST API port
 * @param {string} options.apiKey - Bearer token
 * @param {string} options.path - API path (e.g. /vault/)
 * @param {boolean} [options.https=false] - Use HTTPS (requires trusted certificate)
 * @param {string} [options.method='GET'] - HTTP method
 * @param {string} [options.accept='application/json'] - Accept header
 * @param {string|null} [options.body=null] - Request body
 * @param {string|null} [options.contentType=null] - Content-Type header
 * @param {number} [options.timeout=30000] - Timeout in ms
 * @returns {Promise<{status: number, data: string}>}
 */
export async function obsidianFetch({ host = '127.0.0.1', port, apiKey, path, https: useHttps = false, method = 'GET', accept = 'application/json', body = null, contentType = null, timeout = DEFAULT_TIMEOUT }) {
    // Circuit breaker key: host:port for multi-vault isolation
    const circuitKey = `${host}:${port}`;
    // Circuit breaker: reject immediately if circuit is open
    if (!circuitAllows(circuitKey)) {
        const cs = getCircuitState(circuitKey);
        throw new Error(`Obsidian connection paused after ${cs.failures} failures — retrying in ${Math.ceil(cs.backoffRemaining / 1000)}s. Check that Obsidian is running.`);
    }

    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': accept,
    };
    if (body !== null && contentType) {
        headers['Content-Type'] = contentType;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const protocol = useHttps ? 'https' : 'http';
        const response = await fetch(`${protocol}://${host || '127.0.0.1'}:${port}${path}`, {
            method,
            headers,
            body: body ?? undefined,
            signal: controller.signal,
        });
        const data = await response.text();
        // Track server errors (5xx) and rate limits (429) as circuit breaker failures.
        // BUG-H5: 429 (rate limit) must trip breaker to prevent thundering herd.
        // Don't count auth errors (401/403) or client errors (404) — they are persistent config issues, not transient server failures.
        if (response.status >= 500 || response.status === 429) {
            recordFailure(circuitKey);
        } else if (response.status >= 200 && response.status < 300) {
            recordSuccess(circuitKey);
        }
        return { status: response.status, data };
    } catch (err) {
        recordFailure(circuitKey);
        if (err.name === 'AbortError') throw new Error('Request timed out');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Recursively list all file paths from the Obsidian vault directory listing.
 * @param {number} port
 * @param {string} apiKey
 * @param {string} [directory=''] - Directory path ('' for root)
 * @param {number} [depth=0] - Current recursion depth
 * @returns {Promise<string[]>} Array of full file paths
 */
export async function listAllFiles(host, port, apiKey, directory = '', depth = 0, useHttps = false) {
    if (depth >= 20) {
        throw new Error(`Directory nesting too deep at "${directory}"`);
    }
    const urlPath = directory ? `/vault/${encodeVaultPath(directory)}/` : '/vault/';
    const res = await obsidianFetch({ host, port, apiKey, https: useHttps, path: urlPath });

    if (res.status !== 200) {
        throw new Error(`Failed to list files at "${directory}": HTTP ${res.status}`);
    }

    let listing;
    try {
        listing = JSON.parse(res.data);
    } catch (e) {
        throw new Error(`Failed to parse directory listing for "${directory || '/'}": ${e.message}`);
    }

    const files = listing.files || [];
    const allFiles = [];
    const prefix = directory ? directory + '/' : '';

    // Separate directories and files
    const dirs = [];
    for (const file of files) {
        if (file.endsWith('/')) {
            dirs.push(prefix + file.slice(0, -1));
        } else {
            allFiles.push(prefix + file);
        }
    }

    // Fetch directories in batches to avoid overwhelming the Obsidian REST API
    if (dirs.length > 0) {
        const DIR_BATCH = 10;
        for (let i = 0; i < dirs.length; i += DIR_BATCH) {
            const batch = dirs.slice(i, i + DIR_BATCH);
            const dirResults = await Promise.allSettled(
                batch.map(fullDirPath => listAllFiles(host, port, apiKey, fullDirPath, depth + 1, useHttps)),
            );
            for (const result of dirResults) {
                if (result.status === 'fulfilled') {
                    allFiles.push(...result.value);
                } else {
                    console.warn(`[DLE] Failed to list directory: ${result.reason?.message || result.reason}`);
                }
            }
        }
    }

    return allFiles;
}

/**
 * Test connection to the Obsidian REST API.
 * @param {number} port
 * @param {string} apiKey
 * @returns {Promise<{ok: boolean, authenticated?: boolean, versions?: object, error?: string}>}
 */
export async function testConnection(host, port, apiKey, useHttps = false) {
    try {
        // Force-reset circuit breaker for explicit user-initiated test.
        const circuitKey = `${host || '127.0.0.1'}:${port}`;
        const cb = getCircuitBreaker(circuitKey);
        cb.state = 'closed';
        cb.failures = 0;
        cb.halfOpenProbe = false;
        const result = await obsidianFetch({ host, port, apiKey: apiKey || '', https: useHttps, path: '/vault/', timeout: 10000 });
        if (result.status === 200) {
            return { ok: true, authenticated: true };
        }
        if (result.status === 401 || result.status === 403) {
            return { ok: false, error: `Authentication failed (HTTP ${result.status}). Check your API key.` };
        }
        return { ok: false, error: `HTTP ${result.status}` };
    } catch (err) {
        // Detect self-signed certificate errors (browser blocks HTTPS to untrusted certs)
        if (useHttps && (err instanceof TypeError || err.message?.includes('Failed to fetch'))) {
            const certUrl = `https://${host || '127.0.0.1'}:${port}`;
            return {
                ok: false,
                certError: true,
                certUrl,
                error: `HTTPS connection failed — the certificate may not be trusted yet. Open ${certUrl} in your browser, accept the certificate, then try again.`,
            };
        }
        return { ok: false, error: err.message };
    }
}

/**
 * Fetch all .md files from the vault with their contents (batch parallel).
 * @param {number} port
 * @param {string} apiKey
 * @returns {Promise<{files: Array<{filename: string, content: string}>, total: number, failed: number}>}
 */
export async function fetchAllMdFiles(host, port, apiKey, useHttps = false) {
    const allFiles = await listAllFiles(host, port, apiKey, '', 0, useHttps);
    const mdFiles = allFiles.filter(f => f.endsWith('.md'));

    const BATCH_SIZE = OBSIDIAN_BATCH_SIZE;
    const results = [];
    let failed = 0;

    for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
        const batch = mdFiles.slice(i, i + BATCH_SIZE);
        const batchSettled = await Promise.allSettled(
            batch.map(async (filename) => {
                try {
                    const result = await obsidianFetch({
                        host,
                        port,
                        apiKey,
                        https: useHttps,
                        path: `/vault/${encodeVaultPath(filename)}`,
                        accept: 'text/markdown',
                    });
                    if (result.status === 200) {
                        return { filename, content: result.data };
                    }
                    console.warn(`[DLE] Failed to fetch "${filename}": HTTP ${result.status}`);
                    failed++;
                    return null;
                } catch (err) {
                    console.warn(`[DLE] Failed to fetch "${filename}": ${err.message}`);
                    failed++;
                    return null;
                }
            }),
        );
        for (const r of batchSettled) {
            if (r.status === 'fulfilled' && r.value) results.push(r.value);
            else if (r.status === 'rejected') { failed++; console.warn(`[DLE] Batch file fetch rejected: ${r.reason?.message || r.reason}`); }
        }
    }

    return { files: results, total: mdFiles.length, failed };
}

/**
 * Write a markdown note to the vault.
 * @param {number} port
 * @param {string} apiKey
 * @param {string} filename - Vault-relative path
 * @param {string} content - Markdown content
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function writeNote(host, port, apiKey, filename, content, useHttps = false) {
    try {
        const normalizedPath = validateVaultPath(filename);
        const result = await obsidianFetch({
            host,
            port,
            apiKey,
            https: useHttps,
            path: `/vault/${encodeVaultPath(normalizedPath)}`,
            method: 'PUT',
            body: content,
            contentType: 'text/markdown',
            accept: 'text/markdown',
        });
        if (result.status === 200 || result.status === 204) {
            return { ok: true };
        }
        return { ok: false, error: `HTTP ${result.status}: ${(result.data || '').substring(0, 200)}` };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Fetch a YAML field definitions file from the vault.
 * @param {string} host
 * @param {number} port
 * @param {string} apiKey
 * @param {string} filePath - Vault-relative path (e.g., 'DeepLore/field-definitions.yaml')
 * @returns {Promise<{ok: boolean, content?: string, error?: string}>}
 */
export async function fetchFieldDefinitions(host, port, apiKey, filePath, useHttps = false) {
    try {
        const normalizedPath = validateVaultPath(filePath);
        const result = await obsidianFetch({
            host,
            port,
            apiKey,
            https: useHttps,
            path: `/vault/${encodeVaultPath(normalizedPath)}`,
            method: 'GET',
            accept: 'text/plain',
        });
        if (result.status === 200) {
            return { ok: true, content: result.data };
        }
        if (result.status === 404) {
            return { ok: false, error: 'not_found' };
        }
        return { ok: false, error: `HTTP ${result.status}: ${(result.data || '').substring(0, 200)}` };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Write a YAML field definitions file to the vault.
 * @param {string} host
 * @param {number} port
 * @param {string} apiKey
 * @param {string} filePath - Vault-relative path (e.g., 'DeepLore/field-definitions.yaml')
 * @param {string} content - Serialized YAML string
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function writeFieldDefinitions(host, port, apiKey, filePath, content, useHttps = false) {
    try {
        const normalizedPath = validateVaultPath(filePath);
        const result = await obsidianFetch({
            host,
            port,
            apiKey,
            https: useHttps,
            path: `/vault/${encodeVaultPath(normalizedPath)}`,
            method: 'PUT',
            body: content,
            contentType: 'text/plain',
            accept: 'text/plain',
        });
        if (result.status === 200 || result.status === 204) {
            return { ok: true };
        }
        return { ok: false, error: `HTTP ${result.status}: ${(result.data || '').substring(0, 200)}` };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Fetch all session notes from a vault folder.
 * @param {number} port
 * @param {string} apiKey
 * @param {string} folder - Folder path within vault
 * @returns {Promise<{ok: boolean, notes?: Array<{filename: string, content: string}>, error?: string}>}
 */
export async function fetchScribeNotes(host, port, apiKey, folder, useHttps = false) {
    // BUG-040: Validate folder path to prevent directory traversal
    validateVaultPath(folder);
    try {
        const allFiles = await listAllFiles(host, port, apiKey, folder, 0, useHttps);
        const mdFiles = allFiles.filter(f => f.endsWith('.md'));
        const BATCH_SIZE = OBSIDIAN_BATCH_SIZE;
        const notes = [];

        for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
            const batch = mdFiles.slice(i, i + BATCH_SIZE);
            const batchSettled = await Promise.allSettled(batch.map(async (filepath) => {
                try {
                    const result = await obsidianFetch({
                        host,
                        port,
                        apiKey,
                        https: useHttps,
                        path: `/vault/${encodeVaultPath(filepath)}`,
                        accept: 'text/markdown',
                    });
                    if (result.status !== 200) {
                        console.warn(`[DLE] Failed to fetch scribe note ${filepath}: HTTP ${result.status}`);
                        return null;
                    }
                    return { filename: filepath, content: result.data };
                } catch (err) {
                    console.warn(`[DLE] Failed to fetch scribe note ${filepath}:`, err.message);
                    return null;
                }
            }));
            for (const r of batchSettled) {
                if (r.status === 'fulfilled' && r.value) notes.push(r.value);
                else if (r.status === 'rejected') console.warn(`[DLE] Batch scribe note fetch rejected: ${r.reason?.message || r.reason}`);
            }
        }

        return { ok: true, notes };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}
