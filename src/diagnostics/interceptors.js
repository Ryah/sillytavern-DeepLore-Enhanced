/**
 * interceptors.js — Always-on monkey patches for console / fetch / XHR / errors.
 *
 * Installed at module-eval time via boot.js (the very first import in index.js).
 * Writes into in-memory ring buffers regardless of debugMode setting; the
 * `debugMode` toggle only controls whether the same data is also echoed to a
 * user-visible log surface (currently: a console group prefixed with [DLE-DBG]).
 *
 * Every interceptor is wrapped in try/catch so a bug here can never break ST.
 */

import { RingBuffer, safeStringify } from './ring-buffer.js';

// ── Buffers (exported so flight-recorder / export.js can drain them).
export const consoleBuffer = new RingBuffer(800);
export const networkBuffer = new RingBuffer(300);
export const errorBuffer = new RingBuffer(100);

/** AI call buffer — per-call details for diagnosing AI failures without debugMode.
 *  Populated by recordAiCall() from ai.js after each callAI invocation. */
export const aiCallBuffer = new RingBuffer(40);

/** AI prompt replay buffer — full system+user prompt text for replay/reproduction.
 *  PII-SENSITIVE: only populated when `debugMode === true` (user opt-in).
 *  Kept small and passed through scrubber on export. User can drain
 *  locally via `__DLE_DEBUG.buffers.aiPrompts` to reproduce failing calls. */
export const aiPromptBuffer = new RingBuffer(20);

/** Lifecycle event buffer — settings changes, chat switches, index builds, circuit transitions.
 *  Populated by pushEvent() calls from various DLE modules. */
export const eventBuffer = new RingBuffer(200);

/**
 * Record a DLE lifecycle event. Safe to call from anywhere — never throws.
 * @param {string} kind - Event type (e.g., 'chat_changed', 'setting', 'index_build', 'ai_circuit', 'enabled')
 * @param {object} [data] - Event-specific payload (kept small — no content/PII)
 */
export function pushEvent(kind, data) {
    try { eventBuffer.push({ ...data, t: Date.now(), kind }); } catch { /* never throw */ }
}

/**
 * Single chokepoint for AbortController.abort() across DLE.
 * Stamps the source onto signal.reason so post-mortem catch blocks can attribute the abort.
 * Reviewers: reject any direct controller.abort() — use this instead. See docs/gotchas.md.
 * @param {AbortController} controller
 * @param {string} reason - Flat snake_case source identifier (e.g. 'ai:timeout', 'popup_closing')
 */
export function abortWith(controller, reason) {
    try {
        if (!controller || controller.signal?.aborted) return;
        controller.abort(new DOMException(String(reason || 'unknown'), 'AbortError'));
    } catch { /* never throw */ }
}

// ── Single install guard (HMR / double-import safe).
let installed = false;

/** Best-effort live read of debugMode without creating a hard import dep. */
function debugModeOn() {
    try {
        // DIAG-01: canonical settings key is 'deeplore_enhanced', not legacy 'deeplore'.
        return !!(globalThis.extension_settings?.deeplore_enhanced?.debugMode);
    } catch { return false; }
}

function maybeEcho(level, label, payload) {
    if (!debugModeOn()) return;
    try {
        // Use the original (saved) console funcs so we don't recurse.
        const fn = ORIGINAL_CONSOLE[level] || ORIGINAL_CONSOLE.log;
        fn.call(console, `[DLE-DBG ${label}]`, payload);
    } catch { /* noop */ }
}

const ORIGINAL_CONSOLE = {};

function patchConsole() {
    const levels = ['log', 'warn', 'error', 'debug', 'info'];
    for (const level of levels) {
        const orig = console[level];
        if (typeof orig !== 'function') continue;
        ORIGINAL_CONSOLE[level] = orig;
        console[level] = function (...args) {
            try {
                const msg = safeStringify(args);
                const entry = { t: Date.now(), level, msg };
                // Tag DLE-originated entries so they can be filtered from global noise
                if (msg.startsWith('[DLE') || msg.startsWith('"[DLE')) entry.dle = true;
                consoleBuffer.push(entry);
            } catch {
                try { consoleBuffer.push({ t: Date.now(), level, msg: '[serialization failed]' }); } catch { /* last resort */ }
            }
            try { return orig.apply(this, args); } catch { /* swallow */ }
        };
    }
}

function patchFetch() {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    const orig = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        const start = Date.now();
        let url = '';
        let method = 'GET';
        try {
            if (typeof input === 'string') url = input;
            else if (typeof Request !== 'undefined' && input instanceof Request) url = input.url;
            else if (input && typeof input.url === 'string') url = input.url;
            method = (init && init.method) || (input && input.method) || 'GET';
        } catch { /* noop */ }

        const entry = { t: start, kind: 'fetch', method, url, status: 0, durMs: 0, ok: false };
        try {
            const resp = await orig(input, init);
            entry.status = resp.status;
            entry.ok = resp.ok;
            entry.durMs = Date.now() - start;
            // Capture error response body snippet for non-2xx responses (aids AI call debugging)
            if (!resp.ok) {
                try {
                    const body = await resp.clone().text();
                    entry.errorBody = body.slice(0, 500);
                } catch { /* body read failed — ok, we still have status */ }
            }
            networkBuffer.push(entry);
            maybeEcho('log', 'fetch', entry);
            return resp;
        } catch (err) {
            entry.durMs = Date.now() - start;
            entry.error = (err && err.message) || String(err);
            networkBuffer.push(entry);
            maybeEcho('warn', 'fetch-err', entry);
            throw err;
        }
    };
}

function patchXHR() {
    if (typeof XMLHttpRequest === 'undefined') return;
    const proto = XMLHttpRequest.prototype;
    // Sentinel: prevent double-chaining if module is re-evaluated (e.g., test harness)
    if (proto.open?.__dle_patched) return;
    const origOpen = proto.open;
    const origSend = proto.send;

    proto.open = function (method, url, ...rest) {
        try {
            this.__dle_diag = { t: Date.now(), kind: 'xhr', method, url, status: 0, durMs: 0, ok: false };
        } catch { /* noop */ }
        return origOpen.call(this, method, url, ...rest);
    };
    proto.open.__dle_patched = true;

    proto.send = function (...args) {
        try {
            const meta = this.__dle_diag;
            if (meta) {
                // { once: true } prevents listener accumulation if XHR object is reused
                this.addEventListener('loadend', () => {
                    try {
                        meta.status = this.status;
                        meta.ok = this.status >= 200 && this.status < 400;
                        meta.durMs = Date.now() - meta.t;
                        networkBuffer.push(meta);
                        maybeEcho('log', 'xhr', meta);
                    } catch { /* noop */ }
                }, { once: true });
            }
        } catch { /* noop */ }
        return origSend.apply(this, args);
    };
}

function patchErrors() {
    if (typeof window === 'undefined') return;

    // Use addEventListener instead of assignment to avoid last-writer-wins conflicts
    // with ST core or other extensions that also set window.onerror.
    window.addEventListener('error', (event) => {
        try {
            errorBuffer.push({
                t: Date.now(),
                kind: 'window.onerror',
                message: String(event.message || ''),
                source: event.filename || '',
                lineno: event.lineno,
                colno: event.colno,
                stack: (event.error && event.error.stack) || '',
            });
            maybeEcho('error', 'onerror', { message: event.message, source: event.filename, lineno: event.lineno });
        } catch { /* noop */ }
    });

    window.addEventListener('unhandledrejection', (event) => {
        try {
            const reason = event.reason;
            errorBuffer.push({
                t: Date.now(),
                kind: 'unhandledrejection',
                message: (reason && reason.message) || String(reason),
                stack: (reason && reason.stack) || '',
            });
            maybeEcho('error', 'rej', reason);
        } catch { /* noop */ }
    });
}

/**
 * Install all interceptors. Safe to call multiple times — second call is a no-op.
 */
/** Tracks which interceptors failed to install (readable by export.js for diagnostics). */
export const installFailures = [];

export function installInterceptors() {
    if (installed) return;
    installed = true;
    for (const [name, fn] of [['console', patchConsole], ['fetch', patchFetch], ['xhr', patchXHR], ['errors', patchErrors]]) {
        try { fn(); } catch (e) {
            installFailures.push({ target: name, error: e?.message || String(e), t: Date.now() });
            try { errorBuffer.push({ t: Date.now(), kind: 'interceptor-install-failure', target: name, message: e?.message || String(e) }); } catch { /* last resort */ }
        }
    }
}
