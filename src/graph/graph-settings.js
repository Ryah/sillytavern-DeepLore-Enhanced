/**
 * DeepLore Enhanced — Graph settings panel module.
 * Normalized slider mapping, presets, settings panel wiring.
 */
import { invalidateSettingsCache } from '../../settings.js';
import { saveSettingsDebounced } from '../../../../../../script.js';

// ============================================================================
// Public API — call initGraphSettings(gs) after graph state is ready
// ============================================================================

/**
 * @param {object} gs  Shared graph state
 * @param {Function} dbg  Debug logger
 * @returns {{ syncSettingsPanel }}
 */
export function initGraphSettings(gs, dbg) {
    const { settings } = gs;
    const lOpt = { signal: gs.listenerAC.signal };

    // Helper: update a setting, persist, and refresh graph
    function updateSetting(key, value) {
        settings[key] = value;
        invalidateSettingsCache();
        saveSettingsDebounced();
        gs.needsDraw = true;
    }

    // ── Normalized slider mapping ──
    // Each slider is -100..+100. 0 = default. Negative = below default, positive = above.
    const sliderMaps = {
        dle_gs_repulsion:   { key: 'graphRepulsion',       min: 0.1,   def: 0.5,  max: 50,    round: 1, power: 1.5 },
        dle_gs_spring:      { key: 'graphSpringLength',    min: 30,    def: 200,  max: 600,   round: 0, power: 1 },
        dle_gs_gravity:     { key: 'graphGravity',         min: 0.1,   def: 5.0,  max: 20,    round: 1, power: 1.5 },
        dle_gs_damping:     { key: 'graphDamping',         min: 0.3,   def: 0.70, max: 0.98,  round: 2, power: 1 },
        dle_gs_hover_dim:   { key: 'graphHoverDimDistance', min: 0,     def: 2,    max: 15,    round: 0, power: 1 },
        dle_gs_dim_opacity: { key: 'graphHoverDimOpacity',  min: 0,     def: 0.1,  max: 0.9,   round: 2, power: 1.5 },
        dle_gs_tree_depth:  { key: 'graphFocusTreeDepth',  min: 0,     def: 2,    max: 15,    round: 0, power: 1 },
        dle_gs_edge_filter: { key: 'graphEdgeFilterAlpha', min: 0.01,  def: 0.05, max: 0.5,   round: 2, power: 1.5 },
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
            const t = (sliderVal + 100) / 100;
            v = map.min + Math.pow(t, p) * (map.def - map.min);
        } else {
            const t = sliderVal / 100;
            v = map.def + Math.pow(t, p) * (map.max - map.def);
        }
        if (map.round === 0) return Math.round(v);
        const factor = Math.pow(10, map.round);
        return Math.round(v * factor) / factor;
    }

    /** Format actual value for display */
    function formatActual(map, actual) {
        if (map.round === 0) return String(Math.round(actual));
        return actual.toFixed(map.round);
    }

    // Physics sliders restart simulation on change
    const physicsKeys = new Set(['graphRepulsion', 'graphSpringLength', 'graphGravity', 'graphDamping']);

    /** Update the backbone edge count display */
    function updateEdgeCount() {
        const el = document.getElementById('dle_gs_edge_count');
        if (el && gs._backboneCount != null) {
            el.textContent = `Backbone: ${gs._backboneCount} / ${gs.edges.length} edges`;
        }
    }

    const settingsPanel = document.getElementById('dle_graph_settings_panel');
    const settingsBtn = document.getElementById('dle_graph_settings_btn');
    const settingsCloseBtn = document.getElementById('dle_graph_settings_panel_close');
    const colorModeEl = document.getElementById('dle_graph_color_mode');

    // Sync panel controls from current settings
    function syncSettingsPanel() {
        const gsColorMode = document.getElementById('dle_gs_color_mode');
        if (gsColorMode) gsColorMode.value = gs.colorMode;

        const gsLabels = document.getElementById('dle_gs_labels');
        if (gsLabels) gsLabels.checked = gs.showLabels;

        for (const [id, map] of Object.entries(sliderMaps)) {
            const el = document.getElementById(id);
            const valEl = document.getElementById(id + '_val');
            const actual = settings[map.key] ?? map.def;
            if (el) el.value = actualToSlider(map, actual);
            if (valEl) valEl.textContent = formatActual(map, actual);
        }

        updateEdgeCount();
    }

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

        // Wire color mode
        const gsColorMode = document.getElementById('dle_gs_color_mode');
        if (gsColorMode) {
            gsColorMode.addEventListener('change', () => {
                gs.colorMode = gsColorMode.value;
                updateSetting('graphDefaultColorMode', gs.colorMode);
                if (colorModeEl) colorModeEl.value = gs.colorMode;
                gs.updateTooltip();
            }, lOpt);
        }

        // Wire labels
        const gsLabels = document.getElementById('dle_gs_labels');
        if (gsLabels) {
            gsLabels.addEventListener('change', () => {
                gs.showLabels = gsLabels.checked;
                updateSetting('graphShowLabels', gs.showLabels);
            }, lOpt);
        }

        // Wire all normalized sliders
        for (const [id, map] of Object.entries(sliderMaps)) {
            const el = document.getElementById(id);
            const valEl = document.getElementById(id + '_val');
            if (!el) continue;
            el.addEventListener('input', () => {
                const actual = sliderToActual(map, parseInt(el.value, 10));
                if (valEl) valEl.textContent = formatActual(map, actual);
                updateSetting(map.key, actual);
                if (physicsKeys.has(map.key)) gs.alpha = Math.max(gs.alpha, 0.5);
                if (map.key === 'graphEdgeFilterAlpha' && gs.recomputeBackbone) {
                    gs.recomputeBackbone(actual);
                    updateEdgeCount();
                }
                // Recompute hover distances live when interaction settings change
                if ((map.key === 'graphHoverDimDistance' || map.key === 'graphHoverDimOpacity') && gs.hoverNode && gs.computeHoverDistances) {
                    gs.hoverDistances = gs.computeHoverDistances(gs.hoverNode.id);
                }
            }, lOpt);
        }

        // Reset to defaults
        const resetBtn = document.getElementById('dle_gs_reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                for (const [, map] of Object.entries(sliderMaps)) {
                    updateSetting(map.key, map.def);
                }
                gs.colorMode = 'type';
                updateSetting('graphDefaultColorMode', 'type');
                if (colorModeEl) colorModeEl.value = 'type';
                gs.showLabels = true;
                updateSetting('graphShowLabels', true);
                gs.alpha = Math.max(gs.alpha, 0.5);
                if (gs.recomputeBackbone) gs.recomputeBackbone(0.05);
                syncSettingsPanel();
                dbg('Settings reset to defaults');
            }, lOpt);
        }

        // Presets — set all physics params at once
        const presets = {
            compact:    { graphRepulsion: 0.3, graphSpringLength: 80,  graphGravity: 8.0,  graphDamping: 0.70 },
            balanced:   { graphRepulsion: 0.5, graphSpringLength: 150, graphGravity: 5.0,  graphDamping: 0.70 },
            spacious:   { graphRepulsion: 1.0, graphSpringLength: 250, graphGravity: 3.0,  graphDamping: 0.65 },
            ginormous:  { graphRepulsion: 2.0, graphSpringLength: 400, graphGravity: 1.5,  graphDamping: 0.60 },
        };
        settingsPanel.querySelectorAll('.dle-gs-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = presets[btn.dataset.preset];
                if (!preset) return;
                for (const [key, value] of Object.entries(preset)) {
                    updateSetting(key, value);
                }
                gs.alpha = Math.max(gs.alpha, 0.5);
                syncSettingsPanel();
                dbg(`Preset applied: ${btn.dataset.preset}`);
            }, lOpt);
        });
    }

    return { syncSettingsPanel };
}
