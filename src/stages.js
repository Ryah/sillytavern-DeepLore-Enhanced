/**
 * DeepLore Enhanced — Pipeline Stages
 * Pure(ish) functions extracted from onGenerate() for testability and clarity.
 * Each stage takes explicit inputs and returns outputs — no implicit global state reads.
 */
import { trackerKey } from './state.js';

// ============================================================================
// ExemptionPolicy
// ============================================================================

/**
 * Build the ExemptionPolicy: a single source of truth for which entries skip all gating.
 * forceInject entries skip: contextual gating, requires/excludes, reinjection cooldown, strip dedup.
 * Only budget limits can exclude a forceInject entry.
 *
 * @param {Array} vaultSnapshot - All vault entries
 * @param {string[]} pins - Per-chat pinned entry titles
 * @param {string[]} blocks - Per-chat blocked entry titles
 * @returns {{ forceInject: Set<string>, pins: Set<string>, blocks: Set<string> }}
 */
export function buildExemptionPolicy(vaultSnapshot, pins, blocks) {
    const forceInject = new Set();
    for (const entry of vaultSnapshot) {
        if (entry.constant) forceInject.add(entry.title);
    }
    // Pins are treated as constants with priority 10 — add them to forceInject
    for (const title of pins) forceInject.add(title);
    return {
        forceInject,
        pins: new Set(pins),
        blocks: new Set(blocks.map(t => t.toLowerCase())),
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

    // Add pinned entries not already in results
    if (policy.pins.size > 0) {
        const pinLower = new Set([...policy.pins].map(t => t.toLowerCase()));
        const resultTitles = new Set(result.map(e => e.title.toLowerCase()));
        for (const entry of vaultSnapshot) {
            if (pinLower.has(entry.title.toLowerCase())) {
                if (!resultTitles.has(entry.title.toLowerCase())) {
                    // Create shallow copy with pin overrides to avoid mutating shared objects
                    const pinned = { ...entry, constant: true, priority: 10 };
                    result.push(pinned);
                    resultTitles.add(entry.title.toLowerCase());
                    matchedKeys.set(entry.title, '(pinned)');
                } else {
                    // Entry already matched — replace with pinned copy
                    const idx = result.findIndex(e => e.title.toLowerCase() === entry.title.toLowerCase());
                    if (idx !== -1) result[idx] = { ...entry, constant: true, priority: 10 };
                }
            }
        }
    }

    // Remove blocked entries (blocks override constants)
    if (policy.blocks.size > 0) {
        result = result.filter(e => !policy.blocks.has(e.title.toLowerCase()));
    }

    return result;
}

// ============================================================================
// Stage 2: Contextual Gating
// ============================================================================

/**
 * Filter entries by contextual gating rules (era, location, scene type, character present).
 * ForceInject entries are exempt from all contextual gating.
 *
 * @param {Array} entries
 * @param {{ era?: string, location?: string, scene_type?: string, characters_present?: string[] }} context
 * @param {{ forceInject: Set }} policy
 * @param {boolean} debugMode
 * @returns {Array} Filtered entries
 */
export function applyContextualGating(entries, context, policy, debugMode, settings) {
    const activeEra = (context.era || '').toLowerCase();
    const activeLocation = (context.location || '').toLowerCase();
    const activeScene = (context.scene_type || '').toLowerCase();
    const presentChars = (context.characters_present || []).map(c => c.toLowerCase());

    const tolerance = (settings && settings.contextualGatingTolerance) || 'strict';

    // Only apply gating if at least one context dimension is set
    if (!activeEra && !activeLocation && !activeScene && presentChars.length === 0) {
        return entries;
    }

    // E5: Lenient — if ALL active context dimensions are empty, allow everything through
    if (tolerance === 'lenient') {
        return entries;
    }

    const before = entries.length;
    const result = entries.filter(e => {
        if (policy.forceInject.has(e.title)) return true;

        // Era gating
        if (e.era && e.era.length > 0) {
            if (activeEra) {
                if (!e.era.some(v => v.toLowerCase() === activeEra)) return false;
            } else if (tolerance === 'strict') {
                return false; // Entry requires an era but none is set
            }
            // moderate: entry has era set but active context doesn't — allow through
        }
        // Location gating
        if (e.location && e.location.length > 0) {
            if (activeLocation) {
                if (!e.location.some(v => v.toLowerCase() === activeLocation)) return false;
            } else if (tolerance === 'strict') {
                return false;
            }
            // moderate: entry has location set but active context doesn't — allow through
        }
        // Scene type gating
        if (e.sceneType && e.sceneType.length > 0) {
            if (activeScene) {
                if (!e.sceneType.some(v => v.toLowerCase() === activeScene)) return false;
            } else if (tolerance === 'strict') {
                return false;
            }
            // moderate: entry has sceneType set but active context doesn't — allow through
        }
        // Character present gating
        if (e.characterPresent && e.characterPresent.length > 0) {
            if (presentChars.length === 0) {
                if (tolerance === 'strict') return false;
                // moderate/lenient: no active characters — allow through
            } else if (!e.characterPresent.some(c => presentChars.some(p => c.toLowerCase() === p))) {
                return false;
            }
        }
        return true;
    });

    if (debugMode && result.length < before) {
        console.log(`[DLE] Contextual gating removed ${before - result.length} entries (era: ${activeEra || 'none'}, location: ${activeLocation || 'none'}, scene: ${activeScene || 'none'})`);
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
        if (policy.forceInject.has(e.title)) return true;
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
    let result = [...entries];
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
            if (policy.forceInject.has(entry.title)) { nextResult.push(entry); continue; }

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
    if (!injectionLog || injectionLog.length === 0) return entries;

    const recentEntries = new Set();
    const recentLogs = injectionLog.slice(-lookbackDepth);
    for (const logEntry of recentLogs.flatMap(l => l.entries || [])) {
        recentEntries.add(`${logEntry.title}|${logEntry.pos}|${logEntry.depth}|${logEntry.role}|${logEntry.contentHash || ''}`);
    }

    const before = entries.length;
    const result = entries.filter(e => {
        if (policy.forceInject.has(e.title)) return true;
        const key = `${e.title}|${e.injectionPosition ?? defaultSettings.injectionPosition}|${e.injectionDepth ?? defaultSettings.injectionDepth}|${e.injectionRole ?? defaultSettings.injectionRole}|${e._contentHash || ''}`;
        if (recentEntries.has(key)) {
            if (debugMode) {
                console.debug(`[DLE] Strip: "${e.title}" already injected in recent ${lookbackDepth} gen(s) — skipping`);
            }
            return false;
        }
        return true;
    });

    if (debugMode && result.length < before) {
        console.log(`[DLE] Strip dedup removed ${before - result.length} entries`);
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
    // Decrement cooldown counters; remove expired ones
    for (const [title, remaining] of cooldownTracker) {
        if (remaining <= 1) {
            cooldownTracker.delete(title);
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
                if (staleness + 1 > pruneThreshold) {
                    decayTracker.delete(tk);
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
            if (!injectedKeys.has(tk)) consecutiveInjections.delete(tk);
        }
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
    for (const key of Object.keys(analyticsData)) {
        if (analyticsData[key].lastTriggered && (now - analyticsData[key].lastTriggered) > ANALYTICS_STALE_MS) {
            delete analyticsData[key];
        }
    }
}
