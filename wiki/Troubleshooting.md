# Troubleshooting

Common issues and how to fix them. Run `/dle-health` first — it catches most problems automatically.

## Connection Issues

### "Connection failed" or "ECONNREFUSED"
- **Check:** Is Obsidian running?
- **Check:** Is the Local REST API plugin enabled in Obsidian settings?
- **Check:** Does the port in DeepLore settings match the REST API plugin port? (Default: 27124 for HTTPS, 27123 for HTTP)
- **Check:** Is another application using the same port?
- **Try:** Restart Obsidian, then click **Test All** in DeepLore settings

### "Authentication failed" (401/403)
- **Check:** Your API key matches what's shown in Obsidian → Settings → Local REST API
- **Check:** You copied the full key without extra spaces
- **Try:** Regenerate the API key in the REST API plugin and paste it fresh

### "Obsidian connection timed out"
- **Check:** Obsidian is not frozen or unresponsive
- **Check:** No firewall is blocking localhost connections
- **Check:** The REST API plugin is enabled (not just installed)
- **Try:** Increase the cache TTL in Index & Cache settings to reduce connection frequency

### HTTPS Certificate Not Trusted

If you're using HTTPS (port 27124) and getting "Failed to fetch" or "Certificate not trusted" errors, the browser is blocking the connection because the Local REST API plugin uses a self-signed certificate.

**Option 1: Switch to HTTP (easiest)**
1. In Obsidian, open Settings → Local REST API
2. Ensure "Enable Non-Encrypted (HTTP) Server" is **ON**
3. In DeepLore settings, **uncheck HTTPS** and set port to `27123`

**Option 2: Trust the certificate**
1. Open `https://127.0.0.1:27124` directly in your browser
2. Accept the security warning / add exception
3. See the [Local REST API certificate guide](https://github.com/coddingtonbear/obsidian-web/wiki/Troubleshooting%3A-Certificate-Trust-Issues) for detailed steps per platform

> DeepLore automatically detects certificate issues and shows a guidance popup with both options when a connection test fails.

## Entries Not Matching

### Keywords not triggering
- **Run:** `/dle-inspect` after sending a message — check the "keyword matches" section
- **Check:** Scan depth is not 0 (Settings → Matching & Budget)
- **Check:** Keywords are in the entry's `keys:` frontmatter field (not just in the content)
- **Check:** "Match Whole Words" setting — if enabled, "ai" won't match "artificial"
- **Check:** "Case Sensitive" setting — if enabled, "Eris" won't match "eris"
- **Check:** The entry has the correct lorebook tag (default: `lorebook`)

### Entries matching but not injecting
- **Check:** Token budget — entry may be cut for space. Run `/dle-inspect` to see "budget cut" entries
- **Check:** Gating rules — entry may have `requires` or `excludes` that aren't met
- **Check:** Contextual gating — if you've set era/location/scene filters, entries may be gated out
- **Check:** Per-chat blocks — run `/dle-pins` to see if the entry is blocked
- **Check:** Cooldown — entry may have a cooldown period active
- **Check:** Re-injection cooldown setting — entry may be skipped due to recent injection
- **Check:** Strip duplicate injections — entry may be deduped from recent generations

### Too many entries matching (noisy results)
- **Fix:** Make keywords more specific
- **Fix:** Lower the scan depth (fewer messages scanned = fewer matches)
- **Fix:** Use priority values to ensure important entries win budget allocation
- **Fix:** Enable AI search (Two-Stage mode) to let AI filter out irrelevant matches

## AI Search Issues

### "AI search failed — using keyword fallback"
- **Timed out:** Increase the AI Search timeout setting (default: 10s)
- **Auth error:** Check your connection profile or proxy API key
- **Profile not found:** Select a profile in AI Search settings, or create one in Connection Manager
- **Network error:** Check the proxy URL, or verify your connection profile works in Connection Manager
- **Server error:** The API provider may be down — try again later

### AI search returning empty results
- **Check:** Entries have `summary:` fields — AI search relies on summaries to decide relevance
- **Check:** AI search scan depth is not too low (needs enough chat context to judge relevance)
- **Try:** Run `/dle-status` to verify AI search is enabled and configured
- **Try:** Switch from AI-only to Two-Stage mode — it uses keywords as a safety net

### AI search too expensive
- **Fix:** Use Two-Stage mode instead of AI-only (keywords pre-filter, reducing AI workload)
- **Fix:** Use a cheaper/faster model (Claude Haiku, GPT-4o-mini)
- **Fix:** Reduce `aiSearchManifestSummaryLength` to send less text per entry
- **Fix:** Check `/dle-status` for cache hit rate — high cache hits mean fewer API calls

### "AI Search Throttled"
- AI calls are rate-limited to a minimum of 2 seconds between requests. If you're regenerating rapidly, the AI call is skipped and keywords are used instead.
- **Not a bug.** The throttle prevents request flooding and protects your API budget.
- The throttle does not count as a failure — it won't trip the AI circuit breaker.

### AI search timing out with local LLMs
- Local models (e.g., Magistry 24B, Qwen, Mistral) are often significantly slower than cloud APIs and may need 60-120 seconds to respond, especially on longer chats.
- The default AI search timeout is 10,000ms (10 seconds), which is tuned for fast cloud APIs.
- **Fix:** Increase the timeout in Settings → AI tab → Show Advanced → Timeout. Values of 60000-120000ms (60-120 seconds) are common for local models. The same applies to Scribe and Auto-Suggest timeouts in their respective tabs.

### AI circuit breaker tripped
- After 2 consecutive AI failures (timeouts, errors), the circuit breaker trips and AI search is disabled for 30 seconds.
- During this period, the pipeline falls back to keyword-only matching.
- After 30 seconds, a single "half-open" probe is allowed. If it succeeds, the circuit breaker resets and AI search resumes normally.
- **Fix:** Check your connection profile or proxy URL. Run `/dle-status` to see circuit breaker state.

### Per-vault circuit breaker
- In multi-vault setups, each vault (identified by host:port) has its own independent circuit breaker with exponential backoff (2s → 4s → 8s → 15s max).
- One vault being unreachable does not block the others — entries from healthy vaults are still indexed.
- **Fix:** Check that the Obsidian REST API plugin is running on the affected vault's port.

## Lore Not Injecting

### Extension enabled but nothing happens
1. Run `/dle-refresh` to rebuild the index
2. Check the header badge — does it show entries? If "0 entries", your notes aren't being indexed
3. Run `/dle-health` for a full diagnostic
4. Check the browser console (F12) for `[DLE]` error messages

### "No vault entries loaded"
- **No tagged notes:** Make sure at least one note has the lorebook tag in its frontmatter `tags:` field
- **Wrong tag:** Check that the lorebook tag in settings matches what's in your notes (default: `lorebook`)
- **Connection failed:** The vault connection test should be green. If not, fix the connection first

### Entries injecting in wrong position
- **Check:** Injection settings (before/after prompt, or in-chat with depth)
- **Check:** Per-entry overrides — entries can have their own `position`, `depth`, and `role` in frontmatter
- **Check:** In prompt_list mode, drag the DeepLore entries in Prompt Manager to your preferred position

## Cache and Sync Issues

### Stale entries (edits in Obsidian not showing up)
- **Quick fix:** Run `/dle-refresh` to force a full rebuild
- **Check:** Cache TTL setting — if set high (e.g., 300s), changes take up to 5 minutes to appear
- **Check:** Sync polling interval — controls how often DeepLore checks for changes in the background
- **Fix:** Lower cache TTL to 60-120s for faster updates during active editing

### "Index refresh timed out"
- Obsidian is taking too long to respond. This happens with very large vaults (1000+ notes)
- **Try:** Restart Obsidian and try again
- **Check:** No other plugins are hogging Obsidian's resources

## Extension Causes Errors

### JavaScript errors in console
1. Open browser console (F12) and filter for `[DLE]`
2. Note the exact error message
3. Try disabling the extension, refreshing, and re-enabling
4. If the error persists, [report it on GitHub](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues) with the error message

### Extension freezes SillyTavern
- This can happen if the generation lock gets stuck
- **Quick fix:** Run `/dle-refresh` in chat to reset the lock
- If chat input is frozen, refresh the page — the lock auto-recovers after 90 seconds

### Conflicts with other extensions
- DeepLore uses `setExtensionPrompt()` for injection, which is standard ST API
- If another extension also uses `generate_interceptor`, they may conflict
- **Try:** Disable other lorebook/world-info extensions and test
- In prompt_list mode, conflicts are less likely since entries integrate with Prompt Manager

## Still Stuck?

1. Run `/dle-health` and review all errors and warnings
2. Check browser console (F12) for `[DLE]` messages
3. Run `/dle-status` to see the full extension state
4. [Open an issue on GitHub](https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues) with:
   - Your DeepLore Enhanced version
   - The error message or unexpected behavior
   - Steps to reproduce
   - `/dle-status` output
