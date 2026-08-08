"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForTarget(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(target => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) {}
    await delay(250);
  }
  throw new Error("Medict DevTools target did not become available");
}

async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("Could not connect to Medict DevTools"));
  });
  return {
    close: () => socket.close(),
    send(method, params = {}) {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    }
  };
}

async function main() {
  const executable = path.resolve("release", "win-unpacked", "Medict.exe");
  const port = 9300 + Math.floor(Math.random() * 500);
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "medict-layout-"));
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${userData}`
  ], { stdio: "ignore", windowsHide: true });
  let client = null;
  try {
    const target = await waitForTarget(port);
    client = await connect(target.webSocketDebuggerUrl);
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    const readyDeadline = Date.now() + 10000;
    let rendererReady = false;
    while (Date.now() < readyDeadline) {
      const readiness = await client.send("Runtime.evaluate", {
        expression: `Boolean(document.querySelector("#results .empty-state"))`,
        returnByValue: true
      });
      rendererReady = Boolean(readiness.result?.value);
      if (rendererReady) break;
      await delay(200);
    }
    if (!rendererReady) throw new Error("Medict renderer did not finish initialization");
    const initialResult = await client.send("Runtime.evaluate", {
      expression: `({
        source: document.querySelector("#source-language")?.value,
        target: document.querySelector("#target-language")?.value,
        hasHistory: Boolean(document.querySelector("#history-button")),
        hasTrash: Boolean(document.querySelector("#clear-button svg"))
      })`,
      returnByValue: true
    });
    const initialUi = initialResult.result?.value || {};
    if (initialUi.source !== "auto" || initialUi.target !== "zh-CN" || !initialUi.hasHistory || !initialUi.hasTrash) {
      throw new Error(`Language/history controls were not initialized: ${JSON.stringify(initialUi)}`);
    }
    const lookupStartedAt = Date.now();
    await client.send("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector("#query-input");
        input.value = "happy";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#word-button").click();
        return true;
      })()`,
      returnByValue: true
    });

    let rows = [];
    let firstResultMs = null;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const evaluation = await client.send("Runtime.evaluate", {
        expression: `(() => [...document.querySelectorAll(".dictionary-example-row")].slice(0, 5).map(row => {
          const content = row.querySelector(".dictionary-example-content");
          const english = row.querySelector(".dictionary-example-en");
          const lineHeight = Number.parseFloat(getComputedStyle(english).lineHeight) || 1;
          return {
            text: english?.textContent?.trim() || "",
            hasAudio: Boolean(row.querySelector(".example-audio")),
            rowWidth: Math.round(row.getBoundingClientRect().width),
            contentWidth: Math.round(content?.getBoundingClientRect().width || 0),
            gridColumnStart: getComputedStyle(content).gridColumnStart,
            visualLines: Math.round((english?.scrollHeight || 0) / lineHeight)
          };
        }))()`,
        returnByValue: true
      });
      rows = evaluation.result?.value || [];
      if (rows.length >= 4) {
        firstResultMs = Date.now() - lookupStartedAt;
        break;
      }
      await delay(400);
    }
    if (rows.length < 4) {
      const status = await client.send("Runtime.evaluate", {
        expression: `({ request: document.querySelector("#request-status")?.textContent, results: document.querySelector("#results")?.innerText?.slice(0, 500) })`,
        returnByValue: true
      });
      throw new Error(`Expected at least 4 examples, found ${rows.length}: ${JSON.stringify(status.result?.value)}`);
    }
    const noAudio = rows.find(row => !row.hasAudio);
    if (!noAudio) throw new Error("Expected an example without audio");
    if (noAudio.gridColumnStart !== "2" || noAudio.contentWidth < noAudio.rowWidth * 0.7) {
      throw new Error(`No-audio example is still narrow: ${JSON.stringify(noAudio)}`);
    }
    if (noAudio.visualLines > 3) {
      throw new Error(`No-audio example still wraps excessively: ${JSON.stringify(noAudio)}`);
    }

    const readConciseEntry = () => client.send("Runtime.evaluate", {
      expression: `(() => {
        const entry = [...document.querySelectorAll(".dictionary-entry")].find(item =>
          item.querySelector(".word-head > strong")?.textContent?.trim()?.toLowerCase() === "happy" &&
          item.querySelectorAll(".pronunciation-button").length === 2
        );
        if (!entry) return null;
        const fontSize = selector => {
          const element = entry.querySelector(selector);
          return element ? Number.parseFloat(getComputedStyle(element).fontSize) : null;
        };
        return {
          groups: [...entry.querySelectorAll(":scope > .meaning-group")].map(group => ({
            heading: group.querySelector(".meaning-heading strong")?.textContent?.trim() || "",
            translation: group.querySelector(".sense-translation")?.textContent?.trim() || ""
          })),
          containsPlaceholder: entry.textContent.includes("暂无英文释义"),
          pronunciations: [...entry.querySelectorAll(".pronunciation-button")].map(button => ({
            label: button.querySelector(".pronunciation-label")?.textContent?.trim() || "",
            url: button.dataset.audioUrl || ""
          })),
          titleSizes: [
            entry.querySelector(".detail-heading"),
            ...entry.querySelectorAll(".dictionary-extra > summary")
          ].filter(Boolean).map(element => Number.parseFloat(getComputedStyle(element).fontSize)),
          auxiliarySizes: {
            tag: fontSize(".dictionary-tags span"),
            wordForm: fontSize(".word-form"),
            related: fontSize(".sense-related, .dictionary-phrase-row"),
            example: fontSize(".dictionary-example-en"),
            sense: fontSize(".sense-translation")
          }
        };
      })()`,
      returnByValue: true
    });
    let concise = null;
    const conciseDeadline = Date.now() + 5000;
    while (Date.now() < conciseDeadline && !concise) {
      const conciseResult = await readConciseEntry();
      concise = conciseResult.result?.value || null;
      if (!concise) await delay(100);
    }
    if (!concise || concise.groups.length !== 3) {
      const diagnosticResult = await client.send("Runtime.evaluate", {
        expression: `({
          status: document.querySelector("#request-status")?.textContent?.trim() || "",
          badge: document.querySelector(".source-badge")?.textContent?.trim() || "",
          entries: [...document.querySelectorAll(".dictionary-entry")].map(entry => ({
            word: entry.querySelector(".word-head > strong")?.textContent?.trim() || "",
            pronunciations: entry.querySelectorAll(".pronunciation-button").length,
            source: entry.querySelector(".source-meta")?.textContent?.trim() || "",
            text: entry.textContent.trim().slice(0, 300)
          })),
          warnings: [...document.querySelectorAll(".warning-details")].map(item => item.textContent.trim()),
          text: document.querySelector("#results")?.innerText?.slice(0, 1000) || ""
        })`,
        returnByValue: true
      });
      throw new Error(`Expected the 3 Youdao concise rows for happy: ${JSON.stringify({ concise, diagnostic: diagnosticResult.result?.value })}`);
    }
    if (concise.groups.some(group => group.heading === "其他释义") || concise.groups.filter(group => group.heading === "【名】").length !== 1) {
      throw new Error(`Happy still contains a duplicate other/named meaning: ${JSON.stringify(concise)}`);
    }
    if (concise.containsPlaceholder) {
      throw new Error(`Youdao concise rows still render the empty English-definition placeholder: ${JSON.stringify(concise)}`);
    }
    if (concise.pronunciations.length !== 2 || concise.pronunciations.map(row => row.label).join(",") !== "英,美") {
      throw new Error(`Expected separate UK and US pronunciation buttons: ${JSON.stringify(concise.pronunciations)}`);
    }
    if (!/type=1$/.test(concise.pronunciations[0].url) || !/type=2$/.test(concise.pronunciations[1].url)) {
      throw new Error(`UK/US pronunciation URLs are not distinct: ${JSON.stringify(concise.pronunciations)}`);
    }
    if (!concise.titleSizes.length || new Set(concise.titleSizes.map(size => size.toFixed(2))).size !== 1 || concise.titleSizes[0] < 13) {
      throw new Error(`Dictionary section titles are not a uniform enlarged size: ${JSON.stringify(concise.titleSizes)}`);
    }
    if (concise.auxiliarySizes.tag < 11 || concise.auxiliarySizes.wordForm < 12 || concise.auxiliarySizes.related < 12 || concise.auxiliarySizes.example < concise.auxiliarySizes.sense) {
      throw new Error(`Dictionary supporting text is still too small: ${JSON.stringify(concise.auxiliarySizes)}`);
    }

    const finalDeadline = Date.now() + 30000;
    while (Date.now() < finalDeadline) {
      const status = await client.send("Runtime.evaluate", {
        expression: `document.querySelector("#request-status")?.textContent || ""`,
        returnByValue: true
      });
      if (!/补充服务加载中|正在查询/.test(status.result?.value || "")) break;
      await delay(250);
    }

    await client.send("Runtime.evaluate", {
      expression: `document.querySelector("#history-button").click()`,
      returnByValue: true
    });
    const historyResult = await client.send("Runtime.evaluate", {
      expression: `({
        open: !document.querySelector("#history-popover").hidden,
        rows: [...document.querySelectorAll(".history-item")].map(item => item.textContent.trim())
      })`,
      returnByValue: true
    });
    const history = historyResult.result?.value || {};
    if (!history.open || !history.rows?.[0]?.includes("happy")) {
      throw new Error(`Recent query history did not contain happy: ${JSON.stringify(history)}`);
    }
    const historyReplayStartedAt = Date.now();
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector(".history-item").click()`,
      returnByValue: true
    });
    const historyReplayDeadline = Date.now() + 3000;
    let historyReplayStatus = "";
    while (Date.now() < historyReplayDeadline) {
      const replay = await client.send("Runtime.evaluate", {
        expression: `document.querySelector("#request-status")?.textContent || ""`,
        returnByValue: true
      });
      historyReplayStatus = replay.result?.value || "";
      if (/缓存返回|在线词典已返回/.test(historyReplayStatus)) break;
      await delay(50);
    }
    const historyReplayMs = Date.now() - historyReplayStartedAt;
    if (!/缓存返回/.test(historyReplayStatus) || historyReplayMs > 1000) {
      throw new Error(`History replay did not use the word cache quickly: ${JSON.stringify({ historyReplayMs, historyReplayStatus })}`);
    }

    const swappedResult = await client.send("Runtime.evaluate", {
      expression: `(() => {
        document.querySelector("#swap-languages-button").click();
        return {
          source: document.querySelector("#source-language").value,
          target: document.querySelector("#target-language").value
        };
      })()`,
      returnByValue: true
    });
    const swapped = swappedResult.result?.value || {};
    if (swapped.source !== "zh-CN" || swapped.target !== "en") {
      throw new Error(`Automatic language swap did not produce Chinese to English: ${JSON.stringify(swapped)}`);
    }

    const chineseLookupStartedAt = Date.now();
    await client.send("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector("#query-input");
        input.value = "快乐";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector("#word-button").click();
        return true;
      })()`,
      returnByValue: true
    });
    let chineseEntry = null;
    const chineseDeadline = Date.now() + 15000;
    while (Date.now() < chineseDeadline && !chineseEntry) {
      const result = await client.send("Runtime.evaluate", {
        expression: `(() => {
          const entry = [...document.querySelectorAll(".dictionary-entry")].find(item =>
            item.querySelector(".word-head > strong")?.textContent?.trim() === "快乐"
          );
          if (!entry) return null;
          return {
            word: entry.querySelector(".word-head > strong")?.textContent?.trim() || "",
            translation: entry.querySelector(".sense-translation")?.textContent?.trim() || "",
            pronunciation: entry.querySelector(".pronunciation-label")?.textContent?.trim() || "",
            badge: document.querySelector(".source-badge")?.textContent?.trim() || ""
          };
        })()`,
        returnByValue: true
      });
      chineseEntry = result.result?.value || null;
      if (!chineseEntry) await delay(100);
    }
    const chineseFirstResultMs = Date.now() - chineseLookupStartedAt;
    if (!chineseEntry || !/[A-Za-z]/.test(chineseEntry.translation)) {
      throw new Error(`Chinese to English dictionary lookup did not return an English meaning: ${JSON.stringify(chineseEntry)}`);
    }

    const cacheBeforeResult = await client.send("Runtime.evaluate", {
      expression: `window.medict.getDrugCacheStats()`,
      awaitPromise: true,
      returnByValue: true
    });
    const drugCacheBefore = Number(cacheBeforeResult.result?.value?.count || 0);
    await client.send("Runtime.evaluate", {
      expression: `window.medict.lookupSelection("happy")`,
      awaitPromise: true,
      returnByValue: true
    });
    await delay(400);
    const selectionResult = await client.send("Runtime.evaluate", {
      expression: `(async () => ({
        headings: [...document.querySelectorAll(".result-block > .result-block-heading .heading-label")].map(item => item.textContent.trim()),
        status: document.querySelector("#request-status")?.textContent?.trim() || "",
        hasDrugText: document.querySelector("#results")?.innerText?.includes("未找到该药物") || false,
        drugCacheCount: Number((await window.medict.getDrugCacheStats())?.count || 0)
      }))()`,
      awaitPromise: true,
      returnByValue: true
    });
    const selection = selectionResult.result?.value || {};
    if (selection.headings?.join(",") !== "WORD" || selection.hasDrugText || selection.drugCacheCount !== drugCacheBefore) {
      throw new Error(`Selection lookup still rendered a drug result: ${JSON.stringify(selection)}`);
    }

    await client.send("Runtime.evaluate", {
      expression: `document.querySelector("#results").scrollTop = 0`,
      returnByValue: true
    });
    await delay(300);
    const conciseScreenshot = await client.send("Page.captureScreenshot", { format: "png" });
    const conciseScreenshotPath = path.resolve("artifacts", "selection-word-only-check.png");
    await fs.mkdir(path.dirname(conciseScreenshotPath), { recursive: true });
    await fs.writeFile(conciseScreenshotPath, Buffer.from(conciseScreenshot.data, "base64"));

    await client.send("Runtime.evaluate", {
      expression: `document.querySelector(".dictionary-extra")?.scrollIntoView({ block: "start" })`,
      returnByValue: true
    });
    await delay(300);
    const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
    const screenshotPath = path.resolve("artifacts", "example-layout-check.png");
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    console.log(JSON.stringify({
      timing: { firstResultMs, historyReplayMs, chineseFirstResultMs },
      languagePair: swapped,
      chineseEntry,
      rows,
      concise,
      selection,
      conciseScreenshotPath,
      screenshotPath
    }, null, 2));
  } finally {
    client?.close();
    child.kill();
    await delay(700);
    await fs.rm(userData, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
