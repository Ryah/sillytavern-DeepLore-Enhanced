/**
 * DeepLore Enhanced — Drawer Panel
 * Native ST drawer in the top bar for live pipeline status and operations.
 */
import { doNavbarIconClick, saveSettingsDebounced, chat_metadata, saveChatDebounced, amount_gen } from '../../../../../script.js';
import { renderExtensionTemplateAsync, extension_settings } from '../../../../extensions.js';
import { escapeHtml } from '../../../../utils.js';
import { getSettings } from '../settings.js';
import {
    vaultIndex, lastInjectionSources, previousSources, lastPipelineTrace,
    generationLock, computeOverallStatus,
    aiSearchStats, isAiCircuitOpen, indexEverLoaded, indexTimestamp, lastHealthResult,
    cooldownTracker, decayTracker,
    onIndexUpdated, onAiStatsUpdated, onCircuitStateChanged,
    onPipelineComplete, onGatingChanged, onPinBlockChanged, onGenerationLockChanged,
    notifyGatingChanged, notifyPinBlockChanged,
} from './state.js';
import { buildIndex } from './vault.js';
import { buildObsidianURI } from './helpers.js';
import { getCircuitState } from './obsidian-api.js';
import { openSettingsPopup } from './settings-ui.js';

// Lazy-loaded ST internals (imported dynamically to avoid breaking the module graph)
let dragElement, isMobile, power_user;
async function loadSTInternals() {
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

const DRAWER_ID = 'deeplore-drawer';
const MODULE_NAME = 'deeplore-enhanced';

/** Tab name → display label map */
const TAB_LABELS = {
    injection: 'Why?',
    browse: 'Browse',
    gating: 'Gating',
    tools: 'Tools',
};

/** Tools tab: data-action → slash command mapping */
const TOOL_ACTIONS = {
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
const EXPAND_ACTIONS = {
    'injection': '/dle-why',
    'browse': '/dle-browse',
    'gating': '/dle-context-state',
};

/** AI search mode display labels */
const MODE_LABELS = {
    'two-stage': 'Two-Stage',
    'ai-only': 'AI Only',
    'keywords-only': 'Keywords',
};

/** Status dot CSS classes */
const STATUS_CLASSES = {
    'ok': 'dle-status-ok',
    'degraded': 'dle-status-degraded',
    'limited': 'dle-status-limited',
    'offline': 'dle-status-offline',
};

/** Convert matchedBy reason to a short badge label */
function getMatchLabel(matchedBy) {
    if (!matchedBy) return '?';
    const lower = matchedBy.toLowerCase();
    if (lower.startsWith('ai:') || lower === 'ai selection') return 'AI';
    if (lower.includes('keyword') && lower.includes('ai')) return 'KEY+AI';
    if (lower.includes('keyword')) return 'KEY';
    if (lower.includes('constant')) return 'CONST';
    if (lower.includes('pinned')) return 'PIN';
    if (lower.includes('bootstrap')) return 'BOOT';
    if (lower.includes('seed')) return 'SEED';
    return matchedBy.length > 8 ? 'AI' : escapeHtml(matchedBy);
}

/** Announce a message to screen readers via the aria-live region */
function announceToScreenReader(message) {
    const $live = $('#dle-drawer-live');
    if ($live.length) {
        $live.text('');
        // Brief delay ensures the screen reader registers the change
        requestAnimationFrame(() => $live.text(message));
    }
}

// ─── Drawer reference (set once in createDrawerPanel, used by all render functions) ───
let $drawerRef = null;

// ─── Generation lifecycle state ───
let stGenerating = false; // True between GENERATION_STARTED and GENERATION_ENDED

// ─── Browse tab state ───
let browseSearchTimeout = null;
let browseQuery = '';
let browseStatusFilter = 'all';
let browseTagFilter = '';
let browseSort = 'priority_asc';

// Context window token tracking (updated via CHAT_COMPLETION_PROMPT_READY event)
let contextTokens = 0;
let promptManagerRef = null;

/** Reset ephemeral drawer state on chat change */
export function resetDrawerState() {
    browseQuery = '';
    browseStatusFilter = 'all';
    browseTagFilter = '';
    browseSort = 'priority_asc';
    contextTokens = 0;
    stGenerating = false;
    if (browseSearchTimeout) { clearTimeout(browseSearchTimeout); browseSearchTimeout = null; }
    // Clear the search input and filter selects if drawer exists
    const $input = $(`#${DRAWER_ID} .dle-browse-input`);
    if ($input.length) $input.val('');
    const $status = $(`#${DRAWER_ID} [data-filter="status"]`);
    if ($status.length) $status.val('all');
    const $tag = $(`#${DRAWER_ID} [data-filter="tag"]`);
    if ($tag.length) $tag.val('');
    const $sort = $(`#${DRAWER_ID} [data-sort]`);
    if ($sort.length) $sort.val('priority_asc');
}

// ─── Render scheduling ───
let renderPending = false;
let pendingRenders = new Set();

function scheduleRender(renderFn) {
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

// ════════════════════════════════════════════════════════════════════════════
// Render Functions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Update the fixed status zone with live data.
 */
function renderStatusZone() {
    const $drawer = $drawerRef;
    const settings = getSettings();

    // Status dot (pass Obsidian circuit state for real-time accuracy between index builds)
    const status = computeOverallStatus(getCircuitState());
    const $dot = $drawer.find('.dle-status-dot');
    $dot.removeClass('dle-status-ok dle-status-degraded dle-status-limited dle-status-offline');
    $dot.addClass(STATUS_CLASSES[status] || 'dle-status-offline');
    $dot.attr('title', `Status: ${status}`);
    $dot.attr('aria-label', `System status: ${status}`);

    // Pipeline label + activity animation (3-state: Choosing Lore → Writing → Idle)
    const pipelineText = generationLock ? 'Choosing Lore...' : stGenerating ? 'Writing...' : 'Idle';
    $drawer.find('.dle-pipeline-label').text(pipelineText).attr('aria-label', `Pipeline stage: ${pipelineText}`);
    $dot.toggleClass('dle-status-active', !!generationLock || stGenerating);

    // Stats
    const entryCount = vaultIndex.length;
    const injectedCount = generationLock ? '…' : (lastInjectionSources ? lastInjectionSources.length : 0);
    const $entries = $drawer.find('[data-stat="entries"]');
    $entries.text(entryCount);
    $entries.closest('.dle-stat').attr('aria-label', `${entryCount} vault entries indexed`);
    const $injected = $drawer.find('[data-stat="injected"]');
    $injected.text(injectedCount);
    $injected.closest('.dle-stat').attr('aria-label', `${injectedCount} entries injected`);

    const mode = settings.aiSearchEnabled !== false
        ? (MODE_LABELS[settings.aiSearchMode] || settings.aiSearchMode || '—')
        : 'Keywords';
    $drawer.find('[data-stat="mode"]').text(mode).attr('aria-label', `Search mode: ${mode}`);

    // Token bar
    const trace = lastPipelineTrace;
    const budget = settings.unlimitedBudget ? 0 : (settings.maxTokensBudget || 0);
    const used = trace?.totalTokens || 0;
    const max = budget || used || 1; // avoid division by zero
    const pct = budget ? Math.min(100, Math.round((used / max) * 100)) : 0;
    const $barContainer = $drawer.find('.dle-token-bar-container');
    $barContainer.attr('aria-valuenow', used).attr('aria-valuemax', budget);
    $drawer.find('.dle-token-bar').css('width', `${pct}%`);
    const budgetLabel = budget
        ? `DLE ${used.toLocaleString()} / ${budget.toLocaleString()}`
        : settings.unlimitedBudget
            ? `DLE ${used.toLocaleString()} / \u221E`
            : 'DLE — / —';
    $drawer.find('.dle-token-bar-label').text(budgetLabel);

    // Entries bar
    const injectedNum = lastInjectionSources ? lastInjectionSources.length : 0;
    const maxEntries = settings.unlimitedEntries ? 0 : (settings.maxEntries || 0);
    const entriesPct = maxEntries ? Math.min(100, Math.round((injectedNum / maxEntries) * 100)) : 0;
    const $entriesBarContainer = $drawer.find('.dle-entries-bar-container');
    $entriesBarContainer.attr('aria-valuenow', injectedNum).attr('aria-valuemax', maxEntries);
    $drawer.find('.dle-entries-bar').css('width', `${entriesPct}%`);
    const entriesLabel = maxEntries
        ? `Entries ${injectedNum} / ${maxEntries}`
        : settings.unlimitedEntries
            ? `Entries ${injectedNum} / \u221E`
            : 'Entries — / —';
    $drawer.find('.dle-entries-bar-label').text(entriesLabel);

    // Active gating filters
    const ctx = chat_metadata?.deeplore_context;
    const $filters = $drawer.find('.dle-active-filters');
    if (ctx && (ctx.era || ctx.location || ctx.scene_type || (ctx.characters_present && ctx.characters_present.length))) {
        const chips = [];
        if (ctx.era) chips.push(escapeHtml(ctx.era));
        if (ctx.location) chips.push(escapeHtml(ctx.location));
        if (ctx.scene_type) chips.push(escapeHtml(ctx.scene_type));
        if (ctx.characters_present) {
            for (const c of ctx.characters_present) chips.push(escapeHtml(c));
        }
        $filters.html(chips.map(c => `<span class="dle-chip dle-chip-sm">${c}</span>`).join(''));
        $filters.show();
    } else {
        $filters.empty().hide();
    }
}

/**
 * Render the "Why?" tab — shows why entries were injected AND why others were filtered out.
 */
function renderInjectionTab() {
    const $drawer = $drawerRef;
    const sources = lastInjectionSources;
    const prev = previousSources;
    const trace = lastPipelineTrace;
    const $list = $drawer.find('.dle-why-list');
    const $empty = $drawer.find('#dle-panel-injection .dle-empty-state');
    const $diff = $drawer.find('.dle-section-diff');
    const $whyNotSection = $drawer.find('.dle-why-not-section');
    const $whyNotList = $drawer.find('.dle-why-not-list');

    if (!sources || sources.length === 0) {
        $list.empty();
        $whyNotSection.hide();
        $empty.show();
        $diff.empty();
        return;
    }

    $empty.hide();

    // Compute diff
    const prevTitles = prev ? new Set(prev.map(s => s.title)) : null;
    const currTitles = new Set(sources.map(s => s.title));
    const added = prevTitles ? sources.filter(s => !prevTitles.has(s.title)) : [];
    const removed = prev ? prev.filter(s => !currTitles.has(s.title)) : [];

    // Diff header
    const diffParts = [];
    if (added.length) diffParts.push(`<span class="dle-diff-add" aria-label="${added.length} new entries added">+${added.length} new</span>`);
    if (removed.length) diffParts.push(`<span class="dle-diff-remove" aria-label="${removed.length} entries removed">-${removed.length} removed</span>`);
    $diff.html(diffParts.join(' '));

    // Build entries
    const settings = getSettings();
    const addedTitles = new Set(added.map(s => s.title));
    let html = '';

    for (const src of sources) {
        const isNew = addedTitles.has(src.title);
        const isConstant = src.constant || (src.matchedBy && src.matchedBy.includes('Constant'));
        const classes = ['dle-why-entry'];
        if (isNew) classes.push('dle-why-new');
        if (isConstant) classes.push('dle-why-constant');

        // Obsidian link
        const srcVault = src.vaultSource && settings.vaults
            ? settings.vaults.find(v => v.name === src.vaultSource)
            : null;
        const vaultName = srcVault ? srcVault.name : (settings.vaults?.[0]?.name || '');
        const uri = src.filename ? buildObsidianURI(vaultName, src.filename) : null;

        const matchLabel = getMatchLabel(src.matchedBy);

        const entryAriaLabel = `${escapeHtml(src.title)}, ${src.tokens || '?'} tokens, matched by ${matchLabel}${isNew ? ', newly added' : ''}`;
        html += `<div class="${classes.join(' ')}" role="listitem" aria-label="${entryAriaLabel}">`;
        html += `<span class="dle-why-title">`;
        if (uri) {
            html += `<a href="${escapeHtml(uri)}" target="_blank" class="dle-obsidian-link" aria-label="Open ${escapeHtml(src.title)} in Obsidian">${escapeHtml(src.title)}</a>`;
        } else {
            html += escapeHtml(src.title);
        }
        html += `</span>`;
        html += `<span class="dle-why-meta">`;
        html += `<span class="dle-why-tokens" aria-label="${src.tokens || '?'} tokens">${src.tokens || '?'} tok</span>`;
        html += `<span class="dle-why-match" title="Matched via ${escapeHtml(src.matchedBy || '?')}" aria-label="Match type: ${matchLabel}">${matchLabel}</span>`;
        if (isNew) html += `<span class="dle-why-new-badge" aria-label="Newly added entry">NEW</span>`;
        html += `</span>`;
        html += `</div>`;
    }

    $list.html(html);

    // ── "Why Not" section — entries that were candidates but got filtered out ──
    if (trace) {
        const rejections = [];

        if (trace.contextualGatingRemoved) {
            for (const title of trace.contextualGatingRemoved) {
                rejections.push({ title, reason: 'Gating mismatch' });
            }
        }
        if (trace.cooldownRemoved) {
            for (const title of trace.cooldownRemoved) {
                rejections.push({ title, reason: 'Cooldown active' });
            }
        }
        if (trace.gatedOut) {
            for (const entry of trace.gatedOut) {
                const parts = [];
                if (entry.requires?.length) parts.push(`needs: ${entry.requires.join(', ')}`);
                if (entry.excludes?.length) parts.push(`blocked by: ${entry.excludes.join(', ')}`);
                rejections.push({ title: entry.title, reason: parts.join('; ') || 'requires/excludes' });
            }
        }
        if (trace.stripDedupRemoved) {
            for (const title of trace.stripDedupRemoved) {
                rejections.push({ title, reason: 'Already in context' });
            }
        }
        if (trace.budgetCut) {
            for (const entry of trace.budgetCut) {
                rejections.push({ title: entry.title, reason: `Over budget (${entry.tokens} tok)` });
            }
        }

        if (rejections.length > 0) {
            let whyNotHtml = '';
            for (const r of rejections) {
                whyNotHtml += `<div class="dle-why-entry dle-why-not-entry" role="listitem" aria-label="${escapeHtml(r.title)}, filtered: ${escapeHtml(r.reason)}">`;
                whyNotHtml += `<span class="dle-why-title dle-muted">${escapeHtml(r.title)}</span>`;
                whyNotHtml += `<span class="dle-why-meta"><span class="dle-why-match dle-why-not-reason" title="${escapeHtml(r.reason)}">${escapeHtml(r.reason)}</span></span>`;
                whyNotHtml += `</div>`;
            }
            $whyNotList.html(whyNotHtml);
            $whyNotSection.show();
        } else {
            $whyNotSection.hide();
        }
    } else {
        $whyNotSection.hide();
    }
}

/**
 * Render the browse tab with live vault entries.
 */
function renderBrowseTab() {
    const $drawer = $drawerRef;
    const $list = $drawer.find('.dle-browse-list');
    const $emptyNoData = $drawer.find('#dle-browse-empty-no-data');
    const $emptyNoResults = $drawer.find('#dle-browse-empty-no-results');

    if (!vaultIndex || vaultIndex.length === 0) {
        $list.empty();
        $emptyNoData.show();
        $emptyNoResults.hide();
        return;
    }

    $emptyNoData.hide();

    // Build tag filter options dynamically
    const $tagSelect = $drawer.find('[data-filter="tag"]');
    const currentTagVal = $tagSelect.val() || '';
    const tagSet = new Set();
    for (const e of vaultIndex) {
        if (e.tags) for (const t of e.tags) tagSet.add(t);
    }
    const tagOpts = ['<option value="">Tags</option>'];
    for (const t of [...tagSet].sort()) {
        tagOpts.push(`<option value="${escapeHtml(t)}"${t === currentTagVal ? ' selected' : ''}>${escapeHtml(t)}</option>`);
    }
    $tagSelect.html(tagOpts.join(''));

    // Reset stale tag filter if the tag no longer exists in the vault
    if (browseTagFilter && !tagSet.has(browseTagFilter)) {
        browseTagFilter = '';
    }

    // Get filters
    const query = browseQuery.toLowerCase();
    const statusFilter = browseStatusFilter;
    const tagFilter = browseTagFilter;
    const sortKey = browseSort;

    // Pin/block state
    const pins = chat_metadata?.deeplore_pins || [];
    const blocks = chat_metadata?.deeplore_blocks || [];
    const pinSet = new Set(pins.map(t => t.toLowerCase()));
    const blockSet = new Set(blocks.map(t => t.toLowerCase()));

    // Injected set
    const injectedSet = new Set();
    if (lastInjectionSources) {
        for (const s of lastInjectionSources) injectedSet.add(s.title.toLowerCase());
    }

    // Filter
    let entries = vaultIndex.filter(e => {
        // Search
        if (query) {
            const titleMatch = e.title.toLowerCase().includes(query);
            const keyMatch = e.keys && e.keys.some(k => k.toLowerCase().includes(query));
            if (!titleMatch && !keyMatch) return false;
        }

        // Status filter
        const tl = e.title.toLowerCase();
        if (statusFilter === 'injected' && !injectedSet.has(tl)) return false;
        if (statusFilter === 'pinned' && !pinSet.has(tl)) return false;
        if (statusFilter === 'blocked' && !blockSet.has(tl)) return false;
        if (statusFilter === 'constant' && !e.constant) return false;
        if (statusFilter === 'seed' && !e.seed) return false;
        if (statusFilter === 'bootstrap' && !e.bootstrap) return false;

        // Tag filter
        if (tagFilter && (!e.tags || !e.tags.includes(tagFilter))) return false;

        return true;
    });

    // Sort
    entries = [...entries];
    switch (sortKey) {
        case 'priority_asc': entries.sort((a, b) => (a.priority || 50) - (b.priority || 50)); break;
        case 'priority_desc': entries.sort((a, b) => (b.priority || 50) - (a.priority || 50)); break;
        case 'alpha_asc': entries.sort((a, b) => a.title.localeCompare(b.title)); break;
        case 'alpha_desc': entries.sort((a, b) => b.title.localeCompare(a.title)); break;
        case 'tokens_desc': entries.sort((a, b) => (b.tokenEstimate || 0) - (a.tokenEstimate || 0)); break;
        case 'tokens_asc': entries.sort((a, b) => (a.tokenEstimate || 0) - (b.tokenEstimate || 0)); break;
        default: entries.sort((a, b) => (a.priority || 50) - (b.priority || 50));
    }

    // Render
    let html = '';
    for (const e of entries) {
        const tl = e.title.toLowerCase();
        const isPinned = pinSet.has(tl);
        const isBlocked = blockSet.has(tl);
        const isInjected = injectedSet.has(tl);

        const classes = ['dle-browse-entry'];
        if (isInjected) classes.push('dle-browse-injected');

        const keysStr = e.constant ? '(constant)' : (e.keys ? e.keys.slice(0, 4).join(', ') : '');
        const prioLabel = e.constant ? 'CONST' : `P${e.priority || 50}`;
        const prioClass = e.constant ? ' dle-browse-constant' : '';

        const statusParts = [];
        if (isInjected) statusParts.push('currently injected');
        if (isPinned) statusParts.push('pinned');
        if (isBlocked) statusParts.push('blocked');
        if (e.constant) statusParts.push('constant');
        const browseAriaLabel = `${escapeHtml(e.title)}, ${prioLabel}${statusParts.length ? ', ' + statusParts.join(', ') : ''}`;

        html += `<div class="${classes.join(' ')}" data-title="${escapeHtml(e.title)}" role="listitem" aria-label="${browseAriaLabel}">`;
        html += `<div class="dle-browse-info">`;
        html += `<span class="dle-browse-title">${escapeHtml(e.title)}</span>`;
        html += `<span class="dle-browse-keys" aria-label="Keywords: ${escapeHtml(keysStr || 'none')}">${escapeHtml(keysStr)}</span>`;
        html += `</div>`;
        html += `<div class="dle-browse-controls">`;
        html += `<span class="dle-browse-priority${prioClass}" title="${e.constant ? 'Constant — always injected' : `Priority ${e.priority || 50}`}" aria-label="${e.constant ? 'Constant entry, always injected' : `Priority ${e.priority || 50}`}">${prioLabel}</span>`;
        html += `<button class="dle-browse-pin${isPinned ? ' dle-pin-active' : ''}" data-entry="${escapeHtml(e.title)}" aria-label="${isPinned ? 'Unpin' : 'Pin'} ${escapeHtml(e.title)}" title="${isPinned ? 'Pinned — always inject' : 'Click to pin'}"><i class="fa-solid fa-thumbtack" aria-hidden="true"></i></button>`;
        html += `<button class="dle-browse-block${isBlocked ? ' dle-block-active' : ''}" data-entry="${escapeHtml(e.title)}" aria-label="${isBlocked ? 'Unblock' : 'Block'} ${escapeHtml(e.title)}" title="${isBlocked ? 'Blocked — never inject' : 'Click to block'}"><i class="fa-solid fa-ban" aria-hidden="true"></i></button>`;
        html += `</div>`;
        html += `</div>`;
    }

    const scrollPos = $list[0]?.scrollTop || 0;
    $list.html(html);
    if (scrollPos) $list[0].scrollTop = scrollPos;
    $emptyNoResults.toggle(entries.length === 0);
}

/**
 * Render the gating tab with live context state.
 */
function renderGatingTab() {
    const $drawer = $drawerRef;
    const ctx = chat_metadata?.deeplore_context;

    const fields = [
        { field: 'era', ctxKey: 'era', single: true },
        { field: 'location', ctxKey: 'location', single: true },
        { field: 'sceneType', ctxKey: 'scene_type', single: true },
        { field: 'characterPresent', ctxKey: 'characters_present', single: false },
    ];

    for (const { field, ctxKey, single } of fields) {
        const $group = $drawer.find(`.dle-gating-group[data-field="${field}"]`);
        const $value = $group.find('.dle-gating-value');
        const value = ctx ? ctx[ctxKey] : null;
        const $setBtn = $value.find('.dle-gating-set');

        // Remove everything except the set button
        $value.find('.dle-chip, .dle-gating-empty').remove();

        if (single) {
            if (value) {
                $setBtn.before(`<span class="dle-chip">${escapeHtml(value)} <button class="dle-chip-x" data-field="${field}" data-value="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(value)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`);
            } else {
                $setBtn.before('<span class="dle-gating-empty">Not set</span>');
            }
        } else {
            // Array field (characters)
            if (value && value.length > 0) {
                for (const c of value) {
                    $setBtn.before(`<span class="dle-chip">${escapeHtml(c)} <button class="dle-chip-x" data-field="${field}" data-value="${escapeHtml(c)}" aria-label="Remove ${escapeHtml(c)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`);
                }
            } else {
                $setBtn.before('<span class="dle-gating-empty">None set</span>');
            }
        }
    }
}

/** Render active entry timers (cooldown, decay, warmup) below gating */
function renderTimers() {
    const $drawer = $drawerRef;
    const $list = $drawer.find('.dle-timer-list');
    const $empty = $drawer.find('.dle-timer-empty');
    const rows = [];
    const settings = getSettings();

    // Cooldown entries
    for (const [key, remaining] of cooldownTracker) {
        const name = key.includes(':') ? key.split(':').slice(1).join(':') : key;
        rows.push(`<div class="dle-timer-row" role="listitem">
            <span class="dle-timer-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="dle-timer-badge dle-timer-cooldown">${remaining} gen cooldown</span>
        </div>`);
    }

    // Decay entries (stale = above boost threshold, frequent = consecutive via consecutiveInjections)
    if (settings.decayEnabled) {
        const boostThreshold = settings.decayBoostThreshold || 5;
        for (const [key, staleness] of decayTracker) {
            if (staleness >= boostThreshold) {
                const name = key.includes(':') ? key.split(':').slice(1).join(':') : key;
                rows.push(`<div class="dle-timer-row" role="listitem">
                    <span class="dle-timer-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                    <span class="dle-timer-badge dle-timer-stale">stale ${staleness} gen</span>
                </div>`);
            }
        }
    }

    // Note: Warmup is static configuration (entry.warmup threshold), not an active timer.
    // Removed from timers section — would show ALL entries with warmup > 1 regardless of state.

    $list.html(rows.join(''));
    $empty.toggle(rows.length === 0);
}

// ════════════════════════════════════════════════════════════════════════════
// Event Wiring
// ════════════════════════════════════════════════════════════════════════════

/** Execute a slash command via ST's context API */
function executeCommand(cmd) {
    const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
    if (ctx?.executeSlashCommands) {
        ctx.executeSlashCommands(cmd).catch(err => console.error('[DLE] Command error:', cmd, err));
    } else {
        console.warn('[DLE] Cannot execute command — SillyTavern.getContext() unavailable');
    }
}

/** Wire tools tab buttons to slash commands (one-time) */
function wireToolsTab($drawer) {
    $drawer.find('#dle-panel-tools').on('click', '.dle-tool-btn[data-action]', function () {
        const action = $(this).data('action');
        const cmd = TOOL_ACTIONS[action];
        if (cmd) executeCommand(cmd);
    });
}

/** Wire tab expand buttons */
function wireTabExpand($drawer) {
    $drawer.on('click', '.dle-tab-expand[data-expand]', function () {
        const target = $(this).data('expand');
        const cmd = EXPAND_ACTIONS[target];
        if (cmd) executeCommand(cmd);
    });
}

/** Wire status zone quick action buttons */
function wireStatusActions($drawer) {
    $drawer.on('click', '.dle-action-btn[data-action]', function () {
        const action = $(this).data('action');
        switch (action) {
            case 'refresh': buildIndex(); break;
            case 'settings': openSettingsPopup(); break;
            case 'scribe': executeCommand('/dle-scribe'); break;
            case 'newlore': executeCommand('/dle-newlore'); break;
        }
    });
}

/** Wire browse tab interactions (search, filters, pin/block) */
function wireBrowseTab($drawer) {
    // Search input with debounce
    $drawer.find('.dle-browse-input').on('input', function () {
        const val = $(this).val();
        clearTimeout(browseSearchTimeout);
        browseSearchTimeout = setTimeout(() => {
            browseQuery = val;
            scheduleRender(renderBrowseTab);
        }, 300);
    });

    // Filter selects
    $drawer.find('[data-filter="status"]').on('change', function () {
        browseStatusFilter = $(this).val();
        scheduleRender(renderBrowseTab);
    });

    $drawer.find('[data-filter="tag"]').on('change', function () {
        browseTagFilter = $(this).val();
        scheduleRender(renderBrowseTab);
    });

    $drawer.find('[data-sort]').on('change', function () {
        browseSort = $(this).val();
        scheduleRender(renderBrowseTab);
    });

    // Pin/block buttons via event delegation
    $drawer.find('.dle-browse-list').on('click', '.dle-browse-pin', function () {
        const title = $(this).data('entry');
        if (!title || !chat_metadata) return;

        if (!chat_metadata.deeplore_pins) chat_metadata.deeplore_pins = [];
        const tl = title.toLowerCase();
        const idx = chat_metadata.deeplore_pins.findIndex(t => t.toLowerCase() === tl);

        if (idx !== -1) {
            // Unpin
            chat_metadata.deeplore_pins.splice(idx, 1);
        } else {
            // Pin — also remove from blocks
            chat_metadata.deeplore_pins.push(title);
            if (chat_metadata.deeplore_blocks) {
                chat_metadata.deeplore_blocks = chat_metadata.deeplore_blocks.filter(t => t.toLowerCase() !== tl);
            }
        }
        saveChatDebounced();
        notifyPinBlockChanged();
    });

    $drawer.find('.dle-browse-list').on('click', '.dle-browse-block', function () {
        const title = $(this).data('entry');
        if (!title || !chat_metadata) return;

        if (!chat_metadata.deeplore_blocks) chat_metadata.deeplore_blocks = [];
        const tl = title.toLowerCase();
        const idx = chat_metadata.deeplore_blocks.findIndex(t => t.toLowerCase() === tl);

        if (idx !== -1) {
            // Unblock
            chat_metadata.deeplore_blocks.splice(idx, 1);
        } else {
            // Block — also remove from pins
            chat_metadata.deeplore_blocks.push(title);
            if (chat_metadata.deeplore_pins) {
                chat_metadata.deeplore_pins = chat_metadata.deeplore_pins.filter(t => t.toLowerCase() !== tl);
            }
        }
        saveChatDebounced();
        notifyPinBlockChanged();
    });
}

/** Wire gating tab interactions (chip remove, set buttons) */
function wireGatingTab($drawer) {
    // Chip X buttons via event delegation
    $drawer.find('#dle-panel-gating').on('click', '.dle-chip-x', function () {
        const field = $(this).data('field');
        const value = $(this).data('value');
        if (!field || !chat_metadata) return;

        if (!chat_metadata.deeplore_context) return;
        const ctx = chat_metadata.deeplore_context;

        if (field === 'characterPresent') {
            if (ctx.characters_present) {
                ctx.characters_present = ctx.characters_present.filter(c => c !== value);
            }
        } else if (field === 'era') {
            ctx.era = null;
        } else if (field === 'location') {
            ctx.location = null;
        } else if (field === 'sceneType') {
            ctx.scene_type = null;
        }

        saveChatDebounced();
        notifyGatingChanged();
    });

    // Set buttons via event delegation
    $drawer.find('#dle-panel-gating').on('click', '.dle-gating-set', async function () {
        const $group = $(this).closest('.dle-gating-group');
        const field = $group.data('field');
        if (!field) return;

        const fieldLabels = { era: 'Era', location: 'Location', sceneType: 'Scene Type', characterPresent: 'Character' };
        const label = fieldLabels[field] || field;

        // Use the slash command which has the full browse-popup experience
        const cmdMap = {
            era: '/dle-set-era',
            location: '/dle-set-location',
            sceneType: '/dle-set-scene',
            characterPresent: '/dle-set-characters',
        };
        const cmd = cmdMap[field];
        if (cmd) executeCommand(cmd);
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Footer Zone — Health Icons + AI Stats + Context Bar
// ════════════════════════════════════════════════════════════════════════════

/**
 * Format a token count compactly: 1234 → "1.2k", 12345 → "12.3k", 123 → "123"
 */
function formatTokensCompact(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

/**
 * Render the footer zone: context bar, health icons, AI stats.
 */
function renderFooter() {
    const $drawer = $drawerRef;
    const $footer = $drawer.find('#dle_drawer_footer');
    if (!$footer.length) return;

    // ── Context window bar ──
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    // Prefer chatCompletionSettings (respects unlocked context) over maxContext (base slider)
    const maxContext = ctx?.chatCompletionSettings?.openai_max_context || ctx?.maxContext || 0;
    const responseTokens = ctx?.chatCompletionSettings?.openai_max_tokens || amount_gen || 0;
    const contextUsed = contextTokens || 0;

    const $barContainer = $footer.find('.dle-context-bar-container');
    if (maxContext > 0) {
        const contextPct = Math.min(100, (contextUsed / maxContext) * 100);
        const responsePct = Math.min(100 - contextPct, (responseTokens / maxContext) * 100);

        $footer.find('.dle-context-bar-context').css('width', `${contextPct}%`);
        $footer.find('.dle-context-bar-response').css({
            left: `${contextPct}%`,
            width: `${responsePct}%`,
        });

        const label = contextUsed
            ? `CTX ${contextUsed.toLocaleString()} + ${responseTokens.toLocaleString()} / ${maxContext.toLocaleString()}`
            : `CTX ${responseTokens.toLocaleString()} res / ${maxContext.toLocaleString()}`;
        $footer.find('.dle-context-bar-label').text(label);

        $barContainer.attr('aria-valuenow', contextUsed + responseTokens).attr('aria-valuemax', maxContext);
    } else {
        $footer.find('.dle-context-bar-context').css('width', '0%');
        $footer.find('.dle-context-bar-response').css({ left: '0%', width: '0%' });
        $footer.find('.dle-context-bar-label').text('CTX — / —');
        $barContainer.attr('aria-valuenow', 0).attr('aria-valuemax', 0);
    }

    // ── Health icons ──
    const settings = getSettings();

    // Vault health
    const $vault = $footer.find('[data-health="vault"]');
    if (lastHealthResult) {
        const { errors, warnings } = lastHealthResult;
        if (errors > 0) {
            $vault.removeClass('dle-health-ok dle-health-warn').addClass('dle-health-error');
            $vault.attr('aria-label', `Vault health: ${errors} errors, ${warnings} warnings`);
        } else if (warnings > 3) {
            $vault.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
            $vault.attr('aria-label', `Vault health: ${warnings} warnings`);
        } else {
            $vault.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
            $vault.attr('aria-label', `Vault health: OK${warnings ? ` (${warnings} minor warnings)` : ''}`);
        }
    } else {
        $vault.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $vault.attr('aria-label', 'Vault health: not checked yet');
    }

    // Connection (Obsidian circuit breaker — aggregate)
    const $conn = $footer.find('[data-health="connection"]');
    const circuit = getCircuitState();
    if (circuit.state === 'closed') {
        $conn.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
        $conn.attr('aria-label', 'Connection: all vaults connected');
    } else if (circuit.state === 'half-open') {
        $conn.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
        $conn.attr('aria-label', 'Connection: recovering — probing vault');
    } else {
        $conn.removeClass('dle-health-ok dle-health-warn').addClass('dle-health-error');
        $conn.attr('aria-label', `Connection: vault unreachable (${circuit.failures} failures)`);
    }

    // Pipeline
    const $pipe = $footer.find('[data-health="pipeline"]');
    if (lastPipelineTrace) {
        const hasResults = lastPipelineTrace.finalEntries?.length > 0 || lastPipelineTrace.totalTokens > 0;
        if (hasResults) {
            $pipe.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
            $pipe.attr('aria-label', 'Pipeline: last run produced results');
        } else {
            $pipe.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
            $pipe.attr('aria-label', 'Pipeline: last run produced no results');
        }
    } else {
        $pipe.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $pipe.attr('aria-label', 'Pipeline: no runs yet');
    }

    // Cache
    const $cache = $footer.find('[data-health="cache"]');
    if (indexEverLoaded && indexTimestamp) {
        const ageMs = Date.now() - indexTimestamp;
        const cacheTTL = (settings.cacheTTL || 300) * 1000;
        if (ageMs < cacheTTL) {
            $cache.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
            $cache.attr('aria-label', `Cache: fresh (${Math.round(ageMs / 1000)}s old, ${vaultIndex.length} entries)`);
        } else {
            $cache.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
            $cache.attr('aria-label', `Cache: stale (${Math.round(ageMs / 1000)}s old, ${vaultIndex.length} entries)`);
        }
    } else if (vaultIndex.length > 0) {
        // Have entries from hydration but never loaded from Obsidian
        $cache.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
        $cache.attr('aria-label', `Cache: hydrated from IndexedDB (${vaultIndex.length} entries, not yet refreshed)`);
    } else {
        $cache.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $cache.attr('aria-label', 'Cache: empty — no index loaded');
    }

    // AI service
    const $ai = $footer.find('[data-health="ai"]');
    if (isAiCircuitOpen()) {
        $ai.removeClass('dle-health-ok dle-health-warn').addClass('dle-health-error');
        $ai.attr('aria-label', 'AI service: circuit breaker tripped — temporarily disabled');
    } else if (aiSearchStats.calls > 0) {
        $ai.removeClass('dle-health-warn dle-health-error').addClass('dle-health-ok');
        $ai.attr('aria-label', `AI service: OK (${aiSearchStats.calls} calls this session)`);
    } else if (settings.aiSearchEnabled !== false) {
        $ai.removeClass('dle-health-ok dle-health-error').addClass('dle-health-warn');
        $ai.attr('aria-label', 'AI service: enabled but no calls yet');
    } else {
        $ai.removeClass('dle-health-ok dle-health-warn dle-health-error');
        $ai.attr('aria-label', 'AI service: disabled');
    }

    // ── AI stats ──
    $footer.find('[data-ai-stat="calls"]').text(`${aiSearchStats.calls} calls`);
    $footer.find('[data-ai-stat="cached"]').text(`${aiSearchStats.cachedHits} cached`);
    const totalTok = aiSearchStats.totalInputTokens + aiSearchStats.totalOutputTokens;
    $footer.find('[data-ai-stat="tokens"]').text(`${formatTokensCompact(totalTok)} tok`);
}

/**
 * Wire health icon click handlers (one-time binding).
 */
function wireHealthIcons($drawer) {
    const $footer = $drawer.find('#dle_drawer_footer');
    if (!$footer.length) return;

    $footer.find('.dle-health-icons').on('click', '[data-health]', function (e) {
        e.preventDefault();
        const area = $(this).data('health');
        switch (area) {
            case 'vault': executeCommand('/dle-health'); break;
            case 'connection': executeCommand('/dle-status'); break;
            case 'pipeline': executeCommand('/dle-inspect'); break;
            case 'cache': {
                const ageMs = indexTimestamp ? Date.now() - indexTimestamp : 0;
                const ageSec = Math.round(ageMs / 1000);
                const msg = indexTimestamp
                    ? `Index: ${vaultIndex.length} entries, ${ageSec}s old${indexEverLoaded ? '' : ' (from IndexedDB cache)'}`
                    : 'No index loaded yet.';
                if (typeof toastr !== 'undefined') toastr.info(msg, 'Cache Status');
                break;
            }
            case 'ai': {
                const totalTok = aiSearchStats.totalInputTokens + aiSearchStats.totalOutputTokens;
                const msg = `Calls: ${aiSearchStats.calls} | Cached: ${aiSearchStats.cachedHits} | Tokens: ${totalTok.toLocaleString()} (${aiSearchStats.totalInputTokens.toLocaleString()} in, ${aiSearchStats.totalOutputTokens.toLocaleString()} out)`;
                if (typeof toastr !== 'undefined') toastr.info(msg, 'AI Search Stats');
                break;
            }
        }
    });

    // Also handle Enter/Space for keyboard a11y
    $footer.find('.dle-health-icons').on('keydown', '[data-health]', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            $(this).trigger('click');
        }
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Tab Switching
// ════════════════════════════════════════════════════════════════════════════

/**
 * Switch to a tab by name. Updates ARIA, classes, hidden state, roving tabindex, and label.
 * @param {jQuery} $drawer - The drawer root element
 * @param {string} tabName - Tab name to activate
 */
function switchTab($drawer, tabName) {
    const $tabs = $drawer.find('.dle-tab');
    const $panels = $drawer.find('.dle-tab-panel');
    const $label = $drawer.find('.dle-tab-label');

    // Update tab bar — roving tabindex
    $tabs.each(function () {
        const $t = $(this);
        const isActive = $t.data('tab') === tabName;
        $t.toggleClass('active', isActive)
            .attr('aria-selected', isActive ? 'true' : 'false')
            .attr('tabindex', isActive ? '0' : '-1');
    });

    // Update panels — use hidden attribute for a11y
    $panels.each(function () {
        const $p = $(this);
        const isActive = $p.data('tab') === tabName;
        $p.toggleClass('active', isActive);
        if (isActive) {
            $p.removeAttr('hidden');
        } else {
            $p.attr('hidden', '');
        }
    });

    // Update label
    $label.text(TAB_LABELS[tabName] || tabName);
}

// ════════════════════════════════════════════════════════════════════════════
// Drawer Creation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create the drawer panel in #top-settings-holder.
 * Mirrors ST's native drawer structure exactly (see #rightNavHolder pattern).
 */
export async function createDrawerPanel() {
    if ($(`#${DRAWER_ID}`).length) return;

    // Load ST internals (Moving UI, mobile detection)
    await loadSTInternals();

    // Load the drawer HTML template
    const drawerContent = await renderExtensionTemplateAsync(
        'third-party/sillytavern-DeepLore-Enhanced',
        'drawer',
    );

    // Build the full drawer structure — mirrors ST's native pattern exactly
    const $drawer = $drawerRef = $(`
        <div id="${DRAWER_ID}" class="drawer">
            <div class="drawer-toggle drawer-header">
                <div id="deeploreDrawerIcon"
                     class="drawer-icon fa-solid fa-scroll fa-fw interactable closedIcon"
                     title="DeepLore Enhanced"
                     tabindex="0"
                     role="button"
                     aria-expanded="false"
                     aria-label="DeepLore Enhanced drawer"></div>
            </div>
            <div id="deeplore-panel" class="drawer-content closedDrawer fillRight" role="region" aria-label="DeepLore Enhanced panel">
                <div id="deeplore-panelheader" class="fa-solid fa-grip drag-grabber" aria-hidden="true"></div>
                <div class="dle-drawer-pin" title="Pin drawer open">
                    <input type="checkbox" id="dle_drawer_pin" aria-label="Pin drawer open">
                    <label for="dle_drawer_pin">
                        <div class="fa-solid unchecked fa-unlock right_menu_button" aria-hidden="true"></div>
                        <div class="fa-solid checked fa-lock right_menu_button" aria-hidden="true"></div>
                    </label>
                </div>
                <div class="scrollableInner dle-drawer-inner">
                </div>
            </div>
        </div>
    `);

    // Inject content into the scrollable area, then move footer outside so it stays pinned
    $drawer.find('.dle-drawer-inner').append(drawerContent);
    const $footerZone = $drawer.find('#dle_drawer_footer');
    if ($footerZone.length) $footerZone.insertAfter($drawer.find('.dle-drawer-inner'));

    // Add to top-settings-holder (after native drawers)
    $('#top-settings-holder').append($drawer);

    // CRITICAL: Bind the drawer toggle — ST's initial binding already ran at page load,
    // so dynamically-added drawers need explicit binding to doNavbarIconClick
    $drawer.find('.drawer-toggle').on('click', function (e) {
        doNavbarIconClick.call(this, e);
        // Update aria-expanded after ST processes the toggle
        requestAnimationFrame(() => {
            const isOpen = $drawer.find('#deeplore-panel').hasClass('openDrawer');
            $drawer.find('#deeploreDrawerIcon').attr('aria-expanded', String(isOpen));
        });
    });

    // Hide pin on mobile (ST convention — native drawers gate behind !isMobile())
    if (isMobile && isMobile()) {
        $drawer.find('.dle-drawer-pin').hide();
    }

    // Restore persisted pin state
    const settings = extension_settings[MODULE_NAME] || {};
    if (settings.drawerPinned && !(isMobile && isMobile())) {
        $drawer.find('#dle_drawer_pin').prop('checked', true);
        $drawer.find('#deeplore-panel').addClass('pinnedOpen');
        $drawer.find('#deeploreDrawerIcon').addClass('drawerPinnedOpen');
    }

    // Wire up pin toggle — matches ST's native drawer pin pattern
    $drawer.find('#dle_drawer_pin').on('click', function () {
        const pinned = $(this).prop('checked');
        if (pinned) {
            $drawer.find('#deeplore-panel').addClass('pinnedOpen');
            $drawer.find('#deeploreDrawerIcon').addClass('drawerPinnedOpen');
        } else {
            $drawer.find('#deeplore-panel').removeClass('pinnedOpen');
            $drawer.find('#deeploreDrawerIcon').removeClass('drawerPinnedOpen');

            // ST convention: close drawer on unpin if another drawer is also open
            if ($drawer.find('#deeplore-panel').hasClass('openDrawer') && $('.openDrawer').length > 1) {
                doNavbarIconClick.call($drawer.find('.drawer-toggle')[0]);
            }
        }

        // Persist pin state
        if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
        extension_settings[MODULE_NAME].drawerPinned = pinned;
        saveSettingsDebounced();
    });

    // Moving UI support — let ST's drag system handle our panel
    if (power_user?.movingUI && dragElement) {
        dragElement($('#deeplore-panel'));
    }

    // Wire up tab switching — click
    $drawer.find('.dle-tab').on('click', function () {
        switchTab($drawer, $(this).data('tab'));
    });

    // Wire up tab switching — keyboard (arrow keys, Home/End per ARIA tabs pattern)
    $drawer.find('.dle-tab').on('keydown', function (e) {
        const $tabs = $drawer.find('.dle-tab');
        const idx = $tabs.index(this);
        let newIdx = idx;

        switch (e.key) {
            case 'ArrowRight': newIdx = (idx + 1) % $tabs.length; break;
            case 'ArrowLeft': newIdx = (idx - 1 + $tabs.length) % $tabs.length; break;
            case 'Home': newIdx = 0; break;
            case 'End': newIdx = $tabs.length - 1; break;
            default: return;
        }

        e.preventDefault();
        const $newTab = $tabs.eq(newIdx);
        switchTab($drawer, $newTab.data('tab'));
        $newTab.trigger('focus');
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Wire event handlers (one-time)
    // ═══════════════════════════════════════════════════════════════════════
    wireToolsTab($drawer);
    wireTabExpand($drawer);
    wireStatusActions($drawer);
    wireBrowseTab($drawer);
    wireGatingTab($drawer);
    wireHealthIcons($drawer);

    // ═══════════════════════════════════════════════════════════════════════
    // Context window event — track total prompt tokens after assembly
    // ═══════════════════════════════════════════════════════════════════════
    try {
        const stCtx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stCtx?.eventSource && stCtx?.eventTypes?.CHAT_COMPLETION_PROMPT_READY) {
            // Lazy-load promptManager to avoid breaking module graph for non-OAI backends
            if (!promptManagerRef) {
                try {
                    const oai = await import('../../../../openai.js');
                    promptManagerRef = oai.promptManager;
                } catch { /* non-OAI backend, context bar stays at 0 */ }
            }
            stCtx.eventSource.on(stCtx.eventTypes.CHAT_COMPLETION_PROMPT_READY, () => {
                contextTokens = promptManagerRef?.tokenUsage || 0;
                scheduleRender(renderFooter);
            });
        }
    } catch (err) {
        console.warn('[DLE] Could not wire context token tracking:', err.message);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Generation lifecycle — track "Writing..." state between GENERATION_STARTED and GENERATION_ENDED
    // ═══════════════════════════════════════════════════════════════════════
    try {
        const stCtx2 = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (stCtx2?.eventSource && stCtx2?.eventTypes?.GENERATION_STARTED) {
            stCtx2.eventSource.on(stCtx2.eventTypes.GENERATION_STARTED, () => {
                stGenerating = true;
                scheduleRender(renderStatusZone);
            });
            stCtx2.eventSource.on(stCtx2.eventTypes.GENERATION_ENDED, () => {
                stGenerating = false;
                scheduleRender(renderStatusZone);
            });
        }
    } catch (err) {
        console.warn('[DLE] Could not wire generation lifecycle tracking:', err.message);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Initial render
    // ═══════════════════════════════════════════════════════════════════════
    renderStatusZone();
    renderInjectionTab();
    renderBrowseTab();
    renderGatingTab();
    renderTimers();
    renderFooter();

    // ═══════════════════════════════════════════════════════════════════════
    // Observer subscriptions — live data updates
    // ═══════════════════════════════════════════════════════════════════════
    onIndexUpdated(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderBrowseTab);
        scheduleRender(renderTimers);
        scheduleRender(renderFooter);
        announceToScreenReader(`Vault index refreshed: ${vaultIndex.length} entries loaded.`);
    });

    onAiStatsUpdated(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderFooter);
    });

    onCircuitStateChanged(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderFooter);
    });

    onPipelineComplete(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderInjectionTab);
        scheduleRender(renderBrowseTab);
        scheduleRender(renderTimers);
        scheduleRender(renderFooter);
        if (lastInjectionSources !== null) {
            announceToScreenReader(`Pipeline complete: ${lastInjectionSources.length} entries injected.`);
        }
    });

    onGatingChanged(() => {
        scheduleRender(renderStatusZone);
        scheduleRender(renderGatingTab);
    });

    onPinBlockChanged(() => {
        scheduleRender(renderBrowseTab);
    });

    onGenerationLockChanged(() => {
        scheduleRender(renderStatusZone);
    });
}
