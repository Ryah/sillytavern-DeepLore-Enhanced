/**
 * ui.js — User-facing entry point for the diagnostic exporter.
 *
 * Single function: triggerDiagnosticDownload().
 * - Builds the report (in-memory, async).
 * - Wraps it in a Blob and triggers the browser's normal download dialog
 *   via an ephemeral <a download>.click() — no leftover files.
 * - Resolves the moment .click() fires, so the caller can flip the button
 *   from "Processing..." to "Done" without waiting on the OS dialog.
 */

import { buildDiagnosticReport } from './export.js';

export async function triggerDiagnosticDownload() {
    const md = await buildDiagnosticReport();

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dle-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
    a.style.display = 'none';
    document.body.appendChild(a);
    try {
        a.click();
    } finally {
        // Defer revoke / cleanup to next tick so the browser has time to start
        // streaming the blob to disk before we yank the URL out from under it.
        setTimeout(() => {
            try { URL.revokeObjectURL(url); } catch { /* noop */ }
            try { a.remove(); } catch { /* noop */ }
        }, 0);
    }
}
