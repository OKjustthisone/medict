const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DictionaryManager, normalizeEntry, parseCsv } = require("../src/main/dictionary-manager");
const { normalizeFreeDictionary, normalizeMerriamItem } = require("../src/main/services/dictionary-api");
const { hasDrugIdentity } = require("../src/main/services/drugshop");
const { parseSelectionLine } = require("../src/main/selection-monitor");
const { lookupWord } = require("../src/main/services/word-lookup");
const { buildYoudaoPayload } = require("../src/main/services/translation");
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

test("decodes UTF-8 selection messages from the Windows helper", () => {
  const encoded = Buffer.from("aspirin 阿司匹林", "utf8").toString("base64");
  assert.deepEqual(parseSelectionLine(`TEXT\t${encoded}`), {
    type: "text",
    text: "aspirin 阿司匹林"
  });
});

test("defaults to automatic selection and Google web fallback without storing a key", () => {
  const settings = mergeSettings({});
  assert.equal(settings.behavior.selectionLookup, true);
  assert.equal(settings.translation.google.enabled, true);
  assert.equal(settings.translation.google.mode, "web");
  assert.equal(settings.translation.google.apiKey, "");
});

test("does not classify a phrase as a drug from trial or PubChem text alone", () => {
  assert.equal(hasDrugIdentity({ rxcui: null }, null, []), false);
  assert.equal(hasDrugIdentity({ rxcui: "1191" }, null, []), true);
  assert.equal(hasDrugIdentity({ rxcui: null }, { id: "CHEMBL25" }, []), true);
  assert.equal(hasDrugIdentity({ rxcui: null }, null, [{ applicationNumber: "NDA000001" }]), true);
});
