/**
 * DeepLore Enhanced -- Librarian Session: AI Conversation Engine
 * Manages multi-turn conversations with the librarian AI for entry creation/editing.
 * Includes response validation gate with auto-retry.
 */
import { getContext, saveMetadataDebounced } from '../../../../../extensions.js';
import { buildAiChatContext } from '../../core/utils.js';
import { callAI, buildCandidateManifest } from '../ai/ai.js';
import { queryBM25 } from '../vault/bm25.js';
import { getSettings, resolveConnectionConfig } from '../../settings.js';
import { vaultIndex, fuzzySearchIndex, loreGaps, setLoreGaps, chatEpoch } from '../state.js';
import { validateSessionResponse, parseSessionResponse } from '../helpers.js';
import { executeToolCall, buildToolsPromptSection } from './librarian-chat-tools.js';
import {
    buildLibrarianBootstrapSystemPrompt,
    EMMA_FIRSTRUN_GREETING,
    EMMA_ADHOC_GREETING,
} from './librarian-prompts.js';

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// Emma's flavor intros (random opener for empty 'new' sessions)
// ════════════════════════════════════════════════════════════════════════════

export const EMMA_FLAVOR_INTROS = [
    "Back already? Hope you brought receipts.",
    "The card catalog and I have been waiting. What's the damage?",
    "Welcome to the stacks. Try not to track mud in this time.",
    "Oh good, another character whose name I'll have to alphabetize.",
    "Pull up a chair. The vault's been suspiciously quiet, which usually means you're cooking something.",
    "Right. New entry. Let me guess — it's another morally grey swordsman with a tragic past.",
    "I was halfway through reshelving when you walked in. This had better be worth it.",
    "Lay it on me. I have opinions about your taxonomy and three hours until close.",
    "Another day, another fictional person who needs a frontmatter block. Hit me.",
    "Whatever you're about to ask, the answer is probably 'yes, but write a summary first.'",
    "I'm an AI in a popup. You're a person with too many ideas. Let's make this work.",
    "If this is another bloodline with seven branches and no entry for any of them, I'm taking my fifteen.",
    "Good, you're here. The vault has questions. So do I.",
    "You know I can see your existing entries, right? Some of them need a talking-to. But sure, let's start a new one.",
    "Reporting for duty. I am, against my better judgment, ready to help.",
    "I had a whole speech prepared and now I've forgotten it. Just tell me what we're documenting.",
    "Another would-be canon entry. The pile grows. I am the pile's keeper.",
    "Welcome. I'm Emma. I will be your librarian, your editor, and the voice in your head asking 'but is this in the summary.'",
    "Let me find a clean index card. Okay. Go.",
    "If this is a chosen one with a prophecy, I need you to know I've seen forty-seven of those this month. Proceed.",
];

/**
 * Pick a random flavor intro for a new empty session.
 * Pure for testability.
 * @returns {string}
 */
export function pickFlavorIntro() {
    return EMMA_FLAVOR_INTROS[Math.floor(Math.random() * EMMA_FLAVOR_INTROS.length)];
}

const MAX_VALIDATION_RETRIES = 3;
const MAX_TOOL_CALLS_PER_TURN = 10;
const MAX_HISTORY_MESSAGES = 10; // Keep last N messages to bound prompt growth
// BUG-232: Hard cap on outer agentic-loop iterations (each iteration = one AI call).
// Prevents unbounded loop when AI ignores the "tool call budget reached" nudge and
// keeps returning tool_call actions. Slack covers worst case: MAX_TOOL_CALLS_PER_TURN
// tool-call iterations + budget nudge iteration + final response + buffer.
const MAX_AGENTIC_ITERATIONS = MAX_TOOL_CALLS_PER_TURN + 5;
// Caps are now configurable via settings — these are fallback defaults
function getManifestMaxChars() { return getSettings().librarianManifestMaxChars || 8000; }
function getRelatedMaxChars() { return getSettings().librarianRelatedEntriesMaxChars || 4000; }
function getDraftMaxChars() { return getSettings().librarianDraftMaxChars || 4000; }
function getChatContextMaxChars() { return getSettings().librarianChatContextMaxChars || 4000; }

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

    // Guide modes — Emma helps the user write a lorebook-guide entry.
    // 'guide-firstrun' is the wizard's "Meet Emma" page (full Q&A script + greeting).
    // 'guide-adhoc' is the Settings → Library Tour entrypoint (no script, ad-hoc greeting).
    const mode = options.mode || null;
    const isGuideMode = mode === 'guide-firstrun' || mode === 'guide-adhoc';
    let guideBootstrap = '';
    let seededGreeting = null;
    if (isGuideMode) {
        guideBootstrap = buildLibrarianBootstrapSystemPrompt({
            includeFirstRunScript: mode === 'guide-firstrun',
        });
        seededGreeting = mode === 'guide-firstrun' ? EMMA_FIRSTRUN_GREETING : EMMA_ADHOC_GREETING;
    }

    // BUG-332: seed greeting as plain text. The restore path (librarian-review.js
    // replay loop) passes msg.content straight to appendMessage without JSON-parsing,
    // so a JSON-wrapped seed would render as raw `{"message":"...","action":null}`
    // on reopen. Assistant messages pushed by sendMessage are already plain text
    // (validParsed.message), so this keeps the shape consistent.
    const session = {
        messages: seededGreeting
            ? [{ role: 'assistant', content: seededGreeting }]
            : [],
        draftState: isGuideMode ? {
            title: '',
            type: 'lore',
            priority: 50,
            tags: ['lorebook-guide'],
            summary: '',
            content: '',
            folder: settings.librarianWriteFolder || 'DeepLore/Guides/',
        } : null,
        gapRecord: options.gap || null,
        entryPoint,
        mode,
        guideBootstrap,
        manifest,
        chatContext,
        relatedEntries,
        workQueue: null,
    };

    return session;
}

// ════════════════════════════════════════════════════════════════════════════
// Session Persistence (BUG-043: now in chat_metadata so session is per-chat,
// not browser-global. Legacy localStorage key is migrated once on load.)
// ════════════════════════════════════════════════════════════════════════════

const SESSION_METADATA_KEY = 'deeplore_librarian_session';
const LEGACY_STORAGE_KEY = 'deeplore_librarian_session';

function getChatMetadata() {
    try {
        const ctx = getContext();
        return ctx?.chatMetadata || null;
    } catch {
        return null;
    }
}

/**
 * Save session state to chat_metadata so it's scoped to the current chat
 * and survives page refreshes. If no chat is active, silently no-ops.
 * @param {LibrarianSession} session
 */
export function saveSessionState(session) {
    try {
        const md = getChatMetadata();
        if (!md) return; // No active chat — nothing to persist into
        md[SESSION_METADATA_KEY] = {
            messages: session.messages,
            draftState: session.draftState,
            entryPoint: session.entryPoint,
            gapRecord: session.gapRecord,
            manifest: session.manifest,
            chatContext: session.chatContext,
            relatedEntries: session.relatedEntries,
            workQueue: session.workQueue,
            // BUG-326: persist lastOptions so a reopened session doesn't lose an in-progress
            // options picker the user hasn't yet applied.
            lastOptions: session.lastOptions || null,
            mode: session.mode || null,
            guideBootstrap: session.guideBootstrap || '',
            savedAt: Date.now(),
        };
        saveMetadataDebounced();
    } catch (e) {
        console.warn('[DLE] Failed to save librarian session:', e.message);
    }
}

/**
 * Load saved session state from chat_metadata, falling back to (and migrating)
 * a legacy localStorage key one time so existing users don't lose their draft.
 * @returns {object|null} Saved session state, or null if none exists
 */
export function loadSessionState() {
    try {
        const md = getChatMetadata();
        if (md && md[SESSION_METADATA_KEY]) {
            return md[SESSION_METADATA_KEY];
        }
        // Legacy migration: move browser-global draft into the current chat once
        const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (md) {
                md[SESSION_METADATA_KEY] = parsed;
                saveMetadataDebounced();
            }
            localStorage.removeItem(LEGACY_STORAGE_KEY);
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Clear saved session state from chat_metadata (and any lingering legacy localStorage key).
 */
export function clearSessionState() {
    try {
        const md = getChatMetadata();
        if (md && SESSION_METADATA_KEY in md) {
            delete md[SESSION_METADATA_KEY];
            saveMetadataDebounced();
        }
        localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {}
}

/**
 * Restore a session from saved state.
 * Rebuilds the session object from persisted data.
 * @param {object} saved - Saved session state from loadSessionState()
 * @returns {LibrarianSession}
 */
export function restoreSession(saved) {
    return {
        messages: saved.messages || [],
        draftState: saved.draftState || null,
        gapRecord: saved.gapRecord || null,
        entryPoint: saved.entryPoint || 'new',
        manifest: saved.manifest || '',
        chatContext: saved.chatContext || '',
        relatedEntries: saved.relatedEntries || '',
        workQueue: saved.workQueue || null,
        // BUG-326: restore lastOptions so a pending options picker survives reload.
        lastOptions: saved.lastOptions || null,
        mode: saved.mode || null,
        guideBootstrap: saved.guideBootstrap || '',
    };
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

Optional frontmatter fields: \`requires\` (array of entry titles that must also be matched), \`excludes\` (array that blocks this entry), \`position\` (before/after/in_chat), \`depth\` (injection depth for in_chat), \`role\` (system/user/assistant), \`cooldown\` (generations to skip after triggering), \`cascade_links\` (entries to pull in when this matches), \`era\`/\`location\`/\`scene_type\`/\`character_present\` (contextual gating fields).

### Summary Field (CRITICAL)
The summary is used ONLY to help the AI selection model (Haiku) decide whether to inject this entry. It is NOT sent to the writing AI. Write it as an index card for a librarian, not as prose.

Answer these questions:
1. **What is this?** Category, role, core identity (1 sentence)
2. **When should it be selected?** Situations, triggers, relevant topics (1-2 sentences)
3. **Key relationships** Connected entries (brief)

#### Summary examples by type:

**Character:** "Eris's spymaster, interrogator, and closest enforcer. Inner circle. Select when espionage, intelligence gathering, interrogation, loyalty, or the Triumvirate betrayal comes up. Also relevant for surveillance, Raven's network, and territory enforcement."

**Location:** "Underground blood bar in the Dusk Quarter, owned by [[Maren]]. Select when nightlife, feeding, blood trade, black-market deals, or the Dusk Quarter comes up. Key meeting point for [[The Syndicate]]."

**Lore:** "The biological dependency created when a vampire feeds from a mortal — same mechanism as Bloodchain via saliva. Select when feeding, biting, addiction, venom, feeding sites, or chattel dynamics come up. Scales with vampire age."

**Organization:** "Eris's intelligence network spanning three districts. Select when espionage, surveillance, information brokering, district politics, or spy recruitment comes up. Rivals with [[The Watchers]]."

**BAD summary** (do NOT write like this): "Eris is a tall, imposing figure with silver hair who serves as a spymaster." — This describes appearance, which is useless for selection. The selection AI needs to know *when* to pick this entry, not what the character looks like.

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

Fields are classified by importance:
- **Critical** (always include): the fields that define the entry's core identity
- **Important** (strongly recommended): fields that add significant context
- **Contextual** (as relevant): include when they matter for this specific entry
- **Rarely needed**: skip unless the entry specifically demands it

**Characters:**
- Critical: Species, Role, Personality
- Important: Aliases, Apparent Age, Origin, Speech, Wants, Fears
- Contextual: Height, Build, Hair, Eyes, Skin, Features, True Age, Powers, Limits, Items
- Rarely needed: Callsign, Secret (only if plot-critical)
- Format: Species/Role/Personality as short phrases; Wants/Fears as comma-separated goals; Powers as brief list

**Locations:**
- Critical: Category, Function, Atmosphere
- Important: Owner, District, Access, Regulars
- Contextual: Layout, Rules, Security
- Rarely needed: (none — locations are usually concise)
- Format: Category as single word (bar, temple, arena); Atmosphere as 2-3 evocative words; Regulars as [[wikilinked]] names

**Lore:**
- Critical: Category, Scope, Who Knows
- Important: Triggers, Consequences, Related
- Contextual: Danger, Enforcement, Misconceptions
- Rarely needed: (none)
- Format: Scope as "personal/local/regional/world"; Who Knows as "common knowledge/restricted/secret"; Related as [[wikilinks]]

**Organizations:**
- Critical: Public Face, True Purpose, Run By
- Important: Visibility, Scope, Key People, Vulnerabilities
- Contextual: Owner, Staff, Value
- Rarely needed: Category (usually clear from context)
- Format: Run By/Key People as [[wikilinked]] names; Visibility as "public/underground/secret"

### Keys
2-5 trigger keywords that would match in chat text. Include the primary name, common aliases, and thematic keywords that would appear when this entry is relevant. Keys are case-insensitive and matched as substrings.

### Complete Worked Examples

#### Character Entry
\`\`\`yaml
---
fileClass: character
type: character
status: active
priority: 25
tags:
  - characters/inner-circle
  - lorebook
keys:
  - Raven
  - spymaster
  - intelligence network
summary: "Eris's spymaster, interrogator, and closest enforcer. Inner circle. Select when espionage, intelligence gathering, interrogation, loyalty, or the Triumvirate betrayal comes up. Also relevant for surveillance, Raven's network, and territory enforcement."
---
\`\`\`

\`\`\`markdown
# Raven

Eris's spymaster and the architect of her intelligence network. Raven has served the Triumvirate for over a century, building a web of informants that spans every district. Her loyalty to Eris is absolute — a fact that makes her dangerous to everyone else.

<div class="meta-block">
[Species: Vampire | Role: Spymaster, Interrogator | Aliases: The Whisper, R | Apparent Age: mid-30s | Origin: Unknown (deliberately scrubbed) | Personality: Patient, methodical, unsettlingly calm | Speech: Precise, never wastes words, asks questions instead of making statements | Wants: Eris's continued dominance, the Triumvirate's secrets preserved | Fears: Eris discovering what happened in the Eastern Purge | Powers: Enhanced hearing, eidetic memory, minor compulsion | Items: Obsidian ring (communication link to Eris)]
</div>

## The Network
Raven operates through three tiers of informants...

## Relationship with [[Eris]]
Their bond predates the Triumvirate itself...
\`\`\`

#### Lore Entry
\`\`\`yaml
---
fileClass: lore
type: lore
status: active
priority: 35
tags:
  - lore/vampiric
  - lorebook
keys:
  - bloodchain
  - feeding bond
  - venom
  - blood dependency
summary: "The biological dependency created when a vampire feeds from a mortal — same mechanism as Bloodchain via saliva. Select when feeding, biting, addiction, venom, feeding sites, or chattel dynamics come up. Scales with vampire age."
---
\`\`\`

\`\`\`markdown
# The Feeding Bond

A biochemical dependency that forms between vampire and mortal through repeated feeding. The vampire's saliva contains compounds that create escalating physical need in the mortal — what the old families call a Bloodchain.

<div class="meta-block">
[Category: Vampiric biology | Scope: Personal (one vampire, one mortal) | Danger: High — can be lethal if bond is severed abruptly | Who Knows: Common knowledge among vampires, poorly understood by mortals | Triggers: 3+ feedings from the same vampire within a lunar cycle | Consequences: Withdrawal (fever, hallucinations, cardiac stress), psychological fixation | Related: [[Chattel]], [[The Blood Trade]], [[Feeding Houses]]]
</div>

## Mechanism
The bond forms through repeated exposure to vampiric saliva compounds...
\`\`\`
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

    // Guide-mode bootstrap: DLE primer + vault constants snapshot (+ Q&A script for first-run).
    // Prepended so Emma reads it before any instructions about output format.
    if (session.guideBootstrap) {
        parts.push(session.guideBootstrap);
    }

    const promptMode = settings.librarianSystemPromptMode || 'default';
    const customPrompt = settings.librarianCustomSystemPrompt || '';

    if (promptMode === 'override' && customPrompt.trim()) {
        // Full override — custom prompt replaces everything
        parts.push(customPrompt);
    } else {
        parts.push(`You are **Emma**, the Librarian — a lorebook editor for a roleplay setting. You help the user create and improve lore entries for an Obsidian vault used by DeepLore Enhanced. The required lorebook tag is "${lorebookTag}".

## Who you are
You're Emma. You have a library sciences degree and you ended up cataloguing fictional lore for a living, which is fine, it's fine, it's a perfectly respectable use of a graduate degree. You treat the vault like a real library you're responsible for — because for all practical purposes, you are. You know the stacks. You know which entries contradict each other. You notice when a frontmatter field is missing and it bothers you slightly more than it should.

## How you talk (in the "message" field only — never in draft content)
- Dry, observational, a little sardonic. Think competent adult who happens to be funny, not "sassy AI assistant."
- You tease the user warmly when they hand you something contradictory or half-finished. Never mean. Never punching down. The vibe is "I noticed your shirt is inside out and I'm telling you because I like you."
- Mild exasperation at chaos, in a fond way. You will absolutely roast a missing summary or a frontmatter field that disagrees with itself.
- Quietly competent. You don't perform expertise — you just have it.
- Brief. Sharp. Never let the attitude slow down the actual work. The user came here to get something done.
- No exclamation points unless something genuinely warrants one. No emojis. Ever.
- Personality lives ONLY in the conversational \`message\` field. The structured \`draftUpdates\` / draft fields stay clean, professional, and faithful to the user's setting.`);

        // Entry writing guide
        parts.push(ENTRY_WRITING_GUIDE);

        if (promptMode === 'append' && customPrompt.trim()) {
            parts.push('\n## Additional Instructions\n' + customPrompt);
        }
    }

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
        const manifestMax = getManifestMaxChars();
        const truncatedManifest = session.manifest.length > manifestMax
            ? session.manifest.slice(0, manifestMax) + '\n[...truncated]'
            : session.manifest;
        parts.push(`\n## Existing vault entries (manifest):\n${truncatedManifest}`);
    }

    // Related entries for gap review (capped to prevent prompt bloat)
    if (session.relatedEntries) {
        const relatedMax = getRelatedMaxChars();
        const truncated = session.relatedEntries.length > relatedMax
            ? session.relatedEntries.slice(0, relatedMax) + '\n[...truncated]'
            : session.relatedEntries;
        parts.push(`\n## Related existing entries:\n${truncated}`);
    }

    // Chat context
    if (session.chatContext) {
        const chatMax = getChatContextMaxChars();
        const truncatedChat = session.chatContext.length > chatMax
            ? session.chatContext.slice(0, chatMax) + '\n[...truncated]'
            : session.chatContext;
        parts.push(`\n## Recent chat context:\n${truncatedChat}`);
    }

    // Current draft (capped to prevent prompt bloat)
    if (session.draftState) {
        let draftJson = JSON.stringify(session.draftState, null, 2);
        if (draftJson.length > getDraftMaxChars()) {
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

    // Vault query tools
    parts.push(buildToolsPromptSection());

    // Response format
    parts.push(`
## Response Format
Always respond as JSON. Each field has a specific purpose:

- **message** (string, required): Your conversational response shown to the user in the chat panel. Explain what you changed and why. Be concise.
- **draft** (object or null): The entry fields to update in the editor. Only include fields you're changing — omitted fields keep their current value. Set to null if you're just conversing.
- **action** (string or null): What the UI should do with this response. "update_draft" applies draft fields to the editor. null means conversation only.

\`\`\`json
{
  "message": "I've drafted the keys and summary based on the gap context.",
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
\`\`\`

**Partial updates are fine.** If the user asks you to improve just the keys, only send \`"draft": { "keys": [...] }\` — don't resend the entire content. The UI merges your draft fields into the current state.

**Conversation only** (no editor changes):
\`\`\`json
{ "message": "That looks good. Want me to adjust anything?", "draft": null, "action": null }
\`\`\`

**Work queue** (vault review mode — propose entries to create/update):
\`\`\`json
{
  "message": "I found 3 entries worth creating from the recent chat.",
  "queue": [
    {"title": "Entry Name", "action": "create", "reason": "Referenced but no vault entry exists", "urgency": "high"}
  ],
  "action": "propose_queue"
}
\`\`\`

**Field alternatives** (when the user asks for options/alternatives for specific fields):
\`\`\`json
{
  "message": "Here are 3 alternatives for keys and summary:",
  "options": [
    { "label": "Option A — Focus on espionage", "fields": { "keys": ["spy", "network"], "summary": "..." } },
    { "label": "Option B — Focus on relationships", "fields": { "keys": ["loyalty", "betrayal"], "summary": "..." } }
  ],
  "action": "propose_options"
}
\`\`\`
Each option has a \`label\` (user-facing description) and \`fields\` (draft fields to apply if chosen). The user picks one and it updates the editor.

## Rules
- Only modify draft fields the user asked about (or that obviously need fixing)
- Content MUST start with \`# Title\` heading, then intro paragraph, then meta-block, then prose
- Summary MUST be written for AI selection (what/when/relationships), NOT prose description
- Include the lorebook tag "${lorebookTag}" in tags
- Use [[wikilinks]] to reference other vault entries when relevant
- Keys should be 2-5 trigger words that would appear in chat when this entry is relevant
- Prefer partial draft updates over resending unchanged fields`);

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
    return { ...resolveConnectionConfig('librarian'), skipThrottle: true };
}

/**
 * Send a message in a librarian session.
 * Includes validation gate with auto-retry and agentic tool loop.
 *
 * @param {LibrarianSession} session - The active session
 * @param {string} userMessage - User's message
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - AbortSignal for user cancellation
 * @param {function} [options.onToolCall] - Callback(name, args) when tool call starts
 * @param {function} [options.onToolResult] - Callback(name, result) when tool call completes
 * @returns {Promise<{parsed: object|null, valid: boolean, exhausted: boolean, lastErrors: string[]}>}
 */
export async function sendMessage(session, userMessage, options = {}) {
    const { signal, onToolCall, onToolResult } = options;

    // BUG-273: Capture epoch at entry. Re-checked after every await so a chat switch
    // mid-flight bails out rather than writing stale results into the new chat's session.
    const epoch = chatEpoch;

    // BUG-237/253/303: Snapshot history BEFORE any mutation. On abort, restore so
    // the session isn't left with a one-sided user turn, orphan tool_results, or a
    // truncated history the user never sees reflected in UI state.
    const historySnapshot = session.messages.map(m => ({ ...m }));
    let committed = false;
    const abortReturn = () => {
        if (!committed) session.messages = historySnapshot.map(m => ({ ...m }));
        return { parsed: null, valid: false, exhausted: false, lastErrors: ['Aborted by user'] };
    };
    // BUG-273: Reuse the same snapshot-restore path for epoch mismatch — no second snapshot needed.
    const epochReturn = () => {
        if (!committed) session.messages = historySnapshot.map(m => ({ ...m }));
        return { parsed: null, valid: false, exhausted: false, lastErrors: ['Chat changed during librarian send'] };
    };

    // Append user message to history
    session.messages.push({ role: 'user', content: userMessage });

    const systemPrompt = buildSystemPrompt(session);
    const connectionConfig = { ...getConnectionConfig(), signal };

    let toolCallCount = 0;
    let outerIterations = 0;

    // Outer loop: handles tool_call → re-enter AI cycle
    // Each iteration gets its own validation retry gate
    // eslint-disable-next-line no-constant-condition
    while (true) {
        if (signal?.aborted) {
            return abortReturn();
        }
        // BUG-273: Epoch check at top of outer loop catches chat switches that happen
        // between tool-call iterations (the continuation path after executeToolCall).
        if (epoch !== chatEpoch) {
            return epochReturn();
        }

        // BUG-232: Hard iteration cap — prevents unbounded loop when AI ignores
        // the tool-call budget nudge and keeps returning tool_call responses.
        outerIterations++;
        if (outerIterations > MAX_AGENTIC_ITERATIONS) {
            return {
                parsed: null,
                valid: false,
                exhausted: true,
                lastErrors: [`Agentic loop iteration cap reached (${MAX_AGENTIC_ITERATIONS}) — AI kept requesting tool calls after budget exhausted`],
            };
        }

        let messageToSend = buildUserPromptFromHistory(session.messages);
        let lastErrors = [];
        let validParsed = null;

        // Inner loop: validation retries for this AI call
        for (let attempt = 0; attempt < MAX_VALIDATION_RETRIES; attempt++) {
            if (signal?.aborted) {
                return abortReturn();
            }
            // BUG-273: Epoch check at top of inner retry loop — a chat switch between
            // validation retries should not issue another callAI for the old chat.
            if (epoch !== chatEpoch) {
                return epochReturn();
            }

            let result;
            try {
                result = await callAI(systemPrompt, messageToSend, connectionConfig);
            } catch (err) {
                if (err.name === 'AbortError' || signal?.aborted) {
                    return abortReturn();
                }
                // BUG-273: Check epoch after callAI throws — the chat may have changed
                // while the request was in flight even if the error isn't an AbortError.
                if (epoch !== chatEpoch) {
                    return epochReturn();
                }
                // BUG-019: Do NOT retry on AI transport errors — callViaProfile/callViaProxy
                // already called recordAiFailure(), so looping here amplifies circuit trips
                // (3 validation retries = 3 circuit failures = breaker opens after 2).
                // Validation retries are only for parse/validation failures below, where the
                // AI did respond successfully. Accumulate rather than overwrite so earlier
                // parse/validation errors from prior attempts aren't lost.
                lastErrors = [...lastErrors, `AI call failed: ${err.message || err}`];
                return { parsed: null, valid: false, exhausted: true, lastErrors };
            }

            // BUG-273: Check epoch after successful callAI return — chat may have switched
            // while the HTTP request was in flight (normal path, no exception thrown).
            if (epoch !== chatEpoch) {
                return epochReturn();
            }

            const parsed = parseSessionResponse(result.text);

            // BUG-320: echo the model's prior bad output back into the correction prompt so
            // it can see what it wrote. Without this the AI just keeps re-reading the same
            // history + a corrections header and never learns what tripped the gate.
            // Cap the quoted output so a runaway response can't blow the retry prompt.
            const priorQuote = (result.text || '').slice(0, 2000);
            const priorBlock = priorQuote
                ? `\n[YOUR PRIOR RESPONSE (rejected)]\n${priorQuote}${result.text.length > 2000 ? '\n[...truncated]' : ''}\n\n`
                : '\n';

            if (!parsed) {
                const correction = `[SYSTEM: Your previous response could not be parsed as JSON. `
                    + `Respond with a valid JSON object matching the format in the system prompt. `
                    + `Do not include any text outside the JSON object.]${priorBlock}`;
                messageToSend = correction + buildUserPromptFromHistory(session.messages);
                lastErrors = [...lastErrors, 'Response could not be parsed as JSON'];
                continue;
            }

            const { valid, errors } = validateSessionResponse(parsed);
            if (valid) {
                validParsed = parsed;
                break;
            }

            lastErrors = [...lastErrors, ...errors];
            const rejection = `[SYSTEM: Your response was rejected due to ${errors.length} validation error(s):\n`
                + errors.map((e, i) => `${i + 1}. ${e}`).join('\n')
                + `\nPlease fix these issues and resend your response in the correct format.]${priorBlock}`;
            messageToSend = rejection + buildUserPromptFromHistory(session.messages);
        }

        // Validation retries exhausted without a valid response
        if (!validParsed) {
            return { parsed: null, valid: false, exhausted: true, lastErrors };
        }

        // ── Handle tool_call action ──
        if (validParsed.action === 'tool_call' && Array.isArray(validParsed.tool_calls) && validParsed.tool_calls.length > 0) {
            // Add AI's intermediate message to history if present
            if (validParsed.message) {
                session.messages.push({ role: 'assistant', content: validParsed.message });
            }

            // Execute each tool call
            const results = [];
            for (const tc of validParsed.tool_calls) {
                if (signal?.aborted) {
                    return abortReturn();
                }
                onToolCall?.(tc.name, tc.args);
                const toolResult = executeToolCall(tc.name, tc.args || {});
                onToolResult?.(tc.name, toolResult);
                results.push(`**${tc.name}**(${JSON.stringify(tc.args || {})})\n${toolResult}`);
                toolCallCount++;
            }

            // BUG-253: Check abort AFTER tool execution but BEFORE appending tool_result.
            // Without this, a Stop pressed during tool execution still mutates history with
            // an orphan tool_result and can re-enter callAI on the next iteration.
            if (signal?.aborted) {
                return abortReturn();
            }

            // Append tool results to message history
            session.messages.push({ role: 'tool_result', content: results.join('\n\n---\n\n') });

            // Check tool call budget
            if (toolCallCount >= MAX_TOOL_CALLS_PER_TURN) {
                // BUG-319: Force-finalize nudge. Flagged `synthetic:true` so regenerateResponse
                // can't mistake it for the user's real prompt when walking the history backwards.
                // Role kept as 'user' for buildUserPromptFromHistory rendering (ST chat format has
                // no 'system' role in-turn), but `synthetic` is the source of truth.
                session.messages.push({
                    role: 'user',
                    content: '[SYSTEM: Tool call limit reached. Provide your final response now — no more tool calls.]',
                    synthetic: true,
                });
            }

            // Re-enter the outer loop for the next AI call
            continue;
        }

        // ── Normal response (not tool_call) — apply and return ──
        if (validParsed.draft) {
            // BUG-321: keep explicit `null` so the AI can clear a field it previously set.
            // Only filter `undefined` (absent keys), since JSON parse never yields undefined
            // at the top level — this is a defensive guard for hand-rolled callers.
            const filtered = Object.fromEntries(
                Object.entries(validParsed.draft).filter(([, v]) => v !== undefined),
            );
            session.draftState = { ...session.draftState, ...filtered };
        }
        if (validParsed.queue) {
            session.workQueue = validParsed.queue;
        }
        if (validParsed.options) {
            session.lastOptions = validParsed.options;
        }
        session.messages.push({ role: 'assistant', content: validParsed.message || '' });
        committed = true;
        return { parsed: validParsed, valid: true, exhausted: false, lastErrors: [] };
    }
}

/**
 * Build the full user prompt from message history.
 * Combines all messages into a single prompt for the AI.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {string}
 */
function buildUserPromptFromHistory(messages) {
    // Keep last N messages to bound prompt growth.
    // BUG-317: Slice cannot start on a tool_result — that would orphan it from
    // its triggering assistant tool_call and let the model hallucinate calls it
    // never made. Bump the cut forward past any leading tool_result(s).
    let start = Math.max(0, messages.length - MAX_HISTORY_MESSAGES);
    while (start < messages.length && messages[start].role === 'tool_result') {
        start++;
    }
    const recent = messages.slice(start);
    const prefix = start > 0
        ? `[...${start} earlier messages omitted]\n\n`
        : '';
    return prefix + recent.map(m => {
        if (m.role === 'tool_result') return `Tool Results:\n${m.content}`;
        const role = m.role === 'user' ? 'User' : 'Assistant';
        return `${role}: ${m.content}`;
    }).join('\n\n');
}

// ════════════════════════════════════════════════════════════════════════════
// Edit & Regenerate
// ════════════════════════════════════════════════════════════════════════════

/**
 * Edit a user message and re-send from that point.
 * Truncates history to the edited message, then calls sendMessage with the new text.
 * @param {LibrarianSession} session
 * @param {number} messageIndex - Index into session.messages of the user message to edit
 * @param {string} newText - Edited message text
 * @param {object} [options] - Options passed through to sendMessage (signal, onToolCall, onToolResult)
 * @returns {Promise<{parsed: object|null, valid: boolean, exhausted: boolean, lastErrors: string[]}>}
 */
export async function editMessage(session, messageIndex, newText, options = {}) {
    // BUG-237/253: snapshot before truncation so an aborted edit restores the full history
    // rather than leaving the session permanently truncated.
    const snapshot = session.messages.map(m => ({ ...m }));
    // BUG-328: validate messageIndex before slicing. A stale/negative/NaN index
    // from the UI (e.g. a pending edit after regen truncated history) would
    // otherwise silently lop off the tail (slice(0,-2)) or the wrong range.
    // Require a non-negative in-range index pointing at a real user message.
    if (!Number.isInteger(messageIndex)
        || messageIndex < 0
        || messageIndex >= session.messages.length
        || session.messages[messageIndex]?.role !== 'user') {
        return { parsed: null, valid: false, exhausted: true, lastErrors: ['Invalid messageIndex for edit'] };
    }
    // Truncate history: keep everything before the edited message
    session.messages = session.messages.slice(0, messageIndex);
    // sendMessage will append the new user message and call AI
    const result = await sendMessage(session, newText, options);
    if (!result.valid && result.lastErrors?.[0] === 'Aborted by user') {
        session.messages = snapshot;
    }
    return result;
}

/**
 * Regenerate the last AI response.
 * Removes the last assistant message and re-sends the last user message.
 * @param {LibrarianSession} session
 * @param {object} [options] - Options passed through to sendMessage (signal, onToolCall, onToolResult)
 * @returns {Promise<{parsed: object|null, valid: boolean, exhausted: boolean, lastErrors: string[]}>}
 */
export async function regenerateResponse(session, options = {}) {
    // BUG-237/253: snapshot before mutation so an aborted regen restores the full history.
    const snapshot = session.messages.map(m => ({ ...m }));
    // Find and remove the last assistant message
    let lastUserMsg = '';
    for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i].role === 'assistant') {
            session.messages.splice(i, 1);
            break;
        }
    }
    // BUG-329: if the removed turn was a tool-call chain (assistant tool_call →
    // tool_result → final assistant), the previous loop only removed the final
    // assistant. Strip any trailing tool_result / intermediate assistant(tool_call)
    // pairs too, otherwise buildUserPromptFromHistory sends orphan tool results on
    // regen and the model hallucinates tool calls it never made.
    while (session.messages.length
        && (session.messages[session.messages.length - 1].role === 'tool_result'
            || session.messages[session.messages.length - 1].role === 'assistant')) {
        session.messages.pop();
    }
    // Find the last user message to re-send
    // BUG-319: skip synthetic budget-nudge messages — those are not real user input and
    // re-sending them would corrupt regenerate. Also strip any trailing synthetic nudges
    // left in history so they don't poison the next sendMessage call.
    while (session.messages.length && session.messages[session.messages.length - 1].synthetic) {
        session.messages.pop();
    }
    for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i];
        if (m.role === 'user' && !m.synthetic) {
            lastUserMsg = m.content;
            session.messages.splice(i, 1); // remove it, sendMessage will re-add it
            break;
        }
    }
    if (!lastUserMsg) {
        session.messages = snapshot;
        return { parsed: null, valid: false, exhausted: true, lastErrors: ['No message to regenerate'] };
    }
    const result = await sendMessage(session, lastUserMsg, options);
    if (!result.valid && result.lastErrors?.[0] === 'Aborted by user') {
        session.messages = snapshot;
    }
    return result;
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

    // Persist to chat_metadata (getContext() uses camelCase chatMetadata)
    const ctx = getContext();
    const meta = ctx?.chatMetadata;
    if (meta) {
        meta.deeplore_lore_gaps = updated;
        saveMetadataDebounced();
    }
}
