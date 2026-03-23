/**
 * DeepLore Enhanced — Drawer Shared State & Constants
 * Shared between drawer.js, drawer-render.js, and drawer-events.js.
 */
import { escapeHtml } from '../../../../utils.js';
import { parseMatchReason } from './helpers.js';

// ─── Constants ───

export const DRAWER_ID = 'deeplore-drawer';
export const MODULE_NAME = 'deeplore-enhanced';

/** Tab name → display label map */
export const TAB_LABELS = {
    injection: 'Why?',
    browse: 'Browse',
    gating: 'Gating',
    tools: 'Tools',
};

/** Tools tab: data-action → slash command mapping */
export const TOOL_ACTIONS = {
    'health': '/dle-health',
    'inspect': '/dle-inspect',
    'status': '/dle-status',
    'simulate': '/dle-simulate',
    'ai-review': '/dle-review',
    'analytics': '/dle-analytics',
    'notebook': '/dle-notebook',
    'summarize': '/dle-summarize',
    'import-wi': '/dle-import',
    'optimize-keys': '/dle-optimize-keys',
    'graph': '/dle-graph',
    'scribe-history': '/dle-scribe-history',
    'setup': '/dle-setup',
    'pins-blocks': '/dle-pins',
    'help': '/dle-help',
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
    browseSort: 'priority_asc',

    // Pre-computed tag cache (rebuilt on index update)
    cachedTagSet: null,
    cachedTagOptions: '',

    // Virtual scroll state
    browseFilteredEntries: [],
    browseLastRangeStart: -1,
    browseLastRangeEnd: -1,
    browseScrollRAF: null,
    browseExpandedEntry: null,

    // Context window token tracking
    contextTokens: 0,
    promptManagerRef: null,
};

// ─── Render Scheduling ───

let renderPending = false;
let pendingRenders = new Set();

/**
 * Schedule a render function to run on the next animation frame.
 * Deduplicates multiple calls to the same function within a frame.
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

/** Convert matchedBy reason to a short badge label */
export function getMatchLabel(matchedBy) {
    if (!matchedBy) return '?';
    const { type } = parseMatchReason(matchedBy);
    const labels = {
        constant: 'CONST', pinned: 'PIN', bootstrap: 'BOOT',
        seed: 'SEED', keyword: 'KEY', keyword_ai: 'KEY+AI', ai: 'AI',
    };
    return labels[type] || (matchedBy.length > 8 ? 'AI' : escapeHtml(matchedBy));
}

/** Announce a message to screen readers via the aria-live region */
export function announceToScreenReader(message) {
    const $live = $('#dle-drawer-live');
    if ($live.length) {
        $live.text('');
        requestAnimationFrame(() => $live.text(message));
    }
}

/** Format a token count compactly: 1234 → "1.2k", 12345 → "12.3k", 123 → "123" */
export function formatTokensCompact(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

// ─── Lazy-loaded ST internals ───

export let dragElement, isMobile, power_user;

export async function loadSTInternals() {
    try {
        const ross = await import('../../../../../scripts/RossAscends-mods.js');
        dragElement = ross.dragElement;
        isMobile = ross.isMobile;
        const pu = await import('../../../../../scripts/power-user.js');
        power_user = pu.power_user;
    } catch (err) {
        console.warn('[DLE] Could not load ST internals for drawer (Moving UI/mobile detection unavailable):', err.message);
    }
}
