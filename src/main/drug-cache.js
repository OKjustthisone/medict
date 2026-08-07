const fs = require("node:fs/promises");
const path = require("node:path");

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_VERSION = 2;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeDrugCacheKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

class DrugCache {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.ttlMs = Math.max(1000, Number(options.ttlMs) || SEVEN_DAYS_MS);
    this.maxEntries = Math.max(10, Number(options.maxEntries) || 200);
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.entries = {};
    this.writePromise = Promise.resolve();
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.entries = raw?.version === CACHE_VERSION && raw?.entries && typeof raw.entries === "object" ? raw.entries : {};
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn("Medict drug cache could not be loaded:", error.message);
      }
      this.entries = {};
    }
    if (this.prune()) await this.persist();
    return this.stats();
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
    const entry = this.entries[key];
    if (!entry) return null;
    if (Number(entry.expiresAt) <= this.now()) {
      delete this.entries[key];
      await this.persist();
      return null;
    }
    return clone(entry);
  }

  async set(query, result) {
    const key = normalizeDrugCacheKey(query);
    if (!key || !result) return null;
    const cachedAt = this.now();
    const entry = {
      query: String(query || "").trim(),
      cachedAt,
      expiresAt: cachedAt + this.ttlMs,
      result: clone(result)
    };
    this.entries[key] = entry;
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
  normalizeDrugCacheKey,
  SEVEN_DAYS_MS
};
