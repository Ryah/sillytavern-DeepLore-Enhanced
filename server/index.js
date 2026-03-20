/**
 * DeepLore Enhanced — CORS Proxy Setup Plugin
 *
 * This is a one-shot SillyTavern server plugin that enables the built-in CORS proxy.
 * The CORS proxy is required for "Custom Proxy" AI connection mode.
 * If you only use Connection Profile mode, you don't need this at all.
 *
 * How it works:
 *   On init, reads SillyTavern's config.yaml and sets enableCorsProxy: true.
 *   No routes are registered — this plugin does nothing after setup.
 *
 * Installation:
 *   Copy this file to SillyTavern/plugins/deeplore-enhanced/index.js
 *   (or use the install script)
 */

const info = {
    id: 'deeplore-enhanced',
    name: 'DeepLore Enhanced — CORS Proxy Setup',
    description: 'Enables SillyTavern CORS proxy for DeepLore Enhanced proxy-mode AI connections',
};

async function init(_router) {
    try {
        const fs = require('node:fs');
        const path = require('node:path');
        const yaml = require('yaml');

        // Walk up from plugin dir to find config.yaml
        let dir = __dirname;
        let configPath = null;
        for (let i = 0; i < 5; i++) {
            const candidate = path.join(dir, 'config.yaml');
            if (fs.existsSync(candidate)) {
                configPath = candidate;
                break;
            }
            dir = path.dirname(dir);
        }

        if (!configPath) {
            console.log('[DeepLore Enhanced] Could not find config.yaml — CORS proxy not auto-configured');
            return;
        }

        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = yaml.parse(raw);

        if (config.enableCorsProxy) {
            console.log('[DeepLore Enhanced] CORS proxy already enabled');
            return;
        }

        config.enableCorsProxy = true;
        fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
        console.log('[DeepLore Enhanced] Enabled CORS proxy in config.yaml — restart SillyTavern for it to take effect');
    } catch (err) {
        console.warn('[DeepLore Enhanced] Could not auto-configure CORS proxy:', err.message);
        console.warn('[DeepLore Enhanced] To use proxy mode, manually set enableCorsProxy: true in config.yaml');
    }
}

async function exit() {}

module.exports = { info, init, exit };
