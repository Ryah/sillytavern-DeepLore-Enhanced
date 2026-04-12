/**
 * DeepLore Enhanced — Self-Healing Diagnostics & Why Not?
 */
import { getSettings } from '../../settings.js';
import { buildScanText } from '../../core/utils.js';
import { testEntryMatch, countKeywordOccurrences } from '../../core/matching.js';
import {
    vaultIndex, indexTimestamp, cooldownTracker, injectionHistory,
    generationCount, lastPipelineTrace, trackerKey,
} from '../state.js';

/**
 * Run comprehensive health checks on the vault index and settings.
 * @returns {{ issues: Array<{type: string, severity: 'error'|'warning'|'info', entry: string, detail: string}>, errors: number, warnings: number }}
 */
export function runHealthCheck() {
    const settings = getSettings();
    const issues = [];

    // --- Multi-vault checks ---
    const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
    if (enabledVaults.length === 0) {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'No enabled vaults configured. Go to DeepLore Enhanced settings → Vault Connections and click "Add Vault".' });
    }
    for (const vault of enabledVaults) {
        if (!vault.apiKey) {
            issues.push({ type: 'Settings', severity: 'warning', entry: '—', detail: `Vault "${vault.name}" has no API key` });
        }
    }

    // --- Settings checks (no vault needed) ---

    if (settings.scanDepth === 0 && !settings.aiSearchEnabled) {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'Scan depth is 0 and AI search is disabled — nothing will ever match' });
    }

    if (settings.aiSearchEnabled && settings.aiSearchMode === 'ai-only' && settings.aiSearchConnectionMode === 'profile' && !settings.aiSearchProfileId) {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'AI-only mode enabled but no connection profile selected' });
    }

    if (settings.aiSearchEnabled && settings.aiSearchConnectionMode === 'proxy' && !settings.aiSearchProxyUrl) {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'AI search enabled in proxy mode but no proxy URL set' });
    }

    if (settings.scribeEnabled && settings.scribeConnectionMode === 'profile' && !settings.scribeProfileId) {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'Scribe enabled in profile mode but no profile selected' });
    }

    if (settings.scribeEnabled && settings.scribeConnectionMode === 'proxy' && !settings.scribeProxyUrl) {
        issues.push({ type: 'Settings', severity: 'error', entry: '—', detail: 'Scribe enabled in proxy mode but no proxy URL set' });
    }

    if (!settings.unlimitedBudget && settings.maxTokensBudget < 200) {
        issues.push({ type: 'Settings', severity: 'warning', entry: '—', detail: `Token budget very low (${settings.maxTokensBudget})` });
    }

    if (settings.recursiveScan && settings.maxRecursionSteps === 1) {
        issues.push({ type: 'Settings', severity: 'info', entry: '—', detail: 'Recursive scan enabled but max steps is 1 — only one extra pass' });
    }

    if (settings.cacheTTL === 0) {
        issues.push({ type: 'Settings', severity: 'info', entry: '—', detail: 'Cache disabled — vault will be fetched every generation' });
    }

    if (indexTimestamp > 0 && settings.cacheTTL > 0 && Date.now() - indexTimestamp > settings.cacheTTL * 1000 * 3) {
        issues.push({ type: 'Settings', severity: 'warning', entry: '—', detail: 'Index is very stale (more than 3x cache TTL old)' });
    }

    // --- Vault entry checks (require vaultIndex) ---
    if (vaultIndex.length === 0) {
        const errors = issues.filter(i => i.severity === 'error').length;
        const warnings = issues.filter(i => i.severity === 'warning').length;
        return { issues, errors, warnings };
    }

    const allTitles = new Set(vaultIndex.map(e => e.title));
    const allTitlesLower = new Set(vaultIndex.map(e => e.title.toLowerCase()));
    const allFilenamesLower = new Set(vaultIndex.map(e => {
        const parts = e.filename.split('/');
        return parts[parts.length - 1].replace(/\.md$/, '').toLowerCase();
    }));
    const titleCounts = new Map();
    const keywordMap = new Map();
    let constantTokenTotal = 0;

    for (const entry of vaultIndex) {
        // Duplicate titles
        titleCounts.set(entry.title, (titleCounts.get(entry.title) || 0) + 1);

        // Empty keys on non-constant, non-bootstrap entries
        if (!entry.constant && !entry.bootstrap && entry.keys.length === 0) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: 'No trigger keywords defined' });
        }

        // Empty content
        if (!entry.content || !entry.content.trim()) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: 'Entry has no content' });
        }

        // Orphaned requires (case-insensitive to match applyGating behavior)
        // Read from _originalRequires if present so dangling refs stripped at finalizeIndex are still surfaced.
        const requiresForCheck = entry._originalRequires || entry.requires;
        for (const req of requiresForCheck) {
            if (!allTitlesLower.has(req.toLowerCase())) {
                issues.push({ type: 'Gating', severity: 'error', entry: entry.title, detail: `Requires "${req}" which doesn't exist in the vault` });
            }
        }

        // Orphaned excludes (case-insensitive to match applyGating behavior)
        const excludesForCheck = entry._originalExcludes || entry.excludes;
        for (const exc of excludesForCheck) {
            if (!allTitlesLower.has(exc.toLowerCase())) {
                issues.push({ type: 'Gating', severity: 'error', entry: entry.title, detail: `Excludes "${exc}" which doesn't exist in the vault` });
            }
        }

        // Orphaned cascade_links (case-insensitive to match pipeline behavior)
        const cascadeForCheck = entry._originalCascadeLinks || entry.cascadeLinks;
        if (cascadeForCheck) {
            for (const cl of cascadeForCheck) {
                if (!allTitlesLower.has(cl.toLowerCase()) && !allFilenamesLower.has(cl.toLowerCase())) {
                    issues.push({ type: 'Gating', severity: 'warning', entry: entry.title, detail: `Cascade link "${cl}" doesn't exist in the vault` });
                }
            }
        }

        // Self-exclude detection
        if (entry.excludes.length > 0 && entry.excludes.some(exc => exc.toLowerCase() === entry.title.toLowerCase())) {
            issues.push({ type: 'Gating', severity: 'error', entry: entry.title, detail: 'This entry can never trigger because it excludes itself' });
        }

        // Requires AND excludes same title
        if (entry.requires.length > 0 && entry.excludes.length > 0) {
            for (const req of entry.requires) {
                if (entry.excludes.some(exc => exc.toLowerCase() === req.toLowerCase())) {
                    issues.push({ type: 'Gating', severity: 'error', entry: entry.title, detail: `Requires and excludes "${req}" simultaneously` });
                }
            }
        }

        // BUG-AUDIT-H22: Warn when excluding a force-injected entry (constant/seed/bootstrap)
        // — force-injected entries are always present, so this entry will be permanently blocked.
        if (entry.excludes.length > 0) {
            for (const exc of entry.excludes) {
                const target = vaultIndex.find(e => e.title.toLowerCase() === exc.toLowerCase());
                if (target && (target.constant || target.seed || target.bootstrap)) {
                    const kind = target.constant ? 'constant' : target.seed ? 'seed' : 'bootstrap';
                    issues.push({ type: 'Gating', severity: 'warning', entry: entry.title, detail: `Excludes "${exc}" which is a ${kind} (always injected) — this entry will always be blocked` });
                }
            }
        }

        // Oversized entries
        if (entry.tokenEstimate > 1500) {
            issues.push({ type: 'Size', severity: 'warning', entry: entry.title, detail: `~${entry.tokenEstimate} tokens (>1500)` });
        }

        // Missing summary when AI search is enabled
        if (settings.aiSearchEnabled && !entry.summary) {
            issues.push({ type: 'AI Search', severity: 'warning', entry: entry.title, detail: 'No AI selection summary defined' });
        }

        // Short keywords
        for (const key of entry.keys) {
            if (key.length <= 2) {
                issues.push({ type: 'Keywords', severity: 'info', entry: entry.title, detail: `Keyword "${key}" is ${key.length} char(s) — may cause false matches` });
            }
            const lower = key.toLowerCase();
            if (!keywordMap.has(lower)) keywordMap.set(lower, []);
            keywordMap.get(lower).push(entry.title);
        }

        // Cooldown on constant entries
        if (entry.constant && entry.cooldown !== null) {
            issues.push({ type: 'Entry Config', severity: 'info', entry: entry.title, detail: 'Cooldown on constant entry has no effect' });
        }

        // Warmup unlikely to trigger
        if (entry.warmup !== null && entry.warmup > 1 && entry.keys.length > 0 && entry.keys.every(k => k.length <= 3)) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: `Warmup ${entry.warmup} unlikely to trigger — all keywords are 3 chars or fewer` });
        }

        // Bootstrap with no keys and not constant
        if (entry.bootstrap && !entry.constant && entry.keys.length === 0) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: 'Bootstrap entry has no keywords — only active during cold start' });
        }

        // Seed entries with large content
        if (entry.seed && entry.tokenEstimate > 2000) {
            issues.push({ type: 'Size', severity: 'warning', entry: entry.title, detail: `Seed entry is large — ~${entry.tokenEstimate} tokens sent as AI context on new chats` });
        }

        // Depth override without in_chat position (consider global default when no per-entry override)
        const effectivePosition = entry.injectionPosition ?? settings.injectionPosition;
        if (entry.injectionDepth !== null && effectivePosition !== 1) {
            issues.push({ type: 'Injection', severity: 'warning', entry: entry.title, detail: 'Depth override ignored — effective position is not in_chat' });
        }

        // Role override without in_chat position
        if (entry.injectionRole !== null && effectivePosition !== 1) {
            issues.push({ type: 'Injection', severity: 'warning', entry: entry.title, detail: 'Role override ignored — effective position is not in_chat' });
        }

        // Unresolved wiki-links (case-insensitive since resolveLinks uses toLowerCase)
        if (entry.links.length > 0 && entry.resolvedLinks.length < entry.links.length) {
            const resolvedLower = new Set(entry.resolvedLinks.map(r => r.toLowerCase()));
            const unresolved = entry.links.filter(l => !resolvedLower.has(l.toLowerCase()));
            if (unresolved.length > 0) {
                issues.push({ type: 'Links', severity: 'info', entry: entry.title, detail: `Unresolved wiki-links: ${unresolved.join(', ')}` });
            }
        }

        // Excluded from recursion with no direct keywords
        if (entry.excludeRecursion && entry.keys.length === 0 && !entry.constant) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: "Entry won't match via recursion and has no keywords" });
        }

        // Probability zero
        if (entry.probability === 0) {
            issues.push({ type: 'Entry Config', severity: 'warning', entry: entry.title, detail: 'Entry will never trigger (probability is 0)' });
        }

        // Track constant token total
        if (entry.constant) {
            constantTokenTotal += entry.tokenEstimate;
        }
    }

    // Duplicate titles
    for (const [title, count] of titleCounts) {
        if (count > 1) {
            issues.push({ type: 'Entry Config', severity: 'error', entry: title, detail: `Duplicate title — ${count} entries share this name` });
        }
    }

    // Duplicate keywords across entries
    for (const [keyword, titles] of keywordMap) {
        if (titles.length > 1) {
            issues.push({ type: 'Keywords', severity: 'info', entry: titles.join(', '), detail: `Keyword "${keyword}" shared by ${titles.length} entries` });
        }
    }

    // Circular requires: A requires B, B requires A
    // Pre-build a Map for O(n) lookups instead of O(n²) .find() per entry
    const requiresMap = new Map();
    for (const entry of vaultIndex) {
        if (entry.requires.length > 0) {
            requiresMap.set(entry.title.toLowerCase(), { title: entry.title, requires: entry.requires });
        }
    }
    for (const [titleLower, { title, requires }] of requiresMap) {
        for (const req of requires) {
            const target = requiresMap.get(req.toLowerCase());
            if (target && target.requires.some(r => r.toLowerCase() === titleLower)) {
                // Only report once (alphabetically first)
                if (title < target.title) {
                    issues.push({ type: 'Gating', severity: 'error', entry: `${title} ↔ ${target.title}`, detail: 'Neither entry can trigger because they each require the other' });
                }
            }
        }
    }

    // Constants total tokens exceed budget
    if (!settings.unlimitedBudget && constantTokenTotal > settings.maxTokensBudget) {
        issues.push({ type: 'Size', severity: 'warning', entry: '—', detail: `Constants alone total ~${constantTokenTotal} tokens, exceeding budget of ${settings.maxTokensBudget}` });
    }

    // Librarian: topics searched 3+ times with 0 results
    try {
        const unmet = settings.analyticsData?._librarian?.topUnmetQueries || [];
        const frequentMisses = unmet.filter(u => u.count >= 3);
        for (const miss of frequentMisses) {
            issues.push({ type: 'Librarian', severity: 'info', entry: '—', detail: `AI searched for "${miss.query}" ${miss.count} times with no results — consider creating an entry` });
        }
    } catch { /* noop */ }

    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warning').length;
    return { issues, errors, warnings };
}

/**
 * Diagnose why an entry was not matched/injected.
 * @param {import('../core/pipeline.js').VaultEntry} entry
 * @param {object[]} chatMsgs
 * @returns {{ stage: string, detail: string, suggestions: string[] }}
 */
export function diagnoseEntry(entry, chatMsgs) {
    const settings = getSettings();
    const result = { stage: 'unknown', detail: '', suggestions: [] };

    // Check 1: No keywords
    if (entry.keys.length === 0 && !entry.constant) {
        result.stage = 'no_keywords';
        result.detail = 'Entry has no trigger keywords defined.';
        result.suggestions.push('Add keywords to the entry frontmatter.');
        return result;
    }

    // Check 2: Scan depth zero
    const scanDepth = entry.scanDepth !== null ? entry.scanDepth : settings.scanDepth;
    if (scanDepth === 0) {
        result.stage = 'scan_depth_zero';
        result.detail = 'Scan depth is 0 — keyword matching is disabled.';
        result.suggestions.push('Increase scan depth or enable AI-only mode.');
        return result;
    }

    // Check 3: Keyword matching
    const scanText = buildScanText(chatMsgs, scanDepth);
    const matchedKey = testEntryMatch(entry, scanText, settings);

    if (!matchedKey) {
        const keyList = entry.keys.map(k => `"${k}"`).join(', ');
        result.stage = 'keyword_miss';
        result.detail = `None of the keywords (${keyList}) were found in the last ${scanDepth} messages.`;

        const widerText = buildScanText(chatMsgs, Math.min(chatMsgs.length, scanDepth * 3));
        const widerMatch = testEntryMatch(entry, widerText, settings);
        if (widerMatch) {
            result.suggestions.push(`Keyword "${widerMatch}" appears in older messages. Increase scan depth from ${scanDepth} to reach it.`);
        } else {
            result.suggestions.push('Add more relevant keywords or wait for these keywords to appear in chat.');
        }
        return result;
    }

    // Check 4: Refine keys
    if (entry.refineKeys && entry.refineKeys.length > 0) {
        const hasRefine = entry.refineKeys.some(rk => {
            const rKey = settings.caseSensitive ? rk : rk.toLowerCase();
            const haystack = settings.caseSensitive ? scanText : scanText.toLowerCase();
            return haystack.includes(rKey);
        });
        if (!hasRefine) {
            result.stage = 'refine_keys';
            result.detail = `Primary keyword matched but none of the refine keys (${entry.refineKeys.join(', ')}) were found.`;
            result.suggestions.push('The refine keys narrow the match — check if they are too restrictive.');
            return result;
        }
    }

    // Check 5: Warmup
    if (entry.warmup !== null) {
        const occurrences = countKeywordOccurrences(entry, scanText, settings);
        if (occurrences < entry.warmup) {
            result.stage = 'warmup';
            result.detail = `Needs ${entry.warmup} keyword occurrences, found ${occurrences}.`;
            result.suggestions.push('The keyword needs to appear more times in recent messages.');
            return result;
        }
    }

    // Check 6: Probability
    if (entry.probability !== null && entry.probability < 1.0) {
        result.stage = 'probability';
        result.detail = `Entry has ${Math.round(entry.probability * 100)}% probability — it was rolled out this time.`;
        return result;
    }

    // Check 7: Cooldown
    const cooldownRemaining = cooldownTracker.get(trackerKey(entry));
    if (cooldownRemaining !== undefined && cooldownRemaining > 0) {
        result.stage = 'cooldown';
        result.detail = `Per-entry cooldown: ${cooldownRemaining} generations remaining.`;
        return result;
    }

    // Check 8: Re-injection cooldown
    if (settings.reinjectionCooldown > 0) {
        const lastGen = injectionHistory.get(trackerKey(entry));
        if (lastGen !== undefined && (generationCount - lastGen) < settings.reinjectionCooldown) {
            result.stage = 'reinjection_cooldown';
            result.detail = `Re-injection cooldown: injected ${generationCount - lastGen} gen(s) ago, cooldown is ${settings.reinjectionCooldown}.`;
            return result;
        }
    }

    // Check 9: Gating
    if (lastPipelineTrace) {
        const allMatchedTitles = new Set([
            ...lastPipelineTrace.keywordMatched.map(m => m.title.toLowerCase()),
            ...lastPipelineTrace.aiSelected.map(m => m.title.toLowerCase()),
        ]);

        if (entry.requires && entry.requires.length > 0) {
            const missing = entry.requires.filter(r => !allMatchedTitles.has(r.toLowerCase()));
            if (missing.length > 0) {
                result.stage = 'gating_requires';
                result.detail = `Requires entries not currently matched: ${missing.join(', ')}`;
                result.suggestions.push(`These required entries must also match: ${missing.join(', ')}`);
                return result;
            }
        }
        if (entry.excludes && entry.excludes.length > 0) {
            const present = entry.excludes.filter(r => allMatchedTitles.has(r.toLowerCase()));
            if (present.length > 0) {
                result.stage = 'gating_excludes';
                result.detail = `Excluded by matched entries: ${present.join(', ')}`;
                return result;
            }
        }
    }

    // Check 10: AI rejection
    if (lastPipelineTrace && lastPipelineTrace.aiSelected) {
        const wasCandidate = lastPipelineTrace.keywordMatched?.some(m => m.title === entry.title);
        const wasSelected = lastPipelineTrace.aiSelected.some(m => m.title === entry.title);
        if (wasCandidate && !wasSelected) {
            result.stage = 'ai_rejected';
            result.detail = 'Entry was in the AI search candidate list but was not selected by the AI.';
            result.suggestions.push('Improve the entry summary to help the AI understand when to select it.');
            return result;
        }
    }

    // Check 11: Guide exclusion — guide entries never reach the writing AI
    if (entry.guide) {
        result.stage = 'guide_entry';
        result.detail = 'This is a lorebook-guide entry — it is only available to the Librarian, never injected into the writing AI prompt.';
        result.suggestions.push('Remove the lorebook-guide tag if you want this entry to be injected normally.');
        return result;
    }

    // Check 12: Folder filter — entry may be outside the active folder filter
    try {
        const cm = globalThis.chat_metadata || {};
        const folderFilter = cm.deeplore_folder_filter;
        if (Array.isArray(folderFilter) && folderFilter.length > 0 && entry.folderPath) {
            if (!folderFilter.some(f => entry.folderPath.startsWith(f))) {
                result.stage = 'folder_filter';
                result.detail = `Entry is in folder "${entry.folderPath}" which is not in the active folder filter.`;
                result.suggestions.push('Clear the folder filter or add this entry\'s folder to the filter.');
                return result;
            }
        }
    } catch { /* chat_metadata may not be available */ }

    // Check 13: Explicit block — entry is blocked in this chat
    try {
        const cm = globalThis.chat_metadata || {};
        const blocks = cm.deeplore_blocks;
        if (Array.isArray(blocks) && blocks.some(b => (b?.title || b) === entry.title)) {
            result.stage = 'blocked';
            result.detail = 'Entry is explicitly blocked in this chat (via pin/block controls).';
            result.suggestions.push('Unblock the entry using the drawer or /dle-unblock command.');
            return result;
        }
    } catch { /* chat_metadata may not be available */ }

    // Check 14: Contextual gating — era/location/scene/character fields may exclude this entry
    if (lastPipelineTrace && Array.isArray(lastPipelineTrace.contextualGatingRemoved)) {
        if (lastPipelineTrace.contextualGatingRemoved.some(e => e.title === entry.title)) {
            result.stage = 'contextual_gating';
            result.detail = 'Entry was removed by contextual gating (era, location, scene type, or character filter).';
            result.suggestions.push('Check the entry\'s custom fields against the current gating state (/dle-context-state).');
            return result;
        }
    }

    // Check 15: Strip dedup — entry was already injected recently
    if (lastPipelineTrace && Array.isArray(lastPipelineTrace.stripDedupRemoved)) {
        if (lastPipelineTrace.stripDedupRemoved.some(e => e.title === entry.title)) {
            result.stage = 'strip_dedup';
            result.detail = 'Entry was already injected in a recent generation and was stripped as a duplicate.';
            result.suggestions.push('This is normal behavior. Increase stripLookbackDepth if you want entries to re-inject sooner.');
            return result;
        }
    }

    // Check 16: Budget/max cut (fallback)
    result.stage = 'budget_cut';
    result.detail = 'Entry matched but was cut by budget limit or max entries cap.';
    result.suggestions.push('Increase token budget or max entries, or raise this entry\'s priority (lower number = higher priority).');
    return result;
}
