const fs = require("node:fs/promises");
const path = require("node:path");

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_VERSION = 3;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeDrugCacheKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function cacheAliases(query, result) {
  const names = result?.names || {};
  return [...new Set([
    query,
    result?.query,
    result?.name,
    names.preferred,
    ...[].concat(names.generic || []),
    ...[].concat(names.brands || []),
    ...[].concat(names.aliases || [])
  ].map(normalizeDrugCacheKey).filter(Boolean))];
}

function cacheKeyFor(query, result) {
  return normalizeDrugCacheKey(result?.names?.preferred || result?.name || query);
}

class DrugCache {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.ttlMs = Math.max(1000, Number(options.ttlMs) || THIRTY_DAYS_MS);
    this.maxEntries = Math.max(10, Number(options.maxEntries) || 200);
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.entries = {};
    this.writePromise = Promise.resolve();
  }

  async load() {
    let raw = null;
    try {
      raw = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn("Medict drug cache could not be loaded:", error.message);
      }
    }
    const isCurrent = raw?.version === CACHE_VERSION;
    const hasLegacyCache = Boolean(raw?.entries && typeof raw.entries === "object");
    // Version 2 entries were produced before brand/generic canonicalization;
    // keeping them would reintroduce the old split result sets.  They are
    // disposable data, so clear them once and let the next query rebuild the
    // new alias-aware record.
    this.entries = isCurrent ? this.migrateEntries(raw.entries, true) : {};
    if ((!isCurrent && hasLegacyCache) || this.prune()) await this.persist();
    return this.stats();
  }

  migrateEntries(entries, isCurrent) {
    const migrated = {};
    if (!entries || typeof entries !== "object") return migrated;
    for (const [legacyKey, value] of Object.entries(entries)) {
      if (!value?.result) continue;
      const cachedAt = Number(value.cachedAt) || 0;
      const result = clone(value.result);
      const cacheKey = cacheKeyFor(value.query || legacyKey, result) || normalizeDrugCacheKey(legacyKey);
      if (!cacheKey) continue;
      const aliases = [...new Set([
        ...cacheAliases(value.query || legacyKey, result),
        ...[].concat(value.aliases || []).map(normalizeDrugCacheKey)
      ].filter(Boolean))];
      const entry = {
        cacheKey,
        query: String(value.query || result.query || legacyKey).trim(),
        cachedAt,
        expiresAt: isCurrent && Number(value.expiresAt) > 0 ? Number(value.expiresAt) : cachedAt + this.ttlMs,
        aliases,
        result
      };
      const previous = migrated[cacheKey];
      if (!previous || previous.cachedAt <= entry.cachedAt) migrated[cacheKey] = entry;
    }
    return migrated;
  }

  prune() {
    const now = this.now();
    let changed = false;
    for (const [key, entry] of Object.entries(this.entries)) {
      if (!entry || Number(entry.expiresAt) <= now || !entry.result) {
        delete this.entries[key];
        changed = true;
      }
    }
    const rows = Object.entries(this.entries).sort((left, right) => Number(right[1].cachedAt) - Number(left[1].cachedAt));
    for (const [key] of rows.slice(this.maxEntries)) {
      delete this.entries[key];
      changed = true;
    }
    return changed;
  }

  async get(query) {
    const key = normalizeDrugCacheKey(query);
    if (!key) return null;
    const entry = Object.values(this.entries).find(value => value?.cacheKey === key || value?.aliases?.includes(key));
    if (!entry) return null;
    if (Number(entry.expiresAt) <= this.now()) {
      delete this.entries[entry.cacheKey];
      await this.persist();
      return null;
    }
    return clone(entry);
  }

  async set(query, result) {
    const key = normalizeDrugCacheKey(query);
    if (!key || !result) return null;
    const cachedAt = this.now();
    const cacheKey = cacheKeyFor(query, result) || key;
    const aliases = cacheAliases(query, result);
    const entry = {
      cacheKey,
      query: String(query || "").trim(),
      cachedAt,
      expiresAt: cachedAt + this.ttlMs,
      aliases,
      result: clone(result)
    };
    const aliasSet = new Set(aliases);
    for (const [existingKey, existing] of Object.entries(this.entries)) {
      if (existing?.cacheKey === cacheKey || existing?.aliases?.some(alias => aliasSet.has(alias))) {
        delete this.entries[existingKey];
      }
    }
    this.entries[cacheKey] = entry;
    this.prune();
    await this.persist();
    return clone(entry);
  }

  stats() {
    const entries = Object.values(this.entries);
    return {
      count: entries.length,
      oldestCachedAt: entries.length ? Math.min(...entries.map(entry => Number(entry.cachedAt) || 0)) : null,
      newestCachedAt: entries.length ? Math.max(...entries.map(entry => Number(entry.cachedAt) || 0)) : null,
      ttlMs: this.ttlMs
    };
  }

  persist() {
    const snapshot = `${JSON.stringify({ version: CACHE_VERSION, entries: this.entries }, null, 2)}\n`;
    this.writePromise = this.writePromise.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, snapshot, "utf8");
    });
    return this.writePromise;
  }
}

module.exports = {
  CACHE_VERSION,
  DrugCache,
  cacheAliases,
  cacheKeyFor,
  normalizeDrugCacheKey,
  SEVEN_DAYS_MS,
  THIRTY_DAYS_MS
};
