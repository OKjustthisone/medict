use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

use crate::word_lookup::LookupConfig;

const BAIDU_TOKEN_URL: &str = "https://aip.baidubce.com/oauth/2.0/token";
const BAIDU_DICTIONARY_URL: &str = "https://aip.baidubce.com/rpc/2.0/mt/texttrans-with-dict/v1";
const BAIDU_DOC_URL: &str = "https://cloud.baidu.com/doc/MT/s/nkqrzmbpc";
const BAIDU_MIN_INTERVAL: Duration = Duration::from_millis(1100);

static BAIDU_TOKENS: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
static BAIDU_REQUESTS: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

pub async fn query_google(
    query: &str,
    config: &LookupConfig,
    source: &str,
    target: &str,
) -> Result<Option<Value>, String> {
    if !config.google_enabled {
        return Ok(None);
    }
    let mode =
        if config.google_mode.eq_ignore_ascii_case("cloud") && !config.google_api_key.is_empty() {
            "cloud"
        } else {
            "web"
        };
    let result = if mode == "cloud" {
        query_google_cloud(query, config, source, target).await?
    } else {
        query_google_web(query, source, target).await?
    };
    Ok(result)
}

async fn query_google_web(
    query: &str,
    source: &str,
    target: &str,
) -> Result<Option<Value>, String> {
    let client = build_client(20)?;
    let url = format!(
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl={}&tl={}&dt=t&q={}",
        urlencoding::encode(if source == "auto" { "auto" } else { source }),
        urlencoding::encode(target),
        urlencoding::encode(query)
    );
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Google 翻译请求失败：{error}"))?;
    let data = response_json(response, "Google 翻译").await?;
    let translations = data
        .get(0)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| row.get(0))
        .filter_map(Value::as_str)
        .map(clean)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let translations = unique(translations);
    if translations.is_empty() {
        return Ok(None);
    }
    Ok(Some(json!({
        "type": "translation",
        "provider": "google",
        "name": "Google 翻译",
        "query": query,
        "detectedSource": clean(data.get(2).and_then(Value::as_str).unwrap_or(source)),
        "translations": translations,
        "source": {
            "id": "google-web",
            "name": "Google 翻译",
            "license": "Google 服务条款；兼容接口可能变更",
            "url": "https://translate.google.com/"
        },
        "mode": "web"
    })))
}

async fn query_google_cloud(
    query: &str,
    config: &LookupConfig,
    source: &str,
    target: &str,
) -> Result<Option<Value>, String> {
    let client = build_client(20)?;
    let mut body = json!({
        "q": query,
        "target": target,
        "format": "text"
    });
    if source != "auto" {
        body["source"] = json!(source);
    }
    let url = format!(
        "https://translation.googleapis.com/language/translate/v2?key={}",
        urlencoding::encode(&config.google_api_key)
    );
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("Google Cloud Translation 请求失败：{error}"))?;
    let data = response_json(response, "Google Cloud Translation").await?;
    let rows = data
        .get("data")
        .and_then(|value| value.get("translations"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let translations = unique(
        rows.iter()
            .filter_map(|row| row.get("translatedText"))
            .filter_map(Value::as_str)
            .map(clean),
    );
    if translations.is_empty() {
        return Ok(None);
    }
    let detected_source = rows
        .first()
        .and_then(|row| row.get("detectedSourceLanguage"))
        .and_then(Value::as_str)
        .unwrap_or(source);
    Ok(Some(json!({
        "type": "translation",
        "provider": "google",
        "name": "Google Cloud Translation",
        "query": query,
        "detectedSource": detected_source,
        "translations": translations,
        "source": {
            "id": "google",
            "name": "Google Cloud Translation",
            "license": "Google Cloud API terms",
            "url": "https://cloud.google.com/translate"
        },
        "mode": "cloud"
    })))
}

pub async fn query_baidu(
    query: &str,
    config: &LookupConfig,
    source: &str,
    target: &str,
    dictionary_query: bool,
) -> Result<Option<Value>, String> {
    if !config.baidu_enabled {
        return Ok(None);
    }
    if config.baidu_api_key.is_empty() || config.baidu_secret_key.is_empty() {
        return Err("百度 API Key / Secret Key 未填写".to_string());
    }
    let token = get_baidu_access_token(config).await?;
    wait_for_baidu_request(&config.baidu_api_key, &config.baidu_secret_key).await;
    let from = if dictionary_query {
        "en".to_string()
    } else {
        source_for_baidu(source)
    };
    let to = target_for_baidu(target);
    let client = build_client(20)?;
    let url = format!(
        "{}?access_token={}",
        BAIDU_DICTIONARY_URL,
        urlencoding::encode(&token)
    );
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&json!({ "q": query, "from": from, "to": to }))
        .send()
        .await
        .map_err(|error| format!("百度请求失败：{error}"))?;
    let data = response_json(response, "百度翻译").await?;
    if let Some(code) = data.get("error_code") {
        let code = clean_value(Some(code));
        let message = clean_value(data.get("error_msg"));
        return Err(format!(
            "百度错误码 {code}：{}{}",
            baidu_error_message(&code),
            if message.is_empty() {
                String::new()
            } else {
                format!("（{message}）")
            }
        ));
    }
    let result = data.get("result").cloned().unwrap_or(Value::Null);
    let rows = result
        .get("trans_result")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let translations = unique(
        rows.iter()
            .filter_map(|row| row.get("dst"))
            .filter_map(Value::as_str)
            .map(clean),
    );
    let dictionary_entry = rows
        .iter()
        .find_map(|row| row.get("dict"))
        .and_then(|value| {
            normalize_baidu_dictionary(value, query, rows.first().unwrap_or(&Value::Null))
        });
    if translations.is_empty() && dictionary_entry.is_none() {
        return Ok(None);
    }
    let mut output = json!({
        "type": "translation",
        "provider": "baidu",
        "name": "百度翻译",
        "query": query,
        "detectedSource": clean_value(result.get("from")).if_empty_then(&from),
        "translations": translations,
        "source": {
            "id": "baidu-dictionary",
            "name": "百度翻译·词典版",
            "license": "百度翻译 API 条款",
            "url": BAIDU_DOC_URL
        }
    });
    if let Some(dictionary_entry) = dictionary_entry {
        output["dictionaryEntry"] = dictionary_entry;
    }
    Ok(Some(output))
}

pub async fn query_oxford(query: &str, config: &LookupConfig) -> Result<Option<Value>, String> {
    if !config.oxford_enabled {
        return Ok(None);
    }
    if config.oxford_app_id.is_empty() || config.oxford_app_key.is_empty() {
        return Err("Oxford App ID / App Key 未填写".to_string());
    }
    let locale = if config.oxford_locale.is_empty() {
        "en-gb"
    } else {
        config.oxford_locale.as_str()
    };
    let client = build_client(20)?;
    let normalized_query = clean(query).to_ascii_lowercase();
    let encoded = urlencoding::encode(&normalized_query);
    let base = "https://od-api.oxforddictionaries.com/api/v2";
    let first_url = format!("{base}/words/{locale}/{encoded}");
    let response = client
        .get(first_url)
        .header("app_id", &config.oxford_app_id)
        .header("app_key", &config.oxford_app_key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Oxford 请求失败：{error}"))?;
    let data = if response.status() == StatusCode::NOT_FOUND {
        let response = client
            .get(format!("{base}/words/{locale}?q={encoded}"))
            .header("app_id", &config.oxford_app_id)
            .header("app_key", &config.oxford_app_key)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|error| format!("Oxford 搜索请求失败：{error}"))?;
        response_json(response, "Oxford").await?
    } else {
        response_json(response, "Oxford").await?
    };
    Ok(normalize_oxford(&data, query, locale))
}

pub async fn query_merriam_webster(
    query: &str,
    config: &LookupConfig,
) -> Result<Option<Value>, String> {
    if !config.merriam_webster_enabled {
        return Ok(None);
    }
    if config.merriam_webster_api_key.is_empty() {
        return Err("Merriam-Webster API Key 未填写".to_string());
    }
    let client = build_client(20)?;
    let url = format!(
        "https://www.dictionaryapi.com/api/v3/references/collegiate/json/{}?key={}",
        urlencoding::encode(&clean(query).to_ascii_lowercase()),
        urlencoding::encode(&config.merriam_webster_api_key)
    );
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Merriam-Webster 请求失败：{error}"))?;
    let data = response_json(response, "Merriam-Webster").await?;
    let rows = data.as_array().cloned().unwrap_or_default();
    if rows.is_empty() {
        return Ok(None);
    }
    if rows.first().is_some_and(Value::is_string) {
        let suggestions = unique(rows.iter().filter_map(Value::as_str).map(clean));
        return Ok(Some(json!({
            "type": "suggestions",
            "provider": "merriam-webster",
            "name": "Merriam-Webster Collegiate API",
            "word": query,
            "suggestions": suggestions,
            "source": {
                "id": "merriam-webster",
                "name": "Merriam-Webster Collegiate API",
                "license": "Merriam-Webster API license required",
                "url": format!("https://www.merriam-webster.com/dictionary/{}", urlencoding::encode(query))
            }
        })));
    }
    Ok(normalize_merriam(&rows[0], query))
}

fn build_client(timeout_seconds: u64) -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(timeout_seconds))
        .user_agent("Medict-Rust/0.1")
        .build()
        .map_err(|error| format!("创建在线服务客户端失败：{error}"))
}

async fn response_json(response: reqwest::Response, provider: &str) -> Result<Value, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取 {provider} 响应失败：{error}"))?;
    let data = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = clean_value(data.get("message")).if_empty_then(&body);
        return Err(format!(
            "{provider} 返回 HTTP {}：{detail}",
            status.as_u16()
        ));
    }
    Ok(data)
}

async fn get_baidu_access_token(config: &LookupConfig) -> Result<String, String> {
    let key = format!("{}\u{0}{}", config.baidu_api_key, config.baidu_secret_key);
    if let Some((token, expires_at)) = BAIDU_TOKENS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|cache| cache.get(&key).cloned())
    {
        if expires_at > Instant::now() + Duration::from_secs(60) {
            return Ok(token);
        }
    }
    let client = build_client(20)?;
    let url = format!(
        "{BAIDU_TOKEN_URL}?grant_type=client_credentials&client_id={}&client_secret={}",
        urlencoding::encode(&config.baidu_api_key),
        urlencoding::encode(&config.baidu_secret_key)
    );
    let response = client
        .post(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("百度鉴权请求失败：{error}"))?;
    let data = response_json(response, "百度鉴权").await?;
    let Some(token) = data.get("access_token").and_then(Value::as_str) else {
        return Err(format!(
            "百度鉴权失败{}",
            data.get("error_description")
                .and_then(Value::as_str)
                .map(|message| format!("：{message}"))
                .unwrap_or_default()
        ));
    };
    let expires_in = data
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(2_592_000)
        .max(60);
    if let Ok(mut cache) = BAIDU_TOKENS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cache.insert(
            key,
            (
                token.to_string(),
                Instant::now() + Duration::from_secs(expires_in),
            ),
        );
    }
    Ok(token.to_string())
}

async fn wait_for_baidu_request(api_key: &str, secret_key: &str) {
    let key = format!("{}\u{0}{}", api_key, secret_key);
    let wait = if let Ok(mut requests) = BAIDU_REQUESTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        let now = Instant::now();
        let start = requests
            .get(&key)
            .copied()
            .filter(|value| *value > now)
            .unwrap_or(now);
        requests.insert(key, start + BAIDU_MIN_INTERVAL);
        start.saturating_duration_since(now)
    } else {
        Duration::ZERO
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

fn normalize_baidu_dictionary(data: &Value, query: &str, translation: &Value) -> Option<Value> {
    let simple_means = data.get("simple_means").unwrap_or(&Value::Null);
    let word_result = data.get("word_result").unwrap_or(&Value::Null);
    let edict = word_result.get("edict").unwrap_or(&Value::Null);
    let symbols = value_rows(simple_means.get("symbols"));
    let parts = symbols
        .iter()
        .flat_map(|symbol| value_rows(symbol.get("parts")))
        .map(|part| {
            json!({
                "partOfSpeech": clean_value(part.get("part")).if_empty_then(&clean_value(part.get("part_name"))),
                "translations": unique(value_strings(part.get("means")))
            })
        })
        .filter(|part| {
            !clean_value(part.get("partOfSpeech")).is_empty()
                || part
                    .get("translations")
                    .and_then(Value::as_array)
                    .is_some_and(|rows| !rows.is_empty())
        })
        .collect::<Vec<_>>();
    let mut senses = Vec::new();
    for item in value_rows(edict.get("item")) {
        let part_of_speech = clean_value(item.get("pos"));
        let matching = parts
            .iter()
            .filter(|part| {
                part_of_speech_matches(
                    &part
                        .get("partOfSpeech")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    &part_of_speech,
                )
            })
            .flat_map(|part| value_strings(part.get("translations")))
            .collect::<Vec<_>>();
        let groups = value_rows(item.get("tr_group"));
        for group in &groups {
            let definitions = unique(value_strings(group.get("tr")));
            let examples = unique(value_strings(group.get("example")));
            let synonyms = unique(value_strings(group.get("similar_word")));
            let rows = if definitions.is_empty() {
                vec![String::new()]
            } else {
                definitions
            };
            for (index, definition) in rows.into_iter().enumerate() {
                let translations = if index == 0 {
                    matching.clone()
                } else {
                    Vec::new()
                };
                if !definition.is_empty() || !translations.is_empty() || !examples.is_empty() {
                    senses.push(json!({
                        "partOfSpeech": part_of_speech,
                        "definition": definition,
                        "translations": translations,
                        "examples": if index == 0 { examples.clone() } else { Vec::<String>::new() },
                        "synonyms": synonyms
                    }));
                }
            }
        }
        if groups.is_empty() && !matching.is_empty() {
            senses.push(json!({
                "partOfSpeech": part_of_speech,
                "definition": "",
                "translations": matching,
                "examples": [],
                "synonyms": []
            }));
        }
    }
    if senses.is_empty() {
        for part in &parts {
            senses.push(json!({
                "partOfSpeech": clean_value(part.get("partOfSpeech")),
                "definition": "",
                "translations": part.get("translations").cloned().unwrap_or_else(|| json!([])),
                "examples": [],
                "synonyms": []
            }));
        }
    }
    if senses.is_empty() {
        let word_means = unique(value_strings(simple_means.get("word_means")));
        if !word_means.is_empty() {
            senses.push(json!({
                "partOfSpeech": "",
                "definition": "",
                "translations": word_means,
                "examples": [],
                "synonyms": []
            }));
        }
    }
    if senses.is_empty() {
        return None;
    }
    let exchange = simple_means.get("exchange").unwrap_or(&Value::Null);
    let form_labels = [
        ("word_third", "第三人称单数"),
        ("word_ing", "现在分词"),
        ("word_done", "过去分词"),
        ("word_past", "过去式"),
        ("word_pl", "复数"),
        ("word_er", "比较级"),
        ("word_est", "最高级"),
    ];
    let word_forms = form_labels
        .iter()
        .filter_map(|(key, label)| {
            let values = unique(value_strings(exchange.get(*key)));
            (!values.is_empty()).then(|| json!({ "label": label, "values": values }))
        })
        .collect::<Vec<_>>();
    let tags = unique(
        [
            value_strings(simple_means.get("tags").and_then(|value| value.get("core"))),
            value_strings(
                simple_means
                    .get("tags")
                    .and_then(|value| value.get("other")),
            ),
        ]
        .into_iter()
        .flatten(),
    );
    let word =
        clean_value(simple_means.get("word_name")).if_empty_then(&clean_value(edict.get("word")));
    let word = if word.is_empty() {
        query.to_string()
    } else {
        word
    };
    let phonetic = symbols
        .iter()
        .flat_map(|symbol| {
            [
                clean_value(symbol.get("ph_en")).map_prefix("英 /", "/"),
                clean_value(symbol.get("ph_am")).map_prefix("美 /", "/"),
                clean_value(symbol.get("ph_other")),
            ]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>()
        .join("  ");
    let audio_url = clean_value(translation.get("src_tts"));
    Some(json!({
        "type": "online-dictionary",
        "provider": "baidu-dictionary",
        "name": "百度词典版",
        "word": word,
        "phonetic": phonetic,
        "audioUrl": if audio_url.starts_with("https://") { audio_url } else { String::new() },
        "wordForms": word_forms,
        "tags": tags,
        "senses": senses,
        "source": {
            "id": "baidu-dictionary",
            "name": "百度翻译·词典版",
            "license": "百度翻译 API",
            "url": BAIDU_DOC_URL
        },
        "meta": { "senseCount": senses.len(), "language": clean_value(data.get("lang")) }
    }))
}

fn normalize_oxford(data: &Value, query: &str, locale: &str) -> Option<Value> {
    let results = value_rows(data.get("results"));
    let mut senses = Vec::new();
    let mut phonetics = Vec::new();
    for result in &results {
        for lexical in value_rows(result.get("lexicalEntries")) {
            let part_of_speech = clean_value(
                lexical
                    .get("lexicalCategory")
                    .and_then(|value| value.get("text"))
                    .or_else(|| lexical.get("lexicalCategory")),
            );
            for entry in value_rows(lexical.get("entries")) {
                for pronunciation in value_rows(entry.get("pronunciations")) {
                    let text = clean_value(pronunciation.get("phoneticSpelling"));
                    let audio = clean_value(pronunciation.get("audioFile"));
                    if !text.is_empty() || !audio.is_empty() {
                        phonetics.push(json!({ "text": text, "audioUrl": audio }));
                    }
                }
                collect_oxford_senses(entry.get("senses"), &part_of_speech, &mut senses);
            }
        }
    }
    if senses.is_empty() && phonetics.is_empty() {
        return None;
    }
    let word = clean_value(results.first().and_then(|value| value.get("word")));
    let word = if word.is_empty() {
        query.to_string()
    } else {
        word
    };
    let phonetic = phonetics
        .iter()
        .find_map(|row| {
            let value = clean_value(row.get("text"));
            (!value.is_empty()).then_some(value)
        })
        .unwrap_or_default();
    let audio_url = phonetics
        .iter()
        .find_map(|row| {
            let value = clean_value(row.get("audioUrl"));
            (!value.is_empty()).then_some(value)
        })
        .unwrap_or_default();
    Some(json!({
        "type": "online-dictionary",
        "provider": "oxford",
        "name": "Oxford Dictionaries API",
        "word": word,
        "phonetic": phonetic,
        "phonetics": phonetics,
        "audioUrl": audio_url,
        "senses": senses,
        "source": {
            "id": "oxford",
            "name": "Oxford Dictionaries API",
            "license": "Oxford API license required",
            "url": format!("https://www.oxfordlearnersdictionaries.com/definition/english/{}", urlencoding::encode(query))
        },
        "meta": { "locale": locale, "senseCount": senses.len() }
    }))
}

fn collect_oxford_senses(value: Option<&Value>, part_of_speech: &str, output: &mut Vec<Value>) {
    for sense in value_rows(value) {
        let definitions = unique(value_strings(sense.get("definitions")));
        let translations = unique(
            value_rows(sense.get("translations"))
                .iter()
                .flat_map(|row| {
                    [
                        clean_value(row.get("text")),
                        clean_value(row.get("translation")),
                    ]
                })
                .collect::<Vec<_>>(),
        );
        let examples = unique(
            value_rows(sense.get("examples"))
                .iter()
                .flat_map(|row| {
                    [
                        clean_value(row.get("text")),
                        clean_value(row.get("example")),
                    ]
                })
                .collect::<Vec<_>>(),
        );
        let synonyms = unique(
            value_rows(sense.get("synonyms"))
                .iter()
                .flat_map(|row| [clean_value(row.get("text")), clean_value(row.get("word"))])
                .collect::<Vec<_>>(),
        );
        if !definitions.is_empty() || !translations.is_empty() || !examples.is_empty() {
            output.push(json!({
                "partOfSpeech": part_of_speech,
                "definition": definitions.first().cloned().unwrap_or_default(),
                "translations": translations,
                "examples": examples,
                "synonyms": synonyms,
                "antonyms": []
            }));
        }
        collect_oxford_senses(sense.get("senses"), part_of_speech, output);
    }
}

fn normalize_merriam(item: &Value, query: &str) -> Option<Value> {
    let definitions = unique(value_strings(item.get("shortdef")));
    let examples = merriam_examples(item.get("def"));
    let word = clean_merriam(
        &clean_value(item.get("meta").and_then(|value| value.get("id")))
            .if_empty_then(&clean_value(
                item.get("hwi").and_then(|value| value.get("hw")),
            ))
            .if_empty_then(query),
    );
    let part_of_speech = clean_value(item.get("fl"));
    let senses = definitions
        .iter()
        .enumerate()
        .map(|(index, definition)| {
            json!({
                "partOfSpeech": part_of_speech,
                "definition": definition,
                "translations": [],
                "examples": if index == 0 { examples.clone() } else { Vec::<String>::new() },
                "synonyms": [],
                "antonyms": []
            })
        })
        .collect::<Vec<_>>();
    let audio_url = merriam_audio_url(item);
    if senses.is_empty() && audio_url.is_empty() {
        return None;
    }
    let phonetic = clean_value(
        item.get("hwi")
            .and_then(|value| value.get("prs"))
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(|value| value.get("mw")),
    );
    Some(json!({
        "type": "online-dictionary",
        "provider": "merriam-webster",
        "name": "Merriam-Webster Collegiate API",
        "word": word,
        "phonetic": phonetic,
        "audioUrl": audio_url,
        "senses": senses,
        "source": {
            "id": "merriam-webster",
            "name": "Merriam-Webster Collegiate API",
            "license": "Merriam-Webster API license required",
            "url": format!("https://www.merriam-webster.com/dictionary/{}", urlencoding::encode(query))
        },
        "meta": { "api": "configured", "senseCount": senses.len() }
    }))
}

fn merriam_examples(value: Option<&Value>) -> Vec<String> {
    let mut output = Vec::new();
    fn visit(value: &Value, output: &mut Vec<String>) {
        let Some(rows) = value.as_array() else {
            return;
        };
        if rows.first().and_then(Value::as_str) == Some("vis") {
            if let Some(items) = rows.get(1).and_then(Value::as_array) {
                for item in items {
                    let text = clean_merriam(&clean_value(item.get("t")));
                    if !text.is_empty() {
                        output.push(text);
                    }
                }
            }
        }
        for row in rows {
            visit(row, output);
        }
    }
    if let Some(value) = value {
        visit(value, &mut output);
    }
    unique(output)
}

fn merriam_audio_url(item: &Value) -> String {
    let audio = item
        .get("hwi")
        .and_then(|value| value.get("prs"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find_map(|row| row.get("sound").and_then(|sound| sound.get("audio")))
        .and_then(Value::as_str)
        .map(clean)
        .unwrap_or_default();
    if audio.is_empty() {
        return String::new();
    }
    let first = audio.chars().next().unwrap_or('0');
    let directory = match first {
        'b' => "b",
        'g' => "gg",
        'p' => "p",
        _ => "number",
    };
    format!("https://media.merriam-webster.com/audio/prons/en/us/mp3/{directory}/{audio}.mp3")
}

fn source_for_baidu(value: &str) -> String {
    match clean(value).to_ascii_lowercase().as_str() {
        "zh-cn" | "zh-chs" => "zh".to_string(),
        "en-us" | "en-gb" => "en".to_string(),
        "ja" => "jp".to_string(),
        "" => "auto".to_string(),
        value => value.to_string(),
    }
}

fn target_for_baidu(value: &str) -> String {
    match clean(value).to_ascii_lowercase().as_str() {
        "zh" | "zh-cn" | "zh-chs" => "zh".to_string(),
        "en-us" | "en-gb" => "en".to_string(),
        "ja" => "jp".to_string(),
        value => value.to_string(),
    }
}

fn baidu_error_message(code: &str) -> &'static str {
    match code {
        "4" => "百度服务集群当前限流，不代表本应用额度已经用完；请稍后重试",
        "6" => "当前应用没有该接口权限，请确认已开通文本翻译-词典版",
        "18" => "百度接口 QPS 超限；Rust 客户端已按应用排队",
        "19" | "31005" => "百度账号或服务的总请求量/字符额度已用完",
        "100" | "110" | "111" => "Access Token 无效或已失效",
        "31105" => "百度不支持当前语种方向",
        "31106" => "百度查询文本超过长度限制",
        "282003" | "282004" => "百度接口参数无效",
        _ => "百度接口返回错误",
    }
}

fn value_rows(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(rows)) => rows.clone(),
        Some(Value::Object(_)) => vec![value.cloned().unwrap_or(Value::Null)],
        _ => Vec::new(),
    }
}

fn value_strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(rows)) => rows
            .iter()
            .flat_map(|row| value_strings(Some(row)))
            .collect(),
        Some(Value::String(value)) => vec![clean(value)],
        Some(Value::Object(map)) => [
            "#text",
            "text",
            "value",
            "word",
            "tran",
            "translation",
            "dst",
        ]
        .iter()
        .find_map(|key| {
            let values = value_strings(map.get(*key));
            (!values.is_empty()).then_some(values)
        })
        .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn unique<I>(values: I) -> Vec<String>
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

fn clean(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_value(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(clean).unwrap_or_default()
}

fn clean_merriam(value: &str) -> String {
    value
        .replace("{wi}", "")
        .replace("{/wi}", "")
        .replace("{bc}", "")
        .replace("{/bc}", "")
        .replace("{it}", "")
        .replace("{/it}", "")
        .replace('{', "")
        .replace('}', "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn part_of_speech_matches(left: &str, right: &str) -> bool {
    if left.is_empty() || right.is_empty() {
        return true;
    }
    let normalize = |value: &str| {
        let lowered = value.trim().to_ascii_lowercase();
        match lowered.trim_end_matches('.') {
            "n" | "noun" => "noun".to_string(),
            "v" | "vi" | "vt" | "verb" => "verb".to_string(),
            "adj" | "adjective" => "adjective".to_string(),
            "adv" | "adverb" => "adverb".to_string(),
            "prep" | "preposition" => "preposition".to_string(),
            value => value.to_string(),
        }
    };
    normalize(left) == normalize(right)
}

trait EmptyFallback {
    fn if_empty_then(self, fallback: &str) -> String;
    fn map_prefix(self, prefix: &str, suffix: &str) -> String;
}

impl EmptyFallback for String {
    fn if_empty_then(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }

    fn map_prefix(self, prefix: &str, suffix: &str) -> String {
        if self.is_empty() {
            String::new()
        } else {
            format!("{prefix}{self}{suffix}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{clean_merriam, part_of_speech_matches};

    #[test]
    fn normalizes_provider_helpers() {
        assert!(part_of_speech_matches("n.", "noun"));
        assert_eq!(
            clean_merriam("{wi}hello{/wi} {bc}world{/bc}"),
            "hello world"
        );
    }
}
