/**
 * DeepLore Enhanced — Client-Side Obsidian REST API Module
 * Direct browser → Obsidian communication (CORS enabled by Obsidian REST API plugin).
 * Replaces the server plugin's Obsidian proxy endpoints.
 */

const DEFAULT_TIMEOUT = 30000;

// ── Circuit Breaker ──
// Prevents hammering Obsidian when it's down. Short backoffs (it's local and free).
const circuitBreaker = {
    failures: 0,
    maxFailures: 3,
    state: 'closed', // closed (normal), open (rejecting), half-open (testing)
    openedAt: 0,
    baseBackoff: 2000,  // 2s initial
    maxBackoff: 15000,  // 15s max
};

/**
 * Get the current circuit breaker state (for UI display).
 * @returns {{ state: string, failures: number, backoffRemaining: number }}
 */
export function getCircuitState() {
    if (circuitBreaker.state === 'open') {
        const elapsed = Date.now() - circuitBreaker.openedAt;
        const backoff = Math.min(
            circuitBreaker.baseBackoff * Math.pow(2, Math.min(circuitBreaker.failures - circuitBreaker.maxFailures, 3)),
            circuitBreaker.maxBackoff,
        );
        const remaining = Math.max(0, backoff - elapsed);
        if (remaining === 0) {
            circuitBreaker.state = 'half-open';
        }
        return { state: circuitBreaker.state, failures: circuitBreaker.failures, backoffRemaining: remaining };
    }
    return { state: circuitBreaker.state, failures: circuitBreaker.failures, backoffRemaining: 0 };
}

function recordSuccess() {
    circuitBreaker.failures = 0;
    circuitBreaker.state = 'closed';
}

function recordFailure() {
    circuitBreaker.failures++;
    if (circuitBreaker.failures >= circuitBreaker.maxFailures) {
        circuitBreaker.state = 'open';
        circuitBreaker.openedAt = Date.now();
    }
}

function circuitAllows() {
    if (circuitBreaker.state === 'closed') return true;
    if (circuitBreaker.state === 'half-open') return true;
    const elapsed = Date.now() - circuitBreaker.openedAt;
    const backoff = Math.min(
        circuitBreaker.baseBackoff * Math.pow(2, Math.min(circuitBreaker.failures - circuitBreaker.maxFailures, 3)),
        circuitBreaker.maxBackoff,
    );
    if (elapsed >= backoff) {
        circuitBreaker.state = 'half-open';
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
function validateVaultPath(filename) {
    const normalized = filename.replace(/\\/g, '/');
    if (normalized.startsWith('..') || normalized.startsWith('/') || normalized.includes('/../')) {
        throw new Error('Invalid filename: path traversal not allowed');
    }
    return normalized;
}

/**
 * Make an HTTP request to the Obsidian Local REST API.
 * @param {object} options
 * @param {number} options.port - Obsidian REST API port
 * @param {string} options.apiKey - Bearer token
 * @param {string} options.path - API path (e.g. /vault/)
 * @param {string} [options.method='GET'] - HTTP method
 * @param {string} [options.accept='application/json'] - Accept header
 * @param {string|null} [options.body=null] - Request body
 * @param {string|null} [options.contentType=null] - Content-Type header
 * @param {number} [options.timeout=30000] - Timeout in ms
 * @returns {Promise<{status: number, data: string}>}
 */
export async function obsidianFetch({ port, apiKey, path, method = 'GET', accept = 'application/json', body = null, contentType = null, timeout = DEFAULT_TIMEOUT }) {
    // Circuit breaker: reject immediately if circuit is open
    if (!circuitAllows()) {
        const cs = getCircuitState();
        throw new Error(`Obsidian circuit breaker open (${cs.failures} failures, retry in ${Math.ceil(cs.backoffRemaining / 1000)}s)`);
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
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers,
            body: body ?? undefined,
            signal: controller.signal,
        });
        const data = await response.text();
        recordSuccess();
        return { status: response.status, data };
    } catch (err) {
        recordFailure();
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
export async function listAllFiles(port, apiKey, directory = '', depth = 0) {
    if (depth >= 20) {
        throw new Error(`Directory nesting too deep at "${directory}"`);
    }
    const urlPath = directory ? `/vault/${encodeVaultPath(directory)}/` : '/vault/';
    const res = await obsidianFetch({ port, apiKey, path: urlPath });

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

    // Fetch sibling directories in parallel instead of sequentially
    if (dirs.length > 0) {
        const dirResults = await Promise.all(
            dirs.map(fullDirPath => listAllFiles(port, apiKey, fullDirPath, depth + 1)),
        );
        for (const subFiles of dirResults) {
            allFiles.push(...subFiles);
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
export async function testConnection(port, apiKey) {
    try {
        const result = await obsidianFetch({ port, apiKey: apiKey || '', path: '/' });
        if (result.status === 200) {
            const serverInfo = JSON.parse(result.data);
            return {
                ok: true,
                authenticated: serverInfo.authenticated || false,
                versions: serverInfo.versions || {},
            };
        }
        return { ok: false, error: `HTTP ${result.status}` };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Fetch all .md files from the vault with their contents (batch parallel).
 * @param {number} port
 * @param {string} apiKey
 * @returns {Promise<{files: Array<{filename: string, content: string}>, total: number, failed: number}>}
 */
export async function fetchAllMdFiles(port, apiKey) {
    const allFiles = await listAllFiles(port, apiKey);
    const mdFiles = allFiles.filter(f => f.endsWith('.md'));

    const BATCH_SIZE = 10;
    const results = [];
    let failed = 0;

    for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
        const batch = mdFiles.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
            batch.map(async (filename) => {
                try {
                    const result = await obsidianFetch({
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

    return { files: results, total: mdFiles.length, failed };
}

/**
 * Fetch only new or changed .md files from the vault (incremental delta sync).
 * Compares file listing against known filenames; only fetches content for new files.
 * Returns the full file list for removal detection + fetched content for new files.
 * @param {number} port
 * @param {string} apiKey
 * @param {Set<string>} knownFiles - Filenames already in the index
 * @returns {Promise<{allMdFiles: string[], newFiles: Array<{filename: string, content: string}>, failed: number}>}
 */
export async function fetchMdFilesDelta(port, apiKey, knownFiles) {
    const allFiles = await listAllFiles(port, apiKey);
    const allMdFiles = allFiles.filter(f => f.endsWith('.md'));

    // Only fetch content for files not in our existing index
    const newFilenames = allMdFiles.filter(f => !knownFiles.has(f));

    if (newFilenames.length === 0) {
        return { allMdFiles, newFiles: [], failed: 0 };
    }

    const BATCH_SIZE = 10;
    const results = [];
    let failed = 0;

    for (let i = 0; i < newFilenames.length; i += BATCH_SIZE) {
        const batch = newFilenames.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
            batch.map(async (filename) => {
                try {
                    const result = await obsidianFetch({
                        port,
                        apiKey,
                        path: `/vault/${encodeVaultPath(filename)}`,
                        accept: 'text/markdown',
                    });
                    if (result.status === 200) {
                        return { filename, content: result.data };
                    }
                    failed++;
                    return null;
                } catch {
                    failed++;
                    return null;
                }
            }),
        );
        results.push(...batchResults.filter(Boolean));
    }

    return { allMdFiles, newFiles: results, failed };
}

/**
 * Write a markdown note to the vault.
 * @param {number} port
 * @param {string} apiKey
 * @param {string} filename - Vault-relative path
 * @param {string} content - Markdown content
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function writeNote(port, apiKey, filename, content) {
    try {
        const normalizedPath = validateVaultPath(filename);
        const result = await obsidianFetch({
            port,
            apiKey,
            path: `/vault/${encodeVaultPath(normalizedPath)}`,
            method: 'PUT',
            body: content,
            contentType: 'text/markdown',
            accept: 'text/markdown',
        });
        if (result.status === 200 || result.status === 204) {
            return { ok: true };
        }
        return { ok: false, error: `HTTP ${result.status}` };
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
export async function fetchScribeNotes(port, apiKey, folder) {
    try {
        const allFiles = await listAllFiles(port, apiKey, folder);
        const mdFiles = allFiles.filter(f => f.endsWith('.md'));
        const BATCH_SIZE = 10;
        const notes = [];

        for (let i = 0; i < mdFiles.length; i += BATCH_SIZE) {
            const batch = mdFiles.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(async (filepath) => {
                try {
                    const result = await obsidianFetch({
                        port,
                        apiKey,
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
            notes.push(...batchResults.filter(Boolean));
        }

        return { ok: true, notes };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}
