/**
 * DeepLore Enhanced — Settings module
 * Default settings, constraints, getSettings(), getPrimaryVault(), getVaultByName()
 */
import {
    extension_settings,
} from '../../../extensions.js';
import { validateSettings } from './core/utils.js';

export const MODULE_NAME = 'deeplore_enhanced';
export const PROMPT_TAG = 'deeplore_enhanced';
export const PROMPT_TAG_PREFIX = 'deeplore_';

export const DEFAULT_AI_SYSTEM_PROMPT = `You are Claude Code. You are a lore librarian for a roleplay session. Given recent chat messages and a manifest of lore entries, select which entries are most relevant to inject into the current conversation context.

You may select up to {{maxEntries}} entries. Select fewer if not all are relevant.

Each entry in the manifest is formatted as:
  EntryName (Ntok) → LinkedEntry1, LinkedEntry2
  Description text. May include structured metadata in [brackets] with fields like Triggers, Related, Who Knows, Category.

Selection criteria (in order of importance):
1. Direct references - Characters, places, items, or events explicitly mentioned
2. Active context - Entries about the current location, present characters, or ongoing events
3. Relationship chains - The → arrow shows linked entries; if entry A is relevant, consider linked entries too
4. Metadata triggers - If an entry's [Triggers: ...] field matches what's happening in the conversation, select it
5. Thematic relevance - Entries matching the tone or themes (betrayal, romance, combat, etc.)

Guidelines:
- Focus on what is relevant RIGHT NOW in the conversation
- Prefer fewer, highly relevant entries over many loosely related ones
- Consider the token cost (Ntok) shown for each entry when making selections
- Use [Related: ...] and → links to find connected lore

Respond with a JSON array of objects. Each object has:
- "title": exact entry name from the manifest
- "confidence": "high", "medium", or "low"
- "reason": brief phrase explaining why

Example: [{"title": "Eris", "confidence": "high", "reason": "directly mentioned by name"}, {"title": "The Dark Council", "confidence": "medium", "reason": "linked from Eris, thematically relevant"}]
If no entries are relevant, respond with: []`;

export const defaultSettings = {
    enabled: false,
    obsidianPort: 27123,
    obsidianApiKey: '',
    lorebookTag: 'lorebook',
    constantTag: 'lorebook-always',
    neverInsertTag: 'lorebook-never',
    seedTag: 'lorebook-seed',
    bootstrapTag: 'lorebook-bootstrap',
    newChatThreshold: 3,
    scanDepth: 4,
    maxEntries: 10,
    unlimitedEntries: false,
    maxTokensBudget: 2048,
    unlimitedBudget: false,
    injectionMode: 'extension', // 'extension' (current) or 'prompt_list' (PM integration)
    injectionPosition: 1,   // extension_prompt_types.IN_CHAT
    injectionDepth: 4,
    injectionRole: 0,        // extension_prompt_roles.SYSTEM
    injectionTemplate: '<{{title}}>\n{{content}}\n</{{title}}>',
    allowWIScan: false,
    recursiveScan: false,
    maxRecursionSteps: 3,
    matchWholeWords: false,
    caseSensitive: false,
    cacheTTL: 300,
    reviewResponseTokens: 0,
    debugMode: false,
    // AI Notebook settings
    notebookEnabled: false,
    notebookPosition: 1,   // in_chat
    notebookDepth: 4,
    notebookRole: 0,        // system
    // AI Search settings
    aiSearchEnabled: false,
    aiSearchConnectionMode: 'profile',
    aiSearchProfileId: '',
    aiSearchProxyUrl: 'http://localhost:42069',
    aiSearchModel: '',
    aiSearchMaxTokens: 1024,
    aiSearchTimeout: 10000,
    aiSearchMode: 'two-stage',
    aiSearchScanDepth: 4,
    aiSearchSystemPrompt: '',
    aiSearchManifestSummaryLength: 600,
    aiSearchClaudeCodePrefix: true,
    scribeInformedRetrieval: false, // Feed Scribe session summary into AI search context
    // Context Cartographer settings
    showLoreSources: true,
    // Session Scribe settings
    scribeEnabled: false,
    scribeInterval: 5,
    scribeFolder: 'Sessions',
    scribePrompt: '',
    scribeConnectionMode: 'st',
    scribeProfileId: '',
    scribeProxyUrl: 'http://localhost:42069',
    scribeModel: '',
    scribeMaxTokens: 1024,
    scribeTimeout: 30000,
    scribeScanDepth: 20,
    // Vault Sync settings
    syncPollingInterval: 0,
    showSyncToasts: true,
    // Chat History Tracking
    reinjectionCooldown: 0,
    // Auto Lorebook Creation
    autoSuggestEnabled: false,
    autoSuggestInterval: 10,
    autoSuggestConnectionMode: 'st',
    autoSuggestProfileId: '',
    autoSuggestProxyUrl: 'http://localhost:42069',
    autoSuggestModel: '',
    autoSuggestMaxTokens: 2048,
    autoSuggestTimeout: 30000,
    autoSuggestFolder: '',
    // Injection Deduplication
    stripDuplicateInjections: false,
    stripLookbackDepth: 2,
    // Optimize Keys
    optimizeKeysMode: 'keyword-only',
    // Matching extras
    characterContextScan: false,
    // Multi-Vault
    vaults: [],
    // UI State
    advancedVisible: {},
    // Entry Decay & Freshness
    decayEnabled: false,
    decayBoostThreshold: 5,    // Generations without injection before freshness boost
    decayPenaltyThreshold: 2,  // Consecutive injections before frequency penalty
    // Analytics
    analyticsData: {},
    // Settings version — increment to trigger migrations
    settingsVersion: 1,
};

/**
 * Run settings migrations between versions.
 * Each migration handles the transition from one version to the next.
 */
function runMigrations(settings, fromVersion, toVersion) {
    // Migration 0 → 1: initial versioned settings (no-op, just sets version)
    if (fromVersion < 1) {
        console.log('[DLE] Migrating settings to version 1');
    }
    // Future migrations go here:
    // if (fromVersion < 2) { ... }
}

/** Validation constraints for numeric settings */
export const settingsConstraints = {
    obsidianPort: { min: 1, max: 65535 },
    scanDepth: { min: 0, max: 100 },
    maxEntries: { min: 1, max: 100 },
    maxTokensBudget: { min: 100, max: 100000 },
    injectionDepth: { min: 0, max: 9999 },
    notebookDepth: { min: 0, max: 9999 },
    maxRecursionSteps: { min: 1, max: 10 },
    cacheTTL: { min: 0, max: 86400 },
    reviewResponseTokens: { min: 0, max: 100000 },
    aiSearchMaxTokens: { min: 64, max: 4096 },
    aiSearchTimeout: { min: 1000, max: 30000 },
    aiSearchScanDepth: { min: 1, max: 100 },
    aiSearchManifestSummaryLength: { min: 100, max: 1000 },
    scribeInterval: { min: 1, max: 50 },
    scribeMaxTokens: { min: 256, max: 4096 },
    scribeTimeout: { min: 5000, max: 60000 },
    scribeScanDepth: { min: 5, max: 100 },
    newChatThreshold: { min: 1, max: 20 },
    syncPollingInterval: { min: 0, max: 3600 },
    reinjectionCooldown: { min: 0, max: 50 },
    stripLookbackDepth: { min: 1, max: 10 },
    autoSuggestInterval: { min: 3, max: 50 },
    autoSuggestMaxTokens: { min: 256, max: 4096 },
    autoSuggestTimeout: { min: 5000, max: 60000 },
    decayBoostThreshold: { min: 2, max: 20 },
    decayPenaltyThreshold: { min: 2, max: 10 },
};

/** @returns {typeof defaultSettings} */
export function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    // Fill in any missing defaults
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = (typeof value === 'object' && value !== null)
                ? JSON.parse(JSON.stringify(value))
                : value;
        }
    }
    validateSettings(extension_settings[MODULE_NAME], settingsConstraints);

    const s = extension_settings[MODULE_NAME];

    // Run migrations if settings version is behind
    const currentVersion = defaultSettings.settingsVersion;
    const storedVersion = s.settingsVersion || 0;
    if (storedVersion < currentVersion) {
        runMigrations(s, storedVersion, currentVersion);
        s.settingsVersion = currentVersion;
    }

    // Multi-vault migration: if vaults[] is empty but legacy obsidianPort exists, migrate
    if ((!Array.isArray(s.vaults) || s.vaults.length === 0) && s.obsidianPort) {
        s.vaults = [{
            name: 'Primary',
            port: s.obsidianPort,
            apiKey: s.obsidianApiKey || '',
            enabled: true,
        }];
    }

    return s;
}

/**
 * Get the first enabled vault connection, or a safe default.
 * @param {typeof defaultSettings} [settings] - Settings object (defaults to getSettings())
 * @returns {{ name: string, port: number, apiKey: string, enabled: boolean }}
 */
export function getPrimaryVault(settings) {
    const s = settings || getSettings();
    return (s.vaults && s.vaults.find(v => v.enabled)) || s.vaults?.[0] || { name: 'Default', port: 27123, apiKey: '', enabled: true };
}

/**
 * Find the vault connection for a given entry (by vaultSource name), falling back to primary.
 * @param {typeof defaultSettings} settings
 * @param {string} vaultName
 * @returns {{ name: string, port: number, apiKey: string, enabled: boolean }}
 */
export function getVaultByName(settings, vaultName) {
    if (vaultName && settings.vaults) {
        const match = settings.vaults.find(v => v.name === vaultName && v.enabled);
        if (match) return match;
    }
    return getPrimaryVault(settings);
}
