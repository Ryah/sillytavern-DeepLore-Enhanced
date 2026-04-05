/**
 * DeepLore Enhanced — AI Candidate Manifest Builder
 * Extracted from ai.js for testability (no SillyTavern imports).
 */

import { truncateToSentence, escapeXml } from '../../core/utils.js';
import { fieldDefinitions, decayTracker, consecutiveInjections, trackerKey } from '../state.js';
import { isForceInjected } from '../helpers.js';

/**
 * Build an XML manifest of candidate entries for the AI search prompt.
 * Filters out force-injected entries (constants/bootstraps), formats each entry
 * with metadata (token count, links, decay hints, custom fields), and produces
 * a header summarizing the candidate pool.
 *
 * @param {Array} candidates - All candidate VaultEntry objects
 * @param {boolean} [excludeBootstrap=false] - Whether to also exclude bootstrap entries
 * @param {object} [settings] - Settings object (defaults to getSettings() in production)
 * @returns {{ manifest: string, header: string }}
 */
export function buildCandidateManifest(candidates, excludeBootstrap = false, settings = null) {
    // In production, settings is passed by the caller (ai.js injects getSettings())
    const s = settings || {};
    const summaryLen = s.aiSearchManifestSummaryLength || 600;

    const summaryMode = s.manifestSummaryMode || 'prefer_summary';
    let selectable = candidates.filter(e => !isForceInjected(e, { bootstrapActive: excludeBootstrap }));

    // E8: In summary_only mode, exclude entries that have no summary field
    if (summaryMode === 'summary_only') {
        selectable = selectable.filter(e => e.summary && e.summary.trim());
    }

    if (selectable.length === 0) return { manifest: '', header: '' };

    const fieldLabelMap = new Map(fieldDefinitions.map(f => [f.name, f.label]));
    const manifest = selectable
        .map(entry => {
            // E8: Select summary text based on manifestSummaryMode
            const summaryText = summaryMode === 'content_only'
                ? truncateToSentence(entry.content.substring(0, summaryLen * 3).replace(/\n+/g, ' ').trim(), summaryLen)
                : (entry.summary || truncateToSentence(entry.content.substring(0, summaryLen * 3).replace(/\n+/g, ' ').trim(), summaryLen));
            const safeSummary = summaryText;
            const links = entry.resolvedLinks && entry.resolvedLinks.length > 0
                ? ` → ${entry.resolvedLinks.join(', ')}`
                : '';
            // Decay/freshness annotation: hint to AI about stale or frequently-injected entries
            let decayHint = '';
            if (s.decayEnabled && decayTracker.size > 0) {
                const staleness = decayTracker.get(trackerKey(entry));
                if (staleness !== undefined && staleness >= s.decayBoostThreshold) {
                    decayHint = ' [STALE — consider refreshing]';
                }
                // Penalty: entries injected many consecutive times get a nudge.
                if (!decayHint && s.decayPenaltyThreshold > 0) {
                    const streak = consecutiveInjections.get(trackerKey(entry));
                    if (streak !== undefined && streak >= s.decayPenaltyThreshold) {
                        decayHint = ' [FREQUENT — consider diversifying]';
                    }
                }
            }
            // Custom field annotations (e.g. [Era: medieval | Location: tavern])
            let fieldsHint = '';
            if (entry.customFields) {
                const pairs = Object.entries(entry.customFields)
                    .filter(([, v]) => v != null && v !== '' && (!Array.isArray(v) || v.length > 0))
                    .map(([k, v]) => `${fieldLabelMap.get(k) || k}: ${Array.isArray(v) ? v.join(', ') : v}`);
                if (pairs.length > 0) fieldsHint = `\n[${pairs.join(' | ')}]`;
            }
            const attrSafeTitle = escapeXml(entry.title);
            const header = `${entry.title} (${entry.tokenEstimate}tok)${links}${decayHint}${fieldsHint}`;

            // Wrap each entry in structural delimiters to prevent summary content
            // from being interpreted as manifest-level instructions
            return `<entry name="${attrSafeTitle}">\n${header}\n${safeSummary}\n</entry>`;
        })
        .join('\n');

    // BUG-047: Use candidates.length (includes force-injected) not selectable.length (tautological)
    const forcedCount = candidates.length - selectable.length;
    let forcedTokens = 0;
    for (const e of candidates) { if (isForceInjected(e)) forcedTokens += e.tokenEstimate; }
    const budgetInfo = s.unlimitedBudget
        ? ''
        : `\nToken budget: ~${s.maxTokensBudget} tokens total.`;

    const header = `Candidate entries: ${selectable.length} (from ${candidates.length} total).`
        + (forcedCount > 0 ? `\n${forcedCount} entries are always included (~${forcedTokens} tokens).` : '')
        + budgetInfo;

    return { manifest, header };
}
