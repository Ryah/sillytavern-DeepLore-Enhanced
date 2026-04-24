/**
 * DLE diagnostic logger.
 *
 * Pre-formats printf-style specifiers (%s %d %i %f %o %O %j) and object arguments
 * into a single string BEFORE reaching console.*, so logs remain readable when
 * captured by tooling that does not process the Chrome DevTools Protocol formatArgs
 * channel (e.g. preview_console_logs, automated harnesses). Native Chrome DevTools
 * still displays the result correctly — it just loses the expandable-object affordance.
 *
 * Existing `console.debug('[DLE][DIAG] ... %s %d', a, b)` call sites can migrate by
 * swapping `console.debug` for `ddebug` (same signature). Structured data can be
 * passed as trailing args and will be JSON-stringified rather than flattened to
 * "[object Object]".
 */

function safeJson(v) {
    try {
        return JSON.stringify(v, (_, val) => (typeof val === 'bigint' ? String(val) : val));
    } catch {
        return String(v);
    }
}

function renderValue(v, spec) {
    if (spec === '%d' || spec === '%i') {
        const n = Number(v);
        return Number.isFinite(n) ? String(Math.trunc(n)) : String(v);
    }
    if (spec === '%f') {
        const n = Number(v);
        return Number.isFinite(n) ? String(n) : String(v);
    }
    if (spec === '%o' || spec === '%O' || spec === '%j') return safeJson(v);
    // %s and default
    return typeof v === 'object' && v !== null ? safeJson(v) : String(v);
}

export function fmt(template, ...args) {
    if (typeof template !== 'string') {
        return [template, ...args]
            .map(a => (typeof a === 'object' && a !== null ? safeJson(a) : String(a)))
            .join(' ');
    }
    let i = 0;
    const formatted = template.replace(/%[sdifoOj%]/g, (spec) => {
        if (spec === '%%') return '%';
        if (i >= args.length) return spec;
        return renderValue(args[i++], spec);
    });
    const rest = args.slice(i).map(a => (typeof a === 'object' && a !== null ? safeJson(a) : String(a)));
    return rest.length ? `${formatted} ${rest.join(' ')}` : formatted;
}

export function dlog(template, ...args) { console.log(fmt(template, ...args)); }
export function dwarn(template, ...args) { console.warn(fmt(template, ...args)); }
export function derror(template, ...args) { console.error(fmt(template, ...args)); }
export function ddebug(template, ...args) { console.debug(fmt(template, ...args)); }

/**
 * Convenience helper for [DLE][DIAG] probes. Prepends the tag, expands format specifiers.
 * Example: diag('strip-dedup-log-clear', '— %s, clearing %d stale entries', reason, count);
 */
export function diag(tag, template, ...args) {
    console.debug(fmt(`[DLE][DIAG] ${tag} ${template}`, ...args));
}
