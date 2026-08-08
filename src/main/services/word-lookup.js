const { isEnglishDictionaryQuery, isYoudaoDictionaryQuery, queryFreeDictionary, queryYoudaoDictionary } = require("./dictionary-api");
const { translateSegments, translateText } = require("./translation");

const DEFAULT_SERVICE_ORDER = ["youdaoDictionary", "freeDictionary", "baidu", "google"];

function clean(value) {
  return String(value ?? "").trim();
}

function serviceIdForResult(result) {
  const provider = clean(result?.provider).toLowerCase();
  if (provider === "youdao-dictionary" || provider === "youdao-web") return "youdaoDictionary";
  if (provider.includes("baidu")) return "baidu";
  if (provider === "free-dictionary") return "freeDictionary";
  if (provider.includes("google")) return "google";
  if (provider.includes("youdao")) return "youdaoDictionary";
  return provider;
}

function serviceOrder(settings = {}) {
  const configured = settings.dictionary?.serviceOrder;
  const requested = Array.isArray(configured) ? configured : [];
  const selected = [...new Set(requested
    .map(item => item === "youdao" ? "youdaoDictionary" : item)
    .filter(item => DEFAULT_SERVICE_ORDER.includes(item)))];
  const missing = DEFAULT_SERVICE_ORDER.filter(item => !selected.includes(item));
  const firstService = DEFAULT_SERVICE_ORDER[0];
  return [
    ...(missing.includes(firstService) ? [firstService] : []),
    ...selected,
    ...missing.filter(item => item !== firstService)
  ];
}

function sortByServiceOrder(results, settings = {}) {
  const rank = new Map(serviceOrder(settings).map((id, index) => [id, index]));
  return [...(results || [])].sort((left, right) => {
    const leftRank = rank.get(serviceIdForResult(left));
    const rightRank = rank.get(serviceIdForResult(right));
    return (leftRank ?? 999) - (rightRank ?? 999);
  });
}

function configuredCloudProviders(settings = {}) {
  const translation = settings.translation || {};
  const providers = [];
  if (settings.dictionary?.youdaoDictionary?.enabled !== false) {
    providers.push("youdao-web");
  }
  if (translation.google?.enabled && (translation.google.apiKey || translation.google.mode === "web")) {
    providers.push("google");
  }
  if (translation.baidu?.enabled && translation.baidu.apiKey && translation.baidu.secretKey) {
    providers.unshift("baidu");
  }
  return sortByServiceOrder(providers.map(provider => ({ provider })), settings).map(item => item.provider);
}

function enrichDictionaryEntry(entry, segmentResult = {}) {
  const translated = segmentResult.translations || [];
  return {
    ...entry,
    translationProvider: segmentResult.provider ? {
      id: segmentResult.provider,
      name: segmentResult.name
    } : null,
    senses: (entry.senses || []).map((sense, index) => ({
      ...sense,
      translations: translated[index]
        ? [translated[index]]
        : (sense.translations || [])
    }))
  };
}

function requestLanguagePair(value, settings = {}, options = {}) {
  const configured = settings.translation || {};
  const source = clean(options.source || options.sourceLanguage || configured.source || "auto") || "auto";
  let target = clean(options.target || options.targetLanguage || configured.target || "zh-CN") || "zh-CN";
  const looksChinese = /[\u3400-\u9fff]/.test(value);
  const looksEnglish = /^[a-z][a-z\s'.,!?;:\-()"%]{0,500}$/i.test(value);
  if (source === "auto" && looksChinese && /^zh(?:-|$)/i.test(target)) target = "en";
  if (source === "auto" && looksEnglish && /^en(?:-|$)/i.test(target)) target = "zh-CN";
  return { source, target };
}

function composeOnlineResult({
  value,
  settings,
  local,
  suggestions,
  providers,
  youdaoDictionaryEntry,
  freeDictionaryEntry,
  cloud,
  dictionaryWarnings = [],
  definitionWarnings = [],
  partial = false
}) {
  const cloudResponse = cloud || {
    source: settings.translation?.source || "auto",
    target: settings.translation?.target || "zh-CN",
    results: [],
    warnings: []
  };
  const baiduDictionary = (cloudResponse.results || []).find(item => item?.dictionaryEntry)?.dictionaryEntry || null;
  const dictionaryResults = sortByServiceOrder([
    ...(youdaoDictionaryEntry ? [youdaoDictionaryEntry] : []),
    ...(baiduDictionary ? [baiduDictionary] : []),
    ...(freeDictionaryEntry ? [freeDictionaryEntry] : [])
  ], settings);
  const cloudResults = sortByServiceOrder((cloudResponse.results || [])
    .filter(item => !item?.dictionaryEntry)
    .map(item => ({
      ...item,
      sourceLanguage: cloudResponse.source || settings.translation?.source || "auto",
      targetLanguage: cloudResponse.target || settings.translation?.target || "zh-CN"
    })), settings);
  const displayResults = sortByServiceOrder([
    ...dictionaryResults.map(item => ({ ...item, displayType: "dictionary" })),
    ...cloudResults.map(item => ({ ...item, displayType: "cloud" }))
  ], settings);
  return {
    type: "word",
    query: value,
    strategy: dictionaryResults.length ? "online-dictionary" : "cloud",
    success: dictionaryResults.length > 0 || cloudResults.length > 0,
    partial,
    localResults: [],
    dictionaryResults,
    cloudResults,
    displayResults,
    suggestions,
    providers,
    warnings: [
      ...(local.warnings || []),
      ...dictionaryWarnings,
      ...definitionWarnings,
      ...(cloudResponse.warnings || [])
    ],
    sources: local.sources || [],
    sourceLanguage: cloudResponse.source || settings.translation?.source || "auto",
    targetLanguage: cloudResponse.target || settings.translation?.target || "zh-CN"
  };
}

async function lookupWord(query, options = {}) {
  const value = clean(query);
  if (!value) throw new Error("请输入要查询的单词或文本");
  if (!options.dictionaryManager) throw new Error("本地词典服务尚未初始化");

  const settings = options.settings || {};
  const languagePair = requestLanguagePair(value, settings, options);
  const requestSettings = {
    ...settings,
    translation: {
      ...(settings.translation || {}),
      ...languagePair
    }
  };
  const translate = options.translate || translateText;
  const lookupOnlineDictionary = options.queryDictionary || queryFreeDictionary;
  const lookupWebDictionary = options.queryYoudaoDictionary || queryYoudaoDictionary;
  const translateDefinitions = options.translateSegments || translateSegments;
  const local = await options.dictionaryManager.searchLocal(value);
  const exactResults = local.exactResults || [];
  const suggestions = local.suggestions || [];
  const providers = configuredCloudProviders(requestSettings);

  if (exactResults.length) {
    return {
      type: "word",
      query: value,
      strategy: "local",
      success: true,
      localResults: exactResults,
      dictionaryResults: [],
      cloudResults: [],
      suggestions,
      providers,
      warnings: local.warnings || [],
      sources: local.sources || []
    };
  }

  const dictionaryWarnings = [];
  const youdaoPromise = isYoudaoDictionaryQuery(value, languagePair) && settings.dictionary?.youdaoDictionary?.enabled !== false
      ? lookupWebDictionary(value, languagePair).catch(error => {
        dictionaryWarnings.push(`网易有道网页词典：${error.message}`);
        return null;
      })
      : Promise.resolve(null);
  const freeDictionaryPromise = isEnglishDictionaryQuery(value) && settings.dictionary?.freeDictionary?.enabled !== false
      ? lookupOnlineDictionary(value).catch(error => {
        dictionaryWarnings.push(`Free Dictionary：${error.message}`);
        return null;
      })
      : Promise.resolve(null);
  const cloudPromise = Promise.resolve()
    .then(() => translate(value, requestSettings))
    .catch(error => ({
      source: languagePair.source,
      target: languagePair.target,
      results: [],
      warnings: [`在线翻译：${error.message}`]
    }));

  const youdaoDictionaryEntry = await youdaoPromise;
  if (youdaoDictionaryEntry && typeof options.onPartial === "function") {
    try {
      options.onPartial(composeOnlineResult({
        value,
        settings: requestSettings,
        local,
        suggestions,
        providers,
        youdaoDictionaryEntry,
        freeDictionaryEntry: null,
        cloud: null,
        dictionaryWarnings,
        partial: true
      }));
    } catch (_) {}
  }

  const [freeDictionaryEntry, cloud] = await Promise.all([freeDictionaryPromise, cloudPromise]);

  let enrichedFreeDictionary = freeDictionaryEntry;
  let definitionWarnings = [];
  if (freeDictionaryEntry?.senses?.length) {
    const definitionIndexes = [];
    const definitions = [];
    freeDictionaryEntry.senses.forEach((sense, index) => {
      if (!sense.definition) return;
      definitionIndexes.push(index);
      definitions.push(sense.definition);
    });
    const segmentResult = definitions.length
      ? await translateDefinitions(definitions, requestSettings)
      : { translations: [], warnings: [] };
    const alignedTranslations = Array.from({ length: freeDictionaryEntry.senses.length }, () => "");
    definitionIndexes.forEach((senseIndex, translationIndex) => {
      alignedTranslations[senseIndex] = segmentResult.translations?.[translationIndex] || "";
    });
    enrichedFreeDictionary = definitions.length
      ? enrichDictionaryEntry(freeDictionaryEntry, { ...segmentResult, translations: alignedTranslations })
      : freeDictionaryEntry;
    definitionWarnings = segmentResult.warnings || [];
  }

  return composeOnlineResult({
    value,
    settings: requestSettings,
    local,
    suggestions,
    providers,
    youdaoDictionaryEntry,
    freeDictionaryEntry: enrichedFreeDictionary,
    cloud,
    dictionaryWarnings,
    definitionWarnings
  });
}

module.exports = {
  configuredCloudProviders,
  composeOnlineResult,
  enrichDictionaryEntry,
  lookupWord,
  requestLanguagePair,
  serviceIdForResult,
  sortByServiceOrder
};
