const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { DictionaryManager } = require("./dictionary-manager");
const { searchDrug } = require("./services/drugshop");
const { translateText } = require("./services/translation");
const { SettingsStore } = require("./store");

let mainWindow;
let dictionaryManager;
let settingsStore;

function registerIpc() {
  ipcMain.handle("app:metadata", () => ({
    name: "Medict",
    version: app.getVersion(),
    userData: app.getPath("userData")
  }));

  ipcMain.handle("settings:get", () => settingsStore.get());
  ipcMain.handle("settings:save", async (_, value) => settingsStore.save(value));
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
    if (result.canceled || !result.filePaths[0]) return { canceled: true, sources: dictionaryManager.listSources() };
    const sources = await dictionaryManager.importFile(result.filePaths[0]);
    return { canceled: false, sources };
  });

  ipcMain.handle("search:dictionary", async (_, query) => dictionaryManager.search(query, settingsStore.get()));
  ipcMain.handle("search:translation", async (_, query) => translateText(query, settingsStore.get()));
  ipcMain.handle("search:drug", async (_, query) => searchDrug(query));
  ipcMain.handle("app:open-external", async (_, url) => {
    if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("只允许打开 http/https 链接");
    await shell.openExternal(String(url));
    return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f4f7fb",
    title: "Medict",
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
  if (!app.isPackaged && process.env.MEDICT_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function bootstrap() {
  await app.whenReady();
  const userData = app.getPath("userData");
  settingsStore = new SettingsStore(path.join(userData, "settings.json"));
  await settingsStore.load();
  dictionaryManager = new DictionaryManager({
    builtinPath: path.join(__dirname, "..", "data", "dictionaries", "medict-demo.json"),
    userDictionaryDir: path.join(userData, "dictionaries")
  });
  await dictionaryManager.load();
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

bootstrap().catch(error => {
  console.error("Medict failed to start:", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
