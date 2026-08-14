const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

function parseSelectionLine(line) {
  const value = String(line || "").trim();
  if (value === "READY") return { type: "ready" };
  if (value === "KEYBOARD_READY") return { type: "keyboard-ready" };
  if (value === "EMPTY") return { type: "empty" };
  if (value.startsWith("ERROR\t")) return { type: "error", message: value.slice(6).trim() };
  const isShortcutText = value.startsWith("SHORTCUT_TEXT\t");
  if (!isShortcutText && !value.startsWith("TEXT\t")) return null;
  try {
    const encoded = isShortcutText ? value.slice("SHORTCUT_TEXT\t".length) : value.slice(5);
    const text = Buffer.from(encoded, "base64").toString("utf8").trim();
    return text ? { type: isShortcutText ? "shortcut-text" : "text", text } : null;
  } catch (_) {
    return null;
  }
}

function captureSelectionAttempt(executablePath, { windowHandle = 0, timeout = 3000 } = {}) {
  if (process.platform !== "win32") return Promise.resolve("");
  if (!executablePath || !fs.existsSync(executablePath)) {
    return Promise.reject(new Error("划词助手未编译"));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, ["--capture-once", String(windowHandle || 0)], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, text = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(String(text || "").trim());
    };
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
      finish(null, "");
    }, Math.max(500, Number(timeout) || 3000));

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += String(chunk || ""); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += String(chunk || ""); });
    child.on("error", error => finish(error));
    child.on("exit", code => {
      const events = stdout.split(/\r?\n/).map(parseSelectionLine).filter(Boolean);
      const textEvent = events.find(event => event.type === "text");
      const errorEvent = events.find(event => event.type === "error");
      if (textEvent) finish(null, textEvent.text);
      else if (errorEvent) finish(new Error(errorEvent.message));
      else if (code && code !== 0) finish(new Error(stderr.trim() || `划词助手异常退出（${code}）`));
      else finish(null, "");
    });
  });
}

function captureSelectionOnce(executablePath, { windowHandle = 0, timeout = 3000 } = {}) {
  if (process.platform !== "win32") return Promise.resolve("");
  if (!executablePath || !fs.existsSync(executablePath)) {
    return Promise.reject(new Error("划词助手未编译"));
  }

  const totalTimeout = Math.max(1000, Number(timeout) || 3000);
  const attemptTimeout = Math.max(700, Math.floor(totalTimeout * 0.62));
  return captureSelectionAttempt(executablePath, { windowHandle, timeout: attemptTimeout })
    .then(async text => {
      if (text) return text;
      await new Promise(resolve => setTimeout(resolve, 90));
      return captureSelectionAttempt(executablePath, {
        windowHandle,
        timeout: Math.max(700, totalTimeout - attemptTimeout - 90)
      });
    });
}

class SelectionMonitor extends EventEmitter {
  constructor(executablePath) {
    super();
    this.executablePath = executablePath;
    this.process = null;
    this.buffer = "";
    this.startOptions = null;
    this.restartTimer = null;
    this.restartAttempts = 0;
    this.stopRequested = false;
    this.keyboardReady = false;
  }

  start({ parentPid, windowHandle, shortcut = "", mouseSelectionEnabled = true }) {
    if (this.process || process.platform !== "win32") return false;
    if (!this.executablePath || !fs.existsSync(this.executablePath)) {
      this.emit("status", { available: false, active: false, message: "划词助手未编译" });
      return false;
    }

    this.startOptions = {
      parentPid,
      windowHandle,
      shortcut: String(shortcut || ""),
      mouseSelectionEnabled: Boolean(mouseSelectionEnabled)
    };
    this.keyboardReady = false;
    this.restartAttempts = 0;
    this.stopRequested = false;
    return this.spawnMonitor();
  }

  spawnMonitor() {
    if (this.process || this.stopRequested || !this.startOptions) return false;
    const { parentPid, windowHandle, shortcut, mouseSelectionEnabled } = this.startOptions;
    this.keyboardReady = false;
    const child = spawn(this.executablePath, [
      String(parentPid || process.pid),
      String(windowHandle || 0),
      shortcut,
      mouseSelectionEnabled ? "1" : "0"
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => this.handleOutput(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      const message = String(chunk || "").trim();
      if (message) this.emit("status", { available: true, active: false, message });
    });
    child.on("error", error => {
      this.emit("status", { available: false, active: false, message: error.message });
    });
    child.on("exit", code => {
      if (this.process === child) this.process = null;
      this.emit("status", {
        available: true,
        active: false,
        message: code === 0 || code == null ? "划词助手已停止" : `划词助手异常退出（${code}）`
      });
      if (!this.stopRequested && this.startOptions && this.restartAttempts < 3) {
        this.restartAttempts += 1;
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.spawnMonitor();
        }, 700);
      }
    });
    return true;
  }

  handleOutput(chunk) {
    this.buffer += String(chunk || "");
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      const event = parseSelectionLine(line);
      if (!event) continue;
      if (event.type === "ready") {
        const active = Boolean(this.startOptions?.mouseSelectionEnabled);
        this.emit("status", {
          available: true,
          active,
          message: active ? "自动划词已开启" : "自动划词已关闭，快捷键仍可用"
        });
      } else if (event.type === "keyboard-ready") {
        this.keyboardReady = true;
      } else if (event.type === "text") {
        this.emit("text", event.text);
      } else if (event.type === "shortcut-text") {
        this.emit("shortcut-text", event.text);
      } else if (event.type === "empty") {
        this.emit("empty");
      } else {
        this.emit("status", { available: true, active: false, message: event.message });
      }
    }
  }

  stop() {
    this.stopRequested = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.startOptions = null;
    this.keyboardReady = false;
    const child = this.process;
    this.process = null;
    if (child && !child.killed) child.kill();
  }

  hasKeyboardShortcut() {
    return Boolean(this.startOptions?.shortcut && this.keyboardReady && this.process && !this.process.killed);
  }
}

module.exports = {
  captureSelectionOnce,
  parseSelectionLine,
  SelectionMonitor
};
