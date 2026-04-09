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
 *
 * Toggle-driven registration: we register once at boot if enabled, unregister on
 * toggle-off, and re-register on toggle-on (see settings-ui.js librarian toggle
 * handler). The `shouldRegister` closures are belt-and-suspenders gates against
 * race conditions between toggle and in-flight generations.
 *
 * Default for `librarianEnabled` is false — fresh installs must opt in from the
 * Librarian tab so we never attach tool definitions to generations before the
 * user has seen the UI.
 */
export function registerLibrarianTools() {
    if (!getSettings().librarianEnabled) return;
    if (typeof ToolManager?.registerFunctionTool !== 'function') return;

    // BUG-086: re-verify tools actually exist in ToolManager every call. Another
    // extension or an HMR cycle may have rebuilt ToolManager's internal #tools
    // map; the local `librarianToolsRegistered` flag would still be true, leaving
    // our tools silently absent. If either tool is missing, force re-registration.
    try {
        const present = Array.isArray(ToolManager.tools) ? ToolManager.tools : [];
        const have = new Set(present.map(t => t?.name).filter(Boolean));
        const ok = have.has('dle_search_lore') && have.has('dle_flag_lore');
        if (librarianToolsRegistered && ok) return;
        if (librarianToolsRegistered && !ok) {
            console.warn('[DLE] Librarian tools missing from ToolManager — re-asserting registration');
            setLibrarianToolsRegistered(false);
        }
    } catch { /* ToolManager.tools getter unavailable — fall through to register */ }
    if (librarianToolsRegistered) return;

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

        // Force-enable function calling on the user's chat completion profile.
        // ST gates tool sending behind oai_settings.function_calling — without this,
        // registered tools are silently dropped from outbound requests.
        ensureFunctionCallingEnabled();
    } catch (err) {
        console.warn('[DLE] Failed to register Librarian tools:', err.message);
    }
}

/**
 * Ensure ST's chat-completion profile has Function Calling enabled.
 * Librarian is opt-in, so the user has already consented to tool use by enabling it.
 */
export function ensureFunctionCallingEnabled() {
    try {
        // Lazy import — openai.js is heavy and only needed once at registration
        import('../../../../../openai.js').then(({ oai_settings, saveSettingsDebounced }) => {
            if (!oai_settings) return;
            if (oai_settings.function_calling === true) return; // already on
            oai_settings.function_calling = true;
            // Sync the visible checkbox if the panel is rendered
            const cb = document.getElementById('openai_function_calling');
            if (cb instanceof HTMLInputElement) cb.checked = true;
            try { saveSettingsDebounced?.(); } catch { /* non-fatal */ }
            try {
                if (typeof toastr !== 'undefined') {
                    toastr.info('DLE Librarian enabled Function Calling on your connection profile.', 'DeepLore Enhanced', { timeOut: 6000 });
                }
            } catch { /* non-fatal */ }
            console.log('[DLE] Auto-enabled oai_settings.function_calling for Librarian');
        }).catch(err => {
            console.warn('[DLE] Could not auto-enable function calling:', err?.message);
        });
    } catch (err) {
        console.warn('[DLE] ensureFunctionCallingEnabled error:', err?.message);
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
