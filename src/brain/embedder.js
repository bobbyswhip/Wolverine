const { getClient, aiCall, detectProvider, _trackEmbedding } = require("../core/ai-client");
const { getEmbeddingModel } = require("../core/models");

/**
 * Embedder — converts text to vector embeddings using TEXT_EMBEDDING_MODEL.
 *
 * Optimized for speed:
 * - Batch embedding support (multiple texts in one API call)
 * - LRU cache for repeated queries
 * - Dimensionality matches text-embedding-3-small (1536) by default
 */

// Simple LRU cache for embedding results
const CACHE_SIZE = 500;
const _cache = new Map();

function _cacheGet(key) {
  if (_cache.has(key)) {
    const val = _cache.get(key);
    // Move to end (most recently used)
    _cache.delete(key);
    _cache.set(key, val);
    return val;
  }
  return null;
}

function _cacheSet(key, val) {
  if (_cache.size >= CACHE_SIZE) {
    // Evict oldest (first entry)
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
  _cache.set(key, val);
}

/**
 * Embed a single text string. Returns number[].
 */
async function embed(text) {
  const cached = _cacheGet(text);
  if (cached) return cached;

  const model = getEmbeddingModel();
  const provider = detectProvider(model);
  const client = provider === "wolverine" ? getClient("wolverine") : getClient("openai");

  const startMs = Date.now();
  let response;
  try {
    response = await client.embeddings.create({ model, input: text });
  } catch (err) {
    // If wolverine proxy is down (startup, crash loop), fall back to OpenAI direct
    if (provider === "wolverine" && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message || "")) {
      const directClient = getClient("openai");
      response = await directClient.embeddings.create({ model: "text-embedding-3-small", input: text });
    } else {
      throw err;
    }
  }

  const embedding = response.data[0].embedding;
  _trackEmbedding(model, response.usage, Date.now() - startMs, true);
  _cacheSet(text, embedding);
  return embedding;
}

/**
 * Embed multiple texts in a single API call. Returns number[][].
 * Much faster than calling embed() in a loop.
 */
async function embedBatch(texts) {
  if (texts.length === 0) return [];

  // Check cache for all
  const results = new Array(texts.length);
  const uncached = [];
  const uncachedIndices = [];

  for (let i = 0; i < texts.length; i++) {
    const cached = _cacheGet(texts[i]);
    if (cached) {
      results[i] = cached;
    } else {
      uncached.push(texts[i]);
      uncachedIndices.push(i);
    }
  }

  if (uncached.length === 0) return results;

  const model = getEmbeddingModel();
  const provider = detectProvider(model);
  const client = provider === "wolverine" ? getClient("wolverine") : getClient("openai");

  const startMs = Date.now();
  let response;
  try {
    response = await client.embeddings.create({ model, input: uncached });
  } catch (err) {
    if (provider === "wolverine" && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message || "")) {
      const directClient = getClient("openai");
      response = await directClient.embeddings.create({ model: "text-embedding-3-small", input: uncached });
    } else {
      throw err;
    }
  }
  _trackEmbedding(model, response.usage, Date.now() - startMs, true);

  // Sort by index to maintain order
  const sorted = response.data.sort((a, b) => a.index - b.index);

  for (let i = 0; i < sorted.length; i++) {
    const embedding = sorted[i].embedding;
    const originalIdx = uncachedIndices[i];
    results[originalIdx] = embedding;
    _cacheSet(uncached[i], embedding);
  }

  return results;
}

/**
 * Compact text using UTILITY_MODEL before embedding.
 * Reduces token count while preserving semantic meaning.
 * This makes embeddings more focused and search more accurate.
 */
async function compact(text) {
  // Skip compaction for short texts
  if (text.length < 200) return text;

  const result = await aiCall({
    model: getModel("utility"),
    systemPrompt: "Compress the following text into a dense, semantically rich summary. Keep all technical terms, function names, file paths, and error messages. Remove filler words. Output ONLY the compressed text, nothing else.",
    userPrompt: text,
    maxTokens: 256,
    category: "compacting",
  });

  return result.content || text;
}

/**
 * Full pipeline: compact → embed. Returns { compacted, embedding }.
 */
async function compactAndEmbed(text) {
  const compacted = await compact(text);
  const embedding = await embed(compacted);
  return { compacted, embedding };
}

module.exports = { embed, embedBatch, compact, compactAndEmbed };
