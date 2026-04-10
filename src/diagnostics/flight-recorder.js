/**
 * flight-recorder.js — Always-on per-generation summary capture.
 *
 * Subscribes to onPipelineComplete from src/state.js and snapshots a
 * lightweight per-generation summary into a ring buffer. This is the
 * primary data source for diagnostic exports of pipeline behavior.
 *
 * Captures a SUMMARY of lastPipelineTrace, not the full trace, to keep
 * size bounded across many generations. The most recent N generations
 * always survive in memory regardless of debugMode.
 */

import { RingBuffer } from './ring-buffer.js';

export const generationBuffer = new RingBuffer(20);

let started = false;

// Session-scoped title pseudonymizer for flight recorder entries.
// Consistent within a session: "entry X" in gen 5 is the same "entry X" in gen 12.
const _frTitleMap = new Map();
let _frTitleN = 0;
function pseudoTitle(title) {
    if (!title) return '?';
    let p = _frTitleMap.get(title);
    if (!p) { p = `<title-${++_frTitleN}>`; _frTitleMap.set(title, p); }
    return p;
}

/** Convert lastPipelineTrace into a compact summary. */
function summarizeTrace(trace) {
    if (!trace || typeof trace !== 'object') return null;
    const arr = (k) => Array.isArray(trace[k]) ? trace[k].length : 0;
    return {
        keywordMatched:           arr('keywordMatched'),
        aiSelected:               arr('aiSelected'),
        gatedOut:                 arr('gatedOut'),
        contextualGatingRemoved:  arr('contextualGatingRemoved'),
        cooldownRemoved:          arr('cooldownRemoved'),
        warmupFailed:             arr('warmupFailed'),
        refineKeyBlocked:         arr('refineKeyBlocked'),
        stripDedupRemoved:        arr('stripDedupRemoved'),
        budgetCut:                arr('budgetCut'),
        injected:                 arr('injected'),
        injectedTitles:           Array.isArray(trace.injected)
                                      ? trace.injected.slice(0, 30).map(e => pseudoTitle(e?.title || e?.filename || '?'))
                                      : [],
        bootstrapActive:          !!trace.bootstrapActive,
        aiFallback:               !!trace.aiFallback,
        aiError:                  trace.aiError || null,
        budget: trace.budget ? {
            used:  trace.budget.used  ?? null,
            limit: trace.budget.limit ?? null,
            ratio: trace.budget.ratio ?? null,
        } : null,
        aiPreFilter: trace.aiPreFilter ? {
            inputCount:  trace.aiPreFilter.inputCount  ?? null,
            outputCount: trace.aiPreFilter.outputCount ?? null,
        } : null,
        // Pipeline timing (if available in trace)
        totalMs:          trace.totalMs          ?? null,
        keywordMatchMs:   trace.keywordMatchMs   ?? null,
        aiSearchMs:       trace.aiSearchMs       ?? null,
    };
}

/**
 * Record a pipeline abort into the flight recorder.
 * Called from index.js catch block when user stops generation or pipeline times out.
 */
export function recordAbort(reason) {
    try {
        generationBuffer.push({
            t: Date.now(),
            aborted: true,
            reason: reason || 'unknown',
        });
    } catch { /* never throw from diagnostic code */ }
}

/**
 * Start the flight recorder. Safe to call multiple times.
 * Subscribes via onPipelineComplete.
 */
export async function startFlightRecorder() {
    if (started) return;
    started = true;
    try {
        const stateMod = await import('../state.js');
        const { onPipelineComplete } = stateMod;
        if (typeof onPipelineComplete !== 'function') return;

        onPipelineComplete(() => {
            try {
                const trace = stateMod.lastPipelineTrace;
                generationBuffer.push({
                    t: Date.now(),
                    generationCount: stateMod.generationCount ?? null,
                    chatEpoch: stateMod.chatEpoch ?? null,
                    aiCircuitOpen: !!stateMod.aiCircuitOpen,
                    aiCircuitFailures: stateMod.aiCircuitFailures ?? 0,
                    summary: summarizeTrace(trace),
                });
            } catch { /* never throw from observer */ }
        });
    } catch {
        started = false; // allow retry on next call (import may succeed later)
    }
}
