const { translateText } = require("./translation");

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
  return providers;
}

async function lookupWord(query, options = {}) {
  const value = clean(query);
  if (!value) throw new Error("请输入要查询的单词或文本");
  if (!options.dictionaryManager) throw new Error("本地词典服务尚未初始化");

  const settings = options.settings || {};
  const translate = options.translate || translateText;
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
      cloudResults: [],
      suggestions,
      providers,
      warnings: local.warnings || [],
      sources: local.sources || []
    };
  }

  const cloud = await translate(value, settings);
  const cloudResults = cloud.results || [];
  return {
    type: "word",
    query: value,
    strategy: "cloud",
    success: cloudResults.length > 0,
    localResults: [],
    cloudResults,
    suggestions,
    providers,
    warnings: [...(local.warnings || []), ...(cloud.warnings || [])],
    sources: local.sources || [],
    sourceLanguage: cloud.source || "auto",
    targetLanguage: cloud.target || "zh-CN"
  };
}

module.exports = {
  configuredCloudProviders,
  lookupWord
};
