(function () {
  "use strict";

  // Tauri 2 exposes these APIs only when the app is running inside Tauri.
  // Keeping the adapter compatible with the existing renderer lets the UI be
  // migrated independently from the Electron main process.
  const tauri = window.__TAURI__ || {};
  const invoke = tauri.core?.invoke;
  const listen = tauri.event?.listen;

  function call(command, args) {
    if (typeof invoke !== "function") {
      return Promise.reject(new Error("Tauri 2 运行时不可用：请从 tauri-app 启动应用"));
    }
    return invoke(command, args);
  }

  function subscribe(channel, callback) {
    if (typeof listen !== "function") return () => {};
    let unlisten = null;
    listen(channel, event => callback(event?.payload))
      .then(handler => { unlisten = handler; })
      .catch(() => {});
    return () => {
      if (typeof unlisten === "function") unlisten();
    };
  }

  window.medict = {
    getMetadata: () => call("app_metadata"),
    getSettings: () => call("settings_get"),
    saveSettings: value => call("settings_save", { value }),
    saveLanguagePair: value => call("settings_set_language_pair", { value }),
    lookupWord: (query, options) => call("lookup_word", { query, options: options || {} }),
    lookupDrug: (query, options) => call("lookup_drug", { query, options: options || {} }),
    lookupSelection: query => call("lookup_selection", { query }),
    getSelectionStatus: () => call("selection_status"),
    suspendShortcuts: () => call("shortcuts_suspend"),
    resumeShortcuts: () => call("shortcuts_resume"),
    getDrugCacheStats: () => call("drug_cache_stats"),
    copyText: value => navigator.clipboard?.writeText(String(value || "")) || call("clipboard_write_text", { value }),
    onSelectionPending: callback => subscribe("selection:pending", callback),
    onSelectionResult: callback => subscribe("selection:result", callback),
    onWordPartial: callback => subscribe("lookup:word-partial", callback),
    onSelectionEmpty: callback => subscribe("selection:empty", callback),
    onSelectionStatus: callback => subscribe("selection:status", callback),
    onWindowShow: callback => subscribe("window:show", callback),
    minimizeWindow: () => call("window_minimize"),
    hideWindow: () => call("window_hide"),
    togglePin: () => call("window_toggle_pin"),
    isPinned: () => call("window_is_pinned"),
    quit: () => call("app_quit"),
    openExternal: url => call("open_external", { url })
  };
})();
