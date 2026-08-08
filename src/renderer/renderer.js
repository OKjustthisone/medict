(function () {
  "use strict";

  const api = window.medict;
  const state = {
    settings: null,
    sources: [],
    requestId: 0,
    activeSelectionRequestId: null,
    selectionStatus: { available: false, active: false, message: "正在启动自动划词" },
    pinned: false,
    activeMode: "word"
  };

  const dictionaryServices = [
    { id: "youdaoDictionary", label: "网易有道词典 / 翻译" },
    { id: "freeDictionary", label: "Free Dictionary" },
    { id: "baidu", label: "百度词典版" },
    { id: "google", label: "Google" }
  ];
  const defaultDictionaryServiceOrder = dictionaryServices.map(service => service.id);

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

  function normalizeDictionaryServiceOrder(order) {
    const requested = Array.isArray(order) ? order : [];
    const selected = [...new Set(requested
      .map(id => id === "youdao" ? "youdaoDictionary" : id)
      .filter(id => defaultDictionaryServiceOrder.includes(id)))];
    const missing = defaultDictionaryServiceOrder.filter(id => !selected.includes(id));
    const firstService = defaultDictionaryServiceOrder[0];
    return [
      ...(missing.includes(firstService) ? [firstService] : []),
      ...selected,
      ...missing.filter(id => id !== firstService)
    ];
  }

  function renderDictionaryServiceOrder(order = state.settings?.dictionary?.serviceOrder) {
    const container = $("#dictionary-service-order");
    if (!container) return;
    const normalized = normalizeDictionaryServiceOrder(order);
    container.innerHTML = normalized.map((id, index) => {
      const service = dictionaryServices.find(item => item.id === id);
      return `<div class="service-order-row" data-service-id="${esc(id)}"><span class="service-order-index">${index + 1}</span><strong>${esc(service?.label || id)}</strong><div class="service-order-actions"><button type="button" class="order-button" data-service-move="up" aria-label="上移" title="上移"${index === 0 ? " disabled" : ""}>↑</button><button type="button" class="order-button" data-service-move="down" aria-label="下移" title="下移"${index === normalized.length - 1 ? " disabled" : ""}>↓</button></div></div>`;
    }).join("");
  }

  function setRequestStatus(message = "", kind = "") {
    const element = $("#request-status");
    element.textContent = message;
    element.className = `request-status ${kind}`.trim();
  }

  function setBusy(busy) {
    $("#word-button").disabled = busy;
    $("#drug-button").disabled = busy;
  }

  function setActiveMode(mode = "word") {
    state.activeMode = mode;
    $("#word-button").classList.toggle("active", mode === "word" || mode === "selection");
    $("#drug-button").classList.toggle("active", mode === "drug");
  }

  function applyFontScale(value) {
    const scale = Math.max(100, Math.min(145, Number(value) || 115));
    const ratio = scale / 100;
    const root = document.documentElement;
    root.style.setProperty("--font-scale", String(ratio));
    [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].forEach(size => {
      root.style.setProperty(`--font-${size}`, `${(size * ratio).toFixed(2)}px`);
    });
  }

  function shortcutLabel(accelerator) {
    return clean(accelerator)
      .replace(/CommandOrControl/gi, "Ctrl")
      .split("+")
      .map(part => part.trim())
      .filter(Boolean)
      .join(" + ");
  }

  function setShortcutField(id, accelerator) {
    const element = $(`#${id}`);
    if (!element) return;
    element.dataset.accelerator = clean(accelerator);
    element.value = shortcutLabel(accelerator);
  }

  function acceleratorFromEvent(event) {
    if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return "";
    const modifiers = [];
    if (event.ctrlKey) modifiers.push("CommandOrControl");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
    if (!event.ctrlKey && !event.altKey) {
      throw new Error("快捷键必须包含 Ctrl 或 Alt");
    }
    const aliases = {
      " ": "Space",
      Tab: "Tab",
      Enter: "Enter",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right"
    };
    let key = aliases[event.key] || "";
    if (/^[a-z0-9]$/i.test(event.key)) key = event.key.toUpperCase();
    if (/^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(event.key)) key = event.key.toUpperCase();
    if (!key) throw new Error("请使用字母、数字、功能键或方向键");
    return [...modifiers, key].join("+");
  }

  function bindShortcutRecorder(element) {
    element.addEventListener("focus", () => {
      element.classList.add("recording");
      element.value = "请按新的组合键…";
      $("#settings-status").textContent = "正在录入快捷键";
    });
    element.addEventListener("blur", () => {
      element.classList.remove("recording");
      element.value = shortcutLabel(element.dataset.accelerator);
      if ($("#settings-status").textContent === "正在录入快捷键") $("#settings-status").textContent = "";
    });
    element.addEventListener("keydown", event => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        element.blur();
        return;
      }
      if (["Backspace", "Delete"].includes(event.key) && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        element.dataset.accelerator = "";
        element.blur();
        return;
      }
      try {
        const accelerator = acceleratorFromEvent(event);
        if (!accelerator) return;
        element.dataset.accelerator = accelerator;
        $("#settings-status").textContent = "快捷键已录入，保存后生效";
        element.blur();
      } catch (error) {
        $("#settings-status").textContent = error.message || String(error);
      }
    });
  }

  function copyButton(scope, label = "复制") {
    return `<button class="copy-button" type="button" data-copy-scope="${esc(scope)}" title="${esc(label)}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7V4h11v13h-3v3H5V7h3Zm2 0h6v8h1V6h-7v1Zm-3 2v9h7V9H7Z"/></svg></button>`;
  }

  function readableText(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll(".copy-button, .sense-number, .cloud-result-footer, .provider-attribution").forEach(item => item.remove());
    return clean(clone.innerText).replace(/\n{3,}/g, "\n\n");
  }

  async function copyFromButton(button) {
    const scope = button.dataset.copyScope;
    let text = "";
    if (scope === "input") text = $("#query-input").value;
    if (scope === "result") text = readableText(button.closest(".result-block"));
    if (scope === "sense") text = readableText(button.closest(".sense"));
    if (scope === "cloud") text = clean(button.closest(".cloud-result")?.querySelector(".cloud-translation")?.innerText);
    if (!clean(text)) {
      setRequestStatus("没有可复制的内容", "error");
      return;
    }
    try {
      await api.copyText(text);
      button.classList.add("copied");
      setRequestStatus("已复制");
      setTimeout(() => button.classList.remove("copied"), 900);
    } catch (error) {
      setRequestStatus(`复制失败：${error.message || error}`, "error");
    }
  }

  function addResultCopyButtons() {
    document.querySelectorAll(".result-block-heading").forEach(heading => {
      if (heading.querySelector('[data-copy-scope="result"]')) return;
      let actions = heading.querySelector(".result-heading-actions");
      if (!actions) {
        actions = document.createElement("div");
        actions.className = "result-heading-actions";
        [...heading.children].slice(1).forEach(item => actions.appendChild(item));
        heading.appendChild(actions);
      }
      actions.insertAdjacentHTML("beforeend", copyButton("result", "复制本条结果"));
    });
  }

  function renderIdle() {
    const localCount = state.sources.reduce((sum, source) => sum + Number(source.entryCount || 0), 0);
    const localMessage = localCount
      ? `已加载 ${localCount.toLocaleString()} 条本地词条；精确命中时不会访问云端。`
      : "当前未安装本地词典；英文单词会查完整在线词典，短语和句子会自动翻译。";
    $("#results").innerHTML = `<div class="empty-state"><div><span class="empty-state-icon" aria-hidden="true"><svg viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="16" fill="#4c72e8"/><g fill="none" stroke="#fff" stroke-linecap="round" stroke-width="3.1" opacity=".94"><ellipse cx="32" cy="32" rx="23" ry="9"/><ellipse cx="32" cy="32" rx="23" ry="9" transform="rotate(60 32 32)"/><ellipse cx="32" cy="32" rx="23" ry="9" transform="rotate(-60 32 32)"/></g><circle cx="32" cy="32" r="6.5" fill="#e9fbff"/><circle cx="32" cy="32" r="3.5" fill="#27a9d4"/></svg></span><strong>一个输入框，两种查询</strong><p>${esc(localMessage)} 鼠标划词时，两种查询会同时执行。</p></div></div>`;
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
    const firstDisplay = result.displayResults?.[0];
    if (firstDisplay?.displayType === "cloud") {
      return firstDisplay.name || firstDisplay.provider || "在线翻译";
    }
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
      if (!sense || typeof sense !== "object") return;
      const partOfSpeech = clean(sense.partOfSpeech);
      const key = partOfSpeech.toLowerCase() || "other";
      if (!groups.has(key)) groups.set(key, { partOfSpeech, senses: [] });
      const group = groups.get(key);
      const definition = clean(sense.definition).toLowerCase();
      const translations = values(sense.translations).map(clean).filter(Boolean);
      const duplicate = definition
        ? group.senses.find(item => clean(item.definition).toLowerCase() === definition)
        : group.senses.find(item => {
          const existing = values(item.translations).map(clean).filter(Boolean);
          return existing.length && translations.length && existing.join("\u0000") === translations.join("\u0000");
        });
      if (duplicate) {
        duplicate.translations = [...new Set([
          ...values(duplicate.translations).map(clean),
          ...translations
        ].filter(Boolean))];
        duplicate.synonyms = [...new Set([
          ...values(duplicate.synonyms).map(clean),
          ...values(sense.synonyms).map(clean)
        ].filter(Boolean))];
        duplicate.antonyms = [...new Set([
          ...values(duplicate.antonyms).map(clean),
          ...values(sense.antonyms).map(clean)
        ].filter(Boolean))];
        if (!clean(duplicate.note) && clean(sense.note)) duplicate.note = clean(sense.note);
        return;
      }
      group.senses.push({
        ...sense,
        translations,
        // Examples are rendered once in the standalone bilingual section below.
        examples: []
      });
    });
    return [...groups.values()];
  }

  function renderRelated(label, items) {
    const rows = values(items).map(clean).filter(Boolean).slice(0, 8);
    if (!rows.length) return "";
    return `<div class="sense-related"><span>${esc(label)}</span>${rows.map(item => `<em>${esc(item)}</em>`).join("")}</div>`;
  }

  function renderMeaningGroup(group) {
    const senses = values(group.senses).filter(item => item && typeof item === "object");
    const translations = [...new Set(senses.flatMap(sense => values(sense.translations).map(clean)).filter(Boolean))];
    const definitions = [...new Set(senses.map(sense => clean(sense.definition)).filter(Boolean))];
    const notes = [...new Set(senses.map(sense => clean(sense.note)).filter(Boolean))];
    const synonyms = [...new Set(senses.flatMap(sense => values(sense.synonyms).map(clean)).filter(Boolean))];
    const antonyms = [...new Set(senses.flatMap(sense => values(sense.antonyms).map(clean)).filter(Boolean))];
    const definitionRows = definitions.length
      ? `<div class="meaning-definitions">${definitions.map((definition, index) => `<div class="meaning-definition"><span>${index + 1}</span><span>${esc(definition)}</span></div>`).join("")}</div>`
      : `<div class="definition">暂无英文释义</div>`;
    return `<section class="meaning-group"><div class="meaning-heading"><strong>${esc(partOfSpeechLabel(group.partOfSpeech))}</strong><span>${senses.length} 个义项</span></div><div class="sense meaning-summary"><span class="meaning-bullet">•</span><div class="sense-copy">${translations.length ? `<div class="sense-translation">${translations.map(esc).join("；")}</div>` : ""}${definitionRows}${notes.map(note => `<div class="sense-note">${esc(note)}</div>`).join("")}${renderRelated("近义", synonyms)}${renderRelated("反义", antonyms)}<div class="sense-footer">${copyButton("sense", "复制本词性释义")}</div></div></div></section>`;
  }

  function renderDictionaryExamples(examples) {
    const rows = values(examples).map(row => typeof row === "object" ? row : { example: row })
      .map(row => ({
        example: clean(row.example || row.text),
        translation: clean(row.translation || row.trans || row.zh || row.chn),
        source: clean(row.source || row.sourceType || row.type),
        audioUrl: clean(row.audioUrl)
      }))
      .filter(row => row.example)
      .slice(0, 48);
    if (!rows.length) return "";
    const renderRow = row => `<div class="dictionary-example-row">${row.audioUrl ? `<button class="example-audio" type="button" data-audio-url="${esc(row.audioUrl)}" title="播放例句" aria-label="播放例句">▶</button>` : ""}<div><div class="dictionary-example-en">${esc(row.example)}</div>${row.translation ? `<div class="dictionary-example-zh">${esc(row.translation)}</div>` : ""}${row.source ? `<small class="example-source">${esc(row.source)}</small>` : ""}</div></div>`;
    const visibleRows = rows.slice(0, 5).map(renderRow).join("");
    const remainingRows = rows.slice(5);
    const more = remainingRows.length
      ? `<div class="dictionary-example-more" hidden>${remainingRows.map(renderRow).join("")}</div><button class="dictionary-more-button" type="button" data-expand-examples data-expanded="false" data-more-count="${remainingRows.length}">显示更多例句（${remainingRows.length}）</button>`
      : "";
    return `<details class="dictionary-extra" open><summary><span>双语例句</span><span class="source-badge">${rows.length}</span></summary><div class="dictionary-extra-body"><div class="dictionary-example-visible">${visibleRows}</div>${more}</div></details>`;
  }

  function renderDictionaryPhrases(phrases) {
    const rows = values(phrases).filter(row => row && typeof row === "object" && clean(row.phrase))
      .slice(0, 32);
    if (!rows.length) return "";
    const body = rows.map(row => `<div class="dictionary-phrase-row"><strong>${esc(row.phrase)}</strong><span>${esc(values(row.translations).map(clean).filter(Boolean).join("；"))}</span></div>`).join("");
    return `<details class="dictionary-extra" open><summary><span>常用词组</span><span class="source-badge">${rows.length}</span></summary><div class="dictionary-extra-body">${body}</div></details>`;
  }

  function renderRelatedWords(words) {
    const rows = values(words).filter(row => row && typeof row === "object" && clean(row.word)).slice(0, 32);
    if (!rows.length) return "";
    const body = rows.map(row => `<div class="dictionary-phrase-row"><strong>${esc(row.word)}</strong><span>${esc(values(row.translations).map(clean).filter(Boolean).join("；"))}</span></div>`).join("");
    return `<details class="dictionary-extra"><summary><span>相关词</span><span class="source-badge">${rows.length}</span></summary><div class="dictionary-extra-body">${body}</div></details>`;
  }

  function renderWebTranslations(rows) {
    const items = values(rows).filter(row => row && typeof row === "object" && clean(row.word)).slice(0, 32);
    if (!items.length) return "";
    const body = items.map(row => `<div class="dictionary-phrase-row"><strong>${esc(row.word)}</strong><span>${esc(values(row.translations).map(clean).filter(Boolean).join("；"))}</span></div>`).join("");
    return `<details class="dictionary-extra"><summary><span>网页常用译法</span><span class="source-badge">${items.length}</span></summary><div class="dictionary-extra-body">${body}</div></details>`;
  }

  function renderDictionaryTags(tags) {
    const rows = values(tags).map(clean).filter(Boolean);
    return rows.length ? `<div class="dictionary-tags">${rows.map(tag => `<span>${esc(tag)}</span>`).join("")}</div>` : "";
  }

  function renderWordForms(forms) {
    const rows = values(forms).map(item => {
      if (!item || typeof item !== "object") return "";
      const label = clean(item.label);
      const formValues = values(item.values).map(clean).filter(Boolean);
      return label && formValues.length
        ? `<div class="word-form"><span>${esc(label)}</span><strong>${esc(formValues.join(" / "))}</strong></div>`
        : "";
    }).filter(Boolean);
    return rows.length ? `<div class="word-forms"><span class="word-forms-label">变形</span><div class="word-form-grid">${rows.join("")}</div></div>` : "";
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
    const sourceMeta = entry.source
      ? `<div class="dictionary-source-row"><span>${source}${entry.source.license ? ` · ${esc(entry.source.license)}` : ""}</span></div>`
      : "";
    return `<div class="dictionary-entry result-body"><div class="word-head"><strong>${esc(entry.word)}</strong>${entry.phonetic ? `<span class="phonetic">${esc(entry.phonetic)}</span>` : ""}${audio}</div>${renderDictionaryTags(entry.tags)}${renderWordForms(entry.wordForms)}<div class="detail-heading">详细释义</div>${groups.map(renderMeaningGroup).join("")}${renderDictionaryExamples(entry.examples)}${renderDictionaryPhrases(entry.phrases)}${renderRelatedWords(entry.relatedWords)}${renderWebTranslations(entry.webTranslations)}${sourceMeta}</div>`;
  }

  function renderCloudResult(result) {
    const translations = values(result.translations).map(esc).join("<br>") || "服务没有返回译文";
    const provider = esc(result.name || result.provider || "云端服务");
    const language = `${result.detectedSource ? `${esc(result.detectedSource)} → ` : ""}${esc(state.settings?.translation?.target || "zh-CN")}`;
    const examples = values(result.examples).filter(row => row && typeof row === "object" && clean(row.example)).slice(0, 6);
    const exampleHtml = examples.length
      ? `<div class="translation-examples">${examples.map(row => `<div><span>${esc(clean(row.example))}</span>${clean(row.translation) ? `<small>${esc(row.translation)}</small>` : ""}</div>`).join("")}</div>`
      : "";
    const compatible = result.provider === "google" && result.mode === "web" ? " · 兼容模式" : "";
    return `<div class="cloud-result"><div class="cloud-translation">${translations}</div>${exampleHtml}<div class="cloud-result-footer"><span>${language}</span><span class="provider-attribution">${provider}${compatible}</span>${copyButton("cloud", "复制本条直接释义")}</div></div>`;
  }

  function renderCloudReference(results, dictionaryMode = false) {
    const rows = values(results);
    if (!rows.length) return "";
    const providers = [...new Set(rows.map(item => item.name || item.provider).filter(Boolean))];
    const supplement = providers.length ? `${providers.join(" / ")}补充` : "";
    return `<div class="whole-word-translation${dictionaryMode ? " cloud-after-dictionary" : ""}"><div class="whole-word-heading"><strong>${dictionaryMode ? "整词翻译" : "翻译结果"}</strong><span>${dictionaryMode ? esc(supplement) : ""}</span></div>${rows.map(renderCloudResult).join("")}</div>`;
  }

  function renderOrderedResults(results) {
    return values(results).map(item => item.displayType === "cloud"
      ? renderCloudReference([item], true)
      : renderDictionaryEntry(item)).join("");
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
      content = `${result.displayResults?.length ? renderOrderedResults(result.displayResults) : `${result.dictionaryResults.map(renderDictionaryEntry).join("")}${renderCloudReference(result.cloudResults, true)}`}${renderSuggestions(result.suggestions)}`;
    } else if (result.cloudResults?.length) {
      content = `<div class="result-body">${renderCloudReference(result.cloudResults)}${renderSuggestions(result.suggestions)}</div>`;
    } else {
      const configured = values(result.providers).length > 0;
      content = `<div class="notice ${configured ? "warning" : ""}"><strong>${configured ? "云端没有返回结果" : "未配置可用的云端服务"}</strong>${configured ? "请检查网络或展开下方错误信息。" : "在设置中启用网易有道网页服务或 Google 兼容模式，也可以填写百度凭据。"}${renderSuggestions(result.suggestions)}</div>`;
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

  function cacheBadge(result) {
    return result?.cache?.hit ? '<span class="cache-chip">7 天缓存</span>' : "";
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
      return `<section class="result-block"><div class="result-block-heading"><div class="heading-title"><span class="heading-label">DRUG</span><h2>${esc(query)}</h2></div><span class="source-badge">未命中</span>${cacheBadge(result)}</div><div class="not-found"><span class="not-found-mark">Rx</span><strong>未找到该药物</strong><p>已查询 DrugShop 的 RxNorm、ChEMBL、PubChem、FDA 与 ClinicalTrials.gov 数据链路。</p></div></section>`;
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

    const summary = `<div class="drug-summary"><div class="drug-name-row"><div><h3>${esc(result.name || query)}</h3><div class="drug-query">查询词：${esc(query)}${result.cache?.hit ? " · 读取自本机 7 天缓存" : ""}</div></div><div class="id-row">${idRows}</div></div><div class="fact-grid">${fact("通用名", names.generic)}${fact("商品名", names.brands)}${fact("分子式", structure.formula)}${fact("分子量", structure.molecularWeight)}${fact("分子类型", result.format?.description)}${fact("最高开发阶段", phaseLabel(result.development?.maxPhase))}</div></div>`;

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

    return `<section class="result-block"><div class="result-block-heading"><div class="heading-title"><span class="heading-label">DRUG</span><h2>${esc(result.name || query)}</h2></div><span class="phase-chip">${esc(phaseLabel(result.development?.maxPhase))}</span>${cacheBadge(result)}</div>${summary}${detailSection("名称、结构与处方", null, identity)}${detailSection("靶点与作用机制", mechanisms.length, mechanismBody)}${detailSection("分类与适应症", indications.length, indicationBody)}${detailSection("FDA 批准记录", approvals.length, approvalBody)}${detailSection("临床试验", trials.length, trialBody)}${detailSection("药理活性", activities.length, activityBody)}${sources}${warningDetails(result.warnings)}</section>`;
  }

  function renderResults({ word = undefined, drug = undefined, errors = {} }) {
    const blocks = [];
    if (word !== undefined) blocks.push(renderWord(word, errors.word));
    if (drug !== undefined) blocks.push(renderDrug(drug, errors.drug));
    $("#results").innerHTML = `<div class="result-stack">${blocks.join("")}</div>`;
    addResultCopyButtons();
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
    setActiveMode(kind);
    setBusy(true);
    setRequestStatus(kind === "drug" ? "正在查询 DrugShop…" : "正在查询词典与翻译…");
    showLoading(kind, query);
    try {
      const result = kind === "drug" ? await api.lookupDrug(query) : await api.lookupWord(query);
      if (requestId !== state.requestId) return;
      renderResults(kind === "drug" ? { drug: result } : { word: result });
      setRequestStatus(kind === "drug"
        ? (result.cache?.hit ? "药物结果来自 7 天缓存" : result.success ? "药物数据已返回并缓存" : "未找到该药物，结果已缓存")
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
    const dictionary = settings.dictionary || {};
    setChecked("selection-enabled", settings.behavior?.selectionLookup);
    setChecked("youdao-dictionary-enabled", dictionary.youdaoDictionary?.enabled !== false);
    setChecked("free-dictionary-enabled", dictionary.freeDictionary?.enabled !== false);
    setChecked("google-enabled", translation.google?.enabled);
    setField("google-mode", translation.google?.mode || (translation.google?.apiKey ? "cloud" : "web"));
    setField("google-api-key", translation.google?.apiKey || "");
    setChecked("baidu-enabled", translation.baidu?.enabled);
    setField("baidu-api-key", translation.baidu?.apiKey || "");
    setField("baidu-secret-key", translation.baidu?.secretKey || "");
    setField("translation-target", translation.target || "zh-CN");
    setField("font-scale", settings.appearance?.fontScale || 115);
    setShortcutField("shortcut-show-window", settings.shortcuts?.showWindow ?? "CommandOrControl+Alt+M");
    setShortcutField("shortcut-selection-lookup", settings.shortcuts?.selectionLookup ?? "CommandOrControl+Alt+D");
    setChecked("hide-on-close", settings.window?.hideOnClose !== false);
    $("#settings-status").textContent = "";
    renderDictionarySources();
    renderDictionaryServiceOrder(dictionary.serviceOrder);
    updateGoogleMode();
  }

  function readSettings() {
    const settings = JSON.parse(JSON.stringify(state.settings || {}));
    settings.dictionary ||= {};
    settings.dictionary.youdaoDictionary ||= {};
    settings.dictionary.freeDictionary ||= {};
    settings.translation ||= {};
    settings.translation.google ||= {};
    settings.translation.baidu ||= {};
    settings.behavior ||= {};
    settings.appearance ||= {};
    settings.shortcuts ||= {};
    settings.window ||= {};
    settings.translation.source = "auto";
    settings.translation.target = $("#translation-target").value || "zh-CN";
    settings.translation.google.enabled = $("#google-enabled").checked;
    settings.translation.google.mode = $("#google-mode").value || "web";
    settings.translation.google.apiKey = clean($("#google-api-key").value);
    settings.translation.baidu.enabled = $("#baidu-enabled").checked;
    settings.translation.baidu.apiKey = clean($("#baidu-api-key").value);
    settings.translation.baidu.secretKey = clean($("#baidu-secret-key").value);
    settings.dictionary.youdaoDictionary.enabled = $("#youdao-dictionary-enabled").checked;
    settings.dictionary.freeDictionary.enabled = $("#free-dictionary-enabled").checked;
    settings.dictionary.serviceOrder = [...document.querySelectorAll("#dictionary-service-order .service-order-row")]
      .map(row => row.dataset.serviceId)
      .filter(Boolean);
    settings.behavior.selectionLookup = $("#selection-enabled").checked;
    settings.behavior.selectionMaxLength = Number(settings.behavior.selectionMaxLength) || 500;
    settings.appearance.fontScale = Math.max(100, Math.min(145, Number($("#font-scale").value) || 115));
    settings.shortcuts.showWindow = clean($("#shortcut-show-window").dataset.accelerator);
    settings.shortcuts.selectionLookup = clean($("#shortcut-selection-lookup").dataset.accelerator);
    settings.window.hideOnClose = $("#hide-on-close").checked;
    settings.window.alwaysOnTop = state.pinned;
    return settings;
  }

  async function openSettings() {
    fillSettings();
    try {
      await api.suspendShortcuts();
    } catch (error) {
      $("#settings-status").textContent = `快捷键暂时停用失败：${error.message || error}`;
    }
    if (!$("#settings-dialog").open) $("#settings-dialog").showModal();
  }

  function bindEvents() {
    $("#word-button").addEventListener("click", () => runManual("word"));
    $("#drug-button").addEventListener("click", () => runManual("drug"));
    $("#clear-button").addEventListener("click", () => {
      state.requestId += 1;
      state.activeSelectionRequestId = null;
      setActiveMode("word");
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

    $("#settings-button").addEventListener("click", () => { void openSettings(); });
    $("#selection-status").addEventListener("click", () => { void openSettings(); });
    $("#close-settings-button").addEventListener("click", () => {
      applyFontScale(state.settings?.appearance?.fontScale);
      $("#settings-dialog").close();
    });
    $("#cancel-settings-button").addEventListener("click", () => {
      applyFontScale(state.settings?.appearance?.fontScale);
      $("#settings-dialog").close();
    });
    $("#google-mode").addEventListener("change", updateGoogleMode);
    $("#dictionary-service-order").addEventListener("click", event => {
      const button = event.target.closest("[data-service-move]");
      if (!button || button.disabled) return;
      const rows = [...document.querySelectorAll("#dictionary-service-order .service-order-row")];
      const index = rows.indexOf(button.closest(".service-order-row"));
      const direction = button.dataset.serviceMove === "up" ? -1 : 1;
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= rows.length) return;
      const order = rows.map(row => row.dataset.serviceId);
      [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
      renderDictionaryServiceOrder(order);
    });
    $("#font-scale").addEventListener("change", event => applyFontScale(event.target.value));
    document.querySelectorAll(".shortcut-input").forEach(bindShortcutRecorder);
    document.querySelectorAll("[data-clear-shortcut]").forEach(button => {
      button.addEventListener("click", () => {
        setShortcutField(button.dataset.clearShortcut, "");
        $("#settings-status").textContent = "快捷键已清除，保存后生效";
      });
    });
    $("#settings-dialog").addEventListener("close", () => {
      applyFontScale(state.settings?.appearance?.fontScale);
      api.resumeShortcuts().catch(error => setRequestStatus(`快捷键恢复失败：${error.message || error}`, "error"));
    });
    $("#settings-form").addEventListener("submit", async event => {
      event.preventDefault();
      const next = readSettings();
      if (next.shortcuts.showWindow && next.shortcuts.showWindow.toLowerCase() === next.shortcuts.selectionLookup.toLowerCase()) {
        $("#settings-status").textContent = "两个功能不能使用同一个快捷键";
        return;
      }
      if (next.translation.google.enabled && next.translation.google.mode === "cloud" && !next.translation.google.apiKey) {
        $("#settings-status").textContent = "请填写 Google Cloud Key";
        return;
      }
      if (next.translation.baidu.enabled && (!next.translation.baidu.apiKey || !next.translation.baidu.secretKey)) {
        $("#settings-status").textContent = "请填写百度 API Key 和 Secret Key";
        return;
      }
      $("#settings-status").textContent = "保存中…";
      try {
        state.settings = await api.saveSettings(next);
        applyFontScale(state.settings.appearance?.fontScale);
        $("#settings-status").textContent = "已保存";
        setTimeout(() => {
          if ($("#settings-dialog").open) $("#settings-dialog").close();
        }, 320);
      } catch (error) {
        $("#settings-status").textContent = error.message || String(error);
        api.suspendShortcuts().catch(() => {});
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
      const expandExamples = event.target.closest("[data-expand-examples]");
      if (expandExamples) {
        const more = expandExamples.parentElement?.querySelector(".dictionary-example-more");
        if (!more) return;
        const expanded = expandExamples.dataset.expanded === "true";
        more.hidden = expanded;
        expandExamples.dataset.expanded = String(!expanded);
        expandExamples.textContent = expanded
          ? `显示更多例句（${expandExamples.dataset.moreCount || 0}）`
          : "收起例句";
        return;
      }
      const copyControl = event.target.closest("[data-copy-scope]");
      if (copyControl) {
        event.preventDefault();
        event.stopPropagation();
        void copyFromButton(copyControl);
        return;
      }
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
      setActiveMode("selection");
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
    api.onSelectionEmpty(payload => {
      state.activeSelectionRequestId = null;
      setActiveMode("word");
      setBusy(false);
      setRequestStatus(payload?.message || "未读取到选中文本", "error");
      $("#query-input").focus();
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
      applyFontScale(settings.appearance?.fontScale);
      setActiveMode("word");
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
