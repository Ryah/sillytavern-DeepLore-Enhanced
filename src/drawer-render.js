/**
 * DeepLore Enhanced — Drawer Render Functions
 * All functions that produce HTML / update the DOM for the drawer panel.
 */
import { chat_metadata, amount_gen } from '../../../../../script.js';
import { escapeHtml } from '../../../../utils.js';
import { getSettings } from '../settings.js';
import {
    vaultIndex, lastInjectionSources, previousSources, lastPipelineTrace,
    generationLock, computeOverallStatus,
    aiSearchStats, isAiCircuitOpen, indexEverLoaded, indexTimestamp, lastHealthResult,
    cooldownTracker, decayTracker,
} from './state.js';
import { buildObsidianURI, computeSourcesDiff, categorizeRejections, resolveEntryVault } from './helpers.js';
import { getCircuitState } from './obsidian-api.js';
import {
    ds, BROWSE_ROW_HEIGHT, BROWSE_OVERSCAN, MODE_LABELS, STATUS_CLASSES,
    getMatchLabel, formatTokensCompact,
} from './drawer-state.js';

// ════════════════════════════════════════════════════════════════════════════
// Status Zone
// ════════════════════════════════════════════════════════════════════════════

/**
 * Update the fixed status zone with live data.
 */
export function renderStatusZone() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const settings = getSettings();

    // Status dot (pass Obsidian circuit state for real-time accuracy between index builds)
    const status = computeOverallStatus(getCircuitState());
    const $dot = $drawer.find('.dle-status-dot');
    $dot.removeClass('dle-status-ok dle-status-degraded dle-status-limited dle-status-offline');
    $dot.addClass(STATUS_CLASSES[status] || 'dle-status-offline');
    $dot.attr('title', `Status: ${status}`);
    $dot.attr('aria-label', `System status: ${status}`);

    // Pipeline label + activity animation (3-state: Choosing Lore → Writing → Idle)
    const pipelineText = generationLock ? 'Choosing Lore...' : ds.stGenerating ? 'Writing...' : 'Idle';
    $drawer.find('.dle-pipeline-label').text(pipelineText).attr('aria-label', `Pipeline stage: ${pipelineText}`);
    $dot.toggleClass('dle-status-active', !!generationLock || ds.stGenerating);

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

    updateTabBadges();
}

/**
 * Update tab count badges (cheap — just sets textContent on 3 spans).
 */
export function updateTabBadges() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;

    // Why? tab: injected entry count
    const injCount = lastInjectionSources?.length || 0;
    $drawer.find('[data-badge="injection"]').text(injCount || '');

    // Browse tab: total vault entries
    const browseCount = vaultIndex?.length || 0;
    $drawer.find('[data-badge="browse"]').text(browseCount || '');

    // Gating tab: count of active gating fields
    const ctx = chat_metadata?.deeplore_context;
    let gatingCount = 0;
    if (ctx) {
        if (ctx.era) gatingCount++;
        if (ctx.location) gatingCount++;
        if (ctx.scene_type) gatingCount++;
        if (ctx.characters_present?.length) gatingCount += ctx.characters_present.length;
    }
    $drawer.find('[data-badge="gating"]').text(gatingCount || '');
}

// ════════════════════════════════════════════════════════════════════════════
// Why? Tab
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render the "Why?" tab — shows why entries were injected AND why others were filtered out.
 */
export function renderInjectionTab() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
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

    // Compute diff via shared data layer
    const diff = computeSourcesDiff(sources, prev);

    // Diff header
    const diffParts = [];
    if (diff.added.length) diffParts.push(`<span class="dle-diff-add" aria-label="${diff.added.length} new entries added">+${diff.added.length} new</span>`);
    if (diff.removed.length) diffParts.push(`<span class="dle-diff-remove" aria-label="${diff.removed.length} entries removed">-${diff.removed.length} removed</span>`);
    $diff.html(diffParts.join(' '));

    // Build entries
    const settings = getSettings();
    const addedTitles = new Set(diff.added.map(s => s.title));
    let html = '';

    for (const src of sources) {
        const isNew = addedTitles.has(src.title);
        const isConstant = src.constant || (src.matchedBy && src.matchedBy.includes('Constant'));
        const classes = ['dle-why-entry'];
        if (isNew) classes.push('dle-why-new');
        if (isConstant) classes.push('dle-why-constant');

        // Obsidian link
        const { uri } = resolveEntryVault(src, settings.vaults);

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
        // Use shared categorization (all 8 rejection stages), flatten to list
        const injectedTitles = new Set(sources.map(s => s.title));
        const rejectedGroups = categorizeRejections(trace, injectedTitles);
        const rejections = [];
        for (const group of rejectedGroups) {
            for (const e of group.entries) {
                rejections.push({ title: e.title, reason: e.reason });
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

// ════════════════════════════════════════════════════════════════════════════
// Browse Tab
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render the browse tab with live vault entries.
 */
export function renderBrowseTab() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
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

    // Use pre-computed tag cache (rebuilt on index update)
    const $tagSelect = $drawer.find('[data-filter="tag"]');
    if (ds.cachedTagOptions) {
        $tagSelect.html(ds.cachedTagOptions);
        if (ds.browseTagFilter) $tagSelect.val(ds.browseTagFilter);
    }

    // Reset stale tag filter if the tag no longer exists in the vault
    if (ds.browseTagFilter && ds.cachedTagSet && !ds.cachedTagSet.has(ds.browseTagFilter)) {
        ds.browseTagFilter = '';
    }

    // Get filters
    const query = ds.browseQuery.toLowerCase();
    const statusFilter = ds.browseStatusFilter;
    const tagFilter = ds.browseTagFilter;
    const sortKey = ds.browseSort;

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

    // Store filtered entries for virtual scroll
    ds.browseFilteredEntries = entries;
    ds.browseLastRangeStart = -1;
    ds.browseLastRangeEnd = -1;
    ds.browseExpandedEntry = null; // collapse any expanded entry on filter change

    // Set up virtual scroll container — use min-height so flex doesn't collapse it
    const listEl = $list[0];
    if (!listEl) return;
    const totalHeight = entries.length * BROWSE_ROW_HEIGHT;
    $list.css({ 'min-height': totalHeight + 'px' });

    // Reset scroll to top when filters change (prevents seeing empty results after filtering while scrolled)
    const scrollContainer = $drawer.find('.dle-drawer-inner')[0];
    if (scrollContainer) scrollContainer.scrollTop = 0;

    // Render visible window
    renderBrowseWindow();
    $emptyNoResults.toggle(entries.length === 0);
}

/**
 * Render only the visible window of browse entries (virtual scroll).
 * Reads scroll position from the tab panel, computes visible range, renders only those rows.
 */
export function renderBrowseWindow() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const $list = $drawer.find('.dle-browse-list');
    const listEl = $list[0];
    if (!listEl) return;

    const entries = ds.browseFilteredEntries;
    if (!entries.length) { $list.empty(); return; }

    // The scrollable container is .dle-drawer-inner, not the tab panel
    const scrollContainer = $drawer.find('.dle-drawer-inner')[0];
    if (!scrollContainer) return;
    const viewHeight = scrollContainer.clientHeight;
    // How far the list's top is above (negative) or below (positive) the scroll container's viewport top
    // Using getBoundingClientRect for robustness against intermediate positioned parents
    const relativeScroll = scrollContainer.getBoundingClientRect().top - listEl.getBoundingClientRect().top;

    const startIdx = Math.max(0, Math.floor(relativeScroll / BROWSE_ROW_HEIGHT) - BROWSE_OVERSCAN);
    const endIdx = Math.min(entries.length, Math.ceil((relativeScroll + viewHeight) / BROWSE_ROW_HEIGHT) + BROWSE_OVERSCAN);

    // Skip re-render if visible range hasn't changed
    if (startIdx === ds.browseLastRangeStart && endIdx === ds.browseLastRangeEnd) return;
    ds.browseLastRangeStart = startIdx;
    ds.browseLastRangeEnd = endIdx;

    // Pin/block/injected state for rendering
    const pins = chat_metadata?.deeplore_pins || [];
    const blocks = chat_metadata?.deeplore_blocks || [];
    const pinSet = new Set(pins.map(t => t.toLowerCase()));
    const blockSet = new Set(blocks.map(t => t.toLowerCase()));
    const injectedSet = new Set();
    if (lastInjectionSources) {
        for (const s of lastInjectionSources) injectedSet.add(s.title.toLowerCase());
    }

    let html = '';
    for (let i = startIdx; i < endIdx; i++) {
        const e = entries[i];
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

        const top = i * BROWSE_ROW_HEIGHT;
        html += `<div class="${classes.join(' ')}" data-title="${escapeHtml(e.title)}" data-idx="${i}" role="listitem" aria-label="${browseAriaLabel}" style="position:absolute;top:${top}px;left:0;right:0;height:${BROWSE_ROW_HEIGHT}px;">`;
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

    $list.html(html);

    // Re-expand entry if one was expanded before this re-render
    if (ds.browseExpandedEntry) {
        const $entry = $list.find(`.dle-browse-entry[data-title="${CSS.escape(ds.browseExpandedEntry)}"]`);
        if ($entry.length) {
            const entry = ds.browseFilteredEntries.find(e => e.title === ds.browseExpandedEntry);
            if (entry) {
                const preview = entry.summary || (entry.content ? entry.content.substring(0, 200) + (entry.content.length > 200 ? '...' : '') : 'No content');
                const tokens = entry.tokenEstimate ? `${entry.tokenEstimate} tokens` : '';
                const settings = getSettings();
                const srcVault = entry.vaultSource && settings.vaults ? settings.vaults.find(v => v.name === entry.vaultSource) : null;
                const vaultName = srcVault ? srcVault.name : (settings.vaults?.[0]?.name || '');
                const uri = entry.filename ? buildObsidianURI(vaultName, entry.filename) : null;
                const linkHtml = uri ? ` <a href="${escapeHtml(uri)}" target="_blank" class="dle-obsidian-link" aria-label="Open in Obsidian">Open in Obsidian</a>` : '';
                $entry.append(`<div class="dle-browse-preview"><div class="dle-browse-preview-text">${escapeHtml(preview)}</div><div class="dle-browse-preview-meta">${escapeHtml(tokens)}${linkHtml}</div></div>`);
                $entry.css({ height: 'auto', position: 'absolute' });
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Gating Tab
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render the gating tab with live context state.
 */
export function renderGatingTab() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
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
        $value.find('.dle-chip, .dle-gating-empty, .dle-gating-count').remove();

        if (single) {
            if (value) {
                $setBtn.before(`<span class="dle-chip">${escapeHtml(value)} <button class="dle-chip-x" data-field="${field}" data-value="${escapeHtml(value)}" aria-label="Remove ${escapeHtml(value)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`);
                // Impact count: how many entries have this field set but DON'T match
                const entryField = field === 'sceneType' ? 'sceneType' : field;
                const filtered = vaultIndex.filter(e => e[entryField] && e[entryField] !== value).length;
                if (filtered > 0) {
                    $setBtn.before(`<span class="dle-gating-count" aria-label="Filtering ${filtered} entries">filtering ${filtered}</span>`);
                }
            } else {
                $setBtn.before('<span class="dle-gating-empty">Not set</span>');
            }
        } else {
            // Array field (characters)
            if (value && value.length > 0) {
                for (const c of value) {
                    $setBtn.before(`<span class="dle-chip">${escapeHtml(c)} <button class="dle-chip-x" data-field="${field}" data-value="${escapeHtml(c)}" aria-label="Remove ${escapeHtml(c)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></span>`);
                }
                // Impact count: entries with character_present set but no overlap with active characters
                const charSet = new Set(value.map(c => c.toLowerCase()));
                const filtered = vaultIndex.filter(e =>
                    e.characterPresent?.length && !e.characterPresent.some(cp => charSet.has(cp.toLowerCase())),
                ).length;
                if (filtered > 0) {
                    $setBtn.before(`<span class="dle-gating-count" aria-label="Filtering ${filtered} entries">filtering ${filtered}</span>`);
                }
            } else {
                $setBtn.before('<span class="dle-gating-empty">None set</span>');
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// Timers
// ════════════════════════════════════════════════════════════════════════════

/** Render active entry timers (cooldown, decay, warmup) below gating */
export function renderTimers() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
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
// Footer Zone — Health Icons + AI Stats + Context Bar
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render the footer zone: context bar, health icons, AI stats.
 */
export function renderFooter() {
    const $drawer = ds.$drawer;
    if (!$drawer) return;
    const $footer = $drawer.find('#dle_drawer_footer');
    if (!$footer.length) return;

    // ── Context window bar ──
    const ctx = typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
    // Prefer chatCompletionSettings (respects unlocked context) over maxContext (base slider)
    const maxContext = ctx?.chatCompletionSettings?.openai_max_context || ctx?.maxContext || 0;
    const responseTokens = ctx?.chatCompletionSettings?.openai_max_tokens || amount_gen || 0;
    const contextUsed = ds.contextTokens || 0;

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
