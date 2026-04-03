/**
 * DeepLore Enhanced -- Librarian Session: AI Conversation Engine
 * Manages multi-turn conversations with the librarian AI for entry creation/editing.
 * Includes response validation gate with auto-retry.
 */
import { getContext } from '../../../../../extensions.js';
import { buildAiChatContext } from '../../core/utils.js';
import { callAI, buildCandidateManifest } from '../ai/ai.js';
import { queryBM25 } from '../vault/bm25.js';
import { getSettings } from '../../settings.js';
import { vaultIndex, fuzzySearchIndex, loreGaps, setLoreGaps } from '../state.js';
import { validateSessionResponse } from '../helpers.js';

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const MAX_VALIDATION_RETRIES = 3;

// ════════════════════════════════════════════════════════════════════════════
// Session Factory
// ════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {object} LibrarianSession
 * @property {Array<{role: string, content: string}>} messages
 * @property {object|null} draftState
 * @property {object|null} gapRecord
 * @property {'gap'|'new'|'review'} entryPoint
 * @property {string} manifest
 * @property {string} chatContext
 * @property {Array|null} workQueue
 */

/**
 * Create a new librarian session.
 * @param {'gap'|'new'|'review'} entryPoint
 * @param {object} [options]
 * @param {object} [options.gap] - Gap record (for 'gap' entry point)
 * @returns {LibrarianSession}
 */
export function createSession(entryPoint, options = {}) {
    const settings = getSettings();
    const ctx = getContext();
    const chat = ctx?.chat || [];

    // Build chat context from recent messages
    const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth || 20);

    // Build manifest
    let manifest = '';
    if (vaultIndex.length > 0) {
        const { manifest: m } = buildCandidateManifest(vaultIndex, false);
        manifest = m;
    }

    // For gap entry point, augment manifest with related entries
    let relatedEntries = '';
    if (entryPoint === 'gap' && options.gap && fuzzySearchIndex) {
        const hits = queryBM25(fuzzySearchIndex, options.gap.query, 10, 0.3);
        if (hits.length > 0) {
            relatedEntries = hits.map(h =>
                `## ${h.entry.title}\nKeys: ${(h.entry.keys || []).join(', ')}\n${(h.entry.content || '').slice(0, 500)}`
            ).join('\n\n');
        }
    }

    const session = {
        messages: [],
        draftState: null,
        gapRecord: options.gap || null,
        entryPoint,
        manifest,
        chatContext,
        relatedEntries,
        workQueue: null,
    };

    return session;
}

// ════════════════════════════════════════════════════════════════════════════
// System Prompt Builder
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the system prompt for the librarian AI session.
 * @param {LibrarianSession} session
 * @returns {string}
 */
function buildSystemPrompt(session) {
    const parts = [];

    parts.push(`You are a lorebook editor for a roleplay setting. You help create and improve lore entries for an Obsidian vault used by DeepLore Enhanced.`);

    // Entry point context
    if (session.entryPoint === 'gap' && session.gapRecord) {
        const gap = session.gapRecord;
        parts.push(`\nA gap was detected during generation:`);
        parts.push(`Topic: ${gap.query}`);
        parts.push(`Reason: ${gap.reason}`);
        parts.push(`Urgency: ${gap.urgency || 'medium'}`);
        if (gap.resultTitles && gap.resultTitles.length > 0) {
            parts.push(`Search results found: ${gap.resultTitles.join(', ')}`);
        } else if (gap.type === 'search') {
            parts.push(`Search results: none found`);
        }
    } else if (session.entryPoint === 'review') {
        parts.push(`\nThe following chat history has not yet been integrated into the lore vault. Review it and propose entries to create or update, prioritized by importance.`);
    }

    // Manifest
    if (session.manifest) {
        const truncatedManifest = session.manifest.length > 8000
            ? session.manifest.slice(0, 8000) + '\n[...truncated]'
            : session.manifest;
        parts.push(`\n## Existing vault entries (manifest):\n${truncatedManifest}`);
    }

    // Related entries for gap review
    if (session.relatedEntries) {
        parts.push(`\n## Related existing entries:\n${session.relatedEntries}`);
    }

    // Chat context
    if (session.chatContext) {
        const truncatedChat = session.chatContext.length > 4000
            ? session.chatContext.slice(0, 4000) + '\n[...truncated]'
            : session.chatContext;
        parts.push(`\n## Recent chat context:\n${truncatedChat}`);
    }

    // Current draft
    if (session.draftState) {
        parts.push(`\n## Current draft (editing):\n${JSON.stringify(session.draftState, null, 2)}`);
    } else {
        parts.push(`\n## Current draft:\nNo draft yet. Help the user create one.`);
    }

    // Response format
    parts.push(`
Respond as JSON:
{
  "message": "Your conversational response",
  "draft": {
    "title": "...", "type": "...", "priority": N,
    "keys": [...], "summary": "...", "content": "..."
  } or null,
  "action": "update_draft" | "propose_queue" | null
}

If proposing a work queue (vault review), use:
{
  "message": "Here's what I found...",
  "queue": [
    {"title": "...", "action": "create"|"update", "reason": "...", "urgency": "high"|"medium"|"low"}
  ],
  "action": "propose_queue"
}

Guidelines:
- Only modify draft fields the user asked about (or that obviously need fixing)
- Keys: 2-5 trigger words that would match in chat text
- Summary: describe when to select (~100 words, written for AI retrieval, not prose)
- Content: structured markdown with meta-block, prose sections, [[wikilinks]]
- Priority: 20=inner circle, 35=core, 50=standard, 60=secondary, 80=background
- Include lorebook tag in tags`);

    return parts.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// Response Parsing
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse the AI response text into a structured object.
 * Handles raw JSON, code-fenced JSON, and plain text fallback.
 * @param {string} text - Raw AI response
 * @returns {object|null} Parsed response or null on total failure
 */
function parseSessionResponse(text) {
    if (!text || typeof text !== 'string') return null;

    // Try direct JSON parse
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch { /* noop */ }

    // Try code fence extraction
    const fenceMatch = text.match(/`{3,}(?:json)?\s*([\s\S]*?)`{3,}/);
    if (fenceMatch) {
        try {
            const parsed = JSON.parse(fenceMatch[1].trim());
            if (typeof parsed === 'object' && parsed !== null) return parsed;
        } catch { /* noop */ }
    }

    // Try finding first { ... } block via bracket balancing
    const firstBrace = text.indexOf('{');
    if (firstBrace >= 0) {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = firstBrace; i < text.length; i++) {
            const ch = text[i];
            if (escape) { escape = false; continue; }
            if (ch === '\\' && inString) { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    try {
                        const parsed = JSON.parse(text.slice(firstBrace, i + 1));
                        if (typeof parsed === 'object' && parsed !== null) return parsed;
                    } catch { /* noop */ }
                    break;
                }
            }
        }
    }

    return null;
}

// validateSessionResponse is imported from helpers.js (pure, testable in Node)
// Re-export for convenience
export { validateSessionResponse } from '../helpers.js';

// ════════════════════════════════════════════════════════════════════════════
// Send Message (with validation + retry)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the connection config for librarian AI calls.
 * Reuses AI search connection settings.
 * @returns {object} connectionConfig for callAI()
 */
function getConnectionConfig() {
    const settings = getSettings();
    return {
        mode: settings.aiSearchConnectionMode,
        profileId: settings.aiSearchProfileId,
        proxyUrl: settings.aiSearchProxyUrl,
        model: settings.aiSearchModel,
        maxTokens: settings.aiSearchMaxTokens || 4096,
        timeout: settings.aiSearchTimeout || 30000,
        skipThrottle: true, // Session calls should not be throttled
    };
}

/**
 * Send a message in a librarian session.
 * Includes validation gate with auto-retry.
 *
 * @param {LibrarianSession} session - The active session
 * @param {string} userMessage - User's message
 * @returns {Promise<{parsed: object|null, valid: boolean, exhausted: boolean, lastErrors: string[]}>}
 */
export async function sendMessage(session, userMessage) {
    // Append user message to history
    session.messages.push({ role: 'user', content: userMessage });

    const systemPrompt = buildSystemPrompt(session);
    const connectionConfig = getConnectionConfig();

    let messageToSend = buildUserPromptFromHistory(session.messages);
    let lastErrors = [];

    for (let attempt = 0; attempt < MAX_VALIDATION_RETRIES; attempt++) {
        const result = await callAI(systemPrompt, messageToSend, connectionConfig);
        const parsed = parseSessionResponse(result.text);

        if (!parsed) {
            // Total parse failure -- retry with explicit instruction
            messageToSend = `Your response could not be parsed as JSON. `
                + `Respond with a valid JSON object matching the format in the system prompt. `
                + `Do not include any text outside the JSON object.`;
            lastErrors = ['Response could not be parsed as JSON'];
            continue;
        }

        const { valid, errors } = validateSessionResponse(parsed);
        if (valid) {
            // Apply valid response
            if (parsed.draft) {
                session.draftState = { ...session.draftState, ...parsed.draft };
            }
            if (parsed.queue) {
                session.workQueue = parsed.queue;
            }
            session.messages.push({ role: 'assistant', content: parsed.message || result.text });
            return { parsed, valid: true, exhausted: false, lastErrors: [] };
        }

        // Build specific rejection -- note: rejected responses are NOT appended to session.messages
        lastErrors = errors;
        messageToSend = `Your response was rejected due to ${errors.length} validation error(s):\n`
            + errors.map((e, i) => `${i + 1}. ${e}`).join('\n')
            + `\n\nPlease fix these issues and resend your response in the correct format.`;
    }

    // Retries exhausted
    return { parsed: null, valid: false, exhausted: true, lastErrors };
}

/**
 * Build the full user prompt from message history.
 * Combines all messages into a single prompt for the AI.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {string}
 */
function buildUserPromptFromHistory(messages) {
    return messages.map(m => {
        const prefix = m.role === 'user' ? 'User' : 'Assistant';
        return `${prefix}: ${m.content}`;
    }).join('\n\n');
}

// ════════════════════════════════════════════════════════════════════════════
// Gap Status Management
// ════════════════════════════════════════════════════════════════════════════

/**
 * Update a gap record's status.
 * @param {string} gapId - Gap record ID
 * @param {string} newStatus - New status value
 */
export function updateGapStatus(gapId, newStatus) {
    const idx = loreGaps.findIndex(g => g.id === gapId);
    if (idx === -1) return;

    const updated = [...loreGaps];
    updated[idx] = { ...updated[idx], status: newStatus };
    setLoreGaps(updated);

    // Persist to chat_metadata
    const ctx = getContext();
    if (ctx?.chat_metadata) {
        ctx.chat_metadata.deeplore_lore_gaps = updated;
    }
}
