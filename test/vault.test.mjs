/**
 * DeepLore Enhanced — Vault, Multi-Vault, Dedup & Search Tests
 * Run with: node test/vault.test.mjs
 *
 * Covers: detectCrossVaultDuplicates, deduplicateMultiVault, BM25 search,
 *         entity name tracking, vault path/URI utilities, index snapshot/change
 *         detection, and entry clustering.
 */

import {
    assert, assertEqual, assertNotEqual, assertNull, assertNotNull,
    assertGreaterThan, assertLessThan, assertContains,
    test, section, summary, makeEntry, makeSettings,
} from './helpers.mjs';

import {
    detectCrossVaultDuplicates, deduplicateMultiVault,
} from '../src/vault/vault-pure.js';

import { buildBM25Index, queryBM25 } from '../src/vault/bm25.js';

import {
    encodeVaultPath, validateVaultPath, pruneCircuitBreakers,
} from '../src/vault/obsidian-api.js';

import {
    trackerKey, setEntityNameSet, entityNameSet,
    setEntityShortNameRegexes, entityShortNameRegexes,
} from '../src/state.js';

import { buildObsidianURI, clusterEntries } from '../src/helpers.js';

import { takeIndexSnapshot, detectChanges } from '../core/sync.js';

// computeEntityDerivedState rebuilds entity name set + regexes from entries
import { computeEntityDerivedState } from '../src/vault/vault-pure.js';

console.log('DeepLore Enhanced — Vault & Multi-Vault Tests');
console.log('='.repeat(60));

// ============================================================================
//  A. detectCrossVaultDuplicates (12 tests)
// ============================================================================

section('A. detectCrossVaultDuplicates');

test('A1: no duplicates returns empty array', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Elf', { vaultSource: 'v2' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 0, 'no cross-vault dups');
});

test('A2: same title in 2 vaults detected', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Dragon', { vaultSource: 'v2' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 1, 'one dup detected');
    assertEqual(dupes[0].title, 'Dragon', 'title is Dragon');
    assert(dupes[0].vaults.includes('v1'), 'v1 listed');
    assert(dupes[0].vaults.includes('v2'), 'v2 listed');
});

test('A3: same title in 3 vaults detected with all vaults listed', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Dragon', { vaultSource: 'v2' }),
        makeEntry('Dragon', { vaultSource: 'v3' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 1, 'one dup group');
    assertEqual(dupes[0].vaults.length, 3, 'all 3 vaults listed');
    assert(dupes[0].vaults.includes('v3'), 'v3 in vaults');
});

test('A4: case-insensitive detection — "Eris" vs "eris"', () => {
    const entries = [
        makeEntry('Eris', { vaultSource: 'vaultA' }),
        makeEntry('eris', { vaultSource: 'vaultB' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 1, 'case-insensitive dup found');
    assert(dupes[0].vaults.includes('vaultA'), 'vaultA listed');
    assert(dupes[0].vaults.includes('vaultB'), 'vaultB listed');
});

test('A5: different titles produce no duplicate', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Wyvern', { vaultSource: 'v2' }),
    ];
    assertEqual(detectCrossVaultDuplicates(entries).length, 0, 'no dup');
});

test('A6: same vault, same title is NOT a cross-vault duplicate', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Dragon', { vaultSource: 'v1' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 0, 'same vault same title not cross-vault');
});

test('A7: empty entries returns empty', () => {
    assertEqual(detectCrossVaultDuplicates([]).length, 0, 'empty input');
});

test('A8: missing vaultSource defaults to "(unknown)"', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: '' }),
        makeEntry('Dragon', { vaultSource: 'v2' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 1, 'dup detected with unknown vault');
    // vaultSource '' => '(unknown)'
    assert(dupes[0].vaults.includes('(unknown)'), '(unknown) listed for empty vaultSource');
    assert(dupes[0].vaults.includes('v2'), 'v2 listed');
});

test('A9: multiple duplicate titles produce multiple results', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1' }),
        makeEntry('Dragon', { vaultSource: 'v2' }),
        makeEntry('Elf', { vaultSource: 'v1' }),
        makeEntry('Elf', { vaultSource: 'v3' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 2, 'two dup groups');
    const titles = dupes.map(d => d.title.toLowerCase());
    assert(titles.includes('dragon'), 'dragon group found');
    assert(titles.includes('elf'), 'elf group found');
});

test('A10: titles with special characters still detected', () => {
    const entries = [
        makeEntry('"The [Great] Dragon"', { vaultSource: 'v1' }),
        makeEntry('"The [Great] Dragon"', { vaultSource: 'v2' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes.length, 1, 'special char title dup detected');
});

test('A11: single entry returns no duplicates', () => {
    const entries = [makeEntry('Dragon', { vaultSource: 'v1' })];
    assertEqual(detectCrossVaultDuplicates(entries).length, 0, 'single entry no dup');
});

test('A12: display title preserved from first vault seen', () => {
    const entries = [
        makeEntry('Eris', { vaultSource: 'v1' }),
        makeEntry('ERIS', { vaultSource: 'v2' }),
    ];
    const dupes = detectCrossVaultDuplicates(entries);
    assertEqual(dupes[0].title, 'Eris', 'preserves first display title');
});

// ============================================================================
//  B. deduplicateMultiVault — All 4 Modes (26 tests)
// ============================================================================

section('B. deduplicateMultiVault — All 4 Modes');

test('B1: mode "all" returns all entries unchanged', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'a' }),
        makeEntry('Dragon', { vaultSource: 'v2', content: 'b' }),
    ];
    const result = deduplicateMultiVault(entries, 'all');
    assertEqual(result.length, 2, 'all keeps both');
    assertEqual(result[0].content, 'a', 'first unchanged');
    assertEqual(result[1].content, 'b', 'second unchanged');
});

test('B2: null mode returns all (same as "all")', () => {
    const entries = [makeEntry('Dragon'), makeEntry('Dragon')];
    assertEqual(deduplicateMultiVault(entries, null).length, 2, 'null = no dedup');
});

test('B3: undefined mode returns all', () => {
    const entries = [makeEntry('Dragon'), makeEntry('Dragon')];
    assertEqual(deduplicateMultiVault(entries, undefined).length, 2, 'undefined = no dedup');
});

test('B4: empty string mode returns all', () => {
    const entries = [makeEntry('Dragon'), makeEntry('Dragon')];
    assertEqual(deduplicateMultiVault(entries, '').length, 2, 'empty string = no dedup');
});

test('B5: mode "first" keeps first vault copy', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'first content' }),
        makeEntry('Dragon', { vaultSource: 'v2', content: 'second content' }),
    ];
    const result = deduplicateMultiVault(entries, 'first');
    assertEqual(result.length, 1, 'deduped to one');
    assertEqual(result[0].content, 'first content', 'first vault content kept');
    assertEqual(result[0].vaultSource, 'v1', 'first vault source kept');
});

test('B6: mode "first" discards later entry data entirely', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', keys: ['fire'], tags: ['lorebook'] }),
        makeEntry('Dragon', { vaultSource: 'v2', keys: ['ice'], tags: ['lorebook', 'creature'] }),
    ];
    const result = deduplicateMultiVault(entries, 'first');
    assertEqual(result[0].keys.length, 1, 'only first keys');
    assertEqual(result[0].keys[0], 'fire', 'first keys kept');
    assert(!result[0].keys.includes('ice'), 'second keys discarded');
});

test('B7: mode "last" keeps last vault copy', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'first' }),
        makeEntry('Dragon', { vaultSource: 'v2', content: 'second' }),
    ];
    const result = deduplicateMultiVault(entries, 'last');
    assertEqual(result.length, 1, 'deduped to one');
    assertEqual(result[0].content, 'second', 'last vault content kept');
});

test('B8: mode "last" earlier entry data replaced', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', summary: 'old summary' }),
        makeEntry('Dragon', { vaultSource: 'v2', summary: 'new summary' }),
    ];
    const result = deduplicateMultiVault(entries, 'last');
    assertEqual(result[0].summary, 'new summary', 'last vault summary replaces');
});

test('B9: mode "merge" unions array fields (keys, tags, links, requires, excludes)', () => {
    const entries = [
        makeEntry('Dragon', {
            keys: ['fire', 'drake'], tags: ['lorebook'], links: ['Castle'],
            requires: ['Mountain'], excludes: ['Sea'],
        }),
        makeEntry('Dragon', {
            keys: ['drake', 'wyrm'], tags: ['lorebook', 'beast'], links: ['Castle', 'Cave'],
            requires: ['Mountain', 'Volcano'], excludes: ['Sea', 'Ocean'],
        }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result.length, 1, 'merged to one');
    // keys
    assert(result[0].keys.includes('fire'), 'keys: fire');
    assert(result[0].keys.includes('wyrm'), 'keys: wyrm');
    assertEqual(result[0].keys.length, 3, 'keys deduped (fire, drake, wyrm)');
    // tags
    assert(result[0].tags.includes('beast'), 'tags: beast merged');
    // links
    assert(result[0].links.includes('Cave'), 'links: Cave merged');
    assertEqual(result[0].links.length, 2, 'links deduped (Castle, Cave)');
    // requires
    assert(result[0].requires.includes('Volcano'), 'requires: Volcano');
    assertEqual(result[0].requires.length, 2, 'requires deduped');
    // excludes
    assert(result[0].excludes.includes('Ocean'), 'excludes: Ocean');
    assertEqual(result[0].excludes.length, 2, 'excludes deduped');
});

test('B10: mode "merge" concatenates content with separator', () => {
    const entries = [
        makeEntry('Dragon', { content: 'Fire breather.' }),
        makeEntry('Dragon', { content: 'Ice breather.' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assert(result[0].content.includes('Fire breather.'), 'first content present');
    assert(result[0].content.includes('Ice breather.'), 'second content present');
    assert(result[0].content.includes('\n\n---\n\n'), 'separator present');
});

test('B11: mode "merge" recalculates tokenEstimate from merged content', () => {
    const entries = [
        makeEntry('Dragon', { content: 'Short text.', tokenEstimate: 3 }),
        makeEntry('Dragon', { content: 'More text here.', tokenEstimate: 4 }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    const mergedContent = 'Short text.' + '\n\n---\n\n' + 'More text here.';
    const expected = Math.ceil(mergedContent.length / 4.0);
    assertEqual(result[0].tokenEstimate, expected, 'token estimate recalculated');
});

test('B12: mode "merge" summary prefers first non-empty', () => {
    const entries = [
        makeEntry('Dragon', { summary: 'A fierce dragon' }),
        makeEntry('Dragon', { summary: 'A tame dragon' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].summary, 'A fierce dragon', 'first summary kept');
});

test('B13: mode "merge" summary uses second if first empty', () => {
    const entries = [
        makeEntry('Dragon', { summary: '' }),
        makeEntry('Dragon', { summary: 'Fallback summary' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].summary, 'Fallback summary', 'second summary used');
});

test('B14: mode "merge" boolean flags OR-merged (constant, seed, bootstrap, guide)', () => {
    const e1 = makeEntry('Dragon', { constant: false, seed: true, bootstrap: false });
    e1.guide = false;
    const e2 = makeEntry('Dragon', { constant: true, seed: false, bootstrap: true });
    e2.guide = true;
    const result = deduplicateMultiVault([e1, e2], 'merge');
    assert(result[0].constant === true, 'constant OR-merged');
    assert(result[0].seed === true, 'seed OR-merged');
    assert(result[0].bootstrap === true, 'bootstrap OR-merged');
    assert(result[0].guide === true, 'guide OR-merged');
});

test('B15: mode "merge" customFields — arrays unioned', () => {
    const entries = [
        makeEntry('Dragon', { customFields: { era: ['medieval'], location: ['cave'] } }),
        makeEntry('Dragon', { customFields: { era: ['medieval', 'modern'], location: ['mountain'] } }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].customFields.era.length, 2, 'era unioned');
    assert(result[0].customFields.era.includes('modern'), 'era has modern');
    assertEqual(result[0].customFields.location.length, 2, 'location unioned');
    assert(result[0].customFields.location.includes('mountain'), 'location has mountain');
});

test('B16: mode "merge" customFields — scalars: first wins unless null/undefined', () => {
    const entries = [
        makeEntry('Dragon', { customFields: { mood: 'fierce', region: '', count: 0, missing: null } }),
        makeEntry('Dragon', { customFields: { mood: 'calm', region: 'north', count: 42, missing: 'found' } }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].customFields.mood, 'fierce', 'first non-empty scalar kept');
    // Code uses `== null` (null/undefined only), NOT generic falsy — preserves legitimate '' and 0.
    assertEqual(result[0].customFields.region, '', 'empty string preserved (not null)');
    assertEqual(result[0].customFields.count, 0, 'zero preserved (not null)');
    assertEqual(result[0].customFields.missing, 'found', 'null scalar filled from second');
});

test('B17: BUG-378 — _contentHash preserved from first entry (not recomputed)', () => {
    const e1 = makeEntry('Dragon', { content: 'Original' });
    e1._contentHash = 'abc123_original';
    const e2 = makeEntry('Dragon', { content: 'Extra' });
    e2._contentHash = 'def456_extra';
    const result = deduplicateMultiVault([e1, e2], 'merge');
    assertEqual(result[0]._contentHash, 'abc123_original', '_contentHash preserved from first');
    assert(result[0].content.includes('Extra'), 'content still merged');
});

test('B18: mode "merge" 3 entries same title all merged', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['a'], content: 'one', vaultSource: 'v1' }),
        makeEntry('Dragon', { keys: ['b'], content: 'two', vaultSource: 'v2' }),
        makeEntry('Dragon', { keys: ['c'], content: 'three', vaultSource: 'v3' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result.length, 1, 'merged to single entry');
    assertEqual(result[0].keys.length, 3, 'all keys from 3 entries');
    assert(result[0].content.includes('one'), 'first content');
    assert(result[0].content.includes('two'), 'second content');
    assert(result[0].content.includes('three'), 'third content');
});

test('B19: mode "merge" entry with empty content does not double separator', () => {
    const entries = [
        makeEntry('Dragon', { content: 'Real content.' }),
        makeEntry('Dragon', { content: '' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    // Empty content should not trigger concatenation
    assertEqual(result[0].content, 'Real content.', 'empty content not appended');
    assert(!result[0].content.includes('---'), 'no separator for empty content');
});

test('B20: non-duplicate entries unaffected in mode "first"', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'dragon lore' }),
        makeEntry('Elf', { vaultSource: 'v2', content: 'elf lore' }),
    ];
    const result = deduplicateMultiVault(entries, 'first');
    assertEqual(result.length, 2, 'both unique kept');
    assertEqual(result[0].content, 'dragon lore', 'dragon unchanged');
    assertEqual(result[1].content, 'elf lore', 'elf unchanged');
});

test('B21: non-duplicate entries unaffected in mode "merge"', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'dragon lore' }),
        makeEntry('Elf', { vaultSource: 'v2', content: 'elf lore' }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result.length, 2, 'both unique kept in merge mode');
});

test('B22: mixed some duplicated some unique handled correctly', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'v1 dragon' }),
        makeEntry('Elf', { vaultSource: 'v1', content: 'elf' }),
        makeEntry('Dragon', { vaultSource: 'v2', content: 'v2 dragon' }),
        makeEntry('Orc', { vaultSource: 'v2', content: 'orc' }),
    ];
    const result = deduplicateMultiVault(entries, 'first');
    assertEqual(result.length, 3, 'Dragon deduped, Elf+Orc kept');
    const titles = result.map(e => e.title);
    assert(titles.includes('Dragon'), 'Dragon present');
    assert(titles.includes('Elf'), 'Elf present');
    assert(titles.includes('Orc'), 'Orc present');
});

test('B23: mode "merge" does not mutate original entries', () => {
    const e1 = makeEntry('Dragon', { keys: ['fire'], content: 'first' });
    const e2 = makeEntry('Dragon', { keys: ['ice'], content: 'second' });
    const origKeys1 = [...e1.keys];
    const origContent1 = e1.content;
    deduplicateMultiVault([e1, e2], 'merge');
    assertEqual(e1.keys.length, origKeys1.length, 'original keys not mutated');
    assertEqual(e1.content, origContent1, 'original content not mutated');
});

test('B24: mode "merge" resolvedLinks field unioned', () => {
    const entries = [
        makeEntry('Dragon', { resolvedLinks: ['Castle.md'] }),
        makeEntry('Dragon', { resolvedLinks: ['Castle.md', 'Cave.md'] }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].resolvedLinks.length, 2, 'resolvedLinks deduped');
    assert(result[0].resolvedLinks.includes('Cave.md'), 'Cave.md in resolvedLinks');
});

test('B25: mode "merge" customFields new key from second entry added', () => {
    const entries = [
        makeEntry('Dragon', { customFields: { mood: 'fierce' } }),
        makeEntry('Dragon', { customFields: { mood: 'calm', weakness: 'water' } }),
    ];
    const result = deduplicateMultiVault(entries, 'merge');
    assertEqual(result[0].customFields.weakness, 'water', 'new key from second entry');
    assertEqual(result[0].customFields.mood, 'fierce', 'first scalar preserved');
});

test('B26: mode "last" with 3 entries keeps the very last', () => {
    const entries = [
        makeEntry('Dragon', { vaultSource: 'v1', content: 'one' }),
        makeEntry('Dragon', { vaultSource: 'v2', content: 'two' }),
        makeEntry('Dragon', { vaultSource: 'v3', content: 'three' }),
    ];
    const result = deduplicateMultiVault(entries, 'last');
    assertEqual(result.length, 1, 'deduped to one');
    assertEqual(result[0].content, 'three', 'last vault wins');
    assertEqual(result[0].vaultSource, 'v3', 'v3 source');
});

// ============================================================================
//  C. BM25 Search Edge Cases (17 tests)
// ============================================================================

section('C. BM25 Search Edge Cases');

test('C1: buildBM25Index: basic index creation', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire', 'scales'], content: 'A large fire-breathing dragon.' }),
        makeEntry('Elf', { keys: ['forest', 'magic'], content: 'An ancient elf of the forest.' }),
    ];
    const index = buildBM25Index(entries);
    assertNotNull(index, 'index created');
    assertNotNull(index.idf, 'idf map present');
    assertNotNull(index.docs, 'docs map present');
    assertGreaterThan(index.avgDl, 0, 'avgDl > 0');
    assertEqual(index.docs.size, 2, 'two docs indexed');
});

test('C2: buildBM25Index: entries with no content still indexed by title/keys', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire'], content: '' }),
    ];
    const index = buildBM25Index(entries);
    assertEqual(index.docs.size, 1, 'entry indexed');
    // 'dragon' and 'fire' should be in the index
    assert(index.idf.has('dragon'), 'title term in IDF');
    assert(index.idf.has('fire'), 'key term in IDF');
});

test('C3: buildBM25Index: empty entries array returns empty index', () => {
    const index = buildBM25Index([]);
    assertEqual(index.docs.size, 0, 'no docs');
    assertEqual(index.idf.size, 0, 'no IDF terms');
    assertEqual(index.avgDl, 0, 'avgDl is 0');
});

test('C4: queryBM25: exact keyword match produces high score', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire'], content: 'A dragon breathes fire.' }),
        makeEntry('Elf', { keys: ['forest'], content: 'An elf in the forest.' }),
    ];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'dragon fire', 10, 0.1);
    assertGreaterThan(results.length, 0, 'has results');
    assertEqual(results[0].title, 'Dragon', 'Dragon scores highest');
});

test('C5: queryBM25: no match returns empty', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire'], content: 'A dragon.' }),
    ];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'spaceship laser', 10, 0.1);
    assertEqual(results.length, 0, 'no matches');
});

test('C6: queryBM25: multiple matching entries scored and ranked', () => {
    const entries = [
        makeEntry('Fire Dragon', { keys: ['fire', 'dragon'], content: 'A fire dragon with flames.' }),
        makeEntry('Ice Dragon', { keys: ['ice', 'dragon'], content: 'An ice dragon with frost.' }),
        makeEntry('Elf', { keys: ['forest'], content: 'Forest elf.' }),
    ];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'dragon', 10, 0.1);
    assertGreaterThan(results.length, 1, 'multiple dragon matches');
    // Both dragons should score, elf should not
    const titles = results.map(r => r.title);
    assert(titles.includes('Fire Dragon'), 'Fire Dragon matched');
    assert(titles.includes('Ice Dragon'), 'Ice Dragon matched');
});

test('C7: queryBM25: case-insensitive matching', () => {
    const entries = [
        makeEntry('Dragon', { keys: [], content: 'The great DRAGON roars.' }),
    ];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'dragon', 10, 0.1);
    assertGreaterThan(results.length, 0, 'case-insensitive match works');
});

test('C8: queryBM25: multiple query terms score higher for entries with more matches', () => {
    const entries = [
        makeEntry('Fire Dragon', { keys: [], content: 'A fire dragon breathes fire and has scales.' }),
        makeEntry('Dragon Info', { keys: [], content: 'Dragon information page.' }),
    ];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'fire dragon scales', 10, 0.1);
    assertGreaterThan(results.length, 0, 'has results');
    // Fire Dragon matches all 3 terms, Dragon Info matches only 'dragon'
    assertEqual(results[0].title, 'Fire Dragon', 'multi-term match ranked first');
});

test('C9: queryBM25: empty query returns empty', () => {
    const entries = [makeEntry('Dragon', { keys: ['fire'], content: 'A dragon.' })];
    const index = buildBM25Index(entries);
    // Empty query tokenizes to nothing
    const results = queryBM25(index, '', 10, 0.1);
    assertEqual(results.length, 0, 'empty query returns nothing');
});

test('C10: queryBM25: single-character query returns empty (tokenizer filters < 2 chars)', () => {
    const entries = [makeEntry('Dragon', { keys: ['fire'], content: 'A dragon.' })];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'a', 10, 0.1);
    assertEqual(results.length, 0, 'single char query filtered');
});

test('C11: queryBM25: entry with many keyword repetitions has higher TF', () => {
    const entries = [
        makeEntry('Dragon Lore', { keys: [], content: 'dragon dragon dragon dragon dragon lore.' }),
        makeEntry('Dragon Brief', { keys: [], content: 'A brief mention of dragon.' }),
    ];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'dragon', 10, 0.1);
    assertEqual(results[0].title, 'Dragon Lore', 'high TF entry ranked first');
    assertGreaterThan(results[0].score, results[1].score, 'higher score for more occurrences');
});

test('C12: queryBM25: maxResults (topK) limit respected', () => {
    const entries = [];
    for (let i = 0; i < 30; i++) {
        entries.push(makeEntry(`Dragon ${i}`, { keys: ['dragon'], content: `Dragon entry number ${i}.` }));
    }
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'dragon', 5, 0.001);
    assertLessThan(results.length, 6, 'topK limit enforced (max 5)');
    assertGreaterThan(results.length, 0, 'has some results');
});

test('C13: queryBM25: minScore threshold filters low-confidence matches', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire'], content: 'A fire dragon with many words about fire and dragons and scales and caves and treasure and mountains.' }),
        makeEntry('Elf', { keys: ['forest'], content: 'forest elf with leaves and trees and nature.' }),
    ];
    const index = buildBM25Index(entries);
    // Query 'dragon' with very high minScore — may filter some results
    const highThreshold = queryBM25(index, 'dragon', 10, 100.0);
    const lowThreshold = queryBM25(index, 'dragon', 10, 0.01);
    assertGreaterThan(lowThreshold.length, highThreshold.length,
        'higher minScore filters more results (or equal if all score high)');
});

test('C14: queryBM25: special characters in query do not crash', () => {
    const entries = [makeEntry('Dragon', { keys: ['fire'], content: 'A dragon.' })];
    const index = buildBM25Index(entries);
    // These should not throw
    let threw = false;
    try {
        queryBM25(index, '(dragon) [fire] {scales} $$$', 10, 0.1);
        queryBM25(index, 'C++ .NET #hashtag @mention', 10, 0.1);
        queryBM25(index, '***', 10, 0.1);
    } catch {
        threw = true;
    }
    assert(!threw, 'special characters in query did not crash');
});

test('C15: queryBM25: null/undefined index returns empty', () => {
    assertEqual(queryBM25(null, 'dragon').length, 0, 'null index');
    assertEqual(queryBM25(undefined, 'dragon').length, 0, 'undefined index');
});

test('C16: queryBM25: results include entry reference', () => {
    const entries = [makeEntry('Dragon', { keys: ['fire'], content: 'A fire dragon.' })];
    const index = buildBM25Index(entries);
    const results = queryBM25(index, 'dragon fire', 10, 0.1);
    assertGreaterThan(results.length, 0, 'has results');
    assertNotNull(results[0].entry, 'entry reference present');
    assertEqual(results[0].entry.title, 'Dragon', 'entry title matches');
});

test('C17: buildBM25Index: inverted index built for fast lookup', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire'], content: 'dragon fire.' }),
        makeEntry('Elf', { keys: ['forest'], content: 'elf forest.' }),
    ];
    const index = buildBM25Index(entries);
    assertNotNull(index.invertedIndex, 'invertedIndex present');
    assert(index.invertedIndex instanceof Map, 'invertedIndex is a Map');
    assert(index.invertedIndex.has('dragon'), 'dragon in inverted index');
    assert(index.invertedIndex.has('forest'), 'forest in inverted index');
});

// ============================================================================
//  D. Entity Name Tracking (10 tests)
// ============================================================================

section('D. Entity Name Tracking');

test('D1: setEntityNameSet stores names readable via entityNameSet', () => {
    const names = new Set(['dragon', 'elf']);
    setEntityNameSet(names);
    assert(entityNameSet.has('dragon'), 'dragon in set');
    assert(entityNameSet.has('elf'), 'elf in set');
});

test('D2: computeEntityDerivedState: entity names from titles (lowercase)', () => {
    const entries = [makeEntry('Dragon', { keys: [] }), makeEntry('Elf Warrior', { keys: [] })];
    computeEntityDerivedState(entries);
    assert(entityNameSet.has('dragon'), 'title lowercased');
    assert(entityNameSet.has('elf warrior'), 'multi-word title lowercased');
});

test('D3: computeEntityDerivedState: entity names from keys (lowercase, min length 2)', () => {
    const entries = [makeEntry('Test', { keys: ['Fire', 'ICE', 'ab'] })];
    computeEntityDerivedState(entries);
    assert(entityNameSet.has('fire'), 'key lowercased');
    assert(entityNameSet.has('ice'), 'key lowercased');
    assert(entityNameSet.has('ab'), 'two-char key included');
});

test('D4: short title (1 char) included', () => {
    const entries = [makeEntry('X', { keys: [] })];
    computeEntityDerivedState(entries);
    assert(entityNameSet.has('x'), 'single-char title included (>= 1)');
});

test('D5: short key (1 char) excluded (min length 2)', () => {
    const entries = [makeEntry('Test', { keys: ['x', 'ab'] })];
    computeEntityDerivedState(entries);
    assert(!entityNameSet.has('x'), 'single-char key excluded');
    assert(entityNameSet.has('ab'), 'two-char key included');
});

test('D6: entity short name regexes use word boundary matching', () => {
    const entries = [makeEntry('Arch', { keys: [] })];
    computeEntityDerivedState(entries);
    const regex = entityShortNameRegexes.get('arch');
    assertNotNull(regex, 'regex exists for arch');
    assert(regex.test('The Arch stands tall'), 'matches whole word');
    assert(!regex.test('monarchy'), 'does not match inside word');
    assert(!regex.test('architecture'), 'does not match prefix');
});

test('D7: entity regex "an" does not match "want" (word boundary)', () => {
    const entries = [makeEntry('Test', { keys: ['an'] })];
    computeEntityDerivedState(entries);
    const regex = entityShortNameRegexes.get('an');
    assertNotNull(regex, 'regex exists for "an"');
    assert(!regex.test('I want food'), '"an" does not match inside "want"');
    assert(regex.test('Give an apple'), '"an" matches standalone');
});

test('D8: entity regex case-insensitive — "Eris" matches "eris"', () => {
    const entries = [makeEntry('Eris', { keys: [] })];
    computeEntityDerivedState(entries);
    const regex = entityShortNameRegexes.get('eris');
    assertNotNull(regex, 'regex exists');
    assert(regex.test('ERIS is here'), 'case-insensitive match');
    assert(regex.test('eris is here'), 'lowercase match');
    assert(regex.test('Eris is here'), 'title case match');
});

test('D9: entity regex special chars in name are escaped', () => {
    const entries = [makeEntry('C++', { keys: [] })];
    computeEntityDerivedState(entries);
    const regex = entityShortNameRegexes.get('c++');
    assertNotNull(regex, 'regex exists for C++');
    // Should not throw (+ is escaped to \\+)
    let threw = false;
    try { regex.test('I use C++ daily'); } catch { threw = true; }
    assert(!threw, 'regex with special chars does not throw');
});

test('D10: multiple entries accumulate all names', () => {
    const entries = [
        makeEntry('Dragon', { keys: ['fire', 'scales'] }),
        makeEntry('Elf', { keys: ['forest', 'magic'] }),
        makeEntry('Orc', { keys: ['war'] }),
    ];
    computeEntityDerivedState(entries);
    assert(entityNameSet.has('dragon'), 'dragon title');
    assert(entityNameSet.has('elf'), 'elf title');
    assert(entityNameSet.has('orc'), 'orc title');
    assert(entityNameSet.has('fire'), 'dragon key');
    assert(entityNameSet.has('forest'), 'elf key');
    assert(entityNameSet.has('war'), 'orc key');
    assert(entityNameSet.has('scales'), 'dragon key 2');
    assert(entityNameSet.has('magic'), 'elf key 2');
    // Check total count: 3 titles + 5 keys (all >= 2 chars) = 8
    assertEqual(entityNameSet.size, 8, '8 total entity names');
});

// ============================================================================
//  E. Vault Path & URI (12 tests)
// ============================================================================

section('E. Vault Path & URI');

test('E1: encodeVaultPath: basic path passes through', () => {
    assertEqual(encodeVaultPath('Characters/Alice.md'), 'Characters/Alice.md', 'no encoding needed');
});

test('E2: encodeVaultPath: spaces encoded per segment', () => {
    const result = encodeVaultPath('LA World/My Characters/Alice Smith.md');
    assert(result.includes('LA%20World'), 'space encoded in first segment');
    assert(result.includes('Alice%20Smith.md'), 'space encoded in filename');
    assert(result.includes('/'), 'slashes preserved');
});

test('E3: encodeVaultPath: special characters encoded', () => {
    const result = encodeVaultPath('Notes/Dragon & Elf.md');
    assert(result.includes('%26'), 'ampersand encoded');
    assert(!result.includes(' & '), 'original ampersand not present');
});

test('E4: validateVaultPath: valid path passes', () => {
    const result = validateVaultPath('Characters/Alice.md');
    assertEqual(result, 'Characters/Alice.md', 'valid path returned');
});

test('E5: validateVaultPath: backslashes normalized to forward', () => {
    const result = validateVaultPath('Characters\\Alice.md');
    assertEqual(result, 'Characters/Alice.md', 'backslashes normalized');
});

test('E6: validateVaultPath: empty relative path passes', () => {
    const result = validateVaultPath('file.md');
    assertEqual(result, 'file.md', 'simple filename passes');
});

test('E7: validateVaultPath: path traversal (..) throws', () => {
    let threw = false;
    try { validateVaultPath('../etc/passwd'); } catch { threw = true; }
    assert(threw, 'path traversal rejected');
});

test('E8: validateVaultPath: dot segment (.) throws', () => {
    let threw = false;
    try { validateVaultPath('./file.md'); } catch { threw = true; }
    assert(threw, 'dot segment rejected');
});

test('E9: validateVaultPath: absolute path throws', () => {
    let threw = false;
    try { validateVaultPath('/etc/passwd'); } catch { threw = true; }
    assert(threw, 'absolute path rejected');
});

test('E10: buildObsidianURI: constructs correct URI', () => {
    const uri = buildObsidianURI('MyVault', 'Characters/Alice.md');
    assertEqual(uri, 'obsidian://open?vault=MyVault&file=Characters/Alice', 'correct URI');
});

test('E11: buildObsidianURI: with vault name containing spaces', () => {
    const uri = buildObsidianURI('My Vault', 'Alice.md');
    assert(uri.includes('vault=My%20Vault'), 'vault name encoded');
    assert(uri.includes('file=Alice'), 'file path present');
});

test('E12: buildObsidianURI: no vault name returns null', () => {
    assertNull(buildObsidianURI('', 'Alice.md'), 'empty vault name returns null');
    assertNull(buildObsidianURI(null, 'Alice.md'), 'null vault name returns null');
    assertNull(buildObsidianURI(undefined, 'Alice.md'), 'undefined vault name returns null');
});

// ============================================================================
//  F. Index Snapshot & Change Detection (12 tests)
// ============================================================================

section('F. Index Snapshot & Change Detection');

test('F1: takeIndexSnapshot: creates snapshot with contentHash, title, keys', () => {
    const entries = [
        makeEntry('Dragon', { content: 'Fire.', keys: ['fire'], filename: 'Dragon.md' }),
    ];
    const snap = takeIndexSnapshot(entries);
    assertNotNull(snap.contentHashes, 'contentHashes map present');
    assertNotNull(snap.titleMap, 'titleMap present');
    assertNotNull(snap.keyMap, 'keyMap present');
    assertNotNull(snap.timestamp, 'timestamp present');
    assert(snap.contentHashes.has('Dragon.md'), 'entry tracked by filename');
    assertEqual(snap.titleMap.get('Dragon.md'), 'Dragon', 'title mapped');
});

test('F2: takeIndexSnapshot: empty array creates empty snapshot', () => {
    const snap = takeIndexSnapshot([]);
    assertEqual(snap.contentHashes.size, 0, 'no content hashes');
    assertEqual(snap.titleMap.size, 0, 'no titles');
    assertEqual(snap.keyMap.size, 0, 'no keys');
});

test('F3: detectChanges: no changes between identical snapshots', () => {
    const entries = [makeEntry('Dragon', { content: 'Fire.', keys: ['fire'], filename: 'Dragon.md' })];
    const snap1 = takeIndexSnapshot(entries);
    const snap2 = takeIndexSnapshot(entries);
    const changes = detectChanges(snap1, snap2);
    assertEqual(changes.added.length, 0, 'no added');
    assertEqual(changes.removed.length, 0, 'no removed');
    assertEqual(changes.modified.length, 0, 'no modified');
    assertEqual(changes.keysChanged.length, 0, 'no key changes');
    assert(!changes.hasChanges, 'hasChanges is false');
});

test('F4: detectChanges: new entry detected as added', () => {
    const entries1 = [makeEntry('Dragon', { content: 'Fire.', filename: 'Dragon.md' })];
    const entries2 = [
        makeEntry('Dragon', { content: 'Fire.', filename: 'Dragon.md' }),
        makeEntry('Elf', { content: 'Forest.', filename: 'Elf.md' }),
    ];
    const snap1 = takeIndexSnapshot(entries1);
    const snap2 = takeIndexSnapshot(entries2);
    const changes = detectChanges(snap1, snap2);
    assertEqual(changes.added.length, 1, 'one added');
    assertEqual(changes.added[0], 'Elf', 'Elf added');
    assert(changes.hasChanges, 'hasChanges is true');
});

test('F5: detectChanges: removed entry detected', () => {
    const entries1 = [
        makeEntry('Dragon', { content: 'Fire.', filename: 'Dragon.md' }),
        makeEntry('Elf', { content: 'Forest.', filename: 'Elf.md' }),
    ];
    const entries2 = [makeEntry('Dragon', { content: 'Fire.', filename: 'Dragon.md' })];
    const snap1 = takeIndexSnapshot(entries1);
    const snap2 = takeIndexSnapshot(entries2);
    const changes = detectChanges(snap1, snap2);
    assertEqual(changes.removed.length, 1, 'one removed');
    assertEqual(changes.removed[0], 'Elf', 'Elf removed');
    assert(changes.hasChanges, 'hasChanges is true');
});

test('F6: detectChanges: modified content detected via different hash', () => {
    const entries1 = [makeEntry('Dragon', { content: 'Fire.', filename: 'Dragon.md' })];
    const entries2 = [makeEntry('Dragon', { content: 'Ice and Fire.', filename: 'Dragon.md' })];
    const snap1 = takeIndexSnapshot(entries1);
    const snap2 = takeIndexSnapshot(entries2);
    const changes = detectChanges(snap1, snap2);
    assertEqual(changes.modified.length, 1, 'one modified');
    assertEqual(changes.modified[0], 'Dragon', 'Dragon modified');
    assert(changes.hasChanges, 'hasChanges is true');
});

test('F7: detectChanges: key changes detected', () => {
    const entries1 = [makeEntry('Dragon', { content: 'Fire.', keys: ['fire'], filename: 'Dragon.md' })];
    const entries2 = [makeEntry('Dragon', { content: 'Fire.', keys: ['fire', 'dragon'], filename: 'Dragon.md' })];
    const snap1 = takeIndexSnapshot(entries1);
    const snap2 = takeIndexSnapshot(entries2);
    const changes = detectChanges(snap1, snap2);
    // Content is same, but keys changed
    assertEqual(changes.modified.length, 0, 'content not modified');
    assertEqual(changes.keysChanged.length, 1, 'one key change');
    assertEqual(changes.keysChanged[0], 'Dragon', 'Dragon keys changed');
    assert(changes.hasChanges, 'hasChanges is true');
});

test('F8: detectChanges: null old snapshot returns empty changes (no crash)', () => {
    const entries = [makeEntry('Dragon', { content: 'Fire.', filename: 'Dragon.md' })];
    const snap = takeIndexSnapshot(entries);
    const changes = detectChanges(null, snap);
    // With null old snapshot, the function returns early with empty changes
    assertEqual(changes.added.length, 0, 'no added (null old)');
    assertEqual(changes.removed.length, 0, 'no removed (null old)');
    assert(!changes.hasChanges, 'hasChanges is false (null old)');
});

test('F9: detectChanges: multiple simultaneous changes', () => {
    const entries1 = [
        makeEntry('Dragon', { content: 'Fire.', keys: ['fire'], filename: 'Dragon.md' }),
        makeEntry('Elf', { content: 'Forest.', keys: ['forest'], filename: 'Elf.md' }),
        makeEntry('Orc', { content: 'War.', keys: ['war'], filename: 'Orc.md' }),
    ];
    const entries2 = [
        makeEntry('Dragon', { content: 'Ice!', keys: ['fire'], filename: 'Dragon.md' }),
        // Elf removed
        makeEntry('Orc', { content: 'War.', keys: ['war'], filename: 'Orc.md' }),
        makeEntry('Dwarf', { content: 'Mine.', keys: ['mine'], filename: 'Dwarf.md' }),
    ];
    const snap1 = takeIndexSnapshot(entries1);
    const snap2 = takeIndexSnapshot(entries2);
    const changes = detectChanges(snap1, snap2);
    assertEqual(changes.added.length, 1, 'Dwarf added');
    assertEqual(changes.removed.length, 1, 'Elf removed');
    assertEqual(changes.modified.length, 1, 'Dragon modified');
    assert(changes.hasChanges, 'hasChanges true');
});

test('F10: takeIndexSnapshot: entries tracked by filename not title', () => {
    const entries = [
        makeEntry('Dragon', { content: 'Fire.', filename: 'Lore/Dragon.md' }),
        makeEntry('Dragon Alt', { content: 'Ice.', filename: 'Lore/DragonAlt.md' }),
    ];
    const snap = takeIndexSnapshot(entries);
    assertEqual(snap.contentHashes.size, 2, 'two separate entries');
    assert(snap.contentHashes.has('Lore/Dragon.md'), 'tracked by filename path');
    assert(snap.contentHashes.has('Lore/DragonAlt.md'), 'second tracked by filename path');
});

test('F11: detectChanges: content+keys both changed counts as modified (not double-counted)', () => {
    const entries1 = [makeEntry('Dragon', { content: 'Old.', keys: ['fire'], filename: 'Dragon.md' })];
    const entries2 = [makeEntry('Dragon', { content: 'New.', keys: ['fire', 'ice'], filename: 'Dragon.md' })];
    const snap1 = takeIndexSnapshot(entries1);
    const snap2 = takeIndexSnapshot(entries2);
    const changes = detectChanges(snap1, snap2);
    assertEqual(changes.modified.length, 1, 'in modified');
    assertEqual(changes.keysChanged.length, 0, 'not in keysChanged (already in modified)');
});

test('F12: takeIndexSnapshot: keys serialized as JSON for comparison', () => {
    const entries = [makeEntry('Dragon', { keys: ['fire', 'ice'], filename: 'Dragon.md' })];
    const snap = takeIndexSnapshot(entries);
    assertEqual(snap.keyMap.get('Dragon.md'), JSON.stringify(['fire', 'ice']), 'keys JSON-serialized');
});

// ============================================================================
//  G. Clustering (7 tests)
// ============================================================================

section('G. Clustering');

test('G1: clusterEntries: groups by first non-infrastructure tag', () => {
    const entries = [
        makeEntry('Dragon', { tags: ['lorebook', 'creature'] }),
        makeEntry('Elf', { tags: ['lorebook', 'creature'] }),
        makeEntry('Castle', { tags: ['lorebook', 'location'] }),
    ];
    const clusters = clusterEntries(entries);
    assert(clusters.has('creature'), 'creature cluster exists');
    assert(clusters.has('location'), 'location cluster exists');
    assertEqual(clusters.get('creature').length, 2, 'two entries in creature');
    assertEqual(clusters.get('location').length, 1, 'one entry in location');
});

test('G2: clusterEntries: empty entries returns empty clusters', () => {
    const clusters = clusterEntries([]);
    assertEqual(clusters.size, 0, 'no clusters');
});

test('G3: clusterEntries: single entry creates single cluster', () => {
    const entries = [makeEntry('Dragon', { tags: ['lorebook', 'monster'] })];
    const clusters = clusterEntries(entries);
    assertEqual(clusters.size, 1, 'one cluster');
    assert(clusters.has('monster'), 'cluster named monster');
});

test('G4: clusterEntries: entries with no non-infra tags go to Uncategorized', () => {
    const entries = [
        makeEntry('Dragon', { tags: ['lorebook'], filename: 'Dragon.md' }),
    ];
    const clusters = clusterEntries(entries);
    // No non-infra tag, no folder in filename => 'Uncategorized'
    assert(clusters.has('Uncategorized'), 'Uncategorized cluster');
});

test('G5: clusterEntries: entries with no tags go to Uncategorized', () => {
    const entries = [makeEntry('Dragon', { tags: [] })];
    const clusters = clusterEntries(entries);
    assert(clusters.has('Uncategorized'), 'Uncategorized for empty tags');
});

test('G6: clusterEntries: infra-only tags fall back to folder from filename', () => {
    const entries = [
        makeEntry('Dragon', { tags: ['lorebook', 'lorebook-always'], filename: 'Creatures/Dragon.md' }),
    ];
    const clusters = clusterEntries(entries);
    assert(clusters.has('Creatures'), 'folder fallback used');
    assert(!clusters.has('Uncategorized'), 'not in Uncategorized');
});

test('G7: clusterEntries: multiple different tags create separate clusters', () => {
    const entries = [
        makeEntry('Dragon', { tags: ['lorebook', 'creature'] }),
        makeEntry('Fireball', { tags: ['lorebook', 'spell'] }),
        makeEntry('Castle', { tags: ['lorebook', 'location'] }),
        makeEntry('Elf', { tags: ['lorebook', 'creature'] }),
    ];
    const clusters = clusterEntries(entries);
    assertEqual(clusters.size, 3, 'three clusters: creature, spell, location');
    assertEqual(clusters.get('creature').length, 2, 'two creatures');
    assertEqual(clusters.get('spell').length, 1, 'one spell');
    assertEqual(clusters.get('location').length, 1, 'one location');
});

// ============================================================================
//  H. trackerKey (3 tests — complements state.js tests in unit.mjs)
// ============================================================================

section('H. trackerKey');

test('H1: trackerKey combines vaultSource and title', () => {
    assertEqual(trackerKey({ title: 'Dragon', vaultSource: 'main' }), 'main:Dragon', 'correct key');
});

test('H2: trackerKey with no vaultSource', () => {
    assertEqual(trackerKey({ title: 'Dragon', vaultSource: '' }), ':Dragon', 'empty vault');
    assertEqual(trackerKey({ title: 'Dragon' }), ':Dragon', 'undefined vault falls back to empty string');
});

test('H3: trackerKey uniqueness across vaults', () => {
    const key1 = trackerKey({ title: 'Dragon', vaultSource: 'v1' });
    const key2 = trackerKey({ title: 'Dragon', vaultSource: 'v2' });
    assertNotEqual(key1, key2, 'different vaults produce different keys');
});

// ============================================================================
//  I. pruneCircuitBreakers (4 tests)
// ============================================================================

section('I. pruneCircuitBreakers');

test('I1: pruneCircuitBreakers is callable without error', () => {
    // pruneCircuitBreakers operates on module-level Map; we can at least call it safely
    let threw = false;
    try {
        pruneCircuitBreakers(new Set(['127.0.0.1:27123']));
    } catch {
        threw = true;
    }
    assert(!threw, 'pruneCircuitBreakers does not throw');
});

test('I2: pruneCircuitBreakers with empty active set clears all', () => {
    // We can't directly inspect the internal Map, but calling with empty set should not crash
    let threw = false;
    try {
        pruneCircuitBreakers(new Set());
    } catch {
        threw = true;
    }
    assert(!threw, 'empty active set does not crash');
});

test('I3: pruneCircuitBreakers accepts Set of host:port strings', () => {
    let threw = false;
    try {
        pruneCircuitBreakers(new Set(['127.0.0.1:27123', '192.168.1.5:27124']));
    } catch {
        threw = true;
    }
    assert(!threw, 'multiple active keys accepted');
});

test('I4: encodeVaultPath: slash-separated segments encoded independently', () => {
    const result = encodeVaultPath('A B/C D/E F.md');
    // Each segment encoded separately, slashes preserved
    assertEqual(result, 'A%20B/C%20D/E%20F.md', 'segments encoded independently');
});

// ============================================================================
// Summary
// ============================================================================

summary('Vault & Multi-Vault Tests');
