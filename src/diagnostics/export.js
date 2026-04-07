/**
 * export.js — Build the diagnostic markdown report.
 *
 * Output shape (matches mock-diagnostic-report.md, validated end-to-end):
 *   1. Header / privacy / how-to-read instructions (plaintext)
 *   2. Schema reference (plaintext)
 *   3. Diagnostic form template (plaintext)
 *   4. Summary data section (plaintext, scrubbed)
 *   5. ---DLE-DATA-BEGIN---
 *      base64(gzip(JSON(verbose data, scrubbed)))
 *      ---DLE-DATA-END---
 */

import { scrubDeep } from './scrubber.js';
import { captureStateSnapshot } from './state-snapshot.js';
import { consoleBuffer, networkBuffer, errorBuffer } from './interceptors.js';
import { generationBuffer } from './flight-recorder.js';
import { longTaskBuffer, captureMemorySnapshot } from './performance.js';

const ISSUE_URL = 'https://github.com/pixelnull/sillytavern-DeepLore-Enhanced/issues/new';

/**
 * Compress a string with gzip and return base64. Browser-native, no deps.
 * Works identically across Chrome 80+, Firefox 113+, Safari 16.4+, Edge 80+.
 */
async function gzipBase64(str) {
    const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000; // avoid stack overflow on large inputs
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

/** Build a compact, human-readable summary section for the top of the report. */
function buildSummarySection(snapshot) {
    const lines = [];
    const push = (s) => lines.push(s);

    push('## Summary Data (human-readable)');
    push('');
    push(`- Captured: ${snapshot.capturedAt}`);
    push(`- DLE version: ${snapshot.dleVersion || 'unknown'}`);
    if (snapshot.system) {
        push(`- Browser: ${snapshot.system.userAgent || 'unknown'}`);
        push(`- URL: ${snapshot.system.url || 'unknown'}`);
    }
    push('');

    if (snapshot.vault) {
        push('### Vault');
        push(`- Entries: **${snapshot.vault.entryCount}** (constants: ${snapshot.vault.constantCount}, seed: ${snapshot.vault.seedCount}, bootstrap: ${snapshot.vault.bootstrapCount})`);
        push(`- With summary: ${snapshot.vault.withSummary} / ${snapshot.vault.entryCount}`);
        push(`- Without keys: ${snapshot.vault.withoutKeys}`);
        push(`- Avg tokens/entry: ${Math.round(snapshot.vault.avgTokens || 0)}`);
        push(`- Indexing: ${snapshot.vault.indexing ? 'IN PROGRESS' : 'idle'} (everLoaded=${snapshot.vault.indexEverLoaded})`);
        push('');
    }

    if (snapshot.ai) {
        push('### AI Subsystem');
        push(`- Circuit breaker: **${snapshot.ai.circuit.open ? 'OPEN' : 'closed'}** (failures: ${snapshot.ai.circuit.failures})`);
        if (snapshot.ai.stats) {
            push(`- Calls: ${snapshot.ai.stats.calls} | Cached hits: ${snapshot.ai.stats.cachedHits} | In tok: ${snapshot.ai.stats.totalInputTokens} | Out tok: ${snapshot.ai.stats.totalOutputTokens}`);
        }
        if (snapshot.ai.cache) push(`- Cache: ${snapshot.ai.cache.resultCount} results, chatLineCount=${snapshot.ai.cache.chatLineCount}`);
        push('');
    }

    if (snapshot.pipeline) {
        push('### Pipeline');
        push(`- generationCount: ${snapshot.pipeline.generationCount} | chatEpoch: ${snapshot.pipeline.chatEpoch}`);
        push(`- generationLock: ${snapshot.pipeline.generationLock ? 'HELD' : 'free'}`);
        push('');
    }

    if (snapshot.health) {
        push('### Health Check');
        push(`- ${snapshot.health.errors} error(s), ${snapshot.health.warnings} warning(s)`);
        const top = (snapshot.health.issues || []).slice(0, 10);
        for (const i of top) push(`  - [${i.severity}] ${i.entry || ''} — ${i.detail || i.type}`);
        if ((snapshot.health.issues || []).length > 10) push(`  - … +${snapshot.health.issues.length - 10} more`);
        push('');
    }

    if (snapshot.extensionInventory) {
        push('### Installed Extensions');
        push(`- ${snapshot.extensionInventory.length} extensions: ${snapshot.extensionInventory.join(', ')}`);
        push('');
    }

    push('### Recent Generations (flight recorder)');
    const gens = generationBuffer.drain();
    if (gens.length === 0) {
        push('_No generations captured yet._');
    } else {
        for (const g of gens) {
            const s = g.summary || {};
            push(`- gen ${g.generationCount} @ ${new Date(g.t).toISOString()}: keyword=${s.keywordMatched} → aiSelected=${s.aiSelected} → injected=${s.injected}${s.aiError ? ` [aiError: ${s.aiError}]` : ''}${g.aiCircuitOpen ? ' [CIRCUIT OPEN]' : ''}`);
            if (s.injectedTitles && s.injectedTitles.length) {
                push(`    injected: ${s.injectedTitles.join(', ')}`);
            }
        }
    }
    push('');

    return lines.join('\n');
}

const HEADER = `# DeepLore Enhanced — Diagnostic Report

> **For support:** Attach this file when opening an issue at <${ISSUE_URL}>.
>
> **For self-diagnosis:** This file is intentionally designed to be read end-to-end
> by a flagship LLM (Claude, GPT-5, Gemini). Drop it into a fresh chat and ask it
> to "diagnose my DeepLore Enhanced setup." Decode the base64 blob at the bottom
> first if you want full data.

---

## Privacy & Verification

This report has been **anonymized as much as possible** before being written:

- **Redacted:** API keys, auth tokens, \`Authorization\` / \`X-Api-Key\` headers,
  long opaque tokens (32+ char base64/hex strings).
- **Pseudonymized (cardinality preserved):** IPv4 / IPv6 addresses, hostnames in
  URLs, email addresses, Windows/POSIX user home paths. Each unique value gets a
  stable per-report alias like \`<ip-1>\`, \`<host-2>\`, \`<email-1>\` so a reader
  can still tell "the same host errored 12 times in a row" without learning the
  real value. Aliases are **fresh per report** and cannot be correlated across
  files.
- **Excluded entirely (never read):** chat message bodies, vault entry contents,
  vault entry summaries.

**Please verify this yourself before sharing.** We want to prove we aren't hiding
anything. The format is plain text/markdown wrapped around a base64 gzip blob;
any flagship LLM can decompress and audit it inline. Try asking:

> *"Decode the base64 blob in this DLE diagnostic report and list every personally
> identifiable thing still in it."*

If you find something the scrubber missed, **that's a bug** — please open an issue.

---

## How to Read This File (for AI assistants)

You are looking at a DeepLore Enhanced (DLE) diagnostic report. Your job is to
diagnose what's wrong with the user's setup.

1. Start with **Summary Data** below — it's pre-digested.
2. The base64 blob between \`---DLE-DATA-BEGIN---\` and \`---DLE-DATA-END---\` is
   gzip-compressed JSON. Decode it (\`atob\` → gunzip → JSON.parse) for full data:
   - \`snapshot\` — settings, full vault metadata, full pipeline trace, health check
   - \`flightRecorder\` — last ~20 generations (summarized)
   - \`consoleLog\` — last ~800 console entries (level, msg, timestamp)
   - \`networkLog\` — last ~300 fetch/XHR entries (method, url, status, duration)
   - \`errorLog\` — last ~100 window.onerror / unhandledrejection entries
   - \`longTasks\` — last ~100 main-thread blocks >50ms
   - \`memory\` — JS heap snapshot
3. Fill out the **Diagnostic Form** at the bottom and present it to the user.

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

\`circuit.open\` means the AI service is in circuit-breaker timeout (2 failures → 30s cooldown).

### Common patterns to look for

- **Circuit breaker tripped** → AI keeps timing out or 5xx-ing. Check timeout, model id, network log.
- **Constants eating budget** → many entries with \`constant: true\` and high token counts. Check budget %.
- **Pre-filter too aggressive** → \`hierarchicalAggressiveness\` close to 0.8 starves later stages.
- **Requires/excludes contradiction** → entry that requires X also excludes X (or vice versa).
- **Atmospheric entries with no keys** → \`withoutKeys\` is high, those entries are dead weight.
- **Missing summaries** → \`withSummary\` ≪ \`entryCount\`. AI pre-filter handicapped.
- **Stuck warmup** → same entry appears in \`warmupFailed\` many generations in a row.

---

## Diagnostic Form (please fill out)

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

---
`;

/**
 * Build the full diagnostic report as a single string.
 * Returns the markdown text ready to be wrapped in a Blob.
 */
export async function buildDiagnosticReport() {
    // 1. Snapshot + scrub state
    const rawSnapshot = captureStateSnapshot();
    const snapshot = scrubDeep(rawSnapshot);

    // 2. Build the verbose payload — also scrubbed
    const verbose = scrubDeep({
        version: 1,
        format: 'dle-diagnostic-v1',
        snapshot,
        flightRecorder: generationBuffer.drain(),
        consoleLog: consoleBuffer.drain(),
        networkLog: networkBuffer.drain(),
        errorLog: errorBuffer.drain(),
        longTasks: longTaskBuffer.drain(),
        memory: captureMemorySnapshot(),
    });

    // 3. Build the human-readable top section (uses scrubbed snapshot)
    const summarySection = buildSummarySection(snapshot);

    // 4. Compress verbose payload
    const json = JSON.stringify(verbose);
    const b64 = await gzipBase64(json);

    // 5. Assemble final markdown
    const sizeKb = (json.length / 1024).toFixed(1);
    const compressedKb = (b64.length * 0.75 / 1024).toFixed(1);

    return [
        HEADER,
        summarySection,
        '',
        '---',
        '',
        '## Verbose Data (gzip + base64)',
        '',
        `_Original: ${sizeKb} KB · Compressed: ${compressedKb} KB · Encoding: base64(gzip(JSON))_`,
        '',
        '```',
        '---DLE-DATA-BEGIN---',
        b64,
        '---DLE-DATA-END---',
        '```',
        '',
    ].join('\n');
}
