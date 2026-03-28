/**
 * DeepLore Enhanced — Settings UI: load, bind, stats
 */
import {
    saveSettingsDebounced,
    chat,
} from '../../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../../shared.js';
import { escapeHtml } from '../../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { buildAiChatContext } from '../../core/utils.js';
import { getSettings, getPrimaryVault, DEFAULT_AI_SYSTEM_PROMPT, PROMPT_TAG_PREFIX, settingsConstraints, invalidateSettingsCache, defaultSettings } from '../../settings.js';
import { promptManager } from '../../../../../openai.js';
import { testConnection } from '../vault/obsidian-api.js';
import { testProxyConnection } from '../ai/proxy-api.js';
import {
    vaultIndex,
    computeOverallStatus,
    setVaultIndex, setIndexTimestamp, setLastHealthResult,
    onIndexUpdated, onAiStatsUpdated, onCircuitStateChanged,
} from '../state.js';
import { ensureIndexFresh } from '../vault/vault.js';
import {
    callViaProfile, getProfileModelHint,
    buildCandidateManifest,
} from '../ai/ai.js';
import { matchEntries } from '../pipeline/pipeline.js';
import { setupSyncPolling } from '../vault/sync.js';
import { buildIndexWithReuse } from '../vault/vault.js';
import { showNotebookPopup, showBrowsePopup } from './popups.js';
import { runHealthCheck } from './diagnostics.js';

// ============================================================================
// Vault List UI
// ============================================================================

/**
 * Render the dynamic vault list in the settings panel.
 * @param {object} settings
 */
function renderVaultList(settings, container = null) {
    container = container || document.getElementById('dle_vault_list');
    if (!container) return;

    const vaults = settings.vaults || [];
    let html = '';

    for (let i = 0; i < vaults.length; i++) {
        const v = vaults[i];
        html += `<div class="dle_vault_row" data-index="${i}">
            <div class="flex-container" style="gap: 6px; align-items: center;">
                <label class="checkbox_label" style="flex: 0 0 auto;" title="Enable/disable this vault">
                    <input type="checkbox" class="dle_vault_enabled checkbox" ${v.enabled ? 'checked' : ''} />
                </label>
                <input type="text" class="dle_vault_name text_pole" placeholder="Obsidian vault name" value="${escapeHtml(v.name)}" title="Must match your Obsidian vault name exactly (used for deep links)" style="flex: 1; min-width: 80px;" aria-label="Vault name" />
                <input type="text" class="dle_vault_host text_pole" placeholder="Host" value="${escapeHtml(v.host || '127.0.0.1')}" style="flex: 0 0 100px;" aria-label="Vault host" />
                <input type="number" class="dle_vault_port text_pole" placeholder="Port" value="${v.port}" min="1" max="65535" style="flex: 0 0 80px;" aria-label="Vault port" />
                <input type="password" class="dle_vault_key text_pole" placeholder="API Key" value="${escapeHtml(v.apiKey)}" style="flex: 2; min-width: 100px;" aria-label="API key" />
                <div class="dle_vault_test menu_button menu_button_icon" title="Test this vault" style="flex: 0 0 auto;" tabindex="0" aria-label="Test vault connection">
                    <i class="fa-solid fa-plug" aria-hidden="true"></i>
                </div>
                <div class="dle_vault_remove menu_button menu_button_icon" title="Remove this vault" style="flex: 0 0 auto;" tabindex="0" aria-label="Remove vault">
                    <i class="fa-solid fa-trash" aria-hidden="true"></i>
                </div>
            </div>
            <span class="dle_vault_status dle_status dle_text_sm"></span>
        </div>`;
    }

    container.innerHTML = html;
}

/**
 * Bind event handlers for the vault list UI (delegated events).
 * @param {object} settings
 */
function bindVaultListEvents(settings, $scope = null, $addBtn = null) {
    const container = $scope || $('#dle_vault_list');

    // Input changes on vault fields
    container.on('input', '.dle_vault_name, .dle_vault_host, .dle_vault_port, .dle_vault_key', function () {
        const row = $(this).closest('.dle_vault_row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;

        if ($(this).hasClass('dle_vault_name')) {
            let newName = String($(this).val()).trim() || 'Vault';
            // Validate unique vault names — prevent duplicates
            const otherNames = settings.vaults
                .filter((_, vi) => vi !== idx)
                .map(v => v.name.toLowerCase());
            if (otherNames.includes(newName.toLowerCase())) {
                // Append incrementing number to make it unique
                let counter = 2;
                while (otherNames.includes(`${newName} ${counter}`.toLowerCase())) {
                    counter++;
                }
                newName = `${newName} ${counter}`;
                $(this).val(newName);
                toastr.warning(`Vault name already in use. Renamed to "${newName}".`, 'DeepLore Enhanced', { timeOut: 4000 });
            }
            settings.vaults[idx].name = newName;
        } else if ($(this).hasClass('dle_vault_host')) {
            let hostVal = String($(this).val()).trim();
            hostVal = hostVal.replace(/^https?:\/\//, ''); // Strip protocol prefix
            hostVal = hostVal.replace(/:\d+$/, ''); // Strip port suffix if user pasted host:port
            settings.vaults[idx].host = hostVal || '127.0.0.1';
        } else if ($(this).hasClass('dle_vault_port')) {
            settings.vaults[idx].port = Math.max(1, Math.min(65535, numVal($(this).val(), 27123)));
        } else if ($(this).hasClass('dle_vault_key')) {
            settings.vaults[idx].apiKey = String($(this).val());
        }
        // Keep legacy fields in sync with primary vault
        const primary = getPrimaryVault(settings);
        settings.obsidianPort = primary.port;
        settings.obsidianApiKey = primary.apiKey;
        saveSettingsDebounced();
    });

    // Enable/disable toggle
    container.on('change', '.dle_vault_enabled', function () {
        const row = $(this).closest('.dle_vault_row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;
        settings.vaults[idx].enabled = $(this).prop('checked');
        const primary = getPrimaryVault(settings);
        settings.obsidianPort = primary.port;
        settings.obsidianApiKey = primary.apiKey;
        saveSettingsDebounced();
    });

    // Test individual vault
    container.on('click', '.dle_vault_test', async function () {
        const $btn = $(this);
        if ($btn.hasClass('disabled')) return;
        $btn.addClass('disabled');
        const row = $btn.closest('.dle_vault_row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) { $btn.removeClass('disabled'); return; }
        const vault = settings.vaults[idx];
        const statusEl = row.find('.dle_vault_status');
        statusEl.text('Testing...').removeClass('success failure');
        try {
            const data = await testConnection(vault.host, vault.port, vault.apiKey);
            if (data.ok) {
                statusEl.text(`Connected${data.authenticated ? '' : ' (no auth)'}`).addClass('success').removeClass('failure');
                announceToSR(`Vault ${vault.name} connected successfully.`);
            } else {
                statusEl.text(`Failed: ${data.error}`).addClass('failure').removeClass('success');
                announceToSR(`Vault ${vault.name} connection failed: ${data.error}`);
            }
        } catch (err) {
            statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success');
            announceToSR(`Vault ${vault.name} test error: ${err.message}`);
        } finally { $btn.removeClass('disabled'); }
    });

    // Remove vault (with confirmation)
    container.on('click', '.dle_vault_remove', async function () {
        const row = $(this).closest('.dle_vault_row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;
        if (settings.vaults.length <= 1) {
            toastr.warning('At least one vault connection is required. Add another vault before removing this one.', 'DeepLore Enhanced');
            return;
        }
        const vaultName = settings.vaults[idx].name || `Vault ${idx + 1}`;
        const confirmed = await callGenericPopup(
            `Remove vault "${escapeHtml(vaultName)}"? This cannot be undone.`,
            POPUP_TYPE.CONFIRM, '', { okButton: 'Remove', cancelButton: 'Cancel' },
        );
        if (!confirmed) return;
        settings.vaults.splice(idx, 1);
        const primary = getPrimaryVault(settings);
        settings.obsidianPort = primary.port;
        settings.obsidianApiKey = primary.apiKey;
        saveSettingsDebounced();
        renderVaultList(settings, container[0]);
    });

    // Add vault button
    const $addButton = $addBtn || $('#dle_add_vault');
    $addButton.on('click', function () {
        settings.vaults.push({ name: `Vault ${settings.vaults.length + 1}`, host: '127.0.0.1', port: 27123, apiKey: '', enabled: true });
        saveSettingsDebounced();
        renderVaultList(settings, container[0]);
    });
}

// ============================================================================
// Stats Display
// ============================================================================

/**
 * Announce a status message to screen readers via ARIA live region.
 * @param {string} message
 */
function announceToSR(message) {
    const el = document.getElementById('dle-drawer-live');
    if (el) el.textContent = message;
}

/** Status dot characters and labels for each overall status level. */
const STATUS_DISPLAY = {
    ok:       { dot: '\u{1F7E2}', label: 'OK',       title: 'All systems operational' },
    degraded: { dot: '\u{1F7E1}', label: 'Degraded',  title: 'Some vaults unreachable or health issues detected' },
    limited:  { dot: '\u{1F7E0}', label: 'Limited',   title: 'AI search temporarily paused or using stale cache' },
    offline:  { dot: '\u{1F534}', label: 'Offline',    title: 'No vaults reachable and no cached data' },
};

/** Update the header badge with entry count and overall status indicator. */
function updateHeaderBadge() {
    const headerBadge = document.getElementById('dle_header_badge');
    if (!headerBadge) return;

    if (vaultIndex.length > 0) {
        const status = computeOverallStatus();
        const info = STATUS_DISPLAY[status];
        headerBadge.textContent = `(${vaultIndex.length} entries | ${info.dot} ${info.label})`;
        headerBadge.title = info.title;
    } else {
        const status = computeOverallStatus();
        if (status === 'offline') {
            const info = STATUS_DISPLAY.offline;
            headerBadge.textContent = `(${info.dot} ${info.label})`;
            headerBadge.title = info.title;
        } else {
            headerBadge.textContent = '';
            headerBadge.title = '';
        }
    }
}

// ============================================================================
// Settings Popup
// ============================================================================

/**
 * Populate a profile dropdown within a specific container (works on detached DOM).
 */
function populateProfileDropdownIn($container, selectId, settingsKey) {
    const select = $container.find('#' + selectId)[0];
    if (!select) return;
    const settings = getSettings();
    const currentId = settings[settingsKey];
    select.innerHTML = '<option value="">— Select a profile —</option>';
    try {
        const profiles = ConnectionManagerRequestService.getSupportedProfiles();
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.api}${p.model ? ' / ' + p.model : ''})`;
            if (p.id === currentId) opt.selected = true;
            select.appendChild(opt);
        }
    } catch {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Connection Manager not available';
        opt.disabled = true;
        select.appendChild(opt);
    }
}

/**
 * Update visibility of connection fields within a container (works on detached DOM).
 */
function updateConnectionVisibilityIn($container, config) {
    const settings = getSettings();
    const mode = settings[config.modeSettingsKey] || (config.hasStMode ? 'st' : 'profile');
    const isProfile = mode === 'profile';
    const isProxy = mode === 'proxy';
    $container.find(config.profileRowSelector).toggle(isProfile);
    $container.find(config.proxyRowSelector).toggle(isProxy);
    if (config.externalOnlySelectors) {
        const isExternal = isProfile || isProxy;
        for (const sel of config.externalOnlySelectors) $container.find(sel).toggle(isExternal);
    }
    if (config.modelInputSelector) {
        const modelInput = $container.find(config.modelInputSelector);
        if (isProfile) {
            let hint = '';
            if (config.profileIdSettingsKey) {
                try {
                    const profileId = settings[config.profileIdSettingsKey];
                    if (profileId) hint = ConnectionManagerRequestService.getProfile(profileId).model || '';
                } catch { /* noop */ }
            }
            modelInput.attr('placeholder', hint ? `Profile: ${hint}` : 'Leave empty to use profile model');
        } else if (isProxy) {
            modelInput.attr('placeholder', 'claude-haiku-4-5-20251001');
        }
    }
}

function updatePopupModeVisibility($container, settings) {
    const aiEnabled = settings.aiSearchEnabled;
    const isProxy = settings.aiSearchConnectionMode === 'proxy';
    const isAiOnly = aiEnabled && settings.aiSearchMode === 'ai-only';
    $container.find('#dle_sp_scan_depth').closest('.flex-container').toggle(!isAiOnly);
    $container.find('#dle_sp_optimize_keys_mode').closest('.flex-container').toggleClass('dle-disabled', isAiOnly);
    $container.find('#dle_sp_ai_claude_prefix').closest('.checkbox_label').toggle(aiEnabled && isProxy);
    // Blur/overlay AI tab content when AI search is off
    const $aiPanel = $container.find('#dle-sp-ai');
    $container.find('#dle_sp_ai_disabled_notice').toggle(!aiEnabled);
    $aiPanel.find('.dle-ai-content-wrap').toggleClass('dle-blurred', !aiEnabled);
    $aiPanel.find('.dle-ai-content-wrap input, .dle-ai-content-wrap select, .dle-ai-content-wrap textarea, .dle-ai-content-wrap .menu_button').prop('disabled', !aiEnabled);
    // Source Tracking + Decay are always available (not AI-dependent)
    if (!aiEnabled) {
        $container.find('#dle_sp_show_sources, #dle_sp_decay_enabled').prop('disabled', false);
        $container.find('#dle_sp_decay_controls input').prop('disabled', !settings.decayEnabled);
    }
}

function updatePopupInjectionModeVisibility($container, settings) {
    const isPromptList = settings.injectionMode === 'prompt_list';
    $container.find('#dle_sp_extension_position_controls').toggle(!isPromptList);
    $container.find('#dle_sp_prompt_list_info').toggle(isPromptList);
    const nbControls = $container.find('#dle_sp_notebook_position_controls');
    nbControls.find('input, select').prop('disabled', isPromptList);
    nbControls.toggleClass('dle-disabled', isPromptList);
    $container.find('#dle_sp_notebook_pm_note').toggle(isPromptList);
}

function updatePopupIndexStats($container) {
    const statsEl = $container.find('#dle_sp_index_stats');
    if (statsEl.length === 0) return;
    if (vaultIndex.length > 0) {
        const totalKeys = vaultIndex.reduce((sum, e) => sum + e.keys.length, 0);
        const constants = vaultIndex.filter(e => e.constant).length;
        const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
        statsEl.text(`${vaultIndex.length} entries (${totalKeys} keywords, ${constants} always-send, ~${totalTokens} total tokens)`);
    } else {
        statsEl.text('No index loaded.');
    }
}

/**
 * Open the settings popup with tabbed layout and live data binding.
 */
export async function openSettingsPopup() {
    const html = await renderExtensionTemplateAsync(
        'third-party/sillytavern-DeepLore-Enhanced',
        'settings-popup',
    );
    const $container = $(html);

    // Tab switching helper
    function switchSettingsTab($tab) {
        const tab = $tab.data('settings-tab');
        $container.find('.dle-settings-tab').removeClass('active')
            .attr('aria-selected', 'false').attr('tabindex', '-1');
        $tab.addClass('active').attr('aria-selected', 'true').attr('tabindex', '0');
        $container.find('.dle-settings-panel').removeClass('active').attr('hidden', '');
        $container.find(`[data-settings-panel="${tab}"]`).addClass('active').removeAttr('hidden');
        localStorage.setItem('dle_last_settings_tab', tab);
    }

    // Restore last viewed tab
    const lastTab = localStorage.getItem('dle_last_settings_tab');
    if (lastTab) {
        const $lastTab = $container.find(`.dle-settings-tab[data-settings-tab="${lastTab}"]`);
        if ($lastTab.length) switchSettingsTab($lastTab);
    }

    $container.on('click', '.dle-settings-tab', function () { switchSettingsTab($(this)); });
    $container.on('keydown', '.dle-settings-tab', function (e) {
        const $tabs = $container.find('.dle-settings-tab');
        const idx = $tabs.index(this);
        let newIdx = idx;
        switch (e.key) {
            case 'ArrowDown': newIdx = (idx + 1) % $tabs.length; break;
            case 'ArrowUp': newIdx = (idx - 1 + $tabs.length) % $tabs.length; break;
            case 'Home': newIdx = 0; break;
            case 'End': newIdx = $tabs.length - 1; break;
            default: return;
        }
        e.preventDefault();
        const $newTab = $tabs.eq(newIdx);
        switchSettingsTab($newTab);
        $newTab.trigger('focus');
    });

    $container.find('.dle-settings-tab').attr('tabindex', '-1');
    $container.find('.dle-settings-tab.active').attr('tabindex', '0');
    $container.find('.dle-settings-panel').not('.active').attr('hidden', '');

    // "Go to Matching tab" link in AI disabled notice
    $container.on('click', '#dle_sp_goto_matching', function (e) {
        e.preventDefault();
        const $matchingTab = $container.find('[data-settings-tab="matching"]');
        switchSettingsTab($matchingTab);
        const $modeSelect = $container.find('#dle_sp_search_mode');
        $modeSelect.addClass('dle-pulse');
        setTimeout(() => $modeSelect.removeClass('dle-pulse'), 2000);
    });

    // Keyboard support for all role="button" elements (Enter/Space fires click)
    $container.on('keydown', '[role="button"][tabindex="0"]', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            $(this).trigger('click');
        }
    });

    // Advanced section toggles
    $container.on('click', '.dle_advanced_toggle', function () {
        const section = $(this).data('section');
        const $section = $container.find(`.dle_advanced_section[data-section="${section}"]`);
        const isOpen = $section.is(':visible');
        $section.slideToggle(200);
        $(this).attr('aria-expanded', String(!isOpen));
        $(this).find('.dle_advanced_icon')
            .toggleClass('fa-chevron-right', isOpen)
            .toggleClass('fa-chevron-down', !isOpen);
        const s = getSettings();
        if (!s.advancedVisible) s.advancedVisible = {};
        s.advancedVisible[section] = !isOpen;
        saveSettingsDebounced();
    });

    loadPopupSettings($container);
    bindPopupEvents($container);

    await callGenericPopup($container, POPUP_TYPE.DISPLAY, '', {
        large: true,
        wide: true,
        allowVerticalScrolling: true,
        onOpen: () => {
            // Click-outside-to-dismiss: clicking the ::backdrop area of the <dialog>
            // fires a click on the dialog element itself with target === dialog.
            const dlg = $container[0]?.closest('dialog');
            if (dlg) {
                dlg.addEventListener('click', (e) => {
                    if (e.target === dlg) {
                        saveSettingsDebounced();
                        dlg.querySelector('.popup-button-close')?.click();
                    }
                });
            }
        },
    });
}

// ============================================================================
// Popup: Load Settings
// ============================================================================

function loadPopupSettings($container) {
    const settings = getSettings();
    const $c = (sel) => $container.find(sel);

    // ── Connection ──
    $c('#dle_sp_enabled').prop('checked', settings.enabled);
    renderVaultList(settings, $c('#dle_sp_vault_list')[0]);
    $c('#dle_sp_multi_vault_conflict').val(settings.multiVaultConflictResolution);
    $c('#dle_sp_tag').val(settings.lorebookTag);
    $c('#dle_sp_constant_tag').val(settings.constantTag);
    $c('#dle_sp_never_insert_tag').val(settings.neverInsertTag);
    $c('#dle_sp_seed_tag').val(settings.seedTag);
    $c('#dle_sp_bootstrap_tag').val(settings.bootstrapTag);
    $c('#dle_sp_new_chat_threshold').val(settings.newChatThreshold);

    // ── Matching ──
    const searchMode = !settings.aiSearchEnabled ? 'keyword-only'
        : (settings.aiSearchMode === 'ai-only' ? 'ai-only' : 'two-stage');
    $c('#dle_sp_search_mode').val(searchMode);
    $c('#dle_sp_scan_depth').val(settings.scanDepth);
    $c('#dle_sp_char_context_scan').prop('checked', settings.characterContextScan);
    $c('#dle_sp_fuzzy_search').prop('checked', settings.fuzzySearchEnabled);
    $c('#dle_sp_fuzzy_min_score').val(settings.fuzzySearchMinScore);
    $c('#dle_sp_fuzzy_min_score_value').text((settings.fuzzySearchMinScore || 0.5).toFixed(1));
    $c('#dle_sp_fuzzy_min_score_row').toggle(settings.fuzzySearchEnabled);
    if (settings.fuzzySearchEnabled) runFuzzyPreview();
    $c('#dle_sp_unlimited_entries').prop('checked', settings.unlimitedEntries);
    $c('#dle_sp_max_entries').val(settings.maxEntries).prop('disabled', settings.unlimitedEntries);
    $c('#dle_sp_unlimited_budget').prop('checked', settings.unlimitedBudget);
    $c('#dle_sp_token_budget').val(settings.maxTokensBudget).prop('disabled', settings.unlimitedBudget);
    $c('#dle_sp_optimize_keys_mode').val(settings.optimizeKeysMode);
    $c('#dle_sp_case_sensitive').prop('checked', settings.caseSensitive);
    $c('#dle_sp_match_whole_words').prop('checked', settings.matchWholeWords);
    $c('#dle_sp_recursive_scan').prop('checked', settings.recursiveScan);
    $c('#dle_sp_max_recursion').val(settings.maxRecursionSteps).prop('disabled', !settings.recursiveScan);
    $c('#dle_sp_reinjection_cooldown').val(settings.reinjectionCooldown);
    $c('#dle_sp_strip_dedup').prop('checked', settings.stripDuplicateInjections);
    $c('#dle_sp_strip_lookback').val(settings.stripLookbackDepth).prop('disabled', !settings.stripDuplicateInjections);
    $c('#dle_sp_keyword_occurrence_weighting').prop('checked', settings.keywordOccurrenceWeighting);
    $c('#dle_sp_contextual_gating_tolerance').val(settings.contextualGatingTolerance);

    // ── Injection ──
    $c(`input[name="dle_sp_injection_mode"][value="${settings.injectionMode || 'extension'}"]`).prop('checked', true);
    updatePopupInjectionModeVisibility($container, settings);
    $c(`input[name="dle_sp_position"][value="${settings.injectionPosition}"]`).prop('checked', true);
    $c('#dle_sp_depth').val(settings.injectionDepth);
    $c('#dle_sp_role').val(settings.injectionRole);
    const isInChat = settings.injectionPosition === 1;
    $c('#dle_sp_depth, #dle_sp_role').prop('disabled', !isInChat).toggleClass('dle-disabled', !isInChat);
    $c('#dle_sp_template').val(settings.injectionTemplate);
    $c('#dle_sp_allow_wi_scan').prop('checked', settings.allowWIScan);

    // ── AI Search ──
    $c(`input[name="dle_sp_ai_connection_mode"][value="${settings.aiSearchConnectionMode}"]`).prop('checked', true);
    populateProfileDropdownIn($container, 'dle_sp_ai_profile_select', 'aiSearchProfileId');
    updateConnectionVisibilityIn($container, {
        modeSettingsKey: 'aiSearchConnectionMode',
        profileRowSelector: '#dle_sp_ai_profile_row',
        proxyRowSelector: '#dle_sp_ai_proxy_row',
        modelInputSelector: '#dle_sp_ai_model',
        profileIdSettingsKey: 'aiSearchProfileId',
    });
    $c('#dle_sp_ai_proxy_url').val(settings.aiSearchProxyUrl);
    $c('#dle_sp_ai_model').val(settings.aiSearchModel);
    $c('#dle_sp_ai_max_tokens').val(settings.aiSearchMaxTokens);
    $c('#dle_sp_ai_timeout').val(settings.aiSearchTimeout);
    $c('#dle_sp_ai_scan_depth').val(settings.aiSearchScanDepth);
    $c('#dle_sp_ai_system_prompt').val(settings.aiSearchSystemPrompt);
    $c('#dle_sp_ai_summary_length').val(settings.aiSearchManifestSummaryLength);
    $c('#dle_sp_ai_claude_prefix').prop('checked', settings.aiSearchClaudeCodePrefix);
    $c('#dle_sp_scribe_informed_retrieval').prop('checked', settings.scribeInformedRetrieval);
    $c('#dle_sp_ai_confidence_threshold').val(settings.aiConfidenceThreshold);
    $c('#dle_sp_hierarchical_aggressiveness').val(settings.hierarchicalAggressiveness);
    $c('#dle_sp_hierarchical_value').text(settings.hierarchicalAggressiveness);
    $c('#dle_sp_manifest_summary_mode').val(settings.manifestSummaryMode);
    $c('#dle_sp_ai_error_fallback').val(settings.aiErrorFallback);
    $c('#dle_sp_ai_empty_fallback').val(settings.aiEmptyFallback);
    $c('#dle_sp_show_sources').prop('checked', settings.showLoreSources);
    $c('#dle_sp_decay_enabled').prop('checked', settings.decayEnabled);
    $c('#dle_sp_decay_boost_threshold').val(settings.decayBoostThreshold);
    $c('#dle_sp_decay_penalty_threshold').val(settings.decayPenaltyThreshold);
    $c('#dle_sp_decay_controls').toggleClass('dle-dimmed', !settings.decayEnabled);
    $c('#dle_sp_decay_controls input').prop('disabled', !settings.decayEnabled);

    // ── Features — Graph ──
    $c('#dle_sp_graph_color_mode').val(settings.graphDefaultColorMode);
    $c('#dle_sp_graph_hover_dim_distance').val(settings.graphHoverDimDistance);
    $c('#dle_sp_graph_focus_tree_depth').val(settings.graphFocusTreeDepth);
    $c('#dle_sp_graph_show_labels').prop('checked', settings.graphShowLabels);
    $c('#dle_sp_graph_repulsion').val(settings.graphRepulsion);
    $c('#dle_sp_graph_spring_length').val(settings.graphSpringLength);
    $c('#dle_sp_graph_gravity').val(settings.graphGravity);
    $c('#dle_sp_graph_damping').val(settings.graphDamping);
    $c('#dle_sp_graph_hover_dim_opacity').val(settings.graphHoverDimOpacity);
    $c('#dle_sp_graph_edge_filter_alpha').val(settings.graphEdgeFilterAlpha);

    // ── Features — Notebook ──
    $c('#dle_sp_notebook_enabled').prop('checked', settings.notebookEnabled);
    $c(`input[name="dle_sp_notebook_position"][value="${settings.notebookPosition}"]`).prop('checked', true);
    $c('#dle_sp_notebook_depth').val(settings.notebookDepth);
    $c('#dle_sp_notebook_role').val(settings.notebookRole);
    if (!settings.notebookEnabled && settings.injectionMode !== 'prompt_list') {
        const nbControls = $c('#dle_sp_notebook_position_controls');
        nbControls.find('input, select').prop('disabled', true);
        nbControls.addClass('dle-dimmed');
    }

    // ── Features — Scribe ──
    $c('#dle_sp_scribe_enabled').prop('checked', settings.scribeEnabled);
    $c('#dle_sp_scribe_controls').find('input, textarea, select').prop('disabled', !settings.scribeEnabled);
    $c('#dle_sp_scribe_controls').find('.menu_button').toggleClass('disabled', !settings.scribeEnabled);
    $c('#dle_sp_scribe_interval').val(settings.scribeInterval);
    $c('#dle_sp_scribe_folder').val(settings.scribeFolder);
    $c(`input[name="dle_sp_scribe_connection_mode"][value="${settings.scribeConnectionMode}"]`).prop('checked', true);
    populateProfileDropdownIn($container, 'dle_sp_scribe_profile_select', 'scribeProfileId');
    updateConnectionVisibilityIn($container, {
        modeSettingsKey: 'scribeConnectionMode',
        profileRowSelector: '#dle_sp_scribe_profile_row',
        proxyRowSelector: '#dle_sp_scribe_proxy_row',
        modelInputSelector: '#dle_sp_scribe_model',
        profileIdSettingsKey: 'scribeProfileId',
        externalOnlySelectors: ['#dle_sp_scribe_model_row'],
        hasStMode: true,
    });
    $c('#dle_sp_scribe_proxy_url').val(settings.scribeProxyUrl);
    $c('#dle_sp_scribe_model').val(settings.scribeModel);
    $c('#dle_sp_scribe_max_tokens').val(settings.scribeMaxTokens);
    $c('#dle_sp_scribe_timeout').val(settings.scribeTimeout);
    $c('#dle_sp_scribe_scan_depth').val(settings.scribeScanDepth);
    $c('#dle_sp_scribe_prompt').val(settings.scribePrompt);

    // ── Features — Auto Lorebook ──
    $c('#dle_sp_autosuggest_enabled').prop('checked', settings.autoSuggestEnabled);
    $c('#dle_sp_autosuggest_controls').find('input, select').prop('disabled', !settings.autoSuggestEnabled);
    $c('#dle_sp_autosuggest_interval').val(settings.autoSuggestInterval);
    $c('#dle_sp_autosuggest_folder').val(settings.autoSuggestFolder);
    $c(`input[name="dle_sp_autosuggest_connection_mode"][value="${settings.autoSuggestConnectionMode}"]`).prop('checked', true);
    populateProfileDropdownIn($container, 'dle_sp_autosuggest_profile', 'autoSuggestProfileId');
    updateConnectionVisibilityIn($container, {
        modeSettingsKey: 'autoSuggestConnectionMode',
        profileRowSelector: '#dle_sp_autosuggest_profile_container',
        proxyRowSelector: '#dle_sp_autosuggest_proxy_container',
    });
    $c('#dle_sp_autosuggest_proxy_url').val(settings.autoSuggestProxyUrl);
    $c('#dle_sp_autosuggest_model').val(settings.autoSuggestModel);
    $c('#dle_sp_autosuggest_max_tokens').val(settings.autoSuggestMaxTokens);
    $c('#dle_sp_autosuggest_timeout').val(settings.autoSuggestTimeout);

    // ── System ──
    updatePopupIndexStats($container);
    $c('#dle_sp_cache_ttl').val(settings.cacheTTL);
    $c('#dle_sp_sync_interval').val(settings.syncPollingInterval);
    $c('#dle_sp_index_rebuild_trigger').val(settings.indexRebuildTrigger);
    $c('#dle_sp_rebuild_gen_interval').val(settings.indexRebuildGenerationInterval);
    // Show/hide rebuild trigger descriptions
    const showTrigger = (t) => {
        $c('#dle_sp_rebuild_trigger_ttl_desc').toggle(t === 'ttl');
        $c('#dle_sp_rebuild_trigger_gen_desc').toggle(t === 'generation');
        $c('#dle_sp_rebuild_trigger_manual_desc').toggle(t === 'manual');
        $c('#dle_sp_rebuild_gen_interval_row').toggle(t === 'generation');
    };
    showTrigger(settings.indexRebuildTrigger);
    $c('#dle_sp_show_sync_toasts').prop('checked', settings.showSyncToasts);
    $c('#dle_sp_review_tokens').val(settings.reviewResponseTokens);
    $c('#dle_sp_debug').prop('checked', settings.debugMode);

    // Migrate renamed data-section keys (D4 consistency fix)
    if (settings.advancedVisible) {
        const renames = { sp_vaultTags: 'sp_vault_tags', sp_aiSearch: 'sp_ai_search' };
        for (const [old, nw] of Object.entries(renames)) {
            if (old in settings.advancedVisible) {
                settings.advancedVisible[nw] = settings.advancedVisible[old];
                delete settings.advancedVisible[old];
            }
        }
    }

    // Restore advanced toggles
    const advVisible = settings.advancedVisible || {};
    $container.find('.dle_advanced_section').each(function () {
        const section = jQuery(this).data('section');
        if (advVisible[section]) {
            jQuery(this).show();
            jQuery(this).prev('.dle_advanced_toggle')
                .find('.dle_advanced_icon').removeClass('fa-chevron-right').addClass('fa-chevron-down');
            jQuery(this).prev('.dle_advanced_toggle').attr('aria-expanded', 'true');
        }
    });

    updatePopupModeVisibility($container, settings);
}

// ============================================================================
// Popup: Bind Events
// ============================================================================

/** Parse a numeric input value, returning fallback only when the value is truly non-numeric (not when it's 0). */
function numVal(raw, fallback) {
    const n = Number(raw);
    return Number.isNaN(n) ? fallback : n;
}

/**
 * Pure toy demo for the fuzzy strictness slider — no vault connection needed.
 * Uses real BM25 scoring (same k1/b/tokenizer as bm25.js) against a hardcoded
 * mini-corpus so users can see how the threshold controls which entries pass.
 * Also shows which specific words matched, so the user understands the mechanism.
 */
const FUZZY_TOY_CORPUS = [
    { title: 'Velmira the Blade',    content: 'A retired assassin who once served the shadow court. Now sells guild secrets to the highest bidder from a hidden safehouse.' },
    { title: 'The Hollow Fang',      content: 'A secretive assassin guild operating from the sewers beneath the capital. Members use shadow magic to vanish after completing a contract.' },
    { title: 'Nightveil District',   content: 'The shadow quarter of the capital where thieves and smugglers gather. Home to several guild halls and black market dealers.' },
    { title: 'Merchant Guild Prices', content: 'The official guild price list for trade across the realm. Establishes taxation and merchant protections for all five kingdoms.' },
    { title: 'Sunforge Cathedral',   content: 'A grand cathedral of golden spires dedicated to the sun goddess. Priests perform healing rituals. A shadow falls across the altar each equinox.' },
    { title: 'Starfall Academy',     content: 'A prestigious school for young mages perched on a cliffside. Students study elemental magic and arcane theory in ancient towers.' },
];
const FUZZY_TOY_QUERY = 'shadow assassin guild';
let _fuzzyToyScores = null;

/** Compute BM25 scores + matched words for the toy corpus once, reuse on slider changes. */
function getFuzzyToyScores() {
    if (_fuzzyToyScores) return _fuzzyToyScores;
    const k1 = 1.5, b = 0.75;
    const tokenize = t => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);
    const docs = FUZZY_TOY_CORPUS.map(e => {
        const tokens = tokenize(`${e.title} ${e.content}`);
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
        return { title: e.title, tf, len: tokens.length };
    });
    const N = docs.length;
    const avgDl = docs.reduce((s, d) => s + d.len, 0) / N;
    const df = new Map();
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    const idf = new Map();
    for (const [t, f] of df) idf.set(t, Math.log((N - f + 0.5) / (f + 0.5) + 1));
    const queryTerms = new Set(tokenize(FUZZY_TOY_QUERY));
    _fuzzyToyScores = docs.map(d => {
        let score = 0;
        const matchedWords = [];
        for (const term of queryTerms) {
            const termIdf = idf.get(term);
            if (!termIdf) continue;
            const tf = d.tf.get(term) || 0;
            if (tf === 0) continue;
            score += termIdf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.len / avgDl));
            matchedWords.push(term);
        }
        return { title: d.title, score, matchedWords };
    }).sort((a, b) => b.score - a.score);
    return _fuzzyToyScores;
}

function runFuzzyPreview() {
    const $results = $('#dle_sp_fuzzy_preview_results');
    if (!$results.length) return;

    const minScore = getSettings().fuzzySearchMinScore || 0.5;
    const scores = getFuzzyToyScores();

    let html = '<div style="margin-bottom:4px;">';
    html += '<small><i class="fa-solid fa-flask" style="color:var(--dle-info,#2196f3);"></i> <strong>How this works</strong>';
    html += ' <span class="dle_muted">— sample data, not your vault</span></small></div>';
    html += `<div style="margin-bottom:6px;"><small class="dle_muted">If a chat message said </small><small><strong>"${FUZZY_TOY_QUERY}"</strong></small><small class="dle_muted">, these entries would be checked:</small></div>`;

    html += '<table style="width:100%;border-collapse:collapse;">';
    html += '<tr style="border-bottom:1px solid var(--dle-border,#444);"><th style="text-align:left;padding:2px 4px;"><small>Entry</small></th><th style="text-align:left;padding:2px 4px;"><small>Words matched</small></th><th style="text-align:right;padding:2px 4px;"><small>Score</small></th><th style="text-align:center;padding:2px 4px;"></th></tr>';
    for (const e of scores) {
        const passes = e.score >= minScore;
        const icon = passes ? '✓' : '✗';
        const iconColor = passes ? 'var(--dle-success,#4caf50)' : 'var(--dle-error,#f44336)';
        const wordsHtml = e.matchedWords.length > 0
            ? e.matchedWords.map(w => `<span style="color:var(--dle-info,#2196f3);">${escapeHtml(w)}</span>`).join(', ')
            : '<span class="dle_muted">—</span>';
        html += `<tr style="opacity:${passes ? 1 : 0.5};">`;
        html += `<td style="padding:2px 4px;"><small>${escapeHtml(e.title)}</small></td>`;
        html += `<td style="padding:2px 4px;"><small>${wordsHtml}</small></td>`;
        html += `<td style="text-align:right;padding:2px 4px;"><small class="dle_muted">${e.score.toFixed(2)}</small></td>`;
        html += `<td style="text-align:center;padding:2px 4px;color:${iconColor};font-weight:bold;"><small>${icon}</small></td>`;
        html += '</tr>';
    }
    html += '</table>';
    $results.html(html);
}

function bindPopupEvents($container) {
    const settings = getSettings();
    const $c = (sel) => $container.find(sel);

    // Debounced index rebuild for tag inputs — avoids rebuilding on every keystroke
    let _rebuildTimer = null;
    const debouncedRebuild = () => { clearTimeout(_rebuildTimer); _rebuildTimer = setTimeout(() => buildIndexWithReuse(), 500); };

    $container.on('change input', 'input, select, textarea', () => invalidateSettingsCache());

    // ── Connection ──
    $c('#dle_sp_enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        setupSyncPolling(buildIndexWithReuse, buildIndexWithReuse);
        $('#dle_enabled').prop('checked', settings.enabled);
    });

    bindVaultListEvents(settings, $c('#dle_sp_vault_list'), $c('#dle_sp_add_vault'));
    $c('#dle_sp_multi_vault_conflict').on('change', function () { settings.multiVaultConflictResolution = String($(this).val()); saveSettingsDebounced(); });

    $c('#dle_sp_test_connection').on('click', async function () {
        const $btn = $(this);
        if ($btn.prop('disabled')) return;
        $btn.prop('disabled', true).addClass('disabled');
        const statusEl = $c('#dle_sp_connection_status');
        statusEl.text('Testing...').removeClass('success failure');
        try {
            const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
            if (enabledVaults.length === 0) throw new Error('No enabled vaults configured.');
            const results = [];
            for (const vault of enabledVaults) {
                try {
                    const data = await testConnection(vault.host, vault.port, vault.apiKey);
                    results.push({ name: vault.name, ok: data.ok, auth: data.authenticated, error: data.error });
                } catch (err) { results.push({ name: vault.name, ok: false, error: err.message }); }
            }
            const allOk = results.every(r => r.ok);
            const summary = results.map(r => `${r.name}: ${r.ok ? (r.auth ? 'OK' : 'OK (no auth)') : 'FAIL'}`).join(', ');
            statusEl.text(summary).toggleClass('success', allOk).toggleClass('failure', !allOk);
        } catch (err) { statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success'); }
        finally { $btn.prop('disabled', false).removeClass('disabled'); }
    });

    $c('#dle_sp_tag').on('input', function () { settings.lorebookTag = String($(this).val()).trim() || 'lorebook'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle_sp_constant_tag').on('input', function () { settings.constantTag = String($(this).val()).trim() || 'lorebook-always'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle_sp_never_insert_tag').on('input', function () { settings.neverInsertTag = String($(this).val()).trim() || 'lorebook-never'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle_sp_seed_tag').on('input', function () { settings.seedTag = String($(this).val()).trim() || 'lorebook-seed'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle_sp_bootstrap_tag').on('input', function () { settings.bootstrapTag = String($(this).val()).trim() || 'lorebook-bootstrap'; saveSettingsDebounced(); debouncedRebuild(); });
    $c('#dle_sp_new_chat_threshold').on('input', function () { settings.newChatThreshold = numVal($(this).val(), 3); saveSettingsDebounced(); });

    // ── Matching ──
    $c('#dle_sp_search_mode').on('change', function () { const mode = $(this).val(); settings.aiSearchEnabled = mode !== 'keyword-only'; settings.aiSearchMode = mode === 'ai-only' ? 'ai-only' : 'two-stage'; saveSettingsDebounced(); updatePopupModeVisibility($container, settings); });
    $c('#dle_sp_scan_depth').on('input', function () { settings.scanDepth = numVal($(this).val(), 4); saveSettingsDebounced(); });
    $c('#dle_sp_char_context_scan').on('change', function () { settings.characterContextScan = $(this).is(':checked'); saveSettingsDebounced(); });
    $c('#dle_sp_fuzzy_search').on('change', function () { settings.fuzzySearchEnabled = $(this).is(':checked'); $c('#dle_sp_fuzzy_min_score_row').toggle(settings.fuzzySearchEnabled); saveSettingsDebounced(); buildIndexWithReuse(); });
    $c('#dle_sp_fuzzy_min_score').on('input', function () {
        const v = parseFloat($(this).val());
        settings.fuzzySearchMinScore = v;
        $c('#dle_sp_fuzzy_min_score_value').text(v.toFixed(1));
        saveSettingsDebounced();
        runFuzzyPreview();
    });
    $c('#dle_sp_unlimited_entries').on('change', function () { settings.unlimitedEntries = $(this).prop('checked'); $c('#dle_sp_max_entries').prop('disabled', settings.unlimitedEntries); saveSettingsDebounced(); });
    $c('#dle_sp_max_entries').on('input', function () { settings.maxEntries = numVal($(this).val(), 10); saveSettingsDebounced(); });
    $c('#dle_sp_unlimited_budget').on('change', function () { settings.unlimitedBudget = $(this).prop('checked'); $c('#dle_sp_token_budget').prop('disabled', settings.unlimitedBudget); saveSettingsDebounced(); });
    $c('#dle_sp_token_budget').on('input', function () { settings.maxTokensBudget = numVal($(this).val(), 2048); saveSettingsDebounced(); });
    $c('#dle_sp_optimize_keys_mode').on('change', function () { settings.optimizeKeysMode = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle_sp_case_sensitive').on('change', function () { settings.caseSensitive = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle_sp_match_whole_words').on('change', function () { settings.matchWholeWords = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle_sp_recursive_scan').on('change', function () { settings.recursiveScan = $(this).prop('checked'); $c('#dle_sp_max_recursion').prop('disabled', !settings.recursiveScan); saveSettingsDebounced(); });
    $c('#dle_sp_max_recursion').on('input', function () { settings.maxRecursionSteps = numVal($(this).val(), 3); saveSettingsDebounced(); });
    $c('#dle_sp_reinjection_cooldown').on('input', function () { settings.reinjectionCooldown = numVal($(this).val(), 0); saveSettingsDebounced(); });
    $c('#dle_sp_strip_dedup').on('change', function () { settings.stripDuplicateInjections = $(this).prop('checked'); $c('#dle_sp_strip_lookback').prop('disabled', !settings.stripDuplicateInjections); saveSettingsDebounced(); });
    $c('#dle_sp_strip_lookback').on('input', function () { settings.stripLookbackDepth = numVal($(this).val(), 2); saveSettingsDebounced(); });
    $c('#dle_sp_keyword_occurrence_weighting').on('change', function () { settings.keywordOccurrenceWeighting = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle_sp_contextual_gating_tolerance').on('change', function () { settings.contextualGatingTolerance = String($(this).val()); saveSettingsDebounced(); });

    // ── Injection ──
    $c('input[name="dle_sp_injection_mode"]').on('change', function () {
        const oldMode = settings.injectionMode;
        settings.injectionMode = String($(this).val());
        // H16: Clean up stale PM entries when switching away from prompt_list mode
        if (oldMode === 'prompt_list' && settings.injectionMode !== 'prompt_list' && promptManager) {
            for (const id of [`${PROMPT_TAG_PREFIX}constants`, `${PROMPT_TAG_PREFIX}lore`, 'deeplore_notebook']) {
                const pmEntry = promptManager.getPromptById(id);
                if (pmEntry) pmEntry.content = '';
            }
        }
        updatePopupInjectionModeVisibility($container, settings);
        saveSettingsDebounced();
    });
    $c('input[name="dle_sp_position"]').on('change', function () { settings.injectionPosition = Number($(this).val()); const inChat = settings.injectionPosition === 1; $c('#dle_sp_depth, #dle_sp_role').prop('disabled', !inChat).toggleClass('dle-disabled', !inChat); saveSettingsDebounced(); });
    $c('#dle_sp_depth').on('input', function () { settings.injectionDepth = numVal($(this).val(), 4); saveSettingsDebounced(); });
    $c('#dle_sp_role').on('change', function () { settings.injectionRole = numVal($(this).val(), 0); saveSettingsDebounced(); });
    $c('#dle_sp_template').on('input', function () { settings.injectionTemplate = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle_sp_allow_wi_scan').on('change', function () { settings.allowWIScan = $(this).prop('checked'); saveSettingsDebounced(); });

    // ── AI Search ──
    $c('input[name="dle_sp_ai_connection_mode"]').on('change', function () {
        settings.aiSearchConnectionMode = $c('input[name="dle_sp_ai_connection_mode"]:checked').val();
        saveSettingsDebounced();
        updateConnectionVisibilityIn($container, { modeSettingsKey: 'aiSearchConnectionMode', profileRowSelector: '#dle_sp_ai_profile_row', proxyRowSelector: '#dle_sp_ai_proxy_row', modelInputSelector: '#dle_sp_ai_model', profileIdSettingsKey: 'aiSearchProfileId' });
        updatePopupModeVisibility($container, settings);
    });
    $c('#dle_sp_ai_profile_select').on('change', function () { settings.aiSearchProfileId = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle_sp_ai_proxy_url').on('input', function () { settings.aiSearchProxyUrl = String($(this).val()).trim() || 'http://localhost:42069'; saveSettingsDebounced(); });
    $c('#dle_sp_ai_model').on('input', function () { settings.aiSearchModel = String($(this).val()).trim(); saveSettingsDebounced(); });
    $c('#dle_sp_ai_max_tokens').on('input', function () { settings.aiSearchMaxTokens = numVal($(this).val(), 1024); saveSettingsDebounced(); });
    $c('#dle_sp_ai_timeout').on('input', function () { settings.aiSearchTimeout = numVal($(this).val(), 10000); saveSettingsDebounced(); });
    $c('#dle_sp_ai_scan_depth').on('input', function () { settings.aiSearchScanDepth = numVal($(this).val(), 4); saveSettingsDebounced(); });
    $c('#dle_sp_ai_system_prompt').on('input', function () { settings.aiSearchSystemPrompt = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle_sp_ai_summary_length').on('input', function () { settings.aiSearchManifestSummaryLength = numVal($(this).val(), 600); saveSettingsDebounced(); });
    $c('#dle_sp_ai_claude_prefix').on('change', function () { settings.aiSearchClaudeCodePrefix = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle_sp_scribe_informed_retrieval').on('change', function () { settings.scribeInformedRetrieval = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle_sp_ai_confidence_threshold').on('change', function () { settings.aiConfidenceThreshold = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle_sp_hierarchical_aggressiveness').on('input', function () { const v = parseFloat($(this).val()); settings.hierarchicalAggressiveness = v; $c('#dle_sp_hierarchical_value').text(v.toFixed(1)); saveSettingsDebounced(); });
    $c('#dle_sp_manifest_summary_mode').on('change', function () { settings.manifestSummaryMode = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle_sp_ai_error_fallback').on('change', function () { settings.aiErrorFallback = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle_sp_ai_empty_fallback').on('change', function () { settings.aiEmptyFallback = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle_sp_show_sources').on('change', function () { settings.showLoreSources = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle_sp_decay_enabled').on('change', function () { settings.decayEnabled = $(this).prop('checked'); saveSettingsDebounced(); $c('#dle_sp_decay_controls').toggleClass('dle-dimmed', !settings.decayEnabled); $c('#dle_sp_decay_controls input').prop('disabled', !settings.decayEnabled); });
    $c('#dle_sp_decay_boost_threshold').on('input', function () { settings.decayBoostThreshold = numVal($(this).val(), 5); saveSettingsDebounced(); });
    $c('#dle_sp_decay_penalty_threshold').on('input', function () { settings.decayPenaltyThreshold = numVal($(this).val(), 2); saveSettingsDebounced(); });

    // ── Graph settings ──
    $c('#dle_sp_graph_color_mode').on('change', function () { settings.graphDefaultColorMode = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle_sp_graph_hover_dim_distance').on('input', function () { settings.graphHoverDimDistance = numVal($(this).val(), 2); saveSettingsDebounced(); });
    $c('#dle_sp_graph_focus_tree_depth').on('input', function () { settings.graphFocusTreeDepth = numVal($(this).val(), 3); saveSettingsDebounced(); });
    $c('#dle_sp_graph_show_labels').on('change', function () { settings.graphShowLabels = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle_sp_graph_repulsion').on('input', function () { settings.graphRepulsion = parseFloat($(this).val()) || 0.5; saveSettingsDebounced(); });
    $c('#dle_sp_graph_spring_length').on('input', function () { settings.graphSpringLength = numVal($(this).val(), 200); saveSettingsDebounced(); });
    $c('#dle_sp_graph_gravity').on('input', function () { settings.graphGravity = parseFloat($(this).val()) || 5.0; saveSettingsDebounced(); });
    $c('#dle_sp_graph_damping').on('input', function () { settings.graphDamping = parseFloat($(this).val()) || 0.70; saveSettingsDebounced(); });
    $c('#dle_sp_graph_hover_dim_opacity').on('input', function () { settings.graphHoverDimOpacity = parseFloat($(this).val()) || 0.1; saveSettingsDebounced(); });
    $c('#dle_sp_graph_edge_filter_alpha').on('input', function () { settings.graphEdgeFilterAlpha = parseFloat($(this).val()) || 0.05; saveSettingsDebounced(); });

    // Test AI / Preview
    $c('#dle_sp_test_ai').on('click', async function () {
        const $btn = $(this);
        if ($btn.prop('disabled')) return;
        $btn.prop('disabled', true).addClass('disabled');
        const statusEl = $c('#dle_sp_ai_status');
        statusEl.text('Testing...').removeClass('success failure');
        try {
            if (settings.aiSearchConnectionMode === 'profile') {
                if (!settings.aiSearchProfileId) throw new Error('No connection profile selected');
                await callViaProfile('You are a test assistant. Respond with exactly: {"ok": true}', 'Test. Respond: {"ok": true}', 64, settings.aiSearchTimeout);
                const m = getProfileModelHint(); statusEl.text(`Connected${m ? ' (' + m + ')' : ''}`).addClass('success').removeClass('failure');
            } else {
                const data = await testProxyConnection(settings.aiSearchProxyUrl, settings.aiSearchModel || 'claude-haiku-4-5-20251001');
                statusEl.text(data.ok ? 'Connected' : `Failed: ${data.error}`).toggleClass('success', data.ok).toggleClass('failure', !data.ok);
            }
        } catch (err) { statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success'); }
        finally { $btn.prop('disabled', false).removeClass('disabled'); }
    });

    $c('#dle_sp_preview_ai').on('click', async function () {
        if (!chat || chat.length === 0) { toastr.info('No active chat.', 'DeepLore Enhanced'); return; }
        await ensureIndexFresh();
        if (vaultIndex.length === 0) { toastr.info('No entries indexed.', 'DeepLore Enhanced'); return; }
        let candidateManifest, candidateHeader, modeLabel;
        if (settings.aiSearchMode === 'ai-only') { const r = buildCandidateManifest(vaultIndex); candidateManifest = r.manifest; candidateHeader = r.header; modeLabel = 'AI-only (full vault)'; }
        else { const kr = matchEntries(chat); const nc = kr.matched.filter(e => !e.constant); if (nc.length === 0) { toastr.warning('No entries matched the current chat. Try /dle-simulate for details.', 'DeepLore Enhanced'); return; } const r = buildCandidateManifest(kr.matched); candidateManifest = r.manifest; candidateHeader = r.header; modeLabel = `Two-stage (${nc.length} candidates)`; }
        const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);
        const maxE = settings.unlimitedEntries ? 'as many as are relevant' : String(settings.maxEntries);
        let sp = (settings.aiSearchSystemPrompt && settings.aiSearchSystemPrompt.trim()) || DEFAULT_AI_SYSTEM_PROMPT;
        if (settings.aiSearchClaudeCodePrefix && settings.aiSearchConnectionMode === 'proxy' && !sp.startsWith('You are Claude Code')) sp = 'You are Claude Code. ' + sp;
        sp = sp.replace(/\{\{maxEntries\}\}/g, maxE);
        const hdr = candidateHeader ? `## Manifest Info\n${candidateHeader}\n\n` : '';
        const um = `${hdr}## Recent Chat\n${chatContext}\n\n## Candidate Lore Entries\n${candidateManifest}\n\nSelect the relevant entries as a JSON array.`;
        callGenericPopup(`<div class="dle-popup dle-popup--mono"><h3>Mode: ${escapeHtml(modeLabel)}</h3><h3>System Prompt</h3><div class="dle-preview dle-preview--short" style="margin-bottom:15px">${escapeHtml(sp)}</div><h3>User Message</h3><div class="dle-preview dle-preview--tall">${escapeHtml(um)}</div></div>`, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    });

    // ── Features — Notebook ──
    $c('#dle_sp_notebook_enabled').on('change', function () {
        settings.notebookEnabled = $(this).prop('checked'); saveSettingsDebounced();
        const nbControls = $c('#dle_sp_notebook_position_controls');
        const isPromptList = settings.injectionMode === 'prompt_list';
        if (!isPromptList) {
            nbControls.find('input, select').prop('disabled', !settings.notebookEnabled);
            nbControls.toggleClass('dle-dimmed', !settings.notebookEnabled);
        }
    });
    $c('input[name="dle_sp_notebook_position"]').on('change', function () { settings.notebookPosition = Number($(this).val()); saveSettingsDebounced(); });
    $c('#dle_sp_notebook_depth').on('input', function () { settings.notebookDepth = numVal($(this).val(), 0); saveSettingsDebounced(); });
    $c('#dle_sp_notebook_role').on('change', function () { settings.notebookRole = numVal($(this).val(), 0); saveSettingsDebounced(); });
    $c('#dle_sp_open_notebook').on('click', function () { if (!settings.notebookEnabled) { toastr.warning('Enable the Notebook checkbox above to use this feature.', 'DeepLore Enhanced'); return; } showNotebookPopup(); });

    // ── Features — Scribe ──
    $c('#dle_sp_scribe_enabled').on('change', function () {
        settings.scribeEnabled = $(this).prop('checked'); saveSettingsDebounced();
        $c('#dle_sp_scribe_controls').find('input, textarea, select').prop('disabled', !settings.scribeEnabled);
        $c('#dle_sp_scribe_controls').find('.menu_button').toggleClass('disabled', !settings.scribeEnabled);
        if (settings.scribeEnabled) updateConnectionVisibilityIn($container, { modeSettingsKey: 'scribeConnectionMode', profileRowSelector: '#dle_sp_scribe_profile_row', proxyRowSelector: '#dle_sp_scribe_proxy_row', modelInputSelector: '#dle_sp_scribe_model', profileIdSettingsKey: 'scribeProfileId', externalOnlySelectors: ['#dle_sp_scribe_model_row'], hasStMode: true });
    });
    $c('#dle_sp_scribe_interval').on('input', function () { settings.scribeInterval = numVal($(this).val(), 5); saveSettingsDebounced(); });
    $c('#dle_sp_scribe_folder').on('input', function () { settings.scribeFolder = String($(this).val()).trim() || 'Sessions'; saveSettingsDebounced(); });
    $c('#dle_sp_scribe_prompt').on('input', function () { settings.scribePrompt = String($(this).val()); saveSettingsDebounced(); });
    $c('input[name="dle_sp_scribe_connection_mode"]').on('change', function () { settings.scribeConnectionMode = $c('input[name="dle_sp_scribe_connection_mode"]:checked').val(); saveSettingsDebounced(); updateConnectionVisibilityIn($container, { modeSettingsKey: 'scribeConnectionMode', profileRowSelector: '#dle_sp_scribe_profile_row', proxyRowSelector: '#dle_sp_scribe_proxy_row', modelInputSelector: '#dle_sp_scribe_model', profileIdSettingsKey: 'scribeProfileId', externalOnlySelectors: ['#dle_sp_scribe_model_row'], hasStMode: true }); });
    $c('#dle_sp_scribe_profile_select').on('change', function () { settings.scribeProfileId = String($(this).val()); saveSettingsDebounced(); });
    $c('#dle_sp_scribe_proxy_url').on('input', function () { settings.scribeProxyUrl = String($(this).val()).trim() || 'http://localhost:42069'; saveSettingsDebounced(); });
    $c('#dle_sp_scribe_model').on('input', function () { settings.scribeModel = String($(this).val()).trim(); saveSettingsDebounced(); });
    $c('#dle_sp_scribe_max_tokens').on('input', function () { settings.scribeMaxTokens = numVal($(this).val(), 1024); saveSettingsDebounced(); });
    $c('#dle_sp_scribe_timeout').on('input', function () { settings.scribeTimeout = numVal($(this).val(), 30000); saveSettingsDebounced(); });
    $c('#dle_sp_scribe_scan_depth').on('input', function () { settings.scribeScanDepth = numVal($(this).val(), 20); saveSettingsDebounced(); });

    // ── Features — Auto Lorebook ──
    $c('#dle_sp_autosuggest_enabled').on('change', function () {
        settings.autoSuggestEnabled = $(this).prop('checked'); saveSettingsDebounced();
        $c('#dle_sp_autosuggest_controls').find('input, select').prop('disabled', !settings.autoSuggestEnabled);
        if (settings.autoSuggestEnabled) updateConnectionVisibilityIn($container, { modeSettingsKey: 'autoSuggestConnectionMode', profileRowSelector: '#dle_sp_autosuggest_profile_container', proxyRowSelector: '#dle_sp_autosuggest_proxy_container' });
    });
    $c('#dle_sp_autosuggest_interval').on('input', function () { settings.autoSuggestInterval = numVal($(this).val(), 10); saveSettingsDebounced(); });
    $c('#dle_sp_autosuggest_folder').on('input', function () { settings.autoSuggestFolder = String($(this).val()).trim(); saveSettingsDebounced(); });
    $c('input[name="dle_sp_autosuggest_connection_mode"]').on('change', function () { settings.autoSuggestConnectionMode = $(this).val(); saveSettingsDebounced(); updateConnectionVisibilityIn($container, { modeSettingsKey: 'autoSuggestConnectionMode', profileRowSelector: '#dle_sp_autosuggest_profile_container', proxyRowSelector: '#dle_sp_autosuggest_proxy_container' }); });
    $c('#dle_sp_autosuggest_profile').on('change', function () { settings.autoSuggestProfileId = $(this).val(); saveSettingsDebounced(); });
    $c('#dle_sp_autosuggest_proxy_url').on('input', function () { settings.autoSuggestProxyUrl = String($(this).val()).trim(); saveSettingsDebounced(); });
    $c('#dle_sp_autosuggest_model').on('input', function () { settings.autoSuggestModel = String($(this).val()).trim(); saveSettingsDebounced(); });
    $c('#dle_sp_autosuggest_max_tokens').on('input', function () { settings.autoSuggestMaxTokens = numVal($(this).val(), 2048); saveSettingsDebounced(); });
    $c('#dle_sp_autosuggest_timeout').on('input', function () { settings.autoSuggestTimeout = numVal($(this).val(), 30000); saveSettingsDebounced(); });

    // Copy from AI Search buttons
    $container.on('click', '.dle-copy-ai-btn', function () {
        const target = $(this).data('copy-target');
        const mode = settings.aiSearchConnectionMode;
        if (target === 'scribe') {
            settings.scribeConnectionMode = mode; settings.scribeProfileId = settings.aiSearchProfileId; settings.scribeProxyUrl = settings.aiSearchProxyUrl; settings.scribeModel = settings.aiSearchModel;
            $c(`input[name="dle_sp_scribe_connection_mode"][value="${mode}"]`).prop('checked', true); $c('#dle_sp_scribe_proxy_url').val(settings.scribeProxyUrl); $c('#dle_sp_scribe_model').val(settings.scribeModel);
            populateProfileDropdownIn($container, 'dle_sp_scribe_profile_select', 'scribeProfileId');
            updateConnectionVisibilityIn($container, { modeSettingsKey: 'scribeConnectionMode', profileRowSelector: '#dle_sp_scribe_profile_row', proxyRowSelector: '#dle_sp_scribe_proxy_row', modelInputSelector: '#dle_sp_scribe_model', profileIdSettingsKey: 'scribeProfileId', externalOnlySelectors: ['#dle_sp_scribe_model_row'], hasStMode: true });
        } else if (target === 'autosuggest') {
            settings.autoSuggestConnectionMode = mode; settings.autoSuggestProfileId = settings.aiSearchProfileId; settings.autoSuggestProxyUrl = settings.aiSearchProxyUrl; settings.autoSuggestModel = settings.aiSearchModel;
            $c(`input[name="dle_sp_autosuggest_connection_mode"][value="${mode}"]`).prop('checked', true); $c('#dle_sp_autosuggest_proxy_url').val(settings.autoSuggestProxyUrl); $c('#dle_sp_autosuggest_model').val(settings.autoSuggestModel);
            populateProfileDropdownIn($container, 'dle_sp_autosuggest_profile', 'autoSuggestProfileId');
            updateConnectionVisibilityIn($container, { modeSettingsKey: 'autoSuggestConnectionMode', profileRowSelector: '#dle_sp_autosuggest_profile_container', proxyRowSelector: '#dle_sp_autosuggest_proxy_container' });
        }
        invalidateSettingsCache(); saveSettingsDebounced();
        toastr.success('Connection settings copied from AI Search.', 'DeepLore Enhanced');
    });

    // ── System ──
    $c('#dle_sp_refresh').on('click', async function () {
        const $btn = $(this), $icon = $btn.find('i');
        $btn.prop('disabled', true); $icon.removeClass('fa-rotate').addClass('fa-spinner fa-spin');
        try { setVaultIndex([]); setIndexTimestamp(0); await buildIndexWithReuse(); toastr.success(`Indexed ${vaultIndex.length} entries.`, 'DeepLore Enhanced'); updatePopupIndexStats($container); }
        catch (err) { toastr.error(String(err), 'DeepLore Enhanced'); }
        finally { $btn.prop('disabled', false); $icon.removeClass('fa-spinner fa-spin').addClass('fa-rotate'); }
    });
    $c('#dle_sp_browse_entries').on('click', () => showBrowsePopup());
    $c('#dle_sp_test_match').on('click', () => toastr.info('Use /dle-simulate in chat for a full match test.', 'DeepLore Enhanced'));
    $c('#dle_sp_cache_ttl').on('input', function () { settings.cacheTTL = numVal($(this).val(), 300); saveSettingsDebounced(); });
    $c('#dle_sp_sync_interval').on('input', function () { settings.syncPollingInterval = numVal($(this).val(), 0); saveSettingsDebounced(); setupSyncPolling(buildIndexWithReuse, buildIndexWithReuse); });
    $c('#dle_sp_index_rebuild_trigger').on('change', function () {
        settings.indexRebuildTrigger = String($(this).val());
        $c('#dle_sp_rebuild_trigger_ttl_desc').toggle(settings.indexRebuildTrigger === 'ttl');
        $c('#dle_sp_rebuild_trigger_gen_desc').toggle(settings.indexRebuildTrigger === 'generation');
        $c('#dle_sp_rebuild_trigger_manual_desc').toggle(settings.indexRebuildTrigger === 'manual');
        $c('#dle_sp_rebuild_gen_interval_row').toggle(settings.indexRebuildTrigger === 'generation');
        saveSettingsDebounced();
    });
    $c('#dle_sp_rebuild_gen_interval').on('input', function () { settings.indexRebuildGenerationInterval = numVal($(this).val(), 10); saveSettingsDebounced(); });
    $c('#dle_sp_show_sync_toasts').on('change', function () { settings.showSyncToasts = $(this).prop('checked'); saveSettingsDebounced(); });
    $c('#dle_sp_review_tokens').on('input', function () { settings.reviewResponseTokens = numVal($(this).val(), 0); saveSettingsDebounced(); });
    $c('#dle_sp_debug').on('change', function () { settings.debugMode = $(this).prop('checked'); saveSettingsDebounced(); });

    // ── Reset All Settings ──
    $c('#dle_sp_reset_defaults').on('click', async function () {
        const confirmed = await callGenericPopup(
            '<div style="text-align:center;"><p><strong>Reset all DeepLore Enhanced settings to defaults?</strong></p><p>This cannot be undone. Your vault connections and AI connection profiles will be preserved.</p></div>',
            POPUP_TYPE.CONFIRM, '', { okButton: 'Reset', cancelButton: 'Cancel' },
        );
        if (!confirmed) return;

        // Preserve all connection settings (vault + AI profiles/proxies)
        const savedVaults = JSON.parse(JSON.stringify(settings.vaults || []));
        const savedPort = settings.obsidianPort;
        const savedKey = settings.obsidianApiKey;
        const savedConnections = {
            aiSearchConnectionMode: settings.aiSearchConnectionMode,
            aiSearchProfileId: settings.aiSearchProfileId,
            aiSearchProxyUrl: settings.aiSearchProxyUrl,
            aiSearchModel: settings.aiSearchModel,
            scribeConnectionMode: settings.scribeConnectionMode,
            scribeProfileId: settings.scribeProfileId,
            scribeProxyUrl: settings.scribeProxyUrl,
            scribeModel: settings.scribeModel,
            autoSuggestConnectionMode: settings.autoSuggestConnectionMode,
            autoSuggestProfileId: settings.autoSuggestProfileId,
            autoSuggestProxyUrl: settings.autoSuggestProxyUrl,
            autoSuggestModel: settings.autoSuggestModel,
        };

        // Reset all settings to defaults
        for (const [key, value] of Object.entries(defaultSettings)) {
            settings[key] = (typeof value === 'object' && value !== null)
                ? JSON.parse(JSON.stringify(value))
                : value;
        }

        // Restore all connection settings
        settings.vaults = savedVaults;
        settings.obsidianPort = savedPort;
        settings.obsidianApiKey = savedKey;
        settings._vaultsMigrated = true;
        Object.assign(settings, savedConnections);

        invalidateSettingsCache();
        saveSettingsDebounced();

        // Reload the popup contents
        loadPopupSettings($container);
        toastr.success('All settings reset to defaults. Connections preserved.', 'DeepLore Enhanced');
    });

    // Visual clamping
    const clampMap = {
        dle_sp_scan_depth: 'scanDepth', dle_sp_max_entries: 'maxEntries', dle_sp_token_budget: 'maxTokensBudget',
        dle_sp_depth: 'injectionDepth', dle_sp_notebook_depth: 'notebookDepth', dle_sp_max_recursion: 'maxRecursionSteps',
        dle_sp_cache_ttl: 'cacheTTL', dle_sp_review_tokens: 'reviewResponseTokens',
        dle_sp_ai_max_tokens: 'aiSearchMaxTokens', dle_sp_ai_timeout: 'aiSearchTimeout',
        dle_sp_ai_scan_depth: 'aiSearchScanDepth', dle_sp_ai_summary_length: 'aiSearchManifestSummaryLength',
        dle_sp_scribe_interval: 'scribeInterval', dle_sp_scribe_max_tokens: 'scribeMaxTokens',
        dle_sp_scribe_timeout: 'scribeTimeout', dle_sp_scribe_scan_depth: 'scribeScanDepth',
        dle_sp_new_chat_threshold: 'newChatThreshold', dle_sp_sync_interval: 'syncPollingInterval',
        dle_sp_reinjection_cooldown: 'reinjectionCooldown', dle_sp_strip_lookback: 'stripLookbackDepth',
        dle_sp_autosuggest_interval: 'autoSuggestInterval', dle_sp_autosuggest_max_tokens: 'autoSuggestMaxTokens', dle_sp_autosuggest_timeout: 'autoSuggestTimeout',
        dle_sp_decay_boost_threshold: 'decayBoostThreshold', dle_sp_decay_penalty_threshold: 'decayPenaltyThreshold',
        dle_sp_graph_repulsion: 'graphRepulsion', dle_sp_graph_spring_length: 'graphSpringLength',
        dle_sp_graph_gravity: 'graphGravity', dle_sp_graph_damping: 'graphDamping',
        dle_sp_graph_hover_dim_distance: 'graphHoverDimDistance', dle_sp_graph_hover_dim_opacity: 'graphHoverDimOpacity',
        dle_sp_graph_focus_tree_depth: 'graphFocusTreeDepth', dle_sp_graph_edge_filter_alpha: 'graphEdgeFilterAlpha',
        dle_sp_fuzzy_min_score: 'fuzzySearchMinScore', dle_sp_rebuild_gen_interval: 'indexRebuildGenerationInterval',
    };
    for (const [inputId, settingName] of Object.entries(clampMap)) {
        $c(`#${inputId}`).on('blur', function () {
            const constraints = settingsConstraints[settingName];
            if (!constraints) return;
            const val = Number($(this).val());
            if (Number.isNaN(val)) {
                $(this).val(constraints.min);
                settings[settingName] = constraints.min;
                saveSettingsDebounced();
                return;
            }
            const clamped = Math.max(constraints.min, Math.min(constraints.max, val));
            if (val !== clamped) { $(this).val(clamped); settings[settingName] = clamped; saveSettingsDebounced(); }
        });
    }
}

// ============================================================================
// Load Settings UI (stub — extension panel is gutted)
// ============================================================================

export function loadSettingsUI() {
    const settings = getSettings();
    $('#dle_enabled').prop('checked', settings.enabled);
    updateStubStatus();

    onIndexUpdated(() => {
        updateStubStatus();
        setTimeout(() => {
            try {
                const health = runHealthCheck();
                setLastHealthResult(health);
            } catch { /* noop */ }
        }, 0);
    });
    onAiStatsUpdated(() => updateStubStatus());
    onCircuitStateChanged(() => { updateStubStatus(); updateHeaderBadge(); });
}

function updateStubStatus() {
    const count = vaultIndex.length;
    const status = computeOverallStatus();
    const info = STATUS_DISPLAY[status];
    const el = document.getElementById('dle_stub_status');
    if (el) {
        el.textContent = count > 0
            ? `${count} entries | ${info.dot} ${info.label}`
            : (status === 'offline' ? `${info.dot} ${info.label}` : '');
    }
    updateHeaderBadge();
}

// ============================================================================
// Bind Settings Events (stub — extension panel is gutted)
// ============================================================================

export function bindSettingsEvents(buildIndexFn) {
    const settings = getSettings();

    $('#dle_enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        setupSyncPolling(buildIndexFn, buildIndexWithReuse);
    });

    $('#dle_open_settings').on('click', () => openSettingsPopup());
    $('#dle_open_settings').on('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSettingsPopup(); }
    });
}
