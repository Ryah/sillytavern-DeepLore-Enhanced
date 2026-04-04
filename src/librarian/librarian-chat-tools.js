/**
 * DeepLore Enhanced — Librarian Chat Tools
 * Read-only tools the Librarian AI can call during conversation to query the vault.
 * These are NOT registered with SillyTavern's ToolManager — they execute locally
 * within the Librarian's conversation loop only.
 */
import { vaultIndex, fuzzySearchIndex } from '../state.js';
import { queryBM25 } from '../vault/bm25.js';

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const TOOL_RESULT_MAX_CHARS = 2000;

// ════════════════════════════════════════════════════════════════════════════
// Tool Definitions
// ════════════════════════════════════════════════════════════════════════════

const LIBRARIAN_TOOLS = [
    {
        name: 'search_vault',
        description: 'BM25 fuzzy search across the vault. Returns titles, keys, and content snippets.',
        parameters: {
            query: { type: 'string', required: true, description: 'Search query text' },
            top_k: { type: 'number', required: false, description: 'Max results (default 10, max 20)' },
        },
    },
    {
        name: 'get_entry',
        description: 'Get full content and frontmatter of a vault entry by title. Use when you need to read an existing entry.',
        parameters: {
            title: { type: 'string', required: true, description: 'Entry title (case-insensitive)' },
        },
    },
    {
        name: 'get_links',
        description: 'Get all outgoing [[wikilinks]] from an entry — what this entry references.',
        parameters: {
            title: { type: 'string', required: true, description: 'Entry title' },
        },
    },
    {
        name: 'get_backlinks',
        description: 'Find all entries that link TO a given title — what references this entry.',
        parameters: {
            title: { type: 'string', required: true, description: 'Target title to find backlinks for' },
        },
    },
    {
        name: 'list_entries',
        description: 'List vault entries filtered by type and/or tag. Returns titles, types, and priorities.',
        parameters: {
            type: { type: 'string', required: false, description: 'Filter by type: character, location, lore, organization, story' },
            tag: { type: 'string', required: false, description: 'Filter by tag (substring match)' },
        },
    },
];

// ════════════════════════════════════════════════════════════════════════════
// Tool Executor
// ════════════════════════════════════════════════════════════════════════════

/**
 * Find an entry by title (case-insensitive).
 * @param {string} title
 * @returns {object|null}
 */
function findEntry(title) {
    if (!title) return null;
    const lower = title.toLowerCase();
    return vaultIndex.find(e => e.title.toLowerCase() === lower) || null;
}

/**
 * Truncate text to a maximum length, preserving word boundaries.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max = TOOL_RESULT_MAX_CHARS) {
    if (!text || text.length <= max) return text || '';
    const cut = text.lastIndexOf(' ', max);
    return text.slice(0, cut > 0 ? cut : max) + '...';
}

/**
 * Execute a tool call and return the result string.
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @returns {string} Result text
 */
export function executeToolCall(name, args = {}) {
    switch (name) {
        case 'search_vault': return toolSearchVault(args);
        case 'get_entry': return toolGetEntry(args);
        case 'get_links': return toolGetLinks(args);
        case 'get_backlinks': return toolGetBacklinks(args);
        case 'list_entries': return toolListEntries(args);
        default: return `Unknown tool: "${name}". Available tools: ${LIBRARIAN_TOOLS.map(t => t.name).join(', ')}`;
    }
}

// ── Individual tool implementations ──────────────────────────────────────

function toolSearchVault(args) {
    const query = args.query?.trim();
    if (!query) return 'Error: query is required.';
    if (!fuzzySearchIndex) return 'Error: vault index not built yet.';

    const topK = Math.min(Math.max(Number(args.top_k) || 10, 1), 20);
    const hits = queryBM25(fuzzySearchIndex, query, topK, 0.3);

    if (hits.length === 0) return `No results found for "${query}".`;

    const lines = hits.map((h, i) => {
        const e = h.entry;
        const snippet = truncate(e.summary || e.content || '', 200);
        return `${i + 1}. **${e.title}** (${e.type || '?'}, p${e.priority || 50}, score ${h.score.toFixed(2)})\n   Keys: ${(e.keys || []).join(', ')}\n   ${snippet}`;
    });
    return truncate(lines.join('\n\n'), TOOL_RESULT_MAX_CHARS);
}

function toolGetEntry(args) {
    const title = args.title?.trim();
    if (!title) return 'Error: title is required.';

    const entry = findEntry(title);
    if (!entry) {
        // Suggest close matches
        if (fuzzySearchIndex) {
            const hits = queryBM25(fuzzySearchIndex, title, 5, 0.3);
            if (hits.length > 0) {
                return `Entry "${title}" not found. Did you mean: ${hits.map(h => h.title).join(', ')}?`;
            }
        }
        return `Entry "${title}" not found.`;
    }

    const meta = [
        `**Title:** ${entry.title}`,
        `**Type:** ${entry.type || 'unknown'}`,
        `**Priority:** ${entry.priority || 50}`,
        `**Tags:** ${(entry.tags || []).join(', ')}`,
        `**Keys:** ${(entry.keys || []).join(', ')}`,
        entry.summary ? `**Summary:** ${entry.summary}` : null,
        `**Links out:** ${(entry.resolvedLinks || []).join(', ') || 'none'}`,
    ].filter(Boolean).join('\n');

    const content = truncate(entry.content || '(no content)', TOOL_RESULT_MAX_CHARS - meta.length - 20);
    return `${meta}\n\n---\n${content}`;
}

function toolGetLinks(args) {
    const title = args.title?.trim();
    if (!title) return 'Error: title is required.';

    const entry = findEntry(title);
    if (!entry) return `Entry "${title}" not found.`;

    const links = entry.resolvedLinks || [];
    if (links.length === 0) return `"${entry.title}" has no outgoing links.`;

    const lines = links.map(linkTitle => {
        const target = findEntry(linkTitle);
        return target
            ? `- [[${linkTitle}]] (${target.type || '?'}, p${target.priority || 50})`
            : `- [[${linkTitle}]] (not in vault)`;
    });
    return `**${entry.title}** links to ${links.length} entries:\n${lines.join('\n')}`;
}

function toolGetBacklinks(args) {
    const title = args.title?.trim();
    if (!title) return 'Error: title is required.';

    const lower = title.toLowerCase();
    const backlinks = vaultIndex.filter(e =>
        (e.resolvedLinks || []).some(l => l.toLowerCase() === lower)
    );

    if (backlinks.length === 0) return `No entries link to "${title}".`;

    const lines = backlinks
        .sort((a, b) => (a.priority || 50) - (b.priority || 50))
        .map(e => `- **${e.title}** (${e.type || '?'}, p${e.priority || 50})`);
    return truncate(`${backlinks.length} entries link to "${title}":\n${lines.join('\n')}`, TOOL_RESULT_MAX_CHARS);
}

function toolListEntries(args) {
    const typeFilter = args.type?.trim()?.toLowerCase();
    const tagFilter = args.tag?.trim()?.toLowerCase();

    if (!typeFilter && !tagFilter) return 'Error: at least one of type or tag is required.';

    let entries = vaultIndex;
    if (typeFilter) entries = entries.filter(e => (e.type || '').toLowerCase() === typeFilter);
    if (tagFilter) entries = entries.filter(e => (e.tags || []).some(t => t.toLowerCase().includes(tagFilter)));

    if (entries.length === 0) {
        const filter = [typeFilter && `type="${typeFilter}"`, tagFilter && `tag="${tagFilter}"`].filter(Boolean).join(', ');
        return `No entries match ${filter}.`;
    }

    const capped = entries
        .sort((a, b) => (a.priority || 50) - (b.priority || 50))
        .slice(0, 50);

    const lines = capped.map(e => `- **${e.title}** (p${e.priority || 50}) — ${(e.keys || []).slice(0, 3).join(', ')}`);
    const header = `${entries.length} entries${entries.length > 50 ? ' (showing first 50)' : ''}:`;
    return truncate(`${header}\n${lines.join('\n')}`, TOOL_RESULT_MAX_CHARS);
}

// ════════════════════════════════════════════════════════════════════════════
// System Prompt Section
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the tools documentation for the system prompt.
 * @returns {string}
 */
export function buildToolsPromptSection() {
    const toolDocs = LIBRARIAN_TOOLS.map(t => {
        const params = Object.entries(t.parameters)
            .map(([k, v]) => `${k}${v.required ? '' : '?'}: ${v.description}`)
            .join(', ');
        return `- **${t.name}**(${params}): ${t.description}`;
    }).join('\n');

    return `
## Available Tools
You can query the vault during our conversation using tools. To use tools, respond with:
\`\`\`json
{
  "message": "Let me look that up...",
  "tool_calls": [{"name": "tool_name", "args": {"param": "value"}}],
  "action": "tool_call"
}
\`\`\`

You will receive tool results, then respond with your final answer. Max 5 tool calls per turn.
You may call multiple tools in a single response.

### Tools:
${toolDocs}

### Rules:
- Tools are **read-only** — you cannot write to the vault.
- Use tools when the manifest lacks detail or you need to see an entry's full content.
- After receiving tool results, respond with your final answer (action: "update_draft", "propose_options", or null).
- Don't use tools for entries already visible in the manifest summary.
`;
}
