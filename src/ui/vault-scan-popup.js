/** DeepLore Enhanced — Vault Scan Popup. Runs scanner, user picks discovered vault. */
import { callGenericPopup, POPUP_TYPE } from '../../../../../popup.js';
import { scanVaults } from '../vault/scanner.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param {{host?: string, apiKey?: string, portCenter?: number, radius?: number}} opts
 * @returns {Promise<object|null>} selected vault, or null if cancelled
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

    // BUG-103: scoped DOM refs via onOpen — fires once popup is in the DOM.
    let fill, text, results;
    let onOpenResolve;
    const onOpenReady = new Promise(r => { onOpenResolve = r; });

    const popupPromise = callGenericPopup(html, POPUP_TYPE.TEXT, '', {
        wide: true, large: false, allowVerticalScrolling: true, okButton: 'Cancel',
        onOpen: (popup) => {
            const root = popup?.dlg || document;
            fill = root.querySelector('#dle-vsp-fill') || root.querySelector('.dle-vault-scan-progress-fill');
            text = root.querySelector('#dle-vsp-text') || root.querySelector('.dle-vault-scan-progress-text');
            results = root.querySelector('#dle-vsp-results') || root.querySelector('.dle-vault-scan-results');
            onOpenResolve();
        },
    });

    await onOpenReady;

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
            if (c.httpFallbackOk) continue; // already in vaults list
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

        results.querySelectorAll('.dle-vault-scan-pick').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const row = e.currentTarget.closest('.dle-vault-scan-row');
                const port = parseInt(row?.dataset.port || '0', 10);
                const scheme = row?.dataset.scheme;
                selected = vaults.find(v => v.port === port && v.scheme === scheme) || null;
                const okBtn = document.querySelector('.popup_ok');
                if (okBtn) okBtn.click();
            }, { once: true });
        });
    }

    // BUG-235: cancel aborts in-flight probes so `await scanPromise` below doesn't
    // block for the full scan duration on stragglers.
    const scanAbort = new AbortController();

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
    try { scanAbort.abort(); } catch { /* noop */ }
    await scanPromise;
    return selected;
}
