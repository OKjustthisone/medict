const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("medict", {
  getMetadata: () => ipcRenderer.invoke("app:metadata"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: value => ipcRenderer.invoke("settings:save", value),
  listDictionaries: () => ipcRenderer.invoke("dictionary:list"),
  importDictionary: () => ipcRenderer.invoke("dictionary:import"),
  lookupWord: query => ipcRenderer.invoke("lookup:word", query),
  lookupDrug: query => ipcRenderer.invoke("lookup:drug", query),
  lookupSelection: query => ipcRenderer.invoke("lookup:selection", query),
  getSelectionStatus: () => ipcRenderer.invoke("selection:status"),
  suspendShortcuts: () => ipcRenderer.invoke("shortcuts:suspend"),
  resumeShortcuts: () => ipcRenderer.invoke("shortcuts:resume"),
  getDrugCacheStats: () => ipcRenderer.invoke("drug-cache:stats"),
  copyText: value => ipcRenderer.invoke("clipboard:write-text", value),
  onSelectionPending: callback => subscribe("selection:pending", callback),
  onSelectionResult: callback => subscribe("selection:result", callback),
  onSelectionEmpty: callback => subscribe("selection:empty", callback),
  onSelectionStatus: callback => subscribe("selection:status", callback),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  hideWindow: () => ipcRenderer.invoke("window:hide"),
  togglePin: () => ipcRenderer.invoke("window:toggle-pin"),
  isPinned: () => ipcRenderer.invoke("window:is-pinned"),
  quit: () => ipcRenderer.invoke("app:quit"),
  openExternal: url => ipcRenderer.invoke("app:open-external", url)
});
