use std::time::Duration;

use reqwest::Client;
use serde_json::{json, Value};

const RXNORM_URL: &str = "https://rxnav.nlm.nih.gov/REST";
const PUBCHEM_URL: &str = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";

pub async fn lookup_drug(query: &str) -> Result<Value, String> {
    let query = clean(query);
    if query.is_empty() {
        return Err("请输入药物名称或编号".to_string());
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(18))
        .user_agent("Medict-Tauri/0.1")
        .build()
        .map_err(|error| format!("创建药物查询网络客户端失败：{error}"))?;
    let mut warnings = Vec::new();
    let rx = resolve_rxnorm(&client, &query, &mut warnings).await;
    let rxcui = rx.get("rxcui").and_then(Value::as_str).unwrap_or_default();
    let canonical_name = rx
        .get("canonicalName")
        .and_then(Value::as_str)
        .unwrap_or(&query)
        .to_string();

    let (rxnav, pubchem) = futures::join!(
        get_rxnav(&client, rxcui, &mut warnings),
        get_pubchem(&client, &canonical_name, &mut warnings)
    );
    let success = !rxcui.is_empty();
    let pubchem = pubchem.unwrap_or_default();
    let rxnav = rxnav.unwrap_or_default();

    Ok(json!({
        "type": "drug",
        "success": success,
        "query": query,
        "name": canonical_name,
        "identifiers": {
            "rxcui": if rxcui.is_empty() { Value::Null } else { json!(rxcui) },
            "pubchemCid": pubchem.get("cid").cloned().unwrap_or(Value::Null)
        },
        "names": {
            "preferred": canonical_name,
            "generic": [canonical_name],
            "brands": [],
            "aliases": rx.get("aliases").cloned().unwrap_or_else(|| json!([]))
        },
        "format": {
            "description": pubchem.get("moleculeType").cloned().unwrap_or(Value::Null)
        },
        "structure": if !pubchem.is_object() { Value::Null } else { json!(pubchem) },
        "prescription": rxnav.get("prescription").cloned().unwrap_or_else(|| json!({})),
        "classes": rxnav.get("classes").cloned().unwrap_or_else(|| json!({
            "atc": [], "epc": [], "moa": [], "pe": []
        })),
        "mechanisms": [],
        "indications": [],
        "approvals": [],
        "trials": [],
        "preclinical": [],
        "development": {},
        "sources": {
            "rxnorm": if rxcui.is_empty() { Value::Null } else {
                json!(format!("https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm={rxcui}"))
            },
            "pubchem": pubchem.get("cid").map(|cid| {
                json!(format!("https://pubchem.ncbi.nlm.nih.gov/compound/{cid}"))
            }).unwrap_or(Value::Null),
            "clinicalTrials": json!(format!(
                "https://clinicaltrials.gov/search?intr={}",
                urlencoding::encode(&canonical_name)
            ))
        },
        "warnings": warnings,
        "migration": {
            "implemented": true,
            "feature": "rxnorm-pubchem",
            "remaining": ["chembl", "fda", "clinicaltrials"]
        }
    }))
}

async fn resolve_rxnorm(client: &Client, query: &str, warnings: &mut Vec<String>) -> Value {
    let exact_url = format!(
        "{RXNORM_URL}/rxcui.json?name={}&search=2",
        urlencoding::encode(query)
    );
    let exact = safe_json(client, &exact_url, warnings, "RxNorm 精确查询").await;
    let mut rxcui = exact
        .as_ref()
        .and_then(|data| data.get("idGroup"))
        .and_then(|group| group.get("rxnormId"))
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if rxcui.is_empty() {
        let approximate_url = format!(
            "{RXNORM_URL}/approximateTerm.json?term={}&maxEntries=5&option=1",
            urlencoding::encode(query)
        );
        let approximate = safe_json(client, &approximate_url, warnings, "RxNorm 模糊匹配").await;
        if let Some(candidate) = approximate
            .as_ref()
            .and_then(|data| data.get("approximateGroup"))
            .and_then(|group| group.get("candidate"))
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
        {
            let score = candidate
                .get("score")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<f64>().ok())
                .unwrap_or_default();
            if score >= 80.0 {
                rxcui = candidate
                    .get("rxcui")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
        }
    }
    if rxcui.is_empty() {
        return json!({ "rxcui": "", "canonicalName": query, "aliases": [] });
    }

    let properties_url = format!("{RXNORM_URL}/rxcui/{rxcui}/properties.json");
    let aliases_url = format!("{RXNORM_URL}/rxcui/{rxcui}/allProperties.json?prop=names");
    let properties = safe_json(client, &properties_url, warnings, "RxNorm 属性").await;
    let aliases = safe_json(client, &aliases_url, warnings, "RxNorm 别名").await;
    let canonical_name = properties
        .get("properties")
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(query)
        .to_string();
    let aliases = aliases
        .get("propConceptGroup")
        .and_then(|value| value.get("propConcept"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row.get("propValue").and_then(Value::as_str))
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "rxcui": rxcui,
        "canonicalName": canonical_name,
        "aliases": unique_strings(aliases)
    })
}

async fn get_rxnav(client: &Client, rxcui: &str, warnings: &mut Vec<String>) -> Option<Value> {
    if rxcui.is_empty() {
        return None;
    }
    let terms_url = format!("{RXNORM_URL}/RxTerms/rxcui/{rxcui}/allinfo.json");
    let classes_url = format!("{RXNORM_URL}/rxclass/class/byRxcui.json?rxcui={rxcui}");
    let (terms, classes) = futures::join!(
        safe_json(client, &terms_url, warnings, "RxTerms"),
        safe_json(client, &classes_url, warnings, "RxClass")
    );
    let prescription = terms
        .get("rxtermsProperties")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut output = json!({ "atc": [], "epc": [], "moa": [], "pe": [] });
    if let Some(rows) = classes
        .get("rxclassDrugInfoList")
        .and_then(|value| value.get("rxclassDrugInfo"))
        .and_then(Value::as_array)
    {
        for row in rows {
            let item = row.get("rxclassMinConceptItem");
            let Some(item) = item else {
                continue;
            };
            let class_type = clean_value(item.get("classType"));
            let class_name = clean_value(item.get("className"));
            let class_id = clean_value(item.get("classId"));
            if class_name.is_empty() {
                continue;
            }
            if class_type == "ATC" {
                output["atc"].as_array_mut().unwrap().push(json!({
                    "code": class_id,
                    "name": class_name
                }));
            } else if class_type == "EPC" {
                output["epc"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(class_name));
            } else if class_type == "MoA" {
                output["moa"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(class_name));
            } else if class_type == "PE" {
                output["pe"].as_array_mut().unwrap().push(json!(class_name));
            }
        }
    }
    Some(json!({ "prescription": prescription, "classes": output }))
}

async fn get_pubchem(client: &Client, name: &str, warnings: &mut Vec<String>) -> Option<Value> {
    let url = format!(
        "{PUBCHEM_URL}/compound/name/{}/property/Title,MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,IsomericSMILES/JSON",
        urlencoding::encode(name)
    );
    let data = safe_json(client, &url, warnings, "PubChem").await;
    let row = data
        .get("PropertyTable")
        .and_then(|value| value.get("Properties"))
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())?;
    let cid = row.get("CID").cloned().unwrap_or(Value::Null);
    Some(json!({
        "cid": cid,
        "title": row.get("Title").cloned().unwrap_or(Value::Null),
        "formula": row.get("MolecularFormula").cloned().unwrap_or(Value::Null),
        "molecularWeight": row.get("MolecularWeight").cloned().unwrap_or(Value::Null),
        "iupac": row.get("IUPACName").cloned().unwrap_or(Value::Null),
        "smiles": row.get("CanonicalSMILES").cloned().unwrap_or(Value::Null),
        "isomericSmiles": row.get("IsomericSMILES").cloned().unwrap_or(Value::Null),
        "imageUrl": cid.as_i64().map(|value| format!("{PUBCHEM_URL}/compound/cid/{value}/PNG"))
    }))
}

async fn safe_json(client: &Client, url: &str, warnings: &mut Vec<String>, label: &str) -> Value {
    match client.get(url).send().await {
        Ok(response) if response.status().is_success() => match response.json::<Value>().await {
            Ok(value) => value,
            Err(error) => {
                warnings.push(format!("{label}：解析失败：{error}"));
                json!({})
            }
        },
        Ok(response) => {
            warnings.push(format!("{label}：HTTP {}", response.status()));
            json!({})
        }
        Err(error) => {
            warnings.push(format!("{label}：{error}"));
            json!({})
        }
    }
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

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut output = Vec::new();
    for value in values {
        let value = clean(&value);
        if value.is_empty()
            || output
                .iter()
                .any(|item: &String| item.eq_ignore_ascii_case(&value))
        {
            continue;
        }
        output.push(value);
    }
    output
}
