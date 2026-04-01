const fs = require("fs");
const path = require("path");

/**
 * In-memory vector store with file persistence.
 *
 * Design priorities:
 * 1. SPEED — everything in RAM, cosine similarity is just dot products
 * 2. Persistence — saved to .wolverine/brain/vectors.bin for restart survival
 * 3. No dependencies — pure JS, no external vector DB needed
 *
 * Storage: each entry is { id, namespace, text, metadata, embedding: Float32Array }
 * Namespaces partition the store: "docs", "errors", "fixes", "functions", "learnings"
 */

const BRAIN_DIR = ".wolverine/brain";
const STORE_FILE = "vectors.json";

class VectorStore {
  constructor(projectRoot) {
    this.projectRoot = path.resolve(projectRoot);
    this.brainDir = path.join(this.projectRoot, BRAIN_DIR);
    this.storePath = path.join(this.brainDir, STORE_FILE);

    // In-memory entries: Map<id, Entry>
    this._entries = new Map();
    // Namespace index for fast filtered search: Map<namespace, Set<id>>
    this._nsIndex = new Map();
    // Auto-increment ID
    this._nextId = 1;

    this._ensureDir();
    this._load();
  }

  /**
   * Add an entry to the store. Returns the entry ID.
   *
   * @param {string} namespace - Category: "docs", "errors", "fixes", "functions", "learnings"
   * @param {string} text - The compacted text (what gets searched against)
   * @param {number[]} embedding - Float array from the embedding model
   * @param {object} metadata - Arbitrary metadata (timestamps, file paths, etc.)
   */
  add(namespace, text, embedding, metadata = {}) {
    const id = `${namespace}-${(this._nextId++).toString(36)}`;
    const entry = {
      id,
      namespace,
      text,
      metadata: { ...metadata, createdAt: Date.now() },
      embedding: new Float32Array(embedding),
    };

    this._entries.set(id, entry);

    if (!this._nsIndex.has(namespace)) {
      this._nsIndex.set(namespace, new Set());
    }
    this._nsIndex.get(namespace).add(id);

    return id;
  }

  /**
   * Semantic search — find the top-k most similar entries.
   *
   * @param {number[]} queryEmbedding - Embedding of the search query
   * @param {object} options
   * @param {number} options.topK - Max results (default: 5)
   * @param {string} options.namespace - Filter to a specific namespace
   * @param {number} options.minScore - Minimum similarity score (default: 0.3)
   * @returns {Array<{ id, namespace, text, metadata, score }>}
   */
  search(queryEmbedding, { topK = 5, namespace, minScore = 0.3 } = {}) {
    const queryVec = new Float32Array(queryEmbedding);
    const results = [];

    // Determine which entries to search
    let entryIds;
    if (namespace && this._nsIndex.has(namespace)) {
      entryIds = this._nsIndex.get(namespace);
    } else if (namespace) {
      return []; // namespace doesn't exist
    } else {
      entryIds = this._entries.keys();
    }

    for (const id of entryIds) {
      const entry = this._entries.get(id);
      if (!entry) continue;

      const score = cosineSimilarity(queryVec, entry.embedding);
      if (score >= minScore) {
        results.push({
          id: entry.id,
          namespace: entry.namespace,
          text: entry.text,
          metadata: entry.metadata,
          score,
        });
      }
    }

    // Sort by score descending, take topK
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Fast keyword search — no embedding API call, instant.
   * Tokenizes query and scores entries by keyword overlap.
   * Use as first-pass before expensive semantic search.
   */
  keywordSearch(query, { topK = 5, namespace, minTokens = 2 } = {}) {
    const tokens = query.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(t => t.length > 2);

    if (tokens.length === 0) return [];

    const results = [];
    let entryIds;
    if (namespace && this._nsIndex.has(namespace)) {
      entryIds = this._nsIndex.get(namespace);
    } else {
      entryIds = this._entries.keys();
    }

    for (const id of entryIds) {
      const entry = this._entries.get(id);
      if (!entry) continue;

      const textLower = entry.text.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (textLower.includes(token)) score++;
      }

      if (score >= minTokens) {
        results.push({
          id: entry.id,
          namespace: entry.namespace,
          text: entry.text,
          metadata: entry.metadata,
          score: score / tokens.length, // normalize 0-1
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Get all entries in a namespace.
   */
  getNamespace(namespace) {
    const ids = this._nsIndex.get(namespace);
    if (!ids) return [];
    return Array.from(ids).map(id => {
      const e = this._entries.get(id);
      return { id: e.id, namespace: e.namespace, text: e.text, metadata: e.metadata };
    });
  }

  /**
   * Delete an entry by ID.
   */
  delete(id) {
    const entry = this._entries.get(id);
    if (!entry) return false;
    this._entries.delete(id);
    const nsSet = this._nsIndex.get(entry.namespace);
    if (nsSet) nsSet.delete(id);
    return true;
  }

  /**
   * Get store stats.
   */
  getStats() {
    const nsCounts = {};
    for (const [ns, ids] of this._nsIndex) {
      nsCounts[ns] = ids.size;
    }
    return { totalEntries: this._entries.size, namespaces: nsCounts };
  }

  /**
   * Persist to disk. Call periodically or after batch operations.
   */
  save() {
    const data = {
      version: 1,
      nextId: this._nextId,
      entries: [],
    };

    for (const entry of this._entries.values()) {
      data.entries.push({
        id: entry.id,
        namespace: entry.namespace,
        text: entry.text,
        metadata: entry.metadata,
        embedding: Array.from(entry.embedding),
      });
    }

    // Atomic write: write to temp file, then rename (prevents corruption on kill)
    const tmpPath = this.storePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data), "utf-8");
    fs.renameSync(tmpPath, this.storePath);
  }

  // -- Private --

  _ensureDir() {
    fs.mkdirSync(this.brainDir, { recursive: true });
  }

  _load() {
    if (!fs.existsSync(this.storePath)) return;

    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, "utf-8"));
      this._nextId = data.nextId || 1;

      for (const entry of data.entries) {
        const stored = {
          id: entry.id,
          namespace: entry.namespace,
          text: entry.text,
          metadata: entry.metadata,
          embedding: new Float32Array(entry.embedding),
        };
        this._entries.set(stored.id, stored);

        if (!this._nsIndex.has(stored.namespace)) {
          this._nsIndex.set(stored.namespace, new Set());
        }
        this._nsIndex.get(stored.namespace).add(stored.id);
      }
    } catch {
      // Corrupt store — start fresh
      this._entries.clear();
      this._nsIndex.clear();
    }
  }
}

/**
 * Cosine similarity between two Float32Arrays.
 * Returns value between -1 and 1 (higher = more similar).
 */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

module.exports = { VectorStore, cosineSimilarity };
