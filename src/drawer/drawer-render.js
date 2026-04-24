/**
 * DeepLore Enhanced — Drawer Render Functions (barrel re-export)
 * Split into zone-based modules; this file re-exports everything
 * so existing importers don't need to change.
 */
export { renderStatusZone, updateTabBadges } from './drawer-render-status.js';
export { renderInjectionTab, updateInjectionCountBadges, renderBrowseTab, renderBrowseWindow, renderGatingTab, renderTimers } from './drawer-render-tabs.js';
export { renderFooter } from './drawer-render-footer.js';
