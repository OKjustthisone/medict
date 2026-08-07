const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

function parseSelectionLine(line) {
  const value = String(line || "").trim();
  if (value === "READY") return { type: "ready" };
  if (value.startsWith("ERROR\t")) return { type: "error", message: value.slice(6).trim() };
  if (!value.startsWith("TEXT\t")) return null;
  try {
    const text = Buffer.from(value.slice(5), "base64").toString("utf8").trim();
    return text ? { type: "text", text } : null;
  } catch (_) {
    return null;
  }
}

class SelectionMonitor extends EventEmitter {
  constructor(executablePath) {
    super();
    this.executablePath = executablePath;
    this.process = null;
    this.buffer = "";
  }

  start({ parentPid, windowHandle }) {
    if (this.process || process.platform !== "win32") return false;
    if (!this.executablePath || !fs.existsSync(this.executablePath)) {
      this.emit("status", { available: false, active: false, message: "划词助手未编译" });
      return false;
    }

    const child = spawn(this.executablePath, [String(parentPid || process.pid), String(windowHandle || 0)], {
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
        this.emit("status", { available: true, active: true, message: "自动划词已开启" });
      } else if (event.type === "text") {
        this.emit("text", event.text);
      } else {
        this.emit("status", { available: true, active: false, message: event.message });
      }
    }
  }

  stop() {
    const child = this.process;
    this.process = null;
    if (child && !child.killed) child.kill();
  }
}

module.exports = {
  parseSelectionLine,
  SelectionMonitor
};
