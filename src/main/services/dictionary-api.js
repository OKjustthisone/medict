const crypto = require("node:crypto");

const DEFAULT_TIMEOUT = 12000;
const SYSTEM_NETWORK_HOSTS = new Set([
  "api.dictionaryapi.dev",
  "aip.baidubce.com",
  "dict.youdao.com",
  "translate.googleapis.com",
  "translation.googleapis.com"
]);
const MAX_FREE_DICTIONARY_SENSES = 36;
const YOUDAO_DICTIONARY_URL = "https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4";
const YOUDAO_DICTIONARY_HOME = "https://dict.youdao.com/";
const YOUDAO_WEB_CLIENT_KEY = "Mk6hqtUp33DGGtoS63tTJbMUYjRrG1Lu";
const MAX_YOUDAO_SENSES = 72;
const MAX_YOUDAO_EXAMPLES = 48;
const MAX_YOUDAO_PHRASES = 32;

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
      error.providerCode = data?.error_code || data?.errorCode || data?.error?.code || "";
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
  const rows = Array.isArray(values) ? values : values == null ? [] : [values];
  return [...new Set(rows.map(clean).filter(Boolean))];
}

function stripMarkup(value) {
  return clean(String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"));
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

function md5(value) {
  return crypto.createHash("md5").update(String(value)).digest("hex");
}

function buildYoudaoDictionaryPayload(query, options = {}) {
  const text = clean(query);
  const webWord = `${text}webdict`;
  const time = webWord.length % 10;
  const salt = md5(webWord);
  const sign = md5(`web${text}${time}${YOUDAO_WEB_CLIENT_KEY}${salt}`);
  return {
    q: text,
    le: clean(options.le || options.language || "en") || "en",
    client: "web",
    t: String(time),
    sign,
    keyfrom: "webdict"
  };
}

function youdaoAudioUrl(value) {
  const audio = clean(value);
  if (!audio) return "";
  if (/^https:\/\//i.test(audio)) return audio;
  const [audioName, ...audioOptions] = audio.split("&");
  const suffix = audioOptions.length ? `&${audioOptions.join("&")}` : "";
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(audioName)}${suffix}`;
}

function youdaoPhonetic(value) {
  const phonetic = clean(value);
  if (!phonetic) return "";
  return phonetic.startsWith("/") ? phonetic : `/${phonetic}/`;
}

function normalizeYoudaoPartOfSpeech(value) {
  const raw = clean(value);
  const normalized = raw.toLowerCase().replace(/[.]/g, "").trim();
  const aliases = {
    n: "noun",
    noun: "noun",
    "n-count": "noun",
    "n-uncount": "noun",
    v: "verb",
    vi: "verb",
    vt: "verb",
    verb: "verb",
    adj: "adjective",
    adjective: "adjective",
    adv: "adverb",
    adverb: "adverb",
    prep: "preposition",
    preposition: "preposition",
    pron: "pronoun",
    pronoun: "pronoun",
    conj: "conjunction",
    conjunction: "conjunction",
    interj: "interjection",
    interjection: "interjection",
    det: "determiner",
    determiner: "determiner",
    num: "numeral",
    numeral: "numeral"
  };
  if (aliases[normalized]) return aliases[normalized];
  const firstToken = normalized.split(/[\s/-]+/)[0];
  return aliases[firstToken] || raw;
}

function youdaoTranslationValue(value) {
  if (typeof value === "string") return clean(value);
  if (!value || typeof value !== "object") return "";
  return clean(value.word || value.w || value.tran || value.translation || value.text || value.value);
}

function youdaoSynonymValues(data, partOfSpeech) {
  const requestedPos = normalizeYoudaoPartOfSpeech(partOfSpeech).toLowerCase();
  const rows = Array.isArray(data?.syno?.synos) ? data.syno.synos : [];
  return unique(rows
    .filter(row => {
      const rowPos = normalizeYoudaoPartOfSpeech(row?.pos || row?.partOfSpeech).toLowerCase();
      return !requestedPos || !rowPos || rowPos === requestedPos;
    })
    .flatMap(row => valuesFromYoudao(row?.ws || row?.words || row?.synonyms)));
}

function valuesFromYoudao(value) {
  if (Array.isArray(value)) return value.map(youdaoTranslationValue).filter(Boolean);
  const item = youdaoTranslationValue(value);
  return item ? [item] : [];
}

function youdaoExampleRows(examples) {
  const rows = Array.isArray(examples) ? examples : [];
  const output = [];
  const seen = new Set();
  for (const row of rows) {
    const example = stripMarkup(row?.example || row?.text || row?.sentence || row?.en || row?.foreign || row);
    if (!example) continue;
    const translation = clean(
      row?.sense?.word || row?.sense?.tran || row?.sense?.translation ||
      row?.translation || row?.tran || row?.zh || row?.chn ||
      row?.sentenceTranslation || row?.["sentence-translation"]
    );
    const source = clean(row?.source || row?.sourceType || row?.type);
    const audioUrl = youdaoAudioUrl(row?.sentenceSpeech || row?.["sentence-speech"] || row?.speech || row?.audio);
    const key = `${example}\u0000${translation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ example, translation, source, audioUrl });
  }
  return output;
}

function isYoudaoWordAlignmentRow(row) {
  const example = clean(row?.example);
  if (!example) return false;
  const words = example.replace(/[.!?…]+$/g, "").split(/\s+/).filter(Boolean);
  if (words.length !== 1 || !/^[a-z][a-z'-]*$/i.test(words[0])) return false;
  const translation = clean(row?.translation).replace(/[。！？.!?…]+$/g, "");
  return translation.split(/\s+/).filter(Boolean).length <= 1;
}

function normalizeYoudaoWordForms(word, extraRows = []) {
  const rows = [
    ...(Array.isArray(word?.wfs) ? word.wfs : []),
    ...extraRows
  ];
  const grouped = new Map();
  rows.flatMap(row => {
    const form = row?.wf || row;
    const label = clean(form?.name || form?.label || row?.name);
    const rawValues = form?.value ?? form?.values ?? row?.value;
    const formValues = (Array.isArray(rawValues) ? rawValues : [rawValues])
      .flatMap(value => clean(value).split(/\s*(?:或|；|;|,|，|\/)\s*/))
      .map(clean)
      .filter(Boolean);
    return label && formValues.length ? [{ label, values: unique(formValues) }] : [];
  }).forEach(row => {
    const existing = grouped.get(row.label) || [];
    grouped.set(row.label, unique([...existing, ...row.values]));
  });
  return [...grouped.entries()].map(([label, values]) => ({ label, values }));
}

function youdaoSenseExampleRows(sense) {
  return (sense?.examples || []).map((example, index) => ({
    example,
    translation: sense?.exampleTranslations?.[index] || "",
    source: sense?.exampleSources?.[index] || "",
    audioUrl: sense?.exampleAudioUrls?.[index] || ""
  }));
}

function setYoudaoSenseExampleRows(sense, rows) {
  const output = [];
  const seen = new Set();
  for (const row of rows || []) {
    const example = stripMarkup(row?.example);
    if (!example) continue;
    const translation = clean(row?.translation);
    const key = `${example}\u0000${translation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      example,
      translation,
      source: clean(row?.source),
      audioUrl: clean(row?.audioUrl)
    });
  }
  sense.examples = output.map(row => row.example);
  sense.exampleTranslations = output.map(row => row.translation);
  sense.exampleSources = output.map(row => row.source);
  sense.exampleAudioUrls = output.map(row => row.audioUrl);
}

function youdaoTranslationTokens(values) {
  return unique((values || [])
    .flatMap(value => stripMarkup(value).split(/[；;、,，]/))
    .map(item => clean(item).replace(/^\s*(?:n\.|v\.|adj\.|adv\.)\s*/i, "")));
}

function youdaoSenseMatches(left, right) {
  const leftPos = normalizeYoudaoPartOfSpeech(left?.partOfSpeech).toLowerCase();
  const rightPos = normalizeYoudaoPartOfSpeech(right?.partOfSpeech).toLowerCase();
  if (leftPos && rightPos && leftPos !== rightPos) return false;
  const leftDefinition = stripMarkup(left?.definition).toLowerCase();
  const rightDefinition = stripMarkup(right?.definition).toLowerCase();
  if (leftDefinition && rightDefinition && leftDefinition === rightDefinition) return true;
  const leftTranslations = youdaoTranslationTokens(left?.translations);
  const rightTranslations = youdaoTranslationTokens(right?.translations);
  const incomingTranslationIsSingle = rightTranslations.length === 1;
  return incomingTranslationIsSingle && leftTranslations.length > 0 && rightTranslations.some(item => leftTranslations.includes(item));
}

function mergeYoudaoSense(target, source) {
  if (!target.definition && source.definition) target.definition = source.definition;
  if (!target.partOfSpeech && source.partOfSpeech) target.partOfSpeech = source.partOfSpeech;
  target.translations = unique([...(target.translations || []), ...(source.translations || [])]);
  target.synonyms = unique([...(target.synonyms || []), ...(source.synonyms || [])]);
  target.antonyms = unique([...(target.antonyms || []), ...(source.antonyms || [])]);
  if (source.note && !target.note) target.note = source.note;
  setYoudaoSenseExampleRows(target, [
    ...youdaoSenseExampleRows(target),
    ...youdaoSenseExampleRows(source)
  ]);
  return target;
}

function appendYoudaoSense(senses, sense) {
  if (!sense || (!sense.definition && !sense.translations?.length && !sense.examples?.length)) return;
  const existing = senses.find(item => youdaoSenseMatches(item, sense));
  if (existing) {
    mergeYoudaoSense(existing, sense);
    return;
  }
  const next = {
    partOfSpeech: normalizeYoudaoPartOfSpeech(sense.partOfSpeech),
    definition: stripMarkup(sense.definition),
    translations: unique(sense.translations || []),
    examples: [],
    exampleTranslations: [],
    exampleSources: [],
    exampleAudioUrls: [],
    synonyms: unique(sense.synonyms || []),
    antonyms: unique(sense.antonyms || []),
    homograph: sense.homograph,
    note: clean(sense.note)
  };
  setYoudaoSenseExampleRows(next, youdaoSenseExampleRows(sense));
  senses.push(next);
}

function youdaoCollinsSenses(data) {
  const gramcats = Array.isArray(data?.collins_primary?.gramcat)
    ? data.collins_primary.gramcat
    : [];
  return gramcats.flatMap((gramcat, gramcatIndex) => {
    const partOfSpeech = normalizeYoudaoPartOfSpeech(gramcat?.partofspeech || gramcat?.partOfSpeech || gramcat?.gram || gramcat?.label);
    return (Array.isArray(gramcat?.senses) ? gramcat.senses : []).map(sense => {
      const exampleRows = youdaoExampleRows(sense?.examples);
      return {
        partOfSpeech,
        definition: stripMarkup(sense?.definition || sense?.def),
        translations: unique(valuesFromYoudao(sense?.word || sense?.translation || sense?.tran)),
        examples: exampleRows.map(row => row.example),
        exampleTranslations: exampleRows.map(row => row.translation),
        exampleSources: exampleRows.map(row => row.source),
        exampleAudioUrls: exampleRows.map(row => row.audioUrl),
        synonyms: youdaoSynonymValues(data, partOfSpeech),
        antonyms: [],
        homograph: gramcatIndex + 1
      };
    }).filter(sense => sense.definition || sense.translations.length || sense.examples.length);
  });
}

function youdaoBasicSenses(data) {
  const rows = Array.isArray(data?.ec?.word?.trs) ? data.ec.word.trs : [];
  return rows.map(row => ({
    partOfSpeech: normalizeYoudaoPartOfSpeech(row?.pos || row?.part),
    definition: "",
    translations: unique(valuesFromYoudao(row?.tran || row?.translation || row?.word)),
    examples: [],
    exampleTranslations: [],
    synonyms: youdaoSynonymValues(data, row?.pos || row?.part),
    antonyms: []
  })).filter(sense => sense.translations.length);
}

function youdaoExpandedSenses(data) {
  const rows = Array.isArray(data?.expand_ec?.word) ? data.expand_ec.word : [];
  return rows.flatMap(row => {
    const partOfSpeech = normalizeYoudaoPartOfSpeech(row?.pos || row?.part);
    return (Array.isArray(row?.transList) ? row.transList : []).map(item => {
      const content = item?.content || {};
      const exampleRows = youdaoExampleRows((content.sents || []).map(sentence => ({
        example: sentence?.sentOrig || sentence?.sentSpeech,
        translation: sentence?.sentTrans,
        source: sentence?.source || sentence?.sourceType,
        audio: sentence?.sentSpeech
      })));
      const examTypes = Array.isArray(content.examType)
        ? content.examType.flatMap(type => [type?.en, type?.zh]).filter(Boolean).join(" / ")
        : "";
      return {
        partOfSpeech,
        definition: "",
        translations: unique([item?.trans]),
        examples: exampleRows.map(row => row.example),
        exampleTranslations: exampleRows.map(row => row.translation),
        exampleSources: exampleRows.map(row => row.source),
        exampleAudioUrls: exampleRows.map(row => row.audioUrl),
        synonyms: [],
        antonyms: [],
        note: [clean(content.detailPos), examTypes].filter(Boolean).join(" · ")
      };
    }).filter(sense => sense.translations.length || sense.examples.length);
  });
}

function youdaoWordnetSenses(data) {
  const rows = Array.isArray(data?.ee?.word?.trs) ? data.ee.word.trs : [];
  return rows.flatMap(row => (Array.isArray(row?.tr) ? row.tr : []).map(item => {
    const exampleRows = youdaoExampleRows(item?.examples);
    return {
      partOfSpeech: normalizeYoudaoPartOfSpeech(row?.pos || row?.part),
      definition: stripMarkup(item?.tran),
      translations: [],
      examples: exampleRows.map(example => example.example),
      exampleTranslations: exampleRows.map(example => example.translation),
      exampleSources: exampleRows.map(example => example.source),
      exampleAudioUrls: exampleRows.map(example => example.audioUrl),
      synonyms: unique(item?.["similar-words"]),
      antonyms: []
    };
  }).filter(sense => sense.definition || sense.examples.length));
}

function youdaoDictionaryExamples(data) {
  const rows = [];
  const add = examples => rows.push(...youdaoExampleRows(examples));
  const wordTranslations = Array.isArray(data?.ec?.word?.trs) ? data.ec.word.trs : [];
  add(wordTranslations.flatMap(row => Array.isArray(row?.sentence) ? row.sentence.map(sentence => ({
    example: sentence?.en || sentence?.enShow,
    translation: sentence?.zh,
    source: sentence?.type
  })) : []));
  add(data?.blng_sents_part?.["sentence-pair"]);
  add(data?.individual?.pastExamSents?.map(row => ({
    example: row?.en,
    translation: row?.zh,
    source: row?.source
  })));
  add(data?.auth_sents_part?.sent?.map(row => ({
    example: row?.foreign,
    source: row?.source
  })));
  add(data?.media_sents_part?.sent?.map(row => ({
    example: row?.eng,
    translation: row?.chn,
    source: row?.["@mediatype"]
  })));
  add(data?.expand_ec?.word?.flatMap(row => (row?.transList || []).flatMap(item =>
    (item?.content?.sents || []).map(sentence => ({
      example: sentence?.sentOrig || sentence?.sentSpeech,
      translation: sentence?.sentTrans,
      source: sentence?.source || sentence?.sourceType,
      audio: sentence?.sentSpeech
    }))
  )));
  const output = [];
  const seen = new Set();
  for (const row of rows) {
    if (isYoudaoWordAlignmentRow(row)) continue;
    const key = `${row.example}\u0000${row.translation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
    if (output.length >= MAX_YOUDAO_EXAMPLES) break;
  }
  return output;
}

function youdaoPhraseRows(data) {
  const rows = Array.isArray(data?.phrs?.phrs) ? data.phrs.phrs : [];
  return rows.map(row => ({
    phrase: clean(row?.headword),
    translations: unique([row?.translation])
  })).filter(row => row.phrase && row.translations.length).slice(0, MAX_YOUDAO_PHRASES);
}

function youdaoRelatedWordRows(data) {
  const rows = Array.isArray(data?.rel_word?.rels) ? data.rel_word.rels : [];
  return rows.flatMap(row => (row?.rel?.words || []).map(word => ({
    partOfSpeech: normalizeYoudaoPartOfSpeech(row?.rel?.pos),
    word: clean(word?.word),
    translations: unique([word?.tran])
  }))).filter(row => row.word).slice(0, MAX_YOUDAO_PHRASES);
}

function youdaoWebTranslationRows(data) {
  const rows = Array.isArray(data?.web_trans?.["web-translation"])
    ? data.web_trans["web-translation"]
    : [];
  return rows.map(row => ({
    word: clean(row?.key),
    translations: unique((row?.trans || []).map(item => item?.value))
  })).filter(row => row.word && row.translations.length).slice(0, MAX_YOUDAO_PHRASES);
}

function youdaoTags(data, expandedRows = []) {
  const expandedTags = expandedRows.flatMap(row => {
    const content = row?.content || {};
    return Array.isArray(content.examType)
      ? content.examType.flatMap(item => [item?.en, item?.zh])
      : [];
  });
  const examTypes = Array.isArray(data?.ec?.exam_type)
    ? data.ec.exam_type
    : [data?.ec?.exam_type];
  return unique([...examTypes, ...expandedTags]);
}

function normalizeYoudaoDictionary(data, query) {
  const word = data?.ec?.word || {};
  const text = clean(word.word || query);
  if (!text) return null;

  const phonetics = [];
  const ukPhone = youdaoPhonetic(word.ukphone);
  const usPhone = youdaoPhonetic(word.usphone);
  if (ukPhone) phonetics.push({ label: "英", text: ukPhone, audioUrl: youdaoAudioUrl(word.ukspeech) });
  if (usPhone) phonetics.push({ label: "美", text: usPhone, audioUrl: youdaoAudioUrl(word.usspeech) });
  const firstGramcat = Array.isArray(data?.collins_primary?.gramcat) ? data.collins_primary.gramcat[0] : null;
  if (!phonetics.length && firstGramcat?.pronunciation) {
    phonetics.push({ label: "", text: youdaoPhonetic(firstGramcat.pronunciation), audioUrl: youdaoAudioUrl(firstGramcat.audiourl) });
  }
  const phonetic = phonetics.map(item => [item.label, item.text].filter(Boolean).join(" ")).join("  ");
  const audioUrl = phonetics.find(item => item.audioUrl)?.audioUrl || firstGramcat?.audiourl || "";
  const gramcats = Array.isArray(data?.collins_primary?.gramcat) ? data.collins_primary.gramcat : [];
  const expandedWords = Array.isArray(data?.expand_ec?.word) ? data.expand_ec.word : [];
  const senses = [];
  for (const sense of youdaoCollinsSenses(data)) appendYoudaoSense(senses, sense);
  for (const sense of youdaoBasicSenses(data)) appendYoudaoSense(senses, sense);
  for (const sense of youdaoExpandedSenses(data)) appendYoudaoSense(senses, sense);
  for (const sense of youdaoWordnetSenses(data)) appendYoudaoSense(senses, sense);
  const directTranslations = unique(data?.ec?.web_trans);
  if (!senses.length && directTranslations.length) {
    appendYoudaoSense(senses, {
      partOfSpeech: "",
      definition: "",
      translations: directTranslations,
      examples: []
    });
  }
  const normalizedSenses = senses.slice(0, MAX_YOUDAO_SENSES);
  if (!normalizedSenses.length) return null;

  const sourceUrl = `https://dict.youdao.com/result?word=${encodeURIComponent(text)}&lang=en`;
  const extraWordForms = [
    ...expandedWords.flatMap(row => Array.isArray(row?.wfs) ? row.wfs : []),
    ...gramcats.flatMap(row => (row?.forms || []).map(form => ({ name: "词典词形", value: form?.form })))
  ];
  return {
    type: "online-dictionary",
    provider: "youdao-dictionary",
    name: "网易有道词典",
    word: text,
    phonetic,
    phonetics,
    audioUrl,
    wordForms: normalizeYoudaoWordForms(word, extraWordForms),
    senses: normalizedSenses,
    examples: youdaoDictionaryExamples(data),
    phrases: youdaoPhraseRows(data),
    relatedWords: youdaoRelatedWordRows(data),
    webTranslations: youdaoWebTranslationRows(data),
    tags: youdaoTags(data, expandedWords.flatMap(row => row?.transList || [])),
    source: {
      id: "youdao-dictionary",
      name: "网易有道网页词典",
      license: "有道网页服务",
      url: sourceUrl
    },
    meta: {
      api: "web-v4",
      senseCount: normalizedSenses.length,
      responseSections: Object.keys(data || {})
    }
  };
}

async function queryYoudaoDictionary(query) {
  const word = clean(query).toLowerCase();
  if (!isEnglishDictionaryQuery(word)) return null;
  const payload = buildYoudaoDictionaryPayload(word, { le: "en" });
  const data = await fetchJson(YOUDAO_DICTIONARY_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Referer: YOUDAO_DICTIONARY_HOME,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
    },
    body: new URLSearchParams(payload).toString()
  }, 16000);
  return normalizeYoudaoDictionary(data, word);
}

function youdaoLanguageLabel(value) {
  const normalized = clean(value).toLowerCase();
  const aliases = {
    eng: "en",
    en: "en",
    cmn: "zh-CN",
    zh: "zh-CN",
    jpn: "ja",
    ja: "ja",
    fra: "fr",
    fr: "fr",
    kor: "ko",
    ko: "ko"
  };
  return aliases[normalized] || clean(value);
}

function normalizeYoudaoTranslation(data, query) {
  const text = clean(query || data?.fanyi?.input || data?.input);
  if (!text) return null;
  const webRows = youdaoWebTranslationRows(data);
  const primaryWeb = webRows.find(row => row.word.toLowerCase() === text.toLowerCase());
  const webTranslations = primaryWeb?.translations || [];
  const simpleTranslations = unique(data?.ec?.web_trans);
  const fanyiTranslation = clean(data?.fanyi?.tran);
  const wordTranslations = Array.isArray(data?.ec?.word?.trs)
    ? data.ec.word.trs.flatMap(row => valuesFromYoudao(row?.tran || row?.translation || row?.word))
    : [];
  const chineseTranslations = Array.isArray(data?.ce?.word?.trs)
    ? data.ce.word.trs.flatMap(row => valuesFromYoudao(row?.tran || row?.translation || row?.text))
    : [];
  const translations = unique([
    fanyiTranslation,
    ...simpleTranslations,
    ...webTranslations,
    ...(fanyiTranslation || simpleTranslations.length || webTranslations.length ? [] : wordTranslations),
    ...chineseTranslations
  ]);
  if (!translations.length) return null;
  const examples = youdaoDictionaryExamples(data);
  return {
    type: "translation",
    provider: "youdao-web",
    name: "网易有道网页翻译",
    query: text,
    detectedSource: youdaoLanguageLabel(data?.meta?.guessLanguage || data?.lang || ""),
    translations,
    examples,
    related: webRows.filter(row => row.word.toLowerCase() !== text.toLowerCase()),
    source: {
      id: "youdao-web",
      name: "网易有道网页翻译",
      license: "有道网页服务",
      url: `https://dict.youdao.com/result?word=${encodeURIComponent(text)}&lang=en`
    },
    mode: "web",
    meta: {
      api: "web-v4",
      responseSections: Object.keys(data || {})
    }
  };
}

async function queryYoudaoTranslation(query, options = {}) {
  const text = clean(query);
  if (!text) return null;
  const payload = buildYoudaoDictionaryPayload(text, { le: options.le || "en" });
  const data = await fetchJson(YOUDAO_DICTIONARY_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Referer: YOUDAO_DICTIONARY_HOME,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
    },
    body: new URLSearchParams(payload).toString()
  }, 16000);
  return normalizeYoudaoTranslation(data, text);
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
  buildYoudaoDictionaryPayload,
  fetchJson,
  isEnglishDictionaryQuery,
  normalizeFreeDictionary,
  runtimeFetch,
  normalizeMerriamItem,
  normalizeYoudaoTranslation,
  normalizeOxford,
  normalizeYoudaoDictionary,
  queryFreeDictionary,
  queryMerriamWebster,
  queryOxford,
  queryYoudaoDictionary,
  queryYoudaoTranslation
};
