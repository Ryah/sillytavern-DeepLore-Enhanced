/**
 * DeepLore Enhanced — Session Scribe
 */
import {
    generateQuietPrompt,
    saveChatDebounced,
    chat,
    chat_metadata,
    name2,
} from '../../../../../script.js';
import { getSettings, getPrimaryVault } from '../settings.js';
import { writeNote } from './obsidian-api.js';
import { callProxyViaCorsBridge } from './proxy-api.js';
import { buildAiChatContext } from '../core/utils.js';
import { callViaProfile } from './ai.js';
import {
    scribeInProgress, lastScribeSummary, lastScribeChatLength,
    setScribeInProgress, setLastScribeSummary, setLastScribeChatLength,
} from './state.js';

export const DEFAULT_SCRIBE_PROMPT = `Summarize this roleplay session segment. Write in past tense, third person.

Cover:
- Key events and plot developments (what happened, decisions made, consequences)
- Character dynamics (relationship shifts, emotional moments, conflicts, alliances)
- New information revealed (world-building, backstory, secrets, lore)
- State changes (injuries, location moves, items gained/lost, powers used)

If a previous session note is provided, do NOT repeat what it already covers — only add new developments since then.

Format with markdown headings and bullet points. Be specific — use character names and concrete details, not vague summaries.`;

/**
 * Route a Scribe AI call based on the configured connection mode.
 * @param {string} systemPrompt - System prompt text
 * @param {string} userMessage - User message content (chat context + instructions)
 * @param {typeof import('../settings.js').defaultSettings} settings - Current settings
 * @returns {Promise<string>} Generated summary text
 */
export async function callScribe(systemPrompt, userMessage, settings) {
    const mode = settings.scribeConnectionMode || 'st';

    if (mode === 'profile') {
        const result = await callViaProfile(
            systemPrompt,
            userMessage,
            settings.scribeMaxTokens,
            settings.scribeTimeout,
            settings.scribeProfileId,
            settings.scribeModel,
        );
        return result.text || '';
    }

    if (mode === 'proxy') {
        const result = await callProxyViaCorsBridge(
            settings.scribeProxyUrl,
            settings.scribeModel || 'claude-haiku-4-5-20251001',
            systemPrompt,
            userMessage,
            settings.scribeMaxTokens,
            settings.scribeTimeout,
        );
        return result.text || '';
    }

    // Default: 'st' mode — use SillyTavern's active connection via generateQuietPrompt
    const quietPrompt = `${systemPrompt}\n\n${userMessage}`;
    const timeout = settings.scribeTimeout || 60000;
    return await Promise.race([
        generateQuietPrompt({ quietPrompt, skipWIAN: true, responseLength: settings.scribeMaxTokens }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Scribe quiet prompt timed out (${Math.round(timeout / 1000)}s)`)), timeout)),
    ]);
}

/**
 * Run Session Scribe: summarize recent chat and write to Obsidian.
 * @param {string} [customPrompt] - Optional custom focus/question
 */
export async function runScribe(customPrompt) {
    if (scribeInProgress) return;
    setScribeInProgress(true);

    try {
        const settings = getSettings();
        if (!chat || chat.length === 0) {
            toastr.warning('No active chat to summarize.', 'DeepLore Enhanced');
            return;
        }

        // Build context using shared utility with configurable depth
        const context = buildAiChatContext(chat, settings.scribeScanDepth);
        if (!context.trim()) {
            toastr.warning('No messages to summarize.', 'DeepLore Enhanced');
            return;
        }

        // Build system prompt
        const systemPrompt = settings.scribePrompt?.trim() || DEFAULT_SCRIBE_PROMPT;

        // Build user message with optional prior note context and custom focus
        const parts = [];
        if (lastScribeSummary) {
            parts.push(`[PREVIOUS SESSION NOTE]\n${lastScribeSummary}`);
        }
        parts.push(`[RECENT CONVERSATION]\n${context}`);
        if (customPrompt) {
            parts.push(`[ADDITIONAL FOCUS]\n${customPrompt}`);
        }
        const userMessage = parts.join('\n\n');

        // Generate summary via configured connection
        const summary = await callScribe(systemPrompt, userMessage, settings);

        if (!summary || !summary.trim()) {
            toastr.warning('Scribe generated an empty summary.', 'DeepLore Enhanced');
            return;
        }

        // Build filename and content
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = now.toTimeString().slice(0, 5).replace(':', '-');
        const charName = (name2 || 'Unknown').replace(/[<>:"/\\|?*]/g, '_');
        const filename = `${settings.scribeFolder}/${charName} - ${dateStr} ${timeStr}.md`;

        const noteContent = `---\ntags:\n  - lorebook-session\ndate: ${now.toISOString()}\ncharacter: ${charName}\n---\n# Session: ${charName} - ${dateStr} ${timeStr}\n\n${summary.trim()}\n`;

        // Write to Obsidian directly (uses primary vault)
        const scribeVault = getPrimaryVault(settings);
        const data = await writeNote(scribeVault.port, scribeVault.apiKey, filename, noteContent);

        if (data.ok) {
            setLastScribeSummary(summary.trim());
            setLastScribeChatLength(chat.length);
            chat_metadata.deeplore_lastScribeSummary = lastScribeSummary;
            saveChatDebounced();
            toastr.success(`Session note saved: ${filename}`, 'DeepLore Enhanced', { timeOut: 5000 });
        } else {
            toastr.error(`Failed to save session note: ${data.error}`, 'DeepLore Enhanced');
        }
    } catch (err) {
        console.error('[DLE] Session Scribe error:', err);
        toastr.error(`Scribe error: ${err.message}`, 'DeepLore Enhanced');
    } finally {
        setScribeInProgress(false);
    }
}
