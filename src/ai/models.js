/**
 * DeepLore Enhanced — Generic /v1/models fetcher.
 * Hits OpenAI-compatible {base}/v1/models. Used by proxy-mode AI feature settings
 * (AI Search, Scribe, Auto-Suggest, Librarian) to populate model dropdowns.
 *
 * Tries direct fetch first; falls back to ST CORS bridge on TypeError (CORS denial).
 * Per-baseUrl sessionStorage caching survives tab switches within a session.
 */
import { validateProxyUrl } from './proxy-api.js';

const CACHE_PREFIX = 'dle_models_v1::';

// BUG-388: short, non-reversible fingerprint of the API key so rotating keys
// invalidates the cache without ever storing the raw key in sessionStorage.
function apiKeyFingerprint(apiKey) {
    if (!apiKey) return 'nokey';
    let h = 0x811c9dc5; // FNV-1a 32-bit
    for (let i = 0; i < apiKey.length; i++) {
        h ^= apiKey.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * @param {{baseUrl: string, apiKey?: string, timeout?: number, via?: 'auto'|'direct'|'cors'}} opts
 * @returns {Promise<{ok: boolean, models: string[], raw: any, error?: string, source: 'cache'|'direct'|'cors'}>}
 */
export async function fetchModels({ baseUrl, apiKey, timeout = 8000, via = 'auto' }) {
    if (!baseUrl) return { ok: false, models: [], raw: null, error: 'Missing base URL', source: 'direct' };

    try { validateProxyUrl(baseUrl); }
    catch (e) { return { ok: false, models: [], raw: null, error: e.message, source: 'direct' }; }

    const cacheKey = CACHE_PREFIX + baseUrl.replace(/\/+$/, '') + '::' + apiKeyFingerprint(apiKey);
    try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed && Array.isArray(parsed.models)) {
                return { ok: true, models: parsed.models, raw: parsed.raw, source: 'cache' };
            }
        }
    } catch { /* ignore */ }

    const url = baseUrl.replace(/\/+$/, '') + '/v1/models';
    const headers = { 'Accept': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    async function tryDirect() {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        try {
            const res = await fetch(url, { method: 'GET', headers, signal: ctrl.signal });
            return res;
        } finally { clearTimeout(t); }
    }

    async function tryCors() {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        try {
            const res = await fetch(`/proxy/${encodeURIComponent(url)}`, {
                method: 'GET',
                headers: { ...headers, 'X-CSRF-Token': /** @type {any} */ (globalThis).token || '' },
                signal: ctrl.signal,
            });
            return res;
        } finally { clearTimeout(t); }
    }

    let res, source = 'direct';
    try {
        if (via === 'cors') {
            source = 'cors';
            res = await tryCors();
        } else {
            let directErr = null;
            let directRes = null;
            try {
                directRes = await tryDirect();
            } catch (err) {
                directErr = err;
            }
            // BUG-389: fall back to CORS bridge on TypeError/CORS, AbortError (timeout),
            // and HTTP errors — but NOT on auth failures (401/403), which must surface.
            const isNetworkErr = directErr && (
                directErr.name === 'TypeError'
                || directErr.name === 'AbortError'
                || /failed to fetch|cors/i.test(directErr.message || '')
            );
            const isRetryableHttp = directRes && !directRes.ok
                && directRes.status !== 401 && directRes.status !== 403;
            if (via === 'auto' && (isNetworkErr || isRetryableHttp)) {
                source = 'cors';
                res = await tryCors();
            } else if (directErr) {
                throw directErr;
            } else {
                res = directRes;
            }
        }
    } catch (err) {
        return { ok: false, models: [], raw: null, error: err.message || String(err), source };
    }

    if (!res.ok) {
        return { ok: false, models: [], raw: null, error: `HTTP ${res.status} ${res.statusText}`, source };
    }
    let body;
    try { body = await res.json(); }
    catch (err) { return { ok: false, models: [], raw: null, error: 'Response was not valid JSON', source }; }

    const list = Array.isArray(body?.data) ? body.data : (Array.isArray(body) ? body : []);
    const models = list
        .map(m => (typeof m === 'string' ? m : (m?.id || m?.name || m?.model)))
        .filter(Boolean);
    if (models.length === 0) {
        return { ok: false, models: [], raw: body, error: 'No models found in response', source };
    }

    try { sessionStorage.setItem(cacheKey, JSON.stringify({ models, raw: body })); } catch { /* quota */ }
    return { ok: true, models, raw: body, source };
}

/** Clear cached models for one or all base URLs. */
export function clearModelsCache(baseUrl) {
    try {
        if (baseUrl) {
            // BUG-388: cache keys now include an api-key fingerprint suffix, so we
            // must sweep all fingerprints for this base URL.
            const prefix = CACHE_PREFIX + baseUrl.replace(/\/+$/, '') + '::';
            for (let i = sessionStorage.length - 1; i >= 0; i--) {
                const k = sessionStorage.key(i);
                if (k && k.startsWith(prefix)) sessionStorage.removeItem(k);
            }
        } else {
            for (let i = sessionStorage.length - 1; i >= 0; i--) {
                const k = sessionStorage.key(i);
                if (k && k.startsWith(CACHE_PREFIX)) sessionStorage.removeItem(k);
            }
        }
    } catch { /* ignore */ }
}
