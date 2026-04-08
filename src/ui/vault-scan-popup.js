/**
 * DeepLore Enhanced — Vault Scan Popup.
 * Modal that runs the vault scanner and lets the user pick a discovered vault.
 */
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { scanVaults } from '../vault/scanner.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Open the vault scan popup, run the scan, and resolve with the user-selected vault (or null).
 * @param {{host?: string, apiKey?: string, portCenter?: number, radius?: number}} opts
 * @returns {Promise<object|null>}
 */
export async function openVaultScanPopup(opts = {}) {
    const html = `
        <div class="dle-vault-scan-popup">
            <h3>Scan for Obsidian Vaults</h3>
            <p class="dle-vault-scan-sub">Probing ports ${Math.max(1, (opts.portCenter || 27124) - (opts.radius || 25))}–${(opts.portCenter || 27124) + (opts.radius || 25)} on ${esc(opts.host || '127.0.0.1')}…</p>
            <div class="dle-vault-scan-progress-wrap">
                <div class="dle-vault-scan-progress-bar"><div class="dle-vault-scan-progress-fill" id="dle-vsp-fill" style="width: 0%"></div></div>
                <div class="dle-vault-scan-progress-text" id="dle-vsp-text">Starting…</div>
            </div>
            <div class="dle-vault-scan-results" id="dle-vsp-results"></div>
            <details class="dle-vault-scan-help">
                <summary>How do I trust the Obsidian cert?</summary>
                <div>
                    <p>Install the Obsidian Local REST API certificate into your <strong>OS trust store</strong> — accepting the warning in your browser is not enough; <code>fetch()</code> from SillyTavern still fails.</p>
                    <ul>
                        <li><strong>Windows:</strong> Double-click the cert → Install Certificate → Local Machine → Trusted Root Certification Authorities.</li>
                        <li><strong>macOS:</strong> Keychain Access → System → drag cert in → set Trust to Always Trust.</li>
                        <li><strong>Linux:</strong> <code>sudo cp obsidian-local-rest-api.crt /usr/local/share/ca-certificates/ &amp;&amp; sudo update-ca-certificates</code> (Firefox needs its own NSS DB import).</li>
                    </ul>
                </div>
            </details>
        </div>`;

    // Launch popup non-blocking by passing wide false; we need handle to update DOM. Use callGenericPopup OK-only.
    const popupPromise = callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true, large: false, allowVerticalScrolling: true, okButton: 'Cancel' });

    // Wait one tick for DOM, then run scan
    await new Promise(r => setTimeout(r, 50));
    const fill = document.getElementById('dle-vsp-fill');
    const text = document.getElementById('dle-vsp-text');
    const results = document.getElementById('dle-vsp-results');

    let selected = null;

    function renderResults(vaults, certUntrusted) {
        if (!results) return;
        if (vaults.length === 0 && certUntrusted.length === 0) {
            results.innerHTML = '<div class="dle-vault-scan-empty">No responding vaults found yet.</div>';
            return;
        }
        const rows = [];
        for (const v of vaults) {
            const authBadge = v.authenticated
                ? '<span class="dle-vault-scan-badge dle-ok">authenticated</span>'
                : '<span class="dle-vault-scan-badge dle-warn">no auth</span>';
            const schemeBadge = `<span class="dle-vault-scan-badge dle-scheme">${esc(v.scheme.toUpperCase())}</span>`;
            rows.push(`
                <div class="dle-vault-scan-row" data-port="${v.port}" data-scheme="${esc(v.scheme)}">
                    <div class="dle-vault-scan-row-main">
                        <strong>${esc(v.vaultName)}</strong>
                        <span class="dle-vault-scan-port">${esc(v.host)}:${v.port}</span>
                        ${schemeBadge} ${authBadge}
                    </div>
                    <button class="menu_button dle-vault-scan-pick">Use this</button>
                </div>`);
        }
        for (const c of certUntrusted) {
            if (c.httpFallbackOk) continue; // already represented in vaults list
            rows.push(`
                <div class="dle-vault-scan-row dle-cert-warn">
                    <div class="dle-vault-scan-row-main">
                        <strong>Port ${c.port}</strong>
                        <span class="dle-vault-scan-badge dle-warn">cert untrusted</span>
                        <span class="dle-vault-scan-port">${esc(c.note)}</span>
                    </div>
                </div>`);
        }
        results.innerHTML = rows.join('');

        // Wire pick buttons
        results.querySelectorAll('.dle-vault-scan-pick').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const row = e.currentTarget.closest('.dle-vault-scan-row');
                const port = parseInt(row?.dataset.port || '0', 10);
                const scheme = row?.dataset.scheme;
                selected = vaults.find(v => v.port === port && v.scheme === scheme) || null;
                // Programmatically dismiss the popup
                const okBtn = document.querySelector('.popup_ok');
                if (okBtn) okBtn.click();
            }, { once: true });
        });
    }

    // BUG-235: real cancel support — popup dismissal aborts in-flight probes so the
    // follow-up `await scanPromise` no longer blocks for the full scan duration.
    const scanAbort = new AbortController();

    // Run scan in parallel with the popup awaiting cancel
    const scanPromise = scanVaults({
        host: opts.host || '127.0.0.1',
        apiKey: opts.apiKey,
        portCenter: opts.portCenter || 27124,
        radius: opts.radius || 25,
        signal: scanAbort.signal,
        onProgress: ({ scanned, total, found }) => {
            if (fill) fill.style.width = `${Math.round((scanned / total) * 100)}%`;
            if (text) text.textContent = `Scanned ${scanned} / ${total} probes — ${found} vault${found === 1 ? '' : 's'} found`;
        },
    }).then(({ vaults, certUntrusted, scanDurationMs }) => {
        if (text) text.textContent = `Done in ${(scanDurationMs / 1000).toFixed(1)}s — ${vaults.length} vault${vaults.length === 1 ? '' : 's'}`;
        renderResults(vaults, certUntrusted);
    }).catch(err => {
        if (results) results.innerHTML = `<div class="dle-vault-scan-error">Scan failed: ${esc(err.message || String(err))}</div>`;
    });

    await popupPromise;
    // BUG-235: popup dismissed (Cancel or row pick) — abort any in-flight probes
    // so the await below returns immediately instead of blocking on stragglers.
    try { scanAbort.abort(); } catch { /* noop */ }
    await scanPromise; // make sure scan task finishes/cleans up
    return selected;
}
