const path = require("node:path");
const fs = require("node:fs");
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray
} = require("electron");
const { DictionaryManager } = require("./dictionary-manager");
const { DrugCache } = require("./drug-cache");
const { registerShortcutConfiguration, validateShortcutConfiguration } = require("./shortcut-manager");
const { captureSelectionOnce, SelectionMonitor } = require("./selection-monitor");
const { searchDrug } = require("./services/drugshop");
const { lookupWord } = require("./services/word-lookup");
const { mergeSettings, SettingsStore } = require("./store");

const TRAY_ICON_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAADOElEQVR4nKWTW2hURxjHv5k5t8Q02YitituKsjQVibWbCNFaNW1ajVqq0s2DLbRSjGAR30QKmraWgtIQqIKoUNs+aN3Qhl7wgtpAbbNSNCYYMBe1Xd1Ns3E3Odk9Z3fPXMvZJuBr8Q/zMA/ff358/AZ1d3droReWv6KUNE0JWYEtBuU6eJMpQkxLKNAVTEfXdTB0Hee9fDWSigbnBX5DD8azazBVY8Fg1TD8jyQSU89LA83DihUsf/h028LA7cbnvojv2d4/du5Yb2zl3I8jAGWANYhGIoZSCj92iD+jpDQgOe6FW+tAv7PxxZhoXKfSzZsUv3hZqa5OdXP9stgxE0KACKi2tdrM69MlKD5q14Gt1OKehoqtbMOr6uGq1cXhcFgMNb0mUqe/ofTqr6r/neZHZwOw+b/BKFEAyC/w7/FRu14rAMgyUlHPqBKUUyIxxl5yFBId7Ti3ZYtYtPOjOWULFv38h/PTQYRaDgHCcOPkLp9G+iXYAgBPFuJccMKFlIwxEJoGNJ+H0W+/JoNfHpXzd7wvV3Wc+XTk1Lof9itZXb/rK+aT6LqusONC1dDk1Pd/q4kJSyKDcs4ZpSA1AoUsBcWGsVkdw2zK4aF3P9/64XctsegKvhwBqGJxQtPYeMJ6bxAyF5akXuc0cGYWNWsyUvKCU9DMhVVQ274BpPMXeKkezZGVPLh+d02DMfdSx46jNYFgsIiJ9ZTwcZq7Mr3XX7q7Ml1pd1nANYmxXHq4UeqzAGgmC5Ij4JkR7Z/z++mzteFnmj5rfdsDmCpt08e5cWKnvvs4TK7+M7ktIVIHl+wL4zkvL8BuMi0kLYBwsyCpBOHmcO7KAUHvnV1cWiJMp671RIkkui1C3rqfP2RXpN9M9wykqyxJeN5lzHUld3JSUipkkRP7Ya6vDAD7BcqXYoakpbNTdK8FrfaD33+51n6u4UHvyPUAKuqmKGKdF/Bs5Zj34+7Ngf7Qj67tBiA+ZjdN20Ue13Ug2mb4gL7OfW2hIyNHQneGPpk/dGtv4Hg0Enq6JFIy9cYTfyZfS5IYs9cojIxys3ySMlaSaSYIGEKiSIg1m4MOQDzH8IRWiRD27g72XfsX+KbNA7ogSOYAAAAASUVORK5CYII=";

let mainWindow = null;
let tray = null;
let dictionaryManager = null;
let drugCache = null;
let settingsStore = null;
let selectionMonitor = null;
let selectionStatus = { available: false, active: false, message: "自动划词尚未启动" };
let selectionRequestId = 0;
let isQuitting = false;
let temporarySelectionTop = false;
let shortcutCaptureInFlight = false;
let shortcutsSuspended = false;

const ATOM_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="2" y="2" width="60" height="60" rx="16" fill="#4c72e8"/><g fill="none" stroke="#fff" stroke-linecap="round" stroke-width="3.1" opacity=".94"><ellipse cx="32" cy="32" rx="23" ry="9"/><ellipse cx="32" cy="32" rx="23" ry="9" transform="rotate(60 32 32)"/><ellipse cx="32" cy="32" rx="23" ry="9" transform="rotate(-60 32 32)"/></g><circle cx="32" cy="32" r="6.5" fill="#e9fbff"/><circle cx="32" cy="32" r="3.5" fill="#27a9d4"/></svg>`;

function appIconPath() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "medict.ico"), path.join(app.getAppPath(), "build", "medict.ico")]
    : [path.join(app.getAppPath(), "build", "medict.ico")];
  return candidates.find(candidate => fs.existsSync(candidate)) || "";
}

function createAppIcon() {
  const filePath = appIconPath();
  if (filePath) {
    const icon = nativeImage.createFromPath(filePath);
    if (!icon.isEmpty()) return icon;
  }
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(ATOM_ICON_SVG).toString("base64")}`);
}

function sendToRenderer(channel, value) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, value);
}

function showMainWindow({ focus = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (focus) {
    restoreConfiguredWindowTop();
    mainWindow.show();
    mainWindow.focus();
  } else {
    mainWindow.showInactive();
  }
}

function restoreConfiguredWindowTop() {
  if (!mainWindow || mainWindow.isDestroyed() || !temporarySelectionTop) return;
  temporarySelectionTop = false;
  mainWindow.setAlwaysOnTop(Boolean(settingsStore?.get().window?.alwaysOnTop), "floating");
}

function showNearCursor({ focus = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const bounds = mainWindow.getBounds();
  const area = display.workArea;
  const gap = 14;
  let x = point.x + gap;
  let y = point.y + gap;
  if (x + bounds.width > area.x + area.width) x = point.x - bounds.width - gap;
  if (y + bounds.height > area.y + area.height) y = point.y - bounds.height - gap;
  x = Math.max(area.x, Math.min(x, area.x + area.width - bounds.width));
  y = Math.max(area.y, Math.min(y, area.y + area.height - bounds.height));
  mainWindow.setPosition(Math.round(x), Math.round(y), false);
  if (!settingsStore.get().window?.alwaysOnTop) {
    temporarySelectionTop = true;
    mainWindow.setAlwaysOnTop(true, "pop-up-menu");
  }
  if (focus) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    mainWindow.showInactive();
  }
}

function nativeWindowHandle(window) {
  const value = window.getNativeWindowHandle();
  if (value.length >= 8) return value.readBigUInt64LE(0).toString();
  return String(value.readUInt32LE(0));
}

function selectionHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "SelectionHelper.exe")
    : path.join(app.getAppPath(), "build", "SelectionHelper.exe");
}

function publishSelectionStatus(status) {
  selectionStatus = { ...selectionStatus, ...status };
  sendToRenderer("selection:status", selectionStatus);
  updateTrayMenu();
}

function stopSelectionMonitor() {
  if (selectionMonitor) selectionMonitor.stop();
  selectionMonitor = null;
  publishSelectionStatus({ available: true, active: false, message: "自动划词已关闭" });
}

function startSelectionMonitor() {
  if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return;
  if (selectionMonitor?.process) return;
  selectionMonitor = new SelectionMonitor(selectionHelperPath());
  selectionMonitor.on("status", publishSelectionStatus);
  selectionMonitor.on("text", text => runSelectionLookup(text));
  const started = selectionMonitor.start({
    parentPid: process.pid,
    windowHandle: nativeWindowHandle(mainWindow)
  });
  if (!started) publishSelectionStatus({ active: false });
}

function syncSelectionMonitor() {
  if (settingsStore.get().behavior?.selectionLookup) startSelectionMonitor();
  else stopSelectionMonitor();
}

async function runWordLookup(query) {
  return lookupWord(query, {
    dictionaryManager,
    settings: settingsStore.get()
  });
}

async function runDrugLookup(query) {
  let cached = null;
  try {
    cached = await drugCache?.get(query);
  } catch (error) {
    console.warn("Medict drug cache could not be read:", error.message);
  }
  if (cached) {
    return {
      ...cached.result,
      cache: {
        hit: true,
        cachedAt: cached.cachedAt,
        expiresAt: cached.expiresAt,
        ttlDays: 7
      }
    };
  }

  const result = await searchDrug(query);
  try {
    const saved = await drugCache?.set(query, result);
    return {
      ...result,
      cache: {
        hit: false,
        cachedAt: saved?.cachedAt || Date.now(),
        expiresAt: saved?.expiresAt || Date.now() + (7 * 24 * 60 * 60 * 1000),
        ttlDays: 7
      }
    };
  } catch (error) {
    console.warn("Medict drug cache could not be updated:", error.message);
    return result;
  }
}

async function runSelectionLookup(rawText, options = {}) {
  const settings = settingsStore.get();
  if (!options.force && !settings.behavior?.selectionLookup) return;
  const limit = Math.max(20, Math.min(Number(settings.behavior.selectionMaxLength) || 500, 4000));
  const query = String(rawText || "").trim().slice(0, limit);
  if (!query) return;

  const requestId = ++selectionRequestId;
  showNearCursor({ focus: Boolean(options.focus) });
  sendToRenderer("selection:pending", { query, requestId });
  const [wordResult] = await Promise.allSettled([runWordLookup(query)]);
  if (requestId !== selectionRequestId) return;
  sendToRenderer("selection:result", {
    query,
    requestId,
    word: wordResult.status === "fulfilled" ? wordResult.value : null,
    errors: {
      word: wordResult.status === "rejected" ? String(wordResult.reason?.message || wordResult.reason) : ""
    }
  });
}

async function runShortcutLookup() {
  if (shortcutCaptureInFlight || !mainWindow || mainWindow.isDestroyed()) return;
  shortcutCaptureInFlight = true;
  try {
    const selected = await captureSelectionOnce(selectionHelperPath(), {
      windowHandle: nativeWindowHandle(mainWindow),
      timeout: 5200
    });
    if (selected) {
      await runSelectionLookup(selected, { force: true, focus: true });
      return;
    }
    showMainWindow();
    sendToRenderer("selection:empty", { message: "未读取到选中文本，请重新选择后按 Ctrl + Alt + D" });
  } catch (error) {
    showMainWindow();
    sendToRenderer("selection:empty", { message: `快捷键取词失败：${error.message || error}` });
  } finally {
    shortcutCaptureInFlight = false;
  }
}

function applyConfiguredShortcuts(settings) {
  return registerShortcutConfiguration(globalShortcut, settings?.shortcuts, {
    showWindow: () => showMainWindow(),
    selectionLookup: () => { void runShortcutLookup(); }
  });
}

function registerIpc() {
  ipcMain.handle("app:metadata", () => ({
    name: "Medict",
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath("userData"),
    selectionStatus
  }));

  ipcMain.handle("settings:get", () => settingsStore.get());
  ipcMain.handle("settings:save", async (_, value) => {
    const previous = settingsStore.get();
    const next = mergeSettings(value);
    next.shortcuts = validateShortcutConfiguration(next.shortcuts);
    const keepSuspended = shortcutsSuspended;
    let saved;
    try {
      applyConfiguredShortcuts(next);
      if (keepSuspended) globalShortcut.unregisterAll();
      saved = await settingsStore.save(next);
    } catch (error) {
      globalShortcut.unregisterAll();
      if (!keepSuspended) {
        try {
          applyConfiguredShortcuts(previous);
        } catch (restoreError) {
          console.warn("Medict shortcuts could not be restored:", restoreError.message);
        }
      }
      throw error;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      temporarySelectionTop = false;
      mainWindow.setAlwaysOnTop(Boolean(saved.window?.alwaysOnTop), "floating");
    }
    syncSelectionMonitor();
    return saved;
  });
  ipcMain.handle("dictionary:list", () => dictionaryManager.listSources());
  ipcMain.handle("dictionary:import", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "导入本地词典",
      properties: ["openFile"],
      filters: [
        { name: "Medict 词典文件", extensions: ["json", "csv", "txt"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true, sources: dictionaryManager.listSources() };
    }
    const sources = await dictionaryManager.importFile(result.filePaths[0]);
    return { canceled: false, sources };
  });

  ipcMain.handle("lookup:word", (_, query) => runWordLookup(query));
  ipcMain.handle("lookup:drug", (_, query) => runDrugLookup(query));
  ipcMain.handle("lookup:selection", (_, query) => runSelectionLookup(query));
  ipcMain.handle("selection:status", () => selectionStatus);
  ipcMain.handle("shortcuts:suspend", () => {
    shortcutsSuspended = true;
    globalShortcut.unregisterAll();
    return true;
  });
  ipcMain.handle("shortcuts:resume", () => {
    shortcutsSuspended = false;
    return applyConfiguredShortcuts(settingsStore.get());
  });
  ipcMain.handle("drug-cache:stats", () => drugCache?.stats() || { count: 0, ttlMs: 7 * 24 * 60 * 60 * 1000 });
  ipcMain.handle("clipboard:write-text", (_, value) => {
    const text = String(value || "").slice(0, 250000);
    if (!text.trim()) throw new Error("没有可复制的内容");
    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:hide", () => {
    restoreConfiguredWindowTop();
    mainWindow?.hide();
  });
  ipcMain.handle("window:toggle-pin", async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const settings = settingsStore.get();
    const pinned = !Boolean(settings.window?.alwaysOnTop);
    temporarySelectionTop = false;
    mainWindow.setAlwaysOnTop(pinned, "floating");
    settings.window.alwaysOnTop = pinned;
    await settingsStore.save(settings);
    return pinned;
  });
  ipcMain.handle("window:is-pinned", () => Boolean(mainWindow?.isAlwaysOnTop()));
  ipcMain.handle("app:quit", () => {
    isQuitting = true;
    app.quit();
  });
  ipcMain.handle("app:open-external", async (_, url) => {
    if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("只允许打开 http/https 链接");
    await shell.openExternal(String(url));
    return true;
  });
}

function createWindow() {
  const settings = settingsStore.get();
  mainWindow = new BrowserWindow({
    width: 420,
    height: 610,
    minWidth: 360,
    minHeight: 300,
    maxWidth: 560,
    maxHeight: 780,
    frame: false,
    show: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: Boolean(settings.window?.alwaysOnTop),
    backgroundColor: "#f5f5f3",
    title: "Medict",
    icon: createAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => {
    showMainWindow();
    syncSelectionMonitor();
  });
  if (!app.isPackaged && process.env.MEDICT_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
  mainWindow.on("close", event => {
    if (!isQuitting && settingsStore.get().window?.hideOnClose !== false) {
      event.preventDefault();
      restoreConfiguredWindowTop();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Medict", click: () => showMainWindow() },
    { label: selectionStatus.active ? "自动划词：已开启" : "自动划词：未开启", enabled: false },
    { type: "separator" },
    { label: "退出", click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function createTray() {
  const icon = createAppIcon();
  tray = new Tray(icon);
  tray.setToolTip("Medict · 本地优先查词与药物查询");
  tray.on("click", () => {
    if (mainWindow?.isVisible()) {
      restoreConfiguredWindowTop();
      mainWindow.hide();
    }
    else showMainWindow();
  });
  updateTrayMenu();
}

async function bootstrap() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();
  app.setAppUserModelId("com.medict.desktop");
  const userData = app.getPath("userData");
  settingsStore = new SettingsStore(path.join(userData, "settings.json"));
  await settingsStore.load();
  drugCache = new DrugCache(path.join(userData, "drug-cache.json"));
  await drugCache.load();
  dictionaryManager = new DictionaryManager({
    builtinPath: null,
    userDictionaryDir: path.join(userData, "dictionaries")
  });
  await dictionaryManager.load();
  registerIpc();
  createWindow();
  createTray();

  try {
    applyConfiguredShortcuts(settingsStore.get());
  } catch (error) {
    console.warn("Medict global shortcuts could not be registered:", error.message);
  }
  app.on("second-instance", () => showMainWindow());
  app.on("activate", () => {
    if (!mainWindow) createWindow();
    else showMainWindow();
  });
}

bootstrap().catch(error => {
  console.error("Medict failed to start:", error);
  isQuitting = true;
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  selectionMonitor?.stop();
});
