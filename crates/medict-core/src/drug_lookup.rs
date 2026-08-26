use std::{collections::HashSet, time::Duration};

use reqwest::Client;
use serde_json::{json, Value};

const RXNORM_URL: &str = "https://rxnav.nlm.nih.gov/REST";
const PUBCHEM_URL: &str = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
const CHEMBL_URL: &str = "https://www.ebi.ac.uk/chembl/api/data";
const TRIALS_URL: &str = "https://clinicaltrials.gov/api/v2";
const FDA_URL: &str = "https://api.fda.gov/drug/drugsfda.json";
const UNIPROT_URL: &str = "https://rest.uniprot.org/uniprotkb";

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

    let mut chembl_warnings = Vec::new();
    let mut pubchem_warnings = Vec::new();
    let mut fda_warnings = Vec::new();
    let mut trials_warnings = Vec::new();
    let (chembl, pubchem, fda, trials) = futures::join!(
        get_chembl(&client, &query, &mut chembl_warnings),
        get_pubchem(&client, &query, &mut pubchem_warnings),
        get_fda(&client, &query, &mut fda_warnings),
        get_trials(&client, std::slice::from_ref(&query), &mut trials_warnings)
    );
    let mut rxnav_warnings = Vec::new();
    let rxnav = get_rxnav(&client, rxcui, &mut rxnav_warnings).await;
    warnings.extend(rxnav_warnings);
    warnings.extend(chembl_warnings);
    warnings.extend(pubchem_warnings);
    warnings.extend(fda_warnings);
    warnings.extend(trials_warnings);
    let chembl = chembl.unwrap_or_default();
    let pubchem = pubchem.unwrap_or_default();
    let rxnav = rxnav.unwrap_or_default();
    let fda = fda.unwrap_or_default();
    let trials = trials.unwrap_or_default();
    let canonical_name = first_non_empty(&[
        clean_value(chembl.get("preferredName")),
        rx.get("canonicalName")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        query.clone(),
    ]);
    let aliases = unique_strings(
        std::iter::once(query.clone())
            .chain(std::iter::once(canonical_name.clone()))
            .chain(string_values(rx.get("aliases")))
            .chain(string_values(chembl.get("aliases")))
            .collect(),
    );
    let brand_names = unique_strings(
        fda.iter()
            .flat_map(|record| string_values(record.get("brandNames")))
            .collect(),
    );
    let generic_names = unique_strings(
        [canonical_name.clone()]
            .into_iter()
            .chain(
                fda.iter()
                    .flat_map(|record| string_values(record.get("genericNames"))),
            )
            .collect(),
    );
    let success = !rxcui.is_empty() || chembl.is_object() || !fda.is_empty();
    let pubchem_cid = pubchem.get("cid").cloned().unwrap_or(Value::Null);
    let chembl_id = chembl.get("id").cloned().unwrap_or(Value::Null);
    let max_phase = chembl.get("maxPhase").cloned().unwrap_or(Value::Null);

    Ok(json!({
        "type": "drug",
        "success": success,
        "query": query,
        "name": canonical_name,
        "identifiers": {
            "rxcui": if rxcui.is_empty() { Value::Null } else { json!(rxcui) },
            "chembl": chembl_id,
            "pubchemCid": pubchem_cid
        },
        "names": {
            "preferred": canonical_name,
            "generic": generic_names,
            "brands": brand_names,
            "aliases": aliases
        },
        "format": {
            "moleculeType": chembl.get("moleculeType").cloned().unwrap_or(Value::Null),
            "description": if chembl.get("moleculeType").is_some() {
                chembl.get("moleculeType").cloned().unwrap_or(Value::Null)
            } else if pubchem.is_object() {
                json!("Small molecule")
            } else {
                Value::Null
            }
        },
        "structure": if pubchem.is_object() {
            pubchem.clone()
        } else {
            chembl.get("structure").cloned().unwrap_or(Value::Null)
        },
        "prescription": rxnav.get("prescription").cloned().unwrap_or_else(|| json!({})),
        "classes": rxnav.get("classes").cloned().unwrap_or_else(|| json!({
            "atc": [], "epc": [], "moa": [], "pe": []
        })),
        "mechanisms": chembl.get("mechanisms").cloned().unwrap_or_else(|| json!([])),
        "indications": chembl.get("indications").cloned().unwrap_or_else(|| json!([])),
        "approvals": fda,
        "trials": if success { trials } else { Vec::<Value>::new() },
        "preclinical": chembl.get("activities").cloned().unwrap_or_else(|| json!([])),
        "development": {
            "maxPhase": max_phase,
            "firstApprovalYear": chembl.get("firstApproval").cloned().unwrap_or(Value::Null)
        },
        "sources": {
            "rxnorm": if rxcui.is_empty() { Value::Null } else {
                json!(format!("https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm={rxcui}"))
            },
            "chembl": chembl.get("id").and_then(Value::as_str).map(|id| {
                json!(format!("https://www.ebi.ac.uk/chembl/explore/compound/{id}"))
            }).unwrap_or(Value::Null),
            "pubchem": pubchem.get("cid").map(|cid| {
                json!(format!("https://pubchem.ncbi.nlm.nih.gov/compound/{cid}"))
            }).unwrap_or(Value::Null),
            "clinicalTrials": json!(format!(
                "https://clinicaltrials.gov/search?intr={}",
                urlencoding::encode(&canonical_name)
            )),
            "drugsFda": "https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm"
        },
        "warnings": warnings,
        "migration": {
            "implemented": true,
            "feature": "drugshop-data-sources",
            "remaining": []
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
        .get("idGroup")
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
            .get("approximateGroup")
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
    let ingredients_url = format!("{RXNORM_URL}/rxcui/{rxcui}/related.json?tty=IN+PIN");
    let aliases_url = format!("{RXNORM_URL}/rxcui/{rxcui}/allProperties.json?prop=names");
    let mut properties_warnings = Vec::new();
    let mut ingredients_warnings = Vec::new();
    let mut aliases_warnings = Vec::new();
    let (properties, ingredients, aliases) = futures::join!(
        safe_json(
            client,
            &properties_url,
            &mut properties_warnings,
            "RxNorm 属性"
        ),
        safe_json(
            client,
            &ingredients_url,
            &mut ingredients_warnings,
            "RxNorm 成分"
        ),
        safe_json(client, &aliases_url, &mut aliases_warnings, "RxNorm 别名")
    );
    warnings.extend(properties_warnings);
    warnings.extend(ingredients_warnings);
    warnings.extend(aliases_warnings);
    let concepts = ingredients
        .get("allRelatedGroup")
        .and_then(|value| value.get("conceptGroup"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|group| value_rows(group.get("conceptProperties")))
        .collect::<Vec<_>>();
    let ingredient = concepts
        .iter()
        .find(|row| clean_value(row.get("tty")) == "IN")
        .or_else(|| concepts.first());
    let canonical_name = properties
        .get("properties")
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(query)
        .to_string();
    let canonical_name = ingredient
        .map(|row| clean_value(row.get("name")))
        .filter(|value| !value.is_empty())
        .unwrap_or(canonical_name);
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
    let mut terms_warnings = Vec::new();
    let mut classes_warnings = Vec::new();
    let (terms, classes) = futures::join!(
        safe_json(client, &terms_url, &mut terms_warnings, "RxTerms"),
        safe_json(client, &classes_url, &mut classes_warnings, "RxClass")
    );
    warnings.extend(terms_warnings);
    warnings.extend(classes_warnings);
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

async fn get_chembl(client: &Client, query: &str, warnings: &mut Vec<String>) -> Option<Value> {
    let search_url = format!(
        "{CHEMBL_URL}/molecule/search.json?q={}&limit=8",
        urlencoding::encode(query)
    );
    let search = safe_json(client, &search_url, warnings, "ChEMBL 搜索").await;
    let candidates = value_rows(search.get("molecules"));
    let normalized_query = clean(query).to_ascii_lowercase();
    let candidate = candidates.into_iter().find(|item| {
        clean_value(item.get("pref_name")).to_ascii_lowercase() == normalized_query
            || clean_value(item.get("molecule_chembl_id")).to_ascii_lowercase() == normalized_query
    })?;
    let id = clean_value(candidate.get("molecule_chembl_id"));
    if id.is_empty() {
        return None;
    }

    let details_url = format!("{CHEMBL_URL}/molecule/{id}.json");
    let mechanisms_url = format!("{CHEMBL_URL}/mechanism.json?molecule_chembl_id={id}&limit=100");
    let indications_url =
        format!("{CHEMBL_URL}/drug_indication.json?molecule_chembl_id={id}&limit=100");
    let activities_url = format!(
        "{CHEMBL_URL}/activity.json?molecule_chembl_id={id}&pchembl_value__isnull=false&limit=20&order_by=-pchembl_value"
    );
    let mut details_warnings = Vec::new();
    let mut mechanisms_warnings = Vec::new();
    let mut indications_warnings = Vec::new();
    let mut activities_warnings = Vec::new();
    let (details, mechanisms, indications, activities) = futures::join!(
        safe_json(client, &details_url, &mut details_warnings, "ChEMBL 分子"),
        safe_json(
            client,
            &mechanisms_url,
            &mut mechanisms_warnings,
            "ChEMBL 机制"
        ),
        safe_json(
            client,
            &indications_url,
            &mut indications_warnings,
            "ChEMBL 适应症"
        ),
        safe_json(
            client,
            &activities_url,
            &mut activities_warnings,
            "ChEMBL 活性"
        )
    );
    warnings.extend(details_warnings);
    warnings.extend(mechanisms_warnings);
    warnings.extend(indications_warnings);
    warnings.extend(activities_warnings);

    let molecule = if details
        .as_object()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        details
    } else {
        candidate.clone()
    };
    let mechanism_rows = value_rows(mechanisms.get("mechanisms"));
    let target_ids = unique_strings(
        mechanism_rows
            .iter()
            .map(|row| clean_value(row.get("target_chembl_id")))
            .collect(),
    )
    .into_iter()
    .take(8)
    .collect::<Vec<_>>();
    let mut target_details = Vec::new();
    for target_id in target_ids {
        let target_url = format!("{CHEMBL_URL}/target/{target_id}.json");
        let target = safe_json(client, &target_url, warnings, "ChEMBL 靶点").await;
        let component = target
            .get("target_components")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first());
        let accession = clean_value(component.and_then(|row| row.get("accession")));
        let protein = if accession.is_empty() {
            Value::Null
        } else {
            let protein_url = format!("{UNIPROT_URL}/{accession}.json");
            safe_json(client, &protein_url, warnings, "UniProt").await
        };
        let short_name = value_rows(
            protein
                .get("proteinDescription")
                .and_then(|value| value.get("recommendedName"))
                .and_then(|value| value.get("shortNames")),
        )
        .first()
        .map(|row| clean_value(row.get("value")))
        .unwrap_or_default();
        let gene = value_rows(protein.get("genes"))
            .first()
            .map(|row| clean_value(row.get("geneName").and_then(|value| value.get("value"))))
            .unwrap_or_default();
        let function_comment = value_rows(protein.get("comments"))
            .into_iter()
            .find(|row| clean_value(row.get("commentType")) == "FUNCTION")
            .map(|row| {
                value_rows(row.get("texts"))
                    .into_iter()
                    .map(|text| clean_value(text.get("value")))
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        if target
            .as_object()
            .map(|value| !value.is_empty())
            .unwrap_or(false)
        {
            target_details.push(json!({
                "id": target_id,
                "name": clean_value(target.get("pref_name")),
                "accession": accession,
                "componentName": clean_value(component.and_then(|row| row.get("component_description"))),
                "shortName": short_name,
                "gene": gene,
                "functionComment": function_comment
            }));
        }
    }

    let properties = molecule
        .get("molecule_properties")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let structures = molecule
        .get("molecule_structures")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let target_for = |target_id: &str| {
        target_details
            .iter()
            .find(|row| clean_value(row.get("id")).eq_ignore_ascii_case(target_id))
    };
    let mechanisms_output = mechanism_rows
        .iter()
        .map(|row| {
            let target_id = clean_value(row.get("target_chembl_id"));
            let target = target_for(&target_id);
            let direct_interaction = row
                .get("direct_interaction")
                .and_then(Value::as_i64)
                .map(|value| value == 1)
                .or_else(|| {
                    clean_value(row.get("direct_interaction"))
                        .parse::<i64>()
                        .ok()
                        .map(|value| value == 1)
                })
                .unwrap_or(false);
            let target_accession = target
                .and_then(|value| value.get("accession"))
                .cloned()
                .unwrap_or(Value::Null);
            let target_url = clean_value(Some(&target_accession))
                .is_empty()
                .then_some(Value::Null)
                .or_else(|| {
                    Some(json!(format!(
                        "https://www.uniprot.org/uniprotkb/{}/entry",
                        clean_value(Some(&target_accession))
                    )))
                })
                .unwrap_or(Value::Null);
            json!({
                "action": clean_value(row.get("action_type")),
                "mechanism": clean_value(row.get("mechanism_of_action")),
                "targetId": target_id,
                "target": target.map(|value| clean_value(value.get("name"))).filter(|value| !value.is_empty()).unwrap_or_else(|| target_id.clone()),
                "targetShortName": target.and_then(|value| value.get("shortName")).cloned().unwrap_or(Value::Null),
                "targetGene": target.and_then(|value| value.get("gene")).cloned().unwrap_or(Value::Null),
                "targetAccession": target_accession,
                "targetFunction": target.and_then(|value| value.get("functionComment")).cloned().unwrap_or(Value::Null),
                "targetUrl": target_url,
                "bindingSite": row.get("binding_site_name").cloned().unwrap_or(Value::Null),
                "directInteraction": direct_interaction
            })
        })
        .collect::<Vec<_>>();
    let indications_output = value_rows(indications.get("drug_indications"))
        .into_iter()
        .map(|row| {
            json!({
                "name": first_non_empty(&[
                    clean_value(row.get("mesh_heading")),
                    clean_value(row.get("efo_term"))
                ]),
                "meshId": row.get("mesh_id").cloned().unwrap_or(Value::Null),
                "maxPhase": row.get("max_phase_for_ind").cloned().unwrap_or(Value::Null)
            })
        })
        .filter(|row| !clean_value(row.get("name")).is_empty())
        .collect::<Vec<_>>();
    let activities_output = value_rows(activities.get("activities"))
        .into_iter()
        .map(|row| {
            json!({
                "assay": row.get("assay_description").cloned().unwrap_or(Value::Null),
                "type": row.get("standard_type").cloned().unwrap_or(Value::Null),
                "relation": row.get("standard_relation").cloned().unwrap_or(Value::Null),
                "value": row.get("standard_value").cloned().unwrap_or(Value::Null),
                "units": row.get("standard_units").cloned().unwrap_or(Value::Null),
                "pchembl": row.get("pchembl_value").cloned().unwrap_or(Value::Null),
                "targetId": row.get("target_chembl_id").cloned().unwrap_or(Value::Null),
                "target": row.get("target_pref_name").cloned().unwrap_or_else(|| row.get("target_chembl_id").cloned().unwrap_or(Value::Null)),
                "organism": row.get("target_organism").cloned().unwrap_or(Value::Null)
            })
        })
        .collect::<Vec<_>>();
    Some(json!({
        "id": id,
        "preferredName": molecule.get("pref_name").cloned().unwrap_or(Value::Null),
        "moleculeType": molecule.get("molecule_type").cloned().unwrap_or(Value::Null),
        "maxPhase": molecule.get("max_phase").cloned().unwrap_or(Value::Null),
        "firstApproval": molecule.get("first_approval").cloned().unwrap_or(Value::Null),
        "aliases": unique_strings(
            value_rows(molecule.get("molecule_synonyms"))
                .into_iter()
                .map(|row| clean_value(row.get("molecule_synonym")))
                .collect(),
        ),
        "structure": {
            "formula": first_value(&[properties.get("full_molformula"), properties.get("molecular_formula")]),
            "molecularWeight": first_value(&[properties.get("full_mwt"), properties.get("mw_freebase")]),
            "smiles": structures.get("canonical_smiles").cloned().unwrap_or(Value::Null),
            "imageUrl": if structures.get("canonical_smiles").is_some() { json!(format!("{CHEMBL_URL}/image/{id}.svg")) } else { Value::Null }
        },
        "mechanisms": mechanisms_output,
        "indications": indications_output,
        "activities": activities_output
    }))
}

async fn get_fda(client: &Client, query: &str, warnings: &mut Vec<String>) -> Option<Vec<Value>> {
    let escaped = query.replace(['"', '\\'], " ").trim().to_string();
    if escaped.is_empty() {
        return Some(Vec::new());
    }
    let fields = [
        "openfda.generic_name",
        "openfda.brand_name",
        "openfda.substance_name",
    ];
    let urls = fields.map(|field| {
        format!(
            "{FDA_URL}?search={}&limit=10",
            urlencoding::encode(&format!(r#"{field}:"{escaped}""#))
        )
    });
    let mut first_warnings = Vec::new();
    let mut second_warnings = Vec::new();
    let mut third_warnings = Vec::new();
    let (first, second, third) = futures::join!(
        safe_json(client, &urls[0], &mut first_warnings, "FDA"),
        safe_json(client, &urls[1], &mut second_warnings, "FDA"),
        safe_json(client, &urls[2], &mut third_warnings, "FDA")
    );
    warnings.extend(first_warnings);
    warnings.extend(second_warnings);
    warnings.extend(third_warnings);
    let mut records = Vec::new();
    let mut seen = HashSet::new();
    for response in [first, second, third] {
        for record in value_rows(response.get("results")) {
            let application = clean_value(record.get("application_number"));
            if !application.is_empty() && !seen.insert(application) {
                continue;
            }
            let approvals = value_rows(record.get("submissions"))
                .into_iter()
                .filter(|row| clean_value(row.get("submission_status")) == "AP")
                .map(|row| {
                    json!({
                        "date": row.get("submission_status_date").cloned().unwrap_or(Value::Null),
                        "type": row.get("submission_type").cloned().unwrap_or(Value::Null),
                        "class": row.get("submission_class_code_description").cloned().unwrap_or(Value::Null),
                        "documents": row.get("application_docs").cloned().unwrap_or_else(|| json!([]))
                    })
                })
                .collect::<Vec<_>>();
            let mut approvals = approvals;
            approvals.sort_by_key(|row| clean_value(row.get("date")));
            records.push(json!({
                "applicationNumber": record.get("application_number").cloned().unwrap_or(Value::Null),
                "sponsor": record.get("sponsor_name").cloned().unwrap_or(Value::Null),
                "brandNames": unique_strings(
                    string_values(record.get("openfda").and_then(|value| value.get("brand_name")))
                        .into_iter()
                        .chain(value_rows(record.get("products")).into_iter().map(|row| clean_value(row.get("brand_name"))))
                        .collect(),
                ),
                "genericNames": unique_strings(string_values(record.get("openfda").and_then(|value| value.get("generic_name")))),
                "firstApprovalDate": approvals.first().and_then(|row| row.get("date")).cloned().unwrap_or(Value::Null),
                "approvals": approvals
            }));
        }
    }
    Some(records)
}

async fn get_trials(
    client: &Client,
    names: &[String],
    warnings: &mut Vec<String>,
) -> Option<Vec<Value>> {
    let names = unique_strings(names.to_vec())
        .into_iter()
        .take(8)
        .map(|name| format!("\"{}\"", name.replace('"', "")))
        .collect::<Vec<_>>();
    if names.is_empty() {
        return Some(Vec::new());
    }
    let fields = [
        "NCTId",
        "BriefTitle",
        "OverallStatus",
        "Phase",
        "Condition",
        "InterventionName",
        "BriefSummary",
        "StartDate",
        "CompletionDate",
        "HasResults",
        "PrimaryOutcomeMeasure",
        "PrimaryOutcomeDescription",
    ]
    .join(",");
    let url = format!(
        "{TRIALS_URL}/studies?query.intr={}&format=json&pageSize=20&countTotal=true&fields={}",
        urlencoding::encode(&names.join(" OR ")),
        urlencoding::encode(&fields)
    );
    let data = safe_json(client, &url, warnings, "ClinicalTrials.gov").await;
    let studies = value_rows(data.get("studies"));
    Some(
        studies
            .into_iter()
            .filter_map(|study| {
                let protocol = study.get("protocolSection")?;
                let results = study.get("resultsSection").cloned().unwrap_or(Value::Null);
                let id = clean_value(protocol.get("identificationModule").and_then(|value| value.get("nctId")));
                if id.is_empty() {
                    return None;
                }
                let primary = value_rows(
                    results
                        .get("outcomeMeasuresModule")
                        .and_then(|value| value.get("outcomeMeasures")),
                )
                .into_iter()
                .find(|row| clean_value(row.get("type")) == "PRIMARY");
                let primary_result = primary
                    .as_ref()
                    .and_then(|row| value_rows(row.get("classes")).first().cloned())
                    .and_then(|row| value_rows(row.get("categories")).first().cloned())
                    .and_then(|row| value_rows(row.get("measurements")).first().cloned())
                    .and_then(|row| row.get("value").cloned())
                    .unwrap_or(Value::Null);
                let primary_outcome = primary
                    .as_ref()
                    .and_then(|row| row.get("title"))
                    .cloned()
                    .or_else(|| {
                        value_rows(
                            protocol
                                .get("outcomesModule")
                                .and_then(|value| value.get("primaryOutcomes")),
                        )
                        .first()
                        .and_then(|row| row.get("measure").cloned())
                    })
                    .unwrap_or(Value::Null);
                let status = protocol.get("statusModule");
                let design = protocol.get("designModule");
                let conditions = value_rows(
                    protocol
                        .get("conditionsModule")
                        .and_then(|value| value.get("conditions")),
                )
                .into_iter()
                .map(|row| if row.is_string() { row } else { json!(clean_value(Some(&row))) })
                .collect::<Vec<_>>();
                Some(json!({
                    "id": id,
                    "title": protocol.get("identificationModule").and_then(|value| value.get("briefTitle")).cloned().unwrap_or(Value::Null),
                    "status": status.and_then(|value| value.get("overallStatus")).cloned().unwrap_or(Value::Null),
                    "phases": design.and_then(|value| value.get("phases")).cloned().unwrap_or_else(|| json!([])),
                    "conditions": conditions,
                    "startDate": status.and_then(|value| value.get("startDateStruct")).and_then(|value| value.get("date")).cloned().unwrap_or(Value::Null),
                    "completionDate": status.and_then(|value| value.get("completionDateStruct")).and_then(|value| value.get("date")).cloned().unwrap_or(Value::Null),
                    "hasResults": study.get("hasResults").and_then(Value::as_bool).unwrap_or(false) || (results.is_object() && !results.as_object().map(|value| value.is_empty()).unwrap_or(true)),
                    "summary": protocol.get("descriptionModule").and_then(|value| value.get("briefSummary")).cloned().unwrap_or(Value::Null),
                    "primaryOutcome": primary_outcome,
                    "primaryResult": primary_result,
                    "url": format!("https://clinicaltrials.gov/study/{id}")
                }))
            })
            .collect(),
    )
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

fn value_rows(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(rows)) => rows.clone(),
        Some(Value::Object(_)) => vec![value.cloned().unwrap_or(Value::Null)],
        _ => Vec::new(),
    }
}

fn first_value(values: &[Option<&Value>]) -> Value {
    values
        .iter()
        .find_map(|value| value.and_then(|item| (!item.is_null()).then(|| item.clone())))
        .unwrap_or(Value::Null)
}

fn clean(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn first_non_empty(values: &[String]) -> String {
    values
        .iter()
        .find(|value| !value.is_empty())
        .cloned()
        .unwrap_or_default()
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
            .filter_map(Value::as_str)
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
