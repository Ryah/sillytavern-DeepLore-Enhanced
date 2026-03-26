/**
 * DeepLore Enhanced — Graph visualization module
 * Interactive force-directed graph of entry relationships.
 * Extracted from popups.js for maintainability.
 *
 * Phase 2: search/filter toolbar, interactive legend, right-click context menu,
 * rich HTML tooltip, fit-to-view, export PNG/JSON, node coloring modes.
 */
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { NO_ENTRIES_MSG } from '../core/utils.js';
import { getSettings, getVaultByName, invalidateSettingsCache } from '../settings.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { vaultIndex, chatInjectionCounts, lastHealthResult, trackerKey } from './state.js';
import { ensureIndexFresh } from './vault.js';
import { buildObsidianURI } from './helpers.js';

// ============================================================================
// Debug logging
// ============================================================================
const TAG = '[DLE Graph]';
function dbg(...args) {
    const s = getSettings();
    if (s?.debugMode) console.debug(TAG, ...args);
}

// ============================================================================
// Helpers
// ============================================================================

/** Find nearest node to world-space point within hitRadius. Skips hidden nodes (and filtered, unless in Focus Tree). */
function findNearest(nodes, wx, wy, maxDist, debugLabel, inFocusTree) {
    let closest = null, closestDist = maxDist;
    let nearestAny = null, nearestAnyDist = Infinity;
    for (const n of nodes) {
        if (n.hidden) continue;
        if (n.filtered && !inFocusTree) continue;
        const d = Math.sqrt((n.x - wx) ** 2 + (n.y - wy) ** 2);
        if (d < closestDist) { closest = n; closestDist = d; }
        if (d < nearestAnyDist) { nearestAny = n; nearestAnyDist = d; }
    }
    if (debugLabel && !closest && nearestAny) {
        dbg(`findNearest miss (${debugLabel}): nearest="${nearestAny.title}" at dist=${nearestAnyDist.toFixed(1)}, maxDist=${maxDist.toFixed(1)}`);
    }
    return closest;
}

/** Priority-based color (lower priority = warmer). */
function priorityColor(priority) {
    const p = Math.max(0, Math.min(100, priority || 50));
    if (p <= 25) return '#e53935'; // high priority — red
    if (p <= 40) return '#ff9800'; // medium-high — orange
    if (p <= 55) return '#ffeb3b'; // medium — yellow
    if (p <= 75) return '#66bb6a'; // medium-low — green
    return '#42a5f5'; // low priority — blue
}

/** Centrality-based color (more connections = warmer). */
function centralityColor(edgeCount, maxEdgeCount) {
    const ratio = maxEdgeCount > 0 ? edgeCount / maxEdgeCount : 0;
    if (ratio > 0.7) return '#e53935';
    if (ratio > 0.4) return '#ff9800';
    if (ratio > 0.2) return '#ffeb3b';
    if (ratio > 0.05) return '#66bb6a';
    return '#42a5f5';
}

/** Injection frequency color. */
function frequencyColor(count, maxCount) {
    if (!maxCount) return '#78909c';
    const ratio = count / maxCount;
    if (ratio > 0.7) return '#e53935';
    if (ratio > 0.4) return '#ff9800';
    if (ratio > 0.15) return '#ffeb3b';
    if (ratio > 0) return '#66bb6a';
    return '#78909c'; // never injected — gray
}

/**
 * Show an interactive force-directed graph of entry relationships.
 */
export async function showGraphPopup() {
    await ensureIndexFresh();
    if (vaultIndex.length === 0) {
        toastr.info(NO_ENTRIES_MSG, 'DeepLore Enhanced');
        return;
    }

    if (vaultIndex.length > 200) {
        toastr.warning(
            `Large vault (${vaultIndex.length} entries). The graph may be slow to render. Consider filtering by tag first.`,
            'DeepLore Enhanced',
            { timeOut: 8000, preventDuplicates: true },
        );
    }

    const settings = getSettings();
    const multiVault = (settings.vaults || []).length > 1;
    dbg(`showGraphPopup: ${vaultIndex.length} entries, multiVault=${multiVault}`);

    // ========================================================================
    // Build node and edge data
    // ========================================================================
    const nodes = vaultIndex.map((e, i) => ({
        id: i,
        title: e.title,
        type: e.constant ? 'constant' : e.seed ? 'seed' : e.bootstrap ? 'bootstrap' : 'regular',
        tokens: e.tokenEstimate,
        priority: e.priority,
        vaultSource: e.vaultSource || '',
        tags: Array.isArray(e.tags) ? e.tags : [],
        x: Math.random() * 800 - 400,
        y: Math.random() * 600 - 300,
        vx: 0, vy: 0,
        hidden: false,
        filtered: false, // search/filter — true = ghosted
    }));

    // B7: Detect title collisions (case-insensitive)
    const titleToIdx = new Map();
    const titleCollisions = [];
    for (let i = 0; i < vaultIndex.length; i++) {
        const key = vaultIndex[i].title.toLowerCase();
        if (titleToIdx.has(key)) {
            titleCollisions.push({ existing: titleToIdx.get(key), duplicate: i, title: vaultIndex[i].title });
        } else {
            titleToIdx.set(key, i);
        }
    }
    if (titleCollisions.length > 0) {
        dbg('Title collisions detected:', titleCollisions.map(c => `"${c.title}" (idx ${c.existing} vs ${c.duplicate})`));
        toastr.warning(
            `${titleCollisions.length} title collision(s) detected (case-insensitive). Duplicate entries may not display correctly in the graph.`,
            'DeepLore Enhanced',
            { timeOut: 8000, preventDuplicates: true },
        );
    }

    // B2: Deduplicate edges using a Set keyed on min,max,type
    const edgeSet = new Set();
    const edges = [];
    function addEdge(from, to, type) {
        const key = `${Math.min(from, to)},${Math.max(from, to)},${type}`;
        if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({ from, to, type, _idx: edges.length });
        }
    }

    for (let i = 0; i < vaultIndex.length; i++) {
        const entry = vaultIndex[i];
        for (const link of entry.resolvedLinks) {
            const j = titleToIdx.get(link.toLowerCase());
            if (j !== undefined && j !== i) addEdge(i, j, 'link');
        }
        for (const req of entry.requires) {
            const j = titleToIdx.get(req.toLowerCase());
            if (j !== undefined && j !== i) addEdge(i, j, 'requires');
        }
        for (const ex of entry.excludes) {
            const j = titleToIdx.get(ex.toLowerCase());
            if (j !== undefined && j !== i) addEdge(i, j, 'excludes');
        }
        for (const cl of (entry.cascadeLinks || [])) {
            const j = titleToIdx.get(cl.toLowerCase());
            if (j !== undefined && j !== i) addEdge(i, j, 'cascade');
        }
    }

    // B3: Detect circular requires using Set (O(e) instead of O(e²))
    const circularPairs = [];
    const requiresSet = new Set();
    for (const edge of edges) {
        if (edge.type === 'requires') requiresSet.add(`${edge.from},${edge.to}`);
    }
    const seenCircular = new Set();
    for (const edge of edges) {
        if (edge.type === 'requires' && requiresSet.has(`${edge.to},${edge.from}`)) {
            const key = `${Math.min(edge.from, edge.to)},${Math.max(edge.from, edge.to)}`;
            if (!seenCircular.has(key)) { seenCircular.add(key); circularPairs.push(key); }
        }
    }

    dbg(`Built ${edges.length} edges (${edgeSet.size} unique), ${circularPairs.length} circular pairs`);
    const edgeTypeCounts = { link: 0, requires: 0, excludes: 0, cascade: 0 };
    for (const e of edges) edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] || 0) + 1;
    dbg(`Edge breakdown: link=${edgeTypeCounts.link}, requires=${edgeTypeCounts.requires}, excludes=${edgeTypeCounts.excludes}, cascade=${edgeTypeCounts.cascade}`);

    // Edge visibility state (moved here so buildAdjacency can reference it)
    const edgeVisibility = { link: true, requires: true, excludes: true, cascade: true };

    // ========================================================================
    // Build adjacency for hover-dim BFS (U3) — rebuilt when edge visibility changes
    // ========================================================================
    let adjacency = new Map();
    function buildAdjacency() {
        adjacency = new Map();
        for (const n of nodes) adjacency.set(n.id, []);
        for (const edge of edges) {
            if (!edgeVisibility[edge.type]) continue; // Respect legend toggles
            adjacency.get(edge.from).push(edge.to);
            adjacency.get(edge.to).push(edge.from);
        }
        dbg('Adjacency rebuilt, visible edge types:', Object.entries(edgeVisibility).filter(([, v]) => v).map(([k]) => k).join(', '));
    }
    buildAdjacency(); // Initial build with all edge types visible

    // ========================================================================
    // Precompute data for coloring modes
    // ========================================================================
    const edgeCountByNode = new Map();
    for (const edge of edges) {
        edgeCountByNode.set(edge.from, (edgeCountByNode.get(edge.from) || 0) + 1);
        edgeCountByNode.set(edge.to, (edgeCountByNode.get(edge.to) || 0) + 1);
    }
    const maxEdgeCount = Math.max(1, ...edgeCountByNode.values());

    // Injection frequency
    let maxInjectionCount = 0;
    const injectionCounts = new Map();
    for (const n of nodes) {
        const entry = vaultIndex[n.id];
        const count = chatInjectionCounts.get(trackerKey(entry)) || 0;
        injectionCounts.set(n.id, count);
        if (count > maxInjectionCount) maxInjectionCount = count;
    }

    // Collect unique tags for filter dropdown
    const allTags = new Set();
    for (const n of nodes) {
        for (const t of n.tags) allTags.add(t);
    }
    const tagList = [...allTags].sort();

    // ========================================================================
    // Build text summary for screen readers
    // ========================================================================
    const typeCounts = { regular: 0, constant: 0, seed: 0, bootstrap: 0 };
    for (const n of nodes) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;

    const topConnected = [...edgeCountByNode.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([idx, count]) => `${nodes[idx].title} (${count} connections)`);

    const circularNames = circularPairs.map(key => {
        const [a, b] = key.split(',').map(Number);
        return `${nodes[a].title} <-> ${nodes[b].title}`;
    });

    let summaryHtml = `<p><strong>Totals:</strong> ${nodes.length} nodes, ${edges.length} edges</p>`;
    summaryHtml += `<p><strong>By type:</strong> ${typeCounts.regular} regular, ${typeCounts.constant} constant, ${typeCounts.seed} seed, ${typeCounts.bootstrap} bootstrap</p>`;
    if (topConnected.length > 0) {
        summaryHtml += `<p><strong>Most connected:</strong></p><ul>${topConnected.map(t => `<li>${t}</li>`).join('')}</ul>`;
    }
    if (circularNames.length > 0) {
        summaryHtml += `<p><strong>Circular requires:</strong></p><ul>${circularNames.map(t => `<li>${t}</li>`).join('')}</ul>`;
    } else {
        summaryHtml += `<p>No circular requires detected.</p>`;
    }

    // ========================================================================
    // Build popup DOM
    // ========================================================================
    const container = document.createElement('div');
    container.classList.add('dle-popup', 'dle-graph-popup');
    const circularWarning = circularPairs.length > 0
        ? `<p class="dle-error dle-text-sm">⚠ ${circularPairs.length} circular require pair(s) detected</p>`
        : '';

    const tagOptions = tagList.map(t => `<option value="${t}">${t}</option>`).join('');

    container.innerHTML = `
        <h3 class="dle-graph-title">Entry Relationship Graph (${nodes.length} nodes, ${edges.length} edges)</h3>
        ${circularWarning}
        <div class="dle-graph-toolbar">
            <input type="text" id="dle_graph_search" class="text_pole" placeholder="Search entries..." style="flex: 1; min-width: 120px; max-width: 200px; height: 28px; font-size: 12px;" />
            <select id="dle_graph_type_filter" class="text_pole" style="height: 28px; font-size: 12px; min-width: 80px;">
                <option value="">All Types</option>
                <option value="regular">Regular</option>
                <option value="constant">Constant</option>
                <option value="seed">Seed</option>
                <option value="bootstrap">Bootstrap</option>
            </select>
            <select id="dle_graph_tag_filter" class="text_pole" style="height: 28px; font-size: 12px; min-width: 80px;">
                <option value="">All Tags</option>
                ${tagOptions}
            </select>
            <span class="dle-graph-toolbar-sep"></span>
            <select id="dle_graph_color_mode" class="text_pole" title="Node color mode" style="height: 28px; font-size: 12px; min-width: 100px;">
                <option value="type">Color: Type</option>
                <option value="priority">Color: Priority</option>
                <option value="centrality">Color: Connections</option>
                <option value="frequency">Color: Frequency</option>
            </select>
            <span class="dle-graph-toolbar-sep"></span>
            <button id="dle_graph_back" class="menu_button" title="Exit Focus Tree (Esc)" style="height: 28px; padding: 2px 8px; font-size: 12px; display: none; white-space: nowrap; max-width: 300px; overflow: hidden; text-overflow: ellipsis;">← Back</button>
            <button id="dle_graph_fit" class="menu_button" title="Fit to view (0)" style="height: 28px; padding: 2px 8px; font-size: 12px;">Fit</button>
            <button id="dle_graph_export_png" class="menu_button" title="Export as PNG" style="height: 28px; padding: 2px 8px; font-size: 12px;">PNG</button>
            <button id="dle_graph_export_json" class="menu_button" title="Export as JSON" style="height: 28px; padding: 2px 8px; font-size: 12px;">JSON</button>
            <span class="dle-graph-toolbar-sep"></span>
            <button id="dle_graph_settings_btn" class="menu_button" title="Graph settings" style="height: 28px; padding: 2px 8px; font-size: 12px;"><i class="fa-solid fa-gear"></i></button>
        </div>
        <div class="dle-graph-legend" id="dle_graph_legend">
            <span class="dle-graph-legend-item" data-edge-type="link"><span style="color: #aac8ff;">—</span> Link</span>
            <span class="dle-graph-legend-item" data-edge-type="requires"><span class="dle-success">—</span> Requires</span>
            <span class="dle-graph-legend-item" data-edge-type="excludes"><span class="dle-error">—</span> Excludes</span>
            <span class="dle-graph-legend-item" data-edge-type="cascade"><span class="dle-warning">—</span> Cascade</span>
        </div>
        <div style="position: relative;">
            <canvas id="dle_graph_canvas" width="900" height="600" style="border: 1px solid var(--dle-border); border-radius: 4px; cursor: grab; width: 100%; height: 600px; background: var(--dle-bg-surface);" aria-label="Force-directed graph showing ${nodes.length} vault entries and ${edges.length} relationships between them."></canvas>
            <div id="dle_graph_tooltip" class="dle-graph-tooltip" style="display: none;"></div>
            <div id="dle_graph_context_menu" class="dle-graph-context-menu" style="display: none;"></div>
            <div id="dle_graph_settings_panel" class="dle-graph-settings-panel" style="display: none;">
                <div class="dle-graph-settings-titlebar" id="dle_graph_settings_titlebar">
                    <span><i class="fa-solid fa-gear"></i> Graph Settings</span>
                    <span class="dle-graph-settings-close" id="dle_graph_settings_panel_close">&times;</span>
                </div>
                <div class="dle-graph-settings-body">
                    <div class="dle-graph-settings-section-label">Visual</div>
                    <div class="dle-graph-settings-row">
                        <label>Color Mode</label>
                        <select id="dle_gs_color_mode" class="text_pole" style="height: 22px; font-size: 10px; width: 100px;">
                            <option value="type">By Type</option>
                            <option value="priority">By Priority</option>
                            <option value="centrality">By Connections</option>
                            <option value="frequency">By Frequency</option>
                        </select>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label>Show Labels</label>
                        <input type="checkbox" id="dle_gs_labels" />
                    </div>
                    <div class="dle-graph-settings-row">
                        <label title="Hops from hovered node that stay vivid">Hover Dim Dist</label>
                        <input type="range" id="dle_gs_hover_dim" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_hover_dim_val"></span>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label>Dim Opacity</label>
                        <input type="range" id="dle_gs_dim_opacity" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_dim_opacity_val"></span>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label title="Hops shown in Focus Tree mode">Focus Tree Depth</label>
                        <input type="range" id="dle_gs_tree_depth" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_tree_depth_val"></span>
                    </div>
                    <div class="dle-graph-settings-sep"></div>
                    <div class="dle-graph-settings-section-label">Physics</div>
                    <div class="dle-graph-settings-row">
                        <label>Repulsion</label>
                        <input type="range" id="dle_gs_repulsion" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_repulsion_val"></span>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label>Spring Length</label>
                        <input type="range" id="dle_gs_spring" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_spring_val"></span>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label>Gravity</label>
                        <input type="range" id="dle_gs_gravity" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_gravity_val"></span>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label>Damping</label>
                        <input type="range" id="dle_gs_damping" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_damping_val"></span>
                    </div>
                    <div class="dle-graph-settings-sep"></div>
                    <button id="dle_gs_reset" class="menu_button" style="width: 100%; height: 24px; font-size: 10px; margin-top: 2px;">Reset to Defaults</button>
                </div>
            </div>
        </div>
        <details class="dle-text-sm" style="margin-top: var(--dle-space-2);">
            <summary>Text summary (for screen readers)</summary>
            ${summaryHtml}
        </details>
        <small class="dle-dimmed">Drag nodes to reposition. Right-click for context menu. Scroll to zoom. Click+drag empty space to pan. Press 0 to fit.</small>
    `;

    callGenericPopup(container, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: false });

    // B6: Poll for canvas with layout wait
    let canvas = null;
    for (let attempt = 0; attempt < 20; attempt++) {
        canvas = document.getElementById('dle_graph_canvas');
        if (canvas && canvas.getBoundingClientRect().height > 0) break;
        canvas = null;
        await new Promise(r => setTimeout(r, 50));
    }
    if (!canvas) {
        dbg('ERROR: Canvas not found after polling — popup may have closed');
        return;
    }
    const ctx = canvas.getContext('2d');

    // B5: Cache rect, update only on resize
    let cachedRect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cachedRect.width * dpr;
    canvas.height = cachedRect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = cachedRect.width;
    const H = cachedRect.height;
    dbg(`Canvas initialized: ${W}x${H} CSS px, DPR=${dpr}, buffer=${canvas.width}x${canvas.height}`);

    for (const n of nodes) {
        n.x = (Math.random() - 0.5) * W * 0.8;
        n.y = (Math.random() - 0.5) * H * 0.8;
    }

    let panX = W / 2, panY = H / 2, zoom = 1;
    let dragNode = null, hoverNode = null;
    let isPanning = false, panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;
    let isRunning = true;
    let alpha = 1.0;

    // ========================================================================
    // Graph state (toolbar-driven, initialized from settings)
    // ========================================================================
    let colorMode = settings.graphDefaultColorMode || 'type';
    let searchQuery = '';
    let typeFilter = '';
    let tagFilter = '';
    // edgeVisibility declared earlier (before buildAdjacency)
    let showLabels = settings.graphShowLabels !== false;

    // ========================================================================
    // Focus Tree state
    // ========================================================================
    let focusTreeRoot = null;       // Node that is the tree root (null = normal graph mode)
    let focusTreePhysics = false;   // When true, use tree-constrained physics

    // ========================================================================
    // CSS-var-aware colors
    // ========================================================================
    const computedStyle = getComputedStyle(document.documentElement);
    const nodeColors = {
        constant: computedStyle.getPropertyValue('--dle-warning').trim() || '#ff9800',
        seed: computedStyle.getPropertyValue('--dle-info').trim() || '#2196f3',
        bootstrap: computedStyle.getPropertyValue('--dle-accent').trim() || '#9c27b0',
        regular: computedStyle.getPropertyValue('--dle-success').trim() || '#4caf50',
    };
    const edgeColors = {
        link: '#aac8ff',
        requires: computedStyle.getPropertyValue('--dle-success').trim() || '#4caf50',
        excludes: computedStyle.getPropertyValue('--dle-error').trim() || '#f44336',
        cascade: computedStyle.getPropertyValue('--dle-warning').trim() || '#ff9800',
    };

    function toScreen(x, y) { return { x: x * zoom + panX, y: y * zoom + panY }; }
    function toWorld(sx, sy) { return { x: (sx - panX) / zoom, y: (sy - panY) / zoom }; }

    // ========================================================================
    // Node color resolution based on current mode
    // ========================================================================
    function getNodeColor(n) {
        if (n === hoverNode) return '#ffffff';
        switch (colorMode) {
            case 'priority': return priorityColor(n.priority);
            case 'centrality': return centralityColor(edgeCountByNode.get(n.id) || 0, maxEdgeCount);
            case 'frequency': return frequencyColor(injectionCounts.get(n.id) || 0, maxInjectionCount);
            default: return nodeColors[n.type] || '#4caf50';
        }
    }

    // ========================================================================
    // Node radius — based on connection count (more connections = bigger)
    // ========================================================================
    function getNodeRadius(n) {
        const connections = edgeCountByNode.get(n.id) || 0;
        // Scale: 0 connections = 4px, maxEdgeCount = 14px, sqrt for visual balance
        return Math.max(4, Math.min(14, 4 + Math.sqrt(connections / maxEdgeCount) * 10));
    }

    // ========================================================================
    // Search and filter
    // ========================================================================
    function applyFilters() {
        const q = searchQuery.toLowerCase();
        let matchCount = 0;
        const hasFilter = q || typeFilter || tagFilter;

        // When all filters are cleared, also reset isolation (hidden state)
        // But don't touch hidden state if Focus Tree is active — tree manages that
        if (!hasFilter && !focusTreeRoot) {
            let wasIsolated = false;
            for (const n of nodes) {
                if (n.hidden) wasIsolated = true;
                n.hidden = false;
            }
            if (wasIsolated) dbg('Filters cleared — reset isolation mode');
        }

        for (const n of nodes) {
            let matches = true;
            if (q && !n.title.toLowerCase().includes(q)) matches = false;
            if (typeFilter && n.type !== typeFilter) matches = false;
            if (tagFilter && !n.tags.includes(tagFilter)) matches = false;
            n.filtered = hasFilter && !matches;
            if (!n.filtered) matchCount++;
        }
        needsDraw = true;
        dbg(`Filters applied: query="${q}", type="${typeFilter}", tag="${tagFilter}" → ${matchCount}/${nodes.length} match`);
        // Update match count display
        const searchEl = document.getElementById('dle_graph_search');
        if (searchEl && hasFilter) {
            searchEl.title = `${matchCount} of ${nodes.length} entries match`;
        } else if (searchEl) {
            searchEl.title = '';
        }
    }

    // ========================================================================
    // Fit to view
    // ========================================================================
    function fitToView() {
        const visible = nodes.filter(n => !n.hidden);
        if (visible.length === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of visible) {
            if (n.x < minX) minX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.x > maxX) maxX = n.x;
            if (n.y > maxY) maxY = n.y;
        }
        const dx = maxX - minX || 1;
        const dy = maxY - minY || 1;
        const padding = 40;
        zoom = Math.min((W - padding * 2) / dx, (H - padding * 2) / dy, 3);
        zoom = Math.max(0.2, zoom);
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        panX = W / 2 - cx * zoom;
        panY = H / 2 - cy * zoom;
        needsDraw = true;
    }

    // ========================================================================
    // U3: Hover dim — BFS to compute hop distances
    // ========================================================================
    // ========================================================================
    // Focus Tree — hierarchical tree layout from a root node
    // ========================================================================

    /**
     * BFS from root to maxDepth, returns Map<nodeId, depth>.
     * Uses full adjacency (ignores edge visibility toggles — you want the real structure).
     */
    function bfsDepth(rootId, maxDepth) {
        const fullAdj = new Map();
        for (const n of nodes) fullAdj.set(n.id, []);
        for (const edge of edges) {
            fullAdj.get(edge.from).push(edge.to);
            fullAdj.get(edge.to).push(edge.from);
        }
        const dist = new Map();
        const treeEdges = new Set(); // "from:to" keys for BFS tree edges only
        dist.set(rootId, 0);
        const queue = [rootId];
        let head = 0;
        while (head < queue.length) {
            const cur = queue[head++];
            const d = dist.get(cur);
            if (d >= maxDepth) continue;
            for (const nb of (fullAdj.get(cur) || [])) {
                if (!dist.has(nb)) {
                    dist.set(nb, d + 1);
                    queue.push(nb);
                    // Record this as a tree edge (both directions for lookup)
                    treeEdges.add(`${cur}:${nb}`);
                    treeEdges.add(`${nb}:${cur}`);
                }
            }
        }
        dist._treeEdges = treeEdges;
        return dist;
    }

    /**
     * Compute tree layout positions. Root at top center, children spread below.
     * Wraps wide levels into multiple rows to prevent side-scrolling.
     * Returns Map<nodeId, {x, y}>.
     */
    function computeTreeLayout(rootId, depthMap) {
        // Group nodes by level
        const levels = new Map(); // depth → [nodeId, ...]
        for (const [nid, d] of depthMap) {
            if (!levels.has(d)) levels.set(d, []);
            levels.get(d).push(nid);
        }
        const maxLevel = Math.max(...levels.keys());
        const levelSpacing = 120; // vertical px between levels
        const nodeSpacing = 80;   // min horizontal px between nodes
        const maxRowWidth = W * 2; // max width before wrapping (2x canvas for some breathing room)
        const positions = new Map();

        // First pass: figure out how many sub-rows each level needs
        const levelRows = []; // [{level, subRows: [[nodeId, ...], ...]}, ...]
        for (let lvl = 0; lvl <= maxLevel; lvl++) {
            const nodesAtLevel = levels.get(lvl) || [];
            nodesAtLevel.sort((a, b) => nodes[a].title.localeCompare(nodes[b].title));
            // How many nodes fit in one row?
            const perRow = Math.max(1, Math.floor(maxRowWidth / nodeSpacing));
            const subRows = [];
            for (let i = 0; i < nodesAtLevel.length; i += perRow) {
                subRows.push(nodesAtLevel.slice(i, i + perRow));
            }
            levelRows.push({ level: lvl, subRows });
        }

        // Second pass: assign Y positions accounting for sub-rows
        let currentY = 0;
        for (const { subRows } of levelRows) {
            for (let sr = 0; sr < subRows.length; sr++) {
                const row = subRows[sr];
                const count = row.length;
                const spacing = Math.min(nodeSpacing, maxRowWidth / (count + 1));
                const totalWidth = (count - 1) * spacing;
                const startX = -totalWidth / 2;
                for (let i = 0; i < count; i++) {
                    positions.set(row[i], {
                        x: count === 1 ? 0 : startX + i * spacing,
                        y: currentY,
                    });
                }
                currentY += sr < subRows.length - 1 ? levelSpacing * 0.6 : 0; // tighter for sub-rows
            }
            currentY += levelSpacing;
        }

        // Center vertically
        const totalHeight = currentY - levelSpacing; // subtract last spacing
        const offsetY = -totalHeight / 2;
        for (const pos of positions.values()) {
            pos.y += offsetY;
        }

        return positions;
    }

    function enterFocusTree(rootNode) {
        const depth = settings.graphFocusTreeDepth || 2;
        const depthMap = bfsDepth(rootNode.id, depth);

        dbg(`Focus Tree: root="${rootNode.title}", depth=${depth}, visible=${depthMap.size}/${nodes.length}`);

        // Hide nodes outside the neighborhood
        for (const n of nodes) {
            n.hidden = !depthMap.has(n.id);
        }

        // Pin root, compute tree positions, snap nodes
        focusTreeRoot = rootNode;
        rootNode.pinned = true;
        const positions = computeTreeLayout(rootNode.id, depthMap);
        for (const [nid, pos] of positions) {
            const n = nodes[nid];
            n.x = pos.x;
            n.y = pos.y;
            n.vx = 0;
            n.vy = 0;
            // Pin all nodes in tree mode — they're positioned by layout
            n._treePinned = true;
            n.pinned = true;
        }
        // Store depth map for rendering (level labels, edge styling)
        focusTreeRoot._depthMap = depthMap;
        // Pre-build edge index set for fast draw-loop lookup (avoid string concat per frame)
        const treeEdgeIdx = new Set();
        for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            if (depthMap._treeEdges.has(`${e.from}:${e.to}`)) treeEdgeIdx.add(i);
        }
        focusTreeRoot._treeEdgeIdx = treeEdgeIdx;
        cachedVisibleCount = depthMap.size;
        focusTreePhysics = true;
        alpha = 0.001; // Don't run physics — tree is pre-laid-out
        needsDraw = true;

        // Show breadcrumb button
        const backBtn = document.getElementById('dle_graph_back');
        if (backBtn) {
            backBtn.textContent = `← ${rootNode.title} (${depthMap.size} nodes, ${depth}-hop)`;
            backBtn.style.display = 'inline-block';
        }

        fitToView();
        // Refresh cached rect — toolbar may have shifted canvas position
        cachedRect = canvas.getBoundingClientRect();
    }

    function exitFocusTree() {
        if (!focusTreeRoot) return;
        dbg(`Exiting Focus Tree from root="${focusTreeRoot.title}"`);

        // Unpin all tree-pinned nodes, un-hide all
        for (const n of nodes) {
            if (n._treePinned) {
                n.pinned = false;
                n._treePinned = false;
            }
            n.hidden = false;
            n.vx = 0;
            n.vy = 0;
        }
        // Root was explicitly pinned — keep it pinned if it was before
        // (we always pinned it, so unpin it too)
        focusTreeRoot.pinned = false;
        delete focusTreeRoot._treeEdgeIdx;
        delete focusTreeRoot._depthMap;
        focusTreeRoot = null;
        focusTreePhysics = false;
        cachedVisibleCount = nodes.length;

        // Re-scatter nodes so physics can settle them
        for (const n of nodes) {
            if (!n.pinned) {
                n.x = (Math.random() - 0.5) * W * 0.8;
                n.y = (Math.random() - 0.5) * H * 0.8;
            }
        }
        alpha = 1.0;
        needsDraw = true;

        // Hide breadcrumb button
        const backBtn = document.getElementById('dle_graph_back');
        if (backBtn) backBtn.style.display = 'none';

        fitToView();
        cachedRect = canvas.getBoundingClientRect();
    }

    // ========================================================================
    // U3: Hover dim — BFS to compute hop distances
    // ========================================================================
    let hoverDistances = null;

    function computeHoverDistances(startId, maxDepth) {
        const depth = maxDepth ?? (settings.graphHoverDimDistance || 2);
        const dist = new Map();
        dist.set(startId, 0);
        const queue = [startId];
        let head = 0;
        while (head < queue.length) {
            const current = queue[head++];
            const d = dist.get(current);
            if (d >= depth) continue;
            for (const neighbor of (adjacency.get(current) || [])) {
                if (!dist.has(neighbor)) { dist.set(neighbor, d + 1); queue.push(neighbor); }
            }
        }
        return dist;
    }

    // ========================================================================
    // Physics simulation
    // ========================================================================
    let hasSpringEnergy = true;
    let maxDelta = 0;

    // Precompute mass per node: more connections = heavier = harder to push around
    // Mass ranges from 1.0 (0 connections) to ~5.0 (max connections)
    const nodeMass = new Float64Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
        const connections = edgeCountByNode.get(i) || 0;
        nodeMass[i] = 1 + Math.sqrt(connections / maxEdgeCount) * 4;
    }

    function simulate() {
        // In focus tree mode, skip physics — layout is pre-computed
        if (focusTreePhysics) return;
        if (alpha < 0.001 && !dragNode && !hasSpringEnergy && maxDelta < 0.01) return;
        if (!dragNode) alpha *= 0.98;
        const k = 0.008, repulsion = settings.graphRepulsion || 2000, damping = settings.graphDamping || 0.7, gravity = settings.graphGravity || 0.03, maxV = 8;
        const springLen = settings.graphSpringLength || 120;
        if (!dragNode) {
            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].hidden) continue;
                const mi = nodeMass[i];
                for (let j = i + 1; j < nodes.length; j++) {
                    if (nodes[j].hidden) continue;
                    const mj = nodeMass[j];
                    let dx = nodes[j].x - nodes[i].x;
                    let dy = nodes[j].y - nodes[i].y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const force = repulsion / (dist * dist) * alpha;
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;
                    // Lighter nodes get pushed more, heavier nodes resist
                    nodes[i].vx -= fx / mi; nodes[i].vy -= fy / mi;
                    nodes[j].vx += fx / mj; nodes[j].vy += fy / mj;
                }
            }
            for (let i = 0; i < nodes.length; i++) {
                const n = nodes[i];
                if (n.hidden) continue;
                n.vx -= n.x * gravity * alpha / nodeMass[i];
                n.vy -= n.y * gravity * alpha / nodeMass[i];
            }
        }
        for (const edge of edges) {
            if (nodes[edge.from].hidden || nodes[edge.to].hidden) continue;
            const a = nodes[edge.from], b = nodes[edge.to];
            const dx = b.x - a.x, dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = k * (dist - springLen);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            // Mass-weighted spring forces
            a.vx += fx / nodeMass[edge.from]; a.vy += fy / nodeMass[edge.from];
            b.vx -= fx / nodeMass[edge.to]; b.vy -= fy / nodeMass[edge.to];
        }
        let totalSpeed = 0;
        maxDelta = 0;
        const bound = Math.max(W, H) * 2;
        for (const n of nodes) {
            if (n === dragNode || n.pinned || n.hidden) continue;
            n.vx *= damping; n.vy *= damping;
            const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
            if (speed > maxV) { n.vx *= maxV / speed; n.vy *= maxV / speed; }
            n.x += n.vx; n.y += n.vy;
            n.x = Math.max(-bound, Math.min(bound, n.x));
            n.y = Math.max(-bound, Math.min(bound, n.y));
            totalSpeed += speed;
            maxDelta = Math.max(maxDelta, Math.abs(n.vx), Math.abs(n.vy));
        }
        // Collision resolution — push overlapping nodes apart based on their radii
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].hidden || nodes[i].pinned) continue;
            const ri = getNodeRadius(nodes[i]);
            for (let j = i + 1; j < nodes.length; j++) {
                if (nodes[j].hidden) continue;
                const rj = getNodeRadius(nodes[j]);
                const minDist = ri + rj + 2; // 2px padding
                let dx = nodes[j].x - nodes[i].x;
                let dy = nodes[j].y - nodes[i].y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
                if (dist < minDist) {
                    const overlap = (minDist - dist) / 2;
                    const nx = dx / dist, ny = dy / dist;
                    if (!nodes[i].pinned && nodes[i] !== dragNode) {
                        nodes[i].x -= nx * overlap;
                        nodes[i].y -= ny * overlap;
                    }
                    if (!nodes[j].pinned && nodes[j] !== dragNode) {
                        nodes[j].x += nx * overlap;
                        nodes[j].y += ny * overlap;
                    }
                }
            }
        }
        hasSpringEnergy = totalSpeed > 0.1;
    }

    // ========================================================================
    // Canvas rendering
    // ========================================================================
    let needsDraw = true;
    let prevHoverNode = null;

    let debugMouseX = 0, debugMouseY = 0;
    function draw() {
        ctx.clearRect(0, 0, W, H);

        // DEBUG: draw crosshair at mouse position (debug mode only)
        if (settings.debugMode && focusTreeRoot) {
            ctx.save();
            ctx.strokeStyle = 'red'; ctx.lineWidth = 1; ctx.globalAlpha = 0.8;
            ctx.beginPath(); ctx.moveTo(debugMouseX - 10, debugMouseY); ctx.lineTo(debugMouseX + 10, debugMouseY); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(debugMouseX, debugMouseY - 10); ctx.lineTo(debugMouseX, debugMouseY + 10); ctx.stroke();
            ctx.restore();
        }

        // Batch edges by type
        const edgesByType = { link: [], requires: [], excludes: [], cascade: [] };
        for (const edge of edges) {
            if (!edgeVisibility[edge.type]) continue;
            if (nodes[edge.from].hidden || nodes[edge.to].hidden) continue;
            (edgesByType[edge.type] || (edgesByType[edge.type] = [])).push(edge);
        }

        for (const [type, edgeList] of Object.entries(edgesByType)) {
            if (edgeList.length === 0) continue;
            ctx.strokeStyle = edgeColors[type] || '#555';
            if (type === 'excludes') { ctx.setLineDash([4, 4]); } else { ctx.setLineDash([]); }

            for (const edge of edgeList) {
                const fromFiltered = nodes[edge.from].filtered;
                const toFiltered = nodes[edge.to].filtered;

                // Frequency mode: thicker edges for high-frequency nodes
                let freqAvg = 0;
                if (colorMode === 'frequency') {
                    const fromFreq = (injectionCounts.get(edge.from) || 0) / (maxInjectionCount || 1);
                    const toFreq = (injectionCounts.get(edge.to) || 0) / (maxInjectionCount || 1);
                    freqAvg = (fromFreq + toFreq) / 2;
                    ctx.lineWidth = 1 + freqAvg * 3; // 1px–4px
                } else {
                    ctx.lineWidth = 1;
                }

                // Alpha priority: hover dim > focus tree depth > filtered > frequency/standard
                if (hoverDistances && focusTreeRoot && focusTreeRoot._treeEdgeIdx) {
                    // Iso mode hover: tree edges only, brighten n+1 edges
                    if (!focusTreeRoot._treeEdgeIdx.has(edge._idx)) continue;
                    // Only brighten edges directly touching the hovered node, going downward
                    const dm = focusTreeRoot._depthMap;
                    const hid = hoverNode ? hoverNode.id : -1;
                    const touchesHover = (edge.from === hid || edge.to === hid);
                    const otherDepth = edge.from === hid ? (dm.get(edge.to) ?? 0) : (dm.get(edge.from) ?? 0);
                    const hoverDepth = dm.get(hid) ?? 0;
                    const isDownward = touchesHover && otherDepth > hoverDepth;
                    ctx.globalAlpha = isDownward ? 0.35 : 0.03;
                } else if (hoverDistances) {
                    const fromIn = hoverDistances.has(edge.from);
                    const toIn = hoverDistances.has(edge.to);
                    ctx.globalAlpha = (fromIn && toIn) ? 0.5 : (settings.graphHoverDimOpacity || 0.1);
                } else if (focusTreeRoot && focusTreeRoot._treeEdgeIdx) {
                    // In Focus Tree: only show BFS tree edges, dim + thin by depth
                    if (!focusTreeRoot._treeEdgeIdx.has(edge._idx)) continue;
                    const dm = focusTreeRoot._depthMap;
                    const maxD = Math.max(dm.get(edge.from) ?? 0, dm.get(edge.to) ?? 0);
                    if (maxD === 0)      { ctx.globalAlpha = 0.25; ctx.lineWidth = 3; }
                    else if (maxD === 1) { ctx.globalAlpha = 0.12; ctx.lineWidth = 2; }
                    else                 { ctx.globalAlpha = 0.03; ctx.lineWidth = 1; }
                } else if (fromFiltered && toFiltered) {
                    ctx.globalAlpha = 0.06;
                } else if (fromFiltered || toFiltered) {
                    ctx.globalAlpha = 0.12;
                } else if (colorMode === 'frequency') {
                    ctx.globalAlpha = 0.2 + freqAvg * 0.6; // 0.2–0.8
                } else {
                    ctx.globalAlpha = 0.4;
                }

                const a = toScreen(nodes[edge.from].x, nodes[edge.from].y);
                const b = toScreen(nodes[edge.to].x, nodes[edge.to].y);
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            }
        }
        ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.lineWidth = 1;

        // Draw nodes — rendered AFTER edges so they appear on top
        // First pass: opaque background circles to mask edges underneath
        const bgColor = computedStyle.getPropertyValue('--dle-bg-surface').trim() || '#1a1a2e';
        for (const n of nodes) {
            if (n.hidden) continue;
            const s = toScreen(n.x, n.y);
            const r = getNodeRadius(n);
            ctx.globalAlpha = 1;
            ctx.fillStyle = bgColor;
            ctx.beginPath(); ctx.arc(s.x, s.y, (r + 1) * zoom, 0, Math.PI * 2); ctx.fill();
        }

        // Second pass: colored node circles
        for (const n of nodes) {
            if (n.hidden) continue;
            if (hoverDistances && focusTreeRoot && focusTreeRoot._depthMap) {
                // Iso mode hover: keep depth-based dimming unchanged
                const nd = focusTreeRoot._depthMap.get(n.id) ?? 99;
                ctx.globalAlpha = nd === 0 ? 1.0 : nd === 1 ? 0.9 : 0.75;
            } else if (hoverDistances) {
                ctx.globalAlpha = hoverDistances.has(n.id) ? 1.0 : (settings.graphHoverDimOpacity || 0.1);
            } else if (focusTreeRoot && focusTreeRoot._depthMap) {
                // In Focus Tree: full alpha for all visible nodes, dim by depth
                const nd = focusTreeRoot._depthMap.get(n.id) ?? 99;
                ctx.globalAlpha = nd === 0 ? 1.0 : nd === 1 ? 0.9 : 0.75;
            } else if (n.filtered) {
                ctx.globalAlpha = 0.12;
            } else {
                ctx.globalAlpha = 1;
            }
            const s = toScreen(n.x, n.y);
            const r = getNodeRadius(n);
            ctx.fillStyle = getNodeColor(n);
            ctx.beginPath(); ctx.arc(s.x, s.y, r * zoom, 0, Math.PI * 2); ctx.fill();
            if (focusTreeRoot === n) {
                // Root node: double ring + gold highlight
                ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 3;
                ctx.beginPath(); ctx.arc(s.x, s.y, (r + 4) * zoom, 0, Math.PI * 2); ctx.stroke();
                ctx.lineWidth = 1;
            } else if (n.pinned && !n._treePinned) {
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(s.x, s.y, (r + 3) * zoom, 0, Math.PI * 2); ctx.stroke();
                ctx.lineWidth = 1;
            }
        }
        ctx.globalAlpha = 1;

        // Draw labels
        if (showLabels) {
            ctx.font = `${Math.max(9, 11 * zoom)}px monospace`; ctx.textAlign = 'center';
            for (const n of nodes) {
                if (n.hidden) continue;
                if (n.filtered && !focusTreeRoot) continue;
                if (hoverDistances && !focusTreeRoot && !hoverDistances.has(n.id)) continue;
                const s = toScreen(n.x, n.y);
                const isHub = (edgeCountByNode.get(n.id) || 0) >= 5;
                if (focusTreeRoot || n === hoverNode || zoom > 1.0 || nodes.length < 30 || isHub) {
                    if (focusTreeRoot) {
                        // Iso mode: dimmed by default, bright for root/hover/tree-neighbors only
                        const isHovered = n === hoverNode;
                        const treeEdgeSet = focusTreeRoot._depthMap?._treeEdges;
                        const isTreeNeighbor = isHovered ? false : (hoverNode && treeEdgeSet &&
                            treeEdgeSet.has(`${hoverNode.id}:${n.id}`) &&
                            (focusTreeRoot._depthMap.get(n.id) ?? 0) > (focusTreeRoot._depthMap.get(hoverNode.id) ?? 0));
                        const bright = isHovered || n === focusTreeRoot || isTreeNeighbor;
                        ctx.fillStyle = (isHovered || n === focusTreeRoot) ? '#fff' : isTreeNeighbor ? '#ccc' : '#888';
                        ctx.globalAlpha = bright ? 1.0 : 0.6;
                    } else {
                        // Normal mode: full bright always
                        ctx.fillStyle = '#ddd';
                        ctx.globalAlpha = 1;
                    }
                    ctx.fillText(n.title, s.x, s.y - 10 * zoom);
                }
            }

            // Zoomed hover label — readable even when zoomed out
            if (hoverNode && zoom < 0.8) {
                const hs = toScreen(hoverNode.x, hoverNode.y);
                const fontSize = Math.max(13, 14);
                ctx.save();
                ctx.font = `bold ${fontSize}px monospace`;
                ctx.textAlign = 'center';
                ctx.fillStyle = '#fff';
                ctx.globalAlpha = 1;
                // Background pill for readability
                const textW = ctx.measureText(hoverNode.title).width;
                const pad = 4;
                ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
                ctx.fillRect(hs.x - textW / 2 - pad, hs.y - 24 - fontSize + 2, textW + pad * 2, fontSize + pad);
                ctx.fillStyle = '#fff';
                ctx.fillText(hoverNode.title, hs.x, hs.y - 22);
                ctx.restore();
            }
        }
    }

    // ========================================================================
    // HTML tooltip (replaces canvas-drawn tooltip)
    // ========================================================================
    const tooltipEl = document.getElementById('dle_graph_tooltip');

    function updateTooltip() {
        if (!tooltipEl) return;
        if (!hoverNode || hoverNode.hidden) {
            tooltipEl.style.display = 'none';
            return;
        }
        const s = toScreen(hoverNode.x, hoverNode.y);
        const entry = vaultIndex[hoverNode.id];
        const connections = edgeCountByNode.get(hoverNode.id) || 0;
        const injections = injectionCounts.get(hoverNode.id) || 0;
        const vaultLabel = multiVault && hoverNode.vaultSource ? `<span class="dle-dimmed">[${hoverNode.vaultSource}]</span>` : '';
        const typeBadge = `<span class="dle-graph-tooltip-badge dle-graph-tooltip-badge--${hoverNode.type}">${hoverNode.type}</span>`;

        let healthBadge = '';
        if (lastHealthResult) {
            const issues = (lastHealthResult.issues || []).filter(i => i.entry === hoverNode.title);
            if (issues.length > 0) {
                const worst = issues.some(i => i.severity === 'error') ? 'error' : 'warning';
                healthBadge = `<span class="dle-graph-tooltip-badge dle-graph-tooltip-badge--${worst}">${issues.length} issue${issues.length > 1 ? 's' : ''}</span>`;
            }
        }

        const pinnedLabel = hoverNode.pinned ? '<span class="dle-graph-tooltip-badge dle-graph-tooltip-badge--pinned">pinned</span>' : '';
        const gatingFields = [];
        if (entry.era) gatingFields.push(`era: ${entry.era}`);
        if (entry.location) gatingFields.push(`loc: ${entry.location}`);
        if (entry.sceneType) gatingFields.push(`scene: ${entry.sceneType}`);
        const gatingLine = gatingFields.length > 0 ? `<div class="dle-graph-tooltip-gating">${gatingFields.join(' · ')}</div>` : '';

        tooltipEl.innerHTML = `
            <div class="dle-graph-tooltip-header">
                <strong>${hoverNode.title}</strong> ${vaultLabel}
            </div>
            <div class="dle-graph-tooltip-badges">${typeBadge}${healthBadge}${pinnedLabel}</div>
            <div class="dle-graph-tooltip-stats">
                ~${hoverNode.tokens} tok · pri ${entry.priority} · ${connections} conn · ${injections} inj
            </div>
            ${gatingLine}
        `;

        // Position tooltip near node, clamped to canvas
        const tipW = 260;
        const tipH = tooltipEl.offsetHeight || 80;
        let tx = s.x - tipW / 2;
        let ty = s.y + 20 * zoom;
        // Clamp horizontally
        tx = Math.max(2, Math.min(W - tipW - 2, tx));
        // Flip above if too close to bottom
        if (ty + tipH > H - 4) ty = s.y - 20 * zoom - tipH;
        tooltipEl.style.left = `${tx}px`;
        tooltipEl.style.top = `${ty}px`;
        tooltipEl.style.display = 'block';
    }

    // ========================================================================
    // Context menu
    // ========================================================================
    const contextMenuEl = document.getElementById('dle_graph_context_menu');
    let contextMenuNode = null;
    let tempPinnedNode = null; // Node temporarily pinned during drag→right-click flow

    function showContextMenu(node, screenX, screenY) {
        if (!contextMenuEl) return;
        contextMenuNode = node;
        const entry = vaultIndex[node.id];
        const connections = edgeCountByNode.get(node.id) || 0;
        // Temp-pinned nodes should still show "Pin Node" since the user hasn't committed yet
        const isPermanentlyPinned = node.pinned && tempPinnedNode !== node;
        const pinLabel = isPermanentlyPinned ? 'Unpin Node' : 'Pin Node';

        // Build Obsidian URI if we have a vault name
        const vault = getVaultByName(settings, entry.vaultSource || '');
        const obsidianUri = vault ? buildObsidianURI(vault.name, entry.filename) : null;
        const obsidianItem = obsidianUri
            ? `<div class="dle-graph-ctx-item" data-action="obsidian">Open in Obsidian</div>`
            : '';

        contextMenuEl.innerHTML = `
            <div class="dle-graph-ctx-header">${node.title}</div>
            <div class="dle-graph-ctx-item" data-action="pin">${pinLabel}</div>
            ${obsidianItem}
            <div class="dle-graph-ctx-item" data-action="focus-tree">Focus Tree</div>
            <div class="dle-graph-ctx-item" data-action="details">Show Details</div>
            <div class="dle-graph-ctx-sep"></div>
            <div class="dle-graph-ctx-item dle-dimmed">${connections} connection(s) · ~${node.tokens} tokens</div>
        `;

        // Position within canvas bounds
        let tx = screenX;
        let ty = screenY;
        const menuW = 180;
        const menuH = contextMenuEl.offsetHeight || 120;
        if (tx + menuW > W) tx = W - menuW - 4;
        if (ty + menuH > H) ty = H - menuH - 4;
        tx = Math.max(2, tx);
        ty = Math.max(2, ty);
        contextMenuEl.style.left = `${tx}px`;
        contextMenuEl.style.top = `${ty}px`;
        contextMenuEl.style.display = 'block';

        // Wire up click handlers
        contextMenuEl.querySelectorAll('.dle-graph-ctx-item[data-action]').forEach(el => {
            el.addEventListener('click', () => {
                const action = el.dataset.action;
                dbg(`Context menu click: action="${action}", contextMenuNode="${contextMenuNode?.title}", tempPinned="${tempPinnedNode?.title || 'none'}"`);
                handleContextAction(action, contextMenuNode);
                hideContextMenu();
            }, { once: true });
        });
    }

    function hideContextMenu() {
        if (contextMenuEl) contextMenuEl.style.display = 'none';
        // Unpin temp-pinned node if menu dismissed without explicit pin action
        if (tempPinnedNode) {
            tempPinnedNode.pinned = false;
            dbg(`Unpin temp-pinned "${tempPinnedNode.title}" — menu dismissed without pin action`);
            tempPinnedNode = null;
            needsDraw = true;
        }
        contextMenuNode = null;
    }

    function handleContextAction(action, node) {
        if (!node) return;
        dbg(`Context action: ${action} on "${node.title}" (id=${node.id})`);
        const entry = vaultIndex[node.id];
        switch (action) {
            case 'pin':
                if (tempPinnedNode === node) {
                    // User explicitly chose "Pin Node" on a temp-pinned node → make it permanent
                    tempPinnedNode = null; // Clear so hideContextMenu() doesn't undo it
                    node.pinned = true; // Already true from temp-pin, but be explicit
                    dbg(`Node "${node.title}" permanently pinned (was temp-pinned)`);
                } else {
                    node.pinned = !node.pinned;
                    dbg(`Node "${node.title}" ${node.pinned ? 'pinned' : 'unpinned'}`);
                }
                node.vx = 0; node.vy = 0;
                needsDraw = true;
                break;
            case 'obsidian': {
                const vault = getVaultByName(settings, entry.vaultSource || '');
                const uri = vault ? buildObsidianURI(vault.name, entry.filename) : null;
                dbg(`Open in Obsidian: vault=${vault?.name || 'NONE'}, uri=${uri || 'NULL'}`);
                if (uri) window.open(uri, '_blank');
                else dbg('WARNING: No vault found for entry, cannot build Obsidian URI');
                break;
            }
            case 'focus-tree': {
                enterFocusTree(node);
                break;
            }
            case 'details': {
                // Show entry details in a toastr for now (Phase 3 will add side panel)
                const connections = edgeCountByNode.get(node.id) || 0;
                const inj = injectionCounts.get(node.id) || 0;
                const tags = (entry.tags || []).join(', ') || 'none';
                const links = entry.resolvedLinks.length;
                const reqs = entry.requires.length;
                const excl = entry.excludes.length;
                const details = [
                    `<strong>${node.title}</strong>`,
                    `Type: ${node.type} · Priority: ${entry.priority}`,
                    `Tokens: ~${node.tokens} · Connections: ${connections}`,
                    `Injections (this chat): ${inj}`,
                    `Links: ${links} · Requires: ${reqs} · Excludes: ${excl}`,
                    `Tags: ${tags}`,
                ];
                if (entry.era) details.push(`Era: ${entry.era}`);
                if (entry.location) details.push(`Location: ${entry.location}`);
                if (entry.summary) details.push(`<em>${entry.summary.substring(0, 120)}${entry.summary.length > 120 ? '...' : ''}</em>`);
                toastr.info(details.join('<br>'), 'Entry Details', { timeOut: 15000, closeButton: true, escapeHtml: false });
                break;
            }
        }
    }

    // ========================================================================
    // Export functions
    // ========================================================================
    function exportPNG() {
        dbg('Exporting PNG...');
        try {
            const dataUrl = canvas.toDataURL('image/png');
            const link = document.createElement('a');
            link.download = `dle-graph-${new Date().toISOString().slice(0, 10)}.png`;
            link.href = dataUrl;
            link.click();
            toastr.success('Graph exported as PNG', 'DeepLore Enhanced');
        } catch (e) {
            toastr.error('Failed to export PNG: ' + e.message, 'DeepLore Enhanced');
        }
    }

    function exportJSON() {
        dbg('Exporting JSON...');
        let objectUrl = null;
        try {
            const data = {
                exportedAt: new Date().toISOString(),
                nodes: nodes.map(n => ({
                    title: n.title, type: n.type, tokens: n.tokens,
                    priority: n.priority, vaultSource: n.vaultSource,
                    connections: edgeCountByNode.get(n.id) || 0,
                    injections: injectionCounts.get(n.id) || 0,
                    pinned: !!n.pinned,
                })),
                edges: edges.map(e => ({
                    from: nodes[e.from].title,
                    to: nodes[e.to].title,
                    type: e.type,
                })),
                stats: {
                    totalNodes: nodes.length, totalEdges: edges.length,
                    circularPairs: circularPairs.length,
                    typeCounts,
                },
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.download = `dle-graph-${new Date().toISOString().slice(0, 10)}.json`;
            objectUrl = URL.createObjectURL(blob);
            link.href = objectUrl;
            link.click();
            dbg(`JSON exported: ${data.nodes.length} nodes, ${data.edges.length} edges`);
            toastr.success('Graph exported as JSON', 'DeepLore Enhanced');
        } catch (e) {
            dbg('JSON export failed:', e.message);
            toastr.error('Failed to export JSON: ' + e.message, 'DeepLore Enhanced');
        } finally {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        }
    }

    // ========================================================================
    // Animation loop
    // ========================================================================
    let animationFrameId = null;
    function tick() {
        if (!isRunning) return;
        if (!document.getElementById('dle_graph_canvas')) {
            isRunning = false;
            if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
            return;
        }
        simulate();

        const hoverChanged = hoverNode !== prevHoverNode;
        prevHoverNode = hoverNode;
        if (hasSpringEnergy || maxDelta > 0.01 || alpha > 0.001 || dragNode || hoverChanged || needsDraw) {
            draw();
            if (hoverChanged) updateTooltip();
            needsDraw = false;
        }

        animationFrameId = requestAnimationFrame(tick);
    }

    // ========================================================================
    // Cleanup on popup close
    // ========================================================================
    const listenerAC = new AbortController();
    const popupContainer = canvas.closest('.popup') || container.parentElement;
    let cleanupTimer = null;
    const observer = new MutationObserver(() => {
        // Use isConnected on our stored canvas reference — more reliable than getElementById
        if (!canvas.isConnected) {
            dbg('Canvas removed from DOM — cleaning up graph (stopping animation, aborting listeners)');
            isRunning = false;
            if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
            listenerAC.abort();
            observer.disconnect();
        }
    });
    if (popupContainer) {
        observer.observe(popupContainer, { childList: true, subtree: true });
    }

    // ========================================================================
    // Event handlers
    // ========================================================================
    let cachedVisibleCount = nodes.length;
    function hitRadius() {
        // In tree mode: use half the node spacing (divided by zoom to convert to world units)
        if (focusTreeRoot) return 20 / zoom;
        // Normal mode: scale to canvas size and node count
        const baseRadius = Math.max(W, H) / (Math.sqrt(cachedVisibleCount) * 1.5);
        return Math.max(15, Math.min(50, baseRadius / zoom));
    }

    const lOpt = { signal: listenerAC.signal };

    // -- Canvas mouse events --
    // Refresh cachedRect on interaction to handle popup repositioning
    function freshRect() { cachedRect = canvas.getBoundingClientRect(); return cachedRect; }

    canvas.addEventListener('mousedown', (e) => {
        // Only handle left-click (button 0) — right-click is handled by contextmenu
        if (e.button !== 0) return;
        hideContextMenu();
        const rect = freshRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const w = toWorld(mx, my);
        const closest = findNearest(nodes, w.x, w.y, hitRadius(), 'mousedown', !!focusTreeRoot);
        if (closest) {
            dragNode = closest;
            // Don't pump alpha on grab — the network shouldn't react until drop
            canvas.style.cursor = 'grabbing';
            dbg(`mousedown: grabbed "${closest.title}"`);
        } else {
            isPanning = true;
            panStartX = mx; panStartY = my;
            panOriginX = panX; panOriginY = panY;
            canvas.style.cursor = 'grabbing';
        }
    }, lOpt);

    canvas.addEventListener('mouseenter', () => { cachedRect = canvas.getBoundingClientRect(); }, lOpt);
    canvas.addEventListener('mousemove', (e) => {
        const mx = e.clientX - cachedRect.left, my = e.clientY - cachedRect.top;
        debugMouseX = mx; debugMouseY = my; if (focusTreeRoot) needsDraw = true;
        if (dragNode) {
            const w = toWorld(mx, my);
            dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0;
            // Don't pump alpha during drag — just move the node visually, no physics ripple
            needsDraw = true;
        } else if (isPanning) {
            panX = panOriginX + (mx - panStartX);
            panY = panOriginY + (my - panStartY);
            needsDraw = true;
        } else {
            const w = toWorld(mx, my);
            const closest = findNearest(nodes, w.x, w.y, hitRadius(), undefined, !!focusTreeRoot);
            if (closest !== hoverNode) {
                hoverNode = closest;
                hoverDistances = closest ? computeHoverDistances(closest.id) : null;
                needsDraw = true;
                updateTooltip();
            }
            canvas.style.cursor = closest ? 'pointer' : 'grab';
        }
    }, lOpt);

    canvas.addEventListener('mouseup', (e) => {
        // Only handle left-click release
        if (e.button !== 0) return;
        if (dragNode) {
            dbg(`mouseup: released "${dragNode.title}"`);
            dragNode = null;
            // Gentle nudge — just enough for neighbors to adjust, not enough to reconverge the whole graph
            alpha = Math.max(alpha, 0.05);
        }
        isPanning = false;
        canvas.style.cursor = 'grab';
    }, lOpt);

    // -- Double-click: Focus Tree --
    canvas.addEventListener('dblclick', (e) => {
        const rect = freshRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const w = toWorld(mx, my);
        const closest = findNearest(nodes, w.x, w.y, hitRadius(), 'dblclick', !!focusTreeRoot);
        if (closest) {
            // If already in focus tree, exit first then re-enter with new root
            if (focusTreeRoot) {
                dbg(`dblclick: re-rooting Focus Tree from "${focusTreeRoot.title}" to "${closest.title}"`);
                // Quick exit without scatter — we'll immediately re-layout
                for (const n of nodes) {
                    if (n._treePinned) { n.pinned = false; n._treePinned = false; }
                    n.hidden = false;
                }
                if (focusTreeRoot._depthMap) delete focusTreeRoot._depthMap;
                focusTreeRoot.pinned = false;
                focusTreeRoot = null;
                focusTreePhysics = false;
            } else {
                dbg(`dblclick: entering Focus Tree on "${closest.title}"`);
            }
            enterFocusTree(closest);
        }
    }, lOpt);

    canvas.addEventListener('mouseleave', () => {
        if (!dragNode && !isPanning) {
            hoverNode = null;
            hoverDistances = null;
            needsDraw = true;
            updateTooltip();
        }
    }, lOpt);

    // -- Right-click context menu --
    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        // If dragging a node, temporarily pin it so it stays put while the context menu is open
        if (dragNode) {
            const pinTarget = dragNode;
            pinTarget.vx = 0; pinTarget.vy = 0;
            if (!pinTarget.pinned) {
                pinTarget.pinned = true;
                tempPinnedNode = pinTarget; // Track so we can unpin if menu dismissed
                dbg(`Temp-pinned "${pinTarget.title}" during drag→right-click`);
            }
            dragNode = null;
            isPanning = false;
            const r2 = freshRect();
            showContextMenu(pinTarget, e.clientX - r2.left, e.clientY - r2.top);
            return;
        }
        const rect = freshRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const w = toWorld(mx, my);
        const closest = findNearest(nodes, w.x, w.y, hitRadius(), 'contextmenu', !!focusTreeRoot);
        if (closest) {
            showContextMenu(closest, mx, my);
        } else {
            hideContextMenu();
        }
    }, lOpt);

    // Close context menu on click outside
    document.addEventListener('click', (e) => {
        if (contextMenuEl && !contextMenuEl.contains(e.target)) {
            dbg(`Document click outside context menu, hiding. target=${e.target.tagName}.${e.target.className}, tempPinned="${tempPinnedNode?.title || 'none'}"`);
            hideContextMenu();
        }
    }, lOpt);

    // -- Zoom --
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        hideContextMenu();
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        const rect = freshRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        panX = mx - (mx - panX) * zoomFactor;
        panY = my - (my - panY) * zoomFactor;
        zoom *= zoomFactor;
        zoom = Math.max(0.2, Math.min(5, zoom));
        needsDraw = true;
    }, { passive: false, signal: listenerAC.signal });

    // -- Keyboard shortcuts --
    document.addEventListener('keydown', (e) => {
        // Only handle if graph popup is open
        if (!document.getElementById('dle_graph_canvas')) return;
        // Don't capture if user is typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

        switch (e.key) {
            case '0':
                dbg('Keyboard: fit to view');
                fitToView();
                break;
            case 'Escape':
                dbg('Keyboard: Escape — resetting focus tree / isolation and context menu');
                if (focusTreeRoot) {
                    exitFocusTree();
                } else {
                    for (const n of nodes) {
                        if (n.hidden) { n.vx = 0; n.vy = 0; }
                        n.hidden = false;
                    }
                }
                hideContextMenu();
                needsDraw = true;
                break;
        }
    }, lOpt);

    // -- Resize handler --
    window.addEventListener('resize', () => {
        cachedRect = canvas.getBoundingClientRect();
        needsDraw = true;
    }, lOpt);

    // ========================================================================
    // Toolbar event wiring
    // ========================================================================
    const searchEl = document.getElementById('dle_graph_search');
    const typeFilterEl = document.getElementById('dle_graph_type_filter');
    const tagFilterEl = document.getElementById('dle_graph_tag_filter');
    const colorModeEl = document.getElementById('dle_graph_color_mode');
    const fitBtn = document.getElementById('dle_graph_fit');
    const exportPngBtn = document.getElementById('dle_graph_export_png');
    const exportJsonBtn = document.getElementById('dle_graph_export_json');

    if (searchEl) {
        searchEl.addEventListener('input', () => {
            searchQuery = searchEl.value;
            applyFilters();
        }, lOpt);
    }
    if (typeFilterEl) {
        typeFilterEl.addEventListener('change', () => {
            typeFilter = typeFilterEl.value;
            applyFilters();
        }, lOpt);
    }
    if (tagFilterEl) {
        tagFilterEl.addEventListener('change', () => {
            tagFilter = tagFilterEl.value;
            applyFilters();
        }, lOpt);
    }
    if (colorModeEl) {
        colorModeEl.value = colorMode; // Sync dropdown to settings default
        colorModeEl.addEventListener('change', () => {
            colorMode = colorModeEl.value;
            dbg(`Color mode changed to: ${colorMode}`);
            needsDraw = true;
        }, lOpt);
    }
    const backBtn = document.getElementById('dle_graph_back');
    if (backBtn) {
        backBtn.addEventListener('click', () => exitFocusTree(), lOpt);
    }
    if (fitBtn) {
        fitBtn.addEventListener('click', () => fitToView(), lOpt);
    }
    if (exportPngBtn) {
        exportPngBtn.addEventListener('click', () => exportPNG(), lOpt);
    }
    if (exportJsonBtn) {
        exportJsonBtn.addEventListener('click', () => exportJSON(), lOpt);
    }

    // ========================================================================
    // Interactive legend — click to toggle edge types
    // ========================================================================
    const legendEl = document.getElementById('dle_graph_legend');
    if (legendEl) {
        legendEl.querySelectorAll('.dle-graph-legend-item').forEach(item => {
            item.addEventListener('click', () => {
                const type = item.dataset.edgeType;
                if (!type) return;
                edgeVisibility[type] = !edgeVisibility[type];
                item.classList.toggle('dle-graph-legend-item--disabled', !edgeVisibility[type]);
                dbg(`Legend toggle: ${type} → ${edgeVisibility[type] ? 'visible' : 'hidden'}`);
                buildAdjacency(); // Rebuild so BFS hover-dim respects hidden edge types
                needsDraw = true;
            }, lOpt);
        });
    }

    // ========================================================================
    // Settings panel (draggable, inside graph popup)
    // ========================================================================
    const settingsPanel = document.getElementById('dle_graph_settings_panel');
    const settingsBtn = document.getElementById('dle_graph_settings_btn');
    const settingsCloseBtn = document.getElementById('dle_graph_settings_panel_close');

    // Helper: update a setting, persist, and refresh graph
    function updateSetting(key, value) {
        settings[key] = value;
        invalidateSettingsCache();
        saveSettingsDebounced();
        needsDraw = true;
    }

    // ── Normalized slider mapping ──
    // Each slider is -100..+100. 0 = default. Negative = below default, positive = above.
    // Maps define [min, default, max] for each setting.
    // Slider maps: min/def/max define the actual setting range.
    // power > 1 = gentle near 0, dramatic at extremes (quadratic feel).
    // power = 1 = linear.
    const sliderMaps = {
        dle_gs_repulsion:   { key: 'graphRepulsion',       min: -8000,  def: 2000, max: 80000, round: 0, power: 2 },   // negative = attraction
        dle_gs_spring:      { key: 'graphSpringLength',    min: 0,      def: 120,  max: 600,   round: 0, power: 1 },
        dle_gs_gravity:     { key: 'graphGravity',         min: -1.5,   def: 0.03, max: 1.5,   round: 4, power: 2 },   // negative = anti-gravity
        dle_gs_damping:     { key: 'graphDamping',         min: 0,      def: 0.7,  max: 0.999, round: 3, power: 2 },
        dle_gs_hover_dim:   { key: 'graphHoverDimDistance', min: 0,      def: 2,    max: 15,    round: 0, power: 1 },
        dle_gs_dim_opacity: { key: 'graphHoverDimOpacity',  min: 0,      def: 0.1,  max: 0.9,   round: 3, power: 1.5 },
        dle_gs_tree_depth:  { key: 'graphFocusTreeDepth',  min: 0,      def: 2,    max: 15,    round: 0, power: 1 },
    };

    /** Convert actual setting value → normalized slider position (-100..+100) */
    function actualToSlider(map, actual) {
        const p = map.power ?? 1;
        if (actual <= map.def) {
            const range = map.def - map.min;
            if (range === 0) return 0;
            const t = Math.pow(Math.max(0, (actual - map.min) / range), 1 / p);
            return Math.round((t - 1) * 100);
        }
        const range = map.max - map.def;
        if (range === 0) return 0;
        const t = Math.pow(Math.min(1, (actual - map.def) / range), 1 / p);
        return Math.round(t * 100);
    }

    /** Convert normalized slider position (-100..+100) → actual setting value */
    function sliderToActual(map, sliderVal) {
        const p = map.power ?? 1;
        let v;
        if (sliderVal <= 0) {
            const t = (sliderVal + 100) / 100; // -100→0, 0→1
            v = map.min + Math.pow(t, p) * (map.def - map.min);
        } else {
            const t = sliderVal / 100; // 0→0, 100→1
            v = map.def + Math.pow(t, p) * (map.max - map.def);
        }
        if (map.round === 0) return Math.round(v);
        const factor = Math.pow(10, map.round);
        return Math.round(v * factor) / factor;
    }

    /** Format slider value for display (normalized -100..+100) */
    function formatSlider(sliderVal) {
        return String(sliderVal);
    }

    // Physics sliders restart simulation on change
    const physicsKeys = new Set(['graphRepulsion', 'graphSpringLength', 'graphGravity', 'graphDamping']);

    if (settingsPanel && settingsBtn) {
        // Toggle panel visibility
        settingsBtn.addEventListener('click', () => {
            const visible = settingsPanel.style.display !== 'none';
            settingsPanel.style.display = visible ? 'none' : 'block';
            if (!visible) syncSettingsPanel();
        }, lOpt);

        if (settingsCloseBtn) {
            settingsCloseBtn.addEventListener('click', () => {
                settingsPanel.style.display = 'none';
            }, lOpt);
        }

        // Draggable titlebar
        const titlebar = document.getElementById('dle_graph_settings_titlebar');
        if (titlebar) {
            let dragPanelActive = false, dpStartX = 0, dpStartY = 0, dpOriginX = 0, dpOriginY = 0;
            titlebar.addEventListener('mousedown', (e) => {
                if (e.target.closest('.dle-graph-settings-close')) return;
                e.preventDefault();
                dragPanelActive = true;
                dpStartX = e.clientX; dpStartY = e.clientY;
                const panelRect = settingsPanel.getBoundingClientRect();
                const parentRect = settingsPanel.parentElement.getBoundingClientRect();
                dpOriginX = panelRect.left - parentRect.left;
                dpOriginY = panelRect.top - parentRect.top;
                settingsPanel.style.left = `${dpOriginX}px`;
                settingsPanel.style.right = 'auto';
            }, lOpt);
            document.addEventListener('mousemove', (e) => {
                if (!dragPanelActive) return;
                const dx = e.clientX - dpStartX, dy = e.clientY - dpStartY;
                settingsPanel.style.left = `${dpOriginX + dx}px`;
                settingsPanel.style.top = `${dpOriginY + dy}px`;
                settingsPanel.style.right = 'auto';
            }, lOpt);
            document.addEventListener('mouseup', () => { dragPanelActive = false; }, lOpt);
        }

        // Sync panel controls from current settings
        function syncSettingsPanel() {
            const gsColorMode = document.getElementById('dle_gs_color_mode');
            if (gsColorMode) gsColorMode.value = colorMode;

            const gsLabels = document.getElementById('dle_gs_labels');
            if (gsLabels) gsLabels.checked = showLabels;

            for (const [id, map] of Object.entries(sliderMaps)) {
                const el = document.getElementById(id);
                const valEl = document.getElementById(id + '_val');
                const actual = settings[map.key] ?? map.def;
                const sv = actualToSlider(map, actual);
                if (el) el.value = sv;
                if (valEl) valEl.textContent = formatSlider(sv);
            }
        }

        // Wire color mode
        const gsColorMode = document.getElementById('dle_gs_color_mode');
        if (gsColorMode) {
            gsColorMode.addEventListener('change', () => {
                colorMode = gsColorMode.value;
                updateSetting('graphDefaultColorMode', colorMode);
                if (colorModeEl) colorModeEl.value = colorMode;
            }, lOpt);
        }

        // Wire labels
        const gsLabels = document.getElementById('dle_gs_labels');
        if (gsLabels) {
            gsLabels.addEventListener('change', () => {
                showLabels = gsLabels.checked;
                updateSetting('graphShowLabels', showLabels);
            }, lOpt);
        }

        // Wire all normalized sliders
        for (const [id, map] of Object.entries(sliderMaps)) {
            const el = document.getElementById(id);
            const valEl = document.getElementById(id + '_val');
            if (!el) continue;
            el.addEventListener('input', () => {
                const sv = parseInt(el.value, 10);
                const actual = sliderToActual(map, sv);
                if (valEl) valEl.textContent = formatSlider(sv);
                updateSetting(map.key, actual);
                if (physicsKeys.has(map.key)) alpha = Math.max(alpha, 0.5);
            }, lOpt);
        }

        // Reset to defaults
        const resetBtn = document.getElementById('dle_gs_reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                for (const [, map] of Object.entries(sliderMaps)) {
                    updateSetting(map.key, map.def);
                }
                colorMode = 'type';
                updateSetting('graphDefaultColorMode', 'type');
                if (colorModeEl) colorModeEl.value = 'type';
                showLabels = true;
                updateSetting('graphShowLabels', true);
                alpha = Math.max(alpha, 0.5);
                syncSettingsPanel();
                dbg('Settings reset to defaults');
            }, lOpt);
        }
    }

    // Sync toolbar color mode → settings panel color mode
    if (colorModeEl) {
        colorModeEl.addEventListener('change', () => {
            const gsColorMode = document.getElementById('dle_gs_color_mode');
            if (gsColorMode) gsColorMode.value = colorMode;
        }, lOpt);
    }

    // ========================================================================
    // Start
    // ========================================================================
    tick();
}
