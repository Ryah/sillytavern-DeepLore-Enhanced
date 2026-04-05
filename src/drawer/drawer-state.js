/**
 * DeepLore Enhanced — Drawer Shared State & Constants
 * Shared between drawer.js, drawer-render.js, and drawer-events.js.
 */
import { escapeHtml } from '../../../../../utils.js';
import { parseMatchReason } from '../helpers.js';
import { chatInjectionCounts, consecutiveInjections, vaultIndex, trackerKey } from '../state.js';

// ─── Constants ───

export const DRAWER_ID = 'deeplore-drawer';
export const MODULE_NAME = 'deeplore-enhanced';

/** Tab name → display label map */
export const TAB_LABELS = {
    injection: 'Why?',
    browse: 'Browse',
    gating: 'Filters',
    librarian: 'Librarian',
    tools: 'Tools',
};

/** Tools tab: data-action → slash command mapping */
export const TOOL_ACTIONS = {
    'health': '/dle-health',
    'inspect': '/dle-inspect',
    'status': '/dle-status',
    'simulate': '/dle-simulate',
    'ai-review': '/dle-review',
    'notebook': '/dle-notebook',
    'ai-notebook': '/dle-ai-notepad',
    'summarize': '/dle-summarize',
    'import-wi': '/dle-import',
    'optimize-keys': '/dle-optimize-keys',
    'graph': '/dle-graph',
    'scribe-history': '/dle-scribe-history',
    'setup': '/dle-setup',
    'pins-blocks': '/dle-pins',
    'help': '/dle-help',
    'refresh': '/dle-refresh',
};

/** Expand buttons: data-expand → slash command mapping */
export const EXPAND_ACTIONS = {
    'injection': '/dle-why',
    'browse': '/dle-browse',
    'gating': '/dle-context-state',
};

/** AI search mode display labels */
export const MODE_LABELS = {
    'two-stage': 'Two-Stage',
    'ai-only': 'AI Only',
    'keywords-only': 'Keywords',
};

/** AI search mode descriptions for tooltips */
export const MODE_DESCRIPTIONS = {
    'two-stage': 'keywords narrow the field, then AI picks the best matches',
    'ai-only': 'AI evaluates the full vault directly (slower, more thorough)',
    'keywords-only': 'matching by keywords only (AI disabled)',
};

/** Status dot descriptions for tooltips */
export const STATUS_DESCRIPTIONS = {
    'ok': 'all vaults connected and responding',
    'degraded': 'some vaults unreachable or slow',
    'limited': 'running with limited functionality',
    'offline': 'unable to reach Obsidian',
};

/** Status dot CSS classes */
export const STATUS_CLASSES = {
    'ok': 'dle-status-ok',
    'degraded': 'dle-status-degraded',
    'limited': 'dle-status-limited',
    'offline': 'dle-status-offline',
};

/** Virtual scroll constants — must match CSS .dle-browse-entry height */
export const BROWSE_ROW_HEIGHT = 32;
export const BROWSE_OVERSCAN = 8;

/** Chat width threshold for overlay mode */
export const OVERLAY_CHAT_WIDTH_THRESHOLD = 60;

// ─── Mutable State (shared object — avoids circular imports) ───

/**
 * All mutable drawer state lives here. Render and event modules mutate this directly.
 * Using a single object avoids the need for setter functions and circular export/import issues.
 */
export const ds = {
    /** jQuery reference to the drawer root element (set once in createDrawerPanel) */
    $drawer: null,

    /** True between GENERATION_STARTED and GENERATION_ENDED */
    stGenerating: false,

    // Browse tab filters
    browseSearchTimeout: null,
    browseQuery: '',
    browseStatusFilter: 'all',
    browseTagFilter: '',
    browseFolderFilter: '',
    browseSort: 'priority_asc',
    /** @type {Object<string, string>} Active custom field filters: { fieldName: selectedValue } */
    browseCustomFieldFilters: {},

    // Pre-computed tag cache (rebuilt on index update)
    cachedTagSet: null,
    cachedTagOptions: '',
    cachedFolderSet: null,
    cachedFolderOptions: '',

    // Virtual scroll state
    browseFilteredEntries: [],
    browseLastRangeStart: -1,
    browseLastRangeEnd: -1,
    browseScrollRAF: null,
    browseExpandedEntry: null,
    /** Index of expanded entry in browseFilteredEntries (for virtual scroll offset) */
    browseExpandedIdx: null,
    /** Extra height beyond BROWSE_ROW_HEIGHT for the expanded entry */
    browseExpandedExtraHeight: 0,
    /** Set by navigateToBrowseEntry() — renderBrowseTab() consumes and clears it */
    browseNavigateTarget: null,

    // Context window token tracking
    contextTokens: 0,
    promptManagerRef: null,

    /** Why? tab filter: 'both' | 'injected' | 'filtered' */
    whyTabFilter: 'injected',

    // Librarian tab state
    /** Librarian filter: 'flag' | 'activity' */
    librarianFilter: 'flag',
    /** Activity sub-filter: 'all' | 'search' | 'search-noresults' | 'search-results' */
    librarianActivityFilter: 'all',
    /** Librarian sort: 'newest' | 'frequency' | 'urgency' */
    librarianSort: 'newest',
    /** Selected gap IDs for bulk operations */
    librarianSelected: new Set(),
    /** Last clicked gap ID for shift+click range selection */
    librarianLastClicked: null,
};

// ─── Activity Feed ───

/** Activity feed: last N pipeline trace summaries */
export const activityLog = [];
const MAX_ACTIVITY = 5;

/**
 * Push a pipeline activity entry to the feed (most recent first, capped).
 * @param {{ ts: number, injected: number, mode: string, tokens: number }} entry
 */
export function pushActivity(entry) {
    activityLog.unshift(entry);
    if (activityLog.length > MAX_ACTIVITY) activityLog.pop();
}

// ─── Entry Temperature Computation ───

/** Cached temperature map — recomputed on pipeline complete */
let _tempCache = null;

/**
 * Compute injection frequency "temperature" for each entry.
 * Hot entries (above average injection rate) get warm accent tints;
 * cold entries (below average) get cool blue tints; neutral entries are untinted.
 *
 * Constants and contextually-gated entries are excluded from both the average
 * calculation and temperature display.
 *
 * @returns {Map<string, {ratio: number, consecutive: number, tempScore: number, hue: string}>}
 */
export function computeEntryTemperatures() {
    if (_tempCache) return _tempCache;

    const temps = new Map();
    if (!vaultIndex.length || !chatInjectionCounts.size) return temps;

    // Filter out constants and entries with any contextual gating custom fields from the calculation
    const eligible = vaultIndex.filter(e => {
        if (e.constant) return false;
        const cf = e.customFields || {};
        return !Object.values(cf).some(v => v != null && v !== '' && (!Array.isArray(v) || v.length > 0));
    });
    if (!eligible.length) return temps;

    // Compute average injection count across eligible entries
    let totalCount = 0;
    for (const entry of eligible) {
        const key = trackerKey(entry);
        totalCount += chatInjectionCounts.get(key) || 0;
    }
    const avg = totalCount / eligible.length;
    if (avg === 0) return temps;

    for (const entry of eligible) {
        const key = trackerKey(entry);
        const count = chatInjectionCounts.get(key) || 0;
        const ratio = count / avg;
        const consec = consecutiveInjections.get(key) || 0;
        const tempScore = Math.min(3, Math.max(0, ratio + consec * 0.15));
        const hue = tempScore > 1.2 ? 'hot' : tempScore < 0.8 ? 'cold' : 'neutral';
        temps.set(key, { ratio, consecutive: consec, tempScore, hue });
    }

    _tempCache = temps;
    return temps;
}

/** Invalidate the temperature cache (call on pipeline complete) */
export function invalidateTemperatureCache() {
    _tempCache = null;
}

// ─── Render Scheduling ───

let renderPending = false;
let pendingRenders = new Set();

/**
 * Schedule a render function to run on the next animation frame.
 * Deduplicates multiple calls to the same function within a frame.
 * @param {Function} renderFn  Render function to schedule
 */
export function scheduleRender(renderFn) {
    pendingRenders.add(renderFn);
    if (!renderPending) {
        renderPending = true;
        requestAnimationFrame(() => {
            renderPending = false;
            const fns = [...pendingRenders];
            pendingRenders.clear();
            for (const fn of fns) {
                try { fn(); } catch (err) { console.warn('[DLE] Drawer render error:', err.message); }
            }
        });
    }
}

// ─── Shared Utility Functions ───

/**
 * Convert matchedBy reason to a short badge label (e.g. 'KEY', 'AI', 'CONST').
 * @param {string|null} matchedBy  Raw match reason string from pipeline
 * @returns {string} Short label for display
 */
export function getMatchLabel(matchedBy) {
    if (!matchedBy) return '?';
    const { type } = parseMatchReason(matchedBy);
    const labels = {
        constant: 'CONST', pinned: 'PIN', bootstrap: 'INIT',
        seed: 'SEED', keyword: 'KEY', keyword_ai: 'KEY+AI', ai: 'AI',
    };
    return labels[type] || (matchedBy.length > 8 ? 'AI' : escapeHtml(matchedBy));
}

/**
 * Announce a message to screen readers via the aria-live region.
 * @param {string} message  Text to announce
 */
export function announceToScreenReader(message) {
    const $live = $('#dle-drawer-live');
    if ($live.length) {
        $live.text('');
        requestAnimationFrame(() => $live.text(message));
    }
}

/**
 * Format a token count compactly: 1234 → "1.2k", 12345 → "12.3k", 123 → "123".
 * @param {number} n  Token count
 * @returns {string} Compact display string
 */
export function formatTokensCompact(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

// ─── Lazy-loaded ST internals ───

export let dragElement, isMobile, power_user;

export async function loadSTInternals() {
    try {
        const ross = await import('../../../../../../scripts/RossAscends-mods.js');
        dragElement = ross.dragElement;
        isMobile = ross.isMobile;
        const pu = await import('../../../../../../scripts/power-user.js');
        power_user = pu.power_user;
    } catch (err) {
        console.warn('[DLE] Could not load ST internals for drawer (Moving UI/mobile detection unavailable):', err.message);
    }
}
