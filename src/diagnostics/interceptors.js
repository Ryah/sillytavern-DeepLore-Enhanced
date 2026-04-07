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

// ── Single install guard (HMR / double-import safe).
let installed = false;

/** Best-effort live read of debugMode without creating a hard import dep. */
function debugModeOn() {
    try {
        return !!(globalThis.extension_settings?.deeplore?.debugMode);
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
                consoleBuffer.push({
                    t: Date.now(),
                    level,
                    msg: safeStringify(args),
                });
            } catch { /* never throw */ }
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
            else if (input && typeof input.url === 'string') url = input.url;
            method = (init && init.method) || (input && input.method) || 'GET';
        } catch { /* noop */ }

        const entry = { t: start, kind: 'fetch', method, url, status: 0, durMs: 0, ok: false };
        try {
            const resp = await orig(input, init);
            entry.status = resp.status;
            entry.ok = resp.ok;
            entry.durMs = Date.now() - start;
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
    const origOpen = proto.open;
    const origSend = proto.send;

    proto.open = function (method, url, ...rest) {
        try {
            this.__dle_diag = { t: Date.now(), kind: 'xhr', method, url, status: 0, durMs: 0, ok: false };
        } catch { /* noop */ }
        return origOpen.call(this, method, url, ...rest);
    };

    proto.send = function (...args) {
        try {
            const meta = this.__dle_diag;
            if (meta) {
                this.addEventListener('loadend', () => {
                    try {
                        meta.status = this.status;
                        meta.ok = this.status >= 200 && this.status < 400;
                        meta.durMs = Date.now() - meta.t;
                        networkBuffer.push(meta);
                        maybeEcho('log', 'xhr', meta);
                    } catch { /* noop */ }
                });
            }
        } catch { /* noop */ }
        return origSend.apply(this, args);
    };
}

function patchErrors() {
    if (typeof window === 'undefined') return;

    const prevOnError = window.onerror;
    window.onerror = function (message, source, lineno, colno, error) {
        try {
            errorBuffer.push({
                t: Date.now(),
                kind: 'window.onerror',
                message: String(message),
                source: source || '',
                lineno, colno,
                stack: (error && error.stack) || '',
            });
            maybeEcho('error', 'onerror', { message, source, lineno });
        } catch { /* noop */ }
        if (typeof prevOnError === 'function') {
            try { return prevOnError.apply(this, arguments); } catch { /* noop */ }
        }
        return false;
    };

    const prevOnRej = window.onunhandledrejection;
    window.onunhandledrejection = function (ev) {
        try {
            const reason = ev && ev.reason;
            errorBuffer.push({
                t: Date.now(),
                kind: 'unhandledrejection',
                message: (reason && reason.message) || String(reason),
                stack: (reason && reason.stack) || '',
            });
            maybeEcho('error', 'rej', reason);
        } catch { /* noop */ }
        if (typeof prevOnRej === 'function') {
            try { return prevOnRej.apply(this, arguments); } catch { /* noop */ }
        }
    };
}

/**
 * Install all interceptors. Safe to call multiple times — second call is a no-op.
 */
export function installInterceptors() {
    if (installed) return;
    installed = true;
    try { patchConsole(); } catch { /* noop */ }
    try { patchFetch(); } catch { /* noop */ }
    try { patchXHR(); } catch { /* noop */ }
    try { patchErrors(); } catch { /* noop */ }
}
