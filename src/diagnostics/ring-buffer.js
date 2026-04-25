/**
 * RingBuffer — bounded FIFO buffer for diagnostic data.
 *
 * Used as the in-memory backing store for console logs, network logs,
 * pipeline traces, performance entries, and errors. Always-on; never throws.
 *
 * Behavior:
 *   - push(item) appends; if length > capacity, oldest item is dropped.
 *   - capacity is item-count based (not byte-based) for predictable cost.
 *   - drain() returns a snapshot copy and leaves the buffer untouched.
 *   - clear() resets to empty.
 */
export class RingBuffer {
    /**
     * @param {number} capacity Maximum item count before oldest is evicted.
     */
    constructor(capacity = 500) {
        this.capacity = Math.max(1, capacity | 0);
        this.items = [];
    }

    push(item) {
        try {
            this.items.push(item);
            if (this.items.length > this.capacity) {
                // Drop oldest. Splice from front; cheap enough at our scales.
                this.items.splice(0, this.items.length - this.capacity);
            }
        } catch { /* never throw from a diagnostic interceptor */ }
    }

    /** Return a shallow copy of the current contents (oldest → newest). Non-destructive. */
    drain() {
        return this.items.slice();
    }

    /**
     * Snapshot-and-clear. Returns the current contents and resets the buffer.
     * Use for export paths where the caller intends destructive read; use
     * drain() for inspectors and developer tooling that should not mutate.
     */
    flush() {
        const snapshot = this.items.slice();
        this.items = [];
        return snapshot;
    }

    get length() { return this.items.length; }

    clear() { this.items = []; }
}

/** Convenience: safely stringify console arguments without ever throwing. */
export function safeStringify(args, maxLen = 2000) {
    try {
        const parts = [];
        for (const a of args) {
            if (a === undefined) { parts.push('undefined'); continue; }
            if (a === null) { parts.push('null'); continue; }
            const t = typeof a;
            if (t === 'string') { parts.push(a); continue; }
            if (t === 'number' || t === 'boolean' || t === 'bigint') { parts.push(String(a)); continue; }
            if (a instanceof Error) {
                parts.push(`${a.name}: ${a.message}\n${a.stack || ''}`);
                continue;
            }
            try {
                // BUG-035: fresh per-call WeakSet so cycle detection doesn't leak
                // references between unrelated serialize calls.
                parts.push(JSON.stringify(a, makeJsonReplacer()));
            } catch {
                parts.push('[unserializable]');
            }
        }
        let out = parts.length === 1 ? parts[0] : parts.join(' | ');
        if (out.length > maxLen) out = out.slice(0, maxLen) + `…[+${out.length - maxLen} chars]`;
        return out;
    } catch {
        return '[stringify failed]';
    }
}

// BUG-035: factory returns a fresh replacer + private WeakSet per call so the
// cycle-detection set never outlives a single JSON.stringify invocation.
function makeJsonReplacer() {
    const seen = new WeakSet();
    return function jsonReplacer(key, value) {
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[circular]';
            seen.add(value);
        }
        if (typeof value === 'function') return `[fn ${value.name || 'anon'}]`;
        if (typeof value === 'bigint') return value.toString() + 'n';
        return value;
    };
}
