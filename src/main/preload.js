const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("medict", {
  getMetadata: () => ipcRenderer.invoke("app:metadata"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: value => ipcRenderer.invoke("settings:save", value),
  listDictionaries: () => ipcRenderer.invoke("dictionary:list"),
  importDictionary: () => ipcRenderer.invoke("dictionary:import"),
  searchDictionary: query => ipcRenderer.invoke("search:dictionary", query),
  translate: query => ipcRenderer.invoke("search:translation", query),
  searchDrug: query => ipcRenderer.invoke("search:drug", query),
  openExternal: url => ipcRenderer.invoke("app:open-external", url)
});
