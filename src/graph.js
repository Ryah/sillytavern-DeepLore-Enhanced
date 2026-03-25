/**
 * DeepLore Enhanced — Graph visualization module
 * Interactive force-directed graph of entry relationships.
 * Extracted from popups.js for maintainability.
 */
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { NO_ENTRIES_MSG } from '../core/utils.js';
import { getSettings } from '../settings.js';
import { vaultIndex } from './state.js';
import { ensureIndexFresh } from './vault.js';

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

    // ========================================================================
    // Build node and edge data
    // ========================================================================
    const nodes = vaultIndex.map((e, i) => ({
        id: i,
        title: e.title,
        type: e.constant ? 'constant' : e.seed ? 'seed' : e.bootstrap ? 'bootstrap' : 'regular',
        tokens: e.tokenEstimate,
        vaultSource: e.vaultSource || '',
        x: Math.random() * 800 - 400,
        y: Math.random() * 600 - 300,
        vx: 0, vy: 0,
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
            if (j !== undefined && j !== i) {
                addEdge(i, j, 'link');
            }
        }
        for (const req of entry.requires) {
            const j = titleToIdx.get(req.toLowerCase());
            if (j !== undefined && j !== i) {
                addEdge(i, j, 'requires');
            }
        }
        for (const ex of entry.excludes) {
            const j = titleToIdx.get(ex.toLowerCase());
            if (j !== undefined && j !== i) {
                addEdge(i, j, 'excludes');
            }
        }
        for (const cl of (entry.cascadeLinks || [])) {
            const j = titleToIdx.get(cl.toLowerCase());
            if (j !== undefined && j !== i) {
                addEdge(i, j, 'cascade');
            }
        }
    }

    // B3: Detect circular requires using Set (O(e) instead of O(e²))
    const circularPairs = [];
    const requiresSet = new Set();
    for (const edge of edges) {
        if (edge.type === 'requires') {
            requiresSet.add(`${edge.from},${edge.to}`);
        }
    }
    const seenCircular = new Set();
    for (const edge of edges) {
        if (edge.type === 'requires') {
            if (requiresSet.has(`${edge.to},${edge.from}`)) {
                const key = `${Math.min(edge.from, edge.to)},${Math.max(edge.from, edge.to)}`;
                if (!seenCircular.has(key)) {
                    seenCircular.add(key);
                    circularPairs.push(key);
                }
            }
        }
    }

    // ========================================================================
    // Build adjacency for hover-dim BFS (U3)
    // ========================================================================
    const adjacency = new Map();
    for (const n of nodes) adjacency.set(n.id, []);
    for (const edge of edges) {
        adjacency.get(edge.from).push(edge.to);
        adjacency.get(edge.to).push(edge.from);
    }

    // ========================================================================
    // Build text summary for screen readers
    // ========================================================================
    const typeCounts = { regular: 0, constant: 0, seed: 0, bootstrap: 0 };
    for (const n of nodes) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;

    const edgeCountByNode = new Map();
    for (const edge of edges) {
        edgeCountByNode.set(edge.from, (edgeCountByNode.get(edge.from) || 0) + 1);
        edgeCountByNode.set(edge.to, (edgeCountByNode.get(edge.to) || 0) + 1);
    }
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
    container.classList.add('dle-popup');
    const circularWarning = circularPairs.length > 0
        ? `<p class="dle-error dle-text-sm">⚠ ${circularPairs.length} circular require pair(s) detected</p>`
        : '';
    container.innerHTML = `
        <h3>Entry Relationship Graph (${nodes.length} nodes, ${edges.length} edges)</h3>
        ${circularWarning}
        <div class="dle-text-xs" style="display: flex; gap: 10px; margin-bottom: var(--dle-space-2); flex-wrap: wrap;">
            <span><span class="dle-success">●</span> Regular</span>
            <span><span class="dle-warning">●</span> Constant</span>
            <span><span class="dle-info">●</span> Seed</span>
            <span><span class="dle-accent">●</span> Bootstrap</span>
            <span class="dle-muted">—</span>
            <span><span style="color: #aac8ff;">—</span> Link</span>
            <span><span class="dle-success">—</span> Requires</span>
            <span><span class="dle-error">—</span> Excludes</span>
            <span><span class="dle-warning">—</span> Cascade</span>
        </div>
        <canvas id="dle_graph_canvas" width="900" height="600" style="border: 1px solid var(--dle-border); border-radius: 4px; cursor: grab; width: 100%; height: 600px; background: var(--dle-bg-surface);" aria-label="Force-directed graph showing ${nodes.length} vault entries and ${edges.length} relationships between them, including links, requires, excludes, and cascade connections."></canvas>
        <details class="dle-text-sm" style="margin-top: var(--dle-space-2);">
            <summary>Text summary (for screen readers)</summary>
            ${summaryHtml}
        </details>
        <small class="dle-dimmed">Drag nodes to reposition. Right-click to pin/unpin. Scroll to zoom.</small>
    `;

    callGenericPopup(container, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: false });

    // B6: Poll for canvas instead of fixed 100ms setTimeout
    let canvas = null;
    for (let attempt = 0; attempt < 20; attempt++) {
        canvas = document.getElementById('dle_graph_canvas');
        if (canvas && canvas.getBoundingClientRect().height > 0) break;
        canvas = null; // reset so we re-check next attempt
        await new Promise(r => setTimeout(r, 50));
    }
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // B5: Cache rect, update only on resize
    let cachedRect = canvas.getBoundingClientRect();
    canvas.width = cachedRect.width * (window.devicePixelRatio || 1);
    canvas.height = cachedRect.height * (window.devicePixelRatio || 1);
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    const W = cachedRect.width;
    const H = cachedRect.height;

    for (const n of nodes) {
        n.x = (Math.random() - 0.5) * W * 0.8;
        n.y = (Math.random() - 0.5) * H * 0.8;
    }

    let panX = W / 2, panY = H / 2, zoom = 1;
    let dragNode = null, hoverNode = null;
    let isPanning = false, panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;
    let isRunning = true;
    let alpha = 1.0; // simulation temperature — decays toward 0

    // U9: Use CSS-var-aware colors (read computed values from document)
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
    // U3: Hover dim — BFS to compute hop distances from hovered node
    // ========================================================================
    const HOVER_DIM_DISTANCE = 2; // hops — nodes beyond this dim to ~10%
    const HOVER_DIM_OPACITY = 0.1;
    let hoverDistances = null; // Map<nodeId, hopDistance> — null when no hover

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
                if (!dist.has(neighbor)) {
                    dist.set(neighbor, d + 1);
                    queue.push(neighbor);
                }
            }
        }
        return dist;
    }

    // ========================================================================
    // Physics simulation
    // ========================================================================
    let hasSpringEnergy = true;
    let maxDelta = 0; // B9: track max position delta for settle detection

    function simulate() {
        if (alpha < 0.001 && !dragNode && !hasSpringEnergy && maxDelta < 0.01) return;
        if (!dragNode) alpha *= 0.98;
        const k = 0.008, repulsion = 2000, damping = 0.7, gravity = 0.03, maxV = 8;
        // Repulsion + gravity only during initial layout (not during drag)
        if (!dragNode) {
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
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
                n.vx -= n.x * gravity * alpha;
                n.vy -= n.y * gravity * alpha;
            }
        }
        // Spring (edge) forces always apply so dragging pulls neighbors
        for (const edge of edges) {
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
        const bound = Math.max(W, H) * 2; // B10: clamp to ±2x canvas
        for (const n of nodes) {
            if (n === dragNode || n.pinned) continue;
            n.vx *= damping; n.vy *= damping;
            const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
            if (speed > maxV) { n.vx *= maxV / speed; n.vy *= maxV / speed; }
            n.x += n.vx; n.y += n.vy;
            // B10: clamp positions
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
    // P3: Track whether we need to redraw
    let needsDraw = true;
    let prevHoverNode = null;

    function draw() {
        ctx.clearRect(0, 0, W, H);

        // P4: Batch edges by type to minimize canvas state changes
        const edgesByType = { link: [], requires: [], excludes: [], cascade: [] };
        for (const edge of edges) {
            (edgesByType[edge.type] || (edgesByType[edge.type] = [])).push(edge);
        }

        for (const [type, edgeList] of Object.entries(edgesByType)) {
            if (edgeList.length === 0) continue;
            ctx.strokeStyle = edgeColors[type] || '#555';
            ctx.lineWidth = 1;
            if (type === 'excludes') { ctx.setLineDash([4, 4]); } else { ctx.setLineDash([]); }

            for (const edge of edgeList) {
                // U3: Dim edges not in hover neighborhood
                if (hoverDistances) {
                    const fromIn = hoverDistances.has(edge.from);
                    const toIn = hoverDistances.has(edge.to);
                    ctx.globalAlpha = (fromIn && toIn) ? 0.5 : HOVER_DIM_OPACITY;
                } else {
                    ctx.globalAlpha = 0.4;
                }
                const a = toScreen(nodes[edge.from].x, nodes[edge.from].y);
                const b = toScreen(nodes[edge.to].x, nodes[edge.to].y);
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            }
        }
        ctx.setLineDash([]); ctx.globalAlpha = 1;

        // Draw nodes
        for (const n of nodes) {
            // U3: Dim nodes not in hover neighborhood
            if (hoverDistances) {
                ctx.globalAlpha = hoverDistances.has(n.id) ? 1.0 : HOVER_DIM_OPACITY;
            } else {
                ctx.globalAlpha = 1;
            }
            const s = toScreen(n.x, n.y);
            const r = Math.max(4, Math.min(12, Math.sqrt(n.tokens / 10)));
            ctx.fillStyle = n === hoverNode ? '#ffffff' : (nodeColors[n.type] || '#4caf50');
            ctx.beginPath(); ctx.arc(s.x, s.y, r * zoom, 0, Math.PI * 2); ctx.fill();
            if (n.pinned) {
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(s.x, s.y, (r + 3) * zoom, 0, Math.PI * 2); ctx.stroke();
                ctx.lineWidth = 1;
            }
        }
        ctx.globalAlpha = 1;

        // Draw labels — U6: lowered threshold from 1.5 to 1.0, and always show hub labels
        ctx.fillStyle = '#ddd'; ctx.font = `${Math.max(9, 11 * zoom)}px monospace`; ctx.textAlign = 'center';
        for (const n of nodes) {
            // U3: Skip labels for dimmed nodes
            if (hoverDistances && !hoverDistances.has(n.id)) continue;
            const s = toScreen(n.x, n.y);
            const isHub = (edgeCountByNode.get(n.id) || 0) >= 5;
            if (n === hoverNode || zoom > 1.0 || nodes.length < 30 || isHub) {
                ctx.fillText(n.title, s.x, s.y - 10 * zoom);
            }
        }

        // Draw tooltip for hovered node
        if (hoverNode) {
            const s = toScreen(hoverNode.x, hoverNode.y);
            const entry = vaultIndex[hoverNode.id];
            const info = `${hoverNode.title} (~${hoverNode.tokens} tok, pri ${entry.priority})`;
            const connections = edgeCountByNode.get(hoverNode.id) || 0;
            const vaultLabel = multiVault && hoverNode.vaultSource ? ` [${hoverNode.vaultSource}]` : '';
            const tooltip = `${info}${vaultLabel} — ${connections} connection(s)`;
            const fontSize = Math.max(10, 12 * zoom);
            ctx.font = `${fontSize}px monospace`;
            ctx.fillStyle = 'rgba(0,0,0,0.85)';
            const tw = ctx.measureText(tooltip).width + 16;
            const th = fontSize + 8;
            const tooltipY = s.y + 16 * zoom;
            // Clamp tooltip within canvas bounds
            const tx = Math.max(tw / 2 + 2, Math.min(W - tw / 2 - 2, s.x));
            const ty = tooltipY + th > H ? s.y - 16 * zoom - th : tooltipY;
            ctx.fillRect(tx - tw / 2, ty, tw, th);
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center';
            ctx.fillText(tooltip, tx, ty + fontSize + 2);
        }
    }

    let animationFrameId = null;
    function tick() {
        if (!isRunning) return;
        if (!document.getElementById('dle_graph_canvas')) {
            isRunning = false;
            if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
            return;
        }
        simulate();

        // P3: Only redraw when something changed
        const hoverChanged = hoverNode !== prevHoverNode;
        prevHoverNode = hoverNode;
        if (hasSpringEnergy || maxDelta > 0.01 || alpha > 0.001 || dragNode || hoverChanged || needsDraw) {
            draw();
            needsDraw = false;
        }

        animationFrameId = requestAnimationFrame(tick);
    }

    // ========================================================================
    // Cleanup on popup close
    // ========================================================================
    const listenerAC = new AbortController();
    const popupContainer = canvas.closest('.popup') || container.parentElement;
    // B8: Don't fall back to document.body — use container.parentElement instead
    const observer = new MutationObserver(() => {
        if (!document.getElementById('dle_graph_canvas')) {
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
    // B4: Consistent hit detection radius (fixed CSS pixels converted to world)
    function hitRadius() {
        return Math.max(8, Math.min(40, 15 / zoom));
    }

    const lOpt = { signal: listenerAC.signal };
    canvas.addEventListener('mousedown', (e) => {
        const mx = e.clientX - cachedRect.left, my = e.clientY - cachedRect.top;
        const w = toWorld(mx, my);
        let closest = null, closestDist = hitRadius();
        for (const n of nodes) {
            const d = Math.sqrt((n.x - w.x) ** 2 + (n.y - w.y) ** 2);
            if (d < closestDist) { closest = n; closestDist = d; }
        }
        if (closest) {
            dragNode = closest;
            alpha = Math.max(alpha, 0.5);
            canvas.style.cursor = 'grabbing';
        } else {
            // Pan mode — drag empty canvas to move viewport
            isPanning = true;
            panStartX = mx;
            panStartY = my;
            panOriginX = panX;
            panOriginY = panY;
            canvas.style.cursor = 'grabbing';
        }
    }, lOpt);

    canvas.addEventListener('mousemove', (e) => {
        const mx = e.clientX - cachedRect.left, my = e.clientY - cachedRect.top;
        if (dragNode) {
            const w = toWorld(mx, my); dragNode.x = w.x; dragNode.y = w.y; dragNode.vx = 0; dragNode.vy = 0;
            alpha = Math.max(alpha, 0.5);
            needsDraw = true;
        } else if (isPanning) {
            panX = panOriginX + (mx - panStartX);
            panY = panOriginY + (my - panStartY);
            needsDraw = true;
        } else {
            const w = toWorld(mx, my);
            let closest = null, closestDist = hitRadius();
            for (const n of nodes) {
                const d = Math.sqrt((n.x - w.x) ** 2 + (n.y - w.y) ** 2);
                if (d < closestDist) { closest = n; closestDist = d; }
            }
            if (closest !== hoverNode) {
                hoverNode = closest;
                // U3: Recompute hover distances when hover changes
                hoverDistances = closest ? computeHoverDistances(closest.id) : null;
                needsDraw = true;
            }
            canvas.style.cursor = closest ? 'pointer' : 'grab';
        }
    }, lOpt);

    // B1: Only reheat alpha if we were dragging a node — clicking empty space shouldn't reset the layout
    canvas.addEventListener('mouseup', () => {
        if (dragNode) {
            dragNode = null;
            alpha = Math.max(alpha, 0.3); // let springs settle after node drag
        }
        isPanning = false;
        canvas.style.cursor = 'grab';
    }, lOpt);

    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const mx = e.clientX - cachedRect.left, my = e.clientY - cachedRect.top;
        const w = toWorld(mx, my);
        let closest = null, closestDist = hitRadius();
        for (const n of nodes) {
            const d = Math.sqrt((n.x - w.x) ** 2 + (n.y - w.y) ** 2);
            if (d < closestDist) { closest = n; closestDist = d; }
        }
        if (closest) {
            closest.pinned = !closest.pinned;
            closest.vx = 0; closest.vy = 0;
            needsDraw = true;
        }
    }, lOpt);

    // Keep cachedRect fresh on window resize
    window.addEventListener('resize', () => {
        cachedRect = canvas.getBoundingClientRect();
        needsDraw = true;
    }, lOpt);

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        const mx = e.clientX - cachedRect.left, my = e.clientY - cachedRect.top;
        panX = mx - (mx - panX) * zoomFactor; panY = my - (my - panY) * zoomFactor;
        zoom *= zoomFactor; zoom = Math.max(0.2, Math.min(5, zoom));
        needsDraw = true;
    }, { passive: false, signal: listenerAC.signal });

    tick();
}
