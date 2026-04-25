/**
 * DeepLore Enhanced — Pipeline Stages
 * Pure(ish) functions extracted from onGenerate() for testability and clarity.
 * Each stage takes explicit inputs and returns outputs — no implicit global state reads.
 */
import { trackerKey } from './state.js';
import { normalizePinBlock, matchesPinBlock } from './helpers.js';
import { evaluateOperator } from './fields.js';

/** Lazy accessor for debugMode — avoids importing settings.js (which pulls ST globals that break tests). */
function _isDebug() {
    try {
        // Dynamic require avoided; read from the live settings object if available
        const ext = globalThis.extension_settings?.deeplore_enhanced;
        return ext?.debugMode === true;
    } catch { return false; }
}

// ============================================================================
// ExemptionPolicy
// ============================================================================

/**
 * Build the ExemptionPolicy: a single source of truth for which entries skip all gating.
 * forceInject entries skip: contextual gating, requires/excludes, reinjection cooldown, strip dedup.
 * Only budget limits can exclude a forceInject entry.
 *
 * @param {Array} vaultSnapshot - All vault entries
 * @param {Array} pins - Per-chat pinned entries (strings or {title, vaultSource} objects)
 * @param {Array} blocks - Per-chat blocked entries (strings or {title, vaultSource} objects)
 * @returns {{ forceInject: Set<string>, pins: Array<{title:string, vaultSource:string|null}>, blocks: Array<{title:string, vaultSource:string|null}> }}
 */
export function buildExemptionPolicy(vaultSnapshot, pins, blocks) {
    // BUG-AUDIT-9: Seeds and bootstraps are also exempt from contextual gating.
    // They are designed to be always-available in their respective scenarios, so
    // gating should not suppress them.
    // BUG-399 (Fix 2): forceInject keyed by trackerKey(entry) = `${vaultSource}:${title}`
    // so multi-vault duplicates don't collapse — vault-A's constant "Castle" no longer
    // exempts vault-B's non-constant "Castle".
    const forceInject = new Set();
    for (const entry of vaultSnapshot) {
        if (entry.constant || entry.seed || entry.bootstrap) forceInject.add(trackerKey(entry));
    }
    // H23: Normalize pin/block items to structured form (backward compat with bare strings)
    const normalizedPins = (pins || []).map(normalizePinBlock);
    const normalizedBlocks = (blocks || []).map(normalizePinBlock);
    // Pins are treated as constants with priority 10 — add them to forceInject.
    // Legacy bare-string pins have vaultSource=null (matches any vault), so walk the snapshot
    // and add trackerKey for every matching entry — one pin can produce N keys.
    for (const pb of normalizedPins) {
        for (const entry of vaultSnapshot) {
            if (matchesPinBlock(pb, entry)) forceInject.add(trackerKey(entry));
        }
    }
    return {
        forceInject,
        pins: normalizedPins,
        blocks: normalizedBlocks,
    };
}

// ============================================================================
// Stage 1: Pin/Block
// ============================================================================

/**
 * Apply per-chat pin/block overrides.
 * Pinned entries are added to the set (if not already matched) with constant=true and priority=10.
 * Blocked entries are removed entirely (blocks override constants).
 *
 * Returns shallow copies of pinned entries to avoid mutating shared vaultIndex objects.
 *
 * @param {Array} entries - Pipeline results (from runPipeline)
 * @param {Array} vaultSnapshot - Full vault snapshot (to find pinned entries not in pipeline results)
 * @param {{ forceInject: Set, pins: Set, blocks: Set }} policy
 * @param {Map} matchedKeys - Key match tracking map (mutated: pins get '(pinned)')
 * @returns {Array} Modified entries array
 */
export function applyPinBlock(entries, vaultSnapshot, policy, matchedKeys) {
    let result = [...entries];
    let addedCount = 0;
    let upgradedCount = 0;
    let blockedCount = 0;

    // Add pinned entries not already in results
    // H23: Use matchesPinBlock for vault-aware matching (backward compat with bare strings)
    if (policy.pins.length > 0) {
        // BUG-AUDIT-H15: Build title→index Map for O(1) lookup instead of findIndex per pin.
        const resultTitleIdx = new Map();
        for (let ri = 0; ri < result.length; ri++) {
            const lk = result[ri].title.toLowerCase();
            if (!resultTitleIdx.has(lk)) resultTitleIdx.set(lk, ri);
        }
        for (const entry of vaultSnapshot) {
            const isPinned = policy.pins.some(pb => matchesPinBlock(pb, entry));
            if (isPinned) {
                // BUG-030: Deep-clone array fields to prevent shared references with vaultIndex
                const cloneFields = {
                    keys: [...(entry.keys || [])],
                    tags: [...(entry.tags || [])],
                    requires: [...(entry.requires || [])],
                    excludes: [...(entry.excludes || [])],
                    links: [...(entry.links || [])],
                    resolvedLinks: [...(entry.resolvedLinks || [])],
                    // BUG-AUDIT-P8: Avoid JSON round-trip for customFields — shallow clone with array spread.
                    customFields: entry.customFields
                        ? Object.fromEntries(Object.entries(entry.customFields).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]))
                        : {},
                };
                const lowerTitle = entry.title.toLowerCase();
                if (!resultTitleIdx.has(lowerTitle)) {
                    resultTitleIdx.set(lowerTitle, result.length);
                    result.push({ ...entry, constant: true, priority: 10, ...cloneFields });
                    matchedKeys.set(entry.title, '(pinned)');
                    addedCount++;
                } else {
                    // Entry already matched — replace with pinned copy
                    const idx = resultTitleIdx.get(lowerTitle);
                    if (idx !== undefined) result[idx] = { ...entry, constant: true, priority: 10, ...cloneFields };
                    upgradedCount++;
                }
            }
        }
    }

    // Remove blocked entries (blocks override constants)
    // H23: Use matchesPinBlock for vault-aware matching
    if (policy.blocks.length > 0) {
        const beforeBlock = result.length;
        result = result.filter(e => !policy.blocks.some(pb => matchesPinBlock(pb, e)));
        blockedCount = beforeBlock - result.length;
    }

    if ((addedCount > 0 || upgradedCount > 0 || blockedCount > 0) && _isDebug()) {
        console.debug('[DLE] Pin/Block: +%d pinned, %d upgraded, -%d blocked', addedCount, upgradedCount, blockedCount);
    }

    return result;
}

// ============================================================================
// Stage 2: Contextual Gating
// ============================================================================

/**
 * Filter entries by contextual gating rules using custom field definitions.
 * Replaces the hardcoded era/location/sceneType/characterPresent logic with
 * a generic loop driven by fieldDefinitions.
 * ForceInject entries are exempt from all contextual gating.
 *
 * @param {Array} entries
 * @param {object} context - chat_metadata.deeplore_context (dynamic keys)
 * @param {{ forceInject: Set }} policy
 * @param {boolean} debugMode
 * @param {object} [settings] - Settings object (used for fallback tolerance)
 * @param {import('./fields.js').FieldDefinition[]} [fieldDefs] - Custom field definitions
 * @returns {Array} Filtered entries
 */
export function applyContextualGating(entries, context, policy, debugMode, settings, fieldDefs) {
    if (!fieldDefs || fieldDefs.length === 0) return entries;

    const fallbackTolerance = (settings && settings.contextualGatingTolerance) || 'strict';

    // Only apply gating if at least one context dimension is set
    const hasAnyContext = fieldDefs.some(fd => {
        if (!fd.gating || !fd.gating.enabled) return false;
        const val = context[fd.contextKey];
        return val != null && val !== '' && (!Array.isArray(val) || val.length > 0);
    });
    if (!hasAnyContext) return entries;

    const before = entries.length;
    const result = entries.filter(e => {
        if (policy.forceInject.has(trackerKey(e))) return true;

        for (const fd of fieldDefs) {
            if (!fd.gating || !fd.gating.enabled) continue;

            const entryValue = e.customFields?.[fd.name];
            const activeValue = context[fd.contextKey];
            const tolerance = fd.gating.tolerance || fallbackTolerance;
            const isExistenceOp = fd.gating.operator === 'exists' || fd.gating.operator === 'not_exists';

            // No entry value → pass (entry doesn't care about this field) — exempt
            // existence operators, which intentionally gate on the absence of a value.
            if (!isExistenceOp && (entryValue == null || (Array.isArray(entryValue) && entryValue.length === 0))) continue;
            // Empty string → pass (same exemption)
            if (!isExistenceOp && entryValue === '') continue;

            // Entry has value but no active context set for this field — existence
            // operators ignore active context entirely, so always let them evaluate.
            if (!isExistenceOp && (activeValue == null || activeValue === '' || (Array.isArray(activeValue) && activeValue.length === 0))) {
                if (tolerance === 'strict') return false;
                continue; // moderate/lenient: pass through
            }

            // Apply the field's operator
            if (!evaluateOperator(fd.gating.operator, entryValue, activeValue)) {
                // BUG-H8: Lenient tolerance only passes match_any/match_all non-matches as "not relevant".
                // Precision operators (eq, gt, lt, not_any) always filter — they express explicit constraints.
                if (tolerance === 'lenient' && (fd.gating.operator === 'match_any' || fd.gating.operator === 'match_all')) {
                    continue;
                }
                return false;
            }
        }
        return true;
    });

    if (debugMode && result.length < before) {
        const activeFields = fieldDefs
            .filter(fd => fd.gating?.enabled && context[fd.contextKey])
            .map(fd => `${fd.name}: ${context[fd.contextKey]}`)
            .join(', ');
        console.log(`[DLE] Contextual gating removed ${before - result.length} entries (${activeFields || 'none'})`);
    }

    return result;
}

// ============================================================================
// Stage 2b: Folder Filter
// ============================================================================

/**
 * Filter entries by active folder selection. When the user assigns specific
 * vault folders to a chat, only entries from those folders (and their subfolders)
 * are included. Root-level entries (no folder) always pass.
 * ForceInject entries are exempt from folder filtering.
 *
 * @param {Array} entries
 * @param {string[]|null} selectedFolders - Active folder paths, or null/empty for no filter
 * @param {{ forceInject: Set }} policy
 * @param {boolean} debugMode
 * @returns {Array} Filtered entries
 */
export function applyFolderFilter(entries, selectedFolders, policy, debugMode) {
    if (!selectedFolders || selectedFolders.length === 0) return entries;

    const before = entries.length;
    const result = entries.filter(e => {
        if (policy.forceInject.has(trackerKey(e))) return true;
        if (!e.folderPath) return true; // root entries always pass
        return selectedFolders.some(f => e.folderPath === f || e.folderPath.startsWith(f + '/'));
    });

    if (debugMode && result.length < before) {
        console.log(`[DLE] Folder filter removed ${before - result.length} entries (folders: ${selectedFolders.join(', ')})`);
    }

    return result;
}

// ============================================================================
// Stage 3: Re-injection Cooldown
// ============================================================================

/**
 * Filter out entries that were recently injected (within reinjectionCooldown generations).
 * ForceInject entries are exempt.
 *
 * @param {Array} entries
 * @param {{ forceInject: Set }} policy
 * @param {Map} injectionHistory - Map<trackerKey, lastInjectedGeneration>
 * @param {number} generationCount
 * @param {number} reinjectionCooldown - Number of generations to skip
 * @param {boolean} debugMode
 * @returns {Array} Filtered entries
 */
export function applyReinjectionCooldown(entries, policy, injectionHistory, generationCount, reinjectionCooldown, debugMode) {
    if (reinjectionCooldown <= 0) return entries;

    const before = entries.length;
    const result = entries.filter(e => {
        if (policy.forceInject.has(trackerKey(e))) return true;
        const lastGen = injectionHistory.get(trackerKey(e));
        if (lastGen !== undefined && (generationCount - lastGen) < reinjectionCooldown) {
            if (debugMode) {
                console.debug(`[DLE] Re-injection cooldown: "${e.title}" was injected ${generationCount - lastGen} gens ago (cooldown: ${reinjectionCooldown}) — skipping`);
            }
            return false;
        }
        return true;
    });

    if (debugMode && result.length < before) {
        console.log(`[DLE] Re-injection cooldown removed ${before - result.length} entries`);
    }

    return result;
}

// ============================================================================
// Stage 4: Requires/Excludes Gating (wraps core/matching.js applyGating)
// ============================================================================

/**
 * Apply requires/excludes gating with ExemptionPolicy support.
 * ForceInject entries are exempt from both requires and excludes.
 *
 * @param {Array} entries
 * @param {{ forceInject: Set }} policy
 * @param {boolean} debugMode
 * @returns {{ result: Array, removed: Array }}
 */
export function applyRequiresExcludesGating(entries, policy, debugMode) {
    // BUG-029: Sort descending by priority number (higher number = lower priority, processed first).
    // This ensures higher-priority entries (lower number) are checked last, so their
    // excludes targets may already be removed — the higher-priority entry survives.
    let result = [...entries].sort((a, b) => (b.priority || 50) - (a.priority || 50) || a.title.localeCompare(b.title));
    let changed = true;
    let iterations = 0;
    const MAX_ITERATIONS = 10;

    let activeTitles = new Set(result.map(e => e.title.toLowerCase()));

    while (changed && iterations < MAX_ITERATIONS) {
        changed = false;
        iterations++;

        const nextResult = [];
        for (const entry of result) {
            // ForceInject entries skip requires/excludes gating entirely
            if (policy.forceInject.has(trackerKey(entry))) { nextResult.push(entry); continue; }

            if (entry.requires && entry.requires.length > 0) {
                const allPresent = entry.requires.every(r => activeTitles.has(r.toLowerCase()));
                if (!allPresent) {
                    changed = true;
                    activeTitles.delete(entry.title.toLowerCase());
                    continue;
                }
            }
            if (entry.excludes && entry.excludes.length > 0) {
                const anyPresent = entry.excludes.some(r => activeTitles.has(r.toLowerCase()));
                if (anyPresent) {
                    changed = true;
                    activeTitles.delete(entry.title.toLowerCase());
                    continue;
                }
            }
            nextResult.push(entry);
        }
        result = nextResult;
    }

    // Detect contradictory gating for debugging
    const resultSet = new Set(result);
    const removed = entries.filter(e => !resultSet.has(e));
    if (removed.length > 0) {
        const entryMap = new Map(entries.map(e => [e.title.toLowerCase(), e]));
        for (const r of removed) {
            if (r.requires && r.requires.length > 0) {
                for (const req of r.requires) {
                    const reqEntry = entryMap.get(req.toLowerCase());
                    if (reqEntry && reqEntry.excludes && reqEntry.excludes.some(exc => exc.toLowerCase() === r.title.toLowerCase())) {
                        console.warn(`[DLE] Contradictory gating: "${r.title}" requires "${reqEntry.title}" but "${reqEntry.title}" excludes "${r.title}" — both dropped`);
                    }
                }
            }
        }
    }

    if (iterations >= MAX_ITERATIONS && changed) {
        console.warn('[DLE] Gating did not stabilize after', MAX_ITERATIONS, 'iterations');
    }

    if (debugMode && removed.length > 0) {
        console.log(`[DLE] Gating removed ${removed.length} entries:`,
            removed.map(e => ({ title: e.title, requires: e.requires, excludes: e.excludes })));
    }

    // BUG-012: Re-sort ascending by priority (lower number = higher priority) before
    // returning. The descending order used during iteration is an internal detail
    // of the excludes resolution loop; downstream consumers (formatAndGroup budget
    // cap) expect priority-ascending order so the most important entries survive
    // budget truncation.
    result.sort((a, b) => (a.priority || 50) - (b.priority || 50) || a.title.localeCompare(b.title));

    return { result, removed };
}

// ============================================================================
// Stage 5: Strip Duplicate Injections
// ============================================================================

/**
 * Filter out entries that were injected in recent generations (deduplication).
 * ForceInject entries are exempt.
 *
 * @param {Array} entries
 * @param {{ forceInject: Set }} policy
 * @param {Array} injectionLog - chat_metadata.deeplore_injection_log
 * @param {number} lookbackDepth
 * @param {object} defaultSettings - For fallback position/depth/role
 * @param {boolean} debugMode
 * @returns {Array} Filtered entries
 */
export function applyStripDedup(entries, policy, injectionLog, lookbackDepth, defaultSettings, debugMode) {
    if (debugMode) {
        console.debug('[DLE][DIAG] strip-dedup-fn-entry', {
            logExists: !!injectionLog,
            logIsArray: Array.isArray(injectionLog),
            logLength: injectionLog?.length ?? 0,
            lookbackDepth,
            entryCount: entries.length,
        });
    }
    if (!injectionLog || injectionLog.length === 0) {
        if (debugMode) console.debug('[DLE][DIAG] strip-dedup-fn-early-return — log empty or missing, returning all entries');
        return entries;
    }

    const recentEntries = new Set();
    const recentLogs = injectionLog.slice(-lookbackDepth);
    for (const logEntry of recentLogs.flatMap(l => l.entries || [])) {
        recentEntries.add(`${logEntry.title}|${logEntry.pos}|${logEntry.depth}|${logEntry.role}|${logEntry.contentHash || ''}`);
    }

    if (debugMode) {
        console.debug('[DLE][DIAG] strip-dedup-set', {
            recentLogCount: recentLogs.length,
            recentLogGens: recentLogs.map(l => l.gen),
            dedupSetSize: recentEntries.size,
            dedupTitles: [...recentEntries].map(k => k.split('|')[0]),
        });
    }

    const before = entries.length;
    const result = entries.filter(e => {
        const forceExempt = policy.forceInject.has(trackerKey(e));
        if (forceExempt) {
            if (debugMode) console.debug(`[DLE][DIAG] strip-dedup-entry-check EXEMPT "${e.title}" (forceInject)`);
            return true;
        }
        const key = `${e.title}|${e.injectionPosition ?? defaultSettings.injectionPosition}|${e.injectionDepth ?? defaultSettings.injectionDepth}|${e.injectionRole ?? defaultSettings.injectionRole}|${e._contentHash || ''}`;
        const matched = recentEntries.has(key);
        if (debugMode) {
            console.debug(`[DLE][DIAG] strip-dedup-entry-check "${e.title}" — ${matched ? 'STRIPPED' : 'KEPT'}`, { key });
        }
        return !matched;
    });

    if (debugMode && result.length < before) {
        console.debug(`[DLE][DIAG] strip-dedup-summary: removed ${before - result.length}/${before} entries`);
    }

    return result;
}

// ============================================================================
// Stage 6: Tracking (cooldowns, decay, injection history, analytics)
// ============================================================================

/**
 * Track cooldowns, decay, and injection history after a generation.
 * Only runs if epoch checks pass (caller is responsible for epoch gating).
 *
 * @param {Array} injectedEntries - Entries that were actually injected
 * @param {number} generationCount - Current generation count (pre-increment)
 * @param {Map} cooldownTracker - Mutable cooldown tracker
 * @param {Map} decayTracker - Mutable decay tracker
 * @param {Map} injectionHistory - Mutable injection history
 * @param {object} settings - Current settings
 */
export function trackGeneration(injectedEntries, generationCount, cooldownTracker, decayTracker, injectionHistory, settings) {
    // Set cooldown for injected entries that have a cooldown value
    for (const entry of injectedEntries) {
        if (entry.cooldown !== null && entry.cooldown > 0) {
            // Set to cooldown + 1 to compensate for the decrement that happens immediately after
            cooldownTracker.set(trackerKey(entry), entry.cooldown + 1);
        }
    }

    // Record injection history for re-injection cooldown
    if (settings.reinjectionCooldown > 0) {
        for (const entry of injectedEntries) {
            injectionHistory.set(trackerKey(entry), generationCount + 1);
        }
    }

    if (_isDebug() && injectedEntries.length > 0) {
        const cooldownCount = injectedEntries.filter(e => e.cooldown !== null && e.cooldown > 0).length;
        console.debug('[DLE] Track: %d injected, %d cooldowns set, reinjection=%s', injectedEntries.length, cooldownCount, settings.reinjectionCooldown > 0);
    }
}

/**
 * Decrement cooldown counters and update decay tracking.
 * Runs in the finally block of each generation.
 *
 * @param {Map} cooldownTracker
 * @param {Map} decayTracker
 * @param {Array} injectedEntries
 * @param {object} settings
 * @param {Map} [consecutiveInjections] - Mutable consecutive injection counter
 */
export function decrementTrackers(cooldownTracker, decayTracker, injectedEntries, settings, consecutiveInjections) {
    let expiredCooldowns = 0;
    let decayPruned = 0;
    let streaksBroken = 0;

    // Decrement cooldown counters; remove expired ones
    for (const [title, remaining] of cooldownTracker) {
        if (remaining <= 1) {
            cooldownTracker.delete(title);
            expiredCooldowns++;
        } else {
            cooldownTracker.set(title, remaining - 1);
        }
    }

    // Compute injectedKeys once (shared by decay and consecutive tracking)
    const injectedKeys = new Set(injectedEntries.map(e => trackerKey(e)));

    // Entry decay/freshness tracking
    if (settings.decayEnabled) {
        for (const entry of injectedEntries) {
            decayTracker.set(trackerKey(entry), 0);
        }
        const pruneThreshold = (settings.decayBoostThreshold || 5) * 2;
        for (const [tk, staleness] of decayTracker) {
            if (!injectedKeys.has(tk)) {
                if (staleness + 1 >= pruneThreshold) { // BUG-H10: off-by-one, was > causing 1 extra generation
                    decayTracker.delete(tk);
                    decayPruned++;
                } else {
                    decayTracker.set(tk, staleness + 1);
                }
            }
        }
    }

    // Consecutive injection counter — tracked independently of decay
    // (used by AI manifest builder for [FREQUENT] hints)
    if (consecutiveInjections) {
        for (const entry of injectedEntries) {
            const tk = trackerKey(entry);
            consecutiveInjections.set(tk, (consecutiveInjections.get(tk) || 0) + 1);
        }
        for (const [tk] of consecutiveInjections) {
            if (!injectedKeys.has(tk)) {
                consecutiveInjections.delete(tk);
                streaksBroken++;
            }
        }
    }

    if (_isDebug() && (expiredCooldowns > 0 || decayPruned > 0 || streaksBroken > 0)) {
        console.debug('[DLE] Decrement: %d cooldowns expired, %d decay pruned, %d streaks broken', expiredCooldowns, decayPruned, streaksBroken);
    }
}

/**
 * Record analytics for matched and injected entries.
 *
 * @param {Array} matchedEntries - All entries that were selected (pre-budget)
 * @param {Array} injectedEntries - Entries that were actually injected (post-budget)
 * @param {object} analyticsData - Mutable analytics object from settings
 */
export function recordAnalytics(matchedEntries, injectedEntries, analyticsData) {
    for (const entry of matchedEntries) {
        const aKey = trackerKey(entry);
        if (!Object.hasOwn(analyticsData, aKey)) {
            analyticsData[aKey] = { matched: 0, injected: 0, lastTriggered: 0 };
        }
        analyticsData[aKey].matched++;
        analyticsData[aKey].lastTriggered = Date.now();
    }
    for (const entry of injectedEntries) {
        const aKey = trackerKey(entry);
        if (!Object.hasOwn(analyticsData, aKey)) {
            analyticsData[aKey] = { matched: 0, injected: 0, lastTriggered: 0 };
        }
        analyticsData[aKey].injected++;
    }

    // Prune stale analytics entries not triggered in 30+ days
    const ANALYTICS_STALE_MS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let stalePruned = 0;
    for (const key of Object.keys(analyticsData)) {
        if (analyticsData[key].lastTriggered && (now - analyticsData[key].lastTriggered) > ANALYTICS_STALE_MS) {
            delete analyticsData[key];
            stalePruned++;
        }
    }

    // Cap total entries at 500 — evict oldest by lastTriggered to prevent unbounded growth.
    // Underscore-prefixed keys are meta buckets (e.g. `_librarian`) — exempt from eviction
    // because they have no lastTriggered stamp and would always sort first.
    const ANALYTICS_MAX = 500;
    const keys = Object.keys(analyticsData).filter(k => !k.startsWith('_'));
    let capEvicted = 0;
    if (keys.length > ANALYTICS_MAX) {
        keys.sort((a, b) => (analyticsData[a].lastTriggered || 0) - (analyticsData[b].lastTriggered || 0));
        for (const key of keys.slice(0, keys.length - ANALYTICS_MAX)) {
            delete analyticsData[key];
            capEvicted++;
        }
    }

    if (_isDebug() && (stalePruned > 0 || capEvicted > 0)) {
        console.debug('[DLE] Analytics: %d stale pruned, %d cap evicted', stalePruned, capEvicted);
    }
}
