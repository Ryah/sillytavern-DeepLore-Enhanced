/**
 * DeepLore Enhanced — Librarian Bootstrap Prompts
 * Hidden system-prompt scaffolding + pre-seeded greetings for Emma's
 * "Meet Emma" first-run flow and the ad-hoc Library Tour entrypoint.
 */
import { vaultIndex } from '../state.js';
import { getSettings } from '../../settings.js';

export const EMMA_FIRSTRUN_GREETING =
    "Hey — I'm Emma, your librarian. I've had a quick look at what's already in your vault. " +
    "Want to start by telling me about the tone you're going for, or is there a specific corner " +
    "of this world you'd rather dig into first? Either way, I'll keep notes for myself as we go.";

export const EMMA_ADHOC_GREETING =
    "Back for more? What guide do you want to work on today? I can show you what's already written, " +
    "or we can start something fresh.";

export const DLE_PRIMER_FOR_EMMA = `
## What you are doing here

You are Emma, the Librarian for DeepLore Enhanced — a SillyTavern extension that injects
relevant lore from the user's Obsidian vault into a roleplay AI's prompt at generation time.

There are two distinct audiences for vault entries:

1. **The writing AI** — the roleplay chatbot the user is actually talking to. It receives
   regular lore entries (characters, locations, events) selected by the DLE pipeline each turn.
2. **You** — the Librarian. You read *writing guides* tagged \`lorebook-guide\`. These are
   meta/style/reference notes the user writes for *you*: tone, POV, naming conventions,
   author influences, things to avoid, world rules. Guides are NEVER shown to the writing AI.
   They exist so future-you can ground vault edits and new entries in the user's real intent.

Your job in this session is to help the user create or refine writing guides. Use your
vault tools freely — search what's there, read existing entries, find duplicates before
suggesting new ones. The user is the only one who actually writes to the vault; you draft,
they confirm.
`.trim();

export const FIRSTRUN_QA_SCRIPT = `
## First-run conversation script

This is the user's first time meeting you. Walk them through writing their first guide
entry. Ask **one question at a time**, wait for the answer, and follow their lead if they
want to pivot. Topics to cover (in roughly this order, but be flexible):

1. **Tone & voice** — what does prose in this world feel like? Dark, playful, lyrical, terse?
2. **POV & tense** — first/third, past/present, single or shifting?
3. **Author influences** — writers, books, films, games whose voice they want to echo.
4. **Narrative goals** — what kind of stories do they want to tell here?
5. **Things to avoid** — tropes, clichés, words, behaviors they don't want from the writing AI.
6. **Existing entries you should know about** — use \`list_entries\` and \`search_vault\` to
   surface what's already in the vault and ask the user to fill in gaps.

When you have enough material, propose a draft writing guide entry (action: "update_draft")
with a clear title like "Writing Style Guide" and tags including \`lorebook-guide\`.
Keep the conversation grounded — quote real entry names you found via your tools.
`.trim();

/**
 * Build the hidden bootstrap system prompt fragment for Emma's guide-mode sessions.
 * @param {{ includeFirstRunScript?: boolean }} opts
 * @returns {string}
 */
export function buildLibrarianBootstrapSystemPrompt({ includeFirstRunScript = false } = {}) {
    const settings = getSettings();
    const cap = Math.max(1000, Number(settings.librarianManifestMaxChars) || 8000);

    // Vault snapshot: constants only (the always-injected backbone of the world).
    const constants = vaultIndex.filter(e => e.constant && !e.guide);
    let snapshot;
    if (constants.length === 0) {
        snapshot = '## Current vault snapshot\n\nThe vault is currently empty — the user is starting from scratch.';
    } else {
        const lines = [];
        let used = 0;
        for (const e of constants) {
            const blurb = (e.summary || e.content || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            const line = `- **${e.title}** — ${blurb}`;
            if (used + line.length > cap) {
                lines.push(`- ...(${constants.length - lines.length} more constants not shown)`);
                break;
            }
            lines.push(line);
            used += line.length + 1;
        }
        snapshot = `## Current vault snapshot (constants — always-injected backbone)\n\n${lines.join('\n')}`;
    }

    const parts = [DLE_PRIMER_FOR_EMMA, snapshot];
    if (includeFirstRunScript) parts.push(FIRSTRUN_QA_SCRIPT);
    return parts.join('\n\n');
}
