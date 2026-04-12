# AI Subsystem Internals

Code-level reference for the DLE AI subsystem. For pipeline flow see `CLAUDE.md`; for generation ordering see `docs/generation-pipeline.md`.

Source files: `src/ai/ai.js`, `src/ai/manifest.js`, `src/ai/proxy-api.js`, `src/ai/claude-adaptive-check.js`, `src/ai/models.js`, `settings.js` (L280-332), `src/state.js` (L246-350), `src/helpers.js` (L60-210).

---

## 1. Connection Routing

### `resolveConnectionConfig(toolKey)` -- settings.js L301

Central dispatch that resolves any feature's AI connection settings into a uniform config object. Eliminates per-caller if/else routing.

```js
// settings.js L283-290
const TOOL_SETTINGS_KEYS = {
    aiSearch:     { mode, profileId, proxyUrl, model, maxTokens, timeout },
    scribe:       { ... },
    autoSuggest:  { ... },
    aiNotepad:    { ... },
    librarian:    { ... },   // note: maxTokens key is 'librarianSessionMaxTokens'
    optimizeKeys: { ... },
};

// Returns: { mode, profileId, proxyUrl, model, maxTokens, timeout }
resolveConnectionConfig(toolKey) -> config
```

**Inherit fallback** (L312-322): When a tool's mode is `'inherit'` and `toolKey !== 'aiSearch'`, mode and profileId resolve from AI Search's settings. Model and proxyUrl cascade: tool's own value if set, else AI Search's. `maxTokens` and `timeout` always come from the tool's own settings (never inherited).

**Gotchas:**
- AI Search itself cannot inherit (it IS the root). If `aiSearchConnectionMode === 'inherit'`, that value flows through unchanged -- callers treat it as the literal mode string.
- `librarianConnectionMode` must NOT share with retrieval (per user feedback). Don't collapse them.
- When `mode === 'inherit'` resolves to `'proxy'`, the proxyUrl falls back to `toolProxyUrl || aiSearch.proxyUrl` -- but when mode is NOT inherit, proxyUrl falls back to `toolProxyUrl || defaultSettings[keys.proxyUrl]` (L327). These are different fallback chains.

### AI Call Throttle -- ai.js L24-32

```js
let _lastAiCallTimestamp = 0;           // module-scoped, reset on chat change
const AI_CALL_MIN_INTERVAL_MS = 500;    // 500ms minimum between actual API calls
```

Enforced in `callAI()` (L229-240). Cache hits and circuit-breaker skips bypass throttle (they don't make API calls). Throttle errors have `err.throttled = true` and do NOT trip the circuit breaker.

`resetAiThrottle()` (L32): Sets `_lastAiCallTimestamp = 0`. Called on chat change to prevent cross-chat penalty.

**Critical**: Throttle timestamp is stamped on SUCCESS only (L270-272, BUG-039). Failed calls don't consume the window, so immediate retries aren't blocked.

### `callAI()` -- ai.js L228

Unified router. All AI features call this, never `callViaProfile`/`callProxyViaCorsBridge` directly.

```js
callAI(systemPrompt, userMessage, connectionConfig) -> {text, usage}
// connectionConfig: { mode, profileId, proxyUrl, model, maxTokens, timeout, cacheHints, signal, skipThrottle, caller }
```

Dispatches to `callViaProfile()` when `mode === 'profile'`, or `callProxyViaCorsBridge()` when `mode === 'proxy'`. Proxy mode defaults model to `'claude-haiku-4-5-20251001'` if none specified (L266).

**`caller` label**: All callers now pass a `caller` string (e.g. `'aiSearch'`, `'scribe'`, `'autoSuggest'`, `'hierarchicalPreFilter'`, `'aiNotepad'`, `'optimizeKeys'`). This label is recorded in the `aiCallBuffer` for per-call diagnostics.

**`aiCallBuffer` recording**: `callAI()` wraps the actual dispatch in a recording layer that pushes to the `aiCallBuffer` (RingBuffer 20 in `src/diagnostics/interceptors.js`). Each entry captures: `caller`, `mode`, `model`, `systemLen` (system prompt length), `userLen` (user message length), `timeoutMs`, `durationMs`, `status` (success/error/timeout/abort), `responseLen`, `tokens` (usage object), `error` (truncated error message on failure).

`skipThrottle: true` is used by `hierarchicalPreFilter` which chains with `aiSearch` -- both calls in one generation must not throttle each other.

---

## 2. AI Search

### `aiSearch()` -- ai.js L452

```js
aiSearch(chat, candidateManifest, candidateHeader, snapshot, candidateEntries, signal)
  -> { results: AiSearchMatch[], error: boolean, errorMessage?: string }
```

**State read:** `vaultIndex`, `aiSearchCache`, `aiSearchStats`, `entityNameSet`, `entityShortNameRegexes`, `entityRegexVersion`, `lastScribeSummary`, `decayTracker`, `consecutiveInjections`.
**State written:** `aiSearchCache` (via `setAiSearchCache`), `aiSearchStats` (mutated in-place).
**Dependencies:** `getSettings()`, `buildAiChatContext()`, `simpleHash()`, `callAI()`, `extractAiResponseClient()`, `normalizeResults()`, `fuzzyTitleMatch()`.

**Flow:**

1. Guard: bail if `!aiSearchEnabled` or empty manifest (L455-457)
2. Circuit breaker: `tryAcquireHalfOpenProbe()` -- blocks if breaker is open (L460)
3. Strip trailing assistant message from chat for cache stability (L472-478, BUG-CACHE-FIX)
4. Build `chatContext` from `buildAiChatContext(chatForCache, scanDepth)` (L479)
5. Prepend seed entries on new chats (L486-495)
6. Append scribe summary if `scribeInformedRetrieval` is on (L498-503)
7. **Cache check** (see sliding window below)
8. Build system prompt with `{{maxEntries}}` substitution (L613-641)
9. Build user message: manifest info + manifest + chat context (L645-649)
10. Proxy mode: split into cacheHints `{stablePrefix, dynamicSuffix}` (L652-665)
11. `callAI()` (L667-676)
12. Parse response via `extractAiResponseClient()` (L685)
13. Handle object-shaped responses -- unwrap `{results: [...]}` etc. (L688-699)
14. `normalizeResults()` (L710-720) -- zero usable items from non-empty array trips breaker
15. Exact title match against `candidateEntries` (L732-742)
16. Fuzzy match unmatched titles via `fuzzyTitleMatch()` (L747-764)
17. Sort by confidence tier: high > medium > low (L767-768)
18. Confidence threshold filter (L771-777) -- `aiConfidenceThreshold` setting
19. Cache results and `recordAiSuccess()` (L785-805)

**Error handling** (L807-837): Classifies errors into categories that determine circuit breaker behavior:
- **User abort** (`err.userAborted === true`): no breaker trip, silent
- **Timeout** (`err.timedOut === true`): no breaker trip, warning logged
- **Throttle** (`err.throttled`): no breaker trip, debug-only
- **Rate limit** (429 / message match): no breaker trip, user warning
- **Auth error** (401/403): no breaker trip, user error toast
- **Everything else**: `recordAiFailure()` -- trips breaker after 2 consecutive

### Sliding Window Cache -- ai.js L505-610

Cache key components:
```js
// L516
const settingsKey = `${aiSearchMode}|${scanDepth}|${maxEntries}|${unlimitedEntries}|${promptHash}|${connectionMode}|${profileId}|${model}|${confidenceThreshold}|${manifestSummaryMode}|${summaryLength}`;
const manifestHash = simpleHash(settingsKey + candidateManifest);
```

Four cache-hit paths, checked in order:

1. **Exact match** (L537-543): `chatHash === cached.hash && manifestHash === cached.manifestHash`. Catches identical re-runs.

2. **Keyword-stable hit** (L549-565): Manifest unchanged, current `candidateEntries` titles are a subset of `cached.matchedEntrySet`. Catches typo fixes, "ok continue", reaction messages. Skipped in `ai-only` mode.

3. **Swipe/regen safety net** (L571-578): Manifest unchanged, chat line count <= cached count. After trailing-assistant strip, swipe/regen should hit exact match -- this is a defensive fallback.

4. **Sliding window** (L583-610): Manifest unchanged, chat grew (new lines only). Scans new lines against `entityNameSet` using pre-compiled word-boundary regexes from `entityShortNameRegexes`. Cache valid if no new entity mentions. **Skipped when `entityRegexVersion` differs from cached version** (BUG-394 -- post-rebuild staleness).

**Cache writes** (L785-794): Stores `{hash, manifestHash, chatLineCount, results[], matchedEntrySet, entityRegexVersion}` via `setAiSearchCache()`.

`resolveCachedResults()` (L527-535): Replays cached title-based results against `candidateEntries` (not full `vaultIndex`) to prevent blocked/gated entries from leaking through (BUG-382).

### Response Parsing

**`extractAiResponseClient(text)`** -- helpers.js L66

Tries three strategies in order:
1. Direct `JSON.parse()` (L80-83)
2. Markdown code fence extraction via regex (L85-91)
3. Bracket-balanced JSON array extraction with string-awareness (L95-122) -- sorts candidates largest-first, tries each

All candidates are validated via `isValidResultArray()` (L70-77): must be an array where at least one element is a string or an object with `.title` or `.name`.

**`normalizeResults(arr)`** -- helpers.js L131

Maps raw parsed items to `{title, confidence, reason}` objects. Rejects non-string/non-object items (BUG-391 -- prevents `42` or `[object Object]` becoming fake titles). Filters out null/empty/`"null"`/`"undefined"` titles.

**`fuzzyTitleMatch(aiTitle, candidateTitles, threshold=0.6)`** -- helpers.js L697

Bigram Dice coefficient similarity. Returns `{title, similarity}` for best match above threshold, or null.

---

## 3. Hierarchical Pre-Filter

### `hierarchicalPreFilter(candidates, chat, signal)` -- ai.js L300

Two-phase AI search for large vaults. Called from the pipeline before `aiSearch()`.

```
HIERARCHICAL_THRESHOLD = 40  // ai.js L290
AI_PREFILTER_MAX_TOKENS = 512  // ai.js L29
```

**Trigger conditions** (L303-313):
- Selectable entries (non-force-injected) >= 40
- Cluster count > 3
- In `summary_only` mode, entries without summaries are excluded before counting (BUG-387)

**Flow:**

1. Filter out force-injected entries (L303), apply summary_only filter (L306-308)
2. `clusterEntries(selectable)` -> `Map<category, entries[]>` (helpers.js L173)
3. Skip if < 40 selectable or <= 3 clusters (L310-313)
4. `buildCategoryManifest(clusters)` -> compact text (helpers.js L202)
5. `tryAcquireHalfOpenProbe()` -- blocks if circuit breaker open (L333)
6. `callAI()` with `skipThrottle: true` (L339-348)
7. Parse categories via `extractAiResponseClient()` (L363)
8. Handle object wrappers: `{categories: [...]}`, `{labels: [...]}`, etc. (L367-381)
9. Filter candidates to selected categories (L384-401)
10. Re-include force-injected entries (L403-405)
11. Aggressiveness check: if filtering removed > `(1 - hierarchicalAggressiveness)` fraction, return null (L412-416)
12. `releaseHalfOpenProbe()` -- does NOT record success/failure (L425)

**`clusterEntries(entries)`** -- helpers.js L173

Clusters by first non-infrastructure tag. `LOREBOOK_INFRA_TAGS` (helpers.js L156-164) contains `lorebook`, `lorebook-always`, `lorebook-seed`, `lorebook-bootstrap`, `lorebook-guide`, `lorebook-never`, `lorebook-constant`. These are skipped when picking the clustering tag because WI imports put `lorebook` on everything (BUG-384). Falls back to top folder from filename, then `'Uncategorized'`.

**`buildCategoryManifest(clusters)`** -- helpers.js L202

One line per category: `[CategoryName] (N entries): title1, title2, ... (+M more)`
Shows up to 5 sample titles per category.

**Gotchas:**
- `releaseHalfOpenProbe()` (state.js L286-289): Clears the probe flag without recording success or failure. This is intentional -- the pre-filter's outcome shouldn't affect the circuit breaker since `aiSearch()` manages its own probing independently.
- Stats: Hierarchical calls increment `aiSearchStats.totalInputTokens`/`totalOutputTokens` and `aiSearchStats.hierarchicalCalls`, but NOT `aiSearchStats.calls` (BUG-017/BUG-393). The dedicated counter prevents double-counting while keeping token averages accurate.
- On error, the probe is released (not recorded as failure) unless `err.throttled` (L431). The pre-filter returns null on any failure, falling back to single-call search.

---

## 4. Candidate Manifest

### `buildCandidateManifest(candidates, excludeBootstrap, settings)` -- manifest.js L21

Pure function (no SillyTavern imports). The ai.js wrapper (L283-284) injects `getSettings()`.

```js
// Returns: { manifest: string, header: string }
```

**What's excluded:**
- Constants (`entry.constant === true`) -- via `isForceInjected()` (helpers.js L683)
- Bootstraps when `excludeBootstrap === true` (passed when chat is short enough for bootstrap injection)
- In `summary_only` mode: entries without a summary field (L30-31)

**Per-entry XML format** (manifest.js L75):
```xml
<entry name="EscapedTitle">
Title (TokenEstimate tok) -> link1, link2 [STALE - consider refreshing]
[Era: medieval | Location: tavern]
Summary text truncated to aiSearchManifestSummaryLength...
</entry>
```

**Summary selection** (L39-42) controlled by `manifestSummaryMode`:
- `'prefer_summary'` (default): Use `entry.summary`, fallback to truncated content
- `'content_only'`: Always use truncated content
- `'summary_only'`: Use summary only (entries without summaries excluded upstream)

Summary truncation: `truncateToSentence(content.substring(0, summaryLen * 3), summaryLen)` where `summaryLen` defaults to `aiSearchManifestSummaryLength || 600`.

**Annotations:**
- Decay hint `[STALE]` when `staleness >= decayBoostThreshold` (L49-52)
- Frequency hint `[FREQUENT]` when `consecutiveInjections >= decayPenaltyThreshold` (L55-59)
- Custom field annotations from `entry.customFields` using `fieldDefinitions` label map (L63-69)

**Header** (L84-91):
```
Candidate entries: N (from M total).
K entries are always included (~T tokens).
Token budget: ~B tokens total.
```
The forced-entry count uses `candidates.length - selectable.length` (BUG-047: counts against total, not selectable). Budget line omitted when `unlimitedBudget` is true.

---

## 5. Circuit Breaker Integration

### State Machine -- state.js L246-350

Three states:

```
CLOSED  -- aiCircuitOpen=false. All calls pass through.
OPEN    -- aiCircuitOpen=true, cooldown not expired. All calls blocked.
HALF-OPEN -- aiCircuitOpen=true, cooldown expired. One probe allowed.
```

**Constants:**
```js
AI_CIRCUIT_THRESHOLD = 2       // consecutive failures to trip (L254)
AI_CIRCUIT_COOLDOWN  = 30_000  // ms before half-open probe (L255)
AI_PROBE_TIMEOUT     = 60_000  // ms before stale probe auto-resets (L308)
```

**State variables** (state.js):
```js
export let aiCircuitOpen = false;        // L249
export let aiCircuitFailures = 0;        // L250
export let aiCircuitOpenedAt = 0;        // L251
let aiCircuitHalfOpenProbe = false;      // L253 (not exported)
let aiCircuitProbeTimestamp = 0;         // L309 (not exported)
```

### `isAiCircuitOpen()` -- state.js L313

**Pure query. Never mutates state.** Safe for UI rendering, status checks, non-AI code paths.

Returns `true` (blocked) when:
- Circuit open AND cooldown not expired
- Circuit open AND cooldown expired AND probe is in-flight AND probe is not stale

Returns `false` (proceed) when:
- Circuit closed
- Cooldown expired, no probe dispatched (caller should use `tryAcquireHalfOpenProbe`)
- Cooldown expired, probe dispatched but stale (> 60s)

### `tryAcquireHalfOpenProbe()` -- state.js L333

**Mutation gate. Only call from actual AI code paths** (aiSearch, hierarchicalPreFilter).

Returns `true` if:
- Circuit closed (all pass) -- L334
- Circuit open, cooldown expired, no active probe -- acquires atomically (L344-347)
- Circuit open, cooldown expired, probe stale (> 60s) -- resets and re-acquires (L338-339)

Returns `false` if:
- Still in cooldown (L349)
- Probe already in-flight and not stale (L343)

**Caller contract**: If `tryAcquireHalfOpenProbe()` returns true and circuit was open, caller MUST eventually call `recordAiSuccess()`, `recordAiFailure()`, or `releaseHalfOpenProbe()`.

### `recordAiFailure()` -- state.js L258

- Clears half-open probe flag (L260-263)
- Increments `aiCircuitFailures` (L264)
- If failures >= threshold (2): sets `aiCircuitOpen = true`, refreshes `aiCircuitOpenedAt` (L265-268)
- Notifies observers on state transition CLOSED -> OPEN (L271)

### `recordAiSuccess()` -- state.js L273

- Clears probe flag, timestamp, failures, circuit open flag, opened-at (L275-279)
- Notifies observers on state transition OPEN -> CLOSED (L281)

### `releaseHalfOpenProbe()` -- state.js L286

Clears probe flag and timestamp without recording success or failure. Used by `hierarchicalPreFilter` so its outcome doesn't cascade to the main search's circuit state.

### What does NOT trip the breaker (ai.js L819):

- Throttle failures (`err.throttled`)
- Timeouts (`err.timedOut` or `AbortError`)
- User aborts (`err.userAborted`)
- Rate limits (HTTP 429)
- Auth errors (HTTP 401/403)

Only unclassified errors (typically 5xx, network failures, or persistent format drift) call `recordAiFailure()`.

### Error Classification -- core/utils.js `classifyError()`

`classifyError()` categorizes API errors for circuit breaker decisions and user-facing messages. In addition to the original types, 6 new error types have been added:

| Type | Detection | Breaker trip? |
|---|---|---|
| `CORS` | Network error with CORS-related message patterns | No |
| `QUOTA_BILLING` | HTTP 402 (Payment Required) | No |
| `JSON_PARSE` | JSON parse/syntax errors in response | Yes (format drift) |
| `MODEL_NOT_FOUND` | HTTP 404 + model-related message, or explicit model-not-found error | No |
| `OVERLOADED` | HTTP 529 (service overloaded) | No |

These complement the existing types (timeout, rate_limit, auth, user_abort, throttle, network, unknown).

---

## 6. Claude Adaptive-Thinking Check

### Module -- claude-adaptive-check.js

Detects when a Connection Manager profile uses Claude opus-4-6 / sonnet-4-6 (adaptive thinking models) but the bound OpenAI completion preset lacks an explicit `reasoning_effort` set to low/medium/high. ST rejects these requests with a 400 error.

```js
const CLAUDE_ADAPTIVE_REGEX = /^claude-(opus-4-6|sonnet-4-6)/i;  // L14
const VALID_EFFORTS = new Set(['low', 'medium', 'high']);         // L16
```

### `detectClaudeAdaptiveIssue(profileId, modelOverride, opts)` -- L28

```js
// Returns: {bad: boolean, reason?: string, profileName?, modelName?, presetName?}
```

**Flow:**
1. Bail early if no profileId or no SillyTavern context (L30-31)
2. Get profile via `ConnectionManagerRequestService.getProfile()` (L37-38)
3. Skip if `profile.api !== 'claude'` -- OpenRouter/custom wrappers handle this differently (L41)
4. Check model against `CLAUDE_ADAPTIVE_REGEX` (L44)
5. Check preset exists (L46-55) -- `reason: 'no_preset'` if missing
6. Read `reasoning_effort` from preset (BUG-397: always JIT, never memoized; callers can pass `opts.freshPreset`) (L59-61)
7. Return `bad: true` with `reason: 'auto'` or `reason: 'unset'` if effort is invalid (L63-70)

**Wrapped in try/catch** (L74-78): Detection must never throw -- returns `{bad: false}` on any error.

### Pre-flight in `callViaProfile()` -- ai.js L82-96

Dynamic-imported at call time (`await import('./claude-adaptive-check.js')`). When `bad === true`:
- Sets `claudeAutoEffortState` via `setClaudeAutoEffortState(true, detail)` (state.js L135-140), which notifies UI observers
- One-shot toast via `claimClaudeAdaptiveToastSlot(detail)` (L160-166)
- Stores detail for error rewriting in the catch block (L185-197)

### Error rewriting -- ai.js L185-197

When the actual API call fails AND `claudeAdaptiveDetail` was set pre-flight AND the error message matches `400|bad request|top_k|thinking|reasoning_effort`, the error is rewritten to a human-readable message from `buildClaudeAdaptiveMessage(detail, 'error')`. The import is wrapped separately (BUG-069) so import failure doesn't mask the original error.

### `claimClaudeAdaptiveToastSlot(detail)` -- L160

Session-scoped one-shot tracking. Key is `profileName|modelName|presetName`. Returns `true` (show toast) only the first time per combo per browser session. The `_sessionToastShown` Set (L151) is never persisted.

### `resolveFeatureConnectionMode(settings, feature)` -- L115

Resolves inherit chain: `settings[featureConnectionModeKey]` -> if `'inherit'`, falls back to `settings.aiSearchConnectionMode || 'profile'`.

### `shouldCheckClaudeAdaptiveForFeature(settings, feature)` -- L142

Returns true only when the feature's effective mode is `'profile'`. Proxy mode routes through a local proxy that handles thinking itself, so the native-Anthropic preset check would be a false positive.

---

## 7. Proxy Mode

### `callProxyViaCorsBridge()` -- proxy-api.js L69

```js
callProxyViaCorsBridge(proxyUrl, model, systemPrompt, userMessage, maxTokens, timeout=15000, cacheHints, externalSignal)
  -> {text: string, usage: {input_tokens, output_tokens}}
```

Routes through SillyTavern's built-in CORS proxy at `/proxy/:url`. **Requires `enableCorsProxy: true` in ST's config.yaml** -- without it, the proxy returns 404 with a "CORS proxy is disabled" message, which is caught and surfaced as a descriptive error (L120-122).

**URL construction** (L72-74):
```js
const targetUrl = proxyUrl.replace(/\/+$/, '') + '/v1/messages';
const corsProxyUrl = `/proxy/${encodeURIComponent(targetUrl)}`;
```
The target URL is `encodeURIComponent`-encoded to prevent Express from collapsing `://` to `:/`.

**Request format**: Anthropic Messages API format (L108-115):
- `anthropic-version: 2023-06-01` header
- System prompt as `[{type: 'text', text, cache_control: {type: 'ephemeral'}}]`
- User content: plain string, or two-block array when `cacheHints` provided (stable prefix with `cache_control: {type: 'ephemeral'}` + dynamic suffix) (L92-99)

**Abort handling** (L76-88, L149-162):
- Internal `AbortController` with timeout
- External signal wired to internal controller
- On abort, distinguishes user abort (`externalSignal.aborted` -> `err.userAborted = true`) from timeout (`err.timedOut = true`). Both set `err.name = 'AbortError'`.

**Error response scrubbing** (L124-129): Truncates to 150 chars and redacts API keys matching patterns for Anthropic, OpenAI, Google, Groq, and generic Bearer tokens.

**JSON parse safety** (L133-139, BUG-041): Separate `response.text()` and `JSON.parse()` calls for distinct error messages.

### `validateProxyUrl(url)` -- proxy-api.js L25

SSRF validation. Called at the start of `callProxyViaCorsBridge()` and in `fetchModels()`.

**Blocks:**
- Empty/malformed/non-http(s) URLs (L28-36)
- Cloud metadata endpoints: `169.254.169.254`, `metadata.google.internal`, `100.100.100.200` (L38-40)
- `localhost`, `0.0.0.0`, `::1`, `::ffff:127.0.0.1` (L42-44)
- Private/reserved ranges: 10.x, 172.16-31.x, 192.168.x, 100.64-127.x (CGNAT), 169.254.x (link-local), 0.x, fd/fe80 (IPv6) (L46-58)
- Numeric/hex/octal IP shorthand (L61-66)

**Allows:** `127.0.0.1` only (local proxies).

### `testProxyConnection(proxyUrl, model)` -- proxy-api.js L175

Sends a minimal probe (`'Reply OK.'` system, `'ping'` user, max 8 tokens, 15s timeout). Returns `{ok: boolean, response?, error?}`.

### `fetchModels()` -- models.js L29

```js
fetchModels({baseUrl, apiKey, timeout=8000, via='auto'})
  -> {ok, models: string[], raw, error?, source: 'cache'|'direct'|'cors'}
```

Hits `{base}/v1/models` (OpenAI-compatible). Used to populate model dropdowns in proxy-mode settings.

**Caching:** `sessionStorage` keyed by `dle_models_v1::{baseUrl}::{apiKeyFingerprint}` (L35-36). FNV-1a 32-bit hash of API key (BUG-388) -- rotating keys invalidates cache without storing the raw key.

**Fetch strategy** (`via` parameter, L74-101):
- `'auto'` (default): Try direct fetch first. Fall back to CORS bridge on TypeError, AbortError, or non-401/403 HTTP errors. Auth failures (401/403) surface immediately.
- `'direct'`: Direct only.
- `'cors'`: CORS bridge only.

`clearModelsCache(baseUrl)` (L127): Sweeps all fingerprint variants for a base URL, or all DLE model cache entries if no baseUrl given.
