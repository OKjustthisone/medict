use std::collections::HashSet;
use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

const FREE_DICTIONARY_URL: &str = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const YOUDAO_FAST_URL: &str = "https://dict.youdao.com/jsonapi";
const YOUDAO_FAST_SECTIONS: &str = "{\"count\":99,\"dicts\":[[\"web_trans\",\"ec\",\"ce\",\"simple\",\"phrs\",\"syno\",\"collins_primary\",\"rel_word\",\"blng_sents_part\",\"auth_sents_part\",\"expand_ec\",\"meta\"]]}";
const MAX_SENSES: usize = 36;
const MAX_EXAMPLES: usize = 48;

#[derive(Clone, Debug)]
pub struct LookupConfig {
    pub youdao_enabled: bool,
    pub free_dictionary_enabled: bool,
    pub service_order: Vec<String>,
}

impl LookupConfig {
    fn enabled_provider_ids(&self) -> Vec<String> {
        let mut providers = Vec::new();
        for id in &self.service_order {
            if (id == "youdaoDictionary" && self.youdao_enabled)
                || (id == "freeDictionary" && self.free_dictionary_enabled)
            {
                providers.push(id.clone());
            }
        }
        if self.youdao_enabled && !providers.iter().any(|id| id == "youdaoDictionary") {
            providers.push("youdaoDictionary".to_string());
        }
        if self.free_dictionary_enabled && !providers.iter().any(|id| id == "freeDictionary") {
            providers.push("freeDictionary".to_string());
        }
        providers
    }
}

#[derive(Default)]
struct DefinitionRow {
    definition: String,
    example: String,
    synonyms: Vec<String>,
    antonyms: Vec<String>,
}

#[derive(Default)]
struct MeaningGroup {
    part_of_speech: String,
    definitions: Vec<DefinitionRow>,
    synonyms: Vec<String>,
    antonyms: Vec<String>,
}

pub async fn lookup_word(query: &str, config: LookupConfig) -> Result<Value, String> {
    let query = clean(query);
    if query.is_empty() {
        return Err("请输入查询内容".to_string());
    }

    let providers = config.enabled_provider_ids();
    if providers.is_empty() {
        return Ok(empty_result(
            &query,
            providers,
            vec!["Tauri 中还没有启用可用的词典服务".to_string()],
        ));
    }
    let english_query = is_english_dictionary_word(&query);
    let chinese_query = is_chinese_dictionary_word(&query);
    if !english_query && !chinese_query {
        return Ok(empty_result(
            &query,
            providers,
            vec!["Tauri 第一阶段暂只迁移单个单词查词，短语和句子服务正在迁移中".to_string()],
        ));
    }

    let word = if english_query {
        query.to_ascii_lowercase()
    } else {
        query.clone()
    };
    let (youdao_result, free_result) = futures::join!(
        query_youdao(&word, config.youdao_enabled),
        query_free_dictionary(&word, config.free_dictionary_enabled && english_query)
    );
    let mut entries = Vec::new();
    let mut cloud_results = Vec::new();
    let mut warnings = Vec::new();
    match youdao_result {
        Ok(Some(entry)) if entry.get("type").and_then(Value::as_str) == Some("translation") => {
            cloud_results.push(entry)
        }
        Ok(Some(entry)) => entries.push(entry),
        Ok(None) => {}
        Err(error) => warnings.push(error),
    }
    match free_result {
        Ok(Some(entry)) => entries.push(entry),
        Ok(None) => {}
        Err(error) => warnings.push(error),
    }
    entries.sort_by_key(|entry| {
        let provider = entry
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let id = if provider == "youdao-dictionary" {
            "youdaoDictionary"
        } else {
            "freeDictionary"
        };
        config
            .service_order
            .iter()
            .position(|value| value == id)
            .unwrap_or(config.service_order.len())
    });

    if entries.is_empty() {
        if !cloud_results.is_empty() {
            return Ok(json!({
                "type": "word-lookup",
                "success": true,
                "query": word,
                "dictionaryResults": [],
                "cloudResults": cloud_results,
                "displayResults": [],
                "providers": providers,
                "warnings": warnings,
                "migration": { "implemented": true, "feature": "youdao-web-translation" }
            }));
        }
        return Ok(empty_result(&word, providers, warnings));
    }

    Ok(json!({
        "type": "word-lookup",
        "success": true,
        "query": word,
        "dictionaryResults": entries.clone(),
        "cloudResults": cloud_results,
        "displayResults": entries,
        "providers": providers,
        "warnings": warnings,
        "migration": { "implemented": true, "feature": "dictionary-providers" }
    }))
}

fn empty_result(query: &str, providers: Vec<String>, warnings: Vec<String>) -> Value {
    json!({
        "type": "word-lookup",
        "success": false,
        "query": query,
        "dictionaryResults": [],
        "cloudResults": [],
        "displayResults": [],
        "providers": providers,
        "warnings": warnings,
        "migration": { "implemented": true, "feature": "dictionary-providers" }
    })
}

async fn query_free_dictionary(query: &str, enabled: bool) -> Result<Option<Value>, String> {
    if !enabled || !is_english_dictionary_word(query) {
        return Ok(None);
    }
    let client = build_client(16)?;
    let url = format!("{}{}", FREE_DICTIONARY_URL, urlencoding::encode(query));
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Free Dictionary 请求失败：{error}"))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("Free Dictionary 返回 HTTP {}", response.status()));
    }
    let data = response
        .json::<Value>()
        .await
        .map_err(|error| format!("解析 Free Dictionary 响应失败：{error}"))?;
    Ok(normalize_free_dictionary(&data, query))
}

async fn query_youdao(query: &str, enabled: bool) -> Result<Option<Value>, String> {
    if !enabled || query.is_empty() {
        return Ok(None);
    }
    let language = if is_chinese_dictionary_word(query) {
        "zh"
    } else {
        "en"
    };
    let client = build_client(8)?;
    let url = format!(
        "{}?q={}&le={}&dicts={}",
        YOUDAO_FAST_URL,
        urlencoding::encode(query),
        language,
        urlencoding::encode(YOUDAO_FAST_SECTIONS)
    );
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .header("Referer", "https://fanyi.youdao.com/")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
        )
        .send()
        .await
        .map_err(|error| format!("网易有道网页词典请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("网易有道网页词典返回 HTTP {}", response.status()));
    }
    let data = response
        .json::<Value>()
        .await
        .map_err(|error| format!("解析网易有道网页词典响应失败：{error}"))?;
    if is_english_dictionary_word(query) || is_chinese_dictionary_word(query) {
        Ok(normalize_youdao_fast(&data, query, language))
    } else {
        Ok(normalize_youdao_translation(&data, query, language))
    }
}

fn normalize_youdao_translation(data: &Value, query: &str, language: &str) -> Option<Value> {
    let mut translations = Vec::new();
    translations.extend(string_values(
        data.get("fanyi").and_then(|value| value.get("tran")),
    ));
    translations.extend(string_values(
        data.get("ec").and_then(|value| value.get("web_trans")),
    ));
    if let Some(rows) = data
        .get("web_trans")
        .and_then(|value| value.get("web-translation"))
        .and_then(Value::as_array)
    {
        for row in rows {
            if let Some(items) = row.get("trans").and_then(Value::as_array) {
                translations.extend(items.iter().map(|item| clean_value(item.get("value"))));
            }
        }
    }
    if translations.is_empty() {
        for section in ["ec", "ce"] {
            if let Some(rows) = data
                .get(section)
                .and_then(|value| value.get("word"))
                .and_then(|value| value.get("trs"))
                .and_then(Value::as_array)
            {
                for row in rows {
                    translations.extend(string_values(row.get("tran")));
                    translations.extend(string_values(row.get("translation")));
                }
            }
        }
    }
    let translations = unique_strings(translations.into_iter());
    if translations.is_empty() {
        return None;
    }
    Some(json!({
        "type": "translation",
        "provider": "youdao-web",
        "name": "网易有道网页翻译",
        "query": query,
        "detectedSource": if language == "zh" { "zh-CN" } else { "en" },
        "targetLanguage": if language == "zh" { "en" } else { "zh-CN" },
        "translations": translations,
        "examples": [],
        "related": [],
        "source": {
            "id": "youdao-web",
            "name": "网易有道网页翻译",
            "license": "有道网页服务",
            "url": format!(
                "https://dict.youdao.com/result?word={}&lang={}",
                urlencoding::encode(query),
                urlencoding::encode(language)
            )
        },
        "mode": "web",
        "meta": { "api": "web-v2-fast" }
    }))
}

fn build_client(timeout_seconds: u64) -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(timeout_seconds))
        .user_agent("Medict-Tauri/0.1")
        .build()
        .map_err(|error| format!("创建词典网络客户端失败：{error}"))
}

fn normalize_youdao_fast(data: &Value, query: &str, language: &str) -> Option<Value> {
    let word = data
        .get("ec")
        .and_then(|value| value.get("word"))
        .or_else(|| data.get("ce").and_then(|value| value.get("word")))?;
    let text = first_non_empty(&[
        clean_value(word.get("word")),
        clean_value(word.get("return-phrase")),
        query.to_string(),
    ]);
    if text.is_empty() {
        return None;
    }

    let mut phonetics = Vec::new();
    let ukphone = phonetic(clean_value(word.get("ukphone")));
    let usphone = phonetic(clean_value(word.get("usphone")));
    if !ukphone.is_empty() {
        phonetics.push(json!({
            "label": "英",
            "text": ukphone,
            "audioUrl": youdao_audio(clean_value(word.get("ukspeech")))
        }));
    }
    if !usphone.is_empty() {
        phonetics.push(json!({
            "label": "美",
            "text": usphone,
            "audioUrl": youdao_audio(clean_value(word.get("usspeech")))
        }));
    }

    let mut senses = Vec::new();
    let concise_rows = word
        .get("trs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for row in &concise_rows {
        let raw_pos = first_non_empty(&[clean_value(row.get("pos")), clean_value(row.get("part"))]);
        let mut translations = unique_strings(
            [
                clean_value(row.get("tran")),
                clean_value(row.get("translation")),
                clean_value(row.get("word")),
            ]
            .into_iter(),
        );
        let mut part_of_speech = normalize_part_of_speech(&raw_pos);
        if part_of_speech.is_empty() && !translations.is_empty() {
            if let Some((label, rest)) = split_pos_label(&translations[0]) {
                part_of_speech = label;
                translations[0] = rest;
                translations.retain(|value| !value.is_empty());
            }
        }
        append_sense(&mut senses, part_of_speech, translations);
    }

    let mut examples = Vec::new();
    let mut example_keys = HashSet::new();
    for row in &concise_rows {
        if let Some(sentences) = row.get("sentence").and_then(Value::as_array) {
            for sentence in sentences {
                add_example(
                    &mut examples,
                    &mut example_keys,
                    first_non_empty(&[
                        clean_value(sentence.get("en")),
                        clean_value(sentence.get("enShow")),
                    ]),
                    clean_value(sentence.get("zh")),
                    clean_value(sentence.get("type")),
                );
            }
        }
    }

    if let Some(gramcats) = data
        .get("collins_primary")
        .and_then(|value| value.get("gramcat"))
        .and_then(Value::as_array)
    {
        for gramcat in gramcats {
            let part = normalize_part_of_speech(&first_non_empty(&[
                clean_value(gramcat.get("partofspeech")),
                clean_value(gramcat.get("partOfSpeech")),
                clean_value(gramcat.get("gram")),
            ]));
            if let Some(rows) = gramcat.get("senses").and_then(Value::as_array) {
                for row in rows {
                    let translations = unique_strings(
                        [
                            clean_value(row.get("word")),
                            clean_value(row.get("translation")),
                            clean_value(row.get("tran")),
                        ]
                        .into_iter(),
                    );
                    let definition = clean_value(row.get("definition"));
                    if let Some(rows) = row.get("examples").and_then(Value::as_array) {
                        for example in rows {
                            let translation = example
                                .get("sense")
                                .map(|value| {
                                    first_non_empty(&[
                                        clean_value(value.get("word")),
                                        clean_value(value.get("tran")),
                                    ])
                                })
                                .unwrap_or_default();
                            add_example(
                                &mut examples,
                                &mut example_keys,
                                clean_value(example.get("example")),
                                translation,
                                clean_value(example.get("source")),
                            );
                        }
                    }
                    if !definition.is_empty() {
                        append_sense_with_definition(
                            &mut senses,
                            part.clone(),
                            translations,
                            definition,
                        );
                    }
                }
            }
        }
    }

    if let Some(pairs) = data
        .get("blng_sents_part")
        .and_then(|value| value.get("sentence-pair"))
        .and_then(Value::as_array)
    {
        for row in pairs {
            add_example(
                &mut examples,
                &mut example_keys,
                first_non_empty(&[
                    clean_value(row.get("sentence")),
                    clean_value(row.get("example")),
                ]),
                first_non_empty(&[
                    clean_value(row.get("sentence-translation")),
                    clean_value(row.get("translation")),
                ]),
                clean_value(row.get("source")),
            );
        }
    }
    examples.truncate(MAX_EXAMPLES);

    let phrases = data
        .get("phrs")
        .and_then(|value| value.get("phrs"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let phrase = clean_value(row.get("headword"));
                    let translations =
                        unique_strings([clean_value(row.get("translation"))].into_iter());
                    (!phrase.is_empty() && !translations.is_empty())
                        .then(|| json!({ "phrase": phrase, "translations": translations }))
                })
                .take(32)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let related_words = data
        .get("rel_word")
        .and_then(|value| value.get("rels"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .flat_map(|row| {
                    let rel = row.get("rel");
                    let pos = normalize_part_of_speech(&clean_value(
                        rel.and_then(|value| value.get("pos")),
                    ));
                    rel.and_then(|value| value.get("words"))
                        .and_then(Value::as_array)
                        .map(|words| {
                            words
                                .iter()
                                .filter_map(|word| {
                                    let related = clean_value(word.get("word"));
                                    (!related.is_empty()).then(|| {
                                        json!({
                                            "partOfSpeech": pos,
                                            "word": related,
                                            "translations": unique_strings(
                                                [clean_value(word.get("tran"))].into_iter()
                                            )
                                        })
                                    })
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default()
                })
                .take(32)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let tags = data
        .get("ec")
        .and_then(|value| value.get("exam_type"))
        .map(|value| unique_strings(string_values(Some(value)).into_iter()))
        .unwrap_or_default();
    let word_forms = data
        .get("ec")
        .and_then(|value| value.get("word"))
        .and_then(|value| value.get("wfs"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let form = row.get("wf").unwrap_or(row);
                    let label = first_non_empty(&[
                        clean_value(form.get("name")),
                        clean_value(form.get("label")),
                    ]);
                    let values =
                        unique_strings(string_values(form.get("value")).into_iter().flat_map(
                            |value| {
                                value
                                    .split(['或', '；', ';', ',', '，', '/'])
                                    .map(ToString::to_string)
                                    .collect::<Vec<_>>()
                            },
                        ));
                    (!label.is_empty() && !values.is_empty())
                        .then(|| json!({ "label": label, "values": values }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let web_translations = data
        .get("web_trans")
        .and_then(|value| value.get("web-translation"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let word = clean_value(row.get("key"));
                    let translations = row
                        .get("trans")
                        .and_then(Value::as_array)
                        .map(|items| {
                            unique_strings(
                                items
                                    .iter()
                                    .map(|item| clean_value(item.get("value")))
                                    .collect(),
                            )
                        })
                        .unwrap_or_default();
                    (!word.is_empty() && !translations.is_empty())
                        .then(|| json!({ "word": word, "translations": translations }))
                })
                .take(32)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let source_url = format!(
        "https://dict.youdao.com/result?word={}&lang={}",
        urlencoding::encode(&text),
        urlencoding::encode(language)
    );

    if senses.is_empty() {
        return None;
    }
    let phonetic_text = phonetics
        .iter()
        .map(|row| {
            format!(
                "{} {}",
                clean_value(row.get("label")),
                clean_value(row.get("text"))
            )
            .trim()
            .to_string()
        })
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("  ");
    let audio_url = phonetics
        .iter()
        .find_map(|row| {
            let value = clean_value(row.get("audioUrl"));
            (!value.is_empty()).then_some(value)
        })
        .unwrap_or_default();
    let sense_count = senses.len();

    Some(json!({
        "type": "online-dictionary",
        "provider": "youdao-dictionary",
        "name": "网易有道词典",
        "word": text,
        "phonetic": phonetic_text,
        "phonetics": phonetics,
        "audioUrl": audio_url,
        "wordForms": word_forms,
        "senses": senses,
        "examples": examples,
        "phrases": phrases,
        "relatedWords": related_words,
        "webTranslations": web_translations,
        "tags": tags,
        "source": {
            "id": "youdao-dictionary",
            "name": "网易有道网页词典",
            "license": "有道网页服务",
            "url": source_url
        },
        "meta": {
            "api": "web-v2-fast",
            "senseCount": sense_count
        }
    }))
}

fn append_sense(senses: &mut Vec<Value>, part_of_speech: String, translations: Vec<String>) {
    append_sense_with_definition(senses, part_of_speech, translations, String::new());
}

fn append_sense_with_definition(
    senses: &mut Vec<Value>,
    part_of_speech: String,
    translations: Vec<String>,
    definition: String,
) {
    if translations.is_empty() && definition.is_empty() {
        return;
    }
    if let Some(row) = senses.iter_mut().find(|row| {
        clean_value(row.get("partOfSpeech")).eq_ignore_ascii_case(&part_of_speech)
            && clean_value(row.get("definition")).eq_ignore_ascii_case(&definition)
            && row
                .get("translations")
                .and_then(Value::as_array)
                .map(|values| {
                    values.iter().any(|value| {
                        translations
                            .iter()
                            .any(|incoming| clean_value(Some(value)) == *incoming)
                    })
                })
                .unwrap_or(false)
    }) {
        let existing = row
            .get("translations")
            .map(|value| string_values(Some(value)))
            .unwrap_or_default();
        row["translations"] = json!(unique_strings(existing.into_iter().chain(translations)));
        return;
    }
    senses.push(json!({
        "partOfSpeech": part_of_speech,
        "definition": definition,
        "translations": unique_strings(translations.into_iter()),
        "examples": [],
        "synonyms": [],
        "antonyms": []
    }));
}

fn add_example(
    output: &mut Vec<Value>,
    seen: &mut HashSet<String>,
    example: String,
    translation: String,
    source: String,
) {
    let example = strip_markup(&example);
    if example.is_empty() {
        return;
    }
    let key = format!("{}\u{0}{}", example.to_lowercase(), translation);
    if !seen.insert(key) {
        return;
    }
    output.push(json!({
        "example": example,
        "translation": translation,
        "source": source,
        "audioUrl": ""
    }));
}

fn strip_markup(value: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    for character in value.chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(character),
            _ => {}
        }
    }
    clean(&output)
}

fn normalize_part_of_speech(value: &str) -> String {
    let raw = clean(value);
    let normalized = raw.to_lowercase().replace('.', "");
    match normalized.as_str() {
        "n" | "noun" | "n-count" | "n-uncount" => "noun".to_string(),
        "v" | "vi" | "vt" | "verb" => "verb".to_string(),
        "adj" | "adjective" => "adjective".to_string(),
        "adv" | "adverb" => "adverb".to_string(),
        "prep" | "preposition" => "preposition".to_string(),
        "pron" | "pronoun" => "pronoun".to_string(),
        "conj" | "conjunction" => "conjunction".to_string(),
        "interj" | "interjection" => "interjection".to_string(),
        "det" | "determiner" => "determiner".to_string(),
        "num" | "numeral" => "numeral".to_string(),
        _ => raw,
    }
}

fn split_pos_label(value: &str) -> Option<(String, String)> {
    let end = value.find('】')?;
    let label = value.get(..=end)?.to_string();
    let rest = clean(value.get(end + 1..).unwrap_or_default());
    (!rest.is_empty()).then_some((label, rest))
}

fn phonetic(value: String) -> String {
    let value = clean(&value);
    if value.is_empty() {
        String::new()
    } else if value.starts_with('/') {
        value
    } else {
        format!("/{value}/")
    }
}

fn youdao_audio(value: String) -> String {
    let value = clean(&value);
    if value.is_empty() {
        String::new()
    } else if value.starts_with("https://") {
        value
    } else {
        format!(
            "https://dict.youdao.com/dictvoice?audio={}",
            urlencoding::encode(&value)
        )
    }
}

fn first_non_empty(values: &[String]) -> String {
    values
        .iter()
        .find(|value| !value.is_empty())
        .cloned()
        .unwrap_or_default()
}

fn normalize_free_dictionary(data: &Value, query: &str) -> Option<Value> {
    let entries = data
        .as_array()?
        .iter()
        .filter(|value| value.is_object())
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return None;
    }

    let mut groups = Vec::new();
    let mut phonetics = Vec::new();
    let mut examples = Vec::new();
    let mut seen_phonetics = HashSet::new();
    let mut seen_examples = HashSet::new();

    for entry in &entries {
        if let Some(rows) = entry.get("phonetics").and_then(Value::as_array) {
            for row in rows {
                let text = clean_value(row.get("text"));
                let audio_url = https_url(row.get("audio"));
                let key = format!("{text}\u{0}{audio_url}");
                if (text.is_empty() && audio_url.is_empty()) || !seen_phonetics.insert(key) {
                    continue;
                }
                phonetics.push(json!({ "text": text, "audioUrl": audio_url }));
            }
        }
        let fallback_phonetic = clean_value(entry.get("phonetic"));
        if !fallback_phonetic.is_empty() && seen_phonetics.insert(fallback_phonetic.clone()) {
            phonetics.push(json!({ "text": fallback_phonetic, "audioUrl": "" }));
        }

        let meanings = entry
            .get("meanings")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for meaning in meanings {
            let part_of_speech = clean_value(meaning.get("partOfSpeech"));
            let meaning_synonyms = unique_strings(string_values(meaning.get("synonyms")));
            let meaning_antonyms = unique_strings(string_values(meaning.get("antonyms")));
            let mut definitions = Vec::new();
            if let Some(rows) = meaning.get("definitions").and_then(Value::as_array) {
                for row in rows {
                    let definition = clean_value(row.get("definition"));
                    if definition.is_empty() {
                        continue;
                    }
                    let example = clean_value(row.get("example"));
                    if !example.is_empty() && seen_examples.insert(example.to_lowercase()) {
                        examples.push(json!({
                            "example": example,
                            "translation": "",
                            "source": "Free Dictionary"
                        }));
                    }
                    definitions.push(DefinitionRow {
                        definition,
                        example,
                        synonyms: unique_strings(string_values(row.get("synonyms"))),
                        antonyms: unique_strings(string_values(row.get("antonyms"))),
                    });
                }
            }
            if !definitions.is_empty() {
                groups.push(MeaningGroup {
                    part_of_speech,
                    definitions,
                    synonyms: meaning_synonyms,
                    antonyms: meaning_antonyms,
                });
            }
        }
    }
    if groups.is_empty() {
        return None;
    }

    let mut senses = Vec::new();
    let mut seen_senses = HashSet::new();
    let depth = groups
        .iter()
        .map(|group| group.definitions.len())
        .max()
        .unwrap_or(0);
    for index in 0..depth {
        for group in &groups {
            let Some(definition) = group.definitions.get(index) else {
                continue;
            };
            let key = format!(
                "{}\u{0}{}",
                group.part_of_speech.to_lowercase(),
                definition.definition.to_lowercase()
            );
            if !seen_senses.insert(key) {
                continue;
            }
            let synonyms = unique_strings(
                group
                    .synonyms
                    .iter()
                    .cloned()
                    .chain(definition.synonyms.iter().cloned()),
            );
            let antonyms = unique_strings(
                group
                    .antonyms
                    .iter()
                    .cloned()
                    .chain(definition.antonyms.iter().cloned()),
            );
            senses.push(json!({
                "partOfSpeech": group.part_of_speech.clone(),
                "definition": definition.definition.clone(),
                "translations": [],
                "examples": [],
                "synonyms": synonyms,
                "antonyms": antonyms
            }));
            if senses.len() >= MAX_SENSES {
                break;
            }
        }
        if senses.len() >= MAX_SENSES {
            break;
        }
    }
    if senses.is_empty() {
        return None;
    }

    let word = entries
        .iter()
        .map(|entry| clean_value(entry.get("word")))
        .find(|value| !value.is_empty())
        .unwrap_or_else(|| query.to_string());
    let source_url = entries
        .iter()
        .flat_map(|entry| string_values(entry.get("sourceUrls")))
        .find(|value| value.starts_with("https://"))
        .unwrap_or_else(|| {
            format!(
                "https://en.wiktionary.org/wiki/{}",
                urlencoding::encode(&word)
            )
        });
    let license = entries
        .iter()
        .find_map(|entry| {
            let license = entry.get("license")?;
            let name = clean_value(license.get("name"));
            (!name.is_empty()).then_some(name)
        })
        .unwrap_or_else(|| "Source-provided license".to_string());
    let phonetic = phonetics
        .iter()
        .find_map(|row| {
            let text = clean_value(row.get("text"));
            (!text.is_empty()).then_some(text)
        })
        .unwrap_or_default();
    let audio_url = phonetics
        .iter()
        .find_map(|row| {
            let audio = clean_value(row.get("audioUrl"));
            (!audio.is_empty()).then_some(audio)
        })
        .unwrap_or_default();
    examples.truncate(MAX_EXAMPLES);
    let sense_count = senses.len();

    Some(json!({
        "type": "online-dictionary",
        "provider": "free-dictionary",
        "name": "Free Dictionary",
        "word": word,
        "phonetic": phonetic,
        "phonetics": phonetics,
        "audioUrl": audio_url,
        "senses": senses,
        "examples": examples,
        "source": {
            "id": "free-dictionary",
            "name": "Free Dictionary",
            "license": license,
            "url": source_url
        },
        "meta": {
            "entryCount": entries.len(),
            "senseCount": sense_count
        }
    }))
}

fn clean(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_value(value: Option<&Value>) -> String {
    value
        .and_then(|item| item.as_str())
        .map(clean)
        .unwrap_or_default()
}

fn string_values(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(rows)) => rows
            .iter()
            .filter_map(|item| item.as_str())
            .map(clean)
            .filter(|value| !value.is_empty())
            .collect(),
        Some(Value::String(value)) => {
            let value = clean(value);
            if value.is_empty() {
                Vec::new()
            } else {
                vec![value]
            }
        }
        _ => Vec::new(),
    }
}

fn unique_strings<I>(values: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| clean(&value))
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.to_lowercase()))
        .collect()
}

fn https_url(value: Option<&Value>) -> String {
    let url = clean_value(value);
    if url.starts_with("https://") {
        url
    } else {
        String::new()
    }
}

fn is_english_dictionary_word(value: &str) -> bool {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.is_empty()
        || chars.len() > 64
        || chars.iter().any(|character| character.is_whitespace())
    {
        return false;
    }
    if !chars[0].is_ascii_alphabetic() {
        return false;
    }
    chars
        .iter()
        .all(|character| character.is_ascii_alphabetic() || *character == '\'' || *character == '-')
}

fn is_chinese_dictionary_word(value: &str) -> bool {
    let chars = value.chars().collect::<Vec<_>>();
    !chars.is_empty()
        && chars.len() <= 16
        && chars
            .iter()
            .all(|character| ('\u{4e00}'..='\u{9fff}').contains(character))
}
