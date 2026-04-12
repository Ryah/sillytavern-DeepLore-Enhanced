/**
 * scrubber.js — PII / secrets scrubbing for diagnostic exports.
 *
 * Anonymizes sensitive substrings while PRESERVING CARDINALITY: the same real
 * value always maps to the same pseudonym within one export, so a reader can
 * still tell "DLE talked to 4 distinct hosts" or "the same IP errored 12 times
 * in a row." Different exports get different pseudonym tables (the map is
 * created fresh inside scrubDeep), so values cannot be correlated across files.
 *
 * Two entry points:
 *   scrubString(str, ctx?)  — regex pass over a single string, using ctx.
 *   scrubDeep(value)        — recursive walk; creates a fresh ctx and returns
 *                             a new structure with sensitive fields redacted.
 *
 * Design notes:
 *   - Never throws. A scrubber bug must not break the export.
 *   - Operates on a deep copy; the original state is untouched.
 *   - Field-name based redaction handles known-sensitive keys (API keys,
 *     auth tokens) at any nesting depth.
 *   - String regex pass catches secrets that leak into log messages, URLs,
 *     error stack traces, etc.
 *   - Excludes (does not even read): chat message bodies and vault entry
 *     content. Those are stripped at the snapshot layer, not here.
 */

// ── Field-name patterns: any object key matching one of these gets <redacted>.
// (Keys are always replaced wholesale — no cardinality is meaningful for a secret.)
const SENSITIVE_KEY_RE = /(api[_-]?key|apikey|access[_-]?token|secret|password|passwd|authorization|auth[_-]?header|bearer|x[_-]?api[_-]?key|obsidianapikey|proxy[_-]?key|cookie|session|refresh[_-]?token|oauth[_-]?token|private[_-]?key|client[_-]?id|app[_-]?key|encryption[_-]?key|master[_-]?key|helicone[_-]?auth|cf[_-]?access|credential|webhook)/i;

/**
 * Per-export context. Maps from real value → stable pseudonym.
 * Each pseudonym table is independent so e.g. <ip-1> and <host-1> can coexist.
 * Includes stats counters so the report can show what was scrubbed.
 */
export function makeCtx() {
    return {
        ip: new Map(),
        ipv6: new Map(),
        email: new Map(),
        host: new Map(),
        userPath: new Map(),
        title: new Map(),
        stats: {
            ips: 0,
            ipv6s: 0,
            emails: 0,
            hosts: 0,
            userPaths: 0,
            titles: 0,
            bearerTokens: 0,
            urlTokens: 0,
            openaiKeys: 0,
            longTokens: 0,
            sensitiveFields: 0,
        },
    };
}

function pseudonym(map, real, prefix) {
    let p = map.get(real);
    if (!p) {
        p = `<${prefix}-${map.size + 1}>`;
        map.set(real, p);
    }
    return p;
}

// ── Patterns. Each has a `replace` that takes (match, ctx) and returns the
// replacement string. Order matters — more specific first.
const PATTERNS = [
    // Bearer / Authorization header values inline in strings
    {
        re: /(Bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi,
        fn: (m, _g1, _o, _s, ctx) => { ctx.stats.bearerTokens++; return m.replace(/(Bearer\s+).+/i, '$1<token>'); },
    },
    // URL query-string tokens: ?key=abc... &token=... (expanded to cover more param names)
    {
        re: /([?&](?:key|token|access_token|api_key|auth|secret|password|jwt|bearer|authorization|oauth_token)=)[^&\s"']+/gi,
        fn: (_m, g1, _o, _s, ctx) => { ctx.stats.urlTokens++; return `${g1}<token>`; },
    },
    // OpenAI / Anthropic / Stripe key formats: sk-proj-..., sk_test_..., sk-ant-..., sk_live_...
    {
        re: /\bsk[-_][A-Za-z0-9_\-]{20,}\b/g,
        fn: (_m, _o, _s, ctx) => { ctx.stats.openaiKeys++; return '<openai-key>'; },
    },
    // IPv4 (with optional port). Conservative — requires 0-255 range to avoid
    // false positives on version strings like 1.2.3.4 in changelogs (it'll still
    // match those, but they're rare in our log surface).
    {
        re: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?::(\d{1,5}))?\b/g,
        fn: (m, port, _o, _s, ctx) => {
            ctx.stats.ips++;
            const ipPart = m.replace(/:\d+$/, '');
            // Keep first two octets visible for network-level tracking,
            // mask last two for privacy. Same real IP → same masked suffix.
            const octets = ipPart.split('.');
            const prefix = `${octets[0]}.${octets[1]}`;
            const suffix = `${octets[2]}.${octets[3]}`;
            const masked = pseudonym(ctx.ip, suffix, 'host');
            const alias = `${prefix}.${masked}`;
            return port ? `${alias}:${port}` : alias;
        },
    },
    // IPv6 (loose — any run of hex groups separated by colons, with at least two colons)
    {
        re: /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g,
        fn: (m, _o, _s, ctx) => { ctx.stats.ipv6s++; return pseudonym(ctx.ipv6, m, 'ipv6'); },
    },
    // Email
    {
        re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
        fn: (m, _o, _s, ctx) => { ctx.stats.emails++; return pseudonym(ctx.email, m.toLowerCase(), 'email'); },
    },
    // Windows user home paths: C:\Users\<name>\... → C:\Users\<user-N>\...
    {
        re: /([A-Za-z]:\\Users\\)([^\\\/\s"']+)/g,
        fn: (_m, prefix, name, _o, _s, ctx) => { ctx.stats.userPaths++; return `${prefix}${pseudonym(ctx.userPath, name.toLowerCase(), 'user')}`; },
    },
    // POSIX home paths
    {
        re: /(\/(?:home|Users)\/)([^\/\s"']+)/g,
        fn: (_m, prefix, name, _o, _s, ctx) => { ctx.stats.userPaths++; return `${prefix}${pseudonym(ctx.userPath, name.toLowerCase(), 'user')}`; },
    },
    // Hostnames inside URLs (after the scheme). Skips localhost. Done after IP
    // pattern so numeric hosts have already been pseudonymized.
    {
        re: /(https?:\/\/)([A-Za-z0-9][A-Za-z0-9.\-]*)(?=[/:?#]|$)/g,
        fn: (_m, scheme, host, _o, _s, ctx) => {
            if (host === 'localhost' || host.startsWith('<ip')) return `${scheme}${host}`;
            ctx.stats.hosts++;
            return `${scheme}${pseudonym(ctx.host, host.toLowerCase(), 'host')}`;
        },
    },
    // Generic high-entropy long token strings (32+ chars of base64/hex-ish).
    // Last so it can't clobber more specific patterns. No cardinality value — uniformly redact.
    {
        re: /\b[A-Za-z0-9_\-]{32,}\b/g,
        fn: (_m, _o, _s, ctx) => { ctx.stats.longTokens++; return '<long-token>'; },
    },
];

/**
 * Scrub a single string against the given context (or a fresh one).
 * Returns a new string. Never throws.
 */
export function scrubString(str, ctx) {
    if (typeof str !== 'string' || str.length === 0) return str;
    if (!ctx) ctx = makeCtx();
    try {
        let out = str;
        for (const { re, fn } of PATTERNS) {
            // Wrap fn so the trailing ctx is always available regardless of capture-group count.
            out = out.replace(re, function (...args) {
                // args is [match, ...groups, offset, fullString, namedGroups?]
                // Append ctx so the pattern fn can access it as the last positional arg.
                return fn.apply(null, [...args, ctx]);
            });
        }
        return out;
    } catch {
        return str;
    }
}

/**
 * Recursively walk a value and return a scrubbed deep copy.
 *
 * - Strings: passed through scrubString() with the shared ctx.
 * - Objects: keys matching SENSITIVE_KEY_RE are replaced with '<redacted>'.
 *            Other keys are recursed.
 * - Arrays: each element recursed.
 * - Numbers/booleans/null/undefined: passed through.
 * - Functions / class instances: replaced with their constructor name.
 *
 * Cycle-safe via WeakMap.
 *
 * @param {*} value
 * @param {object} [ctx] Per-export pseudonym tables; created fresh if omitted.
 */
export function scrubDeep(value, ctx, _seen = new WeakMap()) {
    if (!ctx) ctx = makeCtx();
    try {
        if (value === null || value === undefined) return value;
        const t = typeof value;
        if (t === 'string') return scrubString(value, ctx);
        if (t === 'number' || t === 'boolean' || t === 'bigint') return value;
        if (t === 'function') return `[fn ${value.name || 'anon'}]`;

        if (t === 'object') {
            if (_seen.has(value)) return '[circular]';
            _seen.set(value, true);

            if (Array.isArray(value)) {
                return value.map(v => scrubDeep(v, ctx, _seen));
            }

            const proto = Object.getPrototypeOf(value);
            if (proto && proto !== Object.prototype && proto !== null) {
                if (value instanceof Error) {
                    return {
                        __type: 'Error',
                        name: value.name,
                        message: scrubString(value.message || '', ctx),
                        stack: scrubString(value.stack || '', ctx),
                    };
                }
                if (value instanceof Map) {
                    const obj = {};
                    for (const [k, v] of value.entries()) {
                        const ks = scrubString(String(k), ctx); // scrub tracker keys (vaultSource:title)
                        if (SENSITIVE_KEY_RE.test(ks)) {
                            ctx.stats.sensitiveFields++;
                            obj[ks] = '<redacted>';
                        } else {
                            obj[ks] = scrubDeep(v, ctx, _seen);
                        }
                    }
                    return { __type: 'Map', entries: obj };
                }
                if (value instanceof Set) {
                    return { __type: 'Set', values: Array.from(value).map(v => scrubDeep(v, ctx, _seen)) };
                }
                // Unknown class — fall through to plain-object copy
            }

            const out = {};
            for (const k of Object.keys(value)) {
                if (SENSITIVE_KEY_RE.test(k)) {
                    ctx.stats.sensitiveFields++;
                    out[k] = '<redacted>';
                } else {
                    out[k] = scrubDeep(value[k], ctx, _seen);
                }
            }
            return out;
        }

        return value;
    } catch {
        return '[scrub failed]';
    }
}
