const { isEnglishDictionaryQuery, queryFreeDictionary, queryYoudaoDictionary } = require("./dictionary-api");
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

async function lookupWord(query, options = {}) {
  const value = clean(query);
  if (!value) throw new Error("请输入要查询的单词或文本");
  if (!options.dictionaryManager) throw new Error("本地词典服务尚未初始化");

  const settings = options.settings || {};
  const translate = options.translate || translateText;
  const lookupOnlineDictionary = options.queryDictionary || queryFreeDictionary;
  const lookupWebDictionary = options.queryYoudaoDictionary || queryYoudaoDictionary;
  const translateDefinitions = options.translateSegments || translateSegments;
  const local = await options.dictionaryManager.searchLocal(value);
  const exactResults = local.exactResults || [];
  const suggestions = local.suggestions || [];
  const providers = configuredCloudProviders(settings);

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
  const [youdaoDictionaryEntry, freeDictionaryEntry, cloud] = await Promise.all([
    isEnglishDictionaryQuery(value) && settings.dictionary?.youdaoDictionary?.enabled !== false
      ? lookupWebDictionary(value).catch(error => {
        dictionaryWarnings.push(`网易有道网页词典：${error.message}`);
        return null;
      })
      : Promise.resolve(null),
    isEnglishDictionaryQuery(value) && settings.dictionary?.freeDictionary?.enabled !== false
      ? lookupOnlineDictionary(value).catch(error => {
        dictionaryWarnings.push(`Free Dictionary：${error.message}`);
        return null;
      })
      : Promise.resolve(null),
    translate(value, settings)
  ]);

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
      ? await translateDefinitions(definitions, settings)
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

  const baiduDictionary = (cloud.results || []).find(item => item?.dictionaryEntry)?.dictionaryEntry || null;
  const dictionaryResults = sortByServiceOrder([
    ...(youdaoDictionaryEntry ? [youdaoDictionaryEntry] : []),
    ...(baiduDictionary ? [baiduDictionary] : []),
    ...(enrichedFreeDictionary ? [enrichedFreeDictionary] : [])
  ], settings);
  const cloudResults = sortByServiceOrder((cloud.results || []).filter(item => !item?.dictionaryEntry), settings);
  const displayResults = sortByServiceOrder([
    ...dictionaryResults.map(item => ({ ...item, displayType: "dictionary" })),
    ...cloudResults.map(item => ({ ...item, displayType: "cloud" }))
  ], settings);
  return {
    type: "word",
    query: value,
    strategy: dictionaryResults.length ? "online-dictionary" : "cloud",
    success: dictionaryResults.length > 0 || cloudResults.length > 0,
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
      ...(cloud.warnings || [])
    ],
    sources: local.sources || [],
    sourceLanguage: cloud.source || "auto",
    targetLanguage: cloud.target || "zh-CN"
  };
}

module.exports = {
  configuredCloudProviders,
  enrichDictionaryEntry,
  lookupWord,
  serviceIdForResult,
  sortByServiceOrder
};
