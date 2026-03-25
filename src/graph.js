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
import { getSettings, getVaultByName } from '../settings.js';
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

/** Find nearest node to world-space point within hitRadius. Skips hidden and filtered nodes. */
function findNearest(nodes, wx, wy, maxDist, debugLabel) {
    let closest = null, closestDist = maxDist;
    let nearestAny = null, nearestAnyDist = Infinity;
    for (const n of nodes) {
        if (n.hidden || n.filtered) continue;
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
            edges.push({ from, to, type });
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
            <button id="dle_graph_fit" class="menu_button" title="Fit to view (0)" style="height: 28px; padding: 2px 8px; font-size: 12px;">Fit</button>
            <button id="dle_graph_export_png" class="menu_button" title="Export as PNG" style="height: 28px; padding: 2px 8px; font-size: 12px;">PNG</button>
            <button id="dle_graph_export_json" class="menu_button" title="Export as JSON" style="height: 28px; padding: 2px 8px; font-size: 12px;">JSON</button>
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
    // Graph state (toolbar-driven)
    // ========================================================================
    let colorMode = 'type';
    let searchQuery = '';
    let typeFilter = '';
    let tagFilter = '';
    // edgeVisibility declared earlier (before buildAdjacency)
    let showLabels = true;

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
        if (!hasFilter) {
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
    const HOVER_DIM_DISTANCE = 2;
    const HOVER_DIM_OPACITY = 0.1;
    let hoverDistances = null;

    function computeHoverDistances(startId) {
        const dist = new Map();
        dist.set(startId, 0);
        const queue = [startId];
        let head = 0;
        while (head < queue.length) {
            const current = queue[head++];
            const d = dist.get(current);
            if (d >= HOVER_DIM_DISTANCE) continue;
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

    function simulate() {
        if (alpha < 0.001 && !dragNode && !hasSpringEnergy && maxDelta < 0.01) return;
        if (!dragNode) alpha *= 0.98;
        const k = 0.008, repulsion = 2000, damping = 0.7, gravity = 0.03, maxV = 8;
        if (!dragNode) {
            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].hidden) continue;
                for (let j = i + 1; j < nodes.length; j++) {
                    if (nodes[j].hidden) continue;
                    let dx = nodes[j].x - nodes[i].x;
                    let dy = nodes[j].y - nodes[i].y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const force = repulsion / (dist * dist) * alpha;
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;
                    nodes[i].vx -= fx; nodes[i].vy -= fy;
                    nodes[j].vx += fx; nodes[j].vy += fy;
                }
            }
            for (const n of nodes) {
                if (n.hidden) continue;
                n.vx -= n.x * gravity * alpha;
                n.vy -= n.y * gravity * alpha;
            }
        }
        for (const edge of edges) {
            if (nodes[edge.from].hidden || nodes[edge.to].hidden) continue;
            const a = nodes[edge.from], b = nodes[edge.to];
            const dx = b.x - a.x, dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = k * (dist - 120);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx; a.vy += fy;
            b.vx -= fx; b.vy -= fy;
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
        hasSpringEnergy = totalSpeed > 0.1;
    }

    // ========================================================================
    // Canvas rendering
    // ========================================================================
    let needsDraw = true;
    let prevHoverNode = null;

    function draw() {
        ctx.clearRect(0, 0, W, H);

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

                // Alpha priority: hover dim > filtered > frequency/standard
                if (hoverDistances) {
                    const fromIn = hoverDistances.has(edge.from);
                    const toIn = hoverDistances.has(edge.to);
                    ctx.globalAlpha = (fromIn && toIn) ? 0.5 : HOVER_DIM_OPACITY;
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
            if (hoverDistances) {
                ctx.globalAlpha = hoverDistances.has(n.id) ? 1.0 : HOVER_DIM_OPACITY;
            } else if (n.filtered) {
                ctx.globalAlpha = 0.12;
            } else {
                ctx.globalAlpha = 1;
            }
            const s = toScreen(n.x, n.y);
            const r = getNodeRadius(n);
            ctx.fillStyle = getNodeColor(n);
            ctx.beginPath(); ctx.arc(s.x, s.y, r * zoom, 0, Math.PI * 2); ctx.fill();
            if (n.pinned) {
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(s.x, s.y, (r + 3) * zoom, 0, Math.PI * 2); ctx.stroke();
                ctx.lineWidth = 1;
            }
        }
        ctx.globalAlpha = 1;

        // Draw labels
        if (showLabels) {
            ctx.fillStyle = '#ddd'; ctx.font = `${Math.max(9, 11 * zoom)}px monospace`; ctx.textAlign = 'center';
            for (const n of nodes) {
                if (n.hidden || n.filtered) continue;
                if (hoverDistances && !hoverDistances.has(n.id)) continue;
                const s = toScreen(n.x, n.y);
                const isHub = (edgeCountByNode.get(n.id) || 0) >= 5;
                if (n === hoverNode || zoom > 1.0 || nodes.length < 30 || isHub) {
                    ctx.fillText(n.title, s.x, s.y - 10 * zoom);
                }
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
            <div class="dle-graph-ctx-item" data-action="isolate">Isolate Neighborhood</div>
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
            case 'isolate': {
                // Show only N-hop neighborhood
                const dist = computeHoverDistances(node.id);
                for (const n of nodes) {
                    n.hidden = !dist.has(n.id);
                }
                alpha = Math.max(alpha, 0.8);
                needsDraw = true;
                dbg(`Isolated neighborhood of "${node.title}": ${dist.size} nodes visible, ${nodes.length - dist.size} hidden`);
                toastr.info(
                    `Showing ${dist.size} nodes around "${node.title}". Clear filters or press Escape to reset.`,
                    'DeepLore Enhanced',
                    { timeOut: 5000, preventDuplicates: true },
                );
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
    function hitRadius() {
        // Scale hit radius to canvas size — nodes spread across full canvas area
        const baseRadius = Math.max(W, H) / (Math.sqrt(nodes.length) * 1.5);
        return Math.max(15, Math.min(80, baseRadius / zoom));
    }

    const lOpt = { signal: listenerAC.signal };

    // -- Canvas mouse events --
    canvas.addEventListener('mousedown', (e) => {
        // Only handle left-click (button 0) — right-click is handled by contextmenu
        if (e.button !== 0) return;
        hideContextMenu();
        const mx = e.clientX - cachedRect.left, my = e.clientY - cachedRect.top;
        const w = toWorld(mx, my);
        const closest = findNearest(nodes, w.x, w.y, hitRadius(), 'mousedown');
        if (closest) {
            dragNode = closest;
            alpha = Math.max(alpha, 0.5);
            canvas.style.cursor = 'grabbing';
            dbg(`mousedown: grabbed "${closest.title}"`);
        } else {
            isPanning = true;
            panStartX = mx; panStartY = my;
            panOriginX = panX; panOriginY = panY;
            canvas.style.cursor = 'grabbing';
        }
    }, lOpt);

    canvas.addEventListener('mousemove', (e) => {
        const mx = e.clientX - cachedRect.left, my = e.clientY - cachedRect.top;
        if (dragNode) {
            const w = toWorld(mx, my);
            dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0;
            alpha = Math.max(alpha, 0.5);
            needsDraw = true;
        } else if (isPanning) {
            panX = panOriginX + (mx - panStartX);
            panY = panOriginY + (my - panStartY);
            needsDraw = true;
        } else {
            const w = toWorld(mx, my);
            const closest = findNearest(nodes, w.x, w.y, hitRadius());
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
            alpha = Math.max(alpha, 0.3);
        }
        isPanning = false;
        canvas.style.cursor = 'grab';
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
            showContextMenu(pinTarget, e.clientX - cachedRect.left, e.clientY - cachedRect.top);
            return;
        }
        const mx = e.clientX - cachedRect.left, my = e.clientY - cachedRect.top;
        const w = toWorld(mx, my);
        const closest = findNearest(nodes, w.x, w.y, hitRadius(), 'contextmenu');
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
        const mx = e.clientX - cachedRect.left, my = e.clientY - cachedRect.top;
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
                // Reset isolation + velocity
                dbg('Keyboard: Escape — resetting isolation and context menu');
                for (const n of nodes) {
                    if (n.hidden) { n.vx = 0; n.vy = 0; } // Reset velocity on un-hide
                    n.hidden = false;
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
        colorModeEl.addEventListener('change', () => {
            colorMode = colorModeEl.value;
            dbg(`Color mode changed to: ${colorMode}`);
            needsDraw = true;
        }, lOpt);
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
    // Start
    // ========================================================================
    tick();
}
