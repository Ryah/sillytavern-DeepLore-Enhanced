# Infrastructure

Under-the-hood systems that make DeepLore Enhanced fast, reliable, and cost-efficient. These features are mostly automatic — you don't need to configure them, but understanding them helps when troubleshooting.

---

## Multi-Vault Support

Connect multiple Obsidian vaults simultaneously. Each vault has its own port and API key. Entries from all enabled vaults are merged into a single index.

**Setup:**
1. In the "Vault Connections" section, click "Add Vault" to add multiple vault connections
2. Each vault has a name, port, API key, and enable toggle
3. Click "Test All" to verify all connections

**Notes:**
- Entries from all enabled vaults are merged and treated identically
- Each entry tracks its `vaultSource` for diagnostics
- The health check validates multi-vault configuration

---

## IndexedDB Persistent Cache

The parsed vault index is saved to IndexedDB (`DeepLoreEnhanced` database, `vaultCache` store) after every successful build. On page load, the extension hydrates from IndexedDB instantly (no Obsidian call needed), then validates against Obsidian in the background.

**Benefits:**
- Near-instant startup — lore is available before the first generation
- Works even if Obsidian is briefly unreachable on page load
- Automatic — no settings to configure

---

## Reuse Sync

When auto-sync triggers, the extension fetches all vault file contents but avoids redundant work:
1. Fetches all file contents from Obsidian (local fetch is fast)
2. Computes content hashes and compares against the existing index
3. Reuses already-parsed entries for unchanged files (skips parse + tokenize)
4. Re-parses only new or modified files
5. Removes entries for deleted files
6. Falls back to full rebuild if the reuse approach fails

The savings come from skipping the expensive parse/tokenize step for unchanged entries, not from reducing network calls.

---

## Vault Change Detection & Auto-Sync

When the index rebuilds, DeepLore compares the new index against the previous one and reports changes.

**Detects:**
- New entries added
- Entries removed
- Modified content
- Changed keywords

**Auto-Sync Polling:** Set "Auto-Sync Interval" to automatically re-check the vault every N seconds. When changes are detected, toast notifications summarize what changed (if "Show Sync Change Toasts" is enabled).

**Manual refresh:** Click "Refresh Index" in settings or use `/dle-refresh`.

---

## Circuit Breaker

The Obsidian REST API connection uses a circuit breaker pattern to avoid hammering a down server. States: **closed** (normal), **open** (failing — skip calls for backoff period), **half-open** (try one test call).

Exponential backoff from 2s to 15s. Automatic — no settings to configure. Resets when a call succeeds.

---

## Prompt Cache Optimization

In proxy mode, the AI search manifest is placed first in the message payload with `cache_control` breakpoints. This leverages Anthropic's prompt caching so that the manifest (which rarely changes between calls) is cached server-side, reducing token costs on subsequent calls.

Only applies to Custom Proxy mode. Connection Profile mode does not support cache_control breakpoints.

---

## Sliding Window AI Cache

AI search caches results with a sliding window strategy. The manifest and chat context are hashed separately. When only new chat messages are appended (vault unchanged):
- If the new messages don't contain any entity names/keys from the vault, cached results are reused
- If new messages reference vault entities, the cache is invalidated and a fresh AI call is made

This means most regenerations, swipes, and non-lore-relevant messages reuse cached results automatically.

---

## Hierarchical Manifest Clustering

For large vaults (40+ selectable entries), the AI search uses a two-call approach:
1. Group entries by category (extracted from tags/type fields)
2. First AI call: select relevant categories from the full list
3. Second AI call: select specific entries from within those categories

Safety valve: if the category filter removes more than 80% of entries, it falls back to the full manifest. Requires at least 4 distinct categories to activate.
