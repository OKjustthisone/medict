const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DictionaryManager, normalizeEntry, parseCsv } = require("../src/main/dictionary-manager");
const { normalizeMerriamItem } = require("../src/main/services/dictionary-api");
const { buildYoudaoPayload } = require("../src/main/services/translation");

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
