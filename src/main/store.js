const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_SETTINGS = {
  dictionary: {
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
      enabled: false,
      apiKey: ""
    },
    youdao: {
      enabled: false,
      appKey: "",
      appSecret: ""
    },
    source: "auto",
    target: "zh-CN"
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...clone(DEFAULT_SETTINGS),
    ...source,
    dictionary: {
      ...clone(DEFAULT_SETTINGS.dictionary),
      ...(source.dictionary || {}),
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
      }
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
  SettingsStore,
  mergeSettings
};
