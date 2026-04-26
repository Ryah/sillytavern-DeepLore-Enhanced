/**
 * boot.js — side-effect-only bootstrap for the diagnostic system.
 *
 * Imported as the FIRST line of index.js so interceptors are installed
 * before any other DLE code runs (and, with manifest.loading_order set
 * low, before most other third-party extensions).
 *
 * Do not export anything stateful from here — keep it tiny.
 */

import { installInterceptors } from './interceptors.js';
import { startPerformanceObservers } from './performance.js';

try { installInterceptors(); } catch (e) { try { console.warn('[DLE-boot] interceptor install failed:', e); } catch { /* noop */ } }
try { startPerformanceObservers(); } catch (e) { try { console.warn('[DLE-boot] perf observer install failed:', e); } catch { /* noop */ } }
