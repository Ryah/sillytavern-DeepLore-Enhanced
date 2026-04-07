/**
 * performance.js — Lightweight perf observation for diagnostic exports.
 *
 * Optional layer on top of interceptors. Captures:
 *   - long tasks (>50ms blocking the main thread)
 *   - memory snapshot (Chrome only — performance.memory)
 *   - basic navigation timing
 *
 * Always-on. Bounded ring buffer. Never throws.
 */

import { RingBuffer } from './ring-buffer.js';

export const longTaskBuffer = new RingBuffer(100);

let started = false;

export function startPerformanceObservers() {
    if (started) return;
    started = true;
    try {
        if (typeof PerformanceObserver === 'undefined') return;
        const obs = new PerformanceObserver((list) => {
            try {
                for (const entry of list.getEntries()) {
                    longTaskBuffer.push({
                        t: Date.now(),
                        name: entry.name,
                        duration: Math.round(entry.duration),
                        startTime: Math.round(entry.startTime),
                    });
                }
            } catch { /* noop */ }
        });
        try { obs.observe({ type: 'longtask', buffered: true }); } catch { /* unsupported in some browsers */ }
    } catch { /* noop */ }
}

/** One-shot snapshot of memory + navigation timing for inclusion in the export. */
export function captureMemorySnapshot() {
    const out = {};
    try {
        if (performance && performance.memory) {
            out.jsHeapSizeLimit = performance.memory.jsHeapSizeLimit;
            out.totalJSHeapSize = performance.memory.totalJSHeapSize;
            out.usedJSHeapSize = performance.memory.usedJSHeapSize;
        }
    } catch { /* noop */ }
    try {
        const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
        if (nav) {
            out.navigation = {
                type: nav.type,
                domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
                loadEvent: Math.round(nav.loadEventEnd),
                duration: Math.round(nav.duration),
            };
        }
    } catch { /* noop */ }
    return out;
}
