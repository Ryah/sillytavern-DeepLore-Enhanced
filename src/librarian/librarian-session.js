/**
 * DeepLore Enhanced -- Librarian Session: AI Conversation Engine
 * Manages multi-turn conversations with the librarian AI for entry creation/editing.
 * Includes response validation gate with auto-retry.
 */
import { saveChatDebounced } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { buildAiChatContext } from '../../core/utils.js';
import { callAI, buildCandidateManifest } from '../ai/ai.js';
import { queryBM25 } from '../vault/bm25.js';
import { getSettings } from '../../settings.js';
import { vaultIndex, fuzzySearchIndex, loreGaps, setLoreGaps } from '../state.js';
import { validateSessionResponse, parseSessionResponse } from '../helpers.js';

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const MAX_VALIDATION_RETRIES = 3;
const MAX_HISTORY_MESSAGES = 10; // Keep last N messages to bound prompt growth
const MAX_DRAFT_JSON_CHARS = 4000; // Cap draft state in system prompt
const MAX_RELATED_ENTRIES_CHARS = 4000; // Cap related entries in system prompt

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

// ════════════════════════════════════════════════════════════════════════════
// Entry writing guide (embedded in system prompt)
// ════════════════════════════════════════════════════════════════════════════

const ENTRY_WRITING_GUIDE = `
## How to Write a Vault Entry

### Frontmatter
Every entry needs YAML frontmatter:
\`\`\`yaml
---
fileClass: character  # omit for story type
type: character       # character|location|lore|organization|story
status: active
priority: 50          # 20=inner circle, 35=core lore, 50=standard, 60=secondary, 80=background
tags:
  - lorebook          # REQUIRED — makes it a lorebook entry
  - category/subcategory
keys:
  - Primary Name
  - alias
  - trigger keyword
summary: "Up to 600 chars — see Summary Guidelines below"
---
\`\`\`

### Summary Field (CRITICAL)
The summary is used ONLY to help the AI selection model (Haiku) decide whether to inject this entry. It is NOT sent to the writing AI. Write it as an index card for a librarian, not as prose.

Answer these questions:
1. **What is this?** Category, role, core identity (1 sentence)
2. **When should it be selected?** Situations, triggers, relevant topics (1-2 sentences)
3. **Key relationships** Connected entries (brief)

GOOD: "Eris's spymaster, interrogator, and closest enforcer. Inner circle. Select when espionage, intelligence gathering, interrogation, loyalty, or the Triumvirate betrayal comes up. Also relevant for surveillance, Raven's network, and territory enforcement."

BAD: "Eris is a tall, imposing figure with silver hair who serves as a spymaster." (This describes appearance — useless for selection.)

### Content Structure
\`\`\`markdown
# Entry Title

One-paragraph introduction — what this is, in narrative prose.

<div class="meta-block">
[Field1: value | Field2: value | Field3: value]
</div>

Remaining prose sections with full lore content.
Use [[wikilinks]] to cross-reference other entries.
\`\`\`

### Meta-block Fields by Type
- **Characters:** Species, Role, Callsign, Aliases, Height, Build, Hair, Eyes, Skin, Features, Apparent Age, True Age, Origin, Personality, Speech, Wants, Fears, Powers, Limits, Items, Secret
- **Locations:** Category, Owner, District, Access, Atmosphere, Function, Layout, Rules, Security, Regulars
- **Lore:** Category, Scope, Danger, Who Knows, Triggers, Consequences, Related, Enforcement, Misconceptions
- **Organizations:** Category, Owner, Run By, Public Face, True Purpose, Visibility, Scope, Staff, Key People, Value, Vulnerabilities

### Keys
2-5 trigger keywords that would match in chat text. Include the primary name, common aliases, and thematic keywords that would appear when this entry is relevant. Keys are case-insensitive and matched as substrings.
`;

/**
 * Build the system prompt for the librarian AI session.
 * @param {LibrarianSession} session
 * @returns {string}
 */
function buildSystemPrompt(session) {
    const settings = getSettings();
    const lorebookTag = settings.lorebookTag || 'lorebook';
    const parts = [];

    parts.push(`You are a lorebook editor for a roleplay setting. You help create and improve lore entries for an Obsidian vault used by DeepLore Enhanced. The required lorebook tag is "${lorebookTag}".`);

    // Entry writing guide
    parts.push(ENTRY_WRITING_GUIDE);

    // Entry point context
    if (session.entryPoint === 'gap' && session.gapRecord) {
        const gap = session.gapRecord;
        parts.push(`## Gap Context\nA gap was detected during generation:`);
        parts.push(`- **Topic:** ${gap.query}`);
        parts.push(`- **Reason:** ${gap.reason}`);
        parts.push(`- **Urgency:** ${gap.urgency || 'medium'}`);
        if (gap.resultTitles && gap.resultTitles.length > 0) {
            parts.push(`- **Search results found:** ${gap.resultTitles.join(', ')}`);
        } else if (gap.type === 'search') {
            parts.push(`- **Search results:** none found`);
        }
    } else if (session.entryPoint === 'review') {
        parts.push(`\n## Vault Review Mode\nThe following chat history has not yet been integrated into the lore vault. Review it and propose entries to create or update, prioritized by importance.`);
    }

    // Manifest
    if (session.manifest) {
        const truncatedManifest = session.manifest.length > 8000
            ? session.manifest.slice(0, 8000) + '\n[...truncated]'
            : session.manifest;
        parts.push(`\n## Existing vault entries (manifest):\n${truncatedManifest}`);
    }

    // Related entries for gap review (capped to prevent prompt bloat)
    if (session.relatedEntries) {
        const truncated = session.relatedEntries.length > MAX_RELATED_ENTRIES_CHARS
            ? session.relatedEntries.slice(0, MAX_RELATED_ENTRIES_CHARS) + '\n[...truncated]'
            : session.relatedEntries;
        parts.push(`\n## Related existing entries:\n${truncated}`);
    }

    // Chat context
    if (session.chatContext) {
        const truncatedChat = session.chatContext.length > 4000
            ? session.chatContext.slice(0, 4000) + '\n[...truncated]'
            : session.chatContext;
        parts.push(`\n## Recent chat context:\n${truncatedChat}`);
    }

    // Current draft (capped to prevent prompt bloat)
    if (session.draftState) {
        let draftJson = JSON.stringify(session.draftState, null, 2);
        if (draftJson.length > MAX_DRAFT_JSON_CHARS) {
            // Truncate content field first (largest field)
            const trimmed = { ...session.draftState };
            if (trimmed.content && trimmed.content.length > 1000) {
                trimmed.content = trimmed.content.slice(0, 1000) + '\n[...content truncated, see editor]';
            }
            draftJson = JSON.stringify(trimmed, null, 2);
        }
        parts.push(`\n## Current draft (editing):\n${draftJson}`);
    } else {
        parts.push(`\n## Current draft:\nNo draft yet. Help the user create one.`);
    }

    // Response format
    parts.push(`
## Response Format
Respond as JSON:
{
  "message": "Your conversational response — explain what you did and why",
  "draft": {
    "title": "Entry Title",
    "type": "character|location|lore|organization|story",
    "priority": 50,
    "tags": ["${lorebookTag}"],
    "keys": ["keyword1", "keyword2"],
    "summary": "Selection-oriented summary (see guidelines above)",
    "content": "Full markdown content with # heading, meta-block, prose, [[wikilinks]]"
  },
  "action": "update_draft"
}

Set "draft" to null and "action" to null if you're just conversing without updating the entry.

If proposing a work queue (vault review), use:
{
  "message": "Here's what I found...",
  "queue": [
    {"title": "...", "action": "create"|"update", "reason": "...", "urgency": "high"|"medium"|"low"}
  ],
  "action": "propose_queue"
}

## Rules
- Only modify draft fields the user asked about (or that obviously need fixing)
- Content MUST start with \`# Title\` heading, then intro paragraph, then meta-block, then prose
- Summary MUST be written for AI selection (what/when/relationships), NOT prose description
- Include the lorebook tag "${lorebookTag}" in tags
- Use [[wikilinks]] to reference other vault entries when relevant
- Keys should be 2-5 trigger words that would appear in chat when this entry is relevant`);

    return parts.join('\n');
}

// parseSessionResponse and validateSessionResponse imported from helpers.js (pure, testable in Node)

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
        model: settings.librarianSessionModel || settings.aiSearchModel,
        maxTokens: settings.librarianSessionMaxTokens || 4096,
        timeout: settings.librarianSessionTimeout || 60000,
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
        let result;
        try {
            result = await callAI(systemPrompt, messageToSend, connectionConfig);
        } catch (err) {
            // Connection/timeout errors are retryable once
            lastErrors = [`AI call failed: ${err.message || err}`];
            if (attempt < MAX_VALIDATION_RETRIES - 1) continue;
            return { parsed: null, valid: false, exhausted: true, lastErrors };
        }
        const parsed = parseSessionResponse(result.text);

        if (!parsed) {
            // Total parse failure -- retry with correction prepended to full history
            const correction = `[SYSTEM: Your previous response could not be parsed as JSON. `
                + `Respond with a valid JSON object matching the format in the system prompt. `
                + `Do not include any text outside the JSON object.]\n\n`;
            messageToSend = correction + buildUserPromptFromHistory(session.messages);
            lastErrors = ['Response could not be parsed as JSON'];
            continue;
        }

        const { valid, errors } = validateSessionResponse(parsed);
        if (valid) {
            // Apply valid response — filter out null/undefined draft fields to prevent erasure (M5)
            if (parsed.draft) {
                const filtered = Object.fromEntries(
                    Object.entries(parsed.draft).filter(([, v]) => v != null),
                );
                session.draftState = { ...session.draftState, ...filtered };
            }
            if (parsed.queue) {
                session.workQueue = parsed.queue;
            }
            session.messages.push({ role: 'assistant', content: parsed.message || result.text });
            return { parsed, valid: true, exhausted: false, lastErrors: [] };
        }

        // Build specific rejection prepended to full history
        lastErrors = errors;
        const rejection = `[SYSTEM: Your response was rejected due to ${errors.length} validation error(s):\n`
            + errors.map((e, i) => `${i + 1}. ${e}`).join('\n')
            + `\nPlease fix these issues and resend your response in the correct format.]\n\n`;
        messageToSend = rejection + buildUserPromptFromHistory(session.messages);
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
    // Keep last N messages to bound prompt growth
    const recent = messages.length > MAX_HISTORY_MESSAGES
        ? messages.slice(-MAX_HISTORY_MESSAGES)
        : messages;
    const prefix = messages.length > MAX_HISTORY_MESSAGES
        ? `[...${messages.length - MAX_HISTORY_MESSAGES} earlier messages omitted]\n\n`
        : '';
    return prefix + recent.map(m => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        return `${role}: ${m.content}`;
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
        saveChatDebounced();
    }
}
