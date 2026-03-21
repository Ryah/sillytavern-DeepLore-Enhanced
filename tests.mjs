/**
 * DeepLore Enhanced unit tests
 * Run with: node tests.mjs
 *
 * Tests shared core functions (imported from core/) and Enhanced-specific functions.
 */

import {
    parseFrontmatter, extractWikiLinks, cleanContent, extractTitle,
    truncateToSentence, simpleHash, escapeRegex,
    buildScanText, buildAiChatContext, validateSettings,
} from './core/utils.js';
import { testEntryMatch, countKeywordOccurrences, applyGating, resolveLinks, formatAndGroup } from './core/matching.js';
import { parseVaultFile, clearPrompts } from './core/pipeline.js';
import { takeIndexSnapshot, detectChanges } from './core/sync.js';

// ============================================================================
// Enhanced-only functions (not in core, tested inline)
// ============================================================================

function buildObsidianURI(vaultName, filename) {
    if (!vaultName) return null;
    const encodedVault = encodeURIComponent(vaultName);
    const encodedFile = filename.split('/').map(s => encodeURIComponent(s)).join('/');
    return `obsidian://open?vault=${encodedVault}&file=${encodedFile}`;
}

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

// Settings constraints (Enhanced version with AI/scribe fields)
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
    aiSearchScanDepth: { min: 1, max: 100 },
    aiSearchManifestSummaryLength: { min: 100, max: 1000 },
    scribeInterval: { min: 1, max: 50 },
    syncPollingInterval: { min: 0, max: 3600 },
    reinjectionCooldown: { min: 0, max: 50 },
    newChatThreshold: { min: 1, max: 20 },
};

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
// Helper
// ============================================================================

function makeEntry(title, opts = {}) {
    return {
        title,
        requires: opts.requires || [],
        excludes: opts.excludes || [],
        constant: opts.constant || false,
        seed: opts.seed || false,
        bootstrap: opts.bootstrap || false,
        keys: opts.keys || [],
        content: opts.content || '',
        summary: opts.summary || '',
        priority: opts.priority || 100,
        tokenEstimate: opts.tokenEstimate || 50,
        scanDepth: opts.scanDepth ?? null,
        excludeRecursion: opts.excludeRecursion || false,
        links: opts.links || [],
        resolvedLinks: opts.resolvedLinks || [],
        tags: opts.tags || [],
        injectionPosition: opts.injectionPosition ?? null,
        injectionDepth: opts.injectionDepth ?? null,
        injectionRole: opts.injectionRole ?? null,
        cooldown: opts.cooldown ?? null,
        warmup: opts.warmup ?? null,
        probability: opts.probability ?? null,
        cascadeLinks: opts.cascadeLinks || [],
        refineKeys: opts.refineKeys || [],
        vaultSource: opts.vaultSource || '',
        filename: opts.filename || `${title}.md`,
        era: opts.era || null,
        location: opts.location || null,
        sceneType: opts.sceneType || null,
        characterPresent: opts.characterPresent || null,
    };
}

// ============================================================================
// Tests: parseFrontmatter
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

test('parseFrontmatter: inline arrays', () => {
    const input = '---\nkeys: [Wren, wren, The Bird]\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.keys, ['Wren', 'wren', 'The Bird'], 'should parse inline array');
});

test('parseFrontmatter: inline arrays with quotes', () => {
    const input = '---\nkeys: ["Wren Smith", \'The Bird\']\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.keys, ['Wren Smith', 'The Bird'], 'should strip quotes from inline array items');
});

test('parseFrontmatter: inline array with spaces', () => {
    const input = '---\ntags: [ lorebook , character ]\n---\nContent';
    const result = parseFrontmatter(input);
    assertEqual(result.frontmatter.tags, ['lorebook', 'character'], 'should trim whitespace in inline array items');
});

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
// Tests: cleanContent
// ============================================================================

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

test('cleanContent: strips deeplore-exclude regions', () => {
    assertEqual(
        cleanContent('Before\n%%deeplore-exclude%%\nHidden stuff\n%%/deeplore-exclude%%\nAfter'),
        'Before\n\nAfter',
        'should strip deeplore-exclude region and contents',
    );
    assertEqual(
        cleanContent('Start %%deeplore-exclude%%secret%%/deeplore-exclude%% end'),
        'Start  end',
        'should strip inline deeplore-exclude',
    );
});

test('cleanContent: strips Obsidian %% comment blocks', () => {
    assertEqual(cleanContent('Before %%inline comment%% after'), 'Before  after',
        'should strip inline %% blocks');
    assertEqual(
        cleanContent('Before\n%%aat-inline-event\nstart-date: 2025\ntimelines: [test]\n%%\nAfter'),
        'Before\n\nAfter',
        'should strip multiline %% blocks',
    );
    assertEqual(cleanContent('%%aat-event-end-of-body%%'), '',
        'should strip standalone %% markers');
});

test('cleanContent: strips HTML div tags', () => {
    assertEqual(
        cleanContent('<div class="meta-block">[Species: vampire]</div>'),
        '[Species: vampire]',
        'should strip div tags but keep content',
    );
    assertEqual(cleanContent('Text <div>inner</div> more'), 'Text inner more',
        'should strip plain div tags');
});

test('cleanContent: strips H1 heading', () => {
    assertEqual(cleanContent('# Eris\nContent here'), 'Content here',
        'should strip H1 heading');
    assertEqual(cleanContent('## Subheading\nContent'), '## Subheading\nContent',
        'should NOT strip H2 headings');
});

// ============================================================================
// Tests: extractTitle
// ============================================================================

test('extractTitle: from H1', () => {
    assertEqual(extractTitle('# My Title\nContent', 'test.md'), 'My Title', 'should extract H1');
});

test('extractTitle: from filename', () => {
    assertEqual(extractTitle('No heading here', 'folder/My Note.md'), 'My Note', 'should fall back to filename');
});

// ============================================================================
// Tests: extractWikiLinks
// ============================================================================

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

test('extractWikiLinks: strips trailing backslash from pipe-alias links', () => {
    const links = extractWikiLinks('See [[Name\\|Display]] here.');
    assertEqual(links.length, 1, 'should find one link');
    assertEqual(links[0], 'Name', 'should strip trailing backslash from link target');
});

// ============================================================================
// Tests: testEntryMatch
// ============================================================================

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

// ============================================================================
// Tests: truncateToSentence
// ============================================================================

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

// ============================================================================
// Tests: simpleHash
// ============================================================================

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

// ============================================================================
// Tests: validateSettings
// ============================================================================

test('validateSettings: clamps values', () => {
    const settings = { obsidianPort: 99999, scanDepth: -5, cacheTTL: 100000 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.obsidianPort, 65535, 'should clamp port to max');
    assertEqual(settings.scanDepth, 0, 'should clamp scanDepth to min');
    assertEqual(settings.cacheTTL, 86400, 'should clamp cacheTTL to max');
});

test('validateSettings: clamps AI settings', () => {
    const settings = { aiSearchMaxTokens: 10000, aiSearchTimeout: 500, syncPollingInterval: 5000 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.aiSearchMaxTokens, 4096, 'should clamp AI max tokens');
    assertEqual(settings.aiSearchTimeout, 1000, 'should clamp AI timeout to min');
    assertEqual(settings.syncPollingInterval, 3600, 'should clamp sync interval to max');
});

test('validateSettings: rounds floats', () => {
    const settings = { scanDepth: 4.7 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.scanDepth, 5, 'should round float to integer');
});

test('validateSettings: trims lorebook tag', () => {
    const settings = { lorebookTag: '  custom-tag  ' };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.lorebookTag, 'custom-tag', 'should trim whitespace');
});

test('validateSettings: defaults empty lorebook tag', () => {
    const settings = { lorebookTag: '   ' };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.lorebookTag, 'lorebook', 'should default empty tag to lorebook');
});

test('validateSettings: clamps scribe interval', () => {
    const settings = { scribeInterval: 100 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.scribeInterval, 50, 'should clamp scribe interval to max');
});

test('validateSettings: clamps manifest summary length', () => {
    const settings = { aiSearchManifestSummaryLength: 2000 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.aiSearchManifestSummaryLength, 1000, 'should clamp summary length to max');
});

test('validateSettings: clamps reinjection cooldown', () => {
    const settings = { reinjectionCooldown: 100 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.reinjectionCooldown, 50, 'should clamp reinjection cooldown to max');
});

test('validateSettings: clamps new chat threshold', () => {
    const settings = { newChatThreshold: 30 };
    validateSettings(settings, settingsConstraints);
    assertEqual(settings.newChatThreshold, 20, 'should clamp new chat threshold to max');
});

// ============================================================================
// Tests: buildScanText / buildAiChatContext
// ============================================================================

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
    const chat = [{ name: 'Alice', is_user: true, mes: 'Hello' }];
    assertEqual(buildAiChatContext(chat, 0), '', 'should return empty string for depth 0');
});

// ============================================================================
// Tests: applyGating
// ============================================================================

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
    const entries = [
        makeEntry('A', { requires: ['B'] }),
        makeEntry('B', { requires: ['C'] }),
    ];
    const result = applyGating(entries);
    assertEqual(result.length, 0, 'both should be removed by cascading');
});

test('applyGating: empty requires/excludes passes', () => {
    const entries = [makeEntry('Eris'), makeEntry('Plain Entry')];
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
// Tests: formatAndGroup (using imported core version)
// ============================================================================

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
    const result = formatAndGroup(entries, defaultTestSettings, 'deeplore_');
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
    const result = formatAndGroup(entries, defaultTestSettings, 'deeplore_');
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
    const result = formatAndGroup(entries, settings, 'deeplore_');
    // C gets truncated to fit remaining 200 tokens (content is short so it fits entirely)
    assertEqual(result.count, 3, 'should accept all 3 entries (C truncated to fit)');
    assert(result.totalTokens <= 1200, 'total should not exceed budget');
    assert(result.acceptedEntries[2]._truncated === true, 'C should be truncated');
});

test('formatAndGroup: per-entry depth override', () => {
    const entries = [
        makeEntry('Near', { content: 'Close to action', injectionDepth: 1 }),
        makeEntry('Far', { content: 'Background info', injectionDepth: 8 }),
    ];
    const result = formatAndGroup(entries, defaultTestSettings, 'deeplore_');
    assertEqual(result.groups.length, 2, 'should produce two groups at different depths');
    assert(result.groups.some(g => g.depth === 1), 'should have depth 1 group');
    assert(result.groups.some(g => g.depth === 8), 'should have depth 8 group');
});

test('formatAndGroup: fallback to global settings', () => {
    const entries = [makeEntry('Test', { content: 'Body' })];
    const result = formatAndGroup(entries, defaultTestSettings, 'deeplore_');
    assertEqual(result.groups[0].position, 1, 'should use global position');
    assertEqual(result.groups[0].depth, 4, 'should use global depth');
    assertEqual(result.groups[0].role, 0, 'should use global role');
});

test('formatAndGroup: truncates entry to fit remaining budget', () => {
    // Use content with sentence endings so truncateToSentence finds clean boundaries
    const sentences = Array(50).fill('The quick brown fox jumped over the lazy dog.').join(' ');
    const longContent = sentences; // ~700+ chars, ~200 tokens
    const entries = [
        makeEntry('Small', { content: 'Short content.', tokenEstimate: 100 }),
        makeEntry('Big', { content: longContent, tokenEstimate: 200 }),
    ];
    const settings = { ...defaultTestSettings, unlimitedBudget: false, maxTokensBudget: 160 };
    const result = formatAndGroup(entries, settings, 'deeplore_');
    assertEqual(result.count, 2, 'should accept both entries (second truncated)');
    const big = result.acceptedEntries.find(e => e.title === 'Big');
    assert(big, 'Big entry should be in acceptedEntries');
    assert(big._truncated === true, 'Big entry should be marked as truncated');
    assert(big._originalTokens === 200, 'should preserve original token count');
    assert(big.tokenEstimate <= 60, 'truncated tokenEstimate should fit remaining budget');
    assert(big.content.length < longContent.length, 'content should be shorter than original');
});

test('formatAndGroup: skips entry when remaining budget below minimum threshold', () => {
    const entries = [
        makeEntry('A', { content: 'First entry.', tokenEstimate: 180 }),
        makeEntry('B', { content: 'Second entry.', tokenEstimate: 200 }),
    ];
    const settings = { ...defaultTestSettings, unlimitedBudget: false, maxTokensBudget: 200 };
    const result = formatAndGroup(entries, settings, 'deeplore_');
    assertEqual(result.count, 1, 'should only accept first entry (remaining < 50 tokens)');
    assertEqual(result.acceptedEntries[0].title, 'A', 'should be entry A');
});

test('formatAndGroup: truncates first entry that exceeds entire budget', () => {
    const sentences = Array(100).fill('The ancient vampire stalked through the dark corridor.').join(' ');
    const entries = [
        makeEntry('Huge', { content: sentences, tokenEstimate: 1000 }),
    ];
    const settings = { ...defaultTestSettings, unlimitedBudget: false, maxTokensBudget: 200 };
    const result = formatAndGroup(entries, settings, 'deeplore_');
    assertEqual(result.count, 1, 'should accept truncated entry');
    assert(result.acceptedEntries[0]._truncated === true, 'should be truncated');
    assert(result.acceptedEntries[0].tokenEstimate <= 210, 'should approximately fit budget');
});

test('formatAndGroup: acceptedEntries correct when first entry skipped', () => {
    // Budget is tiny (30 tokens) — too small even for truncation (< MIN_TRUNCATION_TOKENS=50)
    const entries = [
        makeEntry('TooBig', { content: 'Massive entry.', tokenEstimate: 500 }),
        makeEntry('Small', { content: 'Tiny.', tokenEstimate: 20 }),
    ];
    const settings = { ...defaultTestSettings, unlimitedBudget: false, maxTokensBudget: 30 };
    const result = formatAndGroup(entries, settings, 'deeplore_');
    assertEqual(result.count, 1, 'should accept Small (skip TooBig)');
    assertEqual(result.acceptedEntries[0].title, 'Small', 'accepted should be Small, not TooBig');
});

test('formatAndGroup: truncation does not mutate original entry', () => {
    const originalContent = 'C'.repeat(700);
    const entry = makeEntry('Mutable?', { content: originalContent, tokenEstimate: 200 });
    const settings = { ...defaultTestSettings, unlimitedBudget: false, maxTokensBudget: 100 };
    formatAndGroup([entry], settings, 'deeplore_');
    assertEqual(entry.content, originalContent, 'original entry content should be unchanged');
    assertEqual(entry.tokenEstimate, 200, 'original tokenEstimate should be unchanged');
    assert(entry._truncated === undefined, 'original should not have _truncated flag');
});

// ============================================================================
// Tests: detectChanges
// ============================================================================

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
// Tests: parseVaultFile (core/pipeline.js)
// ============================================================================

test('parseVaultFile: parses valid lorebook entry', () => {
    const file = {
        filename: 'Characters/Eris.md',
        content: '---\ntags:\n  - lorebook\nkeys:\n  - Eris\n  - goddess\npriority: 20\nsummary: "A powerful goddess"\n---\n# Eris\n\nShe is a goddess.',
    };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: 'lorebook-always', neverInsertTag: 'lorebook-never', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assert(entry !== null, 'should return an entry');
    assertEqual(entry.title, 'Eris', 'should extract title');
    assertEqual(entry.keys, ['Eris', 'goddess'], 'should extract keys');
    assertEqual(entry.priority, 20, 'should extract priority');
    assertEqual(entry.summary, 'A powerful goddess', 'should extract summary');
    assertEqual(entry.constant, false, 'should not be constant');
    assertEqual(entry.seed, false, 'should not be seed');
    assertEqual(entry.bootstrap, false, 'should not be bootstrap');
});

test('parseVaultFile: skips non-lorebook files', () => {
    const file = { filename: 'notes.md', content: '---\ntags:\n  - misc\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    assertEqual(parseVaultFile(file, tagConfig), null, 'should return null for non-lorebook');
});

test('parseVaultFile: skips disabled entries', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nenabled: false\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    assertEqual(parseVaultFile(file, tagConfig), null, 'should return null for disabled');
});

test('parseVaultFile: skips never-insert tag', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\n  - lorebook-never\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: 'lorebook-never', seedTag: '', bootstrapTag: '' };
    assertEqual(parseVaultFile(file, tagConfig), null, 'should return null for never-insert');
});

test('parseVaultFile: detects constant tag', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\n  - lorebook-always\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: 'lorebook-always', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.constant, true, 'should detect constant from tag');
});

test('parseVaultFile: detects seed and bootstrap tags', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\n  - lorebook-seed\n  - lorebook-bootstrap\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: 'lorebook-seed', bootstrapTag: 'lorebook-bootstrap' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.seed, true, 'should detect seed from tag');
    assertEqual(entry.bootstrap, true, 'should detect bootstrap from tag');
});

// ============================================================================
// Tests: parseVaultFile probability (core/pipeline.js)
// ============================================================================

test('parseVaultFile: probability 0.5', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nprobability: 0.5\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, 0.5, 'should parse probability 0.5');
});

test('parseVaultFile: probability 0', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nprobability: 0\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, 0, 'should parse probability 0');
});

test('parseVaultFile: probability 1', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nprobability: 1\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, 1, 'should parse probability 1');
});

test('parseVaultFile: probability clamped above 1', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nprobability: 1.5\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, 1, 'should clamp probability to 1');
});

test('parseVaultFile: probability clamped below 0', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nprobability: -0.3\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, 0, 'should clamp probability to 0');
});

test('parseVaultFile: no probability field', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, null, 'should default to null when no probability');
});

test('parseVaultFile: probability non-number string', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nprobability: "not a number"\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.probability, null, 'should default to null for non-number probability');
});

test('parseVaultFile: probability field present on VaultEntry', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nkeys:\n  - test\n---\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assert('probability' in entry, 'probability field should exist on VaultEntry');
});

// ============================================================================
// Tests: clearPrompts (core/pipeline.js)
// ============================================================================

test('clearPrompts: removes matching prompts', () => {
    const prompts = {
        'deeplore_p1_d4_r0': 'test',
        'deeplore_enhanced': 'test',
        'other_prompt': 'keep',
    };
    clearPrompts(prompts, 'deeplore_', 'deeplore_enhanced');
    assertEqual(Object.keys(prompts), ['other_prompt'], 'should remove deeplore prompts only');
});

// ============================================================================
// Tests: resolveLinks (core/matching.js)
// ============================================================================

test('resolveLinks: resolves matching titles', () => {
    const index = [
        makeEntry('Eris', { links: ['Dark Council', 'Unknown Page'] }),
        makeEntry('Dark Council', { links: ['Eris'] }),
    ];
    resolveLinks(index);
    assertEqual(index[0].resolvedLinks, ['Dark Council'], 'should resolve matching link');
    assertEqual(index[1].resolvedLinks, ['Eris'], 'should resolve reverse link');
});

// ============================================================================
// Tests: countKeywordOccurrences (core/matching.js)
// ============================================================================

test('countKeywordOccurrences: counts multiple hits', () => {
    const entry = { keys: ['Eris'] };
    const settings = { caseSensitive: false, matchWholeWords: false };
    assertEqual(countKeywordOccurrences(entry, 'Eris met eris and ERIS', settings), 3, 'should count 3 occurrences');
});

test('countKeywordOccurrences: whole words', () => {
    const entry = { keys: ['war'] };
    const settings = { caseSensitive: false, matchWholeWords: true };
    assertEqual(countKeywordOccurrences(entry, 'The war and warning of warfare', settings), 1, 'should count only whole word matches');
});

// ============================================================================
// Tests: takeIndexSnapshot (core/sync.js)
// ============================================================================

test('takeIndexSnapshot: creates snapshot from vault index', () => {
    const index = [
        makeEntry('Eris', { content: 'A goddess', keys: ['Eris'] }),
        makeEntry('Temple', { content: 'Sacred', keys: ['temple'] }),
    ];
    const snapshot = takeIndexSnapshot(index);
    assertEqual(snapshot.contentHashes.size, 2, 'should hash both entries');
    assertEqual(snapshot.titleMap.get('Eris.md'), 'Eris', 'should map filename to title');
});

// ============================================================================
// Tests: Enhanced-only functions
// ============================================================================

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
// Tests: runHealthCheck detection patterns (mirrors index.js logic)
// ============================================================================

/**
 * Portable health check for testing detection patterns.
 * Mirrors the real runHealthCheck() from index.js but accepts params.
 */
function testHealthCheck(vaultIndex, settings = {}) {
    const issues = [];
    const allTitles = new Set(vaultIndex.map(e => e.title));
    const titleCounts = new Map();

    for (const entry of vaultIndex) {
        titleCounts.set(entry.title, (titleCounts.get(entry.title) || 0) + 1);

        // Circular requires
        for (const req of entry.requires) {
            const target = vaultIndex.find(e => e.title.toLowerCase() === req.toLowerCase());
            if (target && target.requires.some(r => r.toLowerCase() === entry.title.toLowerCase())) {
                if (entry.title < target.title) {
                    issues.push({ type: 'circular_requires', entry: entry.title, target: target.title });
                }
            }
        }

        // Requires AND excludes same title
        for (const req of entry.requires) {
            if (entry.excludes.some(exc => exc.toLowerCase() === req.toLowerCase())) {
                issues.push({ type: 'requires_excludes_conflict', entry: entry.title, ref: req });
            }
        }

        // Orphaned cascade_links
        if (entry.cascadeLinks) {
            for (const cl of entry.cascadeLinks) {
                if (!allTitles.has(cl)) {
                    issues.push({ type: 'orphaned_cascade', entry: entry.title, ref: cl });
                }
            }
        }

        // Cooldown on constant
        if (entry.constant && entry.cooldown !== null) {
            issues.push({ type: 'cooldown_on_constant', entry: entry.title });
        }

        // Depth override without in_chat
        if (entry.injectionDepth !== null && entry.injectionPosition !== 1) {
            issues.push({ type: 'depth_without_inchat', entry: entry.title });
        }

        // Empty content
        if (!entry.content || !entry.content.trim()) {
            issues.push({ type: 'empty_content', entry: entry.title });
        }

        // Probability zero
        if (entry.probability === 0) {
            issues.push({ type: 'probability_zero', entry: entry.title });
        }
    }

    // Duplicate titles
    for (const [title, count] of titleCounts) {
        if (count > 1) {
            issues.push({ type: 'duplicate_title', entry: title });
        }
    }

    // Constants exceeding budget
    if (settings.maxTokensBudget && !settings.unlimitedBudget) {
        const constantTokens = vaultIndex.filter(e => e.constant).reduce((s, e) => s + e.tokenEstimate, 0);
        if (constantTokens > settings.maxTokensBudget) {
            issues.push({ type: 'constants_over_budget', tokens: constantTokens });
        }
    }

    return issues;
}

test('health: circular requires detection', () => {
    const index = [
        makeEntry('A', { requires: ['B'], keys: ['a'] }),
        makeEntry('B', { requires: ['A'], keys: ['b'] }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'circular_requires'), 'should detect circular requires');
});

test('health: duplicate title detection', () => {
    const index = [
        makeEntry('Eris', { keys: ['eris'] }),
        makeEntry('Eris', { keys: ['eris2'] }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'duplicate_title'), 'should detect duplicate titles');
});

test('health: orphaned cascade_links', () => {
    const index = [
        makeEntry('A', { keys: ['a'], cascadeLinks: ['NonExistent'] }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'orphaned_cascade'), 'should detect orphaned cascade links');
});

test('health: requires AND excludes same title', () => {
    const index = [
        makeEntry('A', { keys: ['a'], requires: ['B'], excludes: ['B'] }),
        makeEntry('B', { keys: ['b'] }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'requires_excludes_conflict'), 'should detect requires/excludes conflict');
});

test('health: cooldown on constant', () => {
    const index = [
        makeEntry('A', { constant: true, cooldown: 5 }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'cooldown_on_constant'), 'should flag cooldown on constant entry');
});

test('health: depth override without position override', () => {
    const index = [
        makeEntry('A', { keys: ['a'], injectionDepth: 3, injectionPosition: 0 }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'depth_without_inchat'), 'should flag depth without in_chat');
});

test('health: empty content entry', () => {
    const index = [
        makeEntry('A', { keys: ['a'], content: '' }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'empty_content'), 'should flag empty content');
});

test('health: probability zero warning', () => {
    const index = [
        makeEntry('A', { keys: ['a'], probability: 0 }),
    ];
    const issues = testHealthCheck(index);
    assert(issues.some(i => i.type === 'probability_zero'), 'should flag probability 0');
});

test('health: constants exceeding budget', () => {
    const index = [
        makeEntry('A', { constant: true, tokenEstimate: 1500 }),
        makeEntry('B', { constant: true, tokenEstimate: 1500 }),
    ];
    const issues = testHealthCheck(index, { maxTokensBudget: 2000, unlimitedBudget: false });
    assert(issues.some(i => i.type === 'constants_over_budget'), 'should flag constants over budget');
});

test('health: clean vault returns no issues', () => {
    const index = [
        makeEntry('Eris', { keys: ['eris'], content: 'A vampire queen.', summary: 'Main character' }),
        makeEntry('Temple', { keys: ['temple'], content: 'A dark temple.', summary: 'Location' }),
    ];
    const issues = testHealthCheck(index);
    assertEqual(issues.length, 0, 'clean vault should have no issues');
});

// ============================================================================
// Tests: Multi-Vault Support
// ============================================================================

test('parseVaultFile: vaultSource field defaults to empty string', () => {
    const file = { filename: 'test.md', content: '---\ntags:\n  - lorebook\nkeys:\n  - test\n---\n# Test\nContent' };
    const tagConfig = { lorebookTag: 'lorebook', constantTag: '', neverInsertTag: '', seedTag: '', bootstrapTag: '' };
    const entry = parseVaultFile(file, tagConfig);
    assertEqual(entry.vaultSource, '', 'vaultSource should default to empty string');
});

test('multi-vault: entries from different vaults merge with vaultSource', () => {
    const e1 = makeEntry('Eris', { vaultSource: 'Primary', keys: ['eris'] });
    const e2 = makeEntry('Temple', { vaultSource: 'Lore', keys: ['temple'] });
    const combined = [e1, e2];
    assertEqual(combined.length, 2, 'should merge entries from both vaults');
    assertEqual(combined[0].vaultSource, 'Primary', 'first entry should have Primary vault');
    assertEqual(combined[1].vaultSource, 'Lore', 'second entry should have Lore vault');
});

test('multi-vault: settings migration from legacy format', () => {
    // Simulate legacy settings with obsidianPort/obsidianApiKey but no vaults
    const legacySettings = {
        obsidianPort: 27123,
        obsidianApiKey: 'test-key',
        vaults: [],
    };

    // Migration logic (mirrors getSettings)
    if (legacySettings.vaults.length === 0 && legacySettings.obsidianPort) {
        legacySettings.vaults = [{
            name: 'Primary',
            port: legacySettings.obsidianPort,
            apiKey: legacySettings.obsidianApiKey || '',
            enabled: true,
        }];
    }

    assertEqual(legacySettings.vaults.length, 1, 'should create one vault from legacy settings');
    assertEqual(legacySettings.vaults[0].name, 'Primary', 'vault name should be Primary');
    assertEqual(legacySettings.vaults[0].port, 27123, 'vault port should match legacy port');
    assertEqual(legacySettings.vaults[0].apiKey, 'test-key', 'vault apiKey should match legacy key');
    assertEqual(legacySettings.vaults[0].enabled, true, 'vault should be enabled');
});

test('multi-vault: getPrimaryVault logic', () => {
    // Test getPrimaryVault helper logic
    const vaults = [
        { name: 'Disabled', port: 1111, apiKey: '', enabled: false },
        { name: 'Active', port: 2222, apiKey: 'key', enabled: true },
        { name: 'Backup', port: 3333, apiKey: 'key2', enabled: true },
    ];
    const primary = vaults.find(v => v.enabled) || vaults[0] || { name: 'Default', port: 27123, apiKey: '', enabled: true };
    assertEqual(primary.name, 'Active', 'should return first enabled vault');
    assertEqual(primary.port, 2222, 'should return correct port');
});

test('multi-vault: getVaultByName logic', () => {
    const vaults = [
        { name: 'Primary', port: 27123, apiKey: 'pk', enabled: true },
        { name: 'Lore', port: 27124, apiKey: 'lk', enabled: true },
    ];
    // Find by name
    const lore = vaults.find(v => v.name === 'Lore' && v.enabled);
    assertEqual(lore.port, 27124, 'should find vault by name');
    // Fallback to primary for unknown name
    const unknown = vaults.find(v => v.name === 'Unknown' && v.enabled);
    assertEqual(unknown, undefined, 'should not find unknown vault');
});

test('multi-vault: health check detects no enabled vaults', () => {
    // Test health check logic for empty/disabled vaults
    const vaults = [
        { name: 'V1', port: 27123, apiKey: '', enabled: false },
    ];
    const enabledVaults = vaults.filter(v => v.enabled);
    const issues = [];
    if (enabledVaults.length === 0) {
        issues.push({ type: 'Settings', severity: 'error', detail: 'No enabled vaults' });
    }
    assertEqual(issues.length, 1, 'should flag no enabled vaults');
    assertEqual(issues[0].severity, 'error', 'should be an error');
});

// ============================================================================
// Phase 3: Infrastructure tests
// ============================================================================

test('sliding window cache: exact match structure', () => {
    const cache = { hash: '', manifestHash: '', chatLineCount: 0, results: [] };
    assertEqual(typeof cache.manifestHash, 'string', 'cache should have manifestHash');
    assertEqual(typeof cache.chatLineCount, 'number', 'cache should have chatLineCount');

    // Simulate cache population
    cache.hash = simpleHash('chat content');
    cache.manifestHash = simpleHash('manifest content');
    cache.chatLineCount = 5;
    cache.results = [{ entry: makeEntry('A'), confidence: 'high', reason: 'test' }];

    // Exact match: same hash + manifestHash
    const newHash = simpleHash('chat content');
    const newManifestHash = simpleHash('manifest content');
    assert(cache.hash === newHash && cache.manifestHash === newManifestHash, 'exact cache match should hit');

    // Different chat: miss
    const diffHash = simpleHash('different chat');
    assert(cache.hash !== diffHash, 'different chat hash should miss');
});

test('sliding window cache: entity mention detection', () => {
    // Simulate sliding window logic: new lines with no entity mentions → cache hit
    const entryNames = new Set(['alice', 'dark forest', 'sword of truth']);
    const newText = 'the weather was nice today and we walked around the park';

    let hasNewEntityMention = false;
    for (const name of entryNames) {
        if (newText.includes(name)) {
            hasNewEntityMention = true;
            break;
        }
    }
    assert(!hasNewEntityMention, 'no entity mention in new text should allow cache hit');

    // New text that DOES mention an entity
    const newText2 = 'alice walked into the room';
    let hasNewEntityMention2 = false;
    for (const name of entryNames) {
        if (newText2.includes(name)) {
            hasNewEntityMention2 = true;
            break;
        }
    }
    assert(hasNewEntityMention2, 'entity mention in new text should invalidate cache');
});

test('hierarchical clustering: clusterEntries groups by tag', () => {
    // Inline cluster function for testing
    function clusterEntries(entries) {
        const clusters = new Map();
        for (const entry of entries) {
            let category = 'Uncategorized';
            if (entry.tags && entry.tags.length > 0) {
                category = entry.tags[0];
            }
            if (!clusters.has(category)) clusters.set(category, []);
            clusters.get(category).push(entry);
        }
        return clusters;
    }

    const entries = [
        makeEntry('Alice', { tags: ['character'] }),
        makeEntry('Bob', { tags: ['character'] }),
        makeEntry('Dark Forest', { tags: ['location'] }),
        makeEntry('Magic System', { tags: ['lore'] }),
        makeEntry('Misc', {}),
    ];

    const clusters = clusterEntries(entries);
    assertEqual(clusters.size, 4, 'should have 4 clusters');
    assertEqual(clusters.get('character').length, 2, 'character cluster should have 2 entries');
    assertEqual(clusters.get('location').length, 1, 'location cluster should have 1 entry');
    assertEqual(clusters.get('Uncategorized').length, 1, 'uncategorized should have 1 entry');
});

test('hierarchical clustering: buildCategoryManifest formats correctly', () => {
    function buildCategoryManifest(clusters) {
        const lines = [];
        for (const [category, entries] of clusters) {
            const samples = entries.slice(0, 5).map(e => e.title).join(', ');
            const more = entries.length > 5 ? ` (+${entries.length - 5} more)` : '';
            lines.push(`[${category}] (${entries.length} entries): ${samples}${more}`);
        }
        return lines.join('\n');
    }

    const clusters = new Map();
    clusters.set('character', [makeEntry('A'), makeEntry('B'), makeEntry('C'), makeEntry('D'), makeEntry('E'), makeEntry('F')]);
    clusters.set('location', [makeEntry('Place1')]);

    const manifest = buildCategoryManifest(clusters);
    assert(manifest.includes('[character] (6 entries)'), 'should show character count');
    assert(manifest.includes('(+1 more)'), 'should show +more for >5 entries');
    assert(manifest.includes('[location] (1 entries)'), 'should show location count');
});

test('delta sync: file set comparison logic', () => {
    // Simulate delta sync logic
    const knownFiles = new Set(['Alice.md', 'Bob.md', 'Forest.md']);
    const currentFiles = ['Alice.md', 'Bob.md', 'NewEntry.md'];

    const newFiles = currentFiles.filter(f => !knownFiles.has(f));
    const removedFiles = [...knownFiles].filter(f => !currentFiles.includes(f));

    assertEqual(newFiles, ['NewEntry.md'], 'should detect new files');
    assertEqual(removedFiles, ['Forest.md'], 'should detect removed files');
});

test('delta sync: no changes returns empty diff', () => {
    const knownFiles = new Set(['Alice.md', 'Bob.md']);
    const currentFiles = ['Alice.md', 'Bob.md'];

    const newFiles = currentFiles.filter(f => !knownFiles.has(f));
    const removedFiles = [...knownFiles].filter(f => !currentFiles.includes(f));

    assertEqual(newFiles.length, 0, 'no new files');
    assertEqual(removedFiles.length, 0, 'no removed files');
});

// ============================================================================
// Tests: Pipeline Stages (src/stages.js)
// ============================================================================

import {
    buildExemptionPolicy, applyPinBlock, applyContextualGating,
    applyReinjectionCooldown, applyRequiresExcludesGating,
    applyStripDedup, trackGeneration, decrementTrackers, recordAnalytics,
} from './src/stages.js';

// -- buildExemptionPolicy --

test('buildExemptionPolicy: constants are in forceInject', () => {
    const vault = [makeEntry('A', { constant: true }), makeEntry('B')];
    const policy = buildExemptionPolicy(vault, [], []);
    assert(policy.forceInject.has('A'), 'constant A should be in forceInject');
    assert(!policy.forceInject.has('B'), 'non-constant B should NOT be in forceInject');
});

test('buildExemptionPolicy: pins are in forceInject', () => {
    const vault = [makeEntry('A'), makeEntry('B')];
    const policy = buildExemptionPolicy(vault, ['A'], []);
    assert(policy.forceInject.has('A'), 'pinned A should be in forceInject');
    assert(!policy.forceInject.has('B'), 'non-pinned B should NOT be in forceInject');
});

test('buildExemptionPolicy: bootstrap entries are in forceInject', () => {
    const vault = [makeEntry('Boot', { bootstrap: true }), makeEntry('Normal')];
    const policy = buildExemptionPolicy(vault, [], []);
    assert(policy.forceInject.has('Boot'), 'bootstrap should be in forceInject');
    assert(!policy.forceInject.has('Normal'), 'normal should NOT be in forceInject');
});

test('buildExemptionPolicy: blocks stored lowercase in policy', () => {
    const vault = [makeEntry('A')];
    const policy = buildExemptionPolicy(vault, [], ['Blocked Entry']);
    assert(policy.blocks.has('blocked entry'), 'block should be stored lowercase');
    assert(!policy.blocks.has('Blocked Entry'), 'original case should not match');
});

test('buildExemptionPolicy: empty inputs produce empty sets', () => {
    const policy = buildExemptionPolicy([], [], []);
    assertEqual(policy.forceInject.size, 0, 'empty vault = empty forceInject');
    assertEqual(policy.pins.size, 0, 'empty pins');
    assertEqual(policy.blocks.size, 0, 'empty blocks');
});

test('buildExemptionPolicy: pin and constant overlap is deduplicated', () => {
    const vault = [makeEntry('A', { constant: true })];
    const policy = buildExemptionPolicy(vault, ['A'], []);
    assertEqual(policy.forceInject.size, 1, 'A appears once despite being constant and pinned');
    assert(policy.forceInject.has('A'), 'A is in forceInject');
});

// -- applyPinBlock --

test('applyPinBlock: pinned entries added with constant=true and priority=10', () => {
    const vault = [makeEntry('A', { priority: 50 }), makeEntry('B', { priority: 80 })];
    const policy = buildExemptionPolicy(vault, ['B'], []);
    const matchedKeys = new Map();
    const result = applyPinBlock([vault[0]], vault, policy, matchedKeys);
    assertEqual(result.length, 2, 'B should be added');
    const pinned = result.find(e => e.title === 'B');
    assert(pinned.constant === true, 'pinned entry should have constant=true');
    assertEqual(pinned.priority, 10, 'pinned entry should have priority=10');
    assertEqual(matchedKeys.get('B'), '(pinned)', 'matchedKeys should record pin');
});

test('applyPinBlock: pinned entry already in results gets constant+priority override', () => {
    const vault = [makeEntry('A', { priority: 50 })];
    const policy = buildExemptionPolicy(vault, ['A'], []);
    const matchedKeys = new Map();
    const result = applyPinBlock([vault[0]], vault, policy, matchedKeys);
    assertEqual(result.length, 1, 'no duplicate');
    assert(result[0].constant === true, 'existing entry should get constant=true');
    assertEqual(result[0].priority, 10, 'existing entry should get priority=10');
});

test('applyPinBlock: does not mutate original entry objects', () => {
    const original = makeEntry('A', { priority: 50 });
    const vault = [original];
    const policy = buildExemptionPolicy(vault, ['A'], []);
    applyPinBlock([original], vault, policy, new Map());
    assertEqual(original.priority, 50, 'original entry priority unchanged');
    assertEqual(original.constant, false, 'original entry constant unchanged');
});

test('applyPinBlock: blocked entries removed (override constants)', () => {
    const vault = [makeEntry('A', { constant: true }), makeEntry('B')];
    const policy = buildExemptionPolicy(vault, [], ['A']);
    const result = applyPinBlock([vault[0], vault[1]], vault, policy, new Map());
    assertEqual(result.length, 1, 'blocked entry removed');
    assertEqual(result[0].title, 'B', 'only B remains');
});

test('applyPinBlock: block is case-insensitive', () => {
    const vault = [makeEntry('Eris')];
    const policy = buildExemptionPolicy(vault, [], ['ERIS']);
    const result = applyPinBlock([vault[0]], vault, policy, new Map());
    assertEqual(result.length, 0, 'case-insensitive block should remove Eris');
});

test('applyPinBlock: empty pins/blocks is a no-op', () => {
    const vault = [makeEntry('A'), makeEntry('B')];
    const policy = buildExemptionPolicy(vault, [], []);
    const result = applyPinBlock([vault[0], vault[1]], vault, policy, new Map());
    assertEqual(result.length, 2, 'all entries preserved');
});

test('applyPinBlock: pin on already-constant entry sets priority to 10', () => {
    const vault = [makeEntry('A', { constant: true, priority: 50 })];
    const policy = buildExemptionPolicy(vault, ['A'], []);
    const result = applyPinBlock([vault[0]], vault, policy, new Map());
    assertEqual(result[0].priority, 10, 'constant+pinned gets priority 10');
    assert(result[0].constant === true, 'remains constant');
});

// -- applyContextualGating --

test('applyContextualGating: no context set = return all entries unchanged', () => {
    const entries = [makeEntry('A', { era: ['golden'] }), makeEntry('B')];
    const result = applyContextualGating(entries, {}, { forceInject: new Set() }, false);
    assertEqual(result.length, 2, 'no gating when no context dimensions set');
});

test('applyContextualGating: entry with era matches active era', () => {
    const entries = [makeEntry('A', { era: ['golden'] }), makeEntry('B', { era: ['dark'] })];
    const result = applyContextualGating(entries, { era: 'golden' }, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'only golden era entry kept');
    assertEqual(result[0].title, 'A', 'A matches golden era');
});

test('applyContextualGating: entry with era dropped when no era active', () => {
    const entries = [makeEntry('A', { era: ['golden'] }), makeEntry('B')];
    const result = applyContextualGating(entries, { location: 'tavern' }, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'era entry dropped when no era set');
    assertEqual(result[0].title, 'B', 'ungated entry kept');
});

test('applyContextualGating: forceInject entries bypass era gating', () => {
    const entries = [makeEntry('A', { era: ['golden'] })];
    const result = applyContextualGating(entries, { location: 'tavern' }, { forceInject: new Set(['A']) }, false);
    assertEqual(result.length, 1, 'forceInject entry kept despite era mismatch');
});

test('applyContextualGating: location gating works', () => {
    const entries = [makeEntry('A', { location: ['tavern'] }), makeEntry('B', { location: ['castle'] })];
    const result = applyContextualGating(entries, { location: 'tavern' }, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'only matching location kept');
    assertEqual(result[0].title, 'A', 'tavern entry kept');
});

test('applyContextualGating: sceneType gating works', () => {
    const entries = [makeEntry('A', { sceneType: ['combat'] }), makeEntry('B')];
    const result = applyContextualGating(entries, { scene_type: 'combat' }, { forceInject: new Set() }, false);
    assertEqual(result.length, 2, 'combat entry and ungated entry both kept');
});

test('applyContextualGating: characterPresent gating works', () => {
    const entries = [
        makeEntry('A', { characterPresent: ['Eris'] }),
        makeEntry('B', { characterPresent: ['Raven'] }),
    ];
    const result = applyContextualGating(entries, { characters_present: ['Eris'] }, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'only Eris entry kept');
    assertEqual(result[0].title, 'A', 'A kept for Eris');
});

test('applyContextualGating: characterPresent with no present chars drops entry', () => {
    const entries = [makeEntry('A', { characterPresent: ['Eris'] }), makeEntry('B')];
    const result = applyContextualGating(entries, { era: 'golden' }, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'character-gated entry dropped when no chars present');
    assertEqual(result[0].title, 'B', 'ungated entry kept');
});

test('applyContextualGating: era matching is case-insensitive', () => {
    const entries = [makeEntry('A', { era: ['Golden Age'] })];
    const result = applyContextualGating(entries, { era: 'golden age' }, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'case-insensitive era match');
});

test('applyContextualGating: multiple era values, any match passes', () => {
    const entries = [makeEntry('A', { era: ['golden', 'silver'] })];
    const result = applyContextualGating(entries, { era: 'silver' }, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'silver matches one of the era values');
});

test('applyContextualGating: entry with no gating fields always passes', () => {
    const entries = [makeEntry('A')];
    const result = applyContextualGating(entries, { era: 'golden', location: 'tavern' }, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'ungated entry always passes regardless of active context');
});

// -- applyReinjectionCooldown --

test('applyReinjectionCooldown: cooldown=0 is a no-op', () => {
    const entries = [makeEntry('A')];
    const history = new Map([['A', 5]]);
    const result = applyReinjectionCooldown(entries, { forceInject: new Set() }, history, 6, 0, false);
    assertEqual(result.length, 1, 'cooldown disabled = all pass');
});

test('applyReinjectionCooldown: recently injected entry is filtered', () => {
    const a = makeEntry('A', { vaultSource: '' });
    const history = new Map([[':A', 5]]);
    const result = applyReinjectionCooldown([a], { forceInject: new Set() }, history, 6, 3, false);
    assertEqual(result.length, 0, 'entry injected 1 gen ago filtered (cooldown 3)');
});

test('applyReinjectionCooldown: old injection passes cooldown', () => {
    const a = makeEntry('A', { vaultSource: '' });
    const history = new Map([[':A', 2]]);
    const result = applyReinjectionCooldown([a], { forceInject: new Set() }, history, 6, 3, false);
    assertEqual(result.length, 1, 'entry injected 4 gens ago passes (cooldown 3)');
});

test('applyReinjectionCooldown: forceInject entries always pass', () => {
    const a = makeEntry('A', { vaultSource: '' });
    const history = new Map([[':A', 5]]);
    const result = applyReinjectionCooldown([a], { forceInject: new Set(['A']) }, history, 6, 3, false);
    assertEqual(result.length, 1, 'forceInject bypasses cooldown');
});

test('applyReinjectionCooldown: no history = all pass', () => {
    const entries = [makeEntry('A'), makeEntry('B')];
    const result = applyReinjectionCooldown(entries, { forceInject: new Set() }, new Map(), 10, 5, false);
    assertEqual(result.length, 2, 'no history = nothing filtered');
});

test('applyReinjectionCooldown: entry at exact cooldown boundary passes', () => {
    const a = makeEntry('A', { vaultSource: '' });
    const history = new Map([[':A', 4]]);
    // generationCount=7, lastGen=4, diff=3, cooldown=3 → NOT less than → passes
    const result = applyReinjectionCooldown([a], { forceInject: new Set() }, history, 7, 3, false);
    assertEqual(result.length, 1, 'at exact cooldown boundary should pass');
});

// -- applyRequiresExcludesGating --

test('applyRequiresExcludesGating: entry with met requires passes', () => {
    const entries = [makeEntry('A'), makeEntry('B', { requires: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 2, 'B requires A, A is present → both pass');
});

test('applyRequiresExcludesGating: entry with unmet requires removed', () => {
    const entries = [makeEntry('B', { requires: ['A'] })];
    const { result, removed } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 0, 'B requires A, A absent → B removed');
    assertEqual(removed.length, 1, 'B in removed list');
});

test('applyRequiresExcludesGating: entry with triggered excludes removed', () => {
    const entries = [makeEntry('A'), makeEntry('B', { excludes: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'B excludes A → B removed');
    assertEqual(result[0].title, 'A', 'A stays');
});

test('applyRequiresExcludesGating: forceInject entry with unmet requires kept (NEW behavior)', () => {
    const entries = [makeEntry('B', { requires: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set(['B']) }, false);
    assertEqual(result.length, 1, 'forceInject B kept despite unmet requires');
    assertEqual(result[0].title, 'B', 'B is in result');
});

test('applyRequiresExcludesGating: forceInject entry with triggered excludes kept', () => {
    const entries = [makeEntry('A'), makeEntry('B', { excludes: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set(['B']) }, false);
    assertEqual(result.length, 2, 'forceInject B kept despite excludes match');
});

test('applyRequiresExcludesGating: mutual requires both kept (both present)', () => {
    // When A requires B and B requires A, both are present so both requirements are met
    const entries = [makeEntry('A', { requires: ['B'] }), makeEntry('B', { requires: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 2, 'mutual requires: both present → both kept');
});

test('applyRequiresExcludesGating: excludes removes the EXCLUDING entry, not the target', () => {
    // C has excludes:['A'] → C is removed when A is present (not the other way around)
    const entries = [makeEntry('A'), makeEntry('C', { excludes: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'C removed because it excludes A which is present');
    assertEqual(result[0].title, 'A', 'A stays');
});

test('applyRequiresExcludesGating: cascade removal via third-party excludes', () => {
    // A has excludes:['C'] → A removed because C present → B requires A (absent) → B removed
    const entries = [
        makeEntry('A', { excludes: ['C'] }),
        makeEntry('B', { requires: ['A'] }),
        makeEntry('C'),
    ];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'A and B cascade-removed, C stays');
    assertEqual(result[0].title, 'C', 'only C survives');
});

test('applyRequiresExcludesGating: circular requires with one forceInject breaks cycle', () => {
    const entries = [makeEntry('A', { requires: ['B'] }), makeEntry('B', { requires: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set(['A']) }, false);
    // A is forceInject so it stays. B requires A which is present → B also stays.
    assertEqual(result.length, 2, 'forceInject A breaks the cycle');
});

test('applyRequiresExcludesGating: cascade removal (A→B→C chain)', () => {
    const entries = [
        makeEntry('A', { requires: ['X'] }), // X not present → A removed
        makeEntry('B', { requires: ['A'] }), // A removed → B removed too
        makeEntry('C'),                       // C has no deps → stays
    ];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 1, 'cascade: A and B removed, C stays');
    assertEqual(result[0].title, 'C', 'C survives');
});

test('applyRequiresExcludesGating: contradictory gating (A requires B, B excludes A)', () => {
    const entries = [makeEntry('A', { requires: ['B'] }), makeEntry('B', { excludes: ['A'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    // Round 1: B excludes A (present) → B removed. Round 2: A requires B (absent) → A removed. Both dropped.
    assertEqual(result.length, 0, 'contradictory: both A and B dropped');
});

test('applyRequiresExcludesGating: requires matching is case-insensitive', () => {
    const entries = [makeEntry('Eris'), makeEntry('Bond', { requires: ['eris'] })];
    const { result } = applyRequiresExcludesGating(entries, { forceInject: new Set() }, false);
    assertEqual(result.length, 2, 'case-insensitive: "eris" matches "Eris"');
});

test('applyRequiresExcludesGating: empty entries list = empty result', () => {
    const { result, removed } = applyRequiresExcludesGating([], { forceInject: new Set() }, false);
    assertEqual(result.length, 0, 'empty in = empty out');
    assertEqual(removed.length, 0, 'nothing removed');
});

// -- applyStripDedup --

test('applyStripDedup: no injection log = no-op', () => {
    const entries = [makeEntry('A')];
    const result = applyStripDedup(entries, { forceInject: new Set() }, null, 2, {}, false);
    assertEqual(result.length, 1, 'no log = all pass');
});

test('applyStripDedup: empty log = no-op', () => {
    const entries = [makeEntry('A')];
    const result = applyStripDedup(entries, { forceInject: new Set() }, [], 2, {}, false);
    assertEqual(result.length, 1, 'empty log = all pass');
});

test('applyStripDedup: recently injected entry filtered', () => {
    const entries = [makeEntry('A', { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 })];
    const log = [{ gen: 1, entries: [{ title: 'A', pos: 1, depth: 4, role: 0, contentHash: '' }] }];
    const result = applyStripDedup(entries, { forceInject: new Set() }, log, 2, { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 }, false);
    assertEqual(result.length, 0, 'recently injected entry stripped');
});

test('applyStripDedup: forceInject entries never stripped', () => {
    const entries = [makeEntry('A', { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 })];
    const log = [{ gen: 1, entries: [{ title: 'A', pos: 1, depth: 4, role: 0, contentHash: '' }] }];
    const result = applyStripDedup(entries, { forceInject: new Set(['A']) }, log, 2, { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 }, false);
    assertEqual(result.length, 1, 'forceInject bypasses dedup');
});

test('applyStripDedup: lookback depth respected', () => {
    const entries = [makeEntry('A', { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 })];
    // Log has 3 entries but lookback is 1 — only most recent checked
    const log = [
        { gen: 1, entries: [{ title: 'A', pos: 1, depth: 4, role: 0, contentHash: '' }] },
        { gen: 2, entries: [{ title: 'B', pos: 1, depth: 4, role: 0, contentHash: '' }] },
        { gen: 3, entries: [{ title: 'C', pos: 1, depth: 4, role: 0, contentHash: '' }] },
    ];
    const result = applyStripDedup(entries, { forceInject: new Set() }, log, 1, { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 }, false);
    assertEqual(result.length, 1, 'A only in gen1, lookback=1 checks gen3 only → A passes');
});

test('applyStripDedup: different content hash = not a duplicate', () => {
    const entries = [{ ...makeEntry('A'), injectionPosition: 1, injectionDepth: 4, injectionRole: 0, _contentHash: 'abc123' }];
    const log = [{ gen: 1, entries: [{ title: 'A', pos: 1, depth: 4, role: 0, contentHash: 'different' }] }];
    const result = applyStripDedup(entries, { forceInject: new Set() }, log, 2, { injectionPosition: 1, injectionDepth: 4, injectionRole: 0 }, false);
    assertEqual(result.length, 1, 'different content hash = not a duplicate');
});

// -- trackGeneration --

test('trackGeneration: sets cooldown for entries with cooldown value', () => {
    const entries = [makeEntry('A', { cooldown: 3, vaultSource: '' })];
    const cooldownTracker = new Map();
    const decayTracker = new Map();
    const injHistory = new Map();
    trackGeneration(entries, 5, cooldownTracker, decayTracker, injHistory, { reinjectionCooldown: 0, decayEnabled: false });
    assertEqual(cooldownTracker.get(':A'), 4, 'cooldown set to value+1 (compensates for immediate decrement)');
});

test('trackGeneration: no cooldown entries = tracker unchanged', () => {
    const entries = [makeEntry('A', { cooldown: null, vaultSource: '' })];
    const cooldownTracker = new Map();
    trackGeneration(entries, 5, cooldownTracker, new Map(), new Map(), { reinjectionCooldown: 0, decayEnabled: false });
    assert(!cooldownTracker.has(':A'), 'no cooldown set for entry without cooldown');
});

test('trackGeneration: records injection history when reinjectionCooldown > 0', () => {
    const entries = [makeEntry('A', { vaultSource: '' })];
    const injHistory = new Map();
    trackGeneration(entries, 5, new Map(), new Map(), injHistory, { reinjectionCooldown: 3, decayEnabled: false });
    assertEqual(injHistory.get(':A'), 6, 'injection history set to generationCount+1');
});

test('trackGeneration: skips injection history when reinjectionCooldown = 0', () => {
    const entries = [makeEntry('A', { vaultSource: '' })];
    const injHistory = new Map();
    trackGeneration(entries, 5, new Map(), new Map(), injHistory, { reinjectionCooldown: 0, decayEnabled: false });
    assert(!injHistory.has(':A'), 'no history when cooldown disabled');
});

// -- decrementTrackers --

test('decrementTrackers: decrements cooldown counters', () => {
    const cooldownTracker = new Map([['a', 3], ['b', 1]]);
    decrementTrackers(cooldownTracker, new Map(), [], { decayEnabled: false });
    assertEqual(cooldownTracker.get('a'), 2, 'a decremented to 2');
    assert(!cooldownTracker.has('b'), 'b expired and deleted');
});

test('decrementTrackers: decay tracking resets injected entries to 0', () => {
    const entries = [makeEntry('A', { vaultSource: '' })];
    const decayTracker = new Map([[':A', 5]]);
    decrementTrackers(new Map(), decayTracker, entries, { decayEnabled: true, decayBoostThreshold: 5 });
    assertEqual(decayTracker.get(':A'), 0, 'injected entry reset to 0');
});

test('decrementTrackers: decay increments non-injected entries', () => {
    const decayTracker = new Map([[':B', 2]]);
    decrementTrackers(new Map(), decayTracker, [], { decayEnabled: true, decayBoostThreshold: 5 });
    assertEqual(decayTracker.get(':B'), 3, 'non-injected entry incremented');
});

test('decrementTrackers: decay prunes entries past threshold', () => {
    const decayTracker = new Map([[':B', 10]]); // threshold = 5*2=10, 10+1=11 > 10 → pruned
    decrementTrackers(new Map(), decayTracker, [], { decayEnabled: true, decayBoostThreshold: 5 });
    assert(!decayTracker.has(':B'), 'entry at 11 pruned (threshold is 10)');
});

test('decrementTrackers: decay disabled = no changes to decay tracker', () => {
    const decayTracker = new Map([[':A', 5]]);
    decrementTrackers(new Map(), decayTracker, [], { decayEnabled: false });
    assertEqual(decayTracker.get(':A'), 5, 'decay tracker unchanged when disabled');
});

// -- recordAnalytics --

test('recordAnalytics: records matched and injected counts', () => {
    const matched = [makeEntry('A', { vaultSource: '' }), makeEntry('B', { vaultSource: '' })];
    const injected = [makeEntry('A', { vaultSource: '' })];
    const analytics = {};
    recordAnalytics(matched, injected, analytics);
    assertEqual(analytics[':A'].matched, 1, 'A matched once');
    assertEqual(analytics[':A'].injected, 1, 'A injected once');
    assertEqual(analytics[':B'].matched, 1, 'B matched once');
    assertEqual(analytics[':B'].injected, 0, 'B not injected');
});

test('recordAnalytics: increments existing analytics', () => {
    const analytics = { ':A': { matched: 5, injected: 3, lastTriggered: Date.now() - 1000 } };
    recordAnalytics([makeEntry('A', { vaultSource: '' })], [makeEntry('A', { vaultSource: '' })], analytics);
    assertEqual(analytics[':A'].matched, 6, 'matched incremented');
    assertEqual(analytics[':A'].injected, 4, 'injected incremented');
});

test('recordAnalytics: prunes stale entries (>30 days)', () => {
    const staleTime = Date.now() - (31 * 24 * 60 * 60 * 1000);
    const analytics = { ':old': { matched: 1, injected: 0, lastTriggered: staleTime } };
    recordAnalytics([], [], analytics);
    assert(!(':old' in analytics), 'stale entry pruned');
});

test('recordAnalytics: prototype pollution guard', () => {
    const analytics = {};
    const evil = makeEntry('__proto__', { vaultSource: '' });
    recordAnalytics([evil], [], analytics);
    // Object.hasOwn should prevent pollution
    assert(Object.hasOwn(analytics, ':__proto__'), 'analytics has the key via hasOwn');
    assertEqual(typeof analytics[':__proto__']?.matched, 'number', 'value is a normal object');
});

test('recordAnalytics: empty inputs = no changes (except pruning)', () => {
    const analytics = { ':A': { matched: 1, injected: 0, lastTriggered: Date.now() } };
    recordAnalytics([], [], analytics);
    assertEqual(analytics[':A'].matched, 1, 'existing analytics unchanged');
});

// ============================================================================
// Tests: Priority tiebreaker
// ============================================================================

test('priority sort: tiebreaker is alphabetical by title', () => {
    const entries = [
        makeEntry('Zebra', { priority: 50 }),
        makeEntry('Alpha', { priority: 50 }),
        makeEntry('Middle', { priority: 50 }),
    ];
    const sorted = [...entries].sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
    assertEqual(sorted.map(e => e.title), ['Alpha', 'Middle', 'Zebra'], 'same priority → alphabetical order');
});

test('priority sort: lower priority number wins over alphabetical', () => {
    const entries = [
        makeEntry('Zebra', { priority: 10 }),
        makeEntry('Alpha', { priority: 50 }),
    ];
    const sorted = [...entries].sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
    assertEqual(sorted.map(e => e.title), ['Zebra', 'Alpha'], 'priority 10 beats priority 50 regardless of name');
});

// ============================================================================
// Tests: Integration — full pipeline stage sequence
// ============================================================================

test('integration: pinned entry survives all gating stages', () => {
    const vault = [
        makeEntry('A', { priority: 50, era: ['golden'], requires: ['X'] }),
        makeEntry('B', { priority: 80 }),
    ];
    const policy = buildExemptionPolicy(vault, ['A'], []);

    // Stage 1: Pin
    let entries = applyPinBlock([vault[1]], vault, policy, new Map());
    assertEqual(entries.length, 2, 'pinned A added');

    // Stage 2: Contextual gating — no era set, but A has era field
    entries = applyContextualGating(entries, { location: 'tavern' }, policy, false);
    assert(entries.some(e => e.title === 'A'), 'pinned A survives era gating');

    // Stage 3: Cooldown — A was recently injected
    const history = new Map([[':A', 8]]);
    entries = applyReinjectionCooldown(entries, policy, history, 9, 5, false);
    assert(entries.some(e => e.title === 'A'), 'pinned A survives cooldown');

    // Stage 4: Requires/excludes — A requires X which is absent
    const { result } = applyRequiresExcludesGating(entries, policy, false);
    assert(result.some(e => e.title === 'A'), 'pinned A survives requires gating (forceInject)');
});

test('integration: blocked entry removed even if constant', () => {
    const vault = [makeEntry('A', { constant: true }), makeEntry('B')];
    const policy = buildExemptionPolicy(vault, [], ['A']);
    const entries = applyPinBlock([vault[0], vault[1]], vault, policy, new Map());
    assertEqual(entries.length, 1, 'constant A blocked');
    assertEqual(entries[0].title, 'B', 'only B remains');
});

test('integration: non-forceInject entry with era gated when no era set', () => {
    const vault = [makeEntry('A', { era: ['golden'] }), makeEntry('B')];
    const policy = buildExemptionPolicy(vault, [], []);
    let entries = applyPinBlock([vault[0], vault[1]], vault, policy, new Map());
    entries = applyContextualGating(entries, { location: 'tavern' }, policy, false);
    assertEqual(entries.length, 1, 'A gated out (has era but no era active)');
    assertEqual(entries[0].title, 'B', 'B stays');
});

test('integration: constant entry with unmet requires survives (NEW behavior)', () => {
    const vault = [makeEntry('Lore', { constant: true, requires: ['Missing'] })];
    const policy = buildExemptionPolicy(vault, [], []);
    const { result } = applyRequiresExcludesGating(vault, policy, false);
    assertEqual(result.length, 1, 'constant entry survives unmet requires');
    assertEqual(result[0].title, 'Lore', 'Lore kept as forceInject');
});

// ============================================================================
// Results
// ============================================================================

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
