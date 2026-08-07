const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.argv[2] || 9333);
const command = process.argv[3] || "smoke";
const root = path.resolve(__dirname, "..");
const artifactDirectory = path.join(root, "artifacts");

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime evaluation failed");
  return result.result?.value;
}

async function waitFor(client, expression, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(client, expression)) return true;
    await delay(250);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function screenshot(client, fileName) {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false
  });
  const filePath = path.join(artifactDirectory, fileName);
  fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
  return filePath;
}

async function main() {
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const target = targets.find(item => item.type === "page" && item.title === "Medict") || targets.find(item => item.type === "page");
  if (!target?.webSocketDebuggerUrl) throw new Error("Medict debug target not found");

  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await waitFor(client, "document.readyState === 'complete' && Boolean(window.medict)", 10000);

  if (command === "quit") {
    await evaluate(client, "window.medict.quit()");
    client.close();
    console.log("Medict quit requested");
    return;
  }

  if (command === "wait-selection") {
    await waitFor(client, "!/并行执行中|查询中/.test(document.querySelector('#request-status').textContent)", 55000);
  }

  if (command === "inspect" || command === "wait-selection") {
    const inspection = {
      query: await evaluate(client, "document.querySelector('#query-input').value"),
      requestStatus: await evaluate(client, "document.querySelector('#request-status').textContent"),
      selectionStatus: await evaluate(client, "document.querySelector('.selection-label').textContent"),
      windowAlwaysOnTop: await evaluate(client, "window.medict.isPinned()"),
      results: await evaluate(client, "document.querySelector('#results').innerText"),
      warnings: await evaluate(client, "[...document.querySelectorAll('.warning-details li')].map(item => item.textContent)"),
      geometry: await evaluate(client, `(() => {
        const ids = ['.titlebar', '.query-card', '.action-row', '.status-row', '#results'];
        return {
          scrollY,
          documentScrollTop: document.documentElement.scrollTop,
          bodyScrollTop: document.body.scrollTop,
          rows: Object.fromEntries(ids.map(selector => {
            const element = document.querySelector(selector);
            const rect = element.getBoundingClientRect();
            return [selector, { top: rect.top, bottom: rect.bottom, height: rect.height, display: getComputedStyle(element).display }];
          }))
        };
      })()`),
      screenshot: await screenshot(client, "medict-selection.png")
    };
    client.close();
    console.log(JSON.stringify(inspection, null, 2));
    return;
  }

  const report = {
    viewport: await evaluate(client, "({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })"),
    idleText: await evaluate(client, "document.body.innerText"),
    screenshots: {}
  };
  report.screenshots.idle = await screenshot(client, "medict-idle.png");

  await evaluate(client, `(() => {
    const input = document.querySelector('#query-input');
    input.value = 'serendipity';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#word-button').click();
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#word-button').disabled && /完成|命中|失败/.test(document.querySelector('#request-status').textContent)", 30000);
  report.word = {
    status: await evaluate(client, "document.querySelector('#request-status').textContent"),
    text: await evaluate(client, "document.querySelector('#results').innerText"),
    warnings: await evaluate(client, "[...document.querySelectorAll('.warning-details li')].map(item => item.textContent)")
  };
  report.screenshots.word = await screenshot(client, "medict-word-google.png");

  await evaluate(client, `(() => {
    const input = document.querySelector('#query-input');
    input.value = 'aspirin';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#drug-button').click();
    return true;
  })()`);
  await waitFor(client, "!document.querySelector('#drug-button').disabled && /已返回|未找到|失败/.test(document.querySelector('#request-status').textContent)", 55000);
  report.drug = {
    status: await evaluate(client, "document.querySelector('#request-status').textContent"),
    text: await evaluate(client, "document.querySelector('#results').innerText"),
    warnings: await evaluate(client, "[...document.querySelectorAll('.warning-details li')].map(item => item.textContent)")
  };
  report.screenshots.drug = await screenshot(client, "medict-drug-aspirin.png");
  report.selectionStatus = await evaluate(client, "document.querySelector('.selection-label').textContent");
  client.close();
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
