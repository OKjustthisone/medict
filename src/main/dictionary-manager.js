const fs = require("node:fs/promises");
const path = require("node:path");
const { queryMerriamWebster, queryOxford } = require("./services/dictionary-api");

function text(value) {
  return String(value ?? "").trim();
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function normalizeSense(raw, fallback = {}) {
  if (typeof raw === "string" || typeof raw === "number") {
    return {
      partOfSpeech: text(fallback.partOfSpeech || fallback.pos),
      definition: text(raw),
      translations: unique(list(fallback.translation || fallback.translations)),
      examples: [],
      synonyms: []
    };
  }
  const item = raw && typeof raw === "object" ? raw : {};
  const definition = text(item.definition || item.meaning || item.gloss || item.def || item.text);
  return {
    partOfSpeech: text(item.partOfSpeech || item.pos || fallback.partOfSpeech || fallback.pos),
    definition,
    translations: unique(list(item.translations || item.translation || fallback.translation || fallback.translations)),
    examples: unique(list(item.examples || item.example || fallback.examples)),
    synonyms: unique(list(item.synonyms || fallback.synonyms))
  };
}

function normalizeEntry(raw, source) {
  if (!raw || typeof raw !== "object") return null;
  const word = text(raw.word || raw.headword || raw.term || raw.name || raw.w);
  if (!word) return null;
  const fallback = {
    partOfSpeech: raw.partOfSpeech || raw.pos,
    pos: raw.pos,
    translation: raw.translation,
    translations: raw.translations,
    examples: raw.examples || raw.example,
    synonyms: raw.synonyms
  };
  let rawSenses = raw.senses || raw.definitions || raw.definition || raw.def || raw.detail;
  if (!Array.isArray(rawSenses)) rawSenses = rawSenses ? [rawSenses] : [];
  const senses = rawSenses.map(item => normalizeSense(item, fallback)).filter(item => item.definition || item.translations.length);
  if (!senses.length && (raw.translation || raw.translations)) {
    senses.push(normalizeSense({ translations: raw.translations || raw.translation }, fallback));
  }
  if (!senses.length) return null;
  return {
    id: text(raw.id || `${source.id}:${word.toLowerCase()}`),
    word,
    phonetic: text(raw.phonetic || raw.pronunciation || raw.ipa),
    audioUrl: text(raw.audioUrl || raw.audio),
    senses,
    source: {
      id: source.id,
      name: source.name,
      license: source.license || "未声明",
      url: source.sourceUrl || ""
    }
  };
}

function parseCsv(textValue) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(textValue || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some(value => value !== "")) rows.push(row);
  }
  return rows;
}

function parseCsvDictionary(textValue, source) {
  const rows = parseCsv(textValue);
  if (!rows.length) return [];
  const headers = rows[0].map(value => text(value).toLowerCase());
  return rows.slice(1).map(row => {
    const record = Object.fromEntries(headers.map((header, index) => [header, row[index] || ""]));
    return normalizeEntry({
      word: record.word || record.headword || record.term,
      phonetic: record.phonetic || record.pronunciation,
      pos: record.pos || record.part_of_speech,
      definition: record.definition || record.definitions || record.detail,
      translation: record.translation || record.translations,
      examples: record.example || record.examples
    }, source);
  }).filter(Boolean);
}

function parseDictionaryFile(fileText, extension, source) {
  if (extension === ".json") {
    const value = JSON.parse(fileText);
    const entries = Array.isArray(value) ? value : (value.entries || value.words || []);
    const meta = Array.isArray(value) ? {} : value;
    if (meta.name) source.name = text(meta.name);
    if (meta.license) source.license = text(meta.license);
    if (meta.sourceUrl) source.sourceUrl = text(meta.sourceUrl);
    return entries.map(entry => normalizeEntry(entry, source)).filter(Boolean);
  }
  if (extension === ".csv") return parseCsvDictionary(fileText, source);
  return String(fileText || "").split(/\r?\n/).map(line => {
    const [word, definition, translation] = line.split("\t");
    return normalizeEntry({ word, definition, translation }, source);
  }).filter(Boolean);
}

function editDistance(left, right) {
  const a = String(left);
  const b = String(right);
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j < current.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length];
}

class DictionaryManager {
  constructor({ builtinPath, userDictionaryDir }) {
    this.builtinPath = builtinPath;
    this.userDictionaryDir = userDictionaryDir;
    this.sources = [];
  }

  async load() {
    await fs.mkdir(this.userDictionaryDir, { recursive: true });
    const builtin = await this.loadOne(this.builtinPath, "builtin");
    const files = await fs.readdir(this.userDictionaryDir, { withFileTypes: true });
    const imported = [];
    for (const file of files) {
      if (!file.isFile() || !/\.(json|csv|txt)$/i.test(file.name)) continue;
      try {
        imported.push(await this.loadOne(path.join(this.userDictionaryDir, file.name), "imported"));
      } catch (error) {
        console.warn(`Dictionary ${file.name} could not be loaded:`, error.message);
      }
    }
    this.sources = [builtin, ...imported].filter(Boolean);
    return this.listSources();
  }

  async loadOne(filePath, kind) {
    const fileText = await fs.readFile(filePath, "utf8");
    const extension = path.extname(filePath).toLowerCase();
    const id = kind === "builtin" ? "medict-demo" : `local-${path.basename(filePath, extension).toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
    const source = {
      id,
      name: kind === "builtin" ? "Medict 示例词典" : path.basename(filePath),
      kind,
      fileName: path.basename(filePath),
      license: kind === "builtin" ? "CC0-1.0（项目自编示例内容）" : "请确认导入文件的授权",
      sourceUrl: "",
      entries: []
    };
    source.entries = parseDictionaryFile(fileText, extension, source);
    return source;
  }

  listSources() {
    return this.sources.map(source => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      fileName: source.fileName,
      license: source.license,
      sourceUrl: source.sourceUrl,
      entryCount: source.entries.length
    }));
  }

  async importFile(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if (!/\.(json|csv|txt)$/i.test(extension)) {
      throw new Error("当前版本支持 JSON、CSV/ECB Dictionary 导出文件和制表符 TXT 文件");
    }
    const originalName = path.basename(filePath);
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const destination = path.join(this.userDictionaryDir, safeName || `dictionary${extension}`);
    await fs.copyFile(filePath, destination);
    await this.load();
    return this.listSources();
  }

  async search(query, settings = {}) {
    const normalizedQuery = text(query).toLowerCase();
    const warnings = [];
    if (!normalizedQuery) return { type: "dictionary", query: text(query), results: [], warnings };

    const localResults = [];
    for (const source of this.sources) {
      for (const entry of source.entries) {
        const word = entry.word.toLowerCase();
        const score = word === normalizedQuery
          ? 0
          : word.startsWith(normalizedQuery)
            ? 1
            : word.includes(normalizedQuery)
              ? 2
              : editDistance(word, normalizedQuery) <= 2
                ? 3
                : 99;
        if (score < 99) localResults.push({ entry, score });
      }
    }
    localResults.sort((left, right) => left.score - right.score || left.entry.word.length - right.entry.word.length);
    const results = localResults.slice(0, 40).map(item => ({ type: "local", ...item.entry }));

    const dictionarySettings = settings.dictionary || {};
    const onlineTasks = [];
    if (dictionarySettings.oxford?.enabled && dictionarySettings.oxford.appId && dictionarySettings.oxford.appKey) {
      onlineTasks.push(queryOxford(normalizedQuery, dictionarySettings.oxford).catch(error => {
        warnings.push(`Oxford：${error.message}`);
        return null;
      }));
    }
    if (dictionarySettings.merriamWebster?.enabled && dictionarySettings.merriamWebster.apiKey) {
      onlineTasks.push(queryMerriamWebster(normalizedQuery, dictionarySettings.merriamWebster).catch(error => {
        warnings.push(`Merriam-Webster：${error.message}`);
        return null;
      }));
    }
    const onlineResults = (await Promise.all(onlineTasks)).filter(Boolean);
    return {
      type: "dictionary",
      query: text(query),
      results: [...results, ...onlineResults],
      warnings,
      sources: this.listSources()
    };
  }
}

module.exports = {
  DictionaryManager,
  editDistance,
  normalizeEntry,
  parseCsv
};
