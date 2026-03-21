# Known Issues (Security & Design)

These are documented limitations, not actionable vulnerabilities for typical single-user setups.

## Plaintext API Key Storage
Obsidian API keys are stored as plaintext in SillyTavern's extension_settings JSON. This is a platform limitation — ST does not yet provide a secrets API. Any extension on the same origin can read these keys, granting full read/write access to the connected Obsidian vault. **Mitigation:** Use a dedicated Obsidian vault for lorebook content, not your personal vault.

## AI Search Prompt Injection via Summaries
Entry summaries are included in the AI search manifest. In multi-author vaults, a malicious summary could attempt to influence the AI's selection behavior. This is inherent to any AI retrieval system. **Mitigation:** The manifest uses XML structural delimiters and entity escaping to limit injection surface. Review summaries from untrusted authors.

## No AI Call Rate Limiting
All AI features (search, scribe, auto-suggest) make API calls without rate limiting. A fast typist or auto-generation could cause many calls in quick succession. This is a design decision — rate limiting would add latency. **Mitigation:** Each feature has configurable intervals and timeouts.
