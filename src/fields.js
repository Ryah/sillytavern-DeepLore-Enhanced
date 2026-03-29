/**
 * DeepLore Enhanced — Custom Field Definitions
 * Parsing, validation, defaults, and YAML serialization for user-defined frontmatter fields.
 * Pure functions — no SillyTavern imports, testable in Node.js.
 */

// ============================================================================
// Constants
// ============================================================================

/** Reserved frontmatter field names that cannot be used as custom fields */
export const RESERVED_FIELD_NAMES = new Set([
    'keys', 'priority', 'tags', 'requires', 'excludes', 'position', 'depth',
    'role', 'scandepth', 'excluderecursion', 'refine_keys', 'cascade_links',
    'cooldown', 'warmup', 'probability', 'summary', 'graph', 'enabled',
    'constant', 'seed', 'bootstrap', 'type', 'fileclass', 'status', 'aliases',
]);

/** Valid field types */
const VALID_TYPES = new Set(['string', 'number', 'boolean']);

/** Valid gating operators */
export const VALID_OPERATORS = new Set([
    'match_any', 'match_all', 'not_any', 'exists', 'not_exists', 'gt', 'lt', 'eq',
]);

/** Valid gating tolerance levels */
const VALID_TOLERANCES = new Set(['strict', 'moderate', 'lenient']);

// ============================================================================
// Default Field Definitions (built-in 4)
// ============================================================================

/** @type {FieldDefinition[]} */
export const DEFAULT_FIELD_DEFINITIONS = [
    {
        name: 'era',
        label: 'Era',
        type: 'string',
        multi: true,
        gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
        values: [],
        contextKey: 'era',
    },
    {
        name: 'location',
        label: 'Location',
        type: 'string',
        multi: true,
        gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
        values: [],
        contextKey: 'location',
    },
    {
        name: 'scene_type',
        label: 'Scene Type',
        type: 'string',
        multi: true,
        gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
        values: [],
        contextKey: 'scene_type',
    },
    {
        name: 'character_present',
        label: 'Characters Present',
        type: 'string',
        multi: true,
        gating: { enabled: true, operator: 'match_any', tolerance: 'moderate' },
        values: [],
        contextKey: 'characters_present',
    },
];

// ============================================================================
// Type Definition
// ============================================================================

/**
 * @typedef {object} FieldDefinition
 * @property {string} name - Frontmatter field name (snake_case, must not collide with reserved names)
 * @property {string} label - Human-readable label for UI display
 * @property {'string'|'number'|'boolean'} type - Data type
 * @property {boolean} multi - Whether this field holds an array of values
 * @property {{ enabled: boolean, operator: string, tolerance: string }} gating - Gating configuration
 * @property {string[]} values - Optional allowed values (empty = freeform)
 * @property {string} contextKey - Key in chat_metadata.deeplore_context
 */

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a field name against reserved names.
 * @param {string} name
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateFieldName(name) {
    if (!name || typeof name !== 'string') {
        return { valid: false, reason: 'Field name is required' };
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        return { valid: false, reason: 'Field name is required' };
    }
    if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) {
        return { valid: false, reason: 'Field name must be lowercase alphanumeric with underscores, starting with a letter' };
    }
    if (RESERVED_FIELD_NAMES.has(trimmed.toLowerCase())) {
        return { valid: false, reason: `"${trimmed}" is a reserved field name` };
    }
    return { valid: true };
}

/**
 * Validate a single field definition object.
 * Returns a normalized copy or null if invalid.
 * @param {object} raw - Raw field definition (from YAML or UI)
 * @returns {{ field: FieldDefinition|null, errors: string[] }}
 */
export function validateFieldDefinition(raw) {
    const errors = [];

    if (!raw || typeof raw !== 'object') {
        return { field: null, errors: ['Field definition must be an object'] };
    }

    // Name
    const nameResult = validateFieldName(raw.name);
    if (!nameResult.valid) {
        errors.push(nameResult.reason);
    }

    // Label
    const label = (typeof raw.label === 'string' && raw.label.trim()) ? raw.label.trim() : (raw.name || '');

    // Type
    const type = VALID_TYPES.has(raw.type) ? raw.type : 'string';
    if (raw.type && !VALID_TYPES.has(raw.type)) {
        errors.push(`Unknown type "${raw.type}", defaulting to "string"`);
    }

    // Multi
    const multi = raw.multi === true;

    // Gating
    const rawGating = raw.gating || {};
    const gating = {
        enabled: rawGating.enabled !== false,
        operator: VALID_OPERATORS.has(rawGating.operator) ? rawGating.operator : 'match_any',
        tolerance: VALID_TOLERANCES.has(rawGating.tolerance) ? rawGating.tolerance : 'moderate',
    };

    // Values
    const values = Array.isArray(raw.values) ? raw.values.map(v => String(v).trim()).filter(Boolean) : [];

    // Context key
    const contextKey = (typeof raw.contextKey === 'string' && raw.contextKey.trim()) ? raw.contextKey.trim() : (raw.name || '');

    if (errors.length > 0 && !nameResult.valid) {
        return { field: null, errors };
    }

    return {
        field: { name: raw.name.trim(), label, type, multi, gating, values, contextKey },
        errors,
    };
}

// ============================================================================
// YAML Parsing
// ============================================================================

/**
 * Parse a YAML field definitions string into an array of FieldDefinition objects.
 * Uses a simple line-based parser (no external YAML library needed).
 * Expects the format produced by serializeFieldDefinitions().
 *
 * @param {string} yamlText - Raw YAML text
 * @returns {{ definitions: FieldDefinition[], errors: string[] }}
 */
export function parseFieldDefinitionYaml(yamlText) {
    if (!yamlText || typeof yamlText !== 'string') {
        return { definitions: [], errors: [] };
    }

    const trimmed = yamlText.trim();
    if (trimmed.length === 0) {
        return { definitions: [], errors: [] };
    }

    const errors = [];
    const definitions = [];

    // Split into lines and parse the YAML structure
    const lines = trimmed.split('\n');
    let currentField = null;
    let inGating = false;
    let inValues = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const stripped = line.trimEnd();

        // Skip comments and the top-level "fields:" key
        if (stripped.startsWith('#') || stripped === '' || stripped === 'fields:') continue;

        // New field entry: "  - name: ..."
        if (/^\s{2}-\s+name:\s*(.+)/.test(stripped)) {
            // Save previous field
            if (currentField) {
                const { field, errors: fieldErrors } = validateFieldDefinition(currentField);
                if (field) definitions.push(field);
                errors.push(...fieldErrors);
            }
            currentField = { name: stripped.match(/name:\s*(.+)/)[1].trim(), gating: {} };
            inGating = false;
            inValues = false;
            continue;
        }

        if (!currentField) continue;

        // Gating block
        if (/^\s{4}gating:/.test(stripped)) {
            inGating = true;
            inValues = false;
            continue;
        }

        // Values block
        if (/^\s{4}values:/.test(stripped)) {
            inValues = true;
            inGating = false;
            // Check for inline empty array
            if (/values:\s*\[\s*\]/.test(stripped)) {
                currentField.values = [];
                inValues = false;
            }
            continue;
        }

        // Inside gating block
        if (inGating && /^\s{6}\w/.test(stripped)) {
            const match = stripped.match(/^\s{6}(\w+):\s*(.+)/);
            if (match) {
                const [, key, val] = match;
                const parsed = parseYamlValue(val.trim());
                if (!currentField.gating) currentField.gating = {};
                currentField.gating[key] = parsed;
            }
            continue;
        }

        // Inside values array
        if (inValues && /^\s{6}-\s/.test(stripped)) {
            if (!currentField.values) currentField.values = [];
            const valMatch = stripped.match(/^\s{6}-\s+(.+)/);
            if (valMatch) currentField.values.push(valMatch[1].trim());
            continue;
        }

        // Top-level field properties (indented by 4) — reset sub-block flags
        if (/^\s{4}\w/.test(stripped)) {
            inGating = false;
            inValues = false;
            const match = stripped.match(/^\s{4}(\w+):\s*(.+)/);
            if (match) {
                const [, key, val] = match;
                currentField[key] = parseYamlValue(val.trim());
            }
        }
    }

    // Don't forget the last field
    if (currentField) {
        const { field, errors: fieldErrors } = validateFieldDefinition(currentField);
        if (field) definitions.push(field);
        errors.push(...fieldErrors);
    }

    return { definitions, errors };
}

/**
 * Parse a simple YAML scalar value.
 * @param {string} val
 * @returns {string|number|boolean}
 */
function parseYamlValue(val) {
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        return val.slice(1, -1);
    }
    // Inline empty array
    if (val === '[]') return [];
    return val;
}

// ============================================================================
// YAML Serialization
// ============================================================================

/**
 * Serialize an array of FieldDefinition objects to YAML string.
 * @param {FieldDefinition[]} definitions
 * @returns {string}
 */
export function serializeFieldDefinitions(definitions) {
    if (!Array.isArray(definitions) || definitions.length === 0) {
        return 'fields: []\n';
    }

    const lines = ['fields:'];
    for (const def of definitions) {
        lines.push(`  - name: ${def.name}`);
        lines.push(`    label: ${def.label}`);
        lines.push(`    type: ${def.type}`);
        lines.push(`    multi: ${def.multi}`);
        lines.push('    gating:');
        lines.push(`      enabled: ${def.gating.enabled}`);
        lines.push(`      operator: ${def.gating.operator}`);
        lines.push(`      tolerance: ${def.gating.tolerance}`);
        if (def.values && def.values.length > 0) {
            lines.push('    values:');
            for (const v of def.values) {
                lines.push(`      - ${v}`);
            }
        } else {
            lines.push('    values: []');
        }
        lines.push(`    contextKey: ${def.contextKey}`);
    }

    return lines.join('\n') + '\n';
}

// ============================================================================
// Operator Evaluation (used by gating engine)
// ============================================================================

/**
 * Evaluate a gating operator against entry and active context values.
 * @param {string} operator - One of VALID_OPERATORS
 * @param {*} entryValue - Value from entry.customFields[fieldName]
 * @param {*} activeValue - Value from chat_metadata.deeplore_context[contextKey]
 * @returns {boolean}
 */
export function evaluateOperator(operator, entryValue, activeValue) {
    const entryArr = Array.isArray(entryValue) ? entryValue : [entryValue];
    const activeArr = Array.isArray(activeValue) ? activeValue : [activeValue];

    switch (operator) {
        case 'match_any':
            return entryArr.some(v => activeArr.some(a => String(v).toLowerCase() === String(a).toLowerCase()));
        case 'match_all':
            return activeArr.every(a => entryArr.some(v => String(v).toLowerCase() === String(a).toLowerCase()));
        case 'not_any':
            return !entryArr.some(v => activeArr.some(a => String(v).toLowerCase() === String(a).toLowerCase()));
        case 'exists':
            return entryValue != null && (!Array.isArray(entryValue) || entryValue.length > 0);
        case 'not_exists':
            return entryValue == null || (Array.isArray(entryValue) && entryValue.length === 0);
        case 'eq':
            return String(entryValue).toLowerCase() === String(activeValue).toLowerCase();
        case 'gt': {
            const a = Number(entryValue), b = Number(activeValue);
            return !Number.isNaN(a) && !Number.isNaN(b) && a > b; // BUG-L2: NaN guard
        }
        case 'lt': {
            const a = Number(entryValue), b = Number(activeValue);
            return !Number.isNaN(a) && !Number.isNaN(b) && a < b; // BUG-L2: NaN guard
        }
        default:
            return true;
    }
}

// ============================================================================
// Entry Custom Fields Extraction
// ============================================================================

/**
 * Extract custom field values from parsed frontmatter, guided by field definitions.
 * @param {object} frontmatter - Parsed frontmatter object
 * @param {FieldDefinition[]} fieldDefinitions - Active field definitions
 * @returns {Object<string, *>} customFields object
 */
export function extractCustomFields(frontmatter, fieldDefinitions) {
    const customFields = {};
    if (!frontmatter || !fieldDefinitions) return customFields;

    const toStringArray = (v) => {
        if (Array.isArray(v)) return v.map(s => String(s).trim().toLowerCase()).filter(Boolean);
        if (typeof v === 'string' && v.trim()) return [v.trim().toLowerCase()];
        if (typeof v === 'number' || typeof v === 'boolean') return [String(v).toLowerCase()];
        return [];
    };

    for (const field of fieldDefinitions) {
        const raw = frontmatter[field.name];
        if (raw === undefined) continue;

        if (field.type === 'string') {
            customFields[field.name] = field.multi ? toStringArray(raw) : (typeof raw === 'string' ? raw.trim().toLowerCase() : String(raw).toLowerCase());
        } else if (field.type === 'number') {
            customFields[field.name] = typeof raw === 'number' ? raw : Number(raw);
        } else if (field.type === 'boolean') {
            customFields[field.name] = raw === true || raw === 'true';
        }
    }

    return customFields;
}

// ============================================================================
// Duplicate Detection
// ============================================================================

/**
 * Check for duplicate field names in a definitions array.
 * @param {FieldDefinition[]} definitions
 * @returns {string[]} Array of duplicate names (empty if none)
 */
export function findDuplicateFieldNames(definitions) {
    const seen = new Set();
    const dupes = [];
    for (const def of definitions) {
        const lower = def.name.toLowerCase();
        if (seen.has(lower)) dupes.push(def.name);
        else seen.add(lower);
    }
    return dupes;
}
