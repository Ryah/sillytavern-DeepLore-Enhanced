/**
 * RingBuffer — bounded FIFO. Item-count capped (not byte-capped) for predictable
 * cost. Always-on, never throws. push(): appends, evicts oldest when over capacity.
 * drain(): non-destructive snapshot. flush(): destructive snapshot. clear(): reset.
 */
export class RingBuffer {
    constructor(capacity = 500) {
        this.capacity = Math.max(1, capacity | 0);
        this.items = [];
    }

    push(item) {
        try {
            this.items.push(item);
            if (this.items.length > this.capacity) {
                this.items.splice(0, this.items.length - this.capacity);
            }
        } catch { /* never throw from a diagnostic interceptor */ }
    }

    /** Non-destructive shallow copy (oldest → newest). */
    drain() {
        return this.items.slice();
    }

    /** Destructive snapshot — for export paths; use drain() for inspectors. */
    flush() {
        const snapshot = this.items.slice();
        this.items = [];
        return snapshot;
    }

    get length() { return this.items.length; }

    clear() { this.items = []; }
}

/** Stringify console args without ever throwing. */
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
                // BUG-035: fresh per-call WeakSet — cycle detection must not leak
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

// BUG-035: factory returns a fresh replacer + private WeakSet per call so
// cycle detection never outlives a single JSON.stringify invocation.
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
