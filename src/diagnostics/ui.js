/**
 * ui.js — User-facing entry point for the diagnostic exporter.
 *
 * triggerDiagnosticDownload():
 * - Builds the anonymized report + unanonymized reference file (in-memory, async).
 * - Downloads both via ephemeral <a download>.click().
 * - Returns { scrubStats } so the caller can show what was anonymized.
 */

import { buildDiagnosticReport } from './export.js';

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    try {
        a.click();
    } finally {
        setTimeout(() => {
            try { URL.revokeObjectURL(url); } catch { /* noop */ }
            try { a.remove(); } catch { /* noop */ }
        }, 0);
    }
}

export async function triggerDiagnosticDownload() {
    const { report, referenceFile, scrubStats } = await buildDiagnosticReport();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');

    // 1. Download the anonymized report (safe to share)
    downloadBlob(
        new Blob([report], { type: 'text/markdown' }),
        `dle-diagnostics-${ts}.md`,
    );

    // 2. Download the unanonymized connections reference (user's eyes only)
    downloadBlob(
        new Blob([referenceFile], { type: 'text/markdown' }),
        `dle-connections-reference-${ts}.md`,
    );

    return { scrubStats };
}
