# Known Issues (Security & Design)

These are documented limitations, not actionable vulnerabilities for typical single-user setups.

## Plaintext API Key Storage
Obsidian API keys are stored as plaintext in SillyTavern's extension_settings JSON. This is a platform limitation — ST does not yet provide a secrets API. Any extension on the same origin can read these keys, granting full read/write access to the connected Obsidian vault. **Mitigation:** Use a dedicated Obsidian vault for lorebook content, not your personal vault.

## AI Search Prompt Injection via Summaries
Entry summaries are included in the AI search manifest. In multi-author vaults, a malicious summary could attempt to influence the AI's selection behavior. This is inherent to any AI retrieval system. **Mitigation:** The manifest uses XML structural delimiters and entity escaping to limit injection surface. Review summaries from untrusted authors.

## No AI Call Rate Limiting
All AI features (search, scribe, auto-suggest) make API calls without rate limiting. A fast typist or auto-generation could cause many calls in quick succession. This is a design decision — rate limiting would add latency. **Mitigation:** Each feature has configurable intervals and timeouts.

## Librarian Auto-Enables Function Calling
When the Librarian feature is enabled, DLE automatically enables function calling on the active API connection. Disabling function calling elsewhere while Librarian is active will break tool invocations. **Mitigation:** If you need function calling off, disable Librarian first.

## Guide Tag Conflict Resolution
Entries tagged `lorebook-guide` that also carry conflicting tags (`lorebook-seed`, `lorebook-bootstrap`, or base `lorebook`) have runtime conflict resolution: `guide` wins. The entry will be treated as guide-only (never injected into the writing AI context). This is intentional but may surprise authors who expect seed/bootstrap behavior.

## Graph Focus Mode Exit Key
Graph focus mode exits with the `e` key, not Escape. Escape bubbles up to SillyTavern's popup event handler and would close the graph dialog instead of just exiting focus mode.
