/**
 * DeepLore Enhanced — Session Scribe
 */
import {
    generateQuietPrompt,
    chat,
    chat_metadata,
    name2,
    eventSource,
    event_types,
} from '../../../../../../script.js';
import { saveMetadataDebounced } from '../../../../../extensions.js';
import { getSettings, getPrimaryVault, resolveConnectionConfig } from '../../settings.js';
import { writeNote } from '../vault/obsidian-api.js';
import { buildIndex } from '../vault/vault.js';
import { buildAiChatContext } from '../../core/utils.js';
import { callAI } from './ai.js';
import { stripObsidianSyntax } from '../helpers.js';
import {
    scribeInProgress, lastScribeSummary, lastScribeChatLength, chatEpoch,
    setScribeInProgress, setLastScribeSummary, setLastScribeChatLength,
    isAiCircuitOpen, tryAcquireHalfOpenProbe, recordAiSuccess, recordAiFailure,
} from '../state.js';
import { dedupError, dedupWarning } from '../toast-dedup.js';

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
    const resolved = resolveConnectionConfig('scribe');
    const mode = resolved.mode;

    if (mode === 'profile' || mode === 'proxy') {
        if (isAiCircuitOpen() && !tryAcquireHalfOpenProbe()) throw new Error('AI circuit breaker is open — skipping scribe');
        try {
            const result = await callAI(systemPrompt, userMessage, resolved);
            recordAiSuccess();
            return result.text || '';
        } catch (err) {
            // BUG-252: user aborts and timeouts must not trip the circuit breaker.
            if (!err.throttled && !err.userAborted && !err.timedOut) recordAiFailure();
            throw err;
        }
    }

    // Default: 'st' mode — use SillyTavern's active connection via generateQuietPrompt
    // Note: generateQuietPrompt cannot be aborted — the background generation will complete
    // regardless, but BUG-241 wires GENERATION_STOPPED so our await resolves early and the
    // scribeInProgress lock releases promptly instead of waiting out the full timeout.
    const quietPrompt = `${systemPrompt}\n\n${userMessage}`;
    // BUG-FIX: timeout=0 should mean "no timeout", not "instant timeout" (setTimeout(fn, 0) fires immediately)
    const timeout = resolved.timeout || 60000;
    const quietPromise = generateQuietPrompt({ quietPrompt, skipWIAN: true, responseLength: resolved.maxTokens });
    let scribeTimer;
    let onStop;
    try {
        return await Promise.race([
            quietPromise.finally(() => clearTimeout(scribeTimer)),
            new Promise((_, reject) => { scribeTimer = setTimeout(() => {
                console.warn('[DLE] Scribe quiet prompt timed out — orphaned generation may still complete in background');
                const err = new Error(`Scribe quiet prompt timed out (${Math.round(timeout / 1000)}s)`);
                err.timedOut = true;
                reject(err);
            }, timeout); }),
            new Promise((_, reject) => {
                onStop = () => {
                    const err = new Error('Scribe aborted by user (GENERATION_STOPPED)');
                    err.name = 'AbortError';
                    err.userAborted = true;
                    reject(err);
                };
                try { eventSource.on(event_types.GENERATION_STOPPED, onStop); } catch { /* noop */ }
            }),
        ]);
    } finally {
        if (onStop) { try { eventSource.removeListener(event_types.GENERATION_STOPPED, onStop); } catch { /* noop */ } }
    }
}

/**
 * Run Session Scribe: summarize recent chat and write to Obsidian.
 * @param {string} [customPrompt] - Optional custom focus/question
 */
export async function runScribe(customPrompt) {
    if (scribeInProgress) return;
    setScribeInProgress(true);

    // Capture epoch to detect chat changes during async scribe work
    const epoch = chatEpoch;

    try {
        const settings = getSettings();
        if (!chat || chat.length === 0) {
            dedupWarning('No active chat to summarize.', 'scribe_no_chat');
            return;
        }

        // Build context using shared utility with configurable depth
        const context = buildAiChatContext(chat, settings.scribeScanDepth);
        if (!context.trim()) {
            dedupWarning('No messages to summarize.', 'scribe_no_messages');
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
            dedupWarning('Session Scribe couldn\'t finish — your chat is unchanged.', 'scribe_empty_summary', { hint: 'Scribe returned empty summary.' });
            return;
        }

        // Sanitize AI output: strip Obsidian-interpretable syntax and bare YAML delimiters
        const sanitizedSummary = stripObsidianSyntax(summary).replace(/^---$/gm, '- - -');

        // Build filename and content
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
        let charName = (name2 || 'Unknown').replace(/[<>:"/\\|?*]/g, '_');
        charName = charName.replace(/^\.+|\.+$/g, ''); // strip leading/trailing dots
        charName = charName.trimEnd(); // strip trailing spaces
        // Prefix Windows reserved names to prevent filesystem conflicts
        if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(charName)) {
            charName = '_' + charName;
        }
        if (!charName) charName = 'Unknown';
        const filename = `${settings.scribeFolder}/${charName} - ${dateStr} ${timeStr}.md`;

        const noteContent = `---\ntags:\n  - lorebook-session\ndate: ${now.toISOString()}\ncharacter: "${charName.replace(/"/g, '\\"')}"\n---\n# Session: ${charName} - ${dateStr} ${timeStr}\n\n${sanitizedSummary.trim()}\n`;

        // Bail if chat changed during async scribe work
        if (epoch !== chatEpoch) {
            if (getSettings().debugMode) console.log('[DLE] Scribe: chat changed during generation, discarding result');
            return;
        }

        // Write to Obsidian directly (uses primary vault)
        const scribeVault = getPrimaryVault(settings);
        const data = await writeNote(scribeVault.host, scribeVault.port, scribeVault.apiKey, filename, noteContent, !!scribeVault.https);

        if (data.ok) {
            // Re-check epoch after async writeNote to avoid writing to wrong chat's metadata
            if (epoch !== chatEpoch) {
                if (getSettings().debugMode) console.log('[DLE] Scribe: chat changed during note write, skipping metadata update');
                return;
            }
            setLastScribeSummary(sanitizedSummary.trim());
            const chatLenAtWrite = chat?.length || 0;
            setLastScribeChatLength(chatLenAtWrite); // Use current length, not stale start value
            chat_metadata.deeplore_lastScribeSummary = lastScribeSummary;
            // BUG-308: persist the "we already scribed at length N" guard to chat_metadata so
            // CHAT_CHANGED / reload can hydrate it. Previously the guard was in-memory only,
            // so on returning to a chat the next rendered message could re-trigger scribe
            // immediately even though the chat hadn't grown since the last successful scribe.
            chat_metadata.deeplore_lastScribeChatLength = chatLenAtWrite;
            saveMetadataDebounced();
            toastr.success(`Session note saved: ${filename}`, 'DeepLore Enhanced', { timeOut: 5000 });
            // Reindex so the newly-written note is immediately retrievable
            if (epoch !== chatEpoch) {
                if (getSettings().debugMode) console.log('[DLE] Scribe: chat changed before reindex, skipping buildIndex');
                return;
            }
            try { await buildIndex(); } catch (reidxErr) { console.warn('[DLE] Scribe reindex after write failed:', reidxErr?.message); }
        } else {
            dedupError('Couldn\'t save the session note to your vault.', 'scribe_write_fail', { hint: data && data.error });
        }
    } catch (err) {
        console.error('[DLE] Session Scribe error:', err);
        dedupError('Session Scribe couldn\'t finish — your chat is unchanged.', 'scribe_runtime_error', { hint: err && err.message });
    } finally {
        // BUG-275: Always release the flag — this scribe invocation owns it from
        // acquisition (L82) to release here. CHAT_CHANGED no longer touches it, so
        // the prior epoch-guarded reset would have leaked the flag forever.
        setScribeInProgress(false);
    }
}
