(function () {
  "use strict";

  const api = window.medict;
  const state = {
    mode: "dictionary",
    settings: null,
    sources: [],
    history: loadHistory(),
    requestId: 0
  };

  const MODES = {
    dictionary: {
      title: "词典查询",
      kicker: "LOCAL DICTIONARY",
      placeholder: "输入英文单词或短语，例如 serendipity",
      hint: "优先检索本地词典；配置授权 API 后可并行查询在线词典。"
    },
    translation: {
      title: "在线翻译",
      kicker: "ONLINE TRANSLATION",
      placeholder: "输入单词、短语或句子，例如 immune checkpoint inhibitor",
      hint: "Google 和有道可并行返回结果；请先在服务与设置中配置 API 凭据。"
    },
    drug: {
      title: "药物查询",
      kicker: "DRUG INFORMATION",
      placeholder: "输入药物通用名、商品名、ChEMBL ID 或研究编号",
      hint: "查询 RxNorm、ChEMBL、PubChem、FDA 和 ClinicalTrials.gov 等公开来源。"
    }
  };

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const clean = value => String(value ?? "").trim();

  function loadHistory() {
    try {
      const value = JSON.parse(localStorage.getItem("medict.search.history") || "[]");
      return Array.isArray(value) ? value.filter(Boolean).slice(0, 12) : [];
    } catch (_) {
      return [];
    }
  }

  function saveHistory(query) {
    const value = clean(query);
    if (!value) return;
    state.history = [value, ...state.history.filter(item => item.toLowerCase() !== value.toLowerCase())].slice(0, 12);
    localStorage.setItem("medict.search.history", JSON.stringify(state.history));
    renderHistory();
  }

  function renderHistory() {
    const root = $("#history-list");
    if (!state.history.length) {
      root.innerHTML = '<div class="history-empty">暂无查询记录</div>';
      return;
    }
    root.innerHTML = state.history.map(query => `<button class="history-item" type="button" data-history-query="${esc(query)}" title="${esc(query)}">${esc(query)}</button>`).join("");
  }

  function setStatus(message, kind = "") {
    const element = $("#status-line");
    element.className = `status-line ${kind}`.trim();
    element.textContent = message || "";
  }

  function setMode(mode) {
    state.mode = mode;
    const config = MODES[mode];
    $$(".mode-button").forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
    $("#mode-kicker").textContent = config.kicker;
    $("#mode-title").textContent = config.title;
    $("#query-input").placeholder = config.placeholder;
    $("#mode-hint").textContent = config.hint;
    $("#query-input").value = "";
    $("#results").innerHTML = `<div class="welcome-card"><div class="welcome-orbit">${mode === "drug" ? "Rx" : mode === "translation" ? "⇄" : "M"}</div><div><h2>${mode === "drug" ? "公开药物信息" : mode === "translation" ? "多服务翻译" : "离线优先的词典"}</h2><p>${esc(config.hint)}</p><div class="welcome-pills"><span>${mode === "drug" ? "多数据库" : mode === "translation" ? "并行返回" : "本地可用"}</span><span>可配置</span><span>可追溯</span></div></div></div>`;
    setStatus("");
    updateConnectionBadge();
  }

  function updateConnectionBadge() {
    const hasDictionaryApi = Boolean(state.settings?.dictionary?.oxford?.enabled || state.settings?.dictionary?.merriamWebster?.enabled);
    const hasTranslationApi = Boolean(state.settings?.translation?.google?.enabled || state.settings?.translation?.youdao?.enabled);
    const online = state.mode === "dictionary" ? hasDictionaryApi : state.mode === "translation" ? hasTranslationApi : true;
    const badge = $("#connection-badge");
    badge.textContent = online ? "在线服务已配置" : state.mode === "drug" ? "公开数据源" : "离线词典可用";
    badge.classList.toggle("online", online && state.mode !== "drug");
  }

  function renderSources() {
    $("#local-source-count").textContent = `${state.sources.length} 个词典源`;
    const root = $("#dictionary-sources");
    if (!state.sources.length) {
      root.innerHTML = '<div class="dictionary-source-meta">暂无可用词典源</div>';
      return;
    }
    root.innerHTML = state.sources.map(source => `<div class="dictionary-source"><div><div class="dictionary-source-name">${esc(source.name)}</div><div class="dictionary-source-meta">${esc(source.license || "未声明授权")}</div></div><div class="dictionary-source-count">${Number(source.entryCount || 0).toLocaleString()} 条</div></div>`).join("");
  }

  function showLoading(label) {
    $("#results").innerHTML = `<div class="loading-card"><span class="spinner"></span><span>${esc(label)}</span></div>`;
    setStatus("");
    $("#search-button").disabled = true;
  }

  function finishLoading() {
    $("#search-button").disabled = false;
  }

  async function search() {
    const query = clean($("#query-input").value);
    if (!query) {
      $("#query-input").focus();
      setStatus("请输入查询内容", "error");
      return;
    }
    const requestId = ++state.requestId;
    saveHistory(query);
    showLoading(state.mode === "drug" ? "正在并行查询药物数据库…" : state.mode === "translation" ? "正在请求翻译服务…" : "正在检索本地和在线词典…");
    try {
      const data = state.mode === "drug"
        ? await api.searchDrug(query)
        : state.mode === "translation"
          ? await api.translate(query)
          : await api.searchDictionary(query);
      if (requestId !== state.requestId) return;
      finishLoading();
      if (state.mode === "drug") renderDrug(data);
      else if (state.mode === "translation") renderTranslation(data);
      else renderDictionary(data);
    } catch (error) {
      if (requestId !== state.requestId) return;
      finishLoading();
      $("#results").innerHTML = `<div class="notice-card warning"><strong>查询失败</strong><p>${esc(error.message || error)}</p></div>`;
      setStatus("查询失败", "error");
    }
  }

  function warningHtml(warnings) {
    if (!warnings?.length) return "";
    return `<div class="notice-card warning"><strong>部分数据源未返回</strong><ul class="warning-list">${warnings.slice(0, 12).map(item => `<li>${esc(item)}</li>`).join("")}</ul></div>`;
  }

  function sourceFooter(source) {
    if (!source) return "";
    const url = source.url || "";
    return `<div class="result-card-footer"><span>来源：${esc(source.name || source.id || "未知")}</span><span>授权：${esc(source.license || "请查看原始条款")}</span>${url ? `<a href="${esc(url)}" data-external-url="${esc(url)}">打开来源 ↗</a>` : ""}</div>`;
  }

  function normalizedGroups(entry) {
    if (Array.isArray(entry.entries)) return entry.entries;
    const groups = {};
    for (const sense of entry.senses || []) {
      const key = sense.partOfSpeech || "释义";
      groups[key] ||= { partOfSpeech: key, definitions: [] };
      groups[key].definitions.push({
        definition: sense.definition,
        translations: sense.translations || [],
        examples: sense.examples || [],
        synonyms: sense.synonyms || []
      });
    }
    return Object.values(groups);
  }

  function renderDefinitions(entry) {
    const groups = normalizedGroups(entry);
    return groups.map(group => `<div class="entry-group">${group.partOfSpeech ? `<div class="pos-label">${esc(group.partOfSpeech)}</div>` : ""}${(group.definitions || []).map((definition, index) => `<div class="definition-row"><span class="definition-number">${index + 1}.</span><div><div class="definition">${esc(definition.definition || "暂无释义")}</div>${definition.translations?.length ? `<div class="translations">${definition.translations.map(value => `<span class="translation-chip">${esc(value)}</span>`).join("")}</div>` : ""}${definition.examples?.length ? `<div class="examples">${definition.examples.map(value => esc(value)).join("<br>")}</div>` : ""}${definition.synonyms?.length ? `<div class="synonyms">同义词：${definition.synonyms.map(esc).join(", ")}</div>` : ""}</div></div>`).join("")}</div>`).join("");
  }

  function renderDictionary(data) {
    const results = data?.results || [];
    const content = [];
    if (data?.warnings?.length) content.push(warningHtml(data.warnings));
    if (!results.length) {
      const q = encodeURIComponent(data?.query || $("#query-input").value.trim());
      content.push(`<div class="notice-card"><strong>没有找到本地或已配置的在线词典结果</strong><p>可以导入 JSON/CSV/TXT 词典，或在设置中配置 Oxford / Merriam-Webster。也可以打开在线词典页面继续查询。</p><div class="suggestions"><button type="button" data-external-url="https://www.ldoceonline.com/dictionary/${q}">Longman</button><button type="button" data-external-url="https://www.oxfordlearnersdictionaries.com/definition/english/${q}">Oxford Learner's</button><button type="button" data-external-url="https://www.merriam-webster.com/dictionary/${q}">Merriam-Webster</button></div></div>`);
    } else {
      content.push(`<div class="result-toolbar"><h2>查询结果</h2><span class="result-count">${results.length} 个结果</span></div>`);
      for (const entry of results) {
        if (entry.type === "suggestions") {
          content.push(`<div class="notice-card"><strong>${esc(entry.word)} 的近似结果</strong><div class="suggestions">${(entry.suggestions || []).map(item => `<button type="button" data-query-value="${esc(item)}">${esc(item)}</button>`).join("")}</div>${sourceFooter(entry.source)}</div>`);
          continue;
        }
        const isOnline = entry.type === "online";
        content.push(`<article class="result-card"><div class="result-card-header"><div><div class="word-line"><h3>${esc(entry.word)}</h3>${entry.phonetic ? `<span class="phonetic">${esc(entry.phonetic)}</span>` : ""}${entry.audioUrl ? `<button class="audio-button" type="button" data-audio-url="${esc(entry.audioUrl)}">播放发音</button>` : ""}</div></div><span class="provider-label ${isOnline ? "online" : ""}">${esc(isOnline ? entry.source?.name || "在线词典" : entry.source?.name || "本地词典")}</span></div>${renderDefinitions(entry)}${sourceFooter(entry.source)}</article>`);
      }
    }
    $("#results").innerHTML = content.join("");
    setStatus(results.length ? `已完成：${results.length} 个词典结果` : "未找到匹配结果");
  }

  function renderTranslation(data) {
    const content = [warningHtml(data?.warnings)];
    if (!data?.results?.length) {
      content.push('<div class="notice-card"><strong>尚未配置翻译服务</strong><p>请打开“服务与设置”，填写 Google Cloud Translation API Key 或有道智云 App Key / App Secret，并启用对应服务。</p></div>');
    } else {
      content.push(`<div class="result-toolbar"><h2>${esc(data.query)}</h2><span class="result-count">${esc(data.source || "auto")} → ${esc(data.target || "zh-CN")}</span></div>`);
      content.push(...data.results.map(result => `<article class="translation-card"><div class="translation-card-header"><span class="translation-provider">${esc(result.name || result.provider)}</span><span class="provider-label online">在线服务</span></div><div class="translation-value">${(result.translations || []).length ? result.translations.map(esc).join("<br>") : "服务没有返回译文"}</div>${result.detectedSource ? `<div class="translation-meta">检测到源语言：${esc(result.detectedSource)}</div>` : ""}${sourceFooter(result.source)}</article>`));
    }
    $("#results").innerHTML = content.filter(Boolean).join("");
    setStatus(data?.results?.length ? `已完成：${data.results.length} 个翻译服务返回结果` : "没有可显示的翻译结果");
  }

  function valueOrDash(value) {
    if (Array.isArray(value)) return value.filter(Boolean).join("；") || "—";
    return clean(value) || "—";
  }

  function identifier(label, value, url) {
    if (!value) return "";
    return url ? `<a class="identifier" href="${esc(url)}" data-external-url="${esc(url)}">${esc(label)}：${esc(value)}</a>` : `<span class="identifier">${esc(label)}：${esc(value)}</span>`;
  }

  function renderDrug(data) {
    if (!data?.success) {
      $("#results").innerHTML = `${warningHtml(data?.warnings)}<div class="notice-card"><strong>没有找到药物记录</strong><p>可以尝试通用名、商品名、ChEMBL ID 或更准确的英文拼写。</p></div>`;
      setStatus("没有找到匹配药物");
      return;
    }
    const ids = data.identifiers || {};
    const names = data.names || {};
    const classes = data.classes || {};
    const structure = data.structure || {};
    const mechanisms = data.mechanisms || [];
    const indications = data.indications || [];
    const trials = data.trials || [];
    const approvals = data.approvals || [];
    const sourceLinks = Object.entries(data.sources || {}).filter(([, url]) => url).map(([name, url]) => `<a class="drug-link" href="${esc(url)}" data-external-url="${esc(url)}">${esc(name)} ↗</a>`).join("");
    const mechanismsHtml = mechanisms.length ? `<table class="drug-table"><thead><tr><th>靶点</th><th>作用类型</th><th>机制</th><th>蛋白 / 基因</th></tr></thead><tbody>${mechanisms.slice(0, 30).map(row => `<tr><td>${row.targetUrl ? `<a class="drug-link" href="${esc(row.targetUrl)}" data-external-url="${esc(row.targetUrl)}">${esc(row.target || "—")}</a>` : esc(row.target || "—")}</td><td>${esc(row.action || "—")}</td><td>${esc(row.mechanism || "—")}</td><td>${esc([row.targetShortName, row.targetGene, row.targetAccession].filter(Boolean).join(" · ") || "—")}</td></tr>`).join("")}</tbody></table>` : '<div class="notice-card">暂无 ChEMBL 机制记录。</div>';
    const trialsHtml = trials.length ? `<table class="drug-table"><thead><tr><th>NCT</th><th>研究</th><th>状态 / 分期</th><th>日期</th></tr></thead><tbody>${trials.slice(0, 20).map(row => `<tr><td><a class="drug-link" href="${esc(row.url)}" data-external-url="${esc(row.url)}">${esc(row.id)}</a></td><td>${esc(row.title || "—")}</td><td>${esc([row.status, ...(row.phases || [])].filter(Boolean).join(" · ") || "—")}</td><td>${esc([row.startDate, row.completionDate].filter(Boolean).join(" → ") || "—")}</td></tr>`).join("")}</tbody></table>` : '<div class="notice-card">暂无 ClinicalTrials.gov 结果。</div>';
    const approvalHtml = approvals.length ? `<div class="drug-list">${approvals.slice(0, 15).map(row => `<div class="drug-list-item"><strong>${esc([...(row.brandNames || []), ...(row.genericNames || [])].join("；") || "FDA 记录")}</strong><br>申请号：${esc(row.applicationNumber || "—")}　赞助方：${esc(row.sponsor || "—")}　首个批准日期：${esc(row.firstApprovalDate || "—")}</div>`).join("")}</div>` : '<div class="notice-card">暂无 FDA 记录。</div>';
    const classesHtml = ["atc", "epc", "moa", "pe"].flatMap(key => (classes[key] || []).map(value => typeof value === "object" ? `${key.toUpperCase()} ${value.code || ""}: ${value.name || ""}` : `${key.toUpperCase()}: ${value}`));
    $("#results").innerHTML = `${warningHtml(data.warnings)}<article class="drug-card"><div class="drug-header"><div><h2>${esc(data.name)}</h2><div class="drug-query">查询词：${esc(data.query)}${data.format?.description ? `　·　${esc(data.format.description)}` : ""}</div></div><div class="identifier-list">${identifier("RxCUI", ids.rxcui, data.sources?.rxnorm)}${identifier("ChEMBL", ids.chembl, data.sources?.chembl)}${identifier("PubChem", ids.pubchemCid, data.sources?.pubchem)}</div></div><div class="drug-body"><section class="drug-section"><h3>名称与结构</h3><div class="data-grid"><div class="data-cell"><div class="data-label">通用名</div><div class="data-value">${esc(valueOrDash(names.generic))}</div></div><div class="data-cell"><div class="data-label">商品名</div><div class="data-value">${esc(valueOrDash(names.brands))}</div></div><div class="data-cell"><div class="data-label">别名</div><div class="data-value">${esc(valueOrDash(names.aliases))}</div></div><div class="data-cell"><div class="data-label">分子式</div><div class="data-value">${esc(valueOrDash(structure.formula))}</div></div><div class="data-cell"><div class="data-label">分子量</div><div class="data-value">${esc(valueOrDash(structure.molecularWeight))}</div></div><div class="data-cell"><div class="data-label">最高开发阶段</div><div class="data-value">${esc(valueOrDash(data.development?.maxPhase))}</div></div></div></section><section class="drug-section"><h3>RxClass 分类</h3>${classesHtml.length ? `<div class="tag-row">${classesHtml.slice(0, 40).map(value => `<span class="tag">${esc(value)}</span>`).join("")}</div>` : '<div class="notice-card">暂无分类数据。</div>'}</section><section class="drug-section"><h3>靶点与作用机制</h3>${mechanismsHtml}</section><section class="drug-section"><h3>适应症与 FDA 批准</h3>${indications.length ? `<div class="drug-list">${indications.slice(0, 20).map(row => `<div class="drug-list-item">${esc(row.name || "—")}　<span class="tag">最高阶段 ${esc(row.maxPhase ?? "—")}</span></div>`).join("")}</div>` : ""}${approvalHtml}</section><section class="drug-section"><h3>临床试验</h3>${trialsHtml}</section><div class="drug-footer"><span>公开来源：</span>${sourceLinks}</div></div></article>`;
    setStatus(`已完成：${data.name} · ${trials.length} 项试验 · ${mechanisms.length} 条机制记录`);
  }

  function setField(id, value) { const element = $(`#${id}`); if (element) element.value = value ?? ""; }
  function setChecked(id, value) { const element = $(`#${id}`); if (element) element.checked = Boolean(value); }
  function fillSettings() {
    const settings = state.settings || {};
    const dictionary = settings.dictionary || {};
    const translation = settings.translation || {};
    setChecked("oxford-enabled", dictionary.oxford?.enabled);
    setField("oxford-app-id", dictionary.oxford?.appId);
    setField("oxford-app-key", dictionary.oxford?.appKey);
    setField("oxford-locale", dictionary.oxford?.locale || "en-gb");
    setChecked("merriam-enabled", dictionary.merriamWebster?.enabled);
    setField("merriam-api-key", dictionary.merriamWebster?.apiKey);
    setChecked("google-enabled", translation.google?.enabled);
    setField("google-api-key", translation.google?.apiKey);
    setChecked("youdao-enabled", translation.youdao?.enabled);
    setField("youdao-app-key", translation.youdao?.appKey);
    setField("youdao-app-secret", translation.youdao?.appSecret);
    setField("translation-source", translation.source || "auto");
    setField("translation-target", translation.target || "zh-CN");
    renderSources();
  }

  function readSettings() {
    const current = JSON.parse(JSON.stringify(state.settings || {}));
    current.dictionary ||= {};
    current.dictionary.oxford = {
      ...(current.dictionary.oxford || {}),
      enabled: $("#oxford-enabled").checked,
      appId: $("#oxford-app-id").value.trim(),
      appKey: $("#oxford-app-key").value.trim(),
      locale: $("#oxford-locale").value.trim() || "en-gb"
    };
    current.dictionary.merriamWebster = {
      ...(current.dictionary.merriamWebster || {}),
      enabled: $("#merriam-enabled").checked,
      apiKey: $("#merriam-api-key").value.trim()
    };
    current.translation ||= {};
    current.translation.source = $("#translation-source").value.trim() || "auto";
    current.translation.target = $("#translation-target").value.trim() || "zh-CN";
    current.translation.google = {
      ...(current.translation.google || {}),
      enabled: $("#google-enabled").checked,
      apiKey: $("#google-api-key").value.trim()
    };
    current.translation.youdao = {
      ...(current.translation.youdao || {}),
      enabled: $("#youdao-enabled").checked,
      appKey: $("#youdao-app-key").value.trim(),
      appSecret: $("#youdao-app-secret").value.trim()
    };
    return current;
  }

  async function importDictionary() {
    $("#settings-status").textContent = "正在导入…";
    try {
      const result = await api.importDictionary();
      if (!result.canceled) {
        state.sources = result.sources || [];
        renderSources();
        setStatus("词典已导入");
      }
      $("#settings-status").textContent = result.canceled ? "" : "导入成功";
    } catch (error) {
      $("#settings-status").textContent = error.message || "导入失败";
    }
  }

  function bindEvents() {
    $$(".mode-button").forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));
    $("#search-form").addEventListener("submit", event => { event.preventDefault(); search(); });
    $("#clear-button").addEventListener("click", () => { $("#query-input").value = ""; $("#results").innerHTML = '<div class="welcome-card"><div class="welcome-orbit">M</div><div><h2>准备开始查询</h2><p>输入查询内容，Medict 会根据当前模式调用对应的数据源。</p></div></div>'; setStatus(""); $("#query-input").focus(); });
    $("#settings-button").addEventListener("click", () => { fillSettings(); $("#settings-dialog").showModal(); });
    $("#close-settings-button").addEventListener("click", () => $("#settings-dialog").close());
    $("#cancel-settings-button").addEventListener("click", () => $("#settings-dialog").close());
    $("#settings-form").addEventListener("submit", async event => {
      event.preventDefault();
      try {
        state.settings = await api.saveSettings(readSettings());
        updateConnectionBadge();
        $("#settings-status").textContent = "已保存";
        setTimeout(() => $("#settings-dialog").close(), 350);
      } catch (error) {
        $("#settings-status").textContent = error.message || "保存失败";
      }
    });
    $("#import-dictionary-button").addEventListener("click", importDictionary);
    $("#settings-import-button").addEventListener("click", importDictionary);
    $("#query-input").addEventListener("keydown", event => {
      if (event.key === "Escape") { event.target.value = ""; setStatus(""); }
    });
    document.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#query-input").focus(); }
    });
    document.addEventListener("click", event => {
      const history = event.target.closest("[data-history-query]");
      if (history) { $("#query-input").value = history.dataset.historyQuery; search(); return; }
      const quick = event.target.closest("[data-quick-query]");
      if (quick) { $("#query-input").value = quick.dataset.quickQuery; search(); return; }
      const suggestion = event.target.closest("[data-query-value]");
      if (suggestion) { $("#query-input").value = suggestion.dataset.queryValue; search(); return; }
      const external = event.target.closest("[data-external-url]");
      if (external) { event.preventDefault(); api.openExternal(external.dataset.externalUrl); return; }
      const audio = event.target.closest("[data-audio-url]");
      if (audio) { event.preventDefault(); new Audio(audio.dataset.audioUrl).play().catch(() => setStatus("音频无法播放", "error")); }
    });
  }

  async function init() {
    if (!api) {
      $("#results").innerHTML = '<div class="notice-card warning"><strong>桌面桥接不可用</strong><p>请从 Electron 应用启动 Medict，而不是直接打开 HTML 文件。</p></div>';
      return;
    }
    try {
      state.settings = await api.getSettings();
      state.sources = await api.listDictionaries();
    } catch (error) {
      setStatus(`初始化失败：${error.message}`, "error");
    }
    renderHistory();
    renderSources();
    bindEvents();
    setMode("dictionary");
    $("#query-input").focus();
  }

  init();
})();
