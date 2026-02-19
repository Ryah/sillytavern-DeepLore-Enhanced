/**
 * DeepLore Enhanced unit tests
 * Run with: node tests.js
 *
 * Tests pure functions extracted from index.js.
 * These are duplicated here to avoid ESM/browser import issues.
 */

// ============================================================================
// Functions under test (copied from index.js for standalone testing)
// ============================================================================

function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return { frontmatter: {}, body: content };
    }

    const yamlText = match[1];
    const body = match[2];
    const frontmatter = {};
    let currentKey = null;
    let currentArray = null;

    for (const line of yamlText.split('\n')) {
        const trimmed = line.trimEnd();

        if (/^\s+-\s+/.test(trimmed) && currentKey) {
            const value = trimmed.replace(/^\s+-\s+/, '').trim();
            if (!currentArray) {
                currentArray = [];
                frontmatter[currentKey] = currentArray;
            }
            currentArray.push(value);
            continue;
        }

        const kvMatch = trimmed.match(/^(\w[\w-]*)\s*:\s*(.*)/);
        if (kvMatch) {
            currentKey = kvMatch[1];
            const rawValue = kvMatch[2].trim();
            currentArray = null;

            if (rawValue === '' || rawValue === '[]') {
                frontmatter[currentKey] = [];
                currentArray = frontmatter[currentKey];
            } else if (rawValue === 'true') {
                frontmatter[currentKey] = true;
            } else if (rawValue === 'false') {
                frontmatter[currentKey] = false;
            } else if (/^\d+$/.test(rawValue)) {
                frontmatter[currentKey] = parseInt(rawValue, 10);
            } else {
                frontmatter[currentKey] = rawValue.replace(/^['"]|['"]$/g, '');
            }
        }
    }

    return { frontmatter, body };
}

function cleanContent(content) {
    let cleaned = content;
    cleaned = cleaned.replace(/!\[\[.*?\]\]/g, '');
    cleaned = cleaned.replace(/!\[.*?\]\(.*?\)/g, '');
    cleaned = cleaned.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
    cleaned = cleaned.replace(/\[\[([^\]]+)\]\]/g, '$1');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    return cleaned.trim();
}

function extractTitle(body, filename) {
    const h1Match = body.match(/^#\s+(.+)$/m);
    if (h1Match) {
        return h1Match[1].trim();
    }
    const parts = filename.split('/');
    const name = parts[parts.length - 1];
    return name.replace(/\.md$/, '');
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function testEntryMatch(entry, scanText, settings) {
    if (entry.keys.length === 0) return null;
    const haystack = settings.caseSensitive ? scanText : scanText.toLowerCase();
    for (const rawKey of entry.keys) {
        const key = settings.caseSensitive ? rawKey : rawKey.toLowerCase();
        if (settings.matchWholeWords) {
            const regex = new RegExp(`\\b${escapeRegex(key)}\\b`, settings.caseSensitive ? '' : 'i');
            if (regex.test(scanText)) return rawKey;
        } else {
            if (haystack.includes(key)) return rawKey;
        }
    }
    return null;
}

function truncateToSentence(text, maxLen) {
    if (text.length <= maxLen) return text;
    const truncated = text.substring(0, maxLen);
    const lastSentence = truncated.search(/[.!?][^.!?]*$/);
    if (lastSentence > maxLen * 0.4) {
        return truncated.substring(0, lastSentence + 1);
    }
    return truncated.trimEnd() + '...';
}

function simpleHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return `${text.length}:${hash}`;
}

const settingsConstraints = {
    obsidianPort: { min: 1, max: 65535 },
    scanDepth: { min: 0, max: 100 },
    maxEntries: { min: 1, max: 100 },
    maxTokensBudget: { min: 100, max: 100000 },
    injectionDepth: { min: 0, max: 9999 },
    maxRecursionSteps: { min: 1, max: 10 },
    cacheTTL: { min: 0, max: 86400 },
    reviewResponseTokens: { min: 0, max: 100000 },
    aiSearchMaxTokens: { min: 64, max: 4096 },
    aiSearchTimeout: { min: 1000, max: 30000 },
    aiSearchPriorityOffset: { min: 0, max: 1000 },
    aiSearchScanDepth: { min: 1, max: 100 },
    aiSearchManifestSummaryLength: { min: 100, max: 800 },
    scribeInterval: { min: 1, max: 50 },
};

function validateSettings(settings) {
    for (const [key, { min, max }] of Object.entries(settingsConstraints)) {
        if (typeof settings[key] === 'number') {
            settings[key] = Math.max(min, Math.min(max, Math.round(settings[key])));
        }
    }
    if (typeof settings.lorebookTag === 'string') {
        settings.lorebookTag = settings.lorebookTag.trim() || 'lorebook';
    }
}

// ============================================================================
// Test runner
// ============================================================================

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
    }
}

function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    expected: ${JSON.stringify(expected)}`);
        console.error(`    actual:   ${JSON.stringify(actual)}`);
    }
}

function test(name, fn) {
    console.log(`\n${name}`);
    fn();
}

// ============================================================================
// Tests
// ============================================================================

test('parseFrontmatter: basic key-value pairs', () => {
    const input = '---\ntitle: Test Note\npriority: 10\nenabled: true\n---\n# Body';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.title, 'Test Note', 'should parse string value');
    assertEqual(result.frontmatter.priority, 10, 'should parse number value');
    assertEqual(result.frontmatter.enabled, true, 'should parse boolean true');
    assertEqual(result.body, '# Body', 'should extract body');
});

test('parseFrontmatter: arrays', () => {
    const input = '---\ntags:\n  - lorebook\n  - character\nkeys:\n  - Eris\n  - goddess\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.tags, ['lorebook', 'character'], 'should parse tags array');
    assertEqual(result.frontmatter.keys, ['Eris', 'goddess'], 'should parse keys array');
});

test('parseFrontmatter: empty arrays', () => {
    const input = '---\nkeys: []\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.keys, [], 'should parse empty array');
});

test('parseFrontmatter: boolean false', () => {
    const input = '---\nenabled: false\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.enabled, false, 'should parse boolean false');
});

test('parseFrontmatter: quoted strings', () => {
    const input = '---\ntitle: "Hello World"\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.title, 'Hello World', 'should strip quotes');
});

test('parseFrontmatter: no frontmatter', () => {
    const input = '# Just a heading\nSome content';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter, {}, 'should return empty frontmatter');
    assertEqual(result.body, input, 'should return full content as body');
});

test('cleanContent: strips image embeds', () => {
    assertEqual(cleanContent('Before ![[image.png]] after'), 'Before  after', 'should strip wiki image embeds');
    assertEqual(cleanContent('Before ![alt](http://img.png) after'), 'Before  after', 'should strip markdown image embeds');
});

test('cleanContent: converts wiki links', () => {
    assertEqual(cleanContent('See [[Target Page]]'), 'See Target Page', 'should convert simple wiki links');
    assertEqual(cleanContent('See [[Target|Display Text]]'), 'See Display Text', 'should convert aliased wiki links');
});

test('cleanContent: collapses blank lines', () => {
    assertEqual(cleanContent('Line 1\n\n\n\n\nLine 2'), 'Line 1\n\nLine 2', 'should collapse 5 newlines to 2');
});

test('extractTitle: from H1', () => {
    assertEqual(extractTitle('# My Title\nContent', 'test.md'), 'My Title', 'should extract H1');
});

test('extractTitle: from filename', () => {
    assertEqual(extractTitle('No heading here', 'folder/My Note.md'), 'My Note', 'should fall back to filename');
});

test('testEntryMatch: case insensitive substring', () => {
    const entry = { keys: ['Eris'] };
    const settings = { caseSensitive: false, matchWholeWords: false };
    assertEqual(testEntryMatch(entry, 'I met eris today', settings), 'Eris', 'should match case-insensitively');
    assertEqual(testEntryMatch(entry, 'No match here', settings), null, 'should return null for no match');
});

test('testEntryMatch: case sensitive', () => {
    const entry = { keys: ['Eris'] };
    const settings = { caseSensitive: true, matchWholeWords: false };
    assertEqual(testEntryMatch(entry, 'I met eris today', settings), null, 'should not match wrong case');
    assertEqual(testEntryMatch(entry, 'I met Eris today', settings), 'Eris', 'should match exact case');
});

test('testEntryMatch: whole words', () => {
    const entry = { keys: ['war'] };
    const settings = { caseSensitive: false, matchWholeWords: true };
    assertEqual(testEntryMatch(entry, 'The warning was clear', settings), null, 'should not match partial word');
    assertEqual(testEntryMatch(entry, 'The war began', settings), 'war', 'should match whole word');
});

test('testEntryMatch: empty keys', () => {
    const entry = { keys: [] };
    const settings = { caseSensitive: false, matchWholeWords: false };
    assertEqual(testEntryMatch(entry, 'any text', settings), null, 'should return null for empty keys');
});

test('testEntryMatch: regex special chars in key', () => {
    const entry = { keys: ['C++ programming'] };
    const settings = { caseSensitive: false, matchWholeWords: false };
    assertEqual(testEntryMatch(entry, 'I love c++ programming', settings), 'C++ programming', 'should handle regex special chars');
});

test('truncateToSentence: short text unchanged', () => {
    assertEqual(truncateToSentence('Hello world.', 200), 'Hello world.', 'should not truncate short text');
});

test('truncateToSentence: cuts at sentence boundary', () => {
    const text = 'First sentence. Second sentence. Third sentence that is very long and keeps going on.';
    const result = truncateToSentence(text, 40);
    assertEqual(result, 'First sentence. Second sentence.', 'should cut at last sentence boundary');
});

test('truncateToSentence: falls back to ellipsis', () => {
    const text = 'This is a single very long sentence without any periods that just keeps going on and on and on and on';
    const result = truncateToSentence(text, 30);
    assertEqual(result, 'This is a single very long sen...', 'should add ellipsis when no sentence boundary');
});

test('truncateToSentence: respects exclamation marks', () => {
    const text = 'Watch out! This is dangerous. And more text that is very long and keeps going.';
    const result = truncateToSentence(text, 35);
    assertEqual(result, 'Watch out! This is dangerous.', 'should cut at exclamation/period');
});

test('simpleHash: deterministic', () => {
    const hash1 = simpleHash('test string');
    const hash2 = simpleHash('test string');
    assertEqual(hash1, hash2, 'same input should produce same hash');
});

test('simpleHash: different for different inputs', () => {
    const hash1 = simpleHash('hello');
    const hash2 = simpleHash('world');
    assert(hash1 !== hash2, 'different inputs should produce different hashes');
});

test('validateSettings: clamps values', () => {
    const settings = { obsidianPort: 99999, scanDepth: -5, cacheTTL: 100000 };
    validateSettings(settings);
    assertEqual(settings.obsidianPort, 65535, 'should clamp port to max');
    assertEqual(settings.scanDepth, 0, 'should clamp scanDepth to min');
    assertEqual(settings.cacheTTL, 86400, 'should clamp cacheTTL to max');
});

test('validateSettings: clamps AI settings', () => {
    const settings = { aiSearchMaxTokens: 10000, aiSearchTimeout: 500, aiSearchPriorityOffset: 5000 };
    validateSettings(settings);
    assertEqual(settings.aiSearchMaxTokens, 4096, 'should clamp AI max tokens');
    assertEqual(settings.aiSearchTimeout, 1000, 'should clamp AI timeout to min');
    assertEqual(settings.aiSearchPriorityOffset, 1000, 'should clamp AI priority offset');
});

test('validateSettings: rounds floats', () => {
    const settings = { scanDepth: 4.7 };
    validateSettings(settings);
    assertEqual(settings.scanDepth, 5, 'should round float to integer');
});

test('validateSettings: trims lorebook tag', () => {
    const settings = { lorebookTag: '  custom-tag  ' };
    validateSettings(settings);
    assertEqual(settings.lorebookTag, 'custom-tag', 'should trim whitespace');
});

test('validateSettings: defaults empty lorebook tag', () => {
    const settings = { lorebookTag: '   ' };
    validateSettings(settings);
    assertEqual(settings.lorebookTag, 'lorebook', 'should default empty tag to lorebook');
});

// ============================================================================
// buildObsidianURI (from index.js)
// ============================================================================

function buildObsidianURI(vaultName, filename) {
    if (!vaultName) return null;
    const encodedVault = encodeURIComponent(vaultName);
    const encodedFile = filename.split('/').map(s => encodeURIComponent(s)).join('/');
    return `obsidian://open?vault=${encodedVault}&file=${encodedFile}`;
}

test('buildObsidianURI: basic path', () => {
    const uri = buildObsidianURI('My Vault', 'Characters/Alice.md');
    assertEqual(uri, 'obsidian://open?vault=My%20Vault&file=Characters/Alice.md', 'should build URI with encoded vault and path segments');
});

test('buildObsidianURI: spaces in path', () => {
    const uri = buildObsidianURI('TestVault', 'LA World/Main Characters/The Hero.md');
    assertEqual(uri, 'obsidian://open?vault=TestVault&file=LA%20World/Main%20Characters/The%20Hero.md', 'should encode spaces in each segment');
});

test('buildObsidianURI: no vault name returns null', () => {
    assertEqual(buildObsidianURI('', 'test.md'), null, 'should return null for empty vault name');
    assertEqual(buildObsidianURI(null, 'test.md'), null, 'should return null for null vault name');
});

test('buildObsidianURI: special characters', () => {
    const uri = buildObsidianURI('Vault & Notes', 'Lore/Items/Ring (of Power).md');
    assertEqual(uri, 'obsidian://open?vault=Vault%20%26%20Notes&file=Lore/Items/Ring%20(of%20Power).md', 'should encode ampersands and parentheses');
});

test('buildObsidianURI: root-level file', () => {
    const uri = buildObsidianURI('MyVault', 'README.md');
    assertEqual(uri, 'obsidian://open?vault=MyVault&file=README.md', 'should handle root-level files');
});

test('validateSettings: clamps scribe interval', () => {
    const settings = { scribeInterval: 100 };
    validateSettings(settings);
    assertEqual(settings.scribeInterval, 50, 'should clamp scribe interval to max');
});

test('validateSettings: clamps manifest summary length', () => {
    const settings = { aiSearchManifestSummaryLength: 1000 };
    validateSettings(settings);
    assertEqual(settings.aiSearchManifestSummaryLength, 800, 'should clamp summary length to max');
});

// ============================================================================
// extractWikiLinks (from index.js)
// ============================================================================

function extractWikiLinks(body) {
    const links = new Set();
    const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = regex.exec(body)) !== null) {
        if (match.index > 0 && body[match.index - 1] === '!') continue;
        links.add(match[1].trim());
    }
    return [...links];
}

test('extractWikiLinks: basic links', () => {
    const links = extractWikiLinks('See [[Eris]] and [[Dark Council]].');
    assertEqual(links.length, 2, 'should find two links');
    assert(links.includes('Eris'), 'should include Eris');
    assert(links.includes('Dark Council'), 'should include Dark Council');
});

test('extractWikiLinks: aliased links', () => {
    const links = extractWikiLinks('She joined [[Dark Council|the council]] recently.');
    assertEqual(links.length, 1, 'should find one link');
    assertEqual(links[0], 'Dark Council', 'should extract target, not display text');
});

test('extractWikiLinks: ignores image embeds', () => {
    const links = extractWikiLinks('![[portrait.png]] and [[Eris]] and ![[map.jpg]]');
    assertEqual(links.length, 1, 'should skip image embeds');
    assertEqual(links[0], 'Eris', 'should only include non-image link');
});

test('extractWikiLinks: deduplicates', () => {
    const links = extractWikiLinks('[[Eris]] met [[Eris]] at the [[Temple]].');
    assertEqual(links.length, 2, 'should deduplicate Eris');
    assert(links.includes('Eris'), 'should include Eris once');
    assert(links.includes('Temple'), 'should include Temple');
});

test('extractWikiLinks: empty body', () => {
    assertEqual(extractWikiLinks('No links here.').length, 0, 'should return empty for no links');
    assertEqual(extractWikiLinks('').length, 0, 'should handle empty string');
});

test('extractWikiLinks: trims whitespace in link targets', () => {
    const links = extractWikiLinks('See [[ Eris ]] here.');
    assertEqual(links[0], 'Eris', 'should trim whitespace from link target');
});

// ============================================================================
// normalizeResults (from server/index.js)
// ============================================================================

function normalizeResults(arr) {
    return arr.map(item => {
        if (typeof item === 'string') {
            return { title: item, confidence: 'medium', reason: 'AI search' };
        }
        if (typeof item === 'object' && item !== null && typeof item.title === 'string') {
            return {
                title: item.title,
                confidence: ['high', 'medium', 'low'].includes(item.confidence) ? item.confidence : 'medium',
                reason: typeof item.reason === 'string' ? item.reason : 'AI search',
            };
        }
        return { title: String(item), confidence: 'medium', reason: 'AI search' };
    });
}

test('normalizeResults: legacy flat array', () => {
    const results = normalizeResults(['Eris', 'Dark Council']);
    assertEqual(results.length, 2, 'should handle two items');
    assertEqual(results[0].title, 'Eris', 'should preserve title');
    assertEqual(results[0].confidence, 'medium', 'should default to medium');
    assertEqual(results[0].reason, 'AI search', 'should default reason');
});

test('normalizeResults: structured format', () => {
    const results = normalizeResults([
        { title: 'Eris', confidence: 'high', reason: 'directly mentioned' },
        { title: 'Temple', confidence: 'low', reason: 'thematic match' },
    ]);
    assertEqual(results[0].confidence, 'high', 'should preserve high confidence');
    assertEqual(results[0].reason, 'directly mentioned', 'should preserve reason');
    assertEqual(results[1].confidence, 'low', 'should preserve low confidence');
});

test('normalizeResults: mixed/malformed objects', () => {
    const results = normalizeResults([
        { title: 'Eris' },
        { title: 'Temple', confidence: 'invalid', reason: 42 },
        'Plain Title',
    ]);
    assertEqual(results[0].confidence, 'medium', 'should default missing confidence');
    assertEqual(results[0].reason, 'AI search', 'should default missing reason');
    assertEqual(results[1].confidence, 'medium', 'should default invalid confidence');
    assertEqual(results[1].reason, 'AI search', 'should default non-string reason');
    assertEqual(results[2].title, 'Plain Title', 'should handle string items');
});

test('normalizeResults: empty array', () => {
    assertEqual(normalizeResults([]).length, 0, 'should handle empty array');
});

// ============================================================================
// buildAiChatContext (from index.js)
// ============================================================================

function buildScanText(chat, depth) {
    if (depth <= 0) return '';
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages
        .map(m => `${m.name || ''}: ${m.mes || ''}`)
        .join('\n');
}

function buildAiChatContext(chat, depth) {
    if (depth <= 0) return '';
    const recentMessages = chat.slice(-Math.min(depth, chat.length));
    return recentMessages
        .map(m => {
            const speaker = m.name || 'Unknown';
            const role = m.is_user ? '(user)' : '(character)';
            return `${speaker} ${role}: ${m.mes || ''}`;
        })
        .join('\n');
}

test('buildAiChatContext: annotates roles', () => {
    const chat = [
        { name: 'Alice', is_user: true, mes: 'Hello' },
        { name: 'Bob', is_user: false, mes: 'Hi there' },
    ];
    const result = buildAiChatContext(chat, 10);
    assert(result.includes('Alice (user): Hello'), 'should mark Alice as user');
    assert(result.includes('Bob (character): Hi there'), 'should mark Bob as character');
});

test('buildAiChatContext: respects depth', () => {
    const chat = [
        { name: 'A', is_user: true, mes: 'msg1' },
        { name: 'B', is_user: false, mes: 'msg2' },
        { name: 'C', is_user: true, mes: 'msg3' },
    ];
    const result = buildAiChatContext(chat, 2);
    assert(!result.includes('msg1'), 'should exclude messages beyond depth');
    assert(result.includes('msg2'), 'should include recent messages');
    assert(result.includes('msg3'), 'should include most recent message');
});

test('buildAiChatContext: handles missing name', () => {
    const chat = [{ is_user: false, mes: 'Hello' }];
    const result = buildAiChatContext(chat, 10);
    assert(result.includes('Unknown (character)'), 'should use Unknown for missing name');
});

// ============================================================================
// buildScanText / buildAiChatContext depth-0 (AI-only mode)
// ============================================================================

test('buildScanText: depth 0 returns empty string', () => {
    const chat = [
        { name: 'Alice', mes: 'Hello world' },
        { name: 'Bob', mes: 'Greetings' },
    ];
    assertEqual(buildScanText(chat, 0), '', 'should return empty string for depth 0');
});

test('buildScanText: depth 1 returns last message', () => {
    const chat = [
        { name: 'Alice', mes: 'First' },
        { name: 'Bob', mes: 'Second' },
    ];
    const result = buildScanText(chat, 1);
    assert(!result.includes('First'), 'should exclude first message');
    assert(result.includes('Second'), 'should include last message');
});

test('buildAiChatContext: depth 0 returns empty string', () => {
    const chat = [
        { name: 'Alice', is_user: true, mes: 'Hello' },
    ];
    assertEqual(buildAiChatContext(chat, 0), '', 'should return empty string for depth 0');
});

// ============================================================================
// applyGating (Feature 5: Conditional Gating)
// ============================================================================

function applyGating(entries) {
    let result = [...entries];
    let changed = true;
    let iterations = 0;
    const MAX_ITERATIONS = 10;

    while (changed && iterations < MAX_ITERATIONS) {
        changed = false;
        iterations++;
        const activeTitles = new Set(result.map(e => e.title.toLowerCase()));

        result = result.filter(entry => {
            if (entry.requires.length > 0) {
                const allPresent = entry.requires.every(r => activeTitles.has(r.toLowerCase()));
                if (!allPresent) {
                    changed = true;
                    return false;
                }
            }
            if (entry.excludes.length > 0) {
                const anyPresent = entry.excludes.some(r => activeTitles.has(r.toLowerCase()));
                if (anyPresent) {
                    changed = true;
                    return false;
                }
            }
            return true;
        });
    }

    return result;
}

function makeEntry(title, opts = {}) {
    return {
        title,
        requires: opts.requires || [],
        excludes: opts.excludes || [],
        constant: opts.constant || false,
        keys: opts.keys || [],
        content: opts.content || '',
        priority: opts.priority || 100,
        tokenEstimate: opts.tokenEstimate || 50,
        injectionPosition: opts.injectionPosition ?? null,
        injectionDepth: opts.injectionDepth ?? null,
        injectionRole: opts.injectionRole ?? null,
    };
}

test('applyGating: all requires present passes', () => {
    const entries = [
        makeEntry('Eris'),
        makeEntry('Dark Council'),
        makeEntry('Secret', { requires: ['Eris', 'Dark Council'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 3, 'all three should pass');
});

test('applyGating: missing requires removes entry', () => {
    const entries = [
        makeEntry('Eris'),
        makeEntry('Secret', { requires: ['Eris', 'Dark Council'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 1, 'Secret should be removed (Dark Council missing)');
    assertEqual(result[0].title, 'Eris', 'Eris should remain');
});

test('applyGating: excludes blocks entry', () => {
    const entries = [
        makeEntry('Eris'),
        makeEntry('Draft Notes'),
        makeEntry('Secret', { excludes: ['Draft Notes'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 2, 'Secret should be excluded');
    assert(!result.find(e => e.title === 'Secret'), 'Secret should not be in results');
});

test('applyGating: cascading removal', () => {
    // A requires B, B requires C. Only A and B present -> B removed -> A removed
    const entries = [
        makeEntry('A', { requires: ['B'] }),
        makeEntry('B', { requires: ['C'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 0, 'both should be removed by cascading');
});

test('applyGating: empty requires/excludes passes', () => {
    const entries = [
        makeEntry('Eris'),
        makeEntry('Plain Entry'),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 2, 'entries without gating rules should pass');
});

test('applyGating: case insensitive title matching', () => {
    const entries = [
        makeEntry('Eris'),
        makeEntry('Secret', { requires: ['eris'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 2, 'should match case-insensitively');
});

test('applyGating: constants still subject to gating', () => {
    const entries = [
        makeEntry('Draft Notes'),
        makeEntry('Always Entry', { constant: true, excludes: ['Draft Notes'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 1, 'constant entry should still be gated');
    assertEqual(result[0].title, 'Draft Notes', 'Draft Notes should remain');
});

// ============================================================================
// formatAndGroup (Feature 6: Per-Entry Injection Position)
// ============================================================================

const PROMPT_TAG_PREFIX_TEST = 'deeplore_';

function formatAndGroupTest(entries, settings) {
    const template = settings.injectionTemplate || '<{{title}}>\n{{content}}\n</{{title}}>';
    let totalTokens = 0;
    let count = 0;
    const accepted = [];

    for (const entry of entries) {
        if (!settings.unlimitedEntries && count >= settings.maxEntries) break;
        if (!settings.unlimitedBudget && totalTokens + entry.tokenEstimate > settings.maxTokensBudget && count > 0) break;

        accepted.push({
            entry,
            position: entry.injectionPosition ?? settings.injectionPosition,
            depth: entry.injectionDepth ?? settings.injectionDepth,
            role: entry.injectionRole ?? settings.injectionRole,
        });
        totalTokens += entry.tokenEstimate;
        count++;
    }

    const groupMap = new Map();
    for (const item of accepted) {
        const key = `${PROMPT_TAG_PREFIX_TEST}p${item.position}_d${item.depth}_r${item.role}`;
        if (!groupMap.has(key)) {
            groupMap.set(key, { tag: key, position: item.position, depth: item.depth, role: item.role, texts: [] });
        }
        const text = template
            .replace(/\{\{title\}\}/g, item.entry.title)
            .replace(/\{\{content\}\}/g, item.entry.content);
        groupMap.get(key).texts.push(text);
    }

    const groups = [...groupMap.values()].map(g => ({
        tag: g.tag, text: g.texts.join('\n\n'), position: g.position, depth: g.depth, role: g.role,
    }));

    return { groups, count, totalTokens };
}

const defaultTestSettings = {
    injectionPosition: 1,
    injectionDepth: 4,
    injectionRole: 0,
    injectionTemplate: '<{{title}}>\n{{content}}\n</{{title}}>',
    unlimitedEntries: true,
    unlimitedBudget: true,
    maxEntries: 10,
    maxTokensBudget: 2048,
};

test('formatAndGroup: single group when no overrides', () => {
    const entries = [
        makeEntry('Eris', { content: 'A goddess' }),
        makeEntry('Temple', { content: 'A sacred place' }),
    ];
    const result = formatAndGroupTest(entries, defaultTestSettings);
    assertEqual(result.groups.length, 1, 'should produce one group');
    assertEqual(result.groups[0].tag, 'deeplore_p1_d4_r0', 'should use global settings in tag');
    assertEqual(result.count, 2, 'should count 2 entries');
});

test('formatAndGroup: multiple groups with different positions', () => {
    const entries = [
        makeEntry('World Lore', { content: 'Background', injectionPosition: 2 }),
        makeEntry('Eris', { content: 'A goddess' }),
        makeEntry('Dialogue Hint', { content: 'Speak softly', injectionPosition: 1, injectionDepth: 0, injectionRole: 1 }),
    ];
    const result = formatAndGroupTest(entries, defaultTestSettings);
    assertEqual(result.groups.length, 3, 'should produce three groups');
    assert(result.groups.some(g => g.tag === 'deeplore_p2_d4_r0'), 'should have before_prompt group');
    assert(result.groups.some(g => g.tag === 'deeplore_p1_d4_r0'), 'should have default in_chat group');
    assert(result.groups.some(g => g.tag === 'deeplore_p1_d0_r1'), 'should have custom in_chat group');
});

test('formatAndGroup: budget applied globally across groups', () => {
    const entries = [
        makeEntry('A', { content: 'Content A', tokenEstimate: 500, injectionPosition: 2 }),
        makeEntry('B', { content: 'Content B', tokenEstimate: 500 }),
        makeEntry('C', { content: 'Content C', tokenEstimate: 500 }),
    ];
    const settings = { ...defaultTestSettings, unlimitedBudget: false, maxTokensBudget: 1200 };
    const result = formatAndGroupTest(entries, settings);
    assertEqual(result.count, 2, 'should only accept 2 entries within budget');
    assertEqual(result.totalTokens, 1000, 'total should be 1000');
});

test('formatAndGroup: per-entry depth override', () => {
    const entries = [
        makeEntry('Near', { content: 'Close to action', injectionDepth: 1 }),
        makeEntry('Far', { content: 'Background info', injectionDepth: 8 }),
    ];
    const result = formatAndGroupTest(entries, defaultTestSettings);
    assertEqual(result.groups.length, 2, 'should produce two groups at different depths');
    assert(result.groups.some(g => g.depth === 1), 'should have depth 1 group');
    assert(result.groups.some(g => g.depth === 8), 'should have depth 8 group');
});

test('formatAndGroup: fallback to global settings', () => {
    const entries = [makeEntry('Test', { content: 'Body' })];
    const result = formatAndGroupTest(entries, defaultTestSettings);
    assertEqual(result.groups[0].position, 1, 'should use global position');
    assertEqual(result.groups[0].depth, 4, 'should use global depth');
    assertEqual(result.groups[0].role, 0, 'should use global role');
});

// ============================================================================
// detectChanges (Feature 10: Vault Change Detection)
// ============================================================================

function detectChanges(oldSnapshot, newSnapshot) {
    const changes = { added: [], removed: [], modified: [], keysChanged: [], hasChanges: false };
    if (!oldSnapshot) return changes;

    const oldFiles = new Set(oldSnapshot.contentHashes.keys());
    const newFiles = new Set(newSnapshot.contentHashes.keys());

    for (const file of newFiles) {
        if (!oldFiles.has(file)) {
            changes.added.push(newSnapshot.titleMap.get(file) || file);
        }
    }
    for (const file of oldFiles) {
        if (!newFiles.has(file)) {
            changes.removed.push(oldSnapshot.titleMap.get(file) || file);
        }
    }
    for (const file of newFiles) {
        if (oldFiles.has(file)) {
            if (oldSnapshot.contentHashes.get(file) !== newSnapshot.contentHashes.get(file)) {
                changes.modified.push(newSnapshot.titleMap.get(file) || file);
            }
            if (oldSnapshot.keyMap.get(file) !== newSnapshot.keyMap.get(file)) {
                const title = newSnapshot.titleMap.get(file) || file;
                if (!changes.modified.includes(title)) {
                    changes.keysChanged.push(title);
                }
            }
        }
    }

    changes.hasChanges = changes.added.length > 0 || changes.removed.length > 0
        || changes.modified.length > 0 || changes.keysChanged.length > 0;
    return changes;
}

function makeSnapshot(entries) {
    const snapshot = {
        contentHashes: new Map(),
        titleMap: new Map(),
        keyMap: new Map(),
        timestamp: Date.now(),
    };
    for (const e of entries) {
        snapshot.contentHashes.set(e.filename, simpleHash(e.content));
        snapshot.titleMap.set(e.filename, e.title);
        snapshot.keyMap.set(e.filename, JSON.stringify(e.keys || []));
    }
    return snapshot;
}

test('detectChanges: no previous snapshot returns empty', () => {
    const newSnap = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello', keys: [] }]);
    const changes = detectChanges(null, newSnap);
    assertEqual(changes.hasChanges, false, 'should report no changes');
});

test('detectChanges: detects new entries', () => {
    const old = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello', keys: [] }]);
    const now = makeSnapshot([
        { filename: 'a.md', title: 'A', content: 'hello', keys: [] },
        { filename: 'b.md', title: 'B', content: 'world', keys: [] },
    ]);
    const changes = detectChanges(old, now);
    assertEqual(changes.added, ['B'], 'should detect B as new');
    assertEqual(changes.hasChanges, true, 'should report changes');
});

test('detectChanges: detects removed entries', () => {
    const old = makeSnapshot([
        { filename: 'a.md', title: 'A', content: 'hello', keys: [] },
        { filename: 'b.md', title: 'B', content: 'world', keys: [] },
    ]);
    const now = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello', keys: [] }]);
    const changes = detectChanges(old, now);
    assertEqual(changes.removed, ['B'], 'should detect B as removed');
});

test('detectChanges: detects modified content', () => {
    const old = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello', keys: [] }]);
    const now = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello changed', keys: [] }]);
    const changes = detectChanges(old, now);
    assertEqual(changes.modified, ['A'], 'should detect A as modified');
});

test('detectChanges: detects keyword changes', () => {
    const old = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'same', keys: ['foo'] }]);
    const now = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'same', keys: ['foo', 'bar'] }]);
    const changes = detectChanges(old, now);
    assertEqual(changes.keysChanged, ['A'], 'should detect keyword change');
    assertEqual(changes.modified.length, 0, 'should not appear in modified (content unchanged)');
});

test('detectChanges: no changes returns hasChanges false', () => {
    const old = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello', keys: ['x'] }]);
    const now = makeSnapshot([{ filename: 'a.md', title: 'A', content: 'hello', keys: ['x'] }]);
    const changes = detectChanges(old, now);
    assertEqual(changes.hasChanges, false, 'should report no changes');
});

// ============================================================================
// Frontmatter parsing for new fields
// ============================================================================

test('parseFrontmatter: requires and excludes arrays', () => {
    const input = '---\nrequires:\n  - Eris\n  - Dark Council\nexcludes:\n  - Draft\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.requires, ['Eris', 'Dark Council'], 'should parse requires array');
    assertEqual(result.frontmatter.excludes, ['Draft'], 'should parse excludes array');
});

test('parseFrontmatter: position, depth, role fields', () => {
    const input = '---\nposition: before\ndepth: 2\nrole: user\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.position, 'before', 'should parse position string');
    assertEqual(result.frontmatter.depth, 2, 'should parse depth number');
    assertEqual(result.frontmatter.role, 'user', 'should parse role string');
});

// ============================================================================
// Results
// ============================================================================

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
