/**
 * DeepLore Enhanced — Librarian Tool Registration & Lifecycle
 * Registers search_lore and flag_lore tools with SillyTavern's ToolManager.
 */
import { ToolManager } from '../../../../../tool-calling.js';
import { getSettings } from '../../settings.js';
import { librarianToolsRegistered, setLibrarianToolsRegistered } from '../state.js';
import { searchLoreAction, flagLoreAction } from './librarian-tools.js';

// ════════════════════════════════════════════════════════════════════════════
// Tool Registration
// ════════════════════════════════════════════════════════════════════════════

/**
 * Register librarian tools with SillyTavern's ToolManager.
 * Safe to call multiple times — will skip if already registered.
 */
export function registerLibrarianTools() {
    if (librarianToolsRegistered) return;
    if (typeof ToolManager?.registerFunctionTool !== 'function') return;

    try {
        ToolManager.registerFunctionTool({
            name: 'dle_search_lore',
            displayName: 'Search Lore Vault',
            description:
                'Search the lore vault for entries not already in your context. '
                + 'Pass an array of up to 4 search queries. For each query, you receive: '
                + '(1) the full content of the best matching entry, and '
                + '(2) a manifest of up to 10 entries linked from that entry, showing their '
                + 'title, size, connections, and summary. '
                + 'Use linked entry summaries to identify characters, places, or concepts '
                + 'connected to your search result.',
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {
                    queries: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Topics, names, or concepts to search for (up to 4)',
                    },
                },
                required: ['queries'],
            },
            action: searchLoreAction,
            formatMessage: () => null,
            shouldRegister: () => {
                const s = getSettings();
                return s.librarianEnabled && s.librarianSearchEnabled
                    && ToolManager.isToolCallingSupported();
            },
        });

        ToolManager.registerFunctionTool({
            name: 'dle_flag_lore',
            displayName: 'Flag Lore Gap',
            description:
                'Flag a gap in the lore vault. Use when you notice the conversation '
                + 'involves a topic that should have a lorebook entry but does not, or when '
                + 'you had to invent details that should be recorded for consistency.',
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'What is missing (character, place, concept)',
                    },
                    reason: {
                        type: 'string',
                        description: 'One sentence: why this matters',
                    },
                    urgency: {
                        type: 'string',
                        enum: ['low', 'medium', 'high'],
                        description: 'low=nice to have, medium=relevant gap, high=invented critical details',
                    },
                },
                required: ['title', 'reason'],
            },
            action: flagLoreAction,
            formatMessage: () => null,
            shouldRegister: () => {
                const s = getSettings();
                return s.librarianEnabled && s.librarianFlagEnabled
                    && ToolManager.isToolCallingSupported();
            },
        });

        setLibrarianToolsRegistered(true);
        console.log('[DLE] Librarian tools registered');
    } catch (err) {
        console.warn('[DLE] Failed to register Librarian tools:', err.message);
    }
}

/**
 * Unregister librarian tools from ToolManager.
 * Safe to call if tools were never registered.
 */
export function unregisterLibrarianTools() {
    if (!librarianToolsRegistered) return;

    try {
        ToolManager.unregisterFunctionTool('dle_search_lore');
        ToolManager.unregisterFunctionTool('dle_flag_lore');
    } catch (err) {
        console.warn('[DLE] Failed to unregister Librarian tools:', err.message);
    }

    setLibrarianToolsRegistered(false);
    console.log('[DLE] Librarian tools unregistered');
}

// ════════════════════════════════════════════════════════════════════════════
// Lifecycle
// ════════════════════════════════════════════════════════════════════════════
