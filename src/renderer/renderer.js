(function () {
  "use strict";

  const api = window.medict;
  const state = {
    settings: null,
    sources: [],
    requestId: 0,
    activeSelectionRequestId: null,
    selectionStatus: { available: false, active: false, message: "正在启动自动划词" },
    pinned: false
  };

  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
  const clean = value => String(value ?? "").trim();
  const values = value => (Array.isArray(value) ? value : value == null || value === "" ? [] : [value]).filter(item => item != null && item !== "");
  const valueOrDash = value => {
    const items = values(value).map(clean).filter(Boolean);
    return items.length ? items.join("；") : "—";
  };

  function setRequestStatus(message = "", kind = "") {
    const element = $("#request-status");
    element.textContent = message;
    element.className = `request-status ${kind}`.trim();
  }

  function setBusy(busy) {
    $("#word-button").disabled = busy;
    $("#drug-button").disabled = busy;
  }

  function renderIdle() {
    const localCount = state.sources.reduce((sum, source) => sum + Number(source.entryCount || 0), 0);
    const localMessage = localCount
      ? `已加载 ${localCount.toLocaleString()} 条本地词条；精确命中时不会访问云端。`
      : "当前未安装本地词典；英文单词会查询在线词典，再用 Google / 有道补充中文释义。";
    $("#results").innerHTML = `<div class="empty-state"><div><span class="empty-state-icon">M</span><strong>一个输入框，两种查询</strong><p>${esc(localMessage)} 鼠标划词时，两种查询会同时执行。</p></div></div>`;
  }

  function loadingBlock(label, query) {
    return `<section class="result-block"><div class="result-block-heading"><div class="heading-title"><span class="heading-label">${esc(label)}</span><h2>${esc(query)}</h2></div><span class="source-badge">查询中</span></div><div class="loading-state"><div class="loading-line short"></div><div class="loading-line"></div><div class="loading-line medium"></div></div></section>`;
  }

  function showLoading(mode, query) {
    const blocks = mode === "selection"
      ? `${loadingBlock("WORD", query)}${loadingBlock("DRUG", query)}`
      : loadingBlock(mode === "drug" ? "DRUG" : "WORD", query);
    $("#results").innerHTML = `<div class="result-stack">${blocks}</div>`;
    $("#results").scrollTop = 0;
  }

  function warningDetails(warnings) {
    const rows = values(warnings).map(clean).filter(Boolean);
    if (!rows.length) return "";
    return `<details class="warning-details"><summary>部分数据源未返回 <span class="source-badge">${rows.length}</span></summary><ul>${rows.slice(0, 16).map(item => `<li>${esc(item)}</li>`).join("")}</ul></details>`;
  }

  function sourceBadge(result) {
    if (result.strategy === "local") return result.localResults?.[0]?.source?.name || "本地词典";
    if (result.dictionaryResults?.length) {
      const dictionary = result.dictionaryResults[0];
      const count = Number(dictionary.meta?.senseCount || dictionary.senses?.length || 0);
      return `${dictionary.name || dictionary.source?.name || "在线词典"}${count ? ` · ${count} 义` : ""}`;
    }
    const names = (result.cloudResults || []).map(item => item.name || item.provider).filter(Boolean);
    return names.join(" + ") || "在线查询";
  }

  function partOfSpeechLabel(value) {
    const normalized = clean(value).toLowerCase();
    const labels = {
      noun: "名词 · noun",
      verb: "动词 · verb",
      adjective: "形容词 · adjective",
      adverb: "副词 · adverb",
      pronoun: "代词 · pronoun",
      preposition: "介词 · preposition",
      conjunction: "连词 · conjunction",
      interjection: "感叹词 · interjection",
      exclamation: "感叹词 · exclamation",
      determiner: "限定词 · determiner",
      numeral: "数词 · numeral"
    };
    return labels[normalized] || clean(value) || "其他释义";
  }

  function groupSenses(senses) {
    const groups = new Map();
    values(senses).forEach(sense => {
      const key = clean(sense.partOfSpeech).toLowerCase() || "other";
      if (!groups.has(key)) groups.set(key, { partOfSpeech: sense.partOfSpeech, senses: [] });
      groups.get(key).senses.push(sense);
    });
    return [...groups.values()];
  }

  function renderRelated(label, items) {
    const rows = values(items).map(clean).filter(Boolean).slice(0, 8);
    if (!rows.length) return "";
    return `<div class="sense-related"><span>${esc(label)}</span>${rows.map(item => `<em>${esc(item)}</em>`).join("")}</div>`;
  }

  function renderSense(sense, index) {
    const translations = values(sense.translations).map(clean).filter(Boolean);
    const examples = values(sense.examples).map(clean).filter(Boolean);
    return `<div class="sense"><span class="sense-number">${index + 1}</span><div class="sense-copy">${translations.length ? `<div class="sense-translation">${translations.map(esc).join("；")}</div>` : ""}<div class="definition">${esc(sense.definition || "暂无英文释义")}</div>${examples.length ? `<div class="example">${examples.map(example => `<div><span>例</span>${esc(example)}</div>`).join("")}</div>` : ""}${renderRelated("近义", sense.synonyms)}${renderRelated("反义", sense.antonyms)}</div></div>`;
  }

  function renderDictionaryEntry(entry) {
    const groups = groupSenses(entry.senses);
    const audio = entry.audioUrl
      ? `<button class="audio-button" type="button" data-audio-url="${esc(entry.audioUrl)}" title="播放发音" aria-label="播放发音">▶</button>`
      : "";
    const sourceUrl = entry.source?.url;
    const sourceName = entry.source?.name || entry.name || "词典来源";
    const source = sourceUrl
      ? `<a href="#" data-external-url="${esc(sourceUrl)}">${esc(sourceName)}</a>`
      : esc(sourceName);
    const translator = entry.translationProvider?.name
      ? `<span>中文释义：${esc(entry.translationProvider.name)}</span>`
      : "";
    const sourceMeta = entry.source
      ? `<div class="dictionary-source-row"><span>${source}${entry.source.license ? ` · ${esc(entry.source.license)}` : ""}</span>${translator}</div>`
      : "";
    return `<div class="dictionary-entry result-body"><div class="word-head"><strong>${esc(entry.word)}</strong>${entry.phonetic ? `<span class="phonetic">${esc(entry.phonetic)}</span>` : ""}${audio}</div>${groups.map(group => `<section class="meaning-group"><div class="meaning-heading"><strong>${esc(partOfSpeechLabel(group.partOfSpeech))}</strong><span>${group.senses.length} 个义项</span></div>${group.senses.map(renderSense).join("")}</section>`).join("")}${sourceMeta}</div>`;
  }

  function renderCloudResult(result) {
    const translations = values(result.translations).map(esc).join("<br>") || "服务没有返回译文";
    const sourceUrl = result.source?.url;
    const provider = sourceUrl
      ? `<a href="#" data-external-url="${esc(sourceUrl)}">${esc(result.name || result.provider || "云端服务")}</a>`
      : esc(result.name || result.provider || "云端服务");
    return `<div class="cloud-result"><div class="cloud-provider"><span>${provider}</span><span>${result.detectedSource ? `${esc(result.detectedSource)} → ` : ""}${esc(state.settings?.translation?.target || "zh-CN")}</span></div><div class="cloud-translation">${translations}</div>${result.mode === "web" ? '<div class="cloud-meta">Google 免密钥兼容模式</div>' : ""}</div>`;
  }

  function renderCloudReference(results) {
    const rows = values(results);
    if (!rows.length) return "";
    return `<div class="whole-word-translation"><div class="whole-word-heading"><strong>整词翻译</strong><span>仅供快速参考，完整含义以上方词典义项为准</span></div>${rows.map(renderCloudResult).join("")}</div>`;
  }

  function renderSuggestions(suggestions) {
    const words = values(suggestions).map(item => clean(item.word || item)).filter(Boolean);
    if (!words.length) return "";
    return `<div class="suggestion-row">${words.slice(0, 8).map(word => `<button class="suggestion-button" type="button" data-query-word="${esc(word)}">${esc(word)}</button>`).join("")}</div>`;
  }

  function renderWord(result, error = "") {
    const query = result?.query || clean($("#query-input").value);
    if (error) {
      return `<section class="result-block"><div class="result-block-heading"><div class="heading-title"><span class="heading-label">WORD</span><h2>${esc(query || "查词")}</h2></div></div><div class="notice error"><strong>查词失败</strong>${esc(error)}</div></section>`;
    }
    if (!result) return loadingBlock("WORD", query);

    const heading = `<div class="result-block-heading"><div class="heading-title"><span class="heading-label">WORD</span><h2>${esc(query)}</h2></div><span class="source-badge">${esc(sourceBadge(result))}</span></div>`;
    let content = "";
    if (result.strategy === "local" && result.localResults?.length) {
      content = result.localResults.map(renderDictionaryEntry).join("");
    } else if (result.dictionaryResults?.length) {
      content = `${result.dictionaryResults.map(renderDictionaryEntry).join("")}${renderCloudReference(result.cloudResults)}${renderSuggestions(result.suggestions)}`;
    } else if (result.cloudResults?.length) {
      content = `<div class="result-body">${renderCloudReference(result.cloudResults)}${renderSuggestions(result.suggestions)}</div>`;
    } else {
      const configured = values(result.providers).length > 0;
      content = `<div class="notice ${configured ? "warning" : ""}"><strong>${configured ? "云端没有返回结果" : "未配置可用的云端服务"}</strong>${configured ? "请检查网络或展开下方错误信息。" : "在设置中启用 Google 兼容模式，或填写 Google Cloud / 有道凭据。"}${renderSuggestions(result.suggestions)}</div>`;
    }
    return `<section class="result-block">${heading}${content}${warningDetails(result.warnings)}</section>`;
  }

  function phaseLabel(value) {
    const phase = Number(value);
    if (!Number.isFinite(phase)) return valueOrDash(value);
    if (phase >= 4) return "已上市 / Phase 4";
    if (phase > 0) return `Phase ${phase}`;
    return "临床前";
  }

  function identifier(label, value, url) {
    if (value == null || value === "") return "";
    const body = `${esc(label)} ${esc(value)}`;
    return url ? `<a class="id-chip" href="#" data-external-url="${esc(url)}">${body}</a>` : `<span class="id-chip">${body}</span>`;
  }

  function compactValue(value, limit = 3) {
    const items = values(value).map(clean).filter(Boolean);
    if (!items.length) return "—";
    const visible = items.slice(0, limit).join("；");
    return items.length > limit ? `${visible}；… 共 ${items.length} 项` : visible;
  }

  function fact(label, value) {
    const displayValue = compactValue(value);
    return `<div class="fact"><div class="fact-label">${esc(label)}</div><div class="fact-value" title="${esc(displayValue)}">${esc(displayValue)}</div></div>`;
  }

  function tags(items) {
    const rows = values(items).map(item => typeof item === "object" ? `${item.code ? `${item.code} · ` : ""}${item.name || ""}` : clean(item)).filter(Boolean);
    return rows.length ? `<div class="tag-row">${rows.slice(0, 40).map(item => `<span class="tag">${esc(item)}</span>`).join("")}</div>` : '<p class="detail-text">暂无记录。</p>';
  }

  function record(title, meta, url = "") {
    const heading = url ? `<a href="#" data-external-url="${esc(url)}">${esc(title || "—")}</a>` : esc(title || "—");
    return `<div class="record"><div class="record-title">${heading}</div>${meta ? `<div class="record-meta">${meta}</div>` : ""}</div>`;
  }

  function detailSection(title, count, body, open = false) {
    const badge = count != null ? `<span class="source-badge">${esc(count)}</span>` : "";
    return `<details class="drug-section"${open ? " open" : ""}><summary><span>${esc(title)}</span>${badge}</summary><div class="section-content">${body}</div></details>`;
  }

  function renderDrug(result, error = "") {
    const query = result?.query || clean($("#query-input").value);
    if (error) {
      return `<section class="result-block"><div class="result-block-heading"><div class="heading-title"><span class="heading-label">DRUG</span><h2>${esc(query || "药物查询")}</h2></div></div><div class="notice error"><strong>药物查询失败</strong>${esc(error)}</div></section>`;
    }
    if (!result) return loadingBlock("DRUG", query);
    if (!result.success) {
      return `<section class="result-block"><div class="result-block-heading"><div class="heading-title"><span class="heading-label">DRUG</span><h2>${esc(query)}</h2></div><span class="source-badge">未命中</span></div><div class="not-found"><span class="not-found-mark">Rx</span><strong>未找到该药物</strong><p>已查询 DrugShop 的 RxNorm、ChEMBL、PubChem、FDA 与 ClinicalTrials.gov 数据链路。</p></div></section>`;
    }

    const ids = result.identifiers || {};
    const names = result.names || {};
    const structure = result.structure || {};
    const prescription = result.prescription || {};
    const mechanisms = values(result.mechanisms);
    const indications = values(result.indications).sort((a, b) => Number(b.maxPhase ?? -1) - Number(a.maxPhase ?? -1));
    const approvals = values(result.approvals);
    const trials = values(result.trials);
    const activities = values(result.preclinical);
    const classes = result.classes || {};

    const idRows = [
      identifier("RxCUI", ids.rxcui, result.sources?.rxnorm),
      identifier("ChEMBL", ids.chembl, result.sources?.chembl),
      identifier("CID", ids.pubchemCid, result.sources?.pubchem)
    ].filter(Boolean).join("");

    const summary = `<div class="drug-summary"><div class="drug-name-row"><div><h3>${esc(result.name || query)}</h3><div class="drug-query">查询词：${esc(query)}</div></div><div class="id-row">${idRows}</div></div><div class="fact-grid">${fact("通用名", names.generic)}${fact("商品名", names.brands)}${fact("分子式", structure.formula)}${fact("分子量", structure.molecularWeight)}${fact("分子类型", result.format?.description)}${fact("最高开发阶段", phaseLabel(result.development?.maxPhase))}</div></div>`;

    const identity = `<div class="subheading">通用名</div>${tags(names.generic)}<div class="subheading">商品名</div>${tags(names.brands)}<div class="subheading">别名 / 研发编号</div>${tags(names.aliases)}<div class="subheading">处方信息</div><p class="detail-text">剂型：${esc(valueOrDash(prescription.rxtermsDoseForm))}<br>给药途径：${esc(valueOrDash(prescription.route))}<br>规格：${esc(valueOrDash(prescription.strength))}</p>${structure.iupac ? `<div class="subheading">IUPAC</div><p class="detail-text">${esc(structure.iupac)}</p>` : ""}${structure.smiles ? `<div class="subheading">SMILES</div><p class="detail-text">${esc(structure.smiles)}</p>` : ""}`;

    const mechanismBody = mechanisms.length
      ? `<div class="record-list">${mechanisms.slice(0, 40).map(row => record(
        [row.targetShortName || row.targetGene || row.target, row.action].filter(Boolean).join(" · "),
        `${row.mechanism ? `<strong>机制：</strong>${esc(row.mechanism)}<br>` : ""}${row.target ? `<strong>靶点：</strong>${esc(row.target)}${row.targetAccession ? ` · ${esc(row.targetAccession)}` : ""}` : ""}${row.targetFunction ? `<br>${esc(row.targetFunction)}` : ""}`,
        row.targetUrl
      )).join("")}</div>`
      : '<p class="detail-text">暂无 ChEMBL 机制记录。</p>';

    const classRows = [
      ...values(classes.atc).map(item => typeof item === "object" ? `ATC ${item.code || ""} · ${item.name || ""}` : `ATC · ${item}`),
      ...values(classes.epc).map(item => `EPC · ${item}`),
      ...values(classes.moa).map(item => `MOA · ${item}`),
      ...values(classes.pe).map(item => `PE · ${item}`)
    ];

    const indicationBody = `<div class="subheading">RxClass / ATC</div>${tags(classRows)}<div class="subheading">适应症</div>${indications.length ? `<div class="record-list">${indications.slice(0, 30).map(row => record(row.name || "未命名适应症", `最高阶段：${esc(phaseLabel(row.maxPhase))}`)).join("")}</div>` : '<p class="detail-text">暂无 ChEMBL 适应症记录。</p>'}`;

    const approvalBody = approvals.length
      ? `<div class="record-list">${approvals.slice(0, 20).map(row => record(
        [...values(row.brandNames), ...values(row.genericNames)].join(" / ") || row.applicationNumber,
        `申请号：${esc(valueOrDash(row.applicationNumber))}<br>申办方：${esc(valueOrDash(row.sponsor))}<br>首次批准：${esc(valueOrDash(row.firstApprovalDate))}`
      )).join("")}</div>`
      : '<p class="detail-text">暂无 FDA Drugs@FDA 批准记录。</p>';

    const trialBody = trials.length
      ? `<div class="record-list">${trials.slice(0, 20).map(row => record(
        `${row.id || "NCT"} · ${row.title || "未命名研究"}`,
        `${esc([row.status, ...values(row.phases)].filter(Boolean).join(" · ") || "状态未标注")}<br>${esc(values(row.conditions).join("；") || "适应症未标注")}${row.primaryOutcome ? `<br><strong>主要终点：</strong>${esc(row.primaryOutcome)}` : ""}${row.primaryResult ? `<br><strong>主要结果：</strong>${esc(row.primaryResult)}` : ""}`,
        row.url
      )).join("")}</div>`
      : '<p class="detail-text">暂无 ClinicalTrials.gov 试验结果。</p>';

    const activityBody = activities.length
      ? `<p class="detail-text">以下是 ChEMBL 标准化活性记录，仅用于检索，不等同于完整临床前研究。</p><div class="record-list">${activities.slice(0, 20).map(row => record(
        `${row.type || "活性"} ${row.relation || ""} ${row.value || ""} ${row.units || ""}`.trim(),
        `${esc(row.target || row.targetId || "靶点未标注")} · ${esc(row.organism || "物种未标注")}${row.pchembl ? `<br>pChEMBL：${esc(row.pchembl)}` : ""}${row.assay ? `<br>${esc(row.assay)}` : ""}`
      )).join("")}</div>`
      : '<p class="detail-text">暂无 ChEMBL 标准化活性记录。</p>';

    const sourceRows = Object.entries(result.sources || {}).filter(([, url]) => url).map(([name, url]) => `<a href="#" data-external-url="${esc(url)}">${esc(name)} ↗</a>`).join("");
    const sources = sourceRows ? detailSection("原始数据源", Object.values(result.sources || {}).filter(Boolean).length, `<div class="source-links">${sourceRows}</div>`) : "";

    return `<section class="result-block"><div class="result-block-heading"><div class="heading-title"><span class="heading-label">DRUG</span><h2>${esc(result.name || query)}</h2></div><span class="phase-chip">${esc(phaseLabel(result.development?.maxPhase))}</span></div>${summary}${detailSection("名称、结构与处方", null, identity)}${detailSection("靶点与作用机制", mechanisms.length, mechanismBody)}${detailSection("分类与适应症", indications.length, indicationBody)}${detailSection("FDA 批准记录", approvals.length, approvalBody)}${detailSection("临床试验", trials.length, trialBody)}${detailSection("药理活性", activities.length, activityBody)}${sources}${warningDetails(result.warnings)}</section>`;
  }

  function renderResults({ word = undefined, drug = undefined, errors = {} }) {
    const blocks = [];
    if (word !== undefined) blocks.push(renderWord(word, errors.word));
    if (drug !== undefined) blocks.push(renderDrug(drug, errors.drug));
    $("#results").innerHTML = `<div class="result-stack">${blocks.join("")}</div>`;
    $("#results").scrollTop = 0;
  }

  async function runManual(kind) {
    const query = clean($("#query-input").value);
    if (!query) {
      setRequestStatus("请先输入查询内容", "error");
      $("#query-input").focus();
      return;
    }
    const requestId = ++state.requestId;
    state.activeSelectionRequestId = null;
    setBusy(true);
    setRequestStatus(kind === "drug" ? "正在查询 DrugShop…" : "正在查询词典与翻译…");
    showLoading(kind, query);
    try {
      const result = kind === "drug" ? await api.lookupDrug(query) : await api.lookupWord(query);
      if (requestId !== state.requestId) return;
      renderResults(kind === "drug" ? { drug: result } : { word: result });
      setRequestStatus(kind === "drug"
        ? (result.success ? "药物数据已返回" : "未找到该药物")
        : (result.strategy === "local"
          ? "本地词典命中"
          : result.dictionaryResults?.length
            ? "在线词典已返回"
            : result.success ? "翻译已返回" : "在线查询未返回结果"), result.success === false ? "error" : "");
    } catch (error) {
      if (requestId !== state.requestId) return;
      renderResults(kind === "drug" ? { drug: null, errors: { drug: error.message || String(error) } } : { word: null, errors: { word: error.message || String(error) } });
      setRequestStatus("查询失败", "error");
    } finally {
      if (requestId === state.requestId) setBusy(false);
    }
  }

  function updateSelectionStatus(status) {
    state.selectionStatus = { ...state.selectionStatus, ...(status || {}) };
    const element = $("#selection-status");
    element.classList.toggle("active", Boolean(state.selectionStatus.active));
    element.classList.toggle("error", state.selectionStatus.available === false && !state.selectionStatus.active);
    element.querySelector(".selection-label").textContent = state.selectionStatus.message || (state.selectionStatus.active ? "自动划词已开启" : "自动划词未开启");
  }

  function renderDictionarySources() {
    const count = state.sources.length;
    $("#dictionary-count").textContent = `${count} 个`;
    $("#dictionary-sources").innerHTML = count
      ? state.sources.map(source => `<div class="dictionary-source"><span>${esc(source.name)}</span><span>${Number(source.entryCount || 0).toLocaleString()} 条</span></div>`).join("")
      : '<div class="dictionary-source-empty">尚未安装本地词典</div>';
  }

  function setField(id, value) {
    const element = $(`#${id}`);
    if (element) element.value = value ?? "";
  }

  function setChecked(id, value) {
    const element = $(`#${id}`);
    if (element) element.checked = Boolean(value);
  }

  function updateGoogleMode() {
    const cloudMode = $("#google-mode").value === "cloud";
    $("#google-key-field").classList.toggle("disabled-field", !cloudMode);
  }

  function fillSettings() {
    const settings = state.settings || {};
    const translation = settings.translation || {};
    setChecked("selection-enabled", settings.behavior?.selectionLookup);
    setChecked("google-enabled", translation.google?.enabled);
    setField("google-mode", translation.google?.mode || (translation.google?.apiKey ? "cloud" : "web"));
    setField("google-api-key", translation.google?.apiKey || "");
    setChecked("youdao-enabled", translation.youdao?.enabled);
    setField("youdao-app-key", translation.youdao?.appKey || "");
    setField("youdao-app-secret", translation.youdao?.appSecret || "");
    setField("translation-target", translation.target || "zh-CN");
    setChecked("hide-on-close", settings.window?.hideOnClose !== false);
    $("#settings-status").textContent = "";
    renderDictionarySources();
    updateGoogleMode();
  }

  function readSettings() {
    const settings = JSON.parse(JSON.stringify(state.settings || {}));
    settings.translation ||= {};
    settings.translation.google ||= {};
    settings.translation.youdao ||= {};
    settings.behavior ||= {};
    settings.window ||= {};
    settings.translation.source = "auto";
    settings.translation.target = $("#translation-target").value || "zh-CN";
    settings.translation.google.enabled = $("#google-enabled").checked;
    settings.translation.google.mode = $("#google-mode").value || "web";
    settings.translation.google.apiKey = clean($("#google-api-key").value);
    settings.translation.youdao.enabled = $("#youdao-enabled").checked;
    settings.translation.youdao.appKey = clean($("#youdao-app-key").value);
    settings.translation.youdao.appSecret = clean($("#youdao-app-secret").value);
    settings.behavior.selectionLookup = $("#selection-enabled").checked;
    settings.behavior.selectionMaxLength = Number(settings.behavior.selectionMaxLength) || 500;
    settings.window.hideOnClose = $("#hide-on-close").checked;
    settings.window.alwaysOnTop = state.pinned;
    return settings;
  }

  function openSettings() {
    fillSettings();
    if (!$("#settings-dialog").open) $("#settings-dialog").showModal();
  }

  function bindEvents() {
    $("#word-button").addEventListener("click", () => runManual("word"));
    $("#drug-button").addEventListener("click", () => runManual("drug"));
    $("#clear-button").addEventListener("click", () => {
      state.requestId += 1;
      state.activeSelectionRequestId = null;
      setBusy(false);
      $("#query-input").value = "";
      setRequestStatus("");
      renderIdle();
      $("#query-input").focus();
    });
    $("#query-input").addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        runManual(event.ctrlKey ? "drug" : "word");
      }
      if (event.key === "Escape") api.hideWindow();
    });

    $("#settings-button").addEventListener("click", openSettings);
    $("#selection-status").addEventListener("click", openSettings);
    $("#close-settings-button").addEventListener("click", () => $("#settings-dialog").close());
    $("#cancel-settings-button").addEventListener("click", () => $("#settings-dialog").close());
    $("#google-mode").addEventListener("change", updateGoogleMode);
    $("#settings-form").addEventListener("submit", async event => {
      event.preventDefault();
      const next = readSettings();
      if (next.translation.google.enabled && next.translation.google.mode === "cloud" && !next.translation.google.apiKey) {
        $("#settings-status").textContent = "请填写 Google Cloud Key";
        return;
      }
      if (next.translation.youdao.enabled && (!next.translation.youdao.appKey || !next.translation.youdao.appSecret)) {
        $("#settings-status").textContent = "请填写有道凭据";
        return;
      }
      $("#settings-status").textContent = "保存中…";
      try {
        state.settings = await api.saveSettings(next);
        $("#settings-status").textContent = "已保存";
        setTimeout(() => {
          if ($("#settings-dialog").open) $("#settings-dialog").close();
        }, 320);
      } catch (error) {
        $("#settings-status").textContent = error.message || String(error);
      }
    });
    $("#quit-button").addEventListener("click", () => api.quit());

    $("#minimize-button").addEventListener("click", () => api.minimizeWindow());
    $("#close-button").addEventListener("click", () => api.hideWindow());
    $("#pin-button").addEventListener("click", async () => {
      state.pinned = await api.togglePin();
      $("#pin-button").classList.toggle("active", state.pinned);
      $("#pin-button").title = state.pinned ? "取消置顶" : "置顶窗口";
    });

    document.addEventListener("click", event => {
      const audioButton = event.target.closest("[data-audio-url]");
      if (audioButton) {
        const audio = new Audio(audioButton.dataset.audioUrl);
        audio.play().catch(error => setRequestStatus(`发音播放失败：${error.message || error}`, "error"));
        return;
      }
      const queryButton = event.target.closest("[data-query-word]");
      if (queryButton) {
        $("#query-input").value = queryButton.dataset.queryWord;
        runManual("word");
        return;
      }
      const external = event.target.closest("[data-external-url]");
      if (external) {
        event.preventDefault();
        api.openExternal(external.dataset.externalUrl).catch(error => setRequestStatus(error.message || String(error), "error"));
      }
    });

    api.onSelectionPending(payload => {
      state.requestId += 1;
      state.activeSelectionRequestId = payload.requestId;
      $("#query-input").value = payload.query;
      setBusy(false);
      setRequestStatus("划词：查词与药物查询并行执行中…");
      showLoading("selection", payload.query);
    });
    api.onSelectionResult(payload => {
      if (state.activeSelectionRequestId !== payload.requestId) return;
      renderResults({ word: payload.word, drug: payload.drug, errors: payload.errors || {} });
      setRequestStatus(payload.drug?.success ? "划词查询完成 · 已匹配药物" : "划词查询完成 · 未找到该药物");
    });
    api.onSelectionStatus(updateSelectionStatus);
  }

  async function init() {
    if (!api) {
      $("#results").innerHTML = '<div class="notice error"><strong>桌面桥接不可用</strong>请从 Medict 桌面程序启动。</div>';
      return;
    }
    bindEvents();
    try {
      const [settings, sources, pinned, selectionStatus] = await Promise.all([
        api.getSettings(),
        api.listDictionaries(),
        api.isPinned(),
        api.getSelectionStatus()
      ]);
      state.settings = settings;
      state.sources = sources;
      state.pinned = pinned;
      $("#pin-button").classList.toggle("active", pinned);
      updateSelectionStatus(selectionStatus);
      renderIdle();
      $("#query-input").focus();
    } catch (error) {
      $("#results").innerHTML = `<div class="notice error"><strong>Medict 初始化失败</strong>${esc(error.message || error)}</div>`;
    }
  }

  init();
})();
