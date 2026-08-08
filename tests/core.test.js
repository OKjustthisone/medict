const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DictionaryManager, normalizeEntry, parseCsv } = require("../src/main/dictionary-manager");
const { DrugCache, normalizeDrugCacheKey, SEVEN_DAYS_MS } = require("../src/main/drug-cache");
const { normalizeAccelerator, registerShortcutConfiguration, validateShortcutConfiguration } = require("../src/main/shortcut-manager");
const { buildYoudaoDictionaryPayload, normalizeFreeDictionary, normalizeMerriamItem, normalizeYoudaoDictionary, normalizeYoudaoLegacyPayload, normalizeYoudaoTranslation } = require("../src/main/services/dictionary-api");
const { chooseChemblCandidate, hasDrugIdentity } = require("../src/main/services/drugshop");
const { parseSelectionLine } = require("../src/main/selection-monitor");
const { lookupWord, requestLanguagePair, sortByServiceOrder } = require("../src/main/services/word-lookup");
const { createBaiduError, normalizeBaiduDictionary, targetForBaidu } = require("../src/main/services/translation");
const { mergeSettings, normalizeDictionaryServiceOrder } = require("../src/main/store");

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

test("creates the Youdao web V4 signature payload without exposing signing logic to the UI", () => {
  const payload = buildYoudaoDictionaryPayload("This is a reasonably long sentence for signing.", { le: "en" });
  assert.equal(payload.q, "This is a reasonably long sentence for signing.");
  assert.equal(payload.le, "en");
  assert.equal(payload.client, "web");
  assert.equal(payload.keyfrom, "webdict");
  assert.equal(payload.sign.length, 32);
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

test("explains Baidu rate-limit errors with an actionable message", () => {
  const error = createBaiduError(18, "Open api qps request limit reached");
  assert.equal(error.baiduCode, "18");
  assert.match(error.message, /QPS 超限/);
  assert.match(error.message, /自动排队并重试/);
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

test("uses the Youdao webpage concise rows as the canonical meanings", () => {
  const entry = normalizeYoudaoDictionary({
    ec: {
      word: {
        word: "fan",
        ukphone: "fæn",
        usphone: "fæn",
        ukspeech: "fan",
        usspeech: "fan",
        trs: [
          { pos: "n.", tran: "风扇；粉丝；爱好者" },
          { pos: "v.", tran: "给……扇风" },
          { tran: "【名】 （Fan）（英）范（人名）" }
        ],
        wfs: [{ wf: { name: "过去式", value: "fanned" } }]
      }
    },
    collins_primary: {
      gramcat: [
        {
          partofspeech: "noun",
          senses: [{
            definition: "someone who likes someone or something very much",
            word: "粉丝；爱好者",
            examples: [{ example: "He is a fan of the band.", sense: { word: "他是这个乐队的粉丝。" } }]
          }, {
            definition: "a device that moves air around a room",
            word: "风扇"
          }]
        },
        {
          partofspeech: "verb",
          senses: [{ definition: "to move air with a fan", word: "给……扇风" }]
        }
      ]
    },
    syno: { synos: [{ pos: "noun", ws: [{ w: "admirer" }] }] }
  }, "fan");
  const payload = buildYoudaoDictionaryPayload("fan");
  assert.deepEqual({ q: payload.q, le: payload.le, client: payload.client, keyfrom: payload.keyfrom }, {
    q: "fan",
    le: "en",
    client: "web",
    keyfrom: "webdict"
  });
  assert.equal(payload.t, "0");
  assert.equal(payload.sign.length, 32);
  assert.equal(entry.provider, "youdao-dictionary");
  assert.equal(entry.phonetic, "英 /fæn/  美 /fæn/");
  assert.equal(entry.audioUrl, "https://dict.youdao.com/dictvoice?audio=fan");
  assert.deepEqual(entry.wordForms, [{ label: "过去式", values: ["fanned"] }]);
  assert.equal(entry.senses.length, 3);
  assert.deepEqual(entry.senses.map(sense => sense.partOfSpeech), ["noun", "verb", "【名】"]);
  assert.deepEqual(entry.senses.map(sense => sense.translations), [
    ["风扇；粉丝；爱好者"],
    ["给……扇风"],
    ["（Fan）（英）范（人名）"]
  ]);
  assert.ok(entry.senses.every(sense => !sense.definition));
  assert.ok(entry.examples.some(row => row.translation === "他是这个乐队的粉丝。"));
  assert.ok(entry.senses[0].synonyms.includes("admirer"));
});

test("normalizes the compact Youdao response into dual UK and US pronunciation controls", () => {
  const compact = normalizeYoudaoLegacyPayload({
    ec: {
      exam_type: ["CET6", "TOEFL"],
      word: [{
        ukphone: "ˈhæpi",
        usphone: "ˈhæpi",
        ukspeech: "happy&type=1",
        usspeech: "happy&type=2",
        "return-phrase": { l: { i: "happy" } },
        trs: [
          { tr: [{ l: { i: ["adj. 快乐的；幸福的"] } }] },
          { tr: [{ l: { i: ["【名】 （Happy）哈皮（人名）"] } }] }
        ]
      }]
    }
  }, "happy", "en");
  const entry = normalizeYoudaoDictionary(compact, "happy");

  assert.equal(entry.meta.api, "web-v2-fast");
  assert.deepEqual(entry.phonetics.map(row => row.label), ["英", "美"]);
  assert.match(entry.phonetics[0].audioUrl, /type=1$/);
  assert.match(entry.phonetics[1].audioUrl, /type=2$/);
  assert.deepEqual(entry.senses.map(row => row.partOfSpeech), ["adjective", "【名】"]);
  assert.deepEqual(entry.tags, ["CET6", "TOEFL"]);
});

test("normalizes a compact Chinese-to-English Youdao dictionary response", () => {
  const compact = normalizeYoudaoLegacyPayload({
    ce: {
      word: [{
        phone: "kuài lè",
        "return-phrase": { l: { i: "快乐" } },
        trs: [
          { tr: [{ l: { pos: "adj.", i: ["", { "#text": "happy" }], "#tran": "快乐的；幸福的" } }] },
          { tr: [{ l: { pos: "n.", i: ["", { "#text": "happiness" }], "#tran": "快乐；幸福" } }] }
        ]
      }]
    }
  }, "快乐", "en");
  const entry = normalizeYoudaoDictionary(compact, "快乐");

  assert.equal(entry.word, "快乐");
  assert.equal(entry.phonetics[0].label, "拼音");
  assert.deepEqual(entry.senses.map(row => row.partOfSpeech), ["adjective", "noun"]);
  assert.deepEqual(entry.senses.map(row => row.translations[0]), ["happy", "happiness"]);
});

test("keeps Youdao examples and related data without stacking alternative meaning sections", () => {
  const entry = normalizeYoudaoDictionary({
    ec: {
      word: {
        word: "mouse",
        ukphone: "maʊs",
        usphone: "maʊs",
        trs: [{ pos: "n.", tran: "老鼠；鼠标；安静害羞的人" }],
        wfs: [{ wf: { name: "复数", value: "mice或mouses" } }]
      },
      exam_type: ["CET4"]
    },
    collins_primary: {
      gramcat: [{
        partofspeech: "noun",
        senses: [{
          definition: "a small animal with a long tail",
          word: "老鼠；耗子",
          examples: []
        }]
      }]
    },
    expand_ec: {
      word: [{
        pos: "n.",
        transList: [{
          trans: "鼠标",
          content: {
            detailPos: "cn.",
            examType: [{ en: "CET4", zh: "四级" }],
            sents: [{
              sentOrig: "Use the <b>mouse</b> to drag the icon.",
              sentTrans: "用鼠标拖动图标。",
              source: "《牛津词典》"
            }]
          }
        }]
      }]
    },
    blng_sents_part: {
      "sentence-pair": [{
        sentence: "The mouse ran away.",
        "sentence-translation": "老鼠跑掉了。",
        source: "《牛津词典》"
      }]
    },
    phrs: { phrs: [{ headword: "mouse button", translation: "鼠标按钮" }] },
    rel_word: { rels: [{ rel: { pos: "adj.", words: [{ word: "mousy", tran: "像老鼠的" }] } }] },
    ee: { word: { trs: [{ pos: "v.", tr: [{ tran: "manipulate the mouse of a computer" }] }] } }
  }, "mouse");
  assert.equal(entry.senses.length, 1);
  assert.deepEqual(entry.senses[0].translations, ["老鼠；鼠标；安静害羞的人"]);
  assert.equal(entry.senses[0].definition, "");
  assert.ok(entry.examples.some(row => row.translation === "用鼠标拖动图标。"));
  assert.deepEqual(entry.phrases, [{ phrase: "mouse button", translations: ["鼠标按钮"] }]);
  assert.equal(entry.relatedWords[0].word, "mousy");
  assert.ok(entry.tags.includes("CET4"));
});

test("keeps a single named-person row for happy instead of duplicate other meanings", () => {
  const entry = normalizeYoudaoDictionary({
    ec: {
      word: {
        word: "happy",
        trs: [
          { pos: "adj.", tran: "快乐的；幸福的" },
          { pos: "comb.", tran: "<非正式>滥用……的" },
          { tran: "【名】 （Happy）（英、瑞典、喀）哈皮（人名）" }
        ]
      }
    },
    collins_primary: {
      gramcat: [{ partofspeech: "adjective", senses: [{ word: "快乐的；幸福的" }] }]
    },
    expand_ec: {
      word: [{ transList: [{ trans: "【名】 （Happy）（英、瑞典、喀）哈皮（人名）" }] }]
    }
  }, "happy");

  assert.deepEqual(entry.senses.map(sense => sense.partOfSpeech), ["adjective", "comb.", "【名】"]);
  assert.deepEqual(entry.senses[2].translations, ["（Happy）（英、瑞典、喀）哈皮（人名）"]);
  assert.equal(entry.senses.filter(sense => sense.partOfSpeech === "【名】").length, 1);
  assert.equal(entry.senses.filter(sense => !sense.partOfSpeech).length, 0);
});

test("falls back to Collins meanings when Youdao has no concise section", () => {
  const entry = normalizeYoudaoDictionary({
    ec: { word: { word: "fallback", trs: [] } },
    collins_primary: {
      gramcat: [{
        partofspeech: "noun",
        senses: [{ definition: "a backup choice", word: "备选方案" }]
      }]
    }
  }, "fallback");

  assert.equal(entry.senses.length, 1);
  assert.equal(entry.senses[0].partOfSpeech, "noun");
  assert.equal(entry.senses[0].definition, "a backup choice");
  assert.deepEqual(entry.senses[0].translations, ["备选方案"]);
});

test("filters Youdao word-alignment rows from bilingual examples", () => {
  const entry = normalizeYoudaoDictionary({
    ec: {
      word: {
        word: "happy",
        trs: [{ pos: "adj.", tran: "快乐的" }]
      }
    },
    auth_sents_part: {
      sent: [
        { foreign: "A", source: "alignment", sense: { word: "一只" } },
        { foreign: "happy", source: "alignment", sense: { word: "快乐" } },
        { foreign: "little", source: "alignment", sense: { word: "小" } },
        { foreign: "A happy little dog decided to visit this place.", source: "exam" }
      ]
    }
  }, "happy");
  assert.deepEqual(entry.examples.map(row => row.example), ["A happy little dog decided to visit this place."]);
});

test("keeps no-audio dictionary examples in the wide content column", async () => {
  const renderer = await fs.readFile(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf8");
  const styles = await fs.readFile(path.join(__dirname, "..", "src", "renderer", "styles.css"), "utf8");
  assert.match(renderer, /class="dictionary-example-content"/);
  assert.match(styles, /\.dictionary-example-content\s*\{[^}]*grid-column:\s*2;/);
});

test("renders language controls, query history, dual pronunciations and balanced dictionary typography", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  const renderer = await fs.readFile(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf8");
  const styles = await fs.readFile(path.join(__dirname, "..", "src", "renderer", "styles.css"), "utf8");

  assert.match(html, /id="source-language"/);
  assert.match(html, /id="target-language"/);
  assert.match(html, /id="swap-languages-button"/);
  assert.match(html, /id="history-button"/);
  assert.match(html, /id="history-popover"/);
  assert.match(renderer, /function renderPronunciations/);
  assert.match(renderer, /HISTORY_STORAGE_KEY/);
  assert.match(styles, /\.detail-heading,[\s\S]*\.dictionary-extra summary,[\s\S]*font-size:\s*var\(--font-12/);
  assert.match(styles, /\.dictionary-tags span\s*\{\s*font-size:\s*var\(--font-10/);
  assert.match(styles, /\.dictionary-example-en\s*\{\s*font-size:\s*var\(--font-12/);
});

test("selection lookup requests only the word pipeline", async () => {
  const mainSource = await fs.readFile(path.join(__dirname, "..", "src", "main", "main.js"), "utf8");
  const rendererSource = await fs.readFile(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf8");
  const mainSelection = mainSource.match(/async function runSelectionLookup[\s\S]*?(?=\nasync function runShortcutLookup)/)?.[0] || "";
  const rendererSelection = rendererSource.match(/api\.onSelectionPending[\s\S]*?(?=\n\s*api\.onSelectionEmpty)/)?.[0] || "";

  assert.match(mainSelection, /runWordLookup\(query,/);
  assert.doesNotMatch(mainSelection, /runDrugLookup|drugResult|\bdrug:/);
  assert.doesNotMatch(rendererSelection, /DRUG|payload\.drug|未找到该药物/);
});

test("normalizes Youdao web sentence translation", () => {
  const result = normalizeYoudaoTranslation({
    fanyi: {
      input: "I clicked the mouse.",
      type: "en2zh-CHS",
      tran: "我点击了鼠标。"
    },
    meta: { guessLanguage: "eng" }
  }, "I clicked the mouse.");
  assert.equal(result.provider, "youdao-web");
  assert.equal(result.detectedSource, "en");
  assert.deepEqual(result.translations, ["我点击了鼠标。"]);
});

test("automatically reverses a same-language auto target for Chinese input", () => {
  assert.deepEqual(requestLanguagePair("快乐", mergeSettings({}), {}), { source: "auto", target: "en" });
  assert.deepEqual(requestLanguagePair("happy", mergeSettings({ translation: { source: "auto", target: "en" } }), {}), { source: "auto", target: "zh-CN" });
  assert.deepEqual(requestLanguagePair("快乐", mergeSettings({}), { source: "zh-CN", target: "en" }), { source: "zh-CN", target: "en" });
});

test("publishes the Youdao dictionary result before slower supplemental services finish", async () => {
  let resolveFreeDictionary;
  let resolveCloud;
  const partials = [];
  const freeDictionary = new Promise(resolve => { resolveFreeDictionary = resolve; });
  const cloud = new Promise(resolve => { resolveCloud = resolve; });
  const lookup = lookupWord("happy", {
    dictionaryManager: {
      searchLocal: async () => ({ exactResults: [], suggestions: [], warnings: [], sources: [] })
    },
    settings: mergeSettings({}),
    queryYoudaoDictionary: async () => ({
      type: "online-dictionary",
      provider: "youdao-dictionary",
      name: "网易有道词典",
      word: "happy",
      senses: [{ partOfSpeech: "adjective", translations: ["快乐的"] }]
    }),
    queryDictionary: async () => freeDictionary,
    translate: async () => cloud,
    translateSegments: async () => ({ translations: [], warnings: [] }),
    onPartial: result => partials.push(result)
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(partials.length, 1);
  assert.equal(partials[0].partial, true);
  assert.equal(partials[0].dictionaryResults[0].provider, "youdao-dictionary");

  resolveFreeDictionary(null);
  resolveCloud({ source: "en", target: "zh-CN", results: [], warnings: [] });
  const final = await lookup;
  assert.equal(final.partial, false);
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
    queryYoudaoDictionary: async () => null,
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
  assert.deepEqual(result.providers, ["youdao-web", "google"]);
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
    queryYoudaoDictionary: async () => null,
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
    queryYoudaoDictionary: async () => null,
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

test("keeps Free Dictionary optional and sorts dictionary services by the configured order", async () => {
  assert.deepEqual(normalizeDictionaryServiceOrder(["youdao", "baidu", "youdao"]), ["youdaoDictionary", "baidu", "freeDictionary", "google"]);
  const ordered = sortByServiceOrder([
    { provider: "google" },
    { provider: "free-dictionary" },
    { provider: "baidu-dictionary" },
    { provider: "youdao-dictionary" }
  ], mergeSettings({ dictionary: { serviceOrder: ["freeDictionary", "youdaoDictionary", "baidu", "google"] } }));
  assert.deepEqual(ordered.map(item => item.provider), ["free-dictionary", "youdao-dictionary", "baidu-dictionary", "google"]);

  let dictionaryCalls = 0;
  const result = await lookupWord("fan", {
    dictionaryManager: {
      searchLocal: async () => ({ exactResults: [], suggestions: [], warnings: [], sources: [] })
    },
    settings: mergeSettings({ dictionary: { freeDictionary: { enabled: false } } }),
    queryDictionary: async () => {
      dictionaryCalls += 1;
      return null;
    },
    queryYoudaoDictionary: async () => null,
    translate: async () => ({ results: [], warnings: [] })
  });
  assert.equal(dictionaryCalls, 0);
  assert.equal(result.dictionaryResults.length, 0);
});

test("queries the Youdao web dictionary independently and keeps dictionary results in service order", async () => {
  let segmentCalls = 0;
  const webEntry = {
    type: "online-dictionary",
    provider: "youdao-dictionary",
    name: "网易有道词典",
    word: "fan",
    senses: [{ partOfSpeech: "noun", definition: "someone who admires a person", translations: ["粉丝"] }]
  };
  const freeEntry = {
    type: "online-dictionary",
    provider: "free-dictionary",
    name: "Free Dictionary",
    word: "fan",
    senses: [{ partOfSpeech: "noun", definition: "a device for moving air", translations: [] }]
  };
  const result = await lookupWord("fan", {
    dictionaryManager: {
      searchLocal: async () => ({ exactResults: [], suggestions: [], warnings: [], sources: [] })
    },
    settings: mergeSettings({ dictionary: { serviceOrder: ["google", "youdaoDictionary", "freeDictionary", "baidu"] } }),
    queryYoudaoDictionary: async () => webEntry,
    queryDictionary: async () => freeEntry,
    translate: async () => ({ results: [{ provider: "google", name: "Google", translations: ["扇子"] }], warnings: [] }),
    translateSegments: async texts => {
      segmentCalls += 1;
      return { translations: texts.map(() => "风扇"), provider: "google", name: "Google", warnings: [] };
    }
  });
  assert.deepEqual(result.dictionaryResults.map(item => item.provider), ["youdao-dictionary", "free-dictionary"]);
  assert.deepEqual(result.displayResults.map(item => item.provider), ["google", "youdao-dictionary", "free-dictionary"]);
  assert.equal(segmentCalls, 1);
  assert.equal(result.dictionaryResults[1].senses[0].translations[0], "风扇");
});

test("routes phrases and sentences to translation instead of word dictionaries", async () => {
  let dictionaryCalls = 0;
  const result = await lookupWord("I clicked the mouse.", {
    dictionaryManager: {
      searchLocal: async () => ({ exactResults: [], suggestions: [], warnings: [], sources: [] })
    },
    settings: mergeSettings({}),
    queryYoudaoDictionary: async () => {
      dictionaryCalls += 1;
      return null;
    },
    queryDictionary: async () => {
      dictionaryCalls += 1;
      return null;
    },
    translate: async () => ({
      source: "en",
      target: "zh-CN",
      results: [{ provider: "youdao-web", name: "网易有道网页翻译", translations: ["我点击了鼠标。"] }],
      warnings: []
    })
  });
  assert.equal(dictionaryCalls, 0);
  assert.equal(result.strategy, "cloud");
  assert.equal(result.dictionaryResults.length, 0);
  assert.equal(result.cloudResults[0].provider, "youdao-web");
  assert.equal(result.cloudResults[0].translations[0], "我点击了鼠标。");
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
  assert.equal(settings.dictionary.youdaoDictionary.enabled, true);
  assert.equal(settings.dictionary.freeDictionary.enabled, true);
  assert.deepEqual(settings.dictionary.serviceOrder, ["youdaoDictionary", "freeDictionary", "baidu", "google"]);
  assert.equal(settings.shortcuts.showWindow, "CommandOrControl+Alt+M");
  assert.equal(settings.shortcuts.selectionLookup, "CommandOrControl+Alt+D");
  assert.equal(settings.translation.google.enabled, true);
  assert.equal(settings.translation.google.mode, "web");
  assert.equal(settings.translation.google.apiKey, "");
  assert.equal(settings.translation.baidu.enabled, false);
  assert.equal(settings.translation.baidu.apiKey, "");
  assert.equal(settings.translation.youdao, undefined);
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
