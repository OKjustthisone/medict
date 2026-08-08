const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_SETTINGS = {
  dictionary: {
    youdaoDictionary: {
      enabled: true
    },
    freeDictionary: {
      enabled: true
    },
    serviceOrder: ["youdaoDictionary", "freeDictionary", "baidu", "google", "youdao"],
    oxford: {
      enabled: false,
      appId: "",
      appKey: "",
      locale: "en-gb"
    },
    merriamWebster: {
      enabled: false,
      apiKey: ""
    }
  },
  translation: {
    google: {
      enabled: true,
      mode: "web",
      apiKey: ""
    },
    youdao: {
      enabled: false,
      appKey: "",
      appSecret: ""
    },
    baidu: {
      enabled: false,
      apiKey: "",
      secretKey: ""
    },
    source: "auto",
    target: "zh-CN"
  },
  behavior: {
    selectionLookup: true,
    selectionMaxLength: 500
  },
  appearance: {
    fontScale: 115
  },
  shortcuts: {
    showWindow: "CommandOrControl+Alt+M",
    selectionLookup: "CommandOrControl+Alt+D"
  },
  window: {
    alwaysOnTop: false,
    hideOnClose: true
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDictionaryServiceOrder(value) {
  const defaultOrder = DEFAULT_SETTINGS.dictionary.serviceOrder;
  const requested = Array.isArray(value) ? value : [];
  const selected = [...new Set(requested.filter(item => defaultOrder.includes(item)))];
  const missing = defaultOrder.filter(item => !selected.includes(item));
  const firstService = defaultOrder[0];
  return [
    ...(missing.includes(firstService) ? [firstService] : []),
    ...selected,
    ...missing.filter(item => item !== firstService)
  ];
}

function mergeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...clone(DEFAULT_SETTINGS),
    ...source,
    dictionary: {
      ...clone(DEFAULT_SETTINGS.dictionary),
      ...(source.dictionary || {}),
      youdaoDictionary: {
        ...clone(DEFAULT_SETTINGS.dictionary.youdaoDictionary),
        ...(source.dictionary?.youdaoDictionary || {})
      },
      freeDictionary: {
        ...clone(DEFAULT_SETTINGS.dictionary.freeDictionary),
        ...(source.dictionary?.freeDictionary || {})
      },
      serviceOrder: normalizeDictionaryServiceOrder(source.dictionary?.serviceOrder),
      oxford: {
        ...clone(DEFAULT_SETTINGS.dictionary.oxford),
        ...(source.dictionary?.oxford || {})
      },
      merriamWebster: {
        ...clone(DEFAULT_SETTINGS.dictionary.merriamWebster),
        ...(source.dictionary?.merriamWebster || {})
      }
    },
    translation: {
      ...clone(DEFAULT_SETTINGS.translation),
      ...(source.translation || {}),
      google: {
        ...clone(DEFAULT_SETTINGS.translation.google),
        ...(source.translation?.google || {})
      },
      youdao: {
        ...clone(DEFAULT_SETTINGS.translation.youdao),
        ...(source.translation?.youdao || {})
      },
      baidu: {
        ...clone(DEFAULT_SETTINGS.translation.baidu),
        ...(source.translation?.baidu || {})
      }
    },
    behavior: {
      ...clone(DEFAULT_SETTINGS.behavior),
      ...(source.behavior || {})
    },
    appearance: {
      ...clone(DEFAULT_SETTINGS.appearance),
      ...(source.appearance || {})
    },
    shortcuts: {
      ...clone(DEFAULT_SETTINGS.shortcuts),
      ...(source.shortcuts || {})
    },
    window: {
      ...clone(DEFAULT_SETTINGS.window),
      ...(source.window || {})
    }
  };
}

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.settings = clone(DEFAULT_SETTINGS);
  }

  async load() {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      this.settings = mergeSettings(JSON.parse(text));
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn("Medict settings could not be loaded:", error.message);
      }
      this.settings = clone(DEFAULT_SETTINGS);
    }
    return this.get();
  }

  get() {
    return clone(this.settings);
  }

  async save(value) {
    this.settings = mergeSettings(value);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(this.settings, null, 2)}\n`, "utf8");
    return this.get();
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  normalizeDictionaryServiceOrder,
  SettingsStore,
  mergeSettings
};
