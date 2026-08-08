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
      if (rows.length >= 4) break;
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

    const conciseResult = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const entry = document.querySelector(".dictionary-entry");
        if (!entry) return null;
        return {
          groups: [...entry.querySelectorAll(":scope > .meaning-group")].map(group => ({
            heading: group.querySelector(".meaning-heading strong")?.textContent?.trim() || "",
            translation: group.querySelector(".sense-translation")?.textContent?.trim() || ""
          })),
          containsPlaceholder: entry.textContent.includes("暂无英文释义")
        };
      })()`,
      returnByValue: true
    });
    const concise = conciseResult.result?.value;
    if (!concise || concise.groups.length !== 3) {
      throw new Error(`Expected the 3 Youdao concise rows for happy: ${JSON.stringify(concise)}`);
    }
    if (concise.groups.some(group => group.heading === "其他释义") || concise.groups.filter(group => group.heading === "【名】").length !== 1) {
      throw new Error(`Happy still contains a duplicate other/named meaning: ${JSON.stringify(concise)}`);
    }
    if (concise.containsPlaceholder) {
      throw new Error(`Youdao concise rows still render the empty English-definition placeholder: ${JSON.stringify(concise)}`);
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
    console.log(JSON.stringify({ rows, concise, selection, conciseScreenshotPath, screenshotPath }, null, 2));
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
