# AI Notepad

The AI Notepad lets the AI keep private session notes -- things it wants to remember across messages but shouldn't say out loud. Character motivations, unspoken thoughts, plot threads to revisit, relationship shifts, revealed secrets. Notes are automatically hidden from the chat and reinjected into future messages as context.

This is different from the **Author's Notebook** (`/dle-notebook`), which is written by you. The AI Notepad is written by the AI.

## How It Works

There are two modes:

### Tag Mode (Default)

The AI is instructed to write notes inside `<dle-notes>` tags at the end of its response. After generation:

1. DLE scans the response for `<dle-notes>...</dle-notes>` blocks
2. The notes are extracted and stripped from the visible message
3. Extracted notes are appended to the chat's accumulated note store
4. On the next generation, all stored notes are injected back as system context

The reader never sees the tags. The AI gets its notes back every turn.

### Extract Mode

The AI writes normally with no special tags. After generation, a separate API call sends the AI's response to a second model (configurable) that extracts noteworthy details:

1. DLE sends the latest AI response + previous notes to the extraction model
2. The extraction model returns bullet points of anything worth remembering (or `NOTHING_TO_NOTE`)
3. Notes are appended to the chat's accumulated note store

Extract mode is useful when your primary model doesn't reliably follow the `<dle-notes>` tag format, or when you don't want to burden it with extra instructions.

## Enabling

1. Open **Settings** (gear icon in the Drawer, or the extension settings panel)
2. Go to the **Features** tab
3. Check **AI Notepad Enabled**
4. Choose **Tag** or **Extract** mode
5. If using Extract mode, configure the AI connection (Profile or Proxy)

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | Off | Master toggle |
| Mode | Tag | `tag` (AI writes tags) or `extract` (separate API call) |
| Position | In Chat | Where notes are injected (same options as injection position) |
| Depth | 4 | Injection depth in chat context |
| Role | System | Injection role (system, user, or assistant) |
| Instruction Prompt | (built-in) | Custom prompt override for tag mode instructions |
| Extract Prompt | (built-in) | Custom prompt override for extract mode |
| Connection Mode | Profile | `profile` (ST Connection Manager) or `proxy` (CORS proxy) |
| Profile ID | -- | Which ST profile to use for extract mode |
| Proxy URL | localhost:42069 | Proxy endpoint for extract mode |
| Model | -- | Model override for extract mode |
| Max Tokens | 1024 | Token limit for extraction API call (256-4096) |
| Timeout | 30s | API timeout for extraction (5-120s) |

## Viewing and Editing Notes

**`/dle-ai-notepad`** -- Opens a popup showing all accumulated notes for the current chat, with a live token counter. You can edit the notes manually and save.

**`/dle-ai-notepad clear`** -- Clears all notes for the current chat.

Notes are also visible per-message in the **Context Cartographer** popup (the sources button on AI messages).

## How Notes Are Stored

Notes are stored in `chat_metadata.deeplore_ai_notepad` as a plain text string. They persist with the chat -- switching chats loads that chat's notes, and notes survive page reloads.

Each message's extracted notes are also saved on `message.extra.deeplore_ai_notes` for per-message inspection.

## How Notes Are Injected

On each generation, stored notes are wrapped in markers and injected into the context:

```
[Your previous session notes]
- Eris revealed she knows about the betrayal but hasn't confronted Kael yet
- The seal on the northern gate is weakening -- mentioned twice now
- Player character promised to return the artifact by the festival
[End of session notes]
```

In tag mode, the instruction prompt is appended after the notes, telling the AI how to use `<dle-notes>` tags.

## Tips

- **Tag mode works best with capable models** (Claude, GPT-4, etc.) that reliably follow formatting instructions. Smaller models may forget the tags or put them in the wrong place.
- **Extract mode is more reliable** but costs an extra API call per generation. Good for local models that don't follow tags well.
- **Edit notes periodically** with `/dle-ai-notepad` to prune stale information. The notes grow every turn and eventually waste tokens on outdated context.
- **Custom prompts** let you steer what the AI tracks. For example, you could instruct it to only track relationship changes and ignore combat details.

## See Also

- [[Features]] -- Feature overview
- [[Injection and Context Control]] -- How injection position/depth/role works
- [[Slash Commands]] -- `/dle-ai-notepad` reference
