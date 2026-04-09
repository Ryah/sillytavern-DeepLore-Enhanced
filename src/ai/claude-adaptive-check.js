/**
 * DeepLore Enhanced — Claude Adaptive-Thinking Misconfiguration Detector
 *
 * Claude opus-4-6 / sonnet-4-6 use adaptive thinking. ST's chat-completions
 * code path requires `reasoning_effort` to be explicitly set to low/medium/high
 * on the OpenAI completion preset bound to a Connection Manager profile —
 * "auto" / undefined produces 400 errors at request time.
 *
 * This module detects the bad combination and exposes a single shape that all
 * UI surfaces (toasts, banners, drawer chip, wizard inline error, error
 * rewriter) consume. We never override the user's setting; we only warn.
 */

export const CLAUDE_ADAPTIVE_REGEX = /^claude-(opus-4-6|sonnet-4-6)/i;

const VALID_EFFORTS = new Set(['low', 'medium', 'high']);

/**
 * Detect whether the given Connection Manager profile + optional model override
 * is in the broken adaptive-thinking state.
 *
 * @param {string} profileId - Connection Manager profile id
 * @param {string} [modelOverride] - DLE per-feature model override (e.g. settings.aiSearchModel)
 * @param {object} [opts]
 * @param {object} [opts.freshPreset] - BUG-397: optionally pass a just-read preset object so callers on hot paths avoid any risk of a stale preset manager cache; if omitted we re-read JIT from ctx.getPresetManager('openai').
 * @returns {{bad: boolean, reason?: string, profileName?: string, modelName?: string, presetName?: string}}
 */
export function detectClaudeAdaptiveIssue(profileId, modelOverride, opts = {}) {
    try {
        if (!profileId) return { bad: false };

        // CMRS lives on shared.js — guard against missing import surface.
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
        if (!ctx) return { bad: false };

        const cmrs = ctx.ConnectionManagerRequestService;
        const profile = cmrs?.getProfile?.(profileId);
        if (!profile) return { bad: false };

        // Native Anthropic only. OpenRouter / custom wrappers take different code paths.
        if (profile.api !== 'claude') return { bad: false };

        const model = (modelOverride && modelOverride.trim()) || profile.model || '';
        if (!CLAUDE_ADAPTIVE_REGEX.test(model)) return { bad: false };

        const presetName = profile.preset;
        if (!presetName) {
            return {
                bad: true,
                reason: 'no_preset',
                profileName: profile.name || profileId,
                modelName: model,
                presetName: '(none)',
            };
        }

        // BUG-397: always re-read preset just-in-time (never memoize across calls);
        // callers on hot paths can pass a fresh preset via opts.freshPreset to skip the lookup.
        const preset = opts.freshPreset
            || ctx.getPresetManager?.('openai')?.getCompletionPresetByName?.(presetName);
        const effort = preset?.reasoning_effort;

        if (!effort || !VALID_EFFORTS.has(String(effort).toLowerCase())) {
            return {
                bad: true,
                reason: effort ? 'auto' : 'unset',
                profileName: profile.name || profileId,
                modelName: model,
                presetName,
            };
        }

        return { bad: false };
    } catch (err) {
        // Detection must never throw — this runs from many surfaces.
        if (typeof console !== 'undefined') console.debug('[DLE] claude-adaptive-check error:', err);
        return { bad: false };
    }
}

/**
 * Build a human-readable warning string for a given surface.
 *
 * @param {object} detail - Result of detectClaudeAdaptiveIssue when bad===true
 * @param {'toast'|'banner'|'wizard'|'error'|'chip'} surface
 * @returns {string}
 */
export function buildClaudeAdaptiveMessage(detail, surface = 'toast') {
    const { profileName = '?', modelName = '?', presetName = '?' } = detail || {};
    const path = `Connection Manager → edit preset "${presetName}" → Reasoning Effort → Low / Medium / High`;

    if (surface === 'chip') return `${modelName} needs Reasoning Effort set`;
    if (surface === 'error') {
        return `Claude ${modelName} requires reasoning_effort=low|medium|high (auto/unset is rejected). Open ${path}.`;
    }
    if (surface === 'wizard') {
        return `Heads up: profile "${profileName}" uses ${modelName}, which is an adaptive-thinking model. Its bound completion preset "${presetName}" has reasoning_effort unset or "auto" — SillyTavern will reject every request with a 400 error. Fix it in ${path}, or pick a different model. If you're using a proxy that handles this differently, ignore this warning.`;
    }
    if (surface === 'banner') {
        return `Profile "${profileName}" + ${modelName}: completion preset "${presetName}" needs reasoning_effort set to Low, Medium, or High. ${path}.`;
    }
    // toast (default)
    return `DeepLore: ${modelName} on profile "${profileName}" will fail — set reasoning_effort on preset "${presetName}" (Low/Medium/High).`;
}

/**
 * Resolve a DLE feature's effective AI connection mode, following the
 * `inherit` chain back to AI Search. Returns 'profile' | 'proxy' | 'inherit'
 * (only AI Search itself, defaulted) | whatever else the user set.
 *
 * @param {object} settings - getSettings() result
 * @param {'aiSearch'|'scribe'|'autoSuggest'|'aiNotepad'|'librarian'|'optimizeKeys'} feature
 * @returns {string}
 */
export function resolveFeatureConnectionMode(settings, feature) {
    if (!settings) return 'profile';
    const map = {
        aiSearch: 'aiSearchConnectionMode',
        scribe: 'scribeConnectionMode',
        autoSuggest: 'autoSuggestConnectionMode',
        aiNotepad: 'aiNotepadConnectionMode',
        librarian: 'librarianConnectionMode',
        optimizeKeys: 'optimizeKeysConnectionMode',
    };
    const key = map[feature];
    if (!key) return 'profile';
    let mode = settings[key];
    // Fall back through inherit → AI Search root.
    if (mode === 'inherit') mode = settings.aiSearchConnectionMode || 'profile';
    return mode || 'profile';
}

/**
 * Whether the adaptive-thinking check is meaningful for this feature.
 * Proxy mode routes through a local proxy (e.g. claude-code-proxy) that
 * handles thinking itself, so the native-Anthropic preset check is a
 * false positive there. Only `profile` mode warrants the warning.
 *
 * @param {object} settings
 * @param {string} feature
 */
export function shouldCheckClaudeAdaptiveForFeature(settings, feature) {
    return resolveFeatureConnectionMode(settings, feature) === 'profile';
}

// ─────────────────────────────────────────────────────────────────────────────
// Session-scoped one-shot toast tracking. The drawer chip + settings banner
// are the persistent surfaces; the toast is just a heads-up on first detection
// per (profile, model, preset) combo per browser session.
// ─────────────────────────────────────────────────────────────────────────────
const _sessionToastShown = new Set();

/**
 * Returns true if the toast for this combo has NOT been shown yet this
 * session, and marks it as shown. Returns false if it was already shown.
 *
 * @param {object} detail - detectClaudeAdaptiveIssue result with bad===true
 * @returns {boolean}
 */
export function claimClaudeAdaptiveToastSlot(detail) {
    if (!detail) return false;
    const key = `${detail.profileName || '?'}|${detail.modelName || '?'}|${detail.presetName || '?'}`;
    if (_sessionToastShown.has(key)) return false;
    _sessionToastShown.add(key);
    return true;
}

/** Test helper — clears the session toast set. */
export function _resetClaudeAdaptiveToastSession() {
    _sessionToastShown.clear();
}
