# AI Search

AI search adds a semantic understanding layer on top of keyword matching. Instead of only matching exact keywords, an AI model reads the recent chat context alongside a compact manifest of vault entries and selects which ones are contextually relevant, even when no exact keywords appear in the conversation.

This is the feature that makes DeepLore Enhanced different from base DeepLore.

---

## How It Works

When the **Search Mode** dropdown is set to Two-Stage or AI Only, every generation goes through a two-part process:

1. **Build a manifest.** A compact summary of candidate entries is assembled (see [Manifest Format](#manifest-format) below)
2. **Ask the AI.** The manifest, a system prompt, and recent chat messages are sent to an AI model, which returns a JSON array of selected entries with confidence levels and reasons

The AI's selections (plus any constant/bootstrap entries) become the final set of entries injected into the prompt. See [[Pipeline]] for where AI search fits in the full generation flow.

---

## Search Modes

DeepLore Enhanced offers two AI search modes, selected via the **Search Mode** dropdown in [[Settings Reference]]. The third option, **Keyword Only**, disables AI search entirely.

### Two-Stage (default)

Keywords run first as a broad pre-filter. Only keyword-matched candidates are sent to the AI for final selection. This is the recommended mode because it keeps the manifest small (fewer tokens, lower cost, faster responses).

| Step | What happens |
|------|--------------|
| 1. Keyword scan | Matches entries against recent chat using `keys` |
| 2. Build manifest | Only keyword-matched entries are included |
| 3. AI selection | AI picks the most relevant from the candidates |
| 4. Output | AI selections + constants = final injection set |

**Error fallback:** If the AI returns an error or times out, the keyword results are used as-is. If the AI intentionally returns an empty array `[]`, only constants are injected.

### AI Only

Skips keyword matching entirely. A manifest of **all** non-constant vault entries is sent to the AI. More thorough (the AI can find entries that have no keyword overlap with the chat) but uses more tokens and takes longer.

| Step | What happens |
|------|--------------|
| 1. Build manifest | All non-constant entries are included |
| 2. AI selection | AI picks the most relevant from the full vault |
| 3. Output | AI selections + constants = final injection set |

**Error fallback:** If the AI returns an error or times out, the full vault is used, sorted by priority. If the AI intentionally returns an empty array `[]`, only constants are injected.

---

## Connection Modes

AI search needs an AI model to call. DeepLore Enhanced supports two ways to connect.

### Connection Profile (recommended)

Uses a saved SillyTavern Connection Manager profile. Any provider works: Anthropic, OpenAI, OpenRouter, local models, anything you have set up in SillyTavern.

- No separate proxy or server needed
- Calls are made client-side via `ConnectionManagerRequestService`
- You can override the model (e.g., use a cheap/fast model like Haiku even if your profile defaults to a larger model)
- The profile dropdown shows all compatible saved profiles

**Setup:** In AI Search settings, set connection mode to **Connection Profile**, select a profile from the dropdown, and optionally set a model override. Click **Test AI Search** to verify.

### Custom Proxy

Routes AI requests through an external proxy server that exposes an Anthropic-compatible Messages API at `/v1/messages`. Requests are routed through SillyTavern's built-in CORS proxy (`enableCorsProxy: true` required in `config.yaml`).

This mode exists primarily for [claude-code-proxy](https://github.com/horselock/claude-code-proxy) users.

**Setup:** In AI Search settings, set connection mode to **Custom Proxy**, enter the proxy URL (e.g., `http://localhost:42069`), set the model name (e.g., `claude-haiku-4-5-20251001`), and click **Test AI Search** to verify. Make sure `enableCorsProxy: true` is set in `config.yaml`.

---

## Manifest Format

The manifest is a compact representation of entries sent to the AI. Each entry looks like this:

```
EntryName (150tok) -> LinkedEntry1, LinkedEntry2
Summary or truncated content text. May include [Triggers: ...] [Related: ...] metadata.
---
NextEntry (80tok)
Summary of the next entry.
---
```

- **`(Ntok)`:** Estimated token cost of the full entry content. Helps the AI consider budget when selecting.
- **`->`:** Shows wikilink relationships to other entries. Helps the AI follow relationship chains.
- **Summary text:** Comes from the `summary` frontmatter field if present. Otherwise, the entry content is truncated to the **Manifest Summary Length** setting (default 600 characters).

The manifest also includes a header that tells the AI:
- How many candidate entries are in the manifest
- Total number of non-constant selectable entries from the candidate pool (in two-stage mode this is the keyword-matched count, not the full vault count)
- How many entries are always included (constants) and their token cost
- Token budget (if not unlimited)

### Why `summary` Fields Matter

If an entry has a `summary` in its frontmatter, that summary is used in the manifest instead of truncated content. Good summaries help the AI make better selections because they describe *when* to select the entry, not just what the entry contains. See [[Writing Vault Entries]] for summary guidelines.

---

## The AI System Prompt

The default system prompt instructs the AI to:

- Act as a lore librarian for a roleplay session
- Select up to `{{maxEntries}}` entries (replaced with your Max Entries setting)
- Follow a priority order for selection:
  1. **Direct references:** Characters, places, items, or events explicitly mentioned
  2. **Active context:** Current location, present characters, ongoing events
  3. **Relationship chains:** Follow `->` links between related entries
  4. **Metadata triggers:** Match `[Triggers: ...]` fields against the conversation
  5. **Thematic relevance:** Tone and theme matching (betrayal, romance, combat, etc.)
- Prefer fewer, highly relevant entries over many loosely related ones
- Consider token cost when selecting
- Return a JSON array: `[{"title": "...", "confidence": "high|medium|low", "reason": "..."}]`
- Return `[]` if nothing is relevant

You can fully customize the system prompt in [[Settings Reference]]. The `{{maxEntries}}` placeholder is supported in custom prompts.

---

## Caching (Sliding Window)

AI search uses a sliding window cache strategy to minimize redundant API calls:

- The **manifest** and **chat context** are hashed separately
- If both hashes match the previous call, cached results are reused (exact match)
- If the manifest hash matches but chat has new messages, the cache checks whether the new messages contain any **entity names or keys** from the vault:
  - If no vault entities are mentioned in the new messages, cached results are reused (the new messages are irrelevant to lore selection)
  - If vault entities are mentioned, the cache is invalidated and a fresh AI call is made
- **Regenerations and swipes** always reuse cached results (same chat context)
- The cache is **single-entry**, storing only the most recent result
- Cache is cleared on chat change

Cache hits are tracked in the AI Stats display (see below).

---

## New Chat Behavior

When the chat is below the **New Chat Threshold** (default 3 messages), AI search behaves differently to help the AI understand a new conversation:

### Seed Entries

Entries tagged with `#lorebook-seed` have their full content sent to the AI as **story context**, prepended before the chat messages. This gives the AI rich setting information even when the chat itself contains very little.

### Bootstrap Entries

Entries tagged with `#lorebook-bootstrap` are **force-injected** like constants and removed from the manifest. They provide essential context for the start of a conversation.

### Aggressive Selection

On new chats, the AI is instructed to fill to `maxEntries - constantCount` selections instead of being conservative. This ensures rich context from the very first message.

See [[Writing Vault Entries]] for how to tag entries as seed or bootstrap.

---

## Error Handling

AI search is designed to degrade gracefully:

| Situation | Two-Stage behavior | AI-Only behavior |
|-----------|-------------------|-----------------|
| AI returns error | Fall back to keyword results | Fall back to full vault (sorted by priority) |
| AI times out | Same as error | Same as error |
| AI returns `[]` | Only constants injected | Only constants injected |
| AI response unparseable | Same as error | Same as error |
| No chat context | Skip AI search entirely | Skip AI search entirely |
| AI search disabled | Keywords only (base DeepLore behavior) | N/A |

The timeout is configurable (default 10,000ms, range 1,000-30,000ms).

---

## AI Stats

The AI Search section of the settings panel displays session statistics:

- **AI Calls:** Number of API calls made this session
- **Cache Hits:** Number of times cached results were reused
- **Input Tokens:** Estimated total input tokens sent (proxy mode only; profile mode does not report usage)
- **Output Tokens:** Estimated total output tokens received (proxy mode only)

These stats are **session-scoped** — they accumulate across chat switches and reset only on page refresh. This is intentional: they track your total AI search usage for the browser session, not per-chat.

---

## Hierarchical Manifest Clustering

For large vaults (40+ selectable entries with 4+ distinct categories), AI search automatically uses a two-call approach:

1. **Cluster entries by category** — categories are extracted from tags and type fields
2. **First AI call: category selection** — a compact category manifest is sent to the AI, which selects relevant categories
3. **Second AI call: entry selection** — only entries in the selected categories are included in the normal manifest

**Safety valve:** If the category filter removes more than 80% of entries, the pre-filter is skipped and the full manifest is used instead. This prevents overly aggressive AI category selection from hiding relevant entries.

**When it activates:** Automatically when the vault has 40+ selectable (non-constant) entries and 4+ distinct categories. No settings to configure.

---

## Prompt Cache Optimization

In **Custom Proxy mode**, the manifest is placed first in the message payload with `cache_control` breakpoints. This leverages Anthropic's prompt caching: the manifest (which rarely changes between calls in the same chat) is cached server-side, reducing token costs on subsequent calls.

This only applies to Custom Proxy mode. Connection Profile mode does not support `cache_control` breakpoints.

---

## Scribe-Informed Retrieval

When enabled, the Session Scribe's latest summary is fed into the AI search context as additional story background. This gives the AI search a broader narrative perspective beyond just the most recent chat messages.

**Setup:** Enable "Scribe-Informed Retrieval" in [[Settings Reference|AI Search settings]].

---

## Confidence-Gated Budget

AI search over-requests entries from the AI (2x the configured max entries), then sorts the results by confidence tier:

1. **High confidence** entries are prioritized
2. **Medium confidence** entries fill remaining budget
3. **Low confidence** entries only if budget remains

This ensures that when budget is limited, the most relevant entries are always included.

---

## Performance Tips

- **Write `summary` fields** on your entries. This avoids content truncation in the manifest and gives the AI better information for selection. See [[Writing Vault Entries]].
- **Use Two-Stage mode** to reduce manifest size. Keywords pre-filter the candidates, so the AI only sees relevant entries instead of the entire vault.
- **Keep Manifest Summary Length reasonable.** The default of 600 characters is a good balance. Longer summaries use more tokens; shorter ones give the AI less to work with.
- **Keep AI Scan Depth low.** The default of 4 messages is usually sufficient. Higher values send more chat history to the AI, increasing token cost.
- **Use a fast, cheap model.** The AI search task is simple classification. Haiku-class models handle it well and respond quickly. You do not need a frontier model for this.
- **Let caching work for you.** Regenerations and swipes are free (cached). The sliding window cache is even smarter — new messages that don't mention vault entities also reuse cached results.
- **Enable Scribe-Informed Retrieval** if you use Session Scribe. The narrative context helps the AI make better selections for ongoing story arcs.

---

## Related Pages

- [[Pipeline]]: Where AI search fits in the full generation flow
- [[Settings Reference]]: All AI search settings documented
- [[Writing Vault Entries]]: How to write entries and summaries that work well with AI search
- [[Features]]: Overview of all DeepLore Enhanced features
- [[Installation]]: How to set up AI search connections
