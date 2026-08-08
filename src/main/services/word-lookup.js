const { isEnglishDictionaryQuery, queryFreeDictionary } = require("./dictionary-api");
const { translateSegments, translateText } = require("./translation");

const DEFAULT_SERVICE_ORDER = ["baidu", "freeDictionary", "google", "youdao"];

function clean(value) {
  return String(value ?? "").trim();
}

function serviceIdForResult(result) {
  const provider = clean(result?.provider).toLowerCase();
  if (provider.includes("baidu")) return "baidu";
  if (provider === "free-dictionary") return "freeDictionary";
  if (provider.includes("google")) return "google";
  if (provider.includes("youdao")) return "youdao";
  return provider;
}

function serviceOrder(settings = {}) {
  const configured = settings.dictionary?.serviceOrder;
  const requested = Array.isArray(configured) ? configured : [];
  return [...new Set(requested.filter(item => DEFAULT_SERVICE_ORDER.includes(item))), ...DEFAULT_SERVICE_ORDER.filter(item => !requested.includes(item))];
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
  if (translation.google?.enabled && (translation.google.apiKey || translation.google.mode === "web")) {
    providers.push("google");
  }
  if (translation.youdao?.enabled && translation.youdao.appKey && translation.youdao.appSecret) {
    providers.push("youdao");
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

  let dictionaryWarning = "";
  const [dictionaryEntry, cloud] = await Promise.all([
    isEnglishDictionaryQuery(value) && settings.dictionary?.freeDictionary?.enabled !== false
      ? lookupOnlineDictionary(value).catch(error => {
        dictionaryWarning = `在线词典：${error.message}`;
        return null;
      })
      : Promise.resolve(null),
    translate(value, settings)
  ]);

  let enrichedDictionary = dictionaryEntry;
  let definitionWarnings = [];
  if (dictionaryEntry?.senses?.length) {
    const segmentResult = await translateDefinitions(dictionaryEntry.senses.map(sense => sense.definition), settings);
    enrichedDictionary = enrichDictionaryEntry(dictionaryEntry, segmentResult);
    definitionWarnings = segmentResult.warnings || [];
  }

  const baiduDictionary = (cloud.results || []).find(item => item?.dictionaryEntry)?.dictionaryEntry || null;
  const dictionaryResults = sortByServiceOrder([
    ...(baiduDictionary ? [baiduDictionary] : []),
    ...(enrichedDictionary ? [enrichedDictionary] : [])
  ], settings);
  const cloudResults = sortByServiceOrder((cloud.results || []).filter(item => !item?.dictionaryEntry), settings);
  return {
    type: "word",
    query: value,
    strategy: dictionaryResults.length ? "online-dictionary" : "cloud",
    success: dictionaryResults.length > 0 || cloudResults.length > 0,
    localResults: [],
    dictionaryResults,
    cloudResults,
    suggestions,
    providers,
    warnings: [
      ...(local.warnings || []),
      ...(dictionaryWarning ? [dictionaryWarning] : []),
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
