const { isEnglishDictionaryQuery, queryFreeDictionary } = require("./dictionary-api");
const { translateSegments, translateText } = require("./translation");

function clean(value) {
  return String(value ?? "").trim();
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
  return providers;
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
    isEnglishDictionaryQuery(value)
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
  const dictionaryResults = baiduDictionary
    ? [baiduDictionary]
    : enrichedDictionary
      ? [enrichedDictionary]
      : [];
  const cloudResults = (cloud.results || []).filter(item => !item?.dictionaryEntry);
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
  lookupWord
};
