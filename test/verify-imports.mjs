/**
 * Import path verification script.
 * Scans all .js/.mjs files, extracts relative imports, verifies each resolves to a real file.
 * Run with: node test/verify-imports.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
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
let broken = 0;
let total = 0;
let stImports = 0;

for (const file of allFiles) {
    const content = readFileSync(file, 'utf8');
    let m;
    importRegex.lastIndex = 0;
    while ((m = importRegex.exec(content)) !== null) {
        const importPath = m[1];
        const resolved = resolve(dirname(file), importPath);
        total++;

        // Skip SillyTavern imports (resolve outside project root)
        if (!resolved.startsWith(ROOT)) {
            stImports++;
            continue;
        }

        // Skip string literals in test descriptions (not real imports)
        if (file.endsWith('.mjs') && m[0].includes("'...")) continue;

        if (!existsSync(resolved)) {
            const rel = relative(ROOT, file).replace(/\\/g, '/');
            const target = relative(ROOT, resolved).replace(/\\/g, '/');
            console.log(`BROKEN: ${rel} -> ${importPath}  (resolves to ${target})`);
            broken++;
        }
    }
}

console.log('---');
console.log(`Total relative imports checked: ${total}`);
console.log(`SillyTavern imports (skipped, not in repo): ${stImports}`);
console.log(`Project imports verified: ${total - stImports}`);
console.log(`Broken: ${broken}`);
if (broken > 0) process.exit(1);
else console.log('All project-internal imports resolve correctly.');
