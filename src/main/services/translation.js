const crypto = require("node:crypto");
const { fetchJson } = require("./dictionary-api");

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

async function translateYoudaoMany(texts, config = {}) {
  const inputs = texts.map(clean).filter(Boolean);
  return mapWithConcurrency(inputs, 3, async text => {
    const result = await translateYoudao(text, config);
    return clean(result.translations[0]);
  });
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

  if (translation.youdao?.enabled && translation.youdao.appKey && translation.youdao.appSecret) {
    try {
      return {
        translations: await translateYoudaoMany(inputs, { ...translation.youdao, source, target }),
        provider: "youdao",
        name: "有道智云翻译",
        warnings
      };
    } catch (error) {
      warnings.push(`有道释义翻译：${error.message}`);
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
  if (translation.google?.enabled && (translation.google.apiKey || translation.google.mode === "web")) {
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
  translateGoogleMany,
  translateGoogleWeb,
  translateSegments,
  translateText,
  translateYoudao,
  translateYoudaoMany
};
