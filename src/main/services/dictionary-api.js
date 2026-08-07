const DEFAULT_TIMEOUT = 12000;
const SYSTEM_NETWORK_HOSTS = new Set([
  "api.dictionaryapi.dev",
  "aip.baidubce.com",
  "openapi.youdao.com",
  "translate.googleapis.com",
  "translation.googleapis.com"
]);
const MAX_FREE_DICTIONARY_SENSES = 36;

async function runtimeFetch(url, options) {
  const hostname = (() => {
    try { return new URL(String(url)).hostname.toLowerCase(); } catch (_) { return ""; }
  })();
  const useSystemNetworkFirst = process.versions?.electron && SYSTEM_NETWORK_HOSTS.has(hostname);
  if (useSystemNetworkFirst) {
    try {
      const { net } = require("electron");
      if (net?.fetch) return await net.fetch(url, options);
    } catch (error) {
      console.warn("Electron net.fetch failed; falling back to Node fetch:", error.message);
    }
  }
  try {
    return await fetch(url, options);
  } catch (error) {
    if (!process.versions?.electron || options?.signal?.aborted || useSystemNetworkFirst) throw error;
    const { net } = require("electron");
    if (!net?.fetch) throw error;
    return net.fetch(url, options);
  }
}

async function fetchJson(url, options = {}, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await runtimeFetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    let data = null;
    try {
      data = body ? JSON.parse(body) : null;
    } catch (_) {
      data = null;
    }
    if (!response.ok) {
      const error = new Error(data?.message || data?.error?.message || `${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function isEnglishDictionaryQuery(value) {
  return /^[a-z][a-z'-]{0,63}$/i.test(clean(value));
}

function absoluteHttpsUrl(value) {
  const url = clean(value);
  if (url.startsWith("//")) return `https:${url}`;
  return /^https:\/\//i.test(url) ? url : "";
}

function normalizeFreeDictionary(data, query) {
  const entries = Array.isArray(data) ? data.filter(item => item && typeof item === "object") : [];
  if (!entries.length) return null;

  const groups = entries.flatMap((entry, entryIndex) => (entry.meanings || []).map((meaning, meaningIndex) => ({
    entryIndex,
    meaningIndex,
    partOfSpeech: clean(meaning.partOfSpeech),
    definitions: (meaning.definitions || []).map(item => ({
      definition: clean(item.definition),
      examples: unique([item.example]),
      synonyms: unique([...(meaning.synonyms || []), ...(item.synonyms || [])]).slice(0, 12),
      antonyms: unique([...(meaning.antonyms || []), ...(item.antonyms || [])]).slice(0, 12)
    })).filter(item => item.definition)
  }))).filter(group => group.definitions.length);

  // Round-robin across homographs and parts of speech. This keeps distinct common
  // meanings (for example fan=扇子 and fan=粉丝) near the top without dropping
  // the less common senses returned by the source.
  const senses = [];
  const seenSenses = new Set();
  const depth = Math.max(0, ...groups.map(group => group.definitions.length));
  senseLoop:
  for (let definitionIndex = 0; definitionIndex < depth; definitionIndex += 1) {
    for (const group of groups) {
      const item = group.definitions[definitionIndex];
      if (!item) continue;
      const key = `${group.partOfSpeech.toLowerCase()}\u0000${item.definition.toLowerCase()}`;
      if (seenSenses.has(key)) continue;
      seenSenses.add(key);
      senses.push({
        partOfSpeech: group.partOfSpeech,
        definition: item.definition,
        translations: [],
        examples: item.examples,
        synonyms: item.synonyms,
        antonyms: item.antonyms,
        homograph: group.entryIndex + 1
      });
      if (senses.length >= MAX_FREE_DICTIONARY_SENSES) break senseLoop;
    }
  }
  if (!senses.length) return null;

  const phonetics = [];
  const seenPhonetics = new Set();
  for (const entry of entries) {
    const rows = [
      ...(entry.phonetics || []),
      ...(entry.phonetic ? [{ text: entry.phonetic }] : [])
    ];
    for (const row of rows) {
      const text = clean(row?.text);
      const audioUrl = absoluteHttpsUrl(row?.audio);
      const key = `${text}\u0000${audioUrl}`;
      if ((!text && !audioUrl) || seenPhonetics.has(key)) continue;
      seenPhonetics.add(key);
      phonetics.push({ text, audioUrl });
    }
  }

  const word = clean(entries.find(entry => entry.word)?.word || query);
  const sourceUrls = unique(entries.flatMap(entry => entry.sourceUrls || []));
  const license = entries.find(entry => entry.license?.name)?.license || {};
  const phonetic = phonetics.find(item => item.text)?.text || "";
  const audioUrl = phonetics.find(item => item.audioUrl)?.audioUrl || "";

  return {
    type: "online-dictionary",
    provider: "free-dictionary",
    name: "Free Dictionary",
    word,
    phonetic,
    phonetics,
    audioUrl,
    senses,
    source: {
      id: "free-dictionary",
      name: "Free Dictionary",
      license: clean(license.name || "Source-provided license"),
      licenseUrl: absoluteHttpsUrl(license.url),
      url: sourceUrls.find(url => /^https:\/\//i.test(url)) || `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`
    },
    meta: {
      entryCount: entries.length,
      senseCount: senses.length
    }
  };
}

async function queryFreeDictionary(query) {
  const word = clean(query).toLowerCase();
  if (!isEnglishDictionaryQuery(word)) return null;
  try {
    const data = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {}, 16000);
    return normalizeFreeDictionary(data, word);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function oxfordSenseRows(senses = []) {
  return senses.flatMap(sense => {
    const definitions = (sense.definitions || []).map(definition => ({
      definition: clean(definition),
      translations: unique((sense.translations || []).map(item => item.text || item.translation)),
      examples: unique((sense.examples || []).map(item => item.text || item.example)),
      synonyms: unique((sense.synonyms || []).map(item => item.text || item.word))
    })).filter(item => item.definition || item.translations.length);
    return [...definitions, ...oxfordSenseRows(sense.senses || [])];
  });
}

function normalizeOxford(data, query, config) {
  const results = data?.results || [];
  const lexicalEntries = results.flatMap(result => result.lexicalEntries || []);
  const entries = lexicalEntries.map(lexicalEntry => {
    const allEntries = lexicalEntry.entries || [];
    const senses = allEntries.flatMap(entry => oxfordSenseRows(entry.senses || []));
    const pronunciations = allEntries.flatMap(entry => entry.pronunciations || []);
    return {
      partOfSpeech: clean(lexicalEntry.lexicalCategory?.text || lexicalEntry.lexicalCategory),
      definitions: senses,
      pronunciation: clean(pronunciations[0]?.phoneticSpelling),
      audioUrl: clean(pronunciations[0]?.audioFile)
    };
  }).filter(entry => entry.definitions.length || entry.partOfSpeech);
  const phonetic = entries.find(entry => entry.pronunciation)?.pronunciation || "";
  return {
    type: "online",
    provider: "oxford",
    word: clean(results[0]?.word || query),
    phonetic,
    audioUrl: entries.find(entry => entry.audioUrl)?.audioUrl || "",
    entries,
    source: {
      id: "oxford",
      name: "Oxford Dictionaries API",
      license: "Oxford API license required",
      url: `https://www.oxfordlearnersdictionaries.com/definition/english/${encodeURIComponent(query)}`
    },
    meta: { locale: config.locale || "en-gb" }
  };
}

async function queryOxford(query, config = {}) {
  const locale = config.locale || "en-gb";
  const base = "https://od-api.oxforddictionaries.com/api/v2";
  const headers = {
    app_id: config.appId,
    app_key: config.appKey,
    Accept: "application/json"
  };
  const encodedWord = encodeURIComponent(clean(query).toLowerCase());
  let data;
  try {
    data = await fetchJson(`${base}/words/${locale}/${encodedWord}`, { headers });
  } catch (error) {
    if (error.status !== 404) throw error;
    data = await fetchJson(`${base}/words/${locale}?q=${encodedWord}`, { headers });
  }
  return normalizeOxford(data, query, config);
}

function merriamAudioUrl(item) {
  const audio = item?.hwi?.prs?.find(pronunciation => pronunciation.sound?.audio)?.sound?.audio;
  if (!audio) return "";
  const first = audio[0];
  const subdirectory = first === "b" ? "b" : first === "g" ? "gg" : first === "p" ? "p" : "number";
  return `https://media.merriam-webster.com/audio/prons/en/us/mp3/${subdirectory}/${audio}.mp3`;
}

function merriamExamples(value) {
  if (!Array.isArray(value)) return [];
  const examples = [];
  const visit = node => {
    if (!Array.isArray(node)) return;
    if (node[0] === "vis" && Array.isArray(node[1])) {
      for (const item of node[1]) {
        if (item?.t) examples.push(clean(item.t.replace(/{wi}/g, "").replace(/{\/wi}/g, "")));
      }
    }
    node.forEach(visit);
  };
  visit(value);
  return unique(examples);
}

function normalizeMerriamItem(item, query, config) {
  const shortDefinitions = unique(item.shortdef || []);
  const detailedExamples = merriamExamples(item.def);
  return {
    type: "online",
    provider: "merriam-webster",
    word: clean(item.meta?.id || item.hwi?.hw || query).replace(/\{[^}]+\}/g, ""),
    phonetic: clean(item.hwi?.prs?.[0]?.mw),
    audioUrl: merriamAudioUrl(item),
    entries: [{
      partOfSpeech: clean(item.fl),
      definitions: shortDefinitions.map((definition, index) => ({
        definition,
        translations: [],
        examples: index === 0 ? detailedExamples : [],
        synonyms: []
      }))
    }].filter(entry => entry.definitions.length || entry.partOfSpeech),
    source: {
      id: "merriam-webster",
      name: "Merriam-Webster Collegiate API",
      license: "Merriam-Webster API license required",
      url: `https://www.merriam-webster.com/dictionary/${encodeURIComponent(query)}`
    },
    meta: { api: config.apiKey ? "configured" : "missing" }
  };
}

async function queryMerriamWebster(query, config = {}) {
  const encodedWord = encodeURIComponent(clean(query).toLowerCase());
  const url = `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${encodedWord}?key=${encodeURIComponent(config.apiKey)}`;
  const data = await fetchJson(url);
  if (!Array.isArray(data) || !data.length) return null;
  if (typeof data[0] === "string") {
    return {
      type: "suggestions",
      provider: "merriam-webster",
      word: clean(query),
      suggestions: data.slice(0, 12).map(clean).filter(Boolean),
      source: {
        id: "merriam-webster",
        name: "Merriam-Webster Collegiate API",
        license: "Merriam-Webster API license required",
        url: `https://www.merriam-webster.com/dictionary/${encodeURIComponent(query)}`
      }
    };
  }
  return normalizeMerriamItem(data[0], query, config);
}

module.exports = {
  fetchJson,
  isEnglishDictionaryQuery,
  normalizeFreeDictionary,
  runtimeFetch,
  normalizeMerriamItem,
  normalizeOxford,
  queryFreeDictionary,
  queryMerriamWebster,
  queryOxford
};
