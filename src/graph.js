/**
 * DeepLore Enhanced — Graph visualization orchestrator.
 * Builds node/edge data, creates popup DOM, initializes sub-modules,
 * runs the animation loop. Sub-modules handle physics, rendering,
 * events, settings, and focus tree.
 */
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { NO_ENTRIES_MSG } from '../core/utils.js';
import { getSettings } from '../settings.js';
import { vaultIndex, chatInjectionCounts, trackerKey, mentionWeights } from './state.js';
import { ensureIndexFresh } from './vault.js';

import { initPhysics } from './graph-physics.js';
import { initRender } from './graph-render.js';
import { initFocus } from './graph-focus.js';
import { initEvents } from './graph-events.js';
import { initGraphSettings } from './graph-settings.js';
import { computeDisparityFilter, computeLouvainCommunities, updateCommunityCentroids, convexHull, COMMUNITY_PALETTE, computeGapAnalysis } from './graph-analysis.js';

// ============================================================================
// Debug logging
// ============================================================================
const TAG = '[DLE Graph]';
function dbg(...args) {
    const s = getSettings();
    if (s?.debugMode) console.debug(TAG, ...args);
}

// ============================================================================
// Main entry point
// ============================================================================

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
        x: 0, y: 0, vx: 0, vy: 0,
        hidden: false,
        filtered: false,
        cluster: 0,
        _revealScale: 0,
    }));

    // Detect title collisions (case-insensitive)
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

    // Deduplicate edges
    const edgeSet = new Set();
    const edges = [];
    function addEdge(from, to, type) {
        const key = `${Math.min(from, to)},${Math.max(from, to)},${type}`;
        if (!edgeSet.has(key)) {
            edgeSet.add(key);
            const srcTitle = vaultIndex[from]?.title || '';
            const tgtTitle = vaultIndex[to]?.title || '';
            const mw = (mentionWeights.get(`${srcTitle}\0${tgtTitle}`) || 0)
                      + (mentionWeights.get(`${tgtTitle}\0${srcTitle}`) || 0);
            edges.push({ from, to, type, _idx: edges.length, weight: Math.max(1, mw), _revealAlpha: 0 });
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

    // Detect circular requires
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

    // Count edges per node pair (ignoring type)
    const pairEdgeCount = new Map();
    for (const e of edges) {
        const key = `${Math.min(e.from, e.to)},${Math.max(e.from, e.to)}`;
        pairEdgeCount.set(key, (pairEdgeCount.get(key) || 0) + 1);
    }
    const multiEdgePairs = [...pairEdgeCount.entries()].filter(([, c]) => c > 1);
    console.warn(`[DLE Graph] Edge pairs: ${pairEdgeCount.size} unique pairs, ${multiEdgePairs.length} with multiple edge types`);
    if (multiEdgePairs.length > 0) {
        console.warn(`[DLE Graph] Multi-edge pairs (top 10):`, multiEdgePairs.slice(0, 10).map(([k, c]) => {
            const [a, b] = k.split(',').map(Number);
            return `${nodes[a].title} ↔ ${nodes[b].title}: ${c} edges`;
        }));
    }
    const edgeCountDist = new Map();
    for (const [, c] of pairEdgeCount) edgeCountDist.set(c, (edgeCountDist.get(c) || 0) + 1);
    console.warn(`[DLE Graph] Edge count distribution:`, Object.fromEntries([...edgeCountDist.entries()].sort()));

    dbg(`Built ${edges.length} edges (${edgeSet.size} unique), ${circularPairs.length} circular pairs`);
    const edgeTypeCounts = { link: 0, requires: 0, excludes: 0, cascade: 0 };
    for (const e of edges) edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] || 0) + 1;
    dbg(`Edge breakdown: link=${edgeTypeCounts.link}, requires=${edgeTypeCounts.requires}, excludes=${edgeTypeCounts.excludes}, cascade=${edgeTypeCounts.cascade}`);

    // Edge visibility state
    const edgeVisibility = { link: true, requires: true, excludes: true, cascade: true };

    // Build adjacency for hover-dim BFS
    let adjacency = new Map();
    function buildAdjacency() {
        adjacency = new Map();
        for (const n of nodes) adjacency.set(n.id, []);
        for (const edge of edges) {
            if (!edgeVisibility[edge.type]) continue;
            adjacency.get(edge.from).push(edge.to);
            adjacency.get(edge.to).push(edge.from);
        }
        dbg('Adjacency rebuilt, visible edge types:', Object.entries(edgeVisibility).filter(([, v]) => v).map(([k]) => k).join(', '));
    }
    buildAdjacency();

    // ========================================================================
    // Precompute data for coloring modes
    // ========================================================================
    const edgeCountByNode = new Map();
    for (const edge of edges) {
        edgeCountByNode.set(edge.from, (edgeCountByNode.get(edge.from) || 0) + 1);
        edgeCountByNode.set(edge.to, (edgeCountByNode.get(edge.to) || 0) + 1);
    }
    const maxEdgeCount = Math.max(1, ...edgeCountByNode.values());

    const nodeDegree = new Float64Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
        nodeDegree[i] = edgeCountByNode.get(i) || 0;
    }
    dbg(`ForceAtlas2 model: ${nodes.length} nodes, ${edges.length} edges`);

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
                <option value="community">Color: Community</option>
            </select>
            <span class="dle-graph-toolbar-sep"></span>
            <button id="dle_graph_settings_btn" class="menu_button" title="Graph settings" style="height: 28px; padding: 2px 8px; font-size: 12px;"><i class="fa-solid fa-gear"></i></button>
        </div>
        <div class="dle-graph-toolbar" style="gap: 4px; padding: 2px 6px; flex-wrap: nowrap;">
            <button id="dle_graph_back" class="menu_button" title="Exit Focus Tree (Esc)" style="height: 28px; padding: 2px 8px; font-size: 12px; display: none; white-space: nowrap; max-width: 300px; overflow: hidden; text-overflow: ellipsis;">← Back</button>
            <button id="dle_graph_hop_minus" class="menu_button" title="Decrease hop depth" style="height: 28px; padding: 2px 6px; font-size: 12px; display: none; white-space: nowrap;">−</button>
            <button id="dle_graph_hop_plus" class="menu_button" title="Increase hop depth" style="height: 28px; padding: 2px 6px; font-size: 12px; display: none; white-space: nowrap;">+</button>
            <button id="dle_graph_fit" class="menu_button" title="Fit to view (0)" style="height: 28px; padding: 2px 8px; font-size: 12px;">Fit</button>
            <button id="dle_graph_unpin_all" class="menu_button" title="Unpin all nodes" style="height: 28px; padding: 2px 8px; font-size: 12px; white-space: nowrap;">Unpin All</button>
            <button id="dle_graph_reset" class="menu_button" title="Reset simulation — re-randomize positions and restart physics" style="height: 28px; padding: 2px 8px; font-size: 12px;">Reset</button>
            <span class="dle-graph-toolbar-sep"></span>
            <button id="dle_graph_export_png" class="menu_button" title="Export as PNG" style="height: 28px; padding: 2px 8px; font-size: 12px;">PNG</button>
            <button id="dle_graph_export_json" class="menu_button" title="Export as JSON" style="height: 28px; padding: 2px 8px; font-size: 12px;">JSON</button>
            <span class="dle-graph-toolbar-sep"></span>
            <button id="dle_graph_analyze" class="menu_button" title="Toggle gap analysis overlay — highlights orphans, weak bridges, and missing connections" style="height: 28px; padding: 2px 8px; font-size: 12px;"><i class="fa-solid fa-magnifying-glass-chart"></i> Analyze</button>
        </div>
        <div class="dle-graph-legend" id="dle_graph_legend">
            <span class="dle-graph-legend-item" data-edge-type="link"><span style="color: #aac8ff;">—</span> Link</span>
            <span class="dle-graph-legend-item" data-edge-type="requires"><span class="dle-success">—</span> Requires</span>
            <span class="dle-graph-legend-item" data-edge-type="excludes"><span class="dle-error">—</span> Excludes</span>
            <span class="dle-graph-legend-item" data-edge-type="cascade"><span class="dle-warning">—</span> Cascade</span>
        </div>
        <div style="position: relative; flex: 1; min-height: 0;">
            <canvas id="dle_graph_canvas" width="900" height="550" style="border: 1px solid var(--dle-border); border-radius: 4px; cursor: grab; width: 100%; height: 100%; min-height: 200px; background: var(--dle-bg-surface);" aria-label="Force-directed graph showing ${nodes.length} vault entries and ${edges.length} relationships between them."></canvas>
            <div id="dle_graph_tooltip" class="dle-graph-tooltip"></div>
            <div id="dle_graph_context_menu" class="dle-graph-context-menu" style="display: none;"></div>
            <div id="dle_graph_settings_panel" class="dle-graph-settings-panel" style="display: none;">
                <div class="dle-graph-settings-titlebar" id="dle_graph_settings_titlebar">
                    <span><i class="fa-solid fa-gear"></i> Graph Settings</span>
                    <span class="dle-graph-settings-close" id="dle_graph_settings_panel_close">&times;</span>
                </div>
                <div class="dle-graph-settings-body">
                    <div class="dle-graph-settings-row" style="gap: 4px;">
                        <button class="menu_button dle-gs-preset" data-preset="compact" style="flex:1;height:22px;font-size:9px;">Compact</button>
                        <button class="menu_button dle-gs-preset" data-preset="balanced" style="flex:1;height:22px;font-size:9px;">Balanced</button>
                        <button class="menu_button dle-gs-preset" data-preset="spacious" style="flex:1;height:22px;font-size:9px;">Spacious</button>
                        <button class="menu_button dle-gs-preset" data-preset="ginormous" style="flex:1;height:22px;font-size:9px;">Ginormous</button>
                    </div>
                    <div class="dle-graph-settings-sep"></div>
                    <div class="dle-graph-settings-section-label">Layout</div>
                    <div class="dle-graph-settings-row">
                        <label title="How far apart unconnected nodes push each other">Node Spacing</label>
                        <input type="range" id="dle_gs_repulsion" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_repulsion_val"></span>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label title="Target distance between connected nodes">Link Distance</label>
                        <input type="range" id="dle_gs_spring" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_spring_val"></span>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label title="How strongly nodes pull toward the center">Centering</label>
                        <input type="range" id="dle_gs_gravity" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_gravity_val"></span>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label title="How quickly movement settles (higher = calmer)">Stability</label>
                        <input type="range" id="dle_gs_damping" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_damping_val"></span>
                    </div>
                    <div class="dle-graph-settings-sep"></div>
                    <div class="dle-graph-settings-section-label">Display</div>
                    <div class="dle-graph-settings-row">
                        <label>Color By</label>
                        <select id="dle_gs_color_mode" class="text_pole" style="height: 22px; font-size: 10px; width: 100px;">
                            <option value="type">Type</option>
                            <option value="priority">Priority</option>
                            <option value="centrality">Connections</option>
                            <option value="frequency">Frequency</option>
                            <option value="community">Community</option>
                        </select>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label>Show Labels</label>
                        <input type="checkbox" id="dle_gs_labels" />
                    </div>
                    <div class="dle-graph-settings-sep"></div>
                    <div class="dle-graph-settings-section-label">Interaction</div>
                    <div class="dle-graph-settings-row">
                        <label title="How many hops from hovered node stay vivid">Hover Reach</label>
                        <input type="range" id="dle_gs_hover_dim" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_hover_dim_val"></span>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label title="Opacity of dimmed nodes/edges on hover">Dim Opacity</label>
                        <input type="range" id="dle_gs_dim_opacity" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_dim_opacity_val"></span>
                    </div>
                    <div class="dle-graph-settings-row">
                        <label title="How many hops to show in Focus Tree mode">Focus Depth</label>
                        <input type="range" id="dle_gs_tree_depth" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_tree_depth_val"></span>
                    </div>
                    <div class="dle-graph-settings-sep"></div>
                    <div class="dle-graph-settings-section-label">Filtering</div>
                    <div class="dle-graph-settings-row">
                        <label title="Edge backbone filter — lower = sparser, showing only the most significant edges">Edge Filter</label>
                        <input type="range" id="dle_gs_edge_filter" min="-100" max="100" step="1" />
                        <span class="dle-gs-value" id="dle_gs_edge_filter_val"></span>
                    </div>
                    <div class="dle-graph-settings-row" style="justify-content: center;">
                        <small id="dle_gs_edge_count" class="dle-dimmed" style="font-size: 9px;"></small>
                    </div>
                    <div class="dle-graph-settings-sep"></div>
                    <button id="dle_gs_reset" class="menu_button" style="width: 100%; height: 24px; font-size: 10px; margin-top: 2px;">Reset to Defaults</button>
                </div>
            </div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
            <small class="dle-dimmed">Drag to move · Right-click for menu · Scroll to zoom · Click+drag to pan · Double-click to focus · 0 to fit · Esc to exit focus</small>
            <details class="dle-text-sm" style="margin: 0;">
                <summary style="cursor: pointer; font-size: 11px;">Screen reader summary</summary>
                <div style="max-height: 100px; overflow-y: auto; font-size: 11px;">${summaryHtml}</div>
            </details>
        </div>
    `;

    callGenericPopup(container, POPUP_TYPE.DISPLAY, '', { wide: true, large: true, allowVerticalScrolling: false });

    // Poll for canvas with layout wait
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

    // Cache rect, initialize canvas
    let cachedRect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cachedRect.width * dpr;
    canvas.height = cachedRect.height * dpr;
    ctx.scale(dpr, dpr);
    const W = cachedRect.width;
    const H = cachedRect.height;
    dbg(`Canvas initialized: ${W}x${H} CSS px, DPR=${dpr}, buffer=${canvas.width}x${canvas.height}`);

    // ========================================================================
    // Initial node positions (Weighted BFS + progressive reveal)
    // ========================================================================
    const springLen = settings.graphSpringLength || 80;

    const disconnected = nodes.filter(n => (edgeCountByNode.get(n.id) || 0) === 0);
    const orphanCols = Math.ceil(Math.sqrt(disconnected.length));
    const orphanSpacing = 35;
    const orphanOriginX = W * 0.3 - orphanCols * orphanSpacing * 0.5;
    const orphanOriginY = H * 0.3 - Math.ceil(disconnected.length / orphanCols) * orphanSpacing * 0.5;
    for (let i = 0; i < disconnected.length; i++) {
        const n = disconnected[i];
        n.x = orphanOriginX + (i % orphanCols) * orphanSpacing;
        n.y = orphanOriginY + Math.floor(i / orphanCols) * orphanSpacing;
        n.vx = 0; n.vy = 0;
        n.orphan = true;
        n.hidden = true;
    }

    // Weighted adjacency for BFS placement
    const weightedAdj = new Map();
    for (const n of nodes) weightedAdj.set(n.id, []);
    for (const edge of edges) {
        const w = edge.weight || 1;
        weightedAdj.get(edge.from).push({ id: edge.to, weight: w });
        weightedAdj.get(edge.to).push({ id: edge.from, weight: w });
    }
    for (const [, neighbors] of weightedAdj) {
        neighbors.sort((a, b) => b.weight - a.weight);
    }

    // Find hub
    let hubId = 0, hubEdges = 0;
    for (const [id, count] of edgeCountByNode) {
        if (count > hubEdges) { hubId = id; hubEdges = count; }
    }

    // Weighted BFS from hub
    const placed = new Set();
    const revealOrder = [];
    const placeDist = springLen * 1.2;

    // Pre-compute shared neighbors for placement
    const sharedWith = new Map();
    for (const n of nodes) sharedWith.set(n.id, []);
    const neighborSetsForPlace = new Map();
    for (const n of nodes) {
        if (n.orphan) continue;
        neighborSetsForPlace.set(n.id, new Set((adjacency.get(n.id) || [])));
    }
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].orphan) continue;
        const setI = neighborSetsForPlace.get(i);
        if (!setI || setI.size === 0) continue;
        for (let j = i + 1; j < nodes.length; j++) {
            if (nodes[j].orphan) continue;
            if (setI.has(j)) continue;
            const setJ = neighborSetsForPlace.get(j);
            if (!setJ || setJ.size === 0) continue;
            let shared = 0;
            for (const nb of setI) { if (setJ.has(nb)) shared++; }
            if (shared > 0) {
                sharedWith.get(i).push({ id: j, shared });
                sharedWith.get(j).push({ id: i, shared });
            }
        }
    }

    // Place hub at center
    nodes[hubId].x = 0; nodes[hubId].y = 0;
    nodes[hubId].vx = 0; nodes[hubId].vy = 0;
    nodes[hubId].hidden = true;
    placed.add(hubId);
    revealOrder.push(hubId);

    // BFS queue
    const bfsQueue = [hubId];
    let bfsHead = 0;
    let angleCounter = 0;

    while (bfsHead < bfsQueue.length) {
        const cur = bfsQueue[bfsHead++];
        const neighbors = weightedAdj.get(cur) || [];

        for (const nb of neighbors) {
            if (placed.has(nb.id) || nodes[nb.id].orphan) continue;

            let cx = 0, cy = 0, totalW = 0;

            // Direct placed neighbors
            for (const adj of (weightedAdj.get(nb.id) || [])) {
                if (!placed.has(adj.id)) continue;
                const w = adj.weight || 1;
                cx += nodes[adj.id].x * w;
                cy += nodes[adj.id].y * w;
                totalW += w;
            }

            // Shared-neighbor placed nodes
            for (const sn of (sharedWith.get(nb.id) || [])) {
                if (!placed.has(sn.id)) continue;
                const w = sn.shared * 0.5;
                cx += nodes[sn.id].x * w;
                cy += nodes[sn.id].y * w;
                totalW += w;
            }

            if (totalW > 0) {
                cx /= totalW;
                cy /= totalW;
            } else {
                cx = nodes[cur].x;
                cy = nodes[cur].y;
            }

            const angle = angleCounter * 2.399;
            const jitter = placeDist * 0.5 + (Math.random() - 0.5) * placeDist * 0.3;
            nodes[nb.id].x = cx + Math.cos(angle) * jitter;
            nodes[nb.id].y = cy + Math.sin(angle) * jitter;
            nodes[nb.id].vx = 0; nodes[nb.id].vy = 0;
            nodes[nb.id].hidden = true;

            placed.add(nb.id);
            revealOrder.push(nb.id);
            bfsQueue.push(nb.id);
            angleCounter++;
        }
    }

    // Any connected nodes not reached by BFS
    for (const n of nodes) {
        if (!placed.has(n.id) && !n.orphan) {
            const angle = angleCounter * 2.399;
            n.x = Math.cos(angle) * placeDist * 3;
            n.y = Math.sin(angle) * placeDist * 3;
            n.vx = 0; n.vy = 0;
            n.hidden = true;
            revealOrder.push(n.id);
            angleCounter++;
        }
    }

    // Build reveal batches
    const REVEAL_INTERVAL = 4;
    const MAX_BATCH_SIZE = 3;
    const revealBatches = [];
    for (let i = 0; i < revealOrder.length; i += MAX_BATCH_SIZE) {
        revealBatches.push(revealOrder.slice(i, i + MAX_BATCH_SIZE));
    }
    for (let b = 0; b < revealBatches.length; b++) {
        for (const id of revealBatches[b]) {
            nodes[id].revealBatchIdx = b;
            nodes[id].bfsDepth = b;
        }
    }
    if (disconnected.length > 0) {
        const orphanBatchIdx = revealBatches.length;
        for (const n of disconnected) { n.revealBatchIdx = orphanBatchIdx; n.bfsDepth = orphanBatchIdx; }
        revealBatches.push(disconnected.map(n => n.id));
    }

    // Pre-compute link strength
    const linkStrengths = new Float64Array(edges.length);
    for (let e = 0; e < edges.length; e++) {
        const srcDeg = nodeDegree[edges[e].from] || 1;
        const tgtDeg = nodeDegree[edges[e].to] || 1;
        linkStrengths[e] = 1 / Math.min(srcDeg, tgtDeg);
    }

    // Pre-compute shared neighbors (virtual springs)
    const neighborSets = new Map();
    for (const n of nodes) {
        if (n.orphan) continue;
        neighborSets.set(n.id, new Set((adjacency.get(n.id) || [])));
    }
    const sharedNeighborPairs = [];
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].orphan) continue;
        const setI = neighborSets.get(i);
        if (!setI || setI.size === 0) continue;
        for (let j = i + 1; j < nodes.length; j++) {
            if (nodes[j].orphan) continue;
            if (setI.has(j)) continue;
            const setJ = neighborSets.get(j);
            if (!setJ || setJ.size === 0) continue;
            let shared = 0;
            for (const nb of setI) { if (setJ.has(nb)) shared++; }
            if (shared > 0) {
                sharedNeighborPairs.push({ a: i, b: j, shared });
            }
        }
    }
    dbg(`Shared-neighbor pairs: ${sharedNeighborPairs.length} (n+2 virtual springs)`);

    // Pre-compute same-tag pairs
    const tagPairs = [];
    const lorebookTag = (settings.lorebookTag || 'lorebook').toLowerCase();
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].orphan) continue;
        const tagsI = nodes[i].tags.filter(t => t.toLowerCase() !== lorebookTag);
        if (tagsI.length === 0) continue;
        for (let j = i + 1; j < nodes.length; j++) {
            if (nodes[j].orphan) continue;
            const tagsJ = nodes[j].tags.filter(t => t.toLowerCase() !== lorebookTag);
            if (tagsJ.length === 0) continue;
            let shared = 0;
            for (const t of tagsI) { if (tagsJ.includes(t)) shared++; }
            if (shared > 0) tagPairs.push({ a: i, b: j, shared });
        }
    }
    dbg(`Tag pairs: ${tagPairs.length} (same-tag clustering springs)`);
    dbg(`Weighted BFS from "${nodes[hubId].title}" (${hubEdges} edges), ${revealBatches.length} batches, ${disconnected.length} orphans`);

    // ========================================================================
    // CSS-var-aware colors
    // ========================================================================
    const computedStyle = getComputedStyle(document.documentElement);
    const nodeColors = {
        constant: '#ff9800',
        seed: '#2196f3',
        bootstrap: '#9c27b0',
        regular: '#4caf50',
    };
    const edgeColors = {
        link: '#aac8ff',
        requires: computedStyle.getPropertyValue('--dle-success').trim() || '#4caf50',
        excludes: computedStyle.getPropertyValue('--dle-error').trim() || '#f44336',
        cascade: computedStyle.getPropertyValue('--dle-warning').trim() || '#ff9800',
    };

    // ========================================================================
    // Cleanup on popup close
    // ========================================================================
    const listenerAC = new AbortController();
    const popupContainer = canvas.closest('.popup') || container.parentElement;
    const observer = new MutationObserver(() => {
        if (!canvas.isConnected) {
            dbg('Canvas removed from DOM — cleaning up graph');
            gs.isRunning = false;
            if (gs.animationFrameId) { cancelAnimationFrame(gs.animationFrameId); gs.animationFrameId = null; }
            listenerAC.abort();
            observer.disconnect();
        }
    });
    if (popupContainer) {
        observer.observe(popupContainer, { childList: true, subtree: true });
    }

    // ========================================================================
    // Shared graph state — passed to all sub-modules
    // ========================================================================
    const gs = {
        // Data
        nodes, edges, adjacency, edgeVisibility,
        edgeCountByNode, nodeDegree, maxEdgeCount,
        injectionCounts, maxInjectionCount,
        linkStrengths, tagPairs, sharedNeighborPairs,
        titleToIdx, circularPairs, typeCounts,
        multiVault,
        // Reveal
        revealBatches, revealedBatch: 0, revealFrameCounter: 0,
        REVEAL_INTERVAL, MAX_BATCH_SIZE,
        // Canvas
        canvas, ctx, W, H, dpr, cachedRect,
        // View
        panX: W / 2, panY: H / 2, zoom: 1,
        // Interaction
        dragNode: null, hoverNode: null,
        isPanning: false, panStartX: 0, panStartY: 0, panOriginX: 0, panOriginY: 0,
        hoverDistances: null,
        contextMenuNode: null, tempPinnedNode: null,
        // Simulation
        isRunning: true, alpha: 1.0,
        hasSpringEnergy: true, maxDelta: 0, simFrame: 0,
        // Graph state
        colorMode: settings.graphDefaultColorMode || 'type',
        searchQuery: '', typeFilter: '', tagFilter: '',
        showLabels: settings.graphShowLabels !== false,
        // Focus Tree
        focusTreeRoot: null, focusTreePhysics: false,
        // Rendering
        needsDraw: true, prevHoverNode: null,
        debugMouseX: 0, debugMouseY: 0,
        cachedVisibleCount: nodes.length,
        animationFrameId: null,
        // Colors
        nodeColors, edgeColors, computedStyle,
        // References
        settings, springLen,
        tooltipEl: document.getElementById('dle_graph_tooltip'),
        listenerAC,
        // Cross-module functions (set by init calls below)
        buildAdjacency: null, applyFilters: null, fitToView: null,
        getNodeColor: null, getNodeRadius: null,
        toScreen: null, toWorld: null,
        findNearest: null, hitRadius: null,
        computeHoverDistances: null,
        enterFocusTree: null, exitFocusTree: null,
        updateTooltip: null,
        // Gap analysis
        _vaultIndex: vaultIndex,
        gapAnalysis: null,
        gapAnalysisActive: false,
    };

    // Wire buildAdjacency as a gs method (updates gs.adjacency)
    gs.buildAdjacency = () => {
        buildAdjacency();
        gs.adjacency = adjacency;
    };

    // ========================================================================
    // Disparity filter — compute initial backbone
    // ========================================================================
    computeDisparityFilter(gs, settings.graphEdgeFilterAlpha ?? 0.05);
    gs.recomputeBackbone = (alpha) => {
        computeDisparityFilter(gs, alpha);
        gs.needsDraw = true;
    };
    dbg(`Disparity filter: ${gs._backboneCount}/${edges.length} backbone edges at alpha=${gs._disparityAlpha}`);

    // Louvain community detection
    computeLouvainCommunities(gs);
    const communityCount = gs.communities ? gs.communities.size : 0;
    dbg(`Louvain: ${communityCount} communities detected`);

    // ========================================================================
    // Initialize sub-modules
    // ========================================================================
    const render = initRender(gs);
    const focus = initFocus(gs, dbg);
    const physics = initPhysics(gs);
    const events = initEvents(gs, dbg);
    const graphSettings = initGraphSettings(gs, dbg);

    // ========================================================================
    // Animation loop
    // ========================================================================
    function tick() {
        if (!gs.isRunning) return;
        if (!document.getElementById('dle_graph_canvas')) {
            gs.isRunning = false;
            if (gs.animationFrameId) { cancelAnimationFrame(gs.animationFrameId); gs.animationFrameId = null; }
            return;
        }
        physics.simulate();

        // --- Ego-centric focus: smooth position lerp ---
        if (gs._egoLerpActive && focus.lerpEgoPositions()) {
            gs.needsDraw = true;
            gs.hasSpringEnergy = true;
        }

        // --- Entrance animation: lerp reveal scales each frame ---
        let anyRevealing = false;
        for (const n of gs.nodes) {
            if (n.hidden || n._revealScale >= 1) continue;
            n._revealScale += (1 - n._revealScale) * 0.15;
            if (n._revealScale > 0.995) n._revealScale = 1;
            else anyRevealing = true;
        }
        for (const e of gs.edges) {
            const fromScale = gs.nodes[e.from]._revealScale;
            const toScale = gs.nodes[e.to]._revealScale;
            if (fromScale > 0.5 && toScale > 0.5) {
                e._revealAlpha += (1 - e._revealAlpha) * 0.1;
                if (e._revealAlpha > 0.99) e._revealAlpha = 1;
                else anyRevealing = true;
            }
        }
        if (anyRevealing) { gs.needsDraw = true; gs.hasSpringEnergy = true; }

        const hoverChanged = gs.hoverNode !== gs.prevHoverNode;
        gs.prevHoverNode = gs.hoverNode;
        if (gs.hasSpringEnergy || gs.maxDelta > 0.01 || gs.dragNode || hoverChanged || gs.needsDraw) {
            render.draw();
            if (hoverChanged) render.updateTooltip();
            gs.needsDraw = false;
        }

        gs.animationFrameId = requestAnimationFrame(tick);
    }

    // ========================================================================
    // Start
    // ========================================================================
    render.updateTooltip(); // Show color legend on load
    tick();
}
