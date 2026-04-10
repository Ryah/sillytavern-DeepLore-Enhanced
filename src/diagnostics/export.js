/**
 * export.js — Build the diagnostic markdown report.
 *
 * Output shape:
 *   1. Header / privacy (plaintext — humans read this on GitHub)
 *   2. Scrubber report (plaintext — what was redacted)
 *   3. Summary data section (plaintext, scrubbed)
 *   4. AI instructions block (base64 — schema, form, patterns)
 *   5. ---DLE-DATA-BEGIN---
 *      base64(gzip(JSON(verbose data, scrubbed)))
 *      ---DLE-DATA-END---
 */

import { scrubDeep, makeCtx } from './scrubber.js';
import { captureStateSnapshot } from './state-snapshot.js';
import { consoleBuffer, networkBuffer, errorBuffer } from './interceptors.js';
import { generationBuffer } from './flight-recorder.js';
import { longTaskBuffer, captureMemorySnapshot } from './performance.js';

const ISSUE_URL = 'https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/new';

/**
 * Compress a string with gzip and return base64. Browser-native, no deps.
 * Falls back to uncompressed base64 if CompressionStream is unavailable.
 */
async function gzipBase64(str) {
    // Fallback for browsers without CompressionStream (Safari <16.4, Firefox <113)
    if (typeof CompressionStream === 'undefined') {
        return { b64: btoa(unescape(encodeURIComponent(str))), compressed: false };
    }
    try {
        const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
        const buf = await new Response(stream).arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        const CHUNK = 0x8000; // avoid stack overflow on large inputs
        for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return { b64: btoa(bin), compressed: true };
    } catch {
        // Compression failed — fall back to uncompressed base64
        return { b64: btoa(unescape(encodeURIComponent(str))), compressed: false };
    }
}

/** Build a compact, human-readable summary section for the top of the report. */
function buildSummarySection(snapshot, scrubbedGenerations) {
    const lines = [];
    const push = (s) => lines.push(s);

    // Collect issues for traffic-light verdict
    const issues = { critical: [], warning: [] };

    push('## Summary Data (human-readable)');
    push('');
    push(`- Captured: ${snapshot.capturedAt}`);
    const dleVer = snapshot.dleVersion || 'unknown';
    push(`- DLE version: ${dleVer === 'unknown' ? '**unknown** ⚠' : dleVer}`);
    if (dleVer === 'unknown') issues.warning.push('DLE version unknown');
    if (snapshot.system) {
        const stVer = snapshot.system.stVersion;
        push(`- ST version: ${stVer || '**unknown** ⚠'}`);
        push(`- Browser: ${snapshot.system.userAgent || 'unknown'}`);
        push(`- URL: ${snapshot.system.url || 'unknown'}`);
    }
    if (snapshot.staleness?.capturedDuringGeneration) {
        push(`- **WARNING: Snapshot captured during active generation** (lock held ${Math.round((snapshot.staleness.generationLockAgeMs || 0) / 1000)}s)`);
    }
    push('');

    // Setup wizard / migration state
    if (snapshot.setupState) {
        push('### Setup');
        const ss = snapshot.setupState;
        const wizardStatus = ss.wizardCompleted ? '✓ completed' : '**not completed**';
        push(`- Wizard: ${wizardStatus} | Settings v${ss.settingsVersion ?? '?'}`);
        if (ss.wizardCompleted && !ss.localStorageSentinel) push('  - ⚠ localStorage sentinel missing (wizard completed in settings but not localStorage)');
        if (ss.possiblyIncomplete) { push('  - **⚠ Wizard marked complete but no vaults enabled** — likely skipped or partial setup'); issues.critical.push('Wizard complete but no vaults enabled'); }
        push(`- Vaults configured: ${ss.vaultCount} (${ss.vaultSummary?.filter(v => v.enabled).length || 0} enabled)`);
        if (ss.vaultSummary?.length > 0) {
            for (const [i, v] of ss.vaultSummary.entries()) {
                const status = v.enabled ? '✓' : '✗';
                const issues = [];
                if (!v.hasHost) issues.push('no host');
                if (!v.hasApiKey) issues.push('no API key');
                push(`  - Vault ${i}: ${status} ${v.name || '(unnamed)'}${issues.length ? ` — **${issues.join(', ')}**` : ''}`);
            }
        }
        // Only show migrations if something is notable
        if (ss.vaultsMigrated || !ss.indexEverLoaded) {
            if (ss.vaultsMigrated) push('- Migrated from legacy vault format');
            if (!ss.indexEverLoaded) push('- **Index never loaded** — vault may not be reachable');
        }
        push('');
    }

    if (snapshot.connections) {
        push('### Connections');
        const conn = snapshot.connections;

        // ST's active connection state
        if (conn.stActiveConnection) {
            const st = conn.stActiveConnection;
            push(`- **ST active:** ${st.mainApi || '?'} → ${st.chatCompletionSource || '?'} (${st.totalProfiles} profiles configured)`);
            if (st.reverseProxy) push(`  - Reverse proxy: ${st.reverseProxy}`);
            if (st.selectedModel) push(`  - Model: ${st.selectedModel}`);
            if (st.claudeModel) push(`  - Claude model: ${st.claudeModel}`);
            if (st.openrouterModel) push(`  - OpenRouter model: ${st.openrouterModel}`);
        }
        push('');

        // Per-tool resolved connections
        if (conn.tools) {
            push('| Tool | Mode | Target | Model | Timeout | Status |');
            push('|------|------|--------|-------|---------|--------|');

            // Detect which tools inherited from aiSearch
            const aiMode = conn.tools.aiSearch?.effectiveMode;
            const aiProfileId = conn.tools.aiSearch?.profileId;

            for (const [key, t] of Object.entries(conn.tools)) {
                if (t.__error) {
                    push(`| ${key} | ⚠ ERROR | — | — | — | ${t.__error} |`);
                    continue;
                }
                const mode = t.effectiveMode || '?';
                let target = '—';
                let status = '✓';
                let inherited = '';

                // Detect inheritance: non-aiSearch tool with same resolved mode+profileId as aiSearch
                if (key !== 'aiSearch' && mode === aiMode && t.profileId === aiProfileId) {
                    inherited = ' ↑';  // arrow indicates inherited from aiSearch
                }

                if (mode === 'profile') {
                    target = t.profileName || t.profileId || '(none)';
                    if (t.profileExists === false) {
                        status = '**❌ MISSING**';
                        issues.critical.push(`${key}: connection profile missing`);
                    }
                } else if (mode === 'proxy') {
                    target = t.proxyUrl || '(no URL)';
                }
                const model = t.model || t.profileModel || '(default)';
                const timeout = t.timeout ? `${Math.round(t.timeout / 1000)}s` : '—';
                push(`| ${key} | ${mode}${inherited} | ${target} | ${model} | ${timeout} | ${status} |`);
            }
            // Legend for inherited marker
            const inheritCount = Object.entries(conn.tools).filter(([k, t]) => k !== 'aiSearch' && t.effectiveMode === aiMode && t.profileId === aiProfileId).length;
            if (inheritCount > 0) push(`\n_↑ = inherited from aiSearch_`);
        }

        // Stale/missing profile warnings
        if (conn.issues && conn.issues.length > 0) {
            push('');
            push('**⚠ Connection Issues:**');
            for (const issue of conn.issues) push(`- ${issue}`);
        }
        push('');
    }

    // Chat context
    if (snapshot.chatContext) {
        push('### Chat Context');
        const cc = snapshot.chatContext;
        push(`- ${cc.isGroupChat ? `Group chat (groupId: ${cc.groupId})` : `1-on-1 with ${cc.characterName || '?'}`} (characterId: ${cc.characterId ?? 'none'})`);
        push(`- Chat length: ${cc.chatLength} messages | Last message: ${cc.lastMessageRole || 'none'}${cc.lastMessageHasContent === false ? ' **(empty)**' : ''}`);
        push('');
    }

    if (snapshot.vault) {
        push('### Vault');
        push(`- Entries: **${snapshot.vault.entryCount}** (constants: ${snapshot.vault.constantCount}, seed: ${snapshot.vault.seedCount}, bootstrap: ${snapshot.vault.bootstrapCount})`);
        push(`- With summary: ${snapshot.vault.withSummary} / ${snapshot.vault.entryCount}`);
        push(`- Without keys: ${snapshot.vault.withoutKeys}`);
        push(`- Avg tokens/entry: ${Math.round(snapshot.vault.avgTokens || 0)}`);
        push(`- Indexing: ${snapshot.vault.indexing ? 'IN PROGRESS' : 'idle'} (everLoaded=${snapshot.vault.indexEverLoaded})`);
        const indexAge = snapshot.vault.indexTimestamp
            ? `${Math.round((Date.now() - snapshot.vault.indexTimestamp) / 1000)}s ago`
            : 'never';
        push(`- Last index: ${indexAge}`);
        // Per-vault Obsidian circuit breakers
        if (snapshot.obsidianCircuitBreakers && typeof snapshot.obsidianCircuitBreakers === 'object' && !snapshot.obsidianCircuitBreakers.__error) {
            const breakers = Object.entries(snapshot.obsidianCircuitBreakers);
            if (breakers.length > 0) {
                push('- Obsidian circuit breakers:');
                for (const [key, cb] of breakers) {
                    const status = cb.state === 'closed' ? '✓ closed' : cb.state === 'open' ? `**❌ OPEN** (${cb.failures} failures, ${Math.round(cb.backoffRemaining / 1000)}s backoff)` : `⚠ half-open (${cb.failures} failures)`;
                    if (cb.state === 'open') issues.critical.push(`Obsidian vault ${key} circuit breaker OPEN`);
                    push(`  - \`${key}\`: ${status}`);
                }
            }
        }
        push('');
    }

    if (snapshot.ai) {
        push('### AI Subsystem');
        const cbOpen = snapshot.ai.circuit.open;
        push(`- Circuit breaker: **${cbOpen ? 'OPEN' : 'closed'}** (failures: ${snapshot.ai.circuit.failures})`);
        if (cbOpen) issues.critical.push('AI circuit breaker is OPEN');
        if (snapshot.ai.stats) {
            push(`- Calls: ${snapshot.ai.stats.calls} | Cached hits: ${snapshot.ai.stats.cachedHits} | In tok: ${snapshot.ai.stats.totalInputTokens} | Out tok: ${snapshot.ai.stats.totalOutputTokens}`);
        }
        if (snapshot.ai.cache) push(`- Cache: ${snapshot.ai.cache.resultCount} results, chatLineCount=${snapshot.ai.cache.chatLineCount}`);
        if (snapshot.ai.claudeAutoEffortBad) push(`- **Claude auto-effort degraded:** ${snapshot.ai.claudeAutoEffortDetail || 'unknown reason'}`);
        if (snapshot.ai.cacheRegexVersionMatch === false && snapshot.ai.cache?.resultCount > 0) push(`- **⚠ AI cache stale** — cache regex v${snapshot.ai.cacheRegexVersion} ≠ current v${snapshot.ai.currentRegexVersion} (entity regexes rebuilt since last cache write)`);
        push('');
    }

    if (snapshot.pipeline) {
        push('### Pipeline');
        // Pipeline mode from settings
        const pipeMode = snapshot.settings?.aiSearchEnabled === false ? 'keywords-only'
            : snapshot.settings?.aiSearchMode || 'two-stage';
        push(`- Mode: **${pipeMode}**`);
        push(`- generationCount: ${snapshot.pipeline.generationCount} | chatEpoch: ${snapshot.pipeline.chatEpoch}`);
        push(`- generationLock: ${snapshot.pipeline.generationLock ? 'HELD' : 'free'}`);
        if (snapshot.staleness?.generationLockZombie) {
            push(`  - **⚠ ZOMBIE LOCK** — held for ${Math.round((snapshot.staleness.generationLockAgeMs || 0) / 1000)}s (>60s), likely stuck pipeline`);
            issues.critical.push('Zombie generation lock (>60s)');
        }
        if (snapshot.pipeline.notepadExtractInProgress) push('- **Notepad extract in progress**');
        if (snapshot.pipeline.scribeInProgress) push('- **Scribe in progress**');
        push('');
    }

    if (snapshot.librarian) {
        push('### Librarian');
        push(`- Tools registered: ${snapshot.librarian.toolsRegistered}`);
        // Tool presence validation
        const tm = snapshot.librarian.toolsInToolManager;
        if (tm && !tm.__error) {
            const searchOk = tm.dleSearchLore ? '✓' : '**❌ MISSING**';
            const flagOk = tm.dleFlagLore ? '✓' : '**❌ MISSING**';
            push(`- Tools in ToolManager: dle_search_lore ${searchOk}, dle_flag_lore ${flagOk} (${tm.totalTools} total tools)`);
            if (!tm.dleSearchLore || !tm.dleFlagLore) issues.warning.push('Librarian tools missing from ToolManager');
            if (snapshot.librarian.functionCallingEnabled === false) {
                push('  - **⚠ Function calling is DISABLED on active connection**');
                issues.warning.push('Function calling disabled on active connection');
            }
        }
        push(`- Lore gaps: ${snapshot.librarian.loreGapsCount} (searches this session: ${snapshot.librarian.loreGapSearchCount})`);
        if (snapshot.librarian.gapsHiddenCount > 0 || snapshot.librarian.gapsDismissedCount > 0) {
            push(`  - Hidden: ${snapshot.librarian.gapsHiddenCount} | Permanently dismissed: ${snapshot.librarian.gapsDismissedCount}`);
        }
        if (snapshot.librarian.sessionStats) {
            const ss = snapshot.librarian.sessionStats;
            push(`- Session stats: ${ss.searchCalls ?? 0} searches, ${ss.flagCalls ?? 0} flags, ~${ss.estimatedExtraTokens ?? 0} extra tokens`);
        }
        push('');
    }

    if (snapshot.matching) {
        push('### Entity Matching');
        push(`- Entity names: ${snapshot.matching.entityNameSetSize} | Regexes: ${snapshot.matching.entityRegexCount} (v${snapshot.matching.entityRegexVersion})`);
        push(`- Field definitions: ${snapshot.matching.fieldDefinitionsCount} (loaded: ${snapshot.matching.fieldDefinitionsLoaded})`);
        push(`- Mention weights: ${snapshot.matching.mentionWeightsCount} | Fuzzy index: ${snapshot.matching.fuzzySearchIndexBuilt ? 'built' : 'not built'}`);
        push('');
    }

    if (snapshot.health) {
        push('### Health Check');
        push(`- ${snapshot.health.errors} error(s), ${snapshot.health.warnings} warning(s)`);
        // Sort by severity: error > warning > info
        const sevOrder = { error: 0, warning: 1, info: 2 };
        const sorted = (snapshot.health.issues || []).slice().sort((a, b) =>
            (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3));
        const top = sorted.slice(0, 10);
        for (const i of top) push(`  - [${i.severity}] ${i.entry || ''} — ${i.detail || i.type}`);
        if (sorted.length > 10) push(`  - ... +${sorted.length - 10} more`);
        push('');
    }

    // Auto-suggest
    if (snapshot.autoSuggest) {
        push('### Auto-Suggest');
        const as = snapshot.autoSuggest;
        if (!as.enabled) {
            push('- **Disabled**');
        } else {
            push(`- Enabled | Interval: every ${as.interval ?? '?'} messages | Counter: ${as.messageCount}/${as.interval ?? '?'} (${as.messagesUntilTrigger ?? '?'} until next)`);
            if (as.skipReview) push('- Auto-apply: **on** (skip review)');
            if (as.folder) push(`- Folder filter: ${as.folder}`);
        }
        push('');
    }

    // Key settings summary (human-readable, avoids need to decode blob)
    if (snapshot.settings && !snapshot.settings.__error) {
        push('### Key Settings');
        const s = snapshot.settings;
        const budgetStr = s.unlimitedBudget ? 'unlimited' : `${s.maxTokensBudget ?? '?'} tokens`;
        const entriesStr = s.unlimitedEntries ? 'unlimited' : `${s.maxEntries ?? '?'}`;
        push(`- Budget: ${budgetStr} | Max entries: ${entriesStr}`);
        push(`- Scan depth: ${s.scanDepth ?? '?'} | Recursive: ${s.recursiveScan ? 'yes' : 'no'} (max ${s.maxRecursionSteps ?? '?'})`);
        push(`- Strip duplicates: ${s.stripDuplicateInjections ? `yes (lookback ${s.stripLookbackDepth ?? '?'})` : 'no'}`);
        push(`- Fuzzy search: ${s.fuzzySearchEnabled ? `yes (min ${s.fuzzySearchMinScore ?? '?'})` : 'no'}`);
        push(`- Injection mode: ${s.injectionMode || '?'} | Position: ${s.injectionPosition || '?'}`);
        push('');
    }

    if (snapshot.extensionInventory) {
        push('### Installed Extensions');
        push(`- ${snapshot.extensionInventory.length} extensions: ${snapshot.extensionInventory.join(', ')}`);
        push('');
    }

    // Diagnostic hotspots from recent generations
    push('### Recent Generations (flight recorder)');
    const gens = scrubbedGenerations || [];
    if (gens.length === 0) {
        push('_No generations captured yet._');
    } else {
        // Trend line: injection counts for last N generations
        const injectionCounts = gens.filter(g => !g.aborted).map(g => g.summary?.injected ?? 0);
        if (injectionCounts.length > 0) {
            const avg = (injectionCounts.reduce((a, b) => a + b, 0) / injectionCounts.length).toFixed(1);
            push(`- Injection trend (last ${injectionCounts.length}): [${injectionCounts.join(', ')}] avg=${avg}`);
        }

        // Budget ratio from most recent non-aborted generation
        const lastGen = [...gens].reverse().find(g => !g.aborted && g.summary?.budget);
        if (lastGen?.summary?.budget) {
            const b = lastGen.summary.budget;
            push(`- Last budget: ${b.used ?? '?'}/${b.limit ?? '?'} tokens (${b.ratio != null ? Math.round(b.ratio * 100) + '%' : '?'})`);
        }

        // Abort count
        const abortCount = gens.filter(g => g.aborted).length;
        if (abortCount > 0) push(`- **Aborted generations: ${abortCount}**`);

        push('');
        for (const g of gens) {
            if (g.aborted) {
                push(`- **ABORTED** @ ${new Date(g.t).toISOString()}: ${g.reason || 'unknown'}`);
                continue;
            }
            const s = g.summary || {};
            const timing = s.totalMs != null ? ` (${s.totalMs}ms)` : '';
            push(`- gen ${g.generationCount ?? '?'} @ ${new Date(g.t).toISOString()}${timing}: keyword=${s.keywordMatched ?? 0} -> aiSelected=${s.aiSelected ?? 0} -> injected=${s.injected ?? 0}${s.aiError ? ` [aiError: ${s.aiError}]` : ''}${g.aiCircuitOpen ? ' [CIRCUIT OPEN]' : ''}`);
            if (s.injectedTitles && s.injectedTitles.length) {
                push(`    injected: ${s.injectedTitles.join(', ')}`);
            }
        }
    }
    push('');

    // Insert traffic-light verdict at the top (after the "## Summary Data" header)
    const totalCritical = issues.critical.length;
    const totalWarning = issues.warning.length;
    let verdict;
    if (totalCritical > 0) {
        verdict = `> **🔴 ${totalCritical} critical issue(s):** ${issues.critical.join('; ')}`;
    } else if (totalWarning > 0) {
        verdict = `> **🟡 ${totalWarning} warning(s):** ${issues.warning.join('; ')}`;
    } else {
        verdict = '> **🟢 No critical issues detected**';
    }
    // Insert after line 0 ("## Summary Data (human-readable)") and line 1 ("")
    lines.splice(2, 0, verdict, '');

    return lines.join('\n');
}

const HEADER = `# DeepLore Enhanced — Diagnostic Report

> **For support:** Attach this file when opening an issue at <${ISSUE_URL}>.
>
> **For self-diagnosis:** Drop this entire file into a flagship LLM (Claude, GPT-5,
> Gemini). It will decode the base64 blocks automatically and diagnose your setup.

---

## Privacy & Verification

This report has been **anonymized** before being written:

- **Redacted:** API keys, auth tokens, \`Authorization\` / \`X-Api-Key\` headers,
  long opaque tokens (32+ char base64/hex strings), OpenAI/Anthropic key formats.
- **Pseudonymized (cardinality preserved):** IPv4 / IPv6 addresses, hostnames in
  URLs, email addresses, Windows/POSIX user home paths, vault entry titles and
  filenames. Each unique value gets a stable per-report alias like \`<ip-1>\`,
  \`<host-2>\`, \`<title-3>\` so a reader can still follow "the same entry was
  selected 12 times" without learning the real value. Aliases are **fresh per
  report** and cannot be correlated across files.
- **Excluded entirely (never read):** chat message bodies, vault entry contents,
  vault entry summaries.

**Please verify this yourself before sharing.** The format is plain text/markdown
wrapped around base64 blobs; any flagship LLM can decompress and audit it inline.

If you find something the scrubber missed, **that's a bug** — please open an issue.

---
`;

// AI-facing content: instructions, schema, form, patterns.
// Base64-encoded in the report so it doesn't clutter GitHub issues.
const AI_INSTRUCTIONS = `## How to Read This File (for AI assistants)

You are looking at a DeepLore Enhanced (DLE) diagnostic report. Your job is to
diagnose what's wrong with the user's setup.

1. Start with **Summary Data** above — it's pre-digested.
2. The base64 blob between \`---DLE-DATA-BEGIN---\` and \`---DLE-DATA-END---\` is
   gzip-compressed JSON (or uncompressed base64 if gzip was unavailable). Decode
   it (\`atob\` -> gunzip -> JSON.parse, or just \`atob\` -> JSON.parse) for full data:
   - \`snapshot\` — settings, full vault metadata, full pipeline trace, health check
   - \`flightRecorder\` — last ~20 generations (summarized)
   - \`consoleLog\` — last ~800 console entries (level, msg, timestamp)
   - \`networkLog\` — last ~300 fetch/XHR entries (method, url, status, duration)
   - \`errorLog\` — last ~100 window.onerror / unhandledrejection entries
   - \`longTasks\` — last ~100 main-thread blocks >50ms
   - \`memory\` — JS heap snapshot
3. Fill out the **Diagnostic Form** below and present it to the user.

### Schema reference

\`pipelineTrace\` fields (in \`snapshot.pipeline.lastPipelineTrace\`):
- \`keywordMatched[]\` — entries that matched on keyword/BM25 in stage 1
- \`aiSelected[]\` — entries the AI picked in stage 2
- \`gatedOut[]\`, \`contextualGatingRemoved[]\` — removed by era/location/scene gating
- \`cooldownRemoved[]\` — entries on cooldown
- \`warmupFailed[]\` — entries below their warmup keyword-hit threshold
- \`refineKeyBlocked[]\` — failed AND_ANY refine_keys check
- \`stripDedupRemoved[]\` — already in recent context
- \`budgetCut[]\` — dropped to fit token budget
- \`injected[]\` — final survivors actually sent to the model
- \`bootstrapActive\` — chat is short, bootstrap entries force-injected
- \`aiFallback\`, \`aiError\` — AI search failed, fell back to keyword/constants

\`circuit.open\` means the AI service is in circuit-breaker timeout (2 failures -> 30s cooldown).

\`snapshot.staleness.capturedDuringGeneration\` — if true, snapshot was taken mid-pipeline. Some fields may be partially populated.

\`snapshot.setupState\` — Wizard completion, migration sentinels, vault config summary. \`possiblyIncomplete\` flags wizard-done-but-no-vaults-enabled. \`vaultSummary[]\` shows per-vault enabled/host/apiKey status. \`settingsVersion\` tracks migration schema level.

\`snapshot.connections\` — Per-tool resolved connection config. \`tools.*\` shows effectiveMode, profileId, profileExists, profileModel, proxyUrl for each DLE tool (aiSearch, scribe, librarian, etc.). \`profiles.*\` has full ST profile objects. \`stActiveConnection\` shows ST's own active API/model/proxy. \`issues[]\` flags missing profiles and broken inherit chains.

\`snapshot.chatContext\` — Chat state at snapshot time: characterId, characterName, groupId, isGroupChat, chatLength, lastMessageRole, lastMessageHasContent.

\`snapshot.obsidianCircuitBreakers\` — Per-vault (keyed by host:port) circuit breaker state: state (closed/open/half-open), failures, backoffRemaining. Null if no vaults have been contacted.

\`snapshot.librarian\` — Librarian subsystem state: tools registered, lore gap count, session/chat stats. \`toolsInToolManager\` shows whether DLE tools actually exist in ST's ToolManager (not just the registration flag). \`functionCallingEnabled\` shows if the active connection supports tool use. \`gapsHiddenCount\`/\`gapsDismissedCount\` show suppressed lore gaps.

\`snapshot.staleness.generationLockZombie\` — true if generation lock has been held >60s, indicating a stuck pipeline.

\`snapshot.matching\` — Entity matching state: entity name set size, regex count/version, field definitions, mention weights, fuzzy search index.

### Common patterns to look for

- **Circuit breaker tripped** -> AI keeps timing out or 5xx-ing. Check timeout, model id, network log.
- **Constants eating budget** -> many entries with \`constant: true\` and high token counts. Check budget %.
- **Pre-filter too aggressive** -> \`hierarchicalAggressiveness\` close to 0.8 starves later stages.
- **Requires/excludes contradiction** -> entry that requires X also excludes X (or vice versa).
- **Atmospheric entries with no keys** -> \`withoutKeys\` is high, those entries are dead weight.
- **Missing summaries** -> \`withSummary\` << \`entryCount\`. AI pre-filter handicapped.
- **Stuck warmup** -> same entry appears in \`warmupFailed\` many generations in a row.
- **Repeated aborts** -> multiple abort entries in flight recorder. User may be impatient or pipeline is too slow.
- **Zero injections** -> injection trend shows all zeros. Pipeline is matching entries but they're all being gated/cooldown'd/budget-cut.
- **Missing connection profile** -> \`snapshot.connections.tools.*.profileExists === false\`. Profile ID configured but deleted from ST Connection Manager. User needs to re-select a profile in DLE AI Connections settings.
- **Inherit chain confusion** -> tool has \`effectiveMode\` different from its configured mode. Check \`snapshot.connections.tools\` — inherit resolves through aiSearch. If aiSearch itself is misconfigured, all inheriting tools break.
- **Wrong model for tool** -> \`profileModel\` in connections table doesn't match what user expects. Common when profile was edited after DLE was configured.
- **Proxy with no CORS** -> tool mode is 'proxy' but calls fail. Check if \`enableCorsProxy\` is true in ST config (visible in network log 403 errors).
- **Obsidian vault circuit breaker open** -> \`obsidianCircuitBreakers["host:port"].state === "open"\`. One vault being down can make all entries from that vault invisible. Check which vault is affected and whether Obsidian REST API plugin is running.
- **Librarian tools missing from ToolManager** -> \`librarian.toolsInToolManager.dleSearchLore === false\`. Tools were registered but another extension rebuilt ToolManager, or function calling is disabled on the active connection profile.
- **Function calling disabled** -> \`librarian.functionCallingEnabled === false\`. Librarian tools exist but the AI can't call them. User needs to enable function calling on their connection profile.
- **Zombie generation lock** -> \`staleness.generationLockZombie === true\`. Pipeline hung and lock wasn't released. Subsequent generations are blocked.
- **Group chat entity confusion** -> \`chatContext.isGroupChat === true\` and entity matching shows unexpected character names. Group chats have multiple characters; entity regex may be matching the wrong character's lore.
- **AI cache stale after regex rebuild** -> \`ai.cacheRegexVersionMatch === false\`. Cache was written before entity regexes were rebuilt (e.g. after vault re-index). Next generation will use stale entity matching data.
- **Dismissed lore gaps** -> \`librarian.gapsDismissedCount\` > 0. User may have permanently dismissed valid gaps that should be re-examined.
- **Wizard skipped or incomplete** -> \`setupState.possiblyIncomplete === true\`. User marked wizard complete but no vaults are enabled. DLE has nothing to work with. Guide them through vault setup.
- **Vault missing host or API key** -> \`setupState.vaultSummary[].hasHost === false\` or \`hasApiKey === false\`. Vault configured but can't connect. Often caused by partial wizard completion.
- **Settings version mismatch** -> \`setupState.settingsVersion\` is null or lower than expected (currently 2). Old settings may lack required fields and migrations may not have run.
- **Index never loaded** -> \`setupState.indexEverLoaded === false\` AND \`setupState.hasEnabledVaults === true\`. Vault is configured but index never built — likely Obsidian connection failure or missing REST API plugin.

### Diagnostic Form (please fill out)

\`\`\`
ISSUE: <one-line description>
SEVERITY: <blocker | major | minor | cosmetic>

ROOT CAUSE: <your best hypothesis>
EVIDENCE:
  - <data point 1 from this report>
  - <data point 2>

RECOMMENDED ACTIONS (prioritized):
  1. <first thing the user should try>
  2. <second>
  3. <third>

REPORT THIS BUG?
  - <yes/no — is this a DLE bug, a config issue, or expected behavior?>
\`\`\`
`;

/** Build a scrubber stats section showing what was redacted. */
function buildScrubberReport(ctx) {
    const s = ctx.stats;
    const parts = [];
    if (s.ips > 0)             parts.push(`IPs: ${s.ips}`);
    if (s.ipv6s > 0)           parts.push(`IPv6: ${s.ipv6s}`);
    if (s.hosts > 0)           parts.push(`Hostnames: ${s.hosts}`);
    if (s.emails > 0)          parts.push(`Emails: ${s.emails}`);
    if (s.userPaths > 0)       parts.push(`User paths: ${s.userPaths}`);
    if (s.titles > 0)          parts.push(`Titles: ${s.titles}`);
    if (s.sensitiveFields > 0) parts.push(`Sensitive fields: ${s.sensitiveFields}`);
    if (s.bearerTokens > 0)    parts.push(`Bearer tokens: ${s.bearerTokens}`);
    if (s.urlTokens > 0)       parts.push(`URL tokens: ${s.urlTokens}`);
    if (s.openaiKeys > 0)      parts.push(`API keys: ${s.openaiKeys}`);
    if (s.longTokens > 0)      parts.push(`Long tokens: ${s.longTokens}`);

    if (parts.length === 0) return '### Scrubber Report\n_No sensitive data patterns detected._\n';
    return `### Scrubber Report\n- Pseudonymized: ${parts.filter(p => /^(IPs|IPv6|Host|Email|User|Title)/.test(p)).join(' | ')}\n- Redacted: ${parts.filter(p => !/^(IPs|IPv6|Host|Email|User|Title)/.test(p)).join(' | ')}\n`;
}

const MAX_VERBOSE_SIZE = 5 * 1024 * 1024; // 5 MB pre-compression safety limit

/**
 * Build unanonymized connections reference (user's eyes only, never shared).
 * @param {object} rawSnapshot — raw snapshot before scrubbing
 * @returns {string} plain-text markdown
 */
function buildConnectionsReference(rawSnapshot) {
    const lines = [];
    lines.push('# DLE Connections Reference (YOUR EYES ONLY)');
    lines.push('');
    lines.push('> This file contains your **real** connection data — profile names, URLs, models.');
    lines.push('> **Do NOT share this file.** It is for your own reference only.');
    lines.push('> The anonymized diagnostic report (the other file) is safe to share.');
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    const conn = rawSnapshot.connections;
    if (!conn || conn.__error) {
        lines.push('_Connection data unavailable._');
        return lines.join('\n');
    }

    // ST active connection
    if (conn.stActiveConnection) {
        const st = conn.stActiveConnection;
        lines.push('## SillyTavern Active Connection');
        lines.push(`- Main API: ${st.mainApi || '?'}`);
        lines.push(`- Chat completion source: ${st.chatCompletionSource || '?'}`);
        if (st.reverseProxy) lines.push(`- Reverse proxy: ${st.reverseProxy}`);
        if (st.selectedModel) lines.push(`- Model: ${st.selectedModel}`);
        if (st.claudeModel) lines.push(`- Claude model: ${st.claudeModel}`);
        if (st.openrouterModel) lines.push(`- OpenRouter model: ${st.openrouterModel}`);
        lines.push(`- Total profiles: ${st.totalProfiles}`);
        lines.push('');
    }

    // Per-tool table
    if (conn.tools) {
        lines.push('## DLE Tool Connections');
        lines.push('');
        lines.push('| Tool | Mode | Target | Model | Timeout | Max Tokens |');
        lines.push('|------|------|--------|-------|---------|------------|');
        for (const [key, t] of Object.entries(conn.tools)) {
            if (t.__error) {
                lines.push(`| ${key} | ERROR | — | — | — | — |`);
                continue;
            }
            const mode = t.effectiveMode || '?';
            let target = '—';
            if (mode === 'profile') {
                target = t.profileName || t.profileId || '(none)';
                if (t.profileExists === false) target += ' ❌ MISSING';
            } else if (mode === 'proxy') {
                target = t.proxyUrl || '(no URL)';
            }
            const model = t.model || t.profileModel || '(default)';
            const timeout = t.timeout ? `${Math.round(t.timeout / 1000)}s` : '—';
            const maxTok = t.maxTokens ?? '—';
            lines.push(`| ${key} | ${mode} | ${target} | ${model} | ${timeout} | ${maxTok} |`);
        }
        lines.push('');
    }

    // Full profile objects
    if (conn.profiles && Object.keys(conn.profiles).length > 0) {
        lines.push('## Full Profile Details');
        lines.push('');
        for (const [id, p] of Object.entries(conn.profiles)) {
            lines.push(`### ${p.name || id}`);
            lines.push(`- ID: ${id}`);
            lines.push(`- API: ${p.api || '?'}`);
            lines.push(`- Model: ${p.model || '?'}`);
            if (p['api-url']) lines.push(`- API URL: ${p['api-url']}`);
            if (p.proxy) lines.push(`- Proxy preset: ${p.proxy}`);
            if (p.preset) lines.push(`- Settings preset: ${p.preset}`);
            if (p.instruct) lines.push(`- Instruct: ${p.instruct}`);
            if (p.context) lines.push(`- Context: ${p.context}`);
            if (p.tokenizer) lines.push(`- Tokenizer: ${p.tokenizer}`);
            lines.push('');
        }
    }

    // Issues
    if (conn.issues?.length > 0) {
        lines.push('## ⚠ Connection Issues');
        for (const issue of conn.issues) lines.push(`- ${issue}`);
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Build the full diagnostic report.
 * Returns { report, referenceFile, scrubStats } so the UI can download both files
 * and show scrub stats in the confirmation popup.
 */
export async function buildDiagnosticReport() {
    // 1. Atomic drain — one snapshot moment, one truth.
    //    All buffers are drained BEFORE captureStateSnapshot() because
    //    snapshot -> runHealthCheck() can trigger console.log, which would
    //    push new items between drains if we interleaved them.
    const rawGens    = generationBuffer.drain();
    const rawConsole = consoleBuffer.drain();
    const rawNetwork = networkBuffer.drain();
    const rawErrors  = errorBuffer.drain();
    const rawLong    = longTaskBuffer.drain();
    const rawMemory  = captureMemorySnapshot();
    const rawSnapshot = captureStateSnapshot();

    // 2. Shared scrub context — one set of pseudonym tables for the entire report.
    //    Both the summary section and the verbose blob use the same ctx, so
    //    <ip-1> in the summary always means the same real IP as <ip-1> in the blob.
    //    IMPORTANT: Do NOT share the _seen WeakMap across scrubDeep calls — each
    //    call creates its own. Sharing would cause false [circular] detections.
    const ctx = makeCtx();
    const snapshot = scrubDeep(rawSnapshot, ctx);

    // 3. Summary uses scrubbed generations (fixes PII leak in aiError strings)
    const scrubbedGens = scrubDeep(rawGens, ctx);
    const summarySection = buildSummarySection(snapshot, scrubbedGens);

    // 4. Verbose payload — raw data, same ctx for consistent pseudonyms
    let verboseInput = {
        version: 1,
        format: 'dle-diagnostic-v1',
        snapshot: rawSnapshot,
        flightRecorder: rawGens,
        consoleLog: rawConsole,
        networkLog: rawNetwork,
        errorLog: rawErrors,
        longTasks: rawLong,
        memory: rawMemory,
    };

    const verbose = scrubDeep(verboseInput, ctx);
    let json = JSON.stringify(verbose);

    // 5. Size cap — truncate oldest entries if payload is too large
    if (json.length > MAX_VERBOSE_SIZE) {
        verbose.consoleLog = verbose.consoleLog?.slice(-200) ?? [];
        verbose.networkLog = verbose.networkLog?.slice(-100) ?? [];
        verbose.errorLog = verbose.errorLog?.slice(-50) ?? [];
        verbose.longTasks = verbose.longTasks?.slice(-50) ?? [];
        verbose.__truncated = true;
        json = JSON.stringify(verbose);
    }

    // 6. Compress verbose payload (with fallback)
    const { b64, compressed } = await gzipBase64(json);

    // 7. Base64-encode AI instructions
    const aiInstructionsB64 = btoa(unescape(encodeURIComponent(AI_INSTRUCTIONS)));

    // 8. Build scrubber report
    const scrubberReport = buildScrubberReport(ctx);

    // 9. Build unanonymized connections reference from raw snapshot
    const referenceFile = buildConnectionsReference(rawSnapshot);

    // 10. Assemble final markdown
    const sizeKb = (json.length / 1024).toFixed(1);
    const compressedKb = (b64.length * 0.75 / 1024).toFixed(1);
    const encoding = compressed ? 'base64(gzip(JSON))' : 'base64(JSON) — gzip unavailable';

    const report = [
        HEADER,
        scrubberReport,
        '',
        summarySection,
        '',
        '---',
        '',
        '## AI Diagnostic Instructions (base64)',
        '_Drop this entire file into a flagship LLM. It will decode this block automatically._',
        '',
        '```',
        '---AI-INSTRUCTIONS-BEGIN---',
        aiInstructionsB64,
        '---AI-INSTRUCTIONS-END---',
        '```',
        '',
        '---',
        '',
        '## Verbose Data',
        '',
        `_Original: ${sizeKb} KB | Compressed: ${compressedKb} KB | Encoding: ${encoding}_`,
        verbose.__truncated ? '_**Warning:** Verbose data was truncated to fit within size limits._' : '',
        '',
        '```',
        '---DLE-DATA-BEGIN---',
        b64,
        '---DLE-DATA-END---',
        '```',
        '',
    ].join('\n');

    return { report, referenceFile, scrubStats: { ...ctx.stats } };
}
