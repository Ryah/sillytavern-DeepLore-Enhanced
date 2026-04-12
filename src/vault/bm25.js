/**
 * DeepLore Enhanced — BM25 Fuzzy Search Index
 * Extracted from vault.js for testability (pure functions, no ST globals).
 */

/**
 * BUG-369: BM25 docId must be unique WITHIN a single vault. trackerKey
 * (`vaultSource:title`) collides when two entries in the same vault share a title,
 * silently dropping one from the search index. Filename is unique within a vault
 * (verified by reuse-sync code keying existing entries by `vault.name\0filename`),
 * so `vaultSource\0filename` is a correct composite docId.
 */
function bm25DocId(entry) {
    return `${entry.vaultSource || ''}\0${entry.filename || entry.title}`;
}

const BM25_K1 = 1.5;   // Term frequency saturation
const BM25_B = 0.75;    // Length normalization
const TOKENIZE_SPLIT_RE = /[^\p{L}\p{N}]+/u;

/** Simple tokenizer: lowercase, split on non-word characters, remove short tokens.
 *  Uses Unicode-aware regex to support non-Latin scripts (Cyrillic, Arabic, etc.).
 *  Note: CJK text without spaces will produce long unsplit tokens — a proper CJK
 *  tokenizer would need n-gram splitting, which is out of scope. */
export function tokenize(text) {
    return text.toLowerCase().split(TOKENIZE_SPLIT_RE).filter(t => t.length >= 2);
}

/**
 * Build a BM25 index from vault entries.
 * Each "document" is the concatenation of entry title, keys, and content.
 * @param {Array} entries - VaultEntry array
 * @returns {{ idf: Map<string, number>, docs: Map<string, {tf: Map<string, number>, len: number, entry: object}>, avgDl: number }}
 */
export function buildBM25Index(entries) {
    const N = entries.length;
    if (N === 0) return { idf: new Map(), docs: new Map(), avgDl: 0 };

    // Document frequency: how many docs contain each term
    const df = new Map();
    const docs = new Map();
    let totalLen = 0;

    for (const entry of entries) {
        const text = `${entry.title} ${entry.keys.join(' ')} ${entry.content}`;
        const tokens = tokenize(text);
        const tf = new Map();
        for (const token of tokens) {
            tf.set(token, (tf.get(token) || 0) + 1);
        }
        // BUG-013 + BUG-369: Use (vaultSource, filename) composite for docId.
        // trackerKey (vaultSource:title) collides for same-titled entries within one vault.
        docs.set(bm25DocId(entry), { tf, len: tokens.length, entry });
        totalLen += tokens.length;

        // Count unique terms per document for DF
        for (const term of tf.keys()) {
            df.set(term, (df.get(term) || 0) + 1);
        }
    }

    // Compute IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = new Map();
    for (const [term, freq] of df) {
        idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
    }

    // H-12: Build inverted posting list so queryBM25 only iterates matching docs
    const invertedIndex = new Map();
    for (const [docId, doc] of docs) {
        for (const term of doc.tf.keys()) {
            if (!invertedIndex.has(term)) invertedIndex.set(term, new Set());
            invertedIndex.get(term).add(docId);
        }
    }

    return { idf, docs, avgDl: totalLen / N, invertedIndex };
}

/**
 * Query the BM25 index with a text string. Returns scored entry titles.
 * @param {{ idf: Map, docs: Map, avgDl: number }} index
 * @param {string} queryText
 * @param {number} [topK=20] - Max results
 * @param {number} [minScore=0.5] - Minimum BM25 score threshold
 * @returns {Array<{title: string, score: number, entry: object}>}
 */
export function queryBM25(index, queryText, topK = 20, minScore = 0.5) {
    if (!index || index.docs.size === 0) return [];

    const queryTokens = tokenize(queryText);
    if (queryTokens.length === 0) return [];

    // BUG-042: Deduplicate query tokens (frequency was allocated but never used in scoring)
    const queryTerms = new Set(queryTokens);

    const k1 = BM25_K1;
    const b = BM25_B;
    const scores = [];

    // H-12: Use inverted index to only score docs containing at least one query term
    const candidateDocIds = new Set();
    if (index.invertedIndex) {
        for (const term of queryTerms) {
            const posting = index.invertedIndex.get(term);
            if (posting) {
                for (const docId of posting) candidateDocIds.add(docId);
            }
        }
    }
    const docsToScore = index.invertedIndex
        ? [...candidateDocIds].map(id => index.docs.get(id)).filter(Boolean)
        : [...index.docs.values()]; // fallback for indexes built before H-12

    for (const doc of docsToScore) {
        let score = 0;
        for (const term of queryTerms) {
            const termIdf = index.idf.get(term);
            if (!termIdf) continue;
            const tf = doc.tf.get(term) || 0;
            if (tf === 0) continue;
            // BM25 scoring formula
            const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.len / index.avgDl));
            score += termIdf * tfNorm;
        }
        if (score >= minScore) {
            // BUG-013: Return entry.title (not map key which is trackerKey)
            scores.push({ title: doc.entry.title, score, entry: doc.entry });
        }
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
}
