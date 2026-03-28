/**
 * DeepLore Enhanced — Graph physics simulation module.
 * Force-directed layout: repulsion, link attraction, tag clustering,
 * shared-neighbor attraction, community clustering, gravity, collision, progressive reveal.
 */
import { updateCommunityCentroids } from './graph-analysis.js';
import { invalidateSettingsCache } from '../../settings.js';
import { saveSettingsDebounced } from '../../../../../../script.js';

// ============================================================================
// Public API — call initPhysics(gs) after graph state is ready
// ============================================================================

/**
 * @param {object} gs  Shared graph state created by graph.js orchestrator
 * @returns {{ simulate: Function }}
 */
export function initPhysics(gs) {

    function simulate() {
        if (gs.focusTreePhysics) return;
        const frozenNode = gs.dragNode || gs.hoverNode;
        if (frozenNode) { gs.hasSpringEnergy = true; }

        // === PROGRESSIVE REVEAL: cascade nodes in by weighted BFS order ===
        if (gs.revealedBatch < gs.revealBatches.length) {
            gs.revealFrameCounter++;
            if (gs.revealFrameCounter >= gs.REVEAL_INTERVAL) {
                gs.revealFrameCounter = 0;
                const batch = gs.revealBatches[gs.revealedBatch];
                for (const id of batch) {
                    gs.nodes[id].hidden = false;
                    gs.nodes[id].vx = 0;
                    gs.nodes[id].vy = 0;
                }
                gs.revealedBatch++;
                gs.alpha = Math.max(gs.alpha, 0.5); // reheat so new nodes integrate
                gs.hasSpringEnergy = true;
                gs.needsDraw = true;
            }
            gs.hasSpringEnergy = true; // keep ticking during reveal
        }

        if (gs.alpha < 0.001 && !frozenNode && !gs.hasSpringEnergy && gs.maxDelta < 0.01) return;
        gs.simFrame++;
        // G7: Two-phase decay — plateau while hot (~20s above 0.3), then fast cooldown (~6s)
        if (!frozenNode) gs.alpha *= (gs.alpha > 0.3) ? 0.999 : 0.985;

        // -- Force parameters (read from settings each frame so sliders are live) --
        const repulsion = gs.settings.graphRepulsion ?? 0.5;
        const gravity   = gs.settings.graphGravity ?? 5.0;
        // G6: Temporarily boost damping after drag release to prevent snap-back
        let damping     = gs.settings.graphDamping ?? 0.50;
        if (gs.releaseStabilizeFrames > 0) {
            damping = Math.min(damping + 0.2, 0.95);
            gs.releaseStabilizeFrames--;
        }

        const CHARGE          = repulsion * 120;             // base for degree-proportional repulsion (sqrt scaling)
        const CHARGE_MAX_DIST = 1500 + repulsion * 200;
        const COLLIDE_PAD     = 8;
        const VELOCITY_DECAY  = 1 - damping;                // default 0.50 → 0.50
        const MAX_DISP        = 40 + repulsion * 80;        // default 0.5 → 80
        const GLOBAL_GRAVITY  = gravity * 0.003;             // default 5.0 → 0.015 (stronger pull inward)

        const { nodes, edges, nodeDegree, linkStrengths, tagPairs, sharedNeighborPairs } = gs;

        // -- Adaptive hub detection --
        let maxDeg = 0, avgDeg = 0, countDeg = 0;
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].hidden || nodes[i].orphan) continue;
            const d = nodeDegree[i] || 0;
            if (d > maxDeg) maxDeg = d;
            avgDeg += d; countDeg++;
        }
        avgDeg = countDeg > 0 ? avgDeg / countDeg : 1;
        const hubRatio = avgDeg > 0 ? maxDeg / avgDeg : 1;
        // Hub-heavy graphs: boost repulsion, reduce cluster force
        const hubRepulsionMul = hubRatio > 5 ? 1.5 : 1.0;
        const hubClusterMul = hubRatio > 5 ? 0.5 : 1.0;

        // -- Repulsion: degree-proportional (FA2 Dissuade Hubs) --
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].hidden || nodes[i].orphan) continue;
            const di = (nodeDegree[i] || 0) + 1;
            for (let j = i + 1; j < nodes.length; j++) {
                if (nodes[j].hidden || nodes[j].orphan) continue;
                const ddx = nodes[j].x - nodes[i].x;
                const ddy = nodes[j].y - nodes[i].y;
                const dist2 = ddx * ddx + ddy * ddy;
                if (dist2 > CHARGE_MAX_DIST * CHARGE_MAX_DIST) continue;
                const dist = Math.sqrt(dist2) || 1;
                const dj = (nodeDegree[j] || 0) + 1;
                // sqrt(di*dj) gives linear degree scaling — avoids quadratic blowup for hubs
                const force = CHARGE * Math.sqrt(di * dj) * hubRepulsionMul * gs.alpha / dist;
                const ux = ddx / dist, uy = ddy / dist;
                nodes[i].vx -= ux * force;
                nodes[i].vy -= uy * force;
                nodes[j].vx += ux * force;
                nodes[j].vy += uy * force;
            }
        }

        // -- Link attraction: LinLog with Dissuade Hubs --
        for (let e = 0; e < edges.length; e++) {
            const a = edges[e].from, b = edges[e].to;
            if (nodes[a].hidden || nodes[b].hidden || nodes[a].orphan || nodes[b].orphan) continue;
            const ddx = nodes[b].x - nodes[a].x;
            const ddy = nodes[b].y - nodes[a].y;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
            // LinLog: logarithmic attraction — spreads clusters apart
            const logDist = Math.log(1 + dist);
            // Hub penalty: softer reduction for high-degree node pairs
            const degProduct = (nodeDegree[a] || 1) * (nodeDegree[b] || 1);
            const hubPenalty = 1 / (1 + Math.log(1 + degProduct));
            const weight = edges[e].weight || 1;
            const weightFactor = 1 + Math.log(weight);
            const strength = linkStrengths[e];
            const force = logDist * hubPenalty * weightFactor * strength * gs.alpha * 2;
            const ux = ddx / dist, uy = ddy / dist;
            if (nodes[a] !== frozenNode) { nodes[a].vx += ux * force; nodes[a].vy += uy * force; }
            if (nodes[b] !== frozenNode) { nodes[b].vx -= ux * force; nodes[b].vy -= uy * force; }
        }

        // -- Same-tag clustering (strongest clustering force) --
        for (const pair of tagPairs) {
            const a = nodes[pair.a], b = nodes[pair.b];
            if (a.hidden || b.hidden) continue;
            const ddx = b.x - a.x;
            const ddy = b.y - a.y;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
            if (dist < 30) continue; // already close
            // Strong pull — scales with shared tag count
            const force = 1.5 * pair.shared * gs.alpha;
            const ux = ddx / dist, uy = ddy / dist;
            if (a !== frozenNode) { a.vx += ux * force; a.vy += uy * force; }
            if (b !== frozenNode) { b.vx -= ux * force; b.vy -= uy * force; }
        }

        // -- Shared-neighbor attraction (n+2 "friends of friends") --
        // Nodes that share common neighbors pull toward each other weakly
        for (const pair of sharedNeighborPairs) {
            const a = nodes[pair.a], b = nodes[pair.b];
            if (a.hidden || b.hidden) continue;
            const ddx = b.x - a.x;
            const ddy = b.y - a.y;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
            if (dist < 50) continue; // already close enough
            // Strength scales with number of shared neighbors (log scale)
            const force = 0.3 * Math.log(1 + pair.shared) * gs.alpha;
            const ux = ddx / dist, uy = ddy / dist;
            if (a !== frozenNode) { a.vx += ux * force; a.vy += uy * force; }
            if (b !== frozenNode) { b.vx -= ux * force; b.vy -= uy * force; }
        }

        // -- Community cluster force: pull nodes toward their community centroid --
        if (gs.communities && gs.communities.size > 1) {
            updateCommunityCentroids(gs);
            const clusterStrength = 0.02 * hubClusterMul * gs.alpha;
            for (let i = 0; i < nodes.length; i++) {
                const n = nodes[i];
                if (n === frozenNode || n.pinned || n.hidden || n.orphan) continue;
                if (n.community == null) continue;
                const cm = gs.communities.get(n.community);
                if (!cm || cm.members.length < 2) continue;
                const dx = cm.cx - n.x;
                const dy = cm.cy - n.y;
                n.vx += dx * clusterStrength;
                n.vy += dy * clusterStrength;
            }
        }

        // -- Center gravity: gentle pull toward origin --
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i] === frozenNode || nodes[i].pinned || nodes[i].hidden || nodes[i].orphan) continue;
            nodes[i].vx -= nodes[i].x * GLOBAL_GRAVITY * gs.alpha;
            nodes[i].vy -= nodes[i].y * GLOBAL_GRAVITY * gs.alpha;
        }

        // -- Apply velocity + friction + clamp --
        let totalSpeed = 0;
        gs.maxDelta = 0;
        const bound = Math.max(gs.W, gs.H) * 3;
        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            if (n === frozenNode || n.pinned || n.hidden || n.orphan) continue;
            n.vx *= (1 - VELOCITY_DECAY);
            n.vy *= (1 - VELOCITY_DECAY);
            const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
            if (speed > MAX_DISP) { n.vx *= MAX_DISP / speed; n.vy *= MAX_DISP / speed; }
            n.x += n.vx; n.y += n.vy;
            n.x = Math.max(-bound, Math.min(bound, n.x));
            n.y = Math.max(-bound, Math.min(bound, n.y));
            totalSpeed += speed;
            gs.maxDelta = Math.max(gs.maxDelta, Math.abs(n.vx), Math.abs(n.vy));
        }

        // -- Collision --
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].hidden || nodes[i].orphan || nodes[i].pinned || nodes[i] === frozenNode) continue;
            const ri = gs.getNodeRadius(nodes[i]) * (nodes[i]._revealScale || 1) + COLLIDE_PAD;
            for (let j = i + 1; j < nodes.length; j++) {
                if (nodes[j].hidden || nodes[j].orphan) continue;
                const rj = gs.getNodeRadius(nodes[j]) * (nodes[j]._revealScale || 1) + COLLIDE_PAD;
                const minD = ri + rj;
                const ddx = nodes[j].x - nodes[i].x;
                const ddy = nodes[j].y - nodes[i].y;
                const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.1;
                if (dist < minD) {
                    const push = (minD - dist) * 0.35;
                    const nx = ddx / dist, ny = ddy / dist;
                    nodes[i].x -= nx * push; nodes[i].y -= ny * push;
                    if (!nodes[j].pinned && nodes[j] !== frozenNode) {
                        nodes[j].x += nx * push; nodes[j].y += ny * push;
                    }
                    gs.hasSpringEnergy = true;
                }
            }
        }
        gs.hasSpringEnergy = totalSpeed > Math.max(0.1, nodes.length * 0.005);

        // --- Auto-save layout once settled ---
        if (!gs.layoutSaved
            && gs.revealedBatch >= gs.revealBatches.length
            && gs.alpha < 0.05
            && gs.maxDelta < 0.5) {
            gs.layoutSaved = true;
            const positions = {};
            for (const n of nodes) {
                if (!n.orphan) positions[n.title] = { x: n.x, y: n.y };
            }
            gs.settings.graphSavedLayout = { positions, timestamp: Date.now() };
            invalidateSettingsCache();
            saveSettingsDebounced();
            // Show "Layout saved" on color legend, then CSS fade-out
            gs.layoutNotice = '✓ Layout saved';
            if (gs.updateTooltip) gs.updateTooltip();
            // Add fade-out class after a tick so the animation triggers
            requestAnimationFrame(() => {
                const el = gs.tooltipEl?.querySelector('.dle-graph-layout-notice');
                if (el) el.classList.add('dle-fade-out');
            });
            // Clear notice text after animation completes
            setTimeout(() => {
                if (gs.layoutNotice === '✓ Layout saved') {
                    gs.layoutNotice = '';
                    if (gs.updateTooltip) gs.updateTooltip();
                }
            }, 4000);
            // Auto-fit after settling
            if (gs.fitToView) gs.fitToView(true);
        }
    }

    return { simulate };
}
