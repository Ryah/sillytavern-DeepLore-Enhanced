/**
 * DeepLore Enhanced Core — Utility Functions
 */

/**
 * Parse simple YAML frontmatter from markdown content.
 * Handles basic key-value pairs and arrays (indented with - ).
 * @param {string} content - Raw markdown content
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseFrontmatter(content) {
    // Strip UTF-8 BOM if present — it prevents the ^--- anchor from matching
    const cleaned = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    const match = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
    if (!match) {
        return { frontmatter: {}, body: cleaned };
    }

    const yamlText = match[1];
    const body = match[2];
    const frontmatter = {};
    let currentKey = null;
    let currentArray = null;
    let blockScalar = null; // { key, style: '|'|'>', lines: [] }

    for (const line of yamlText.split('\n')) {
        const trimmed = line.trimEnd();

        // Block scalar continuation: accumulate indented lines after | or >
        // In YAML, block scalars continue as long as lines are indented or empty.
        // They end when indentation returns to column 0 (a real YAML key).
        if (blockScalar) {
            if (line.match(/^\s/) || trimmed === '') {
                blockScalar.lines.push(trimmed === '' ? '' : trimmed);
                continue;
            } else {
                // End of block scalar — join with appropriate separator
                const sep = blockScalar.style === '|' ? '\n' : ' ';
                frontmatter[blockScalar.key] = blockScalar.lines.join(sep).trim();
                blockScalar = null;
                // Fall through to process current line
            }
        }

        // Array item: "  - value"
        if (/^\s*-\s+/.test(trimmed) && currentKey) {
            let value = trimmed.replace(/^\s*-\s+/, '').trim();
            // Strip surrounding quotes if present (same as scalar values)
            value = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
            // BUG-033: Unescape backslash sequences to match inline array parser behavior
            value = value.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
            if (!currentArray) {
                currentArray = [];
                frontmatter[currentKey] = currentArray;
            }
            currentArray.push(value);
            continue;
        }

        // Key-value pair: "key: value" or "key:"
        const kvMatch = trimmed.match(/^(\w[\w.-]*)\s*:\s*(.*)/);
        if (kvMatch) {
            currentKey = kvMatch[1];
            const rawValue = kvMatch[2].trim();
            currentArray = null;

            if (rawValue === '|' || rawValue === '>') {
                // YAML block scalar: accumulate subsequent indented lines
                blockScalar = { key: currentKey, style: rawValue, lines: [] };
                continue;
            } else if (rawValue === '' || rawValue === '[]') {
                // Value will come as array items on next lines, or is empty
                frontmatter[currentKey] = [];
                currentArray = frontmatter[currentKey];
            } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
                // Inline YAML array: [value1, value2, "quoted value"]
                const inner = rawValue.slice(1, -1).trim();
                if (inner === '') {
                    frontmatter[currentKey] = [];
                } else {
                    // Quote-aware split: respects commas inside quoted values
                    // Only enters quote mode when quote char is at value boundary (not mid-word like King's)
                    const items = [];
                    let current = '';
                    let inQuote = false;
                    let quoteChar = '';
                    let escaped = false;
                    for (const ch of inner) {
                        if (escaped) {
                            current += ch;
                            escaped = false;
                            continue;
                        }
                        if (ch === '\\' && inQuote) {
                            escaped = true;
                            continue;
                        }
                        if (!inQuote && (ch === '"' || ch === "'") && current.trim() === '') {
                            inQuote = true; quoteChar = ch;
                        } else if (inQuote && ch === quoteChar) { inQuote = false; }
                        else if (!inQuote && ch === ',') {
                            items.push(current.trim().replace(/^['"]|['"]$/g, ''));
                            current = '';
                            continue;
                        }
                        current += ch;
                    }
                    if (current.trim()) items.push(current.trim().replace(/^['"]|['"]$/g, ''));
                    frontmatter[currentKey] = items;
                }
                currentArray = frontmatter[currentKey];
            } else if (rawValue === 'true') {
                frontmatter[currentKey] = true;
            } else if (rawValue === 'false') {
                frontmatter[currentKey] = false;
            } else if (rawValue === 'null' || rawValue === '~') {
                frontmatter[currentKey] = null;
            } else if (/^-?(\d+\.?\d*|\.\d+)$/.test(rawValue)) {
                frontmatter[currentKey] = Number(rawValue);
            } else {
                // Strip surrounding quotes if present
                frontmatter[currentKey] = rawValue.replace(/^['"]|['"]$/g, '');
            }
        }
    }

    // Flush any pending block scalar at end of YAML
    if (blockScalar) {
        const sep = blockScalar.style === '|' ? '\n' : ' ';
        frontmatter[blockScalar.key] = blockScalar.lines.join(sep).trim();
    }

    return { frontmatter, body };
}

/**
 * Extract wiki-link targets from raw markdown body before cleaning.
 * Handles [[Target]] and [[Target|Display]] forms.
 * Excludes image embeds (![[...]]).
 * @param {string} body - Raw markdown body (before cleanContent)
 * @returns {string[]} Deduplicated array of link target page names
 */
export function extractWikiLinks(body) {
    if (!body || typeof body !== 'string') return []; // BUG-L1: guard against null/undefined/non-string
    const links = new Set();
    const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    // Strip H1 line so wikilinks in headings aren't treated as entry links
    const bodyWithoutH1 = body.replace(/^#\s+.+$/m, '');
    let match;
    while ((match = regex.exec(bodyWithoutH1)) !== null) {
        // Skip image embeds (prefixed with !)
        if (match.index > 0 && bodyWithoutH1[match.index - 1] === '!') continue;
        links.add(match[1].trim().replace(/\\$/, ''));
    }
    return [...links];
}

/**
 * Clean markdown content for prompt injection.
 * @param {string} content - Raw markdown body (frontmatter already stripped)
 * @returns {string} Cleaned content
 */
export function cleanContent(content) {
    let cleaned = content;

    // Strip %%deeplore-exclude%%...%%/deeplore-exclude%% regions (user-controlled exclusion)
    cleaned = cleaned.replace(/%%deeplore-exclude%%[\s\S]*?%%\/deeplore-exclude%%/g, '');

    // Strip remaining Obsidian %%...%% comment/plugin blocks (timeline annotations, dataview, etc.)
    // Step 1: Strip inline %%...%% on a single line
    cleaned = cleaned.replace(/%%[^%\n]+%%/g, '');
    // Step 2: Strip multi-line %%...%% blocks (require %% at line boundaries)
    cleaned = cleaned.replace(/^%%[\s\S]*?^%%$/gm, '');

    // Strip HTML div tags (keep content inside)
    cleaned = cleaned.replace(/<\/?div[^>]*>/g, '');

    // Strip the first H1 heading (already used as entry title in XML wrapper)
    cleaned = cleaned.replace(/^#\s+.+$/m, '');

    // Strip image embeds: ![[image.png]] or ![alt](url)
    cleaned = cleaned.replace(/!\[\[.*?\]\]/g, '');
    cleaned = cleaned.replace(/!\[.*?\]\(.*?\)/g, '');

    // Convert wiki links: [[Link|Display]] -> Display, [[Link]] -> Link
    cleaned = cleaned.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
    cleaned = cleaned.replace(/\[\[([^\]]+)\]\]/g, '$1');

    // Collapse excessive blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
}

/**
 * Extract title from markdown content.
 * @param {string} body - Markdown body
 * @param {string} filename - Fallback filename
 * @returns {string}
 */
export function extractTitle(body, filename) {
    const h1Match = body.match(/^#\s+(.+)$/m);
    if (h1Match) {
        // Strip wikilink syntax from title: [[Target|Display]] → Display, [[Target]] → Target
        return h1Match[1].trim().replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');
    }
    // Fallback: filename without extension and path
    const parts = filename.split('/');
    const name = parts[parts.length - 1];
    return name.replace(/\.md$/, '');
}

/**
 * Truncate text at the nearest sentence boundary before maxLen.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
// BUG-054: was ASCII-only (`.!?`) and produced mid-sentence cuts on CJK/emoji
// and dangling brackets on markdown. Now mirrors ST's `trimToEndSentence`
// (public/scripts/utils.js:883) — full Unicode punctuation set + emoji
// sentence-enders — but keeps the original maxLen-aware API by pre-slicing,
// so core/ stays free of ST imports.
const _SENTENCE_PUNCT = new Set([
    '.', '!', '?', '*', '"', ')', '}', '`', ']', '$',
    '。', '！', '？', '”', '）', '】', '’', '」', '_',
]);
const _EMOJI_RE = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu;

// Returns the string trimmed to the last sentence-ending punctuation / emoji,
// or null if no boundary was found. Unlike ST's trimToEndSentence, this signals
// "no boundary" explicitly so the caller can fall back to an ellipsis.
function _trimToSentenceEnd(input) {
    if (!input) return null;
    let last = -1;
    const characters = Array.from(input);
    for (let i = characters.length - 1; i >= 0; i--) {
        const char = characters[i];
        const emoji = _EMOJI_RE.test(char);
        _EMOJI_RE.lastIndex = 0; // reset sticky state from /g
        if (_SENTENCE_PUNCT.has(char) || emoji) {
            if (!emoji && i > 0 && /[\s\n]/.test(characters[i - 1])) {
                last = i - 1;
            } else {
                last = i;
            }
            break;
        }
    }
    if (last === -1) return null;
    return characters.slice(0, last + 1).join('').trimEnd();
}

export function truncateToSentence(text, maxLen) {
    if (text.length <= maxLen) return text;
    const truncated = text.substring(0, maxLen);
    const trimmed = _trimToSentenceEnd(truncated);
    // Only accept the sentence-boundary cut if it kept enough of the budget;
    // otherwise fall back to hard cut + ellipsis.
    if (trimmed && trimmed.length > maxLen * 0.4) return trimmed;
    return truncated.trimEnd() + '...';
}

/**
 * Compute a simple hash for cache comparison.
 * @param {string} text
 * @returns {string}
 */
export function simpleHash(text) {
    if (!text) return '0_0';
    let h1 = 5381, h2 = 52711;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = ((h1 << 5) + h1 + c) | 0;
        h2 = ((h2 << 5) + h2 + c) | 0;
    }
    return `${text.length}_${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}`;
}

/**
 * Escape a string for use in a regex.
 * @param {string} str
 * @returns {string}
 */
export function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape XML/HTML special characters in a string.
 * Handles &, <, >, and " — safe for attribute values and element content.
 * R7: Consolidated from 5 inline implementations across the codebase.
 * @param {string} str
 * @returns {string}
 */
export function escapeXml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * BUG-145: Centralized "is this message scannable?" predicate so DLE's scan/context
 * builders can't drift apart from each other or from openai.js's prompt builder.
 * Mirrors openai.js's exclusion set: tool invocations, system messages, hidden
 * narrator/thoughts entries, and the modern is_thoughts/extra.type === 'narrator' flags.
 */
function _isScannableMessage(m) {
    if (m == null) return false;
    if (m.is_system) return false;
    if (m.is_thoughts) return false;
    const ex = m.extra;
    if (ex) {
        if (ex.tool_invocations) return false;
        if (ex.type === 'narrator') return false;
        if (ex.isSmallSys) return false;
    }
    return true;
}

/**
 * Build scan text from chat messages.
 * @param {object[]} chat - Chat messages array
 * @param {number} depth - Number of recent messages to scan
 * @returns {string}
 */
export function buildScanText(chat, depth) {
    if (depth <= 0) return '';
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages
        .filter(_isScannableMessage)
        .map(m => `${m.name || ''}: ${typeof m.mes === 'string' ? m.mes : ''}`)
        .join('\n');
}

/**
 * Build annotated chat context for AI search.
 * Marks speakers as (user) or (character) to clarify conversation roles.
 * @param {object[]} chat - Chat messages array
 * @param {number} depth - Number of recent messages to scan
 * @returns {string}
 */
export function buildAiChatContext(chat, depth) {
    if (depth <= 0) return '';
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages
        .filter(_isScannableMessage)
        .map(m => {
            const speaker = m.name || 'Unknown';
            const role = m.is_user ? '(user)' : '(character)';
            return `${speaker} ${role}: ${typeof m.mes === 'string' ? m.mes : ''}`;
        })
        .join('\n');
}

/**
 * Clamp a numeric setting to [min, max] and log if clamped.
 * @param {object} obj - Settings object
 * @param {string} key - Setting key
 * @param {number} min
 * @param {number} max
 * @param {string} label - Human-readable label for logging
 */
function clampWithLog(obj, key, min, max, label) {
    const before = obj[key];
    // Only round to integer if the constraint range is integer-based (min and max are both integers).
    // Float constraints (e.g. fuzzySearchMinScore: 0.1–2.0) must preserve decimal precision.
    const isIntegerRange = Number.isInteger(min) && Number.isInteger(max);
    obj[key] = Math.max(min, Math.min(max, isIntegerRange ? Math.round(obj[key]) : obj[key]));
    if (before !== obj[key]) {
        console.info(`[DLE] ${label} clamped from ${before} to ${obj[key]} (range: ${min}-${max})`);
    }
}

/**
 * Validate and clamp settings to their allowed ranges.
 * @param {object} settings - Settings object to validate in-place
 * @param {object} constraints - Map of setting key to { min, max, label }
 */
/**
 * Escape a string for safe use as a YAML value.
 * Wraps in double quotes if the string contains special YAML characters,
 * leading/trailing whitespace, or control characters (newline, return, tab).
 * @param {string} str
 * @returns {string}
 */
export function yamlEscape(str) {
    if (/[:#\[\]{}&*!|>'"%@`\n\r\t]/.test(str) || str.trim() !== str) {
        return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
    }
    return str;
}

/**
 * User-friendly message shown when no vault entries are loaded.
 */
export const NO_ENTRIES_MSG = 'No entries found. Check your Obsidian vault connection, or run /dle-health to troubleshoot.';

/**
 * Classify an error into a user-friendly message based on common patterns.
 * @param {Error|string} err - The error to classify
 * @returns {string} A user-friendly error description
 */
/**
 * BUG-260: Central AbortError detector. Catches classic err.name === 'AbortError',
 * our flag-tagged variants (userAborted/timedOut), and DOMException abort variants
 * (DOMException with name 'AbortError', which some fetch implementations throw).
 * Use instead of bare `err.name === 'AbortError'` comparisons.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAbortError(err) {
    if (!err || typeof err !== 'object') return false;
    if (err.userAborted || err.timedOut) return true;
    if (err.name === 'AbortError') return true;
    if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true;
    return false;
}

export function classifyError(err) {
    // BUG-246: discriminate user-abort from timeout using flags set by callViaProfile/callViaProxy
    // (err.userAborted vs err.timedOut). Fall back to regex only for raw strings / foreign errors,
    // and do NOT treat bare "AbortError" as a timeout — an AbortError with no flag is most likely
    // a user cancel, not a timed-out request.
    if (typeof err === 'object' && err !== null) {
        if (err.userAborted) return 'Cancelled.';
        if (err.timedOut) return 'The request timed out. Try increasing the timeout in settings.';
        if (err.throttled) return 'Slow down — too many AI calls in quick succession.';
    }
    const raw = typeof err === 'string' ? err : String(err.message || err);
    if (err && err.name === 'AbortError') {
        // Unflagged AbortError — assume user cancel (timeouts are flagged by our own code).
        return 'Cancelled.';
    }
    if (/timeout|timed out/i.test(raw)) {
        return 'The request timed out. Try increasing the timeout in settings.';
    }
    if (/\b401\b|\b403\b|\bauth\b|unauthorized|forbidden/i.test(raw)) {
        return 'Authentication failed. Check your API key or connection profile.';
    }
    if (/ECONNREFUSED|Failed to fetch|NetworkError|fetch failed/i.test(raw)) {
        return 'Could not connect. Check that the service is running.';
    }
    if (/\b404\b|Not Found/i.test(raw)) {
        return 'Endpoint not found (404). Check that the URL is correct.';
    }
    if (/\b429\b|Too Many Requests|rate.?limit/i.test(raw)) {
        return 'Rate limited (429). Wait a moment before retrying.';
    }
    if (/\b5\d{2}\b|Internal Server Error|Bad Gateway|Service Unavailable/i.test(raw)) {
        return 'The server returned an error. Try again in a moment.';
    }
    // Scrub potential API keys/tokens from error messages BEFORE truncation so secrets after char 120 are still removed
    let safe = raw.replace(/Bearer\s+[A-Za-z0-9_\-./]{10,}/g, 'Bearer ***');
    safe = safe.replace(/[?&](key|apiKey|api_key|token|secret)=[^&\s]{8,}/gi, '$1=***');
    if (safe.length > 120) safe = safe.slice(0, 120) + '...';
    return safe;
}

export function validateSettings(settings, constraints, defaults) {
    for (const [key, constraint] of Object.entries(constraints)) {
        const { min, max, label, enum: enumValues } = constraint;
        if (Array.isArray(enumValues)) {
            // BUG-344: string-enum whitelist. Reset typo'd enum values to default.
            if (settings[key] !== undefined && !enumValues.includes(settings[key])) {
                const fallback = defaults ? defaults[key] : enumValues[0];
                console.info(`[DLE] ${label || key} invalid enum value ${JSON.stringify(settings[key])} reset to ${JSON.stringify(fallback)} (allowed: ${enumValues.join(', ')})`);
                settings[key] = fallback;
            }
            continue;
        }
        if (typeof settings[key] === 'number') {
            clampWithLog(settings, key, min, max, label || key);
        }
    }
    // Ensure tags are trimmed strings
    if (typeof settings.lorebookTag === 'string') {
        settings.lorebookTag = settings.lorebookTag.trim() || 'lorebook';
    }
}
