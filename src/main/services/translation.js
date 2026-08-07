const crypto = require("node:crypto");
const { fetchJson } = require("./dictionary-api");

function clean(value) {
  return String(value ?? "").trim();
}

function targetForYoudao(value) {
  const normalized = clean(value).toLowerCase();
  return normalized === "zh-cn" || normalized === "zh" ? "zh-CHS" : normalized === "en-us" ? "en" : normalized;
}

function inputForYoudao(value) {
  const input = String(value || "");
  if (input.length <= 20) return input;
  return `${input.slice(0, 10)}${input.length}${input.slice(-10)}`;
}

function buildYoudaoPayload(text, config = {}, options = {}) {
  const now = typeof options === "number" ? options : options.now || Date.now();
  const salt = typeof options === "number" ? String(options) : (options.salt || crypto.randomUUID());
  const curtime = String(Math.floor(now / 1000));
  const q = String(text || "");
  const from = clean(config.source || "auto");
  const to = targetForYoudao(config.target || "zh-CN");
  const sign = crypto.createHash("sha256")
    .update(`${config.appKey}${inputForYoudao(q)}${salt}${curtime}${config.appSecret}`)
    .digest("hex");
  return {
    q,
    from,
    to,
    appKey: config.appKey,
    salt,
    sign,
    signType: "v3",
    curtime
  };
}

async function translateGoogle(text, config = {}) {
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

async function translateYoudao(text, config = {}) {
  const payload = buildYoudaoPayload(text, config);
  const body = new URLSearchParams(payload);
  const data = await fetchJson("https://openapi.youdao.com/api", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (data?.errorCode && data.errorCode !== "0") {
    throw new Error(`有道错误码 ${data.errorCode}`);
  }
  return {
    provider: "youdao",
    name: "有道智云翻译",
    detectedSource: data?.l?.split("2")[0] || "",
    translations: [
      ...(Array.isArray(data?.translation) ? data.translation : []),
      ...(Array.isArray(data?.basic?.explains) ? data.basic.explains : [])
    ].map(clean).filter(Boolean),
    source: {
      id: "youdao",
      name: "有道智云翻译",
      license: "有道智云 API 条款",
      url: "https://ai.youdao.com/product-fanyi.s"
    }
  };
}

async function translateText(text, settings = {}) {
  const query = clean(text);
  const translation = settings.translation || {};
  const source = translation.source || "auto";
  const target = translation.target || "zh-CN";
  const warnings = [];
  const tasks = [];
  if (translation.google?.enabled && translation.google.apiKey) {
    tasks.push(translateGoogle(query, { ...translation.google, source, target }).catch(error => {
      warnings.push(`Google：${error.message}`);
      return null;
    }));
  }
  if (translation.youdao?.enabled && translation.youdao.appKey && translation.youdao.appSecret) {
    tasks.push(translateYoudao(query, { ...translation.youdao, source, target }).catch(error => {
      warnings.push(`有道：${error.message}`);
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
  buildYoudaoPayload,
  inputForYoudao,
  translateGoogle,
  translateText,
  translateYoudao
};
