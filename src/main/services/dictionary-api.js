const DEFAULT_TIMEOUT = 12000;

async function fetchJson(url, options = {}, timeout = DEFAULT_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
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
  normalizeMerriamItem,
  normalizeOxford,
  queryMerriamWebster,
  queryOxford
};
