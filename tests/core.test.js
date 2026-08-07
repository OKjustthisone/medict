const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DictionaryManager, normalizeEntry, parseCsv } = require("../src/main/dictionary-manager");
const { DrugCache, normalizeDrugCacheKey, SEVEN_DAYS_MS } = require("../src/main/drug-cache");
const { normalizeAccelerator, registerShortcutConfiguration, validateShortcutConfiguration } = require("../src/main/shortcut-manager");
const { normalizeFreeDictionary, normalizeMerriamItem } = require("../src/main/services/dictionary-api");
const { chooseChemblCandidate, hasDrugIdentity } = require("../src/main/services/drugshop");
const { parseSelectionLine } = require("../src/main/selection-monitor");
const { lookupWord } = require("../src/main/services/word-lookup");
const { buildYoudaoPayload, normalizeBaiduDictionary, targetForBaidu } = require("../src/main/services/translation");
const { mergeSettings } = require("../src/main/store");

test("normalizes a local bilingual dictionary entry", () => {
  const entry = normalizeEntry({
    word: "testable",
    phonetic: "/ˈtestəbəl/",
    pos: "adjective",
    definition: "able to be tested",
    translation: "可测试的"
  }, { id: "fixture", name: "Fixture", license: "test" });
  assert.equal(entry.word, "testable");
  assert.equal(entry.senses[0].partOfSpeech, "adjective");
  assert.deepEqual(entry.senses[0].translations, ["可测试的"]);
});

test("parses quoted CSV cells used by ECDICT-style exports", () => {
  const rows = parseCsv('word,definition,translation\n"well-being","a state, condition","幸福；安康"\n');
  assert.deepEqual(rows, [
    ["word", "definition", "translation"],
    ["well-being", "a state, condition", "幸福；安康"]
  ]);
});

test("loads and searches the bundled local dictionary", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "medict-test-"));
  try {
    const manager = new DictionaryManager({
      builtinPath: path.join(__dirname, "..", "src", "data", "dictionaries", "medict-demo.json"),
      userDictionaryDir: tempDirectory
    });
    await manager.load();
    const result = await manager.search("serendipity");
    assert.equal(result.type, "dictionary");
    assert.ok(result.results.some(entry => entry.word === "serendipity"));
    assert.ok(manager.listSources()[0].entryCount >= 6);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("creates the v3 Youdao signature payload without exposing plaintext signing logic to the UI", () => {
  const payload = buildYoudaoPayload("This is a reasonably long sentence for signing.", {
    appKey: "demo-key",
    appSecret: "demo-secret",
    source: "auto",
    target: "zh-CN"
  }, 1700000000000);
  assert.equal(payload.to, "zh-CHS");
  assert.equal(payload.sign.length, 64);
  assert.equal(payload.salt, "1700000000000");
  assert.equal(payload.curtime, "1700000000");
});

test("normalizes Baidu dictionary data into phonetics, senses and word forms", () => {
  const entry = normalizeBaiduDictionary({
    lang: "1",
    word_result: {
      edict: {
        word: "fan",
        item: [
          {
            pos: "noun",
            tr_group: [{
              tr: ["a device for moving air"],
              example: ["The fan kept the room cool."],
              similar_word: ["blower"]
            }]
          },
          {
            pos: "verb",
            tr_group: [{ tr: ["move air with a fan"] }]
          }
        ]
      }
    },
    simple_means: {
      word_name: "fan",
      exchange: { word_ing: ["fanning"], word_past: ["fanned"] },
      symbols: [{
        ph_en: "fæn",
        ph_am: "fæn",
        parts: [
          { part: "n.", means: ["风扇", "粉丝"] },
          { part: "v.", means: ["扇动"] }
        ]
      }]
    }
  }, "fan");
  assert.equal(targetForBaidu("zh-CN"), "zh");
  assert.equal(entry.word, "fan");
  assert.equal(entry.phonetic, "英 /fæn/  美 /fæn/");
  assert.deepEqual(entry.wordForms, [
    { label: "现在分词", values: ["fanning"] },
    { label: "过去式", values: ["fanned"] }
  ]);
  assert.deepEqual(entry.senses.find(sense => sense.partOfSpeech === "noun").translations, ["风扇", "粉丝"]);
  assert.ok(entry.senses.some(sense => sense.partOfSpeech === "verb" && sense.translations[0] === "扇动"));
  assert.equal(entry.senses[0].examples[0], "The fan kept the room cool.");
});

test("normalizes a Merriam-Webster response shape", () => {
  const entry = normalizeMerriamItem({
    hwi: { hw: "example", prs: [{ mw: "igˈzampəl" }] },
    fl: "noun",
    shortdef: ["something that serves as a model"]
  }, "example", { apiKey: "configured" });
  assert.equal(entry.word, "example");
  assert.equal(entry.entries[0].partOfSpeech, "noun");
  assert.equal(entry.entries[0].definitions[0].definition, "something that serves as a model");
});

test("normalizes Free Dictionary phonetics, parts of speech, homographs and examples", () => {
  const entry = normalizeFreeDictionary([
    {
      word: "fan",
      phonetic: "/fæn/",
      phonetics: [{ text: "/fæn/", audio: "//example.test/fan.mp3" }],
      meanings: [
        {
          partOfSpeech: "noun",
          definitions: [
            { definition: "A hand-held device used to move air." },
            { definition: "An electrical device for moving air." }
          ]
        },
        {
          partOfSpeech: "verb",
          definitions: [{ definition: "To blow air on something.", example: "She fanned the fire." }]
        }
      ],
      sourceUrls: ["https://en.wiktionary.org/wiki/fan"],
      license: { name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0" }
    },
    {
      word: "fan",
      meanings: [{
        partOfSpeech: "noun",
        definitions: [{ definition: "A person who admires someone or something.", example: "He is a football fan." }]
      }]
    }
  ], "fan");
  assert.equal(entry.word, "fan");
  assert.equal(entry.phonetic, "/fæn/");
  assert.equal(entry.audioUrl, "https://example.test/fan.mp3");
  assert.ok(entry.senses.some(sense => sense.partOfSpeech === "verb" && sense.examples[0] === "She fanned the fire."));
  assert.ok(entry.senses.some(sense => sense.definition.includes("person who admires")));
  assert.equal(entry.source.license, "CC BY-SA 3.0");
});

test("uses an exact local dictionary hit without calling a cloud provider", async () => {
  let cloudCalls = 0;
  let dictionaryCalls = 0;
  const localEntry = { word: "serendipity", senses: [{ definition: "a fortunate discovery" }] };
  const result = await lookupWord("serendipity", {
    dictionaryManager: {
      searchLocal: async () => ({ exactResults: [localEntry], suggestions: [], warnings: [], sources: [] })
    },
    settings: mergeSettings({}),
    queryDictionary: async () => {
      dictionaryCalls += 1;
      return null;
    },
    translate: async () => {
      cloudCalls += 1;
      return { results: [], warnings: [] };
    }
  });
  assert.equal(result.strategy, "local");
  assert.equal(result.localResults[0].word, "serendipity");
  assert.equal(cloudCalls, 0);
  assert.equal(dictionaryCalls, 0);
});

test("falls back to enabled cloud lookup when local dictionaries miss", async () => {
  let cloudCalls = 0;
  const result = await lookupWord("serendipity", {
    dictionaryManager: {
      searchLocal: async () => ({ exactResults: [], suggestions: [], warnings: [], sources: [] })
    },
    settings: mergeSettings({}),
    queryDictionary: async () => null,
    translate: async query => {
      cloudCalls += 1;
      return {
        source: "auto",
        target: "zh-CN",
        results: [{ provider: "google", translations: [`${query}-中文`] }],
        warnings: []
      };
    }
  });
  assert.equal(result.strategy, "cloud");
  assert.equal(result.cloudResults[0].translations[0], "serendipity-中文");
  assert.deepEqual(result.providers, ["google"]);
  assert.equal(cloudCalls, 1);
});

test("combines an online dictionary entry with translated senses and whole-word translation", async () => {
  const dictionaryEntry = normalizeFreeDictionary([{
    word: "fan",
    phonetic: "/fæn/",
    meanings: [{
      partOfSpeech: "noun",
      definitions: [
        { definition: "A device for moving air." },
        { definition: "A person who admires someone.", example: "She is a fan of the band." }
      ]
    }]
  }], "fan");
  const result = await lookupWord("fan", {
    dictionaryManager: {
      searchLocal: async () => ({ exactResults: [], suggestions: [], warnings: [], sources: [] })
    },
    settings: mergeSettings({}),
    queryDictionary: async () => dictionaryEntry,
    translate: async () => ({
      source: "en",
      target: "zh-CN",
      results: [{ provider: "google", name: "Google", translations: ["风扇"] }],
      warnings: []
    }),
    translateSegments: async texts => ({
      translations: texts.map((_, index) => index === 0 ? "使空气流动的设备。" : "喜爱某人或某物的人。"),
      provider: "google",
      name: "Google Cloud Translation",
      warnings: []
    })
  });
  assert.equal(result.strategy, "online-dictionary");
  assert.equal(result.dictionaryResults[0].phonetic, "/fæn/");
  assert.deepEqual(result.dictionaryResults[0].senses.map(sense => sense.translations[0]), [
    "使空气流动的设备。",
    "喜爱某人或某物的人。"
  ]);
  assert.equal(result.dictionaryResults[0].translationProvider.name, "Google Cloud Translation");
  assert.equal(result.cloudResults[0].translations[0], "风扇");
});

test("prefers a Baidu dictionary payload and keeps other providers as translation supplements", async () => {
  const baiduEntry = {
    type: "online-dictionary",
    provider: "baidu-dictionary",
    name: "百度词典版",
    word: "fan",
    senses: [{ partOfSpeech: "noun", translations: ["风扇", "粉丝"], definition: "a device or admirer" }]
  };
  const result = await lookupWord("fan", {
    dictionaryManager: {
      searchLocal: async () => ({ exactResults: [], suggestions: [], warnings: [], sources: [] })
    },
    settings: mergeSettings({ translation: { baidu: { enabled: true, apiKey: "key", secretKey: "secret" } } }),
    queryDictionary: async () => null,
    translate: async () => ({
      source: "en",
      target: "zh-CN",
      results: [
        { provider: "baidu", dictionaryEntry: baiduEntry, translations: ["扇子"], name: "百度翻译" },
        { provider: "google", translations: ["风扇"], name: "Google" }
      ],
      warnings: []
    })
  });
  assert.equal(result.strategy, "online-dictionary");
  assert.equal(result.dictionaryResults[0].provider, "baidu-dictionary");
  assert.deepEqual(result.dictionaryResults[0].senses[0].translations, ["风扇", "粉丝"]);
  assert.deepEqual(result.cloudResults.map(item => item.provider), ["google"]);
});

test("decodes UTF-8 selection messages from the Windows helper", () => {
  const encoded = Buffer.from("aspirin 阿司匹林", "utf8").toString("base64");
  assert.deepEqual(parseSelectionLine(`TEXT\t${encoded}`), {
    type: "text",
    text: "aspirin 阿司匹林"
  });
});

test("recognizes an empty one-shot selection response", () => {
  assert.deepEqual(parseSelectionLine("EMPTY"), { type: "empty" });
});

test("persists drug results for seven days and expires them afterwards", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "medict-cache-test-"));
  const cachePath = path.join(tempDirectory, "drug-cache.json");
  let now = Date.UTC(2026, 7, 8, 0, 0, 0);
  try {
    const first = new DrugCache(cachePath, { now: () => now });
    await first.load();
    await first.set("  Aspirin  ", { type: "drug", success: true, name: "Aspirin" });

    const sameSession = await first.get("aspirin");
    assert.equal(sameSession.result.name, "Aspirin");
    assert.equal(sameSession.expiresAt - sameSession.cachedAt, SEVEN_DAYS_MS);

    const afterRestart = new DrugCache(cachePath, { now: () => now });
    await afterRestart.load();
    assert.equal((await afterRestart.get("ASPIRIN")).result.success, true);
    assert.equal(afterRestart.stats().count, 1);

    now += SEVEN_DAYS_MS + 1;
    assert.equal(await afterRestart.get("aspirin"), null);
    assert.equal(afterRestart.stats().count, 0);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("normalizes drug cache keys across whitespace and case", () => {
  assert.equal(normalizeDrugCacheKey("  Acetyl   Salicylic ACID "), "acetyl salicylic acid");
});

test("defaults to automatic selection and Google web fallback without storing a key", () => {
  const settings = mergeSettings({});
  assert.equal(settings.behavior.selectionLookup, true);
  assert.equal(settings.appearance.fontScale, 115);
  assert.equal(settings.shortcuts.showWindow, "CommandOrControl+Alt+M");
  assert.equal(settings.shortcuts.selectionLookup, "CommandOrControl+Alt+D");
  assert.equal(settings.translation.google.enabled, true);
  assert.equal(settings.translation.google.mode, "web");
  assert.equal(settings.translation.google.apiKey, "");
  assert.equal(settings.translation.baidu.enabled, false);
  assert.equal(settings.translation.baidu.apiKey, "");
});

test("preserves a configured result font scale", () => {
  assert.equal(mergeSettings({ appearance: { fontScale: 145 } }).appearance.fontScale, 145);
});

test("normalizes configurable global shortcuts and rejects conflicts", () => {
  assert.equal(normalizeAccelerator("ctrl + alt + m"), "CommandOrControl+Alt+M");
  assert.equal(normalizeAccelerator("Alt+Shift+F8"), "Alt+Shift+F8");
  assert.deepEqual(validateShortcutConfiguration({ showWindow: "", selectionLookup: "Ctrl+Alt+D" }), {
    showWindow: "",
    selectionLookup: "CommandOrControl+Alt+D"
  });
  assert.throws(() => validateShortcutConfiguration({ showWindow: "Ctrl+Alt+D", selectionLookup: "CommandOrControl+Alt+D" }), /不能使用同一个快捷键/);
  assert.throws(() => normalizeAccelerator("M"), /必须包含 Ctrl 或 Alt/);
});

test("registers the panel and selection shortcuts together", () => {
  const registered = [];
  let unregisterCalls = 0;
  const registry = {
    unregisterAll: () => { unregisterCalls += 1; },
    register: (accelerator, handler) => {
      registered.push({ accelerator, handler });
      return true;
    }
  };
  const handlers = { showWindow: () => {}, selectionLookup: () => {} };
  const shortcuts = registerShortcutConfiguration(registry, {
    showWindow: "Ctrl+Alt+M",
    selectionLookup: "Ctrl+Alt+D"
  }, handlers);
  assert.deepEqual(shortcuts, {
    showWindow: "CommandOrControl+Alt+M",
    selectionLookup: "CommandOrControl+Alt+D"
  });
  assert.deepEqual(registered.map(item => item.accelerator), ["CommandOrControl+Alt+M", "CommandOrControl+Alt+D"]);
  assert.equal(unregisterCalls, 1);
});

test("does not classify a phrase as a drug from trial or PubChem text alone", () => {
  assert.equal(hasDrugIdentity({ rxcui: null }, null, []), false);
  assert.equal(hasDrugIdentity({ rxcui: "1191" }, null, []), true);
  assert.equal(hasDrugIdentity({ rxcui: null }, { id: "CHEMBL25" }, []), true);
  assert.equal(hasDrugIdentity({ rxcui: null }, null, [{ applicationNumber: "NDA000001" }]), true);
});

test("does not accept ChEMBL's first fuzzy candidate for an ordinary word", () => {
  const candidates = [
    { molecule_chembl_id: "CHEMBL562965", pref_name: null },
    { molecule_chembl_id: "CHEMBL999", pref_name: "UNRELATED" }
  ];
  assert.equal(chooseChemblCandidate(candidates, "fan"), null);
  assert.equal(chooseChemblCandidate([{ molecule_chembl_id: "CHEMBL25", pref_name: "ASPIRIN" }], "aspirin").molecule_chembl_id, "CHEMBL25");
  assert.equal(chooseChemblCandidate([{ molecule_chembl_id: "CHEMBL25", pref_name: "ASPIRIN" }], "chembl25").pref_name, "ASPIRIN");
});
