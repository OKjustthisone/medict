const { fetchJson, isEnglishDictionaryQuery, queryYoudaoTranslation } = require("./dictionary-api");

function clean(value) {
  return String(value ?? "").trim();
}

async function mapWithConcurrency(values, limit, worker) {
  const rows = new Array(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      rows[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return rows;
}

const BAIDU_TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const BAIDU_DICTIONARY_URL = "https://aip.baidubce.com/rpc/2.0/mt/texttrans-with-dict/v1";
const BAIDU_DICTIONARY_DOC_URL = "https://cloud.baidu.com/doc/MT/s/nkqrzmbpc";
const BAIDU_MIN_REQUEST_INTERVAL_MS = 1100;
const baiduTokenCache = new Map();
const baiduRequestState = new Map();

const BAIDU_ERROR_MESSAGES = {
  4: "百度服务集群当前限流，不代表本应用额度已经用完；请稍后重试",
  6: "当前应用没有该接口权限，请确认已开通文本翻译-词典版",
  18: "百度接口 QPS 超限；标准版通常需要间隔请求，应用会自动排队并重试一次",
  19: "百度账号或服务的总请求量/字符额度已用完",
  100: "Access Token 无效，请检查百度 API Key 和 Secret Key",
  110: "Access Token 无效或已失效",
  111: "Access Token 已过期",
  20003: "请求内容触发百度安全策略",
  31005: "百度账号用量已超限",
  31104: "百度接口访问频率受限",
  31105: "百度不支持当前语种方向",
  31106: "百度查询文本超过长度限制",
  282003: "百度接口缺少必要参数",
  282004: "百度接口参数格式无效"
};

function targetForBaidu(value) {
  const normalized = clean(value).toLowerCase();
  if (["zh", "zh-cn", "zh-chs"].includes(normalized)) return "zh";
  if (["en-us", "en-gb"].includes(normalized)) return "en";
  if (normalized === "ja") return "jp";
  return normalized;
}

function sourceForBaidu(value) {
  const normalized = clean(value).toLowerCase();
  if (["zh-cn", "zh-chs"].includes(normalized)) return "zh";
  if (["en-us", "en-gb"].includes(normalized)) return "en";
  if (normalized === "ja") return "jp";
  return normalized || "auto";
}

function isBaiduDictionaryQuery(value) {
  return /^[a-z][a-z' -]{0,63}$/i.test(clean(value));
}

function arrayValues(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value])
    .flatMap(item => Array.isArray(item) ? item : [item])
    .map(clean)
    .filter(Boolean);
}

function uniqueValues(values) {
  return [...new Set(arrayValues(values))];
}

function partOfSpeechMatches(left, right) {
  const aliases = {
    n: "noun",
    noun: "noun",
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
    int: "interjection",
    interj: "interjection",
    interjection: "interjection"
  };
  const tokens = value => clean(value).toLowerCase()
    .split(/[\/;,\s]+/)
    .map(item => aliases[item.replace(/\.$/, "")] || item.replace(/\.$/, ""))
    .filter(Boolean);
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  return !leftTokens.length || !rightTokens.length || leftTokens.some(item => rightTokens.includes(item));
}

function parseBaiduDictionary(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch (_) {
    return null;
  }
}

function createBaiduError(code, message = "") {
  const normalizedCode = String(code ?? "");
  const description = BAIDU_ERROR_MESSAGES[normalizedCode] || "百度接口返回错误";
  const detail = clean(message);
  const error = new Error(`百度错误码 ${normalizedCode}：${description}${detail && detail !== description ? `（${detail}）` : ""}`);
  error.baiduCode = normalizedCode;
  return error;
}

function baiduRequestKey(config = {}) {
  return `${clean(config.apiKey)}\u0000${clean(config.secretKey)}`;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function scheduleBaiduRequest(config, task) {
  const key = baiduRequestKey(config);
  const state = baiduRequestState.get(key) || { nextAt: 0 };
  const now = Date.now();
  const startAt = Math.max(now, state.nextAt);
  state.nextAt = startAt + BAIDU_MIN_REQUEST_INTERVAL_MS;
  baiduRequestState.set(key, state);
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      Promise.resolve()
        .then(task)
        .then(resolve, reject);
    }, Math.max(0, startAt - now));
  });
}

async function requestBaiduTranslation(config, task) {
  try {
    return await scheduleBaiduRequest(config, task);
  } catch (error) {
    if (String(error?.baiduCode || error?.providerCode || "") !== "18") throw error;
    await delay(1200);
    return scheduleBaiduRequest(config, task);
  }
}

function normalizeBaiduDictionary(value, query, translationResult = {}) {
  const data = parseBaiduDictionary(value);
  if (!data || typeof data !== "object") return null;

  const simpleMeans = data.simple_means || {};
  const wordResult = data.word_result || {};
  const edict = wordResult.edict || {};
  const symbols = Array.isArray(simpleMeans.symbols) ? simpleMeans.symbols : [];
  const parts = symbols.flatMap(symbol => Array.isArray(symbol?.parts) ? symbol.parts : [])
    .map(part => ({
      partOfSpeech: clean(part?.part || part?.part_name),
      translations: uniqueValues(part?.means)
    }))
    .filter(part => part.partOfSpeech || part.translations.length);

  const phoneticValues = symbols.flatMap(symbol => [
    symbol?.ph_en ? `英 /${clean(symbol.ph_en)}/` : "",
    symbol?.ph_am ? `美 /${clean(symbol.ph_am)}/` : "",
    symbol?.ph_other ? clean(symbol.ph_other) : ""
  ]).filter(Boolean);
  const phonetic = [...new Set(phoneticValues)].join("  ");

  const items = Array.isArray(edict.item) ? edict.item : [];
  const senses = [];
  const attachedTranslations = new Set();
  for (const item of items) {
    const partOfSpeech = clean(item?.pos);
    const matchingParts = parts.filter(part => partOfSpeechMatches(partOfSpeech, part.partOfSpeech));
    const translations = uniqueValues(matchingParts.flatMap(part => part.translations));
    const groups = Array.isArray(item?.tr_group) ? item.tr_group : [];
    for (const group of groups) {
      const definitions = uniqueValues(group?.tr);
      const examples = uniqueValues(group?.example);
      const synonyms = uniqueValues(group?.similar_word);
      const rows = definitions.length ? definitions : [""];
      rows.forEach((definition, index) => {
        const useTranslations = translations.length && !attachedTranslations.has(partOfSpeech) && index === 0
          ? translations
          : [];
        if (useTranslations.length) attachedTranslations.add(partOfSpeech);
        if (definition || useTranslations.length || examples.length) {
          senses.push({
            partOfSpeech,
            definition,
            translations: useTranslations,
            examples: index === 0 ? examples : [],
            synonyms
          });
        }
      });
    }
    if (!groups.length && translations.length) {
      senses.push({ partOfSpeech, definition: "", translations });
      attachedTranslations.add(partOfSpeech);
    }
  }

  if (!senses.length && parts.length) {
    parts.forEach(part => senses.push({
      partOfSpeech: part.partOfSpeech,
      definition: "",
      translations: part.translations
    }));
  }
  if (!senses.length && Array.isArray(simpleMeans.word_means) && simpleMeans.word_means.length) {
    senses.push({
      partOfSpeech: "",
      definition: "",
      translations: uniqueValues(simpleMeans.word_means)
    });
  }
  if (!senses.length) return null;

  const exchange = simpleMeans.exchange || {};
  const formLabels = {
    word_third: "第三人称单数",
    word_ing: "现在分词",
    word_done: "过去分词",
    word_past: "过去式",
    word_pl: "复数",
    word_er: "比较级",
    word_est: "最高级"
  };
  const wordForms = Object.entries(formLabels)
    .map(([key, label]) => ({ label, values: uniqueValues(exchange[key]) }))
    .filter(item => item.values.length);
  const tags = uniqueValues([simpleMeans.tags?.core, simpleMeans.tags?.other]);
  const word = clean(simpleMeans.word_name || edict.word || query);
  const audioUrl = /^https:\/\//i.test(clean(translationResult.src_tts)) ? clean(translationResult.src_tts) : "";

  return {
    type: "online-dictionary",
    provider: "baidu-dictionary",
    name: "百度词典版",
    word,
    phonetic,
    audioUrl,
    wordForms,
    tags,
    senses,
    source: {
      id: "baidu-dictionary",
      name: "百度翻译·词典版",
      license: "百度翻译 API",
      url: BAIDU_DICTIONARY_DOC_URL
    },
    meta: {
      senseCount: senses.length,
      language: data.lang || ""
    }
  };
}

async function getBaiduAccessToken(config = {}) {
  const apiKey = clean(config.apiKey);
  const secretKey = clean(config.secretKey);
  if (!apiKey || !secretKey) throw new Error("百度 API Key / Secret Key 未填写");
  const cacheKey = `${apiKey}\u0000${secretKey}`;
  const cached = baiduTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const query = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: apiKey,
    client_secret: secretKey
  });
  const data = await fetchJson(`${BAIDU_TOKEN_URL}?${query.toString()}`, {
    method: "POST",
    headers: { Accept: "application/json" }
  });
  if (!data?.access_token) {
    throw new Error(`百度鉴权失败${data?.error_description ? `：${data.error_description}` : ""}`);
  }
  const expiresIn = Math.max(60, Number(data.expires_in) || 2_592_000);
  baiduTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + expiresIn * 1000
  });
  return data.access_token;
}

async function translateBaiduDictionary(text, config = {}) {
  const queryText = clean(text);
  const accessToken = await getBaiduAccessToken(config);
  const source = sourceForBaidu(config.source || (isBaiduDictionaryQuery(queryText) ? "en" : "auto"));
  const target = targetForBaidu(config.target || "zh-CN");
  const data = await requestBaiduTranslation(config, () => fetchJson(`${BAIDU_DICTIONARY_URL}?access_token=${encodeURIComponent(accessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ q: queryText, from: source, to: target })
  }, 20000).catch(error => {
    if (error?.providerCode) throw createBaiduError(error.providerCode, error.message);
    throw error;
  }));
  if (data?.error_code) {
    throw createBaiduError(data.error_code, data.error_msg);
  }
  const result = data?.result || {};
  const rows = Array.isArray(result.trans_result) ? result.trans_result : [];
  const translations = uniqueValues(rows.map(row => row?.dst));
  const rowWithDictionary = rows.find(row => row?.dict);
  const dictionaryEntry = rowWithDictionary
    ? normalizeBaiduDictionary(rowWithDictionary.dict, queryText, rowWithDictionary)
    : null;
  return {
    provider: "baidu",
    name: "百度翻译",
    detectedSource: clean(result.from || source),
    translations,
    dictionaryEntry,
    source: {
      id: "baidu-dictionary",
      name: "百度翻译·词典版",
      license: "百度翻译 API 条款",
      url: BAIDU_DICTIONARY_DOC_URL
    }
  };
}

async function translateBaiduMany(texts, config = {}) {
  const inputs = texts.map(clean).filter(Boolean);
  return mapWithConcurrency(inputs, 3, async text => {
    const result = await translateBaiduDictionary(text, config);
    return clean(result.translations.join(" "));
  });
}

async function translateGoogle(text, config = {}) {
  if (!config.apiKey || config.mode === "web") {
    return translateGoogleWeb(text, config);
  }
  const query = new URLSearchParams({ key: config.apiKey });
  const body = {
    q: String(text),
    target: config.target || "zh-CN",
    format: "text"
  };
  if (config.source && config.source !== "auto") body.source = config.source;
  const data = await fetchJson(`https://translation.googleapis.com/language/translate/v2?${query.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const translations = data?.data?.translations || [];
  return {
    provider: "google",
    name: "Google Cloud Translation",
    detectedSource: translations[0]?.detectedSourceLanguage || config.source || "",
    translations: translations.map(item => clean(item.translatedText)).filter(Boolean),
    source: {
      id: "google",
      name: "Google Cloud Translation",
      license: "Google Cloud API terms",
      url: "https://cloud.google.com/translate"
    }
  };
}

async function translateGoogleMany(texts, config = {}) {
  const inputs = texts.map(clean).filter(Boolean);
  if (!inputs.length) return [];
  if (!config.apiKey || config.mode === "web") {
    return mapWithConcurrency(inputs, 4, async text => {
      const result = await translateGoogleWeb(text, config);
      return clean(result.translations.join(" "));
    });
  }
  const query = new URLSearchParams({ key: config.apiKey });
  const body = {
    q: inputs,
    target: config.target || "zh-CN",
    format: "text"
  };
  if (config.source && config.source !== "auto") body.source = config.source;
  const data = await fetchJson(`https://translation.googleapis.com/language/translate/v2?${query.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, 20000);
  const translations = data?.data?.translations || [];
  if (translations.length !== inputs.length) {
    throw new Error(`批量释义翻译返回 ${translations.length}/${inputs.length} 条`);
  }
  return translations.map(item => clean(item.translatedText));
}

async function translateGoogleWeb(text, config = {}) {
  const query = new URLSearchParams({
    client: "gtx",
    sl: config.source && config.source !== "auto" ? config.source : "auto",
    tl: config.target || "zh-CN",
    dt: "t",
    q: String(text)
  });
  const data = await fetchJson(`https://translate.googleapis.com/translate_a/single?${query.toString()}`, {}, 20000);
  const translations = (Array.isArray(data?.[0]) ? data[0] : [])
    .map(item => clean(item?.[0]))
    .filter(Boolean);
  return {
    provider: "google",
    name: "Google 翻译",
    detectedSource: clean(data?.[2] || config.source || ""),
    translations: [...new Set(translations)],
    source: {
      id: "google-web",
      name: "Google 翻译",
      license: "Google 服务条款；兼容接口可能变更",
      url: "https://translate.google.com/"
    },
    mode: "web"
  };
}

async function translateSegments(texts, settings = {}) {
  const inputs = texts.map(clean).filter(Boolean);
  const translation = settings.translation || {};
  const source = "en";
  const target = translation.target || "zh-CN";
  const warnings = [];
  if (!inputs.length || /^en(?:-|$)/i.test(target)) {
    return { translations: [], provider: "", name: "", warnings };
  }

  if (translation.google?.enabled && (translation.google.apiKey || translation.google.mode === "web")) {
    try {
      return {
        translations: await translateGoogleMany(inputs, { ...translation.google, source, target }),
        provider: "google",
        name: translation.google.mode === "web" ? "Google 翻译" : "Google Cloud Translation",
        warnings
      };
    } catch (error) {
      warnings.push(`Google 释义翻译：${error.message}`);
    }
  }

  if (translation.baidu?.enabled && translation.baidu.apiKey && translation.baidu.secretKey) {
    try {
      return {
        translations: await translateBaiduMany(inputs, { ...translation.baidu, source, target }),
        provider: "baidu",
        name: "百度翻译",
        warnings
      };
    } catch (error) {
      warnings.push(`百度释义翻译：${error.message}`);
    }
  }

  return { translations: [], provider: "", name: "", warnings };
}

async function translateText(text, settings = {}) {
  const query = clean(text);
  const translation = settings.translation || {};
  const source = translation.source || "auto";
  const target = translation.target || "zh-CN";
  const warnings = [];
  const tasks = [];
  const youdaoWebEnabled = settings.dictionary?.youdaoDictionary?.enabled !== false;
  const queryLooksEnglish = /^[a-z][a-z\s'.,!?;:\-()\"%]{1,500}$/i.test(query);
  const queryLooksChinese = /[\u3400-\u9fff]/.test(query);
  const targetLooksEnglish = /^en(?:-|$)/i.test(target);
  const targetLooksChinese = /^zh(?:-|$)/i.test(target);
  const sameLanguage = (queryLooksEnglish && targetLooksEnglish) || (queryLooksChinese && targetLooksChinese);
  if (youdaoWebEnabled && !isEnglishDictionaryQuery(query) && !sameLanguage) {
    tasks.push(queryYoudaoTranslation(query, { source, target }).catch(error => {
      warnings.push(`网易有道网页翻译：${error.message}`);
      return null;
    }));
  }
  if (translation.baidu?.enabled && translation.baidu.apiKey && translation.baidu.secretKey) {
    tasks.push(translateBaiduDictionary(query, {
      ...translation.baidu,
      source: isBaiduDictionaryQuery(query) ? "en" : source,
      target
    }).catch(error => {
      warnings.push(`百度：${error.message}`);
      return null;
    }));
  }
  if (translation.google?.enabled && (translation.google.apiKey || translation.google.mode === "web")) {
    tasks.push(translateGoogle(query, { ...translation.google, source, target }).catch(error => {
      warnings.push(`Google：${error.message}`);
      return null;
    }));
  }
  return {
    type: "translation",
    query,
    source,
    target,
    results: (await Promise.all(tasks)).filter(Boolean),
    warnings
  };
}

module.exports = {
  createBaiduError,
  getBaiduAccessToken,
  isBaiduDictionaryQuery,
  normalizeBaiduDictionary,
  targetForBaidu,
  translateGoogle,
  translateGoogleMany,
  translateGoogleWeb,
  translateBaiduDictionary,
  translateBaiduMany,
  translateSegments,
  translateText
};
