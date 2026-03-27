/**
 * DeepLore Enhanced — Shared Test Utilities
 * Common assertion helpers, factories, and runner used by both unit and integration tests.
 */

// ============================================================================
// Test Runner
// ============================================================================

export let passed = 0;
export let failed = 0;

export function resetCounters() {
    passed = 0;
    failed = 0;
}

export function assert(condition, message) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
    }
}

export function assertEqual(actual, expected, message) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    expected: ${JSON.stringify(expected)}`);
        console.error(`    actual:   ${JSON.stringify(actual)}`);
    }
}

export function assertNotEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        passed++;
    } else {
        failed++;
        console.error(`  FAIL: ${message}`);
        console.error(`    should not equal: ${JSON.stringify(expected)}`);
    }
}

export function assertThrows(fn, message) {
    try {
        fn();
        failed++;
        console.error(`  FAIL: ${message} (did not throw)`);
    } catch {
        passed++;
    }
}

export function test(name, fn) {
    console.log(`\n${name}`);
    fn();
}

export async function testAsync(name, fn) {
    console.log(`\n${name}`);
    await fn();
}

// ============================================================================
// Factories
// ============================================================================

/**
 * Create a VaultEntry with sensible defaults. Override any field via opts.
 * @param {string} title
 * @param {object} [opts]
 * @returns {object} VaultEntry-shaped object
 */
export function makeEntry(title, opts = {}) {
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
        enabled: opts.enabled !== false,
    };
}

/**
 * Create a settings object with sensible defaults. Override any field via overrides.
 * @param {object} [overrides]
 * @returns {object} Settings-shaped object
 */
export function makeSettings(overrides = {}) {
    return {
        enabled: true,
        lorebookTag: 'lorebook',
        constantTag: 'lorebook-always',
        neverInsertTag: 'lorebook-never',
        seedTag: 'lorebook-seed',
        bootstrapTag: 'lorebook-bootstrap',
        scanDepth: 5,
        maxEntries: 20,
        unlimitedEntries: false,
        maxTokensBudget: 2000,
        unlimitedBudget: false,
        injectionPosition: 1,
        injectionDepth: 4,
        injectionRole: 'system',
        injectionTemplate: '<{{title}}>\n{{content}}\n</{{title}}>',
        injectionMode: 'extension',
        allowWIScan: false,
        recursiveScan: false,
        maxRecursionSteps: 3,
        matchWholeWords: false,
        caseSensitive: false,
        characterContextScan: false,
        aiSearchEnabled: false,
        aiSearchMode: 'two-stage',
        stripDuplicateInjections: false,
        stripLookbackDepth: 3,
        reinjectionCooldown: 0,
        debugMode: false,
        decayEnabled: false,
        decayBoostThreshold: 5,
        decayPenaltyThreshold: 10,
        analyticsData: {},
        vaults: [{ name: 'Test', port: 27123, apiKey: 'test', enabled: true }],
        contextualGatingTolerance: 'strict',
        ...overrides,
    };
}
