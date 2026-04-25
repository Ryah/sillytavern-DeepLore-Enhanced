/**
 * Import path verification script.
 * Scans all .js/.mjs files, extracts relative imports, verifies:
 *   1. Project-internal imports resolve to a real file
 *   2. ST external imports use consistent ../depth for the same target module
 *   3. Named exports from project-internal modules actually exist in the target file
 * Run with: node test/verify-imports.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function collectFiles(dir) {
    const results = [];
    if (!existsSync(dir)) return results;
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) results.push(...collectFiles(full));
        else if (entry.endsWith('.js') || entry.endsWith('.mjs')) results.push(full);
    }
    return results;
}

const allFiles = [
    join(ROOT, 'index.js'),
    join(ROOT, 'settings.js'),
    ...collectFiles(join(ROOT, 'src')),
    ...collectFiles(join(ROOT, 'core')),
    ...collectFiles(join(ROOT, 'test')),
].filter(f => existsSync(f) && !f.endsWith('verify-imports.mjs'));

const importRegex = /^\s*(?:import|export)\s+.*?from\s+['"](\.[^'"]+)['"]/gm;
const importBareRegex = /^\s*import\s+['"](\.[^'"]+)['"]\s*;?/gm;
const dynamicLiteralRegex = /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const dynamicNonLiteralRegex = /\bimport\(\s*[^'")][^)]*\)/g;
const namedImportRegex = /^\s*import\s+\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]/gm;

let broken = 0;
let total = 0;
let stImports = 0;
let bareImports = 0;
let dynamicImports = 0;
let nonLiteralWarnings = 0;

// ── Check 1: File existence ──────────────────────────────────────────────

function getLineNumber(content, offset) {
    return content.slice(0, offset).split('\n').length;
}

function checkResolvableImport(file, content, importPath, matchOffset, kind) {
    const resolved = resolve(dirname(file), importPath);
    // Skip SillyTavern imports (resolve outside project root)
    if (!resolved.startsWith(ROOT)) {
        stImports++;
        return;
    }
    if (!existsSync(resolved)) {
        const rel = relative(ROOT, file).replace(/\\/g, '/');
        const target = relative(ROOT, resolved).replace(/\\/g, '/');
        const line = getLineNumber(content, matchOffset);
        console.log(`BROKEN [${kind}]: ${rel}:${line} -> ${importPath}  (resolves to ${target})`);
        broken++;
    }
}

// Strip block comments (incl. JSDoc) and line comments to avoid false-positive
// matches on `@param {import('...')}` type annotations and commented-out imports.
function stripComments(src) {
    let out = '';
    let i = 0;
    let inSingle = false, inDouble = false, inTmpl = false, inLine = false, inBlock = false;
    while (i < src.length) {
        const c = src[i], n = src[i + 1];
        if (inLine) {
            if (c === '\n') { inLine = false; out += c; }
            i++; continue;
        }
        if (inBlock) {
            if (c === '*' && n === '/') { inBlock = false; out += '  '; i += 2; continue; }
            // preserve newlines so line numbers are stable
            out += (c === '\n') ? '\n' : ' ';
            i++; continue;
        }
        if (inSingle) {
            if (c === '\\' && i + 1 < src.length) { out += c + src[i + 1]; i += 2; continue; }
            if (c === '\'') inSingle = false;
            out += c; i++; continue;
        }
        if (inDouble) {
            if (c === '\\' && i + 1 < src.length) { out += c + src[i + 1]; i += 2; continue; }
            if (c === '"') inDouble = false;
            out += c; i++; continue;
        }
        if (inTmpl) {
            if (c === '\\' && i + 1 < src.length) { out += c + src[i + 1]; i += 2; continue; }
            if (c === '`') inTmpl = false;
            out += c; i++; continue;
        }
        if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
        if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
        if (c === '\'') { inSingle = true; out += c; i++; continue; }
        if (c === '"') { inDouble = true; out += c; i++; continue; }
        if (c === '`') { inTmpl = true; out += c; i++; continue; }
        out += c; i++;
    }
    return out;
}

for (const file of allFiles) {
    const rawContent = readFileSync(file, 'utf8');
    const content = stripComments(rawContent);
    let m;

    // 1a: `import ... from '...'` and `export ... from '...'`
    importRegex.lastIndex = 0;
    while ((m = importRegex.exec(content)) !== null) {
        // Skip string literals in test descriptions (not real imports)
        if (file.endsWith('.mjs') && m[0].includes("'...")) continue;
        total++;
        checkResolvableImport(file, content, m[1], m.index, 'static');
    }

    // 1b: `import './foo.js';` (side-effect / bare import)
    importBareRegex.lastIndex = 0;
    while ((m = importBareRegex.exec(content)) !== null) {
        total++;
        bareImports++;
        checkResolvableImport(file, content, m[1], m.index, 'bare');
    }

    // 1c: `import('./foo.js')` (dynamic, string-literal)
    dynamicLiteralRegex.lastIndex = 0;
    while ((m = dynamicLiteralRegex.exec(content)) !== null) {
        total++;
        dynamicImports++;
        checkResolvableImport(file, content, m[1], m.index, 'dynamic');
    }

    // 1d: `import(<non-literal>)` — warn-only, can't resolve
    dynamicNonLiteralRegex.lastIndex = 0;
    while ((m = dynamicNonLiteralRegex.exec(content)) !== null) {
        // Skip if it's actually a literal (already counted in 1c).
        const after = m[0].slice('import('.length).trimStart();
        if (after.startsWith("'") || after.startsWith('"')) continue;
        const rel = relative(ROOT, file).replace(/\\/g, '/');
        const line = getLineNumber(content, m.index);
        console.log(`WARN [dynamic-nonliteral]: ${rel}:${line} — non-literal dynamic import, manual review required`);
        nonLiteralWarnings++;
    }
}

console.log('---');
console.log(`Total relative imports checked: ${total}`);
console.log(`  static (import/export from):  ${total - bareImports - dynamicImports}`);
console.log(`  bare side-effect imports:     ${bareImports}`);
console.log(`  dynamic literal imports:      ${dynamicImports}`);
console.log(`SillyTavern imports (skipped file-exist, not in repo): ${stImports}`);
console.log(`Project imports verified: ${total - stImports}`);
console.log(`Broken: ${broken}`);
if (nonLiteralWarnings > 0) {
    console.log(`Non-literal dynamic imports (warn-only): ${nonLiteralWarnings}`);
}

// ── Check 2: ST import path depth consistency ────────────────────────────
// Files at the same directory depth from ROOT should use the same number of
// ../ segments to reach the same ST module. e.g. all files in src/librarian/
// should use ../../../../../openai.js, not ../../../../openai.js.

let depthErrors = 0;

// Map: stModuleName -> Map<depthFromRoot, { prefix, files[] }>
const stImportMap = new Map();

for (const file of allFiles) {
    // Skip test files — they don't import ST modules
    if (file.includes('test/') || file.includes('test\\')) continue;

    const content = readFileSync(file, 'utf8');
    let m;
    importRegex.lastIndex = 0;
    while ((m = importRegex.exec(content)) !== null) {
        const importPath = m[1];
        const resolved = resolve(dirname(file), importPath);

        // Only ST imports (resolve outside project root)
        if (resolved.startsWith(ROOT)) continue;

        // Count ../ segments
        const dotdotCount = (importPath.match(/\.\.\//g) || []).length;

        // Compute depth of this file from ROOT (e.g. index.js=0, src/librarian/foo.js=2)
        const relFile = relative(ROOT, file).replace(/\\/g, '/');
        const depth = relFile.split('/').length - 1; // subtract filename

        // The ST module name is the resolved path's basename (e.g. openai.js, script.js)
        // But two different ST modules could share a basename at different depths, so use
        // the ../ count minus the file depth to get the "escape" count past ROOT
        const stModuleName = basename(resolved);

        if (!stImportMap.has(stModuleName)) stImportMap.set(stModuleName, new Map());
        const byDepth = stImportMap.get(stModuleName);
        if (!byDepth.has(depth)) byDepth.set(depth, { dotdotCount, files: [] });
        const entry = byDepth.get(depth);
        entry.files.push(relFile);

        // Check: all files at this depth should use the same dotdot count for this module
        if (entry.dotdotCount !== dotdotCount) {
            const rel = relFile;
            console.log(
                `ST-PATH-MISMATCH: ${rel} imports ${stModuleName} with ${dotdotCount}x "../" ` +
                `but other files at same depth use ${entry.dotdotCount}x "../" ` +
                `(e.g. ${entry.files[0]})`
            );
            depthErrors++;
        }
    }
}

if (depthErrors > 0) {
    console.log(`\nST import path mismatches: ${depthErrors}`);
} else {
    console.log(`ST import path depth: consistent (${stImports} imports checked)`);
}

// ── Check 3: Named export verification ───────────────────────────────────
// For project-internal imports with { named } bindings, verify the target
// file actually exports those names.

let exportErrors = 0;

// Build a cache of exports per file
const exportCache = new Map();
function getExportsForFile(filePath) {
    if (exportCache.has(filePath)) return exportCache.get(filePath);
    if (!existsSync(filePath)) { exportCache.set(filePath, null); return null; }

    const content = readFileSync(filePath, 'utf8');
    const exports = new Set();

    // export function name / export async function name
    for (const m of content.matchAll(/^\s*export\s+(?:async\s+)?function\s+(\w+)/gm)) {
        exports.add(m[1]);
    }
    // export class name
    for (const m of content.matchAll(/^\s*export\s+class\s+(\w+)/gm)) {
        exports.add(m[1]);
    }
    // export const/let/var name — handles `export let a, b, c;`
    for (const m of content.matchAll(/^\s*export\s+(?:const|let|var)\s+([^;=]+)/gm)) {
        // Split on comma to handle multiple declarations
        for (const part of m[1].split(',')) {
            const name = part.trim().match(/^(\w+)/);
            if (name) exports.add(name[1]);
        }
    }
    // export { name1, name2 } or export { name1 as alias }
    for (const m of content.matchAll(/^\s*export\s+\{([^}]+)\}/gm)) {
        for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0].trim();
            if (name) exports.add(name);
        }
    }
    // export default — tracked as 'default'
    if (/^\s*export\s+default\b/m.test(content)) {
        exports.add('default');
    }
    // Re-exports: export { ... } from '...'
    // We don't chase these transitively — just note what names are re-exported
    for (const m of content.matchAll(/^\s*export\s+\{([^}]+)\}\s+from\s+/gm)) {
        for (const part of m[1].split(',')) {
            const parts = part.trim().split(/\s+as\s+/);
            const exportedName = parts.length > 1 ? parts[1].trim() : parts[0].trim();
            if (exportedName) exports.add(exportedName);
        }
    }

    exportCache.set(filePath, exports);
    return exports;
}

for (const file of allFiles) {
    const content = readFileSync(file, 'utf8');
    let m;
    namedImportRegex.lastIndex = 0;
    while ((m = namedImportRegex.exec(content)) !== null) {
        const names = m[1];
        const importPath = m[2];
        const resolved = resolve(dirname(file), importPath);

        // Only check project-internal imports
        if (!resolved.startsWith(ROOT)) continue;
        if (!existsSync(resolved)) continue; // already caught by check 1

        const exports = getExportsForFile(resolved);
        if (!exports) continue;

        // Strip // comments from the names block before splitting
        const cleanedNames = names.replace(/\/\/[^\n]*/g, '');
        for (const raw of cleanedNames.split(',')) {
            const name = raw.trim().split(/\s+as\s+/)[0].trim();
            if (!name) continue;
            if (!exports.has(name)) {
                const rel = relative(ROOT, file).replace(/\\/g, '/');
                const target = relative(ROOT, resolved).replace(/\\/g, '/');
                console.log(`MISSING-EXPORT: ${rel} imports { ${name} } from ${target}, but it's not exported`);
                exportErrors++;
            }
        }
    }
}

if (exportErrors > 0) {
    console.log(`\nMissing named exports: ${exportErrors}`);
} else {
    console.log(`Named exports: all verified`);
}

// ── Summary ──────────────────────────────────────────────────────────────

const totalErrors = broken + depthErrors + exportErrors;
if (totalErrors > 0) {
    console.log(`\n✗ ${totalErrors} error(s) found`);
    process.exit(1);
} else {
    console.log('\nAll project-internal imports resolve correctly.');
}
