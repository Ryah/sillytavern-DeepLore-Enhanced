/**
 * DeepLore Enhanced — Settings UI: load, bind, stats
 */
import {
    saveSettingsDebounced,
    chat,
} from '../../../../../script.js';
import { escapeHtml } from '../../../../utils.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { eventSource, event_types } from '../../../../events.js';
import { buildAiChatContext, simpleHash } from '../core/utils.js';
import { applyGating, formatAndGroup } from '../core/matching.js';
import { getSettings, getPrimaryVault, PROMPT_TAG_PREFIX, DEFAULT_AI_SYSTEM_PROMPT } from '../settings.js';
import { testConnection } from './obsidian-api.js';
import { testProxyConnection } from './proxy-api.js';
import {
    vaultIndex, aiSearchStats, indexTimestamp,
    injectionHistory, generationCount, lastHealthResult,
    lastInjectionSources, lastPipelineTrace,
    setVaultIndex, setIndexTimestamp,
} from './state.js';
import { ensureIndexFresh, getMaxResponseTokens } from './vault.js';
import {
    callViaProfile, getProfileModelHint,
    populateProfileDropdown, updateAiConnectionVisibility,
    populateScribeProfileDropdown, updateScribeConnectionVisibility,
    buildCandidateManifest,
} from './ai.js';
import { matchEntries, runPipeline } from './pipeline.js';
import { setupSyncPolling } from './sync.js';
import { buildIndexDelta } from './vault.js';
import { showNotebookPopup, showBrowsePopup, runSimulation, showSimulationPopup, showGraphPopup, optimizeEntryKeys, showOptimizePopup } from './popups.js';
import { diagnoseEntry, runHealthCheck } from './diagnostics.js';
import { showSourcesPopup } from './cartographer.js';

// ============================================================================
// Vault List UI
// ============================================================================

/**
 * Render the dynamic vault list in the settings panel.
 * @param {object} settings
 */
function renderVaultList(settings) {
    const container = document.getElementById('dle_vault_list');
    if (!container) return;

    const vaults = settings.vaults || [];
    let html = '';

    for (let i = 0; i < vaults.length; i++) {
        const v = vaults[i];
        html += `<div class="dle_vault_row" data-index="${i}" style="border: 1px solid var(--SmartThemeBorderColor, #444); border-radius: 4px; padding: 8px; margin-bottom: 6px;">
            <div class="flex-container" style="gap: 6px; align-items: center;">
                <label class="checkbox_label" style="flex: 0 0 auto;" title="Enable/disable this vault">
                    <input type="checkbox" class="dle_vault_enabled checkbox" ${v.enabled ? 'checked' : ''} />
                </label>
                <input type="text" class="dle_vault_name text_pole" placeholder="Name" value="${escapeHtml(v.name)}" style="flex: 1; min-width: 80px;" />
                <input type="number" class="dle_vault_port text_pole" placeholder="Port" value="${v.port}" min="1" max="65535" style="flex: 0 0 80px;" />
                <input type="password" class="dle_vault_key text_pole" placeholder="API Key" value="${escapeHtml(v.apiKey)}" style="flex: 2; min-width: 100px;" />
                <div class="dle_vault_test menu_button menu_button_icon" title="Test this vault" style="flex: 0 0 auto;">
                    <i class="fa-solid fa-plug"></i>
                </div>
                <div class="dle_vault_remove menu_button menu_button_icon" title="Remove this vault" style="flex: 0 0 auto; color: #f44336;">
                    <i class="fa-solid fa-trash"></i>
                </div>
            </div>
            <span class="dle_vault_status deeplore_enhanced_status" style="font-size: 0.8em;"></span>
        </div>`;
    }

    container.innerHTML = html;
}

/**
 * Bind event handlers for the vault list UI (delegated events).
 * @param {object} settings
 */
function bindVaultListEvents(settings) {
    const container = $('#dle_vault_list');

    // Input changes on vault fields
    container.on('input', '.dle_vault_name, .dle_vault_port, .dle_vault_key', function () {
        const row = $(this).closest('.dle_vault_row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;

        if ($(this).hasClass('dle_vault_name')) {
            settings.vaults[idx].name = String($(this).val()).trim() || 'Vault';
        } else if ($(this).hasClass('dle_vault_port')) {
            settings.vaults[idx].port = Number($(this).val()) || 27123;
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
        const row = $(this).closest('.dle_vault_row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;
        const vault = settings.vaults[idx];
        const statusEl = row.find('.dle_vault_status');
        statusEl.text('Testing...').removeClass('success failure');
        try {
            const data = await testConnection(vault.port, vault.apiKey);
            if (data.ok) {
                statusEl.text(`Connected${data.authenticated ? '' : ' (no auth)'}`).addClass('success').removeClass('failure');
            } else {
                statusEl.text(`Failed: ${data.error}`).addClass('failure').removeClass('success');
            }
        } catch (err) {
            statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success');
        }
    });

    // Remove vault
    container.on('click', '.dle_vault_remove', function () {
        const row = $(this).closest('.dle_vault_row');
        const idx = parseInt(row.data('index'), 10);
        if (isNaN(idx) || !settings.vaults[idx]) return;
        if (settings.vaults.length <= 1) {
            toastr.warning('Cannot remove the last vault.', 'DeepLore Enhanced');
            return;
        }
        settings.vaults.splice(idx, 1);
        const primary = getPrimaryVault(settings);
        settings.obsidianPort = primary.port;
        settings.obsidianApiKey = primary.apiKey;
        saveSettingsDebounced();
        renderVaultList(settings);
    });

    // Add vault button
    $('#dle_add_vault').on('click', function () {
        settings.vaults.push({ name: `Vault ${settings.vaults.length + 1}`, port: 27123, apiKey: '', enabled: true });
        saveSettingsDebounced();
        renderVaultList(settings);
    });
}

// ============================================================================
// Stats Display
// ============================================================================

export function updateIndexStats() {
    const statsEl = document.getElementById('dle_index_stats');
    if (statsEl) {
        if (vaultIndex.length > 0) {
            const totalKeys = vaultIndex.reduce((sum, e) => sum + e.keys.length, 0);
            const constants = vaultIndex.filter(e => e.constant).length;
            const totalTokens = vaultIndex.reduce((sum, e) => sum + e.tokenEstimate, 0);
            let statsText = `${vaultIndex.length} entries (${totalKeys} keywords, ${constants} always-send, ~${totalTokens} total tokens)`;
            // Health score badge
            if (lastHealthResult) {
                const { errors, warnings } = lastHealthResult;
                let grade, color;
                if (errors === 0 && warnings === 0) { grade = 'A+'; color = '#4caf50'; }
                else if (errors === 0 && warnings <= 3) { grade = 'A'; color = '#8bc34a'; }
                else if (errors === 0 && warnings <= 6) { grade = 'B'; color = '#ff9800'; }
                else if (errors <= 2) { grade = 'C'; color = '#ff5722'; }
                else { grade = 'D'; color = '#f44336'; }
                statsText += ` · Health: <span id="dle_health_badge" style="color: ${color}; font-weight: bold; cursor: pointer;" title="Click for details. ${errors} errors, ${warnings} warnings">${grade}</span>`;
            }
            statsEl.innerHTML = statsText;
            // Bind health badge click
            const badge = document.getElementById('dle_health_badge');
            if (badge) {
                badge.addEventListener('click', async () => {
                    // Run health check directly and show results in a popup
                    const result = await runHealthCheck();
                    if (!result) return;
                    const lines = [];
                    lines.push(`Grade: ${result.grade} (${result.errors} errors, ${result.warnings} warnings)`);
                    for (const item of result.items) {
                        const icon = item.level === 'error' ? '\u274C' : item.level === 'warning' ? '\u26A0\uFE0F' : '\u2705';
                        lines.push(`${icon} ${item.message}`);
                    }
                    const html = `<div style="text-align: left; max-height: 60vh; overflow-y: auto;"><h3>Health Check</h3><pre style="white-space: pre-wrap; font-size: 0.85em;">${escapeHtml(lines.join('\n'))}</pre></div>`;
                    callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
                });
            }
        } else {
            statsEl.textContent = 'No index loaded.';
        }
    }

    // Update header badge with entry count
    const headerBadge = document.getElementById('dle_header_badge');
    if (headerBadge) {
        if (vaultIndex.length > 0) {
            headerBadge.textContent = `(${vaultIndex.length} entries)`;
        } else {
            headerBadge.textContent = '';
        }
    }
}

export function updateAiStats() {
    const statsEl = document.getElementById('dle_ai_stats');
    if (statsEl) {
        statsEl.textContent = `AI calls: ${aiSearchStats.calls} | Cache hits: ${aiSearchStats.cachedHits} | Tokens: ~${aiSearchStats.totalInputTokens} in / ~${aiSearchStats.totalOutputTokens} out`;
    }
}

// ============================================================================
// Mode Visibility
// ============================================================================

/**
 * Update UI visibility based on the current search mode.
 * @param {object} settings
 */
function updateModeVisibility(settings) {
    const aiEnabled = settings.aiSearchEnabled;
    const isProxy = settings.aiSearchConnectionMode === 'proxy';

    // Show/hide AI Search drawer
    $('#dle_ai_search_drawer').toggle(aiEnabled);

    // Show/hide keyword scan depth (hidden in ai-only since keywords aren't used)
    const isAiOnly = aiEnabled && settings.aiSearchMode === 'ai-only';
    $('#dle_scan_depth_row').toggle(!isAiOnly);

    // Claude Code prefix toggle: only visible when proxy mode AND AI enabled
    $('#dle_ai_claude_prefix_row').toggle(aiEnabled && isProxy);
}

/**
 * Show/hide injection position controls based on injection mode.
 * @param {object} settings
 */
function updateInjectionModeVisibility(settings) {
    const isPromptList = settings.injectionMode === 'prompt_list';
    $('#dle_extension_position_controls').toggle(!isPromptList);
    $('#dle_prompt_list_info').toggle(isPromptList);
}

/**
 * Restore advanced section visibility from persisted settings.
 * @param {object} settings
 */
function restoreAdvancedSections(settings) {
    const advVisible = settings.advancedVisible || {};
    $('.dle_advanced_section').each(function () {
        const section = $(this).data('section');
        if (advVisible[section]) {
            $(this).show();
            const toggle = $(this).prev('.dle_advanced_toggle');
            toggle.find('.dle_advanced_icon').removeClass('fa-chevron-right').addClass('fa-chevron-down');
            toggle.contents().filter(function () { return this.nodeType === 3; }).last()[0].textContent = ' Hide Advanced';
        }
    });
}

// ============================================================================
// Load Settings UI
// ============================================================================

export function loadSettingsUI() {
    const settings = getSettings();

    $('#dle_enabled').prop('checked', settings.enabled);
    $('#dle_enabled').closest('.inline-drawer-content').find('> :not(:first-child)').css('opacity', settings.enabled ? 1 : 0.5);
    // Multi-vault list rendering
    renderVaultList(settings);
    $('#dle_tag').val(settings.lorebookTag);
    $('#dle_constant_tag').val(settings.constantTag);
    $('#dle_never_insert_tag').val(settings.neverInsertTag);
    $('#dle_seed_tag').val(settings.seedTag);
    $('#dle_bootstrap_tag').val(settings.bootstrapTag);
    $('#dle_new_chat_threshold').val(settings.newChatThreshold);
    $('#dle_scan_depth').val(settings.scanDepth);
    $('#dle_max_entries').val(settings.maxEntries);
    $('#dle_unlimited_entries').prop('checked', settings.unlimitedEntries);
    $('#dle_max_entries').prop('disabled', settings.unlimitedEntries);
    $('#dle_token_budget').val(settings.maxTokensBudget);
    $('#dle_unlimited_budget').prop('checked', settings.unlimitedBudget);
    $('#dle_token_budget').prop('disabled', settings.unlimitedBudget);
    $('#dle_template').val(settings.injectionTemplate);
    $(`input[name="dle_injection_mode"][value="${settings.injectionMode || 'extension'}"]`).prop('checked', true);
    updateInjectionModeVisibility(settings);
    $(`input[name="dle_position"][value="${settings.injectionPosition}"]`).prop('checked', true);
    $('#dle_depth').val(settings.injectionDepth);
    $('#dle_role').val(settings.injectionRole);
    // Depth/role only apply for in-chat position (value 1)
    const isInChat = settings.injectionPosition === 1;
    $('#dle_depth, #dle_role').prop('disabled', !isInChat).css('opacity', isInChat ? 1 : 0.4);
    $('#dle_allow_wi_scan').prop('checked', settings.allowWIScan);
    $('#dle_recursive_scan').prop('checked', settings.recursiveScan);
    $('#dle_max_recursion').val(settings.maxRecursionSteps);
    $('#dle_max_recursion').prop('disabled', !settings.recursiveScan);
    $('#dle_cache_ttl').val(settings.cacheTTL);
    $('#dle_review_tokens').val(settings.reviewResponseTokens);
    $('#dle_case_sensitive').prop('checked', settings.caseSensitive);
    $('#dle_match_whole_words').prop('checked', settings.matchWholeWords);
    $('#dle_char_context_scan').prop('checked', settings.characterContextScan);
    $('#dle_debug').prop('checked', settings.debugMode);

    // Search Mode dropdown (replaces separate AI enable + mode radios)
    const searchMode = !settings.aiSearchEnabled ? 'keyword-only'
        : (settings.aiSearchMode === 'ai-only' ? 'ai-only' : 'two-stage');
    $('#dle_search_mode').val(searchMode);

    // AI Search settings
    $('input[name="dle_ai_connection_mode"][value="' + settings.aiSearchConnectionMode + '"]').prop('checked', true);
    populateProfileDropdown();
    updateAiConnectionVisibility();
    $('#dle_ai_proxy_url').val(settings.aiSearchProxyUrl);
    $('#dle_ai_model').val(settings.aiSearchModel);
    $('#dle_ai_max_tokens').val(settings.aiSearchMaxTokens);
    $('#dle_ai_timeout').val(settings.aiSearchTimeout);
    $('#dle_ai_scan_depth').val(settings.aiSearchScanDepth);
    $('#dle_ai_system_prompt').val(settings.aiSearchSystemPrompt);
    $('#dle_ai_summary_length').val(settings.aiSearchManifestSummaryLength);
    $('#dle_ai_claude_prefix').prop('checked', settings.aiSearchClaudeCodePrefix);

    // Context Cartographer settings
    $('#dle_show_sources').prop('checked', settings.showLoreSources);

    // Apply mode visibility
    updateModeVisibility(settings);

    // AI Notebook settings
    $('#dle_notebook_enabled').prop('checked', settings.notebookEnabled);
    $(`input[name="dle_notebook_position"][value="${settings.notebookPosition}"]`).prop('checked', true);
    $('#dle_notebook_depth').val(settings.notebookDepth);
    $('#dle_notebook_role').val(settings.notebookRole);
    $('#dle_notebook_controls').css('opacity', settings.notebookEnabled ? 1 : 0.5);

    // Session Scribe settings
    $('#dle_scribe_enabled').prop('checked', settings.scribeEnabled);
    $('#dle_scribe_controls').find('input, textarea, select, .menu_button')
        .prop('disabled', !settings.scribeEnabled)
        .toggleClass('disabled', !settings.scribeEnabled);
    $('#dle_scribe_interval').val(settings.scribeInterval);
    $('#dle_scribe_folder').val(settings.scribeFolder);
    $('input[name="dle_scribe_connection_mode"][value="' + settings.scribeConnectionMode + '"]').prop('checked', true);
    populateScribeProfileDropdown();
    updateScribeConnectionVisibility();
    $('#dle_scribe_proxy_url').val(settings.scribeProxyUrl);
    $('#dle_scribe_model').val(settings.scribeModel);
    $('#dle_scribe_max_tokens').val(settings.scribeMaxTokens);
    $('#dle_scribe_timeout').val(settings.scribeTimeout);
    $('#dle_scribe_scan_depth').val(settings.scribeScanDepth);
    $('#dle_scribe_prompt').val(settings.scribePrompt);

    // Vault Sync settings
    $('#dle_sync_interval').val(settings.syncPollingInterval);
    $('#dle_show_sync_toasts').prop('checked', settings.showSyncToasts);

    // Chat History Tracking
    $('#dle_reinjection_cooldown').val(settings.reinjectionCooldown);

    // Auto Lorebook
    $('#dle_autosuggest_enabled').prop('checked', settings.autoSuggestEnabled);
    $('#dle_autosuggest_controls').find('input, select').prop('disabled', !settings.autoSuggestEnabled).toggleClass('disabled', !settings.autoSuggestEnabled);
    $('#dle_autosuggest_interval').val(settings.autoSuggestInterval);
    $('#dle_autosuggest_folder').val(settings.autoSuggestFolder);
    $(`input[name="dle_autosuggest_connection_mode"][value="${settings.autoSuggestConnectionMode}"]`).prop('checked', true);
    $('#dle_autosuggest_proxy_url').val(settings.autoSuggestProxyUrl);
    $('#dle_autosuggest_model').val(settings.autoSuggestModel);
    $('#dle_autosuggest_max_tokens').val(settings.autoSuggestMaxTokens);
    // Show/hide connection fields based on mode
    const asMode = settings.autoSuggestConnectionMode;
    $('#dle_autosuggest_profile_container').toggle(asMode === 'profile');
    $('#dle_autosuggest_proxy_container').toggle(asMode === 'proxy');

    // Injection Deduplication
    $('#dle_strip_dedup').prop('checked', settings.stripDuplicateInjections);
    $('#dle_strip_lookback').val(settings.stripLookbackDepth);
    $('#dle_strip_lookback').prop('disabled', !settings.stripDuplicateInjections);

    updateIndexStats();
    updateAiStats();

    // Restore advanced section toggle states
    restoreAdvancedSections(settings);
}

// ============================================================================
// Bind Settings Events
// ============================================================================

/**
 * Bind all jQuery event handlers for settings panel elements.
 * @param {Function} buildIndexFn - The buildIndex function from vault.js (passed to avoid circular imports)
 */
export function bindSettingsEvents(buildIndexFn) {
    const settings = getSettings();

    $('#dle_enabled').on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
        setupSyncPolling(buildIndexFn, buildIndexDelta); // Stop/start polling based on enabled state
        $(this).closest('.inline-drawer-content').find('> :not(:first-child)').css('opacity', settings.enabled ? 1 : 0.5);
    });

    // Multi-vault list events (delegated)
    bindVaultListEvents(settings);

    $('#dle_tag').on('input', function () {
        settings.lorebookTag = String($(this).val()).trim() || 'lorebook';
        saveSettingsDebounced();
    });

    $('#dle_constant_tag').on('input', function () {
        settings.constantTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#dle_never_insert_tag').on('input', function () {
        settings.neverInsertTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#dle_seed_tag').on('input', function () {
        settings.seedTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#dle_bootstrap_tag').on('input', function () {
        settings.bootstrapTag = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#dle_new_chat_threshold').on('input', function () {
        const val = Number($(this).val());
        settings.newChatThreshold = isNaN(val) ? 3 : val;
        saveSettingsDebounced();
    });

    $('#dle_scan_depth').on('input', function () {
        const val = Number($(this).val());
        settings.scanDepth = isNaN(val) ? 4 : val;
        saveSettingsDebounced();
    });

    $('#dle_max_entries').on('input', function () {
        const val = Number($(this).val());
        settings.maxEntries = isNaN(val) ? 10 : val;
        saveSettingsDebounced();
    });

    $('#dle_unlimited_entries').on('change', function () {
        settings.unlimitedEntries = $(this).prop('checked');
        $('#dle_max_entries').prop('disabled', settings.unlimitedEntries);
        saveSettingsDebounced();
    });

    $('#dle_token_budget').on('input', function () {
        const val = Number($(this).val());
        settings.maxTokensBudget = isNaN(val) ? 2048 : val;
        saveSettingsDebounced();
    });

    $('#dle_unlimited_budget').on('change', function () {
        settings.unlimitedBudget = $(this).prop('checked');
        $('#dle_token_budget').prop('disabled', settings.unlimitedBudget);
        saveSettingsDebounced();
    });

    $('#dle_template').on('input', function () {
        settings.injectionTemplate = String($(this).val());
        saveSettingsDebounced();
    });

    $('input[name="dle_injection_mode"]').on('change', function () {
        settings.injectionMode = String($(this).val());
        updateInjectionModeVisibility(settings);
        saveSettingsDebounced();
    });

    $('input[name="dle_position"]').on('change', function () {
        settings.injectionPosition = Number($(this).val());
        const inChat = settings.injectionPosition === 1;
        $('#dle_depth, #dle_role').prop('disabled', !inChat).css('opacity', inChat ? 1 : 0.4);
        saveSettingsDebounced();
    });

    $('#dle_depth').on('input', function () {
        const val = Number($(this).val());
        settings.injectionDepth = isNaN(val) ? 4 : val;
        saveSettingsDebounced();
    });

    $('#dle_role').on('change', function () {
        settings.injectionRole = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#dle_allow_wi_scan').on('change', function () {
        settings.allowWIScan = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#dle_recursive_scan').on('change', function () {
        settings.recursiveScan = $(this).prop('checked');
        $('#dle_max_recursion').prop('disabled', !settings.recursiveScan);
        saveSettingsDebounced();
    });

    $('#dle_max_recursion').on('input', function () {
        const val = Number($(this).val());
        settings.maxRecursionSteps = isNaN(val) ? 3 : val;
        saveSettingsDebounced();
    });

    $('#dle_cache_ttl').on('input', function () {
        const val = Number($(this).val());
        settings.cacheTTL = isNaN(val) ? 300 : val;
        saveSettingsDebounced();
    });

    $('#dle_review_tokens').on('input', function () {
        const val = Number($(this).val());
        settings.reviewResponseTokens = isNaN(val) ? 0 : val;
        saveSettingsDebounced();
    });

    $('#dle_case_sensitive').on('change', function () {
        settings.caseSensitive = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#dle_match_whole_words').on('change', function () {
        settings.matchWholeWords = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#dle_char_context_scan').on('change', function () {
        settings.characterContextScan = $(this).is(':checked');
        saveSettingsDebounced();
    });

    $('#dle_debug').on('change', function () {
        settings.debugMode = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Search Mode dropdown
    $('#dle_search_mode').on('change', function () {
        const mode = $(this).val();
        settings.aiSearchEnabled = mode !== 'keyword-only';
        settings.aiSearchMode = mode === 'ai-only' ? 'ai-only' : 'two-stage';
        saveSettingsDebounced();
        updateModeVisibility(settings);
    });

    // AI Search settings
    $('input[name="dle_ai_connection_mode"]').on('change', function () {
        settings.aiSearchConnectionMode = $('input[name="dle_ai_connection_mode"]:checked').val();
        saveSettingsDebounced();
        updateAiConnectionVisibility();
        updateModeVisibility(settings);
    });

    $('#dle_ai_profile_select').on('change', function () {
        settings.aiSearchProfileId = String($(this).val());
        saveSettingsDebounced();
        updateAiConnectionVisibility(); // Update model placeholder hint
    });

    // Refresh profile dropdown when Connection Manager profiles change
    if (typeof eventSource !== 'undefined') {
        const refreshProfileEvents = [
            event_types.CONNECTION_PROFILE_LOADED,
            event_types.CONNECTION_PROFILE_CREATED,
            event_types.CONNECTION_PROFILE_DELETED,
            event_types.CONNECTION_PROFILE_UPDATED,
        ].filter(e => e !== undefined);
        for (const evt of refreshProfileEvents) {
            eventSource.on(evt, () => {
                populateProfileDropdown();
                populateScribeProfileDropdown();
            });
        }
    }

    $('#dle_ai_proxy_url').on('input', function () {
        settings.aiSearchProxyUrl = String($(this).val()).trim() || 'http://localhost:42069';
        saveSettingsDebounced();
    });

    $('#dle_ai_model').on('input', function () {
        settings.aiSearchModel = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#dle_ai_max_tokens').on('input', function () {
        const val = Number($(this).val());
        settings.aiSearchMaxTokens = isNaN(val) ? 1024 : val;
        saveSettingsDebounced();
    });

    $('#dle_ai_timeout').on('input', function () {
        const val = Number($(this).val());
        settings.aiSearchTimeout = isNaN(val) ? 10000 : val;
        saveSettingsDebounced();
    });

    $('#dle_ai_scan_depth').on('input', function () {
        const val = Number($(this).val());
        settings.aiSearchScanDepth = isNaN(val) ? 4 : val;
        saveSettingsDebounced();
    });

    $('#dle_ai_system_prompt').on('input', function () {
        settings.aiSearchSystemPrompt = String($(this).val());
        saveSettingsDebounced();
    });

    $('#dle_ai_summary_length').on('input', function () {
        const val = Number($(this).val());
        settings.aiSearchManifestSummaryLength = isNaN(val) ? 600 : val;
        saveSettingsDebounced();
    });

    // Context Cartographer settings
    $('#dle_show_sources').on('change', function () {
        settings.showLoreSources = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // AI Notebook settings
    $('#dle_notebook_enabled').on('change', function () {
        settings.notebookEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        $('#dle_notebook_controls').css('opacity', settings.notebookEnabled ? 1 : 0.5);
    });

    $('input[name="dle_notebook_position"]').on('change', function () {
        settings.notebookPosition = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#dle_notebook_depth').on('input', function () {
        settings.notebookDepth = Number($(this).val()) || 0;
        saveSettingsDebounced();
    });

    $('#dle_notebook_role').on('change', function () {
        settings.notebookRole = Number($(this).val()) || 0;
        saveSettingsDebounced();
    });

    $('#dle_open_notebook').on('click', function () {
        showNotebookPopup();
    });

    // Session Scribe settings
    $('#dle_scribe_enabled').on('change', function () {
        settings.scribeEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        $('#dle_scribe_controls').find('input, textarea, select, .menu_button')
            .prop('disabled', !settings.scribeEnabled)
            .toggleClass('disabled', !settings.scribeEnabled);
    });

    $('#dle_scribe_interval').on('input', function () {
        const val = Number($(this).val());
        settings.scribeInterval = isNaN(val) ? 5 : val;
        saveSettingsDebounced();
    });

    $('#dle_scribe_folder').on('input', function () {
        settings.scribeFolder = String($(this).val()).trim() || 'Sessions';
        saveSettingsDebounced();
    });

    $('#dle_scribe_prompt').on('input', function () {
        settings.scribePrompt = String($(this).val());
        saveSettingsDebounced();
    });

    $('input[name="dle_scribe_connection_mode"]').on('change', function () {
        settings.scribeConnectionMode = $('input[name="dle_scribe_connection_mode"]:checked').val();
        saveSettingsDebounced();
        updateScribeConnectionVisibility();
    });

    $('#dle_scribe_profile_select').on('change', function () {
        settings.scribeProfileId = String($(this).val());
        saveSettingsDebounced();
        updateScribeConnectionVisibility();
    });

    $('#dle_scribe_proxy_url').on('input', function () {
        settings.scribeProxyUrl = String($(this).val()).trim() || 'http://localhost:42069';
        saveSettingsDebounced();
    });

    $('#dle_scribe_model').on('input', function () {
        settings.scribeModel = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#dle_scribe_max_tokens').on('input', function () {
        const val = Number($(this).val());
        settings.scribeMaxTokens = isNaN(val) ? 1024 : val;
        saveSettingsDebounced();
    });

    $('#dle_scribe_timeout').on('input', function () {
        const val = Number($(this).val());
        settings.scribeTimeout = isNaN(val) ? 30000 : val;
        saveSettingsDebounced();
    });

    $('#dle_scribe_scan_depth').on('input', function () {
        const val = Number($(this).val());
        settings.scribeScanDepth = isNaN(val) ? 20 : val;
        saveSettingsDebounced();
    });

    // Vault Sync settings
    $('#dle_sync_interval').on('input', function () {
        const val = Number($(this).val());
        settings.syncPollingInterval = isNaN(val) ? 0 : val;
        saveSettingsDebounced();
        setupSyncPolling(buildIndexFn, buildIndexDelta);
    });

    $('#dle_show_sync_toasts').on('change', function () {
        settings.showSyncToasts = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Chat History Tracking
    $('#dle_reinjection_cooldown').on('input', function () {
        const val = Number($(this).val());
        settings.reinjectionCooldown = isNaN(val) ? 0 : val;
        saveSettingsDebounced();
    });

    // Auto Lorebook
    $('#dle_autosuggest_enabled').on('change', function () {
        settings.autoSuggestEnabled = $(this).prop('checked');
        saveSettingsDebounced();
        $('#dle_autosuggest_controls').find('input, select').prop('disabled', !settings.autoSuggestEnabled).toggleClass('disabled', !settings.autoSuggestEnabled);
    });

    $('#dle_autosuggest_interval').on('input', function () {
        const val = Number($(this).val());
        settings.autoSuggestInterval = isNaN(val) ? 10 : val;
        saveSettingsDebounced();
    });

    $('#dle_autosuggest_folder').on('input', function () {
        settings.autoSuggestFolder = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('input[name="dle_autosuggest_connection_mode"]').on('change', function () {
        settings.autoSuggestConnectionMode = $(this).val();
        saveSettingsDebounced();
        const m = settings.autoSuggestConnectionMode;
        $('#dle_autosuggest_profile_container').toggle(m === 'profile');
        $('#dle_autosuggest_proxy_container').toggle(m === 'proxy');
    });

    $('#dle_autosuggest_proxy_url').on('input', function () {
        settings.autoSuggestProxyUrl = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#dle_autosuggest_model').on('input', function () {
        settings.autoSuggestModel = String($(this).val()).trim();
        saveSettingsDebounced();
    });

    $('#dle_autosuggest_max_tokens').on('input', function () {
        const val = Number($(this).val());
        settings.autoSuggestMaxTokens = isNaN(val) ? 2048 : val;
        saveSettingsDebounced();
    });

    // Claude Code prefix toggle
    $('#dle_ai_claude_prefix').on('change', function () {
        settings.aiSearchClaudeCodePrefix = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Advanced section toggles
    $('.dle_advanced_toggle').on('click', function () {
        const section = $(this).data('section');
        const content = $(`.dle_advanced_section[data-section="${section}"]`);
        const icon = $(this).find('.dle_advanced_icon');
        content.toggle();
        const visible = content.is(':visible');
        icon.toggleClass('fa-chevron-right', !visible).toggleClass('fa-chevron-down', visible);
        // Update the text node
        $(this).contents().filter(function () { return this.nodeType === 3; }).last()[0].textContent = visible ? ' Hide Advanced' : ' Show Advanced';
        // Persist
        if (!settings.advancedVisible) settings.advancedVisible = {};
        settings.advancedVisible[section] = visible;
        saveSettingsDebounced();
    });

    // Injection Deduplication
    $('#dle_strip_dedup').on('change', function () {
        settings.stripDuplicateInjections = $(this).prop('checked');
        saveSettingsDebounced();
        $('#dle_strip_lookback').prop('disabled', !settings.stripDuplicateInjections);
    });

    $('#dle_strip_lookback').on('input', function () {
        const val = Number($(this).val());
        settings.stripLookbackDepth = isNaN(val) ? 2 : val;
        saveSettingsDebounced();
    });

    // Quick Actions Bar
    $('#dle_qa_browse').on('click', async () => {
        await showBrowsePopup();
    });

    $('#dle_qa_map').on('click', async () => {
        if (!chat || chat.length === 0) {
            toastr.warning('No active chat.', 'DeepLore Enhanced');
            return;
        }
        if (lastInjectionSources && lastInjectionSources.length > 0) {
            showSourcesPopup(lastInjectionSources);
        } else {
            toastr.info('No injection sources yet. Generate a message first.', 'DeepLore Enhanced');
        }
    });

    $('#dle_qa_health').on('click', () => {
        const health = runHealthCheck();
        if (!health) {
            toastr.warning('No entries indexed.', 'DeepLore Enhanced');
            return;
        }
        const grade = health.errors === 0 && health.warnings === 0 ? 'A+'
            : health.errors === 0 ? 'B' : health.errors <= 2 ? 'C' : 'D';
        let msg = `Health: ${grade} — ${health.errors} errors, ${health.warnings} warnings`;
        if (health.issues && health.issues.length > 0) {
            msg += '\n' + health.issues.slice(0, 5).map(i => `${i.severity}: ${i.detail}`).join('\n');
        }
        if (health.errors === 0 && health.warnings === 0) {
            toastr.success(msg, 'DeepLore Enhanced');
        } else if (health.errors === 0) {
            toastr.warning(msg, 'DeepLore Enhanced', { timeOut: 8000 });
        } else {
            toastr.error(msg, 'DeepLore Enhanced', { timeOut: 10000 });
        }
    });

    $('#dle_qa_refresh').on('click', async function () {
        const btn = $(this);
        btn.find('i').removeClass('fa-sync').addClass('fa-spinner fa-spin');
        try {
            setVaultIndex([]);
            setIndexTimestamp(0);
            await buildIndexFn();
            toastr.success(`Indexed ${vaultIndex.length} entries.`, 'DeepLore Enhanced');
        } catch (err) {
            toastr.error(String(err), 'DeepLore Enhanced');
        } finally {
            btn.find('i').removeClass('fa-spinner fa-spin').addClass('fa-sync');
        }
    });

    $('#dle_qa_more_toggle').on('click', () => {
        $('#dle_quick_actions_more').toggle();
    });

    $('#dle_qa_graph').on('click', async () => {
        await ensureIndexFresh();
        if (vaultIndex.length === 0) { toastr.warning('No entries indexed.', 'DeepLore Enhanced'); return; }
        showGraphPopup();
    });

    $('#dle_qa_simulate').on('click', async () => {
        if (!chat || chat.length === 0) { toastr.warning('No active chat.', 'DeepLore Enhanced'); return; }
        await ensureIndexFresh();
        if (vaultIndex.length === 0) { toastr.warning('No entries indexed.', 'DeepLore Enhanced'); return; }
        toastr.info('Running simulation...', 'DeepLore Enhanced', { timeOut: 2000 });
        const timeline = runSimulation(chat);
        showSimulationPopup(timeline);
    });

    $('#dle_qa_analytics').on('click', () => {
        const settings = getSettings();
        const analytics = settings.analyticsData || {};
        if (Object.keys(analytics).length === 0) {
            toastr.info('No analytics data yet. Generate some messages first.', 'DeepLore Enhanced');
            return;
        }
        // Show quick analytics summary as toast
        const sorted = Object.entries(analytics).sort((a, b) => (b[1].injected || 0) - (a[1].injected || 0));
        const top5 = sorted.slice(0, 5).map(([t, d]) => `${t}: ${d.injected || 0} injections`).join('\n');
        toastr.info(`Top entries:\n${top5}`, 'DeepLore Analytics', { timeOut: 10000 });
    });

    $('#dle_qa_optimize').on('click', async () => {
        await ensureIndexFresh();
        if (vaultIndex.length === 0) { toastr.warning('No entries indexed.', 'DeepLore Enhanced'); return; }

        // Show entry selection popup
        const entryOptions = vaultIndex.map(e => `<option value="${escapeHtml(e.title)}">${escapeHtml(e.title)} (${e.keys.length} keys)</option>`).join('');
        const selectHtml = `<div style="text-align: left;">
            <h3>Optimize Keywords</h3>
            <p style="opacity: 0.7; font-size: 0.85em;">Select an entry to optimize its keywords using AI.</p>
            <select id="dle_optimize_entry_select" class="text_pole" style="width: 100%;">${entryOptions}</select>
        </div>`;
        const confirmed = await callGenericPopup(selectHtml, POPUP_TYPE.CONFIRM, '', { wide: true, okButton: 'Optimize', cancelButton: 'Cancel' });
        if (!confirmed) return;
        const selectedTitle = document.getElementById('dle_optimize_entry_select')?.value;
        const entry = vaultIndex.find(e => e.title === selectedTitle);
        if (!entry) return;

        toastr.info(`Analyzing keywords for "${entry.title}"...`, 'DeepLore Enhanced', { timeOut: 2000 });
        const result = await optimizeEntryKeys(entry);
        if (result) showOptimizePopup(entry, result);
    });

    $('#dle_qa_inspect').on('click', () => {
        if (!lastPipelineTrace) {
            toastr.info('No pipeline trace yet. Generate a message first.', 'DeepLore Enhanced');
            return;
        }
        const t = lastPipelineTrace;
        const lines = [
            `Mode: ${t.mode}`,
            `Indexed: ${t.indexed}`,
            `Keyword matched: ${t.keywordMatched.length}`,
            `AI selected: ${t.aiSelected.length}`,
            t.aiFallback ? 'AI FALLBACK: true' : '',
        ].filter(Boolean);
        toastr.info(lines.join('\n'), 'Pipeline Trace', { timeOut: 10000 });
    });

    $('#dle_qa_setup').on('click', async () => {
        // Trigger the setup wizard - import and call the setup function
        // We'll use the slash command approach since setup is complex
        toastr.info('Use /dle-setup in chat to run the setup wizard.', 'DeepLore Enhanced');
    });

    // Test Connection button — tests all enabled vaults
    $('#dle_test_connection').on('click', async function () {
        const statusEl = $('#dle_connection_status');
        statusEl.text('Testing...').removeClass('success failure');

        try {
            const enabledVaults = (settings.vaults || []).filter(v => v.enabled);
            if (enabledVaults.length === 0) {
                throw new Error('No enabled vaults configured');
            }

            const results = [];
            for (const vault of enabledVaults) {
                try {
                    const data = await testConnection(vault.port, vault.apiKey);
                    results.push({ name: vault.name, ok: data.ok, auth: data.authenticated, error: data.error });
                } catch (err) {
                    results.push({ name: vault.name, ok: false, error: err.message });
                }
            }

            const allOk = results.every(r => r.ok);
            const summary = results.map(r => `${r.name}: ${r.ok ? (r.auth ? 'OK' : 'OK (no auth)') : 'FAIL'}`).join(', ');
            if (allOk) {
                statusEl.text(summary).addClass('success').removeClass('failure');
            } else {
                statusEl.text(summary).addClass('failure').removeClass('success');
            }
        } catch (err) {
            statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success');
        }
    });

    // Test AI Search button
    $('#dle_test_ai').on('click', async function () {
        const statusEl = $('#dle_ai_status');
        statusEl.text('Testing...').removeClass('success failure');

        try {
            if (settings.aiSearchConnectionMode === 'profile') {
                // Profile mode: test via ConnectionManagerRequestService
                if (!settings.aiSearchProfileId) {
                    throw new Error('No connection profile selected');
                }
                const result = await callViaProfile(
                    'You are a test assistant. Respond with exactly: {"ok": true}',
                    'Test connection. Respond with exactly: {"ok": true}',
                    64,
                    settings.aiSearchTimeout,
                );
                const profileModel = getProfileModelHint();
                statusEl.text(`Connected${profileModel ? ' (' + profileModel + ')' : ''}`).addClass('success').removeClass('failure');
            } else {
                // Proxy mode: test via server endpoint
                // Proxy mode: test via CORS proxy bridge
                const data = await testProxyConnection(settings.aiSearchProxyUrl, settings.aiSearchModel || 'claude-haiku-4-5-20251001');

                if (data.ok) {
                    statusEl.text('Connected').addClass('success').removeClass('failure');
                } else {
                    statusEl.text(`Failed: ${data.error}`).addClass('failure').removeClass('success');
                }
            }
        } catch (err) {
            statusEl.text(`Error: ${err.message}`).addClass('failure').removeClass('success');
        }
    });

    // Preview AI Prompt button
    $('#dle_preview_ai').on('click', async function () {
        const settings = getSettings();

        if (!chat || chat.length === 0) {
            toastr.warning('No active chat. Start a conversation first.', 'DeepLore Enhanced');
            return;
        }

        await ensureIndexFresh();
        if (vaultIndex.length === 0) {
            toastr.warning('No vault index. Click "Refresh Index" first.', 'DeepLore Enhanced');
            return;
        }

        // Build candidate manifest based on mode
        let candidateManifest, candidateHeader, modeLabel;
        if (settings.aiSearchMode === 'ai-only') {
            const result = buildCandidateManifest(vaultIndex);
            candidateManifest = result.manifest;
            candidateHeader = result.header;
            modeLabel = 'AI-only (full vault)';
        } else {
            const keywordResult = matchEntries(chat);
            const nonConstant = keywordResult.matched.filter(e => !e.constant);
            if (nonConstant.length === 0) {
                toastr.warning('No keyword matches found. The AI would receive no candidates.', 'DeepLore Enhanced');
                return;
            }
            const result = buildCandidateManifest(keywordResult.matched);
            candidateManifest = result.manifest;
            candidateHeader = result.header;
            modeLabel = `Two-stage (${nonConstant.length} keyword candidates)`;
        }

        // Build chat context (same as aiSearch)
        const chatContext = buildAiChatContext(chat, settings.aiSearchScanDepth);

        // Resolve system prompt with {{maxEntries}}
        const maxEntries = settings.unlimitedEntries ? 'as many as are relevant' : String(settings.maxEntries);
        let systemPrompt;
        if (settings.aiSearchSystemPrompt && settings.aiSearchSystemPrompt.trim()) {
            const userPrompt = settings.aiSearchSystemPrompt.trim();
            if (settings.aiSearchClaudeCodePrefix && settings.aiSearchConnectionMode === 'proxy') {
                systemPrompt = userPrompt.startsWith('You are Claude Code')
                    ? userPrompt
                    : 'You are Claude Code. ' + userPrompt;
            } else {
                systemPrompt = userPrompt;
            }
        } else {
            systemPrompt = DEFAULT_AI_SYSTEM_PROMPT;
        }
        systemPrompt = systemPrompt.replace(/\{\{maxEntries\}\}/g, maxEntries);

        // Build user message (same format as server)
        const headerSection = candidateHeader ? `## Manifest Info\n${candidateHeader}\n\n` : '';
        const userMessage = `${headerSection}## Recent Chat\n${chatContext}\n\n## Candidate Lore Entries\n${candidateManifest}\n\nSelect the relevant entries as a JSON array.`;

        // Build preview HTML
        const previewHtml = `
            <div style="text-align: left; font-family: monospace; font-size: 0.85em;">
                <h3>Mode: ${escapeHtml(modeLabel)}</h3>
                <h3>System Prompt</h3>
                <div style="background: var(--SmartThemeBlurTintColor, #1a1a2e); padding: 10px; border-radius: 5px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; margin-bottom: 15px;">${escapeHtml(systemPrompt)}</div>
                <h3>User Message</h3>
                <div style="background: var(--SmartThemeBlurTintColor, #1a1a2e); padding: 10px; border-radius: 5px; white-space: pre-wrap; max-height: 400px; overflow-y: auto;">${escapeHtml(userMessage)}</div>
            </div>
        `;

        callGenericPopup(previewHtml, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    });

    // Refresh Index button
    $('#dle_refresh').on('click', async function () {
        const $btn = $(this);
        const $icon = $btn.find('i');
        $btn.prop('disabled', true);
        $icon.removeClass('fa-rotate').addClass('fa-spinner fa-spin');
        try {
            setVaultIndex([]);
            setIndexTimestamp(0);
            await buildIndexFn();
        } finally {
            $btn.prop('disabled', false);
            $icon.removeClass('fa-spinner fa-spin').addClass('fa-rotate');
        }
    });

    // Browse Entries button
    $('#dle_browse_entries').on('click', function () {
        showBrowsePopup();
    });

    // Test Match button — simulate matching pipeline and show results
    $('#dle_test_match').on('click', async function () {
        const settings = getSettings();

        if (!chat || chat.length === 0) {
            toastr.warning('No active chat. Start a conversation first.', 'DeepLore Enhanced');
            return;
        }

        try {
            toastr.info('Running match simulation...', 'DeepLore Enhanced', { timeOut: 2000 });

            await ensureIndexFresh();

            if (vaultIndex.length === 0) {
                toastr.warning('No entries indexed. Check your Obsidian connection and lorebook tag.', 'DeepLore Enhanced');
                return;
            }

            // Run the full matching pipeline via shared runPipeline()
            const { finalEntries, matchedKeys, trace } = await runPipeline(chat);
            const keywordCount = trace.keywordMatched.filter(m => !m.matchedBy.startsWith('(constant') && !m.matchedBy.startsWith('(bootstrap')).length;
            const aiUsed = trace.aiSelected.length > 0 || trace.aiFallback;
            const aiError = trace.aiFallback;
            const aiSelectedCount = trace.aiSelected.length;

            // Simulate re-injection cooldown BEFORE gating (matches onGenerate order)
            let cooldownBlocked = [];
            let afterCooldown = finalEntries;
            if (settings.reinjectionCooldown > 0) {
                cooldownBlocked = finalEntries.filter(e => {
                    if (e.constant) return false;
                    const lastGen = injectionHistory.get(e.title);
                    return lastGen !== undefined && (generationCount - lastGen) < settings.reinjectionCooldown;
                });
                afterCooldown = finalEntries.filter(e => !cooldownBlocked.includes(e));
            }

            const gated = applyGating(afterCooldown);
            const gatedRemoved = afterCooldown.filter(e => !gated.includes(e));

            const { groups, count: injectedCount, totalTokens } = formatAndGroup(gated, getSettings(), PROMPT_TAG_PREFIX);

            const budgetRemoved = gated.slice(injectedCount);
            const injected = gated.slice(0, injectedCount);

            // Build popup HTML
            const positionLabels = { 0: 'After', 1: 'In-chat', 2: 'Before' };
            const roleLabels = { 0: 'System', 1: 'User', 2: 'Assistant' };

            let html = '<div style="text-align: left; font-family: monospace; font-size: 0.85em;">';

            // Summary
            html += `<h3>Match Summary</h3>`;
            html += `<div style="margin-bottom: 10px;">`;
            html += `<b>${vaultIndex.length}</b> indexed &rarr; `;
            if (settings.aiSearchMode === 'ai-only' && settings.aiSearchEnabled) {
                html += aiError
                    ? `<b style="color: var(--warning, #ff9800);">AI error (fallback to keywords)</b> &rarr; `
                    : `<b>${aiSelectedCount}</b> AI selected &rarr; `;
            } else if (settings.aiSearchEnabled) {
                html += `<b>${keywordCount}</b> keyword matched &rarr; `;
                if (aiUsed) {
                    html += aiError
                        ? `<b style="color: var(--warning, #ff9800);">AI error (fallback)</b> &rarr; `
                        : `<b>${aiSelectedCount}</b> AI selected &rarr; `;
                }
            } else {
                html += `<b>${keywordCount}</b> keyword matched &rarr; `;
            }
            html += `<b>${gated.length}</b> after gating &rarr; `;
            html += `<b style="color: var(--SmartThemeQuoteColor, #4caf50);">${injectedCount}</b> would inject (~${totalTokens} tokens)`;
            html += `</div>`;

            // Injected entries table
            if (injected.length > 0) {
                html += `<h3>Would Inject (${injectedCount} entries, ~${totalTokens} tokens)</h3>`;
                html += `<table style="width: 100%; border-collapse: collapse; margin-bottom: 15px;">`;
                html += `<tr style="border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.2));">`;
                html += `<th style="text-align: left; padding: 4px;">Title</th>`;
                html += `<th style="text-align: left; padding: 4px;">Matched By</th>`;
                html += `<th style="text-align: right; padding: 4px;">Priority</th>`;
                html += `<th style="text-align: right; padding: 4px;">Tokens</th>`;
                html += `<th style="text-align: left; padding: 4px;">Position</th>`;
                html += `</tr>`;
                for (const entry of injected) {
                    const pos = entry.injectionPosition ?? settings.injectionPosition;
                    const depth = entry.injectionDepth ?? settings.injectionDepth;
                    const role = entry.injectionRole ?? settings.injectionRole;
                    const posLabel = pos === 1
                        ? `In-chat @${depth} (${roleLabels[role] || '?'})`
                        : (positionLabels[pos] || '?');
                    html += `<tr style="border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.1));">`;
                    html += `<td style="padding: 4px;">${escapeHtml(entry.title)}</td>`;
                    html += `<td style="padding: 4px; opacity: 0.8;">${escapeHtml(matchedKeys.get(entry.title) || '?')}</td>`;
                    html += `<td style="text-align: right; padding: 4px;">${entry.priority}</td>`;
                    html += `<td style="text-align: right; padding: 4px;">${entry.tokenEstimate}</td>`;
                    html += `<td style="padding: 4px; opacity: 0.8;">${posLabel}</td>`;
                    html += `</tr>`;
                }
                html += `</table>`;
            } else {
                html += `<p style="color: var(--warning, #ff9800);">No entries would be injected.</p>`;
            }

            // Gating removed
            if (gatedRemoved.length > 0) {
                html += `<h3 style="color: var(--warning, #ff9800);">Removed by Gating (${gatedRemoved.length})</h3>`;
                html += `<ul style="margin: 0 0 15px 20px;">`;
                for (const entry of gatedRemoved) {
                    const reasons = [];
                    if (entry.requires.length > 0) reasons.push(`requires: ${entry.requires.join(', ')}`);
                    if (entry.excludes.length > 0) reasons.push(`excludes: ${entry.excludes.join(', ')}`);
                    html += `<li>${escapeHtml(entry.title)} — ${escapeHtml(reasons.join('; ') || 'dependency chain')}</li>`;
                }
                html += `</ul>`;
            }

            // Cooldown blocked
            if (cooldownBlocked.length > 0) {
                html += `<h3 style="color: var(--warning, #ff9800);">Cooldown Blocked (${cooldownBlocked.length})</h3>`;
                html += `<ul style="margin: 0 0 15px 20px;">`;
                for (const entry of cooldownBlocked) {
                    const lastGen = injectionHistory.get(entry.title);
                    html += `<li>${escapeHtml(entry.title)} — injected ${generationCount - lastGen} gen(s) ago (cooldown: ${settings.reinjectionCooldown})</li>`;
                }
                html += `</ul>`;
            }

            // Probability skipped
            if (trace.probabilitySkipped && trace.probabilitySkipped.length > 0) {
                html += `<h3 style="color: var(--warning, #ff9800);">Probability Skipped (${trace.probabilitySkipped.length})</h3>`;
                html += `<ul style="margin: 0 0 15px 20px;">`;
                for (const ps of trace.probabilitySkipped) {
                    html += `<li>${escapeHtml(ps.title)} — rolled ${ps.roll.toFixed(3)} > ${ps.probability} (${Math.round(ps.probability * 100)}% chance)</li>`;
                }
                html += `</ul>`;
            }

            // Budget/max removed
            if (budgetRemoved.length > 0) {
                html += `<h3 style="color: var(--warning, #ff9800);">Cut by Budget/Max (${budgetRemoved.length})</h3>`;
                html += `<ul style="margin: 0 0 15px 20px;">`;
                for (const entry of budgetRemoved) {
                    html += `<li>${escapeHtml(entry.title)} (pri ${entry.priority}, ~${entry.tokenEstimate} tokens)</li>`;
                }
                html += `</ul>`;
            }

            // Unmatched entries with keys (diagnostic aid — click for "Why Not?" diagnosis)
            const matchedTitles = new Set(finalEntries.map(e => e.title));
            const unmatchedWithKeys = vaultIndex.filter(e => !matchedTitles.has(e.title) && !e.constant && e.keys.length > 0);
            if (unmatchedWithKeys.length > 0) {
                html += `<details style="margin-top: 10px;"><summary style="cursor: pointer; opacity: 0.7;">Unmatched entries with keywords (${unmatchedWithKeys.length}) — click an entry for diagnosis</summary>`;
                html += `<ul style="margin: 5px 0 0 20px;">`;
                for (const entry of unmatchedWithKeys.slice(0, 30)) {
                    const probInfo = entry.probability !== null ? ` (probability: ${entry.probability})` : '';
                    const diagId = simpleHash(entry.filename + '_diag');
                    const diagnosis = diagnoseEntry(entry, chat);
                    const stageColors = {
                        keyword_miss: '#ff9800', no_keywords: '#f44336', scan_depth_zero: '#f44336',
                        warmup: '#ff9800', cooldown: '#ff9800', reinjection_cooldown: '#ff9800',
                        probability: '#9c27b0', refine_keys: '#ff9800',
                        gating_requires: '#f44336', gating_excludes: '#f44336',
                        ai_rejected: '#2196f3', budget_cut: '#ff9800',
                    };
                    const stageColor = stageColors[diagnosis.stage] || '#999';
                    html += `<li style="cursor: pointer; margin-bottom: 4px;" onclick="document.getElementById('dle_diag_${diagId}').style.display = document.getElementById('dle_diag_${diagId}').style.display === 'none' ? 'block' : 'none'">`;
                    html += `${escapeHtml(entry.title)} — keys: ${escapeHtml(entry.keys.join(', '))}${escapeHtml(probInfo)}`;
                    html += `<div id="dle_diag_${diagId}" style="display: none; margin-top: 4px; padding: 6px; background: var(--SmartThemeBlurTintColor, #1a1a2e); border-radius: 4px; border-left: 3px solid ${stageColor};">`;
                    html += `<strong style="color: ${stageColor};">${escapeHtml(diagnosis.stage.replace(/_/g, ' '))}</strong>: ${escapeHtml(diagnosis.detail)}`;
                    if (diagnosis.suggestions.length > 0) {
                        html += `<br><small style="opacity: 0.8;">Suggestion: ${escapeHtml(diagnosis.suggestions[0])}</small>`;
                    }
                    html += `</div></li>`;
                }
                if (unmatchedWithKeys.length > 30) {
                    html += `<li>...and ${unmatchedWithKeys.length - 30} more</li>`;
                }
                html += `</ul></details>`;
            }

            // Entries with no keys (potential misconfiguration)
            const noKeys = vaultIndex.filter(e => e.keys.length === 0 && !e.constant);
            if (noKeys.length > 0) {
                html += `<details style="margin-top: 10px;"><summary style="cursor: pointer; color: var(--warning, #ff9800);">Entries with no keywords (${noKeys.length})</summary>`;
                html += `<ul style="margin: 5px 0 0 20px;">`;
                for (const entry of noKeys.slice(0, 30)) {
                    html += `<li>${escapeHtml(entry.title)} (${escapeHtml(entry.filename)})</li>`;
                }
                if (noKeys.length > 30) {
                    html += `<li>...and ${noKeys.length - 30} more</li>`;
                }
                html += `</ul></details>`;
            }

            html += `</div>`;

            callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
        } catch (err) {
            console.error('[DLE] Test Match error:', err);
            toastr.error(String(err), 'DeepLore Enhanced');
        }
    });
}
