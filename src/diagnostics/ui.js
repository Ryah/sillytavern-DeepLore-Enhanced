/**
 * ui.js — User-facing entry point for the diagnostic exporter.
 * Builds anonymized + unanonymized report files and downloads both.
 * Returns { scrubStats } so caller can show what was anonymized.
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

    // Anonymized report — safe to share.
    downloadBlob(
        new Blob([report], { type: 'text/markdown' }),
        `dle-diagnostics-${ts}.md`,
    );

    // Unanonymized connections reference — user's eyes only.
    downloadBlob(
        new Blob([referenceFile], { type: 'text/markdown' }),
        `dle-connections-reference-${ts}.md`,
    );

    return { scrubStats };
}
