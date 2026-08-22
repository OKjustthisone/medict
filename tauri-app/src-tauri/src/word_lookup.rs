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
    pub source_language: String,
    pub target_language: String,
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

#[derive(Clone, Debug)]
struct LanguagePair {
    source: String,
    target: String,
    detected_source: String,
    lookup_language: String,
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
    let language_pair =
        resolve_language_pair(&query, &config.source_language, &config.target_language);
    let dictionary_query = is_dictionary_query(&query);
    let english_query = is_english_dictionary_word(&query);
    let word = if english_query {
        query.to_ascii_lowercase()
    } else {
        query.clone()
    };
    let (youdao_result, free_result) = futures::join!(
        query_youdao(
            &word,
            config.youdao_enabled,
            &language_pair,
            dictionary_query
        ),
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
                "sourceLanguage": language_pair.source,
                "targetLanguage": language_pair.target,
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
        "sourceLanguage": language_pair.source,
        "targetLanguage": language_pair.target,
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

fn normalize_language(value: &str) -> String {
    match clean(value).to_ascii_lowercase().as_str() {
        "zh" | "zh-cn" | "zh-chs" | "zh-hans" => "zh-CN".to_string(),
        "en-us" | "en-gb" => "en".to_string(),
        "jp" | "jpn" => "ja".to_string(),
        "kor" => "ko".to_string(),
        "fra" => "fr".to_string(),
        "" => "auto".to_string(),
        other => other.to_string(),
    }
}

fn detect_language(value: &str) -> String {
    if value
        .chars()
        .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
    {
        return "zh-CN".to_string();
    }
    if value
        .chars()
        .any(|character| ('\u{3040}'..='\u{30ff}').contains(&character))
    {
        return "ja".to_string();
    }
    if value
        .chars()
        .any(|character| ('\u{ac00}'..='\u{d7af}').contains(&character))
    {
        return "ko".to_string();
    }
    if value
        .chars()
        .any(|character| character.is_ascii_alphabetic())
    {
        return "en".to_string();
    }
    "auto".to_string()
}

fn resolve_language_pair(
    query: &str,
    configured_source: &str,
    configured_target: &str,
) -> LanguagePair {
    let configured_source = normalize_language(configured_source);
    let mut target = normalize_language(configured_target);
    if target == "auto" {
        target = "zh-CN".to_string();
    }
    let detected_source = detect_language(query);
    let source = if configured_source == "auto" {
        detected_source.clone()
    } else {
        configured_source.clone()
    };

    // Keep the default pair useful in both directions: Chinese goes to
    // English, while English goes to Simplified Chinese. This mirrors the
    // Electron requestLanguagePair behavior and also avoids same-language
    // dictionary requests when the user leaves the controls at defaults.
    if configured_source == "auto" && source == "zh-CN" && target == "zh-CN" {
        target = "en".to_string();
    } else if configured_source == "auto" && source == "en" && target == "en" {
        target = "zh-CN".to_string();
    }

    let lookup_language = if source == "zh-CN" {
        if target == "zh-CN" {
            "en".to_string()
        } else {
            target.clone()
        }
    } else if source == "auto" {
        "en".to_string()
    } else {
        source.clone()
    };

    LanguagePair {
        source,
        target,
        detected_source,
        lookup_language,
    }
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

async fn query_youdao(
    query: &str,
    enabled: bool,
    language_pair: &LanguagePair,
    dictionary_query: bool,
) -> Result<Option<Value>, String> {
    if !enabled || query.is_empty() {
        return Ok(None);
    }
    let client = build_client(8)?;
    let url = format!(
        "{}?q={}&le={}&dicts={}",
        YOUDAO_FAST_URL,
        urlencoding::encode(query),
        urlencoding::encode(&language_pair.lookup_language),
        urlencoding::encode(YOUDAO_FAST_SECTIONS)
    );
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .header("Referer", "https://fanyi.youdao.com/")
        .header("Cookie", "OUTFOX_SEARCH_USER_ID=1796239350@10.110.96.157;")
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
    if dictionary_query {
        if let Some(entry) = normalize_youdao_fast(&data, query, language_pair) {
            return Ok(Some(entry));
        }
    }
    Ok(normalize_youdao_translation(&data, query, language_pair))
}

fn normalize_youdao_translation(
    data: &Value,
    query: &str,
    language_pair: &LanguagePair,
) -> Option<Value> {
    let mut translations = Vec::new();
    translations.extend(string_values(
        data.get("fanyi").and_then(|value| value.get("tran")),
    ));
    translations.extend(string_values(
        data.get("ec").and_then(|value| value.get("web_trans")),
    ));
    for row in value_rows(
        data.get("web_trans")
            .and_then(|value| value.get("web-translation")),
    ) {
        for item in value_rows(row.get("trans")) {
            translations.extend(legacy_values(Some(&item)));
        }
    }
    if translations.is_empty() {
        for section in ["ec", "ce"] {
            for row in value_rows(
                data.get(section)
                    .and_then(|value| value.get("word"))
                    .and_then(|value| value.get("trs")),
            ) {
                translations.extend(legacy_values(row.get("tran")));
                translations.extend(legacy_values(row.get("translation")));
                translations.extend(legacy_values(row.get("text")));
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
        "detectedSource": language_pair.detected_source,
        "targetLanguage": language_pair.target,
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
                urlencoding::encode(&language_pair.lookup_language)
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

fn youdao_word(data: &Value, section: &str) -> Option<Value> {
    let value = data.get(section)?.get("word")?;
    match value {
        Value::Array(rows) => rows.first().cloned(),
        Value::Object(_) => Some(value.clone()),
        _ => None,
    }
}

fn value_rows(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(rows)) => rows.clone(),
        Some(Value::Object(_)) => vec![value.cloned().unwrap_or(Value::Null)],
        _ => Vec::new(),
    }
}

fn legacy_values(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(rows)) => rows
            .iter()
            .flat_map(|row| legacy_values(Some(row)))
            .collect(),
        Some(Value::String(text)) => {
            let text = clean(text);
            if text.is_empty() {
                Vec::new()
            } else {
                vec![text]
            }
        }
        Some(Value::Object(map)) => {
            for key in [
                "#text",
                "text",
                "word",
                "tran",
                "translation",
                "#tran",
                "value",
            ] {
                let values = legacy_values(map.get(key));
                if !values.is_empty() {
                    return values;
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn split_english_pos_label(value: &str) -> Option<(String, String)> {
    let dot = value.find('.')?;
    let label = value.get(..dot)?.trim();
    if label.is_empty()
        || label.len() > 16
        || !label
            .chars()
            .all(|character| character.is_ascii_alphabetic() || character == '-')
    {
        return None;
    }
    let rest = clean(value.get(dot + 1..).unwrap_or_default());
    (!rest.is_empty()).then(|| (normalize_part_of_speech(label), rest))
}

fn legacy_youdao_senses(word: &Value) -> Vec<(String, Vec<String>)> {
    let mut senses = Vec::new();
    for row in value_rows(word.get("trs")) {
        let nested = value_rows(row.get("tr"));
        let entries = if nested.is_empty() {
            vec![row.clone()]
        } else {
            nested
        };
        for entry in entries {
            let level = entry.get("l").unwrap_or(&entry);
            let raw_pos = first_non_empty(&[
                legacy_values(level.get("pos"))
                    .first()
                    .cloned()
                    .unwrap_or_default(),
                legacy_values(level.get("part"))
                    .first()
                    .cloned()
                    .unwrap_or_default(),
            ]);
            let mut part_of_speech = normalize_part_of_speech(&raw_pos);
            let mut translations = unique_strings(
                legacy_values(level.get("#tran"))
                    .into_iter()
                    .chain(legacy_values(level.get("i")))
                    .chain(legacy_values(level.get("tran")))
                    .chain(legacy_values(level.get("translation")))
                    .chain(legacy_values(level.get("word"))),
            );
            if part_of_speech.is_empty() && !translations.is_empty() {
                if let Some((label, rest)) = split_english_pos_label(&translations[0]) {
                    part_of_speech = label;
                    translations[0] = rest;
                    translations.retain(|value| !value.is_empty());
                } else if let Some((label, rest)) = split_pos_label(&translations[0]) {
                    part_of_speech = label;
                    translations[0] = rest;
                    translations.retain(|value| !value.is_empty());
                }
            }
            if !translations.is_empty() {
                senses.push((part_of_speech, translations));
            }
        }
    }
    senses
}

fn normalize_youdao_fast(data: &Value, query: &str, language_pair: &LanguagePair) -> Option<Value> {
    if youdao_word(data, "ec").is_none() {
        if youdao_word(data, "ce").is_some() {
            return normalize_youdao_chinese(data, query, language_pair);
        }
        return None;
    }
    let word = youdao_word(data, "ec")?;
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
    let basic_senses = legacy_youdao_senses(&word);
    if !basic_senses.is_empty() {
        for (part_of_speech, translations) in &basic_senses {
            append_sense(&mut senses, part_of_speech.clone(), translations.clone());
        }
    } else {
        for row in &concise_rows {
            let raw_pos =
                first_non_empty(&[clean_value(row.get("pos")), clean_value(row.get("part"))]);
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
    }

    let mut examples = Vec::new();
    let mut example_keys = HashSet::new();
    for row in &concise_rows {
        for sentence in value_rows(row.get("sentence")) {
            add_example(
                &mut examples,
                &mut example_keys,
                first_non_empty(&[
                    clean_value(sentence.get("en")),
                    clean_value(sentence.get("enShow")),
                ]),
                clean_value(sentence.get("zh")),
                clean_value(sentence.get("type")),
                first_non_empty(&[
                    clean_value(sentence.get("sentence-speech")),
                    clean_value(sentence.get("sentSpeech")),
                    clean_value(sentence.get("speech")),
                    clean_value(sentence.get("audio")),
                ]),
            );
        }
    }

    for gramcat in value_rows(
        data.get("collins_primary")
            .and_then(|value| value.get("gramcat")),
    ) {
        let part = normalize_part_of_speech(&first_non_empty(&[
            clean_value(gramcat.get("partofspeech")),
            clean_value(gramcat.get("partOfSpeech")),
            clean_value(gramcat.get("gram")),
        ]));
        for row in value_rows(gramcat.get("senses")) {
            let translations = unique_strings(
                [
                    clean_value(row.get("word")),
                    clean_value(row.get("translation")),
                    clean_value(row.get("tran")),
                ]
                .into_iter(),
            );
            for example in value_rows(row.get("examples")) {
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
                    first_non_empty(&[
                        clean_value(example.get("sentence-speech")),
                        clean_value(example.get("speech")),
                        clean_value(example.get("audio")),
                    ]),
                );
            }
            if basic_senses.is_empty() {
                let definition = clean_value(row.get("definition"));
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

    for row in value_rows(
        data.get("blng_sents_part")
            .and_then(|value| value.get("sentence-pair")),
    ) {
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
            first_non_empty(&[
                clean_value(row.get("sentence-speech")),
                clean_value(row.get("speech")),
                clean_value(row.get("audio")),
            ]),
        );
    }

    for row in value_rows(
        data.get("individual")
            .and_then(|value| value.get("pastExamSents")),
    ) {
        add_example(
            &mut examples,
            &mut example_keys,
            clean_value(row.get("en")),
            clean_value(row.get("zh")),
            clean_value(row.get("source")),
            first_non_empty(&[
                clean_value(row.get("sentence-speech")),
                clean_value(row.get("speech")),
                clean_value(row.get("audio")),
            ]),
        );
    }

    for row in value_rows(
        data.get("auth_sents_part")
            .and_then(|value| value.get("sent")),
    ) {
        add_example(
            &mut examples,
            &mut example_keys,
            clean_value(row.get("foreign")),
            String::new(),
            clean_value(row.get("source")),
            clean_value(row.get("speech")),
        );
    }

    for row in value_rows(
        data.get("media_sents_part")
            .and_then(|value| value.get("sent")),
    ) {
        add_example(
            &mut examples,
            &mut example_keys,
            clean_value(row.get("eng")),
            clean_value(row.get("chn")),
            clean_value(row.get("@mediatype")),
            first_non_empty(&[
                clean_value(row.get("sentence-speech")),
                clean_value(row.get("speech")),
                clean_value(row.get("audio")),
            ]),
        );
    }

    for word_row in value_rows(data.get("expand_ec").and_then(|value| value.get("word"))) {
        for item in value_rows(word_row.get("transList")) {
            for sentence in value_rows(item.get("content").and_then(|value| value.get("sents"))) {
                add_example(
                    &mut examples,
                    &mut example_keys,
                    first_non_empty(&[
                        clean_value(sentence.get("sentOrig")),
                        clean_value(sentence.get("sentSpeech")),
                    ]),
                    clean_value(sentence.get("sentTrans")),
                    first_non_empty(&[
                        clean_value(sentence.get("source")),
                        clean_value(sentence.get("sourceType")),
                    ]),
                    clean_value(sentence.get("sentSpeech")),
                );
            }
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
    let word_forms = word
        .get("wfs")
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
                            unique_strings(items.iter().map(|item| clean_value(item.get("value"))))
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
        urlencoding::encode(&language_pair.lookup_language)
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
            "senseCount": sense_count,
            "sourceLanguage": language_pair.source,
            "targetLanguage": language_pair.target
        }
    }))
}

fn legacy_return_phrase(word: &Value, query: &str) -> String {
    let value = word.get("return-phrase");
    let nested = value
        .and_then(|value| value.get("l"))
        .and_then(|value| value.get("i"));
    first_non_empty(&[
        legacy_values(nested).first().cloned().unwrap_or_default(),
        legacy_values(value).first().cloned().unwrap_or_default(),
        query.to_string(),
    ])
}

fn normalize_youdao_chinese(
    data: &Value,
    query: &str,
    language_pair: &LanguagePair,
) -> Option<Value> {
    let word = youdao_word(data, "ce")?;
    let text = legacy_return_phrase(&word, query);
    let mut senses = Vec::new();
    for row in value_rows(word.get("trs")) {
        let nested = value_rows(row.get("tr"));
        let entries = if nested.is_empty() { vec![row] } else { nested };
        for entry in entries {
            let level = entry.get("l").unwrap_or(&entry);
            let translations = unique_strings(
                legacy_values(level.get("i"))
                    .into_iter()
                    .chain(legacy_values(level.get("#text")))
                    .chain(legacy_values(level.get("text")))
                    .chain(legacy_values(level.get("word"))),
            );
            let note = first_non_empty(&[
                legacy_values(level.get("#tran"))
                    .first()
                    .cloned()
                    .unwrap_or_default(),
                legacy_values(level.get("tran"))
                    .first()
                    .cloned()
                    .unwrap_or_default(),
            ]);
            append_sense_with_note(
                &mut senses,
                normalize_part_of_speech(&first_non_empty(&[
                    legacy_values(level.get("pos"))
                        .first()
                        .cloned()
                        .unwrap_or_default(),
                    legacy_values(level.get("part"))
                        .first()
                        .cloned()
                        .unwrap_or_default(),
                ])),
                translations,
                note,
            );
        }
    }
    let web_translations = web_translation_rows(data);
    if senses.is_empty() {
        let direct = web_translations
            .iter()
            .find(|row| clean_value(row.get("word")).eq_ignore_ascii_case(&text))
            .and_then(|row| row.get("translations"))
            .map(|value| string_values(Some(value)))
            .unwrap_or_default();
        append_sense(&mut senses, String::new(), direct);
    }
    if text.is_empty() || senses.is_empty() {
        return None;
    }
    let phone = phonetic(clean_value(word.get("phone")));
    let audio_url = youdao_audio(format!("{}&le=zh", text));
    let phonetics = if phone.is_empty() {
        Vec::new()
    } else {
        vec![json!({ "label": "拼音", "text": phone, "audioUrl": audio_url })]
    };
    let phonetic_text = if phone.is_empty() {
        String::new()
    } else {
        format!("拼音 {phone}")
    };
    let source_url = format!(
        "https://dict.youdao.com/result?word={}&lang={}",
        urlencoding::encode(&text),
        urlencoding::encode(&language_pair.lookup_language)
    );
    Some(json!({
        "type": "online-dictionary",
        "provider": "youdao-dictionary",
        "name": "网易有道词典",
        "word": text,
        "phonetic": phonetic_text,
        "phonetics": phonetics,
        "audioUrl": audio_url,
        "wordForms": [],
        "senses": senses,
        "examples": youdao_dictionary_examples(data),
        "phrases": youdao_phrase_rows(data),
        "relatedWords": youdao_related_word_rows(data),
        "webTranslations": web_translations,
        "tags": youdao_tags(data),
        "source": {
            "id": "youdao-dictionary",
            "name": "网易有道网页词典",
            "license": "有道网页服务",
            "url": source_url
        },
        "meta": {
            "api": "web-v2-fast",
            "senseCount": senses.len(),
            "sourceLanguage": language_pair.source,
            "targetLanguage": language_pair.target
        }
    }))
}

fn append_sense_with_note(
    senses: &mut Vec<Value>,
    part_of_speech: String,
    translations: Vec<String>,
    note: String,
) {
    if translations.is_empty() && note.is_empty() {
        return;
    }
    senses.push(json!({
        "partOfSpeech": part_of_speech,
        "definition": "",
        "translations": unique_strings(translations.into_iter()),
        "examples": [],
        "synonyms": [],
        "antonyms": [],
        "note": note
    }));
}

fn youdao_dictionary_examples(data: &Value) -> Vec<Value> {
    let mut examples = Vec::new();
    let mut example_keys = HashSet::new();
    for row in value_rows(
        data.get("ec")
            .and_then(|value| value.get("word"))
            .and_then(|value| value.get("trs")),
    ) {
        for sentence in value_rows(row.get("sentence")) {
            add_example(
                &mut examples,
                &mut example_keys,
                first_non_empty(&[
                    clean_value(sentence.get("en")),
                    clean_value(sentence.get("enShow")),
                ]),
                clean_value(sentence.get("zh")),
                clean_value(sentence.get("type")),
                first_non_empty(&[
                    clean_value(sentence.get("sentence-speech")),
                    clean_value(sentence.get("sentSpeech")),
                    clean_value(sentence.get("speech")),
                    clean_value(sentence.get("audio")),
                ]),
            );
        }
    }
    for gramcat in value_rows(
        data.get("collins_primary")
            .and_then(|value| value.get("gramcat")),
    ) {
        for sense in value_rows(gramcat.get("senses")) {
            for example in value_rows(sense.get("examples")) {
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
                    first_non_empty(&[
                        clean_value(example.get("sentence-speech")),
                        clean_value(example.get("speech")),
                        clean_value(example.get("audio")),
                    ]),
                );
            }
        }
    }
    for row in value_rows(
        data.get("blng_sents_part")
            .and_then(|value| value.get("sentence-pair")),
    ) {
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
            first_non_empty(&[
                clean_value(row.get("sentence-speech")),
                clean_value(row.get("speech")),
                clean_value(row.get("audio")),
            ]),
        );
    }
    for row in value_rows(
        data.get("individual")
            .and_then(|value| value.get("pastExamSents")),
    ) {
        add_example(
            &mut examples,
            &mut example_keys,
            clean_value(row.get("en")),
            clean_value(row.get("zh")),
            clean_value(row.get("source")),
            first_non_empty(&[
                clean_value(row.get("sentence-speech")),
                clean_value(row.get("speech")),
                clean_value(row.get("audio")),
            ]),
        );
    }
    for row in value_rows(
        data.get("auth_sents_part")
            .and_then(|value| value.get("sent")),
    ) {
        add_example(
            &mut examples,
            &mut example_keys,
            clean_value(row.get("foreign")),
            String::new(),
            clean_value(row.get("source")),
            clean_value(row.get("speech")),
        );
    }
    for row in value_rows(
        data.get("media_sents_part")
            .and_then(|value| value.get("sent")),
    ) {
        add_example(
            &mut examples,
            &mut example_keys,
            clean_value(row.get("eng")),
            clean_value(row.get("chn")),
            clean_value(row.get("@mediatype")),
            first_non_empty(&[
                clean_value(row.get("sentence-speech")),
                clean_value(row.get("speech")),
                clean_value(row.get("audio")),
            ]),
        );
    }
    for word_row in value_rows(data.get("expand_ec").and_then(|value| value.get("word"))) {
        for item in value_rows(word_row.get("transList")) {
            for sentence in value_rows(item.get("content").and_then(|value| value.get("sents"))) {
                add_example(
                    &mut examples,
                    &mut example_keys,
                    first_non_empty(&[
                        clean_value(sentence.get("sentOrig")),
                        clean_value(sentence.get("sentSpeech")),
                    ]),
                    clean_value(sentence.get("sentTrans")),
                    first_non_empty(&[
                        clean_value(sentence.get("source")),
                        clean_value(sentence.get("sourceType")),
                    ]),
                    clean_value(sentence.get("sentSpeech")),
                );
            }
        }
    }
    examples.truncate(MAX_EXAMPLES);
    examples
}

fn youdao_phrase_rows(data: &Value) -> Vec<Value> {
    value_rows(data.get("phrs").and_then(|value| value.get("phrs")))
        .into_iter()
        .filter_map(|row| {
            let phrase = clean_value(row.get("headword"));
            let translations = unique_strings([clean_value(row.get("translation"))].into_iter());
            (!phrase.is_empty() && !translations.is_empty())
                .then(|| json!({ "phrase": phrase, "translations": translations }))
        })
        .take(32)
        .collect()
}

fn youdao_related_word_rows(data: &Value) -> Vec<Value> {
    value_rows(data.get("rel_word").and_then(|value| value.get("rels")))
        .into_iter()
        .flat_map(|row| {
            let rel = row.get("rel");
            let pos = normalize_part_of_speech(&clean_value(
                rel.and_then(|value| value.get("pos")),
            ));
            value_rows(rel.and_then(|value| value.get("words")))
                .into_iter()
                .filter_map(move |word| {
                    let related = clean_value(word.get("word"));
                    (!related.is_empty()).then(|| {
                        json!({
                            "partOfSpeech": pos,
                            "word": related,
                            "translations": unique_strings([clean_value(word.get("tran"))].into_iter())
                        })
                    })
                })
                .collect::<Vec<_>>()
        })
        .take(32)
        .collect()
}

fn web_translation_rows(data: &Value) -> Vec<Value> {
    value_rows(
        data.get("web_trans")
            .and_then(|value| value.get("web-translation")),
    )
    .into_iter()
    .filter_map(|row| {
        let word = clean_value(row.get("key"));
        let translations = unique_strings(
            value_rows(row.get("trans"))
                .into_iter()
                .flat_map(|item| legacy_values(Some(&item)))
                .collect::<Vec<_>>()
                .into_iter(),
        );
        (!word.is_empty() && !translations.is_empty())
            .then(|| json!({ "word": word, "translations": translations }))
    })
    .take(32)
    .collect()
}

fn youdao_tags(data: &Value) -> Vec<String> {
    let value = data
        .get("ec")
        .and_then(|section| section.get("exam_type"))
        .or_else(|| data.get("ce").and_then(|section| section.get("exam_type")));
    unique_strings(legacy_values(value).into_iter())
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
    audio: String,
) {
    let example = strip_markup(&example);
    if example.is_empty() {
        return;
    }
    if is_youdao_word_alignment_row(&example, &translation) {
        return;
    }
    let key = format!("{}\u{0}{}", example, translation);
    if !seen.insert(key) {
        return;
    }
    output.push(json!({
        "example": example,
        "translation": translation,
        "source": source,
        "audioUrl": youdao_audio(audio)
    }));
}

fn is_youdao_word_alignment_row(example: &str, translation: &str) -> bool {
    let trimmed_example = example.trim_end_matches(|character: char| ".!?…".contains(character));
    let words = trimmed_example
        .split_whitespace()
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    if words.len() != 1
        || !words[0].chars().all(|character| {
            character.is_ascii_alphabetic() || character == '\'' || character == '-'
        })
    {
        return false;
    }
    let trimmed_translation =
        translation.trim_end_matches(|character: char| ".!?…".contains(character));
    trimmed_translation
        .split_whitespace()
        .filter(|word| !word.is_empty())
        .count()
        <= 1
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
        "int" | "interj" | "interjection" => "interjection".to_string(),
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
        let mut parts = value.splitn(2, '&');
        let audio_name = parts.next().unwrap_or_default();
        let suffix = parts
            .next()
            .map(|value| format!("&{value}"))
            .unwrap_or_default();
        format!(
            "https://dict.youdao.com/dictvoice?audio={}{}",
            urlencoding::encode(audio_name),
            suffix
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

fn is_dictionary_query(value: &str) -> bool {
    is_english_dictionary_word(value)
        || is_chinese_dictionary_word(value)
        || is_foreign_dictionary_word(value)
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

fn is_foreign_dictionary_word(value: &str) -> bool {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.is_empty()
        || chars.len() > 64
        || chars.iter().any(|character| character.is_whitespace())
    {
        return false;
    }
    if chars.iter().any(|character| {
        character.is_ascii_punctuation()
            && *character != '\''
            && *character != '-'
            && *character != '’'
    }) {
        return false;
    }
    chars.iter().all(|character| {
        character.is_alphabetic()
            || ('\u{4e00}'..='\u{9fff}').contains(character)
            || ('\u{3040}'..='\u{30ff}').contains(character)
            || ('\u{ac00}'..='\u{d7af}').contains(character)
            || *character == '\''
            || *character == '’'
            || *character == '-'
    })
}

#[cfg(test)]
mod tests {
    use super::{
        legacy_youdao_senses, normalize_part_of_speech, normalize_youdao_fast,
        resolve_language_pair, youdao_audio,
    };
    use serde_json::json;

    #[test]
    fn expands_nested_youdao_legacy_senses() {
        let word = json!({
            "trs": [
                { "tr": [{ "l": { "i": ["det. 什么；（指数量的全部）所……的"] } }] },
                { "tr": [{ "l": { "i": ["pron. 什么；多么；无论什么"] } }] },
                { "tr": [{ "l": { "i": ["adj. 什么样的；所有的"] } }] },
                { "tr": [{ "l": { "i": ["adv. 到什么程度"] } }] },
                { "tr": [{ "l": { "i": ["int. 什么，真的吗"] } }] },
                { "tr": [{ "l": { "i": ["conj. 所……的（是……）"] } }] }
            ]
        });

        let senses = legacy_youdao_senses(&word);
        assert_eq!(senses.len(), 6);
        assert_eq!(senses[0].0, "determiner");
        assert_eq!(senses[1].0, "pronoun");
        assert_eq!(senses[2].0, "adjective");
        assert_eq!(senses[3].0, "adverb");
        assert_eq!(senses[4].0, "interjection");
        assert_eq!(senses[5].0, "conjunction");
        assert_eq!(senses[0].1[0], "什么；（指数量的全部）所……的");
        assert_eq!(normalize_part_of_speech("int."), "interjection");
    }

    #[test]
    fn keeps_youdao_example_sections_and_audio_parameters() {
        let data = json!({
            "ec": { "word": [{
                "word": "happy",
                "ukphone": "ˈhæpi",
                "ukspeech": "happy&type=1",
                "trs": []
            }]},
            "collins_primary": { "gramcat": [{
                "partofspeech": "adj.",
                "senses": [{
                    "definition": "快乐的",
                    "examples": [{
                        "example": "Marina was a happy child.",
                        "sense": { "word": "玛丽娜是个快乐的孩子。" }
                    }]
                }]
            }]},
            "blng_sents_part": { "sentence-pair": {
                "sentence": "Happy birthday, sweetheart.",
                "sentence-translation": "生日快乐，亲爱的。",
                "sentence-speech": "Happy+birthday%2C+sweetheart.&le=eng"
            }},
            "auth_sents_part": { "sent": [{
                "foreign": "Ultimately, happy people.",
                "speech": "Ultimately%2C+happy+people.+&le=eng"
            }]},
            "expand_ec": { "word": [{ "transList": [{
                "content": { "sents": [{
                    "sentOrig": "She felt happy.",
                    "sentTrans": "她感到快乐。",
                    "sentSpeech": "She felt happy."
                }]}
            }]}]}
        });

        let pair = resolve_language_pair("happy", "auto", "zh-CN");
        let result = normalize_youdao_fast(&data, "happy", &pair).expect("dictionary result");
        let examples = result
            .get("examples")
            .and_then(|value| value.as_array())
            .expect("examples array");
        assert_eq!(examples.len(), 4);
        assert_eq!(examples[1]["translation"], "生日快乐，亲爱的。");
        assert_eq!(
            examples[1]["audioUrl"],
            "https://dict.youdao.com/dictvoice?audio=Happy%2Bbirthday%252C%2Bsweetheart.&le=eng"
        );
        assert_eq!(
            youdao_audio("happy&type=1".to_string()),
            "https://dict.youdao.com/dictvoice?audio=happy&type=1"
        );
    }

    #[test]
    fn resolves_chinese_to_english_from_youdao_ce_rows() {
        let data = json!({
            "ce": {
                "word": [{
                    "return-phrase": { "l": { "i": "苹果" } },
                    "trs": [{
                        "tr": [{
                            "l": {
                                "i": [{ "#text": "apple" }],
                                "#tran": "苹果；"
                            }
                        }]
                    }]
                }]
            }
        });
        let pair = resolve_language_pair("苹果", "auto", "zh-CN");
        assert_eq!(pair.source, "zh-CN");
        assert_eq!(pair.target, "en");
        assert_eq!(pair.lookup_language, "en");
        let result =
            normalize_youdao_fast(&data, "苹果", &pair).expect("Chinese dictionary result");
        assert_eq!(result["senses"][0]["translations"][0], "apple");
        assert_eq!(result["meta"]["targetLanguage"], "en");
    }
}
