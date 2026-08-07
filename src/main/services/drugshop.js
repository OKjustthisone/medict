// This service ports the data-source boundary from the existing DrugShop
// extension into the desktop process. It deliberately keeps provider calls
// separate from the renderer so the UI does not need API/network privileges.
const { fetchJson } = require("./dictionary-api");

const API = {
  rxnorm: "https://rxnav.nlm.nih.gov/REST",
  pubchem: "https://pubchem.ncbi.nlm.nih.gov/rest/pug",
  chembl: "https://www.ebi.ac.uk/chembl/api/data",
  trials: "https://clinicaltrials.gov/api/v2",
  fda: "https://api.fda.gov/drug/drugsfda.json",
  europePmc: "https://www.ebi.ac.uk/europepmc/webservices/rest/search",
  uniprot: "https://rest.uniprot.org/uniprotkb"
};

function clean(value) {
  return String(value ?? "").trim();
}

function unique(values) {
  return [...new Set(values.flat(Infinity).map(clean).filter(Boolean))];
}

function uniqueNames(values) {
  const seen = new Set();
  return values.map(clean).filter(value => {
    const key = value.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function safeJson(url, warnings, label, timeout = 12000) {
  try {
    return await fetchJson(url, {}, timeout);
  } catch (error) {
    warnings.push(`${label}：${error.name === "AbortError" ? "请求超时" : error.message}`);
    return null;
  }
}

async function resolveRxNorm(query, warnings) {
  const exact = await safeJson(`${API.rxnorm}/rxcui.json?name=${encodeURIComponent(query)}&search=2`, warnings, "RxNorm");
  let rxcui = exact?.idGroup?.rxnormId?.[0] || null;
  if (!rxcui) {
    const approximate = await safeJson(`${API.rxnorm}/approximateTerm.json?term=${encodeURIComponent(query)}&maxEntries=5&option=1`, warnings, "RxNorm 模糊匹配");
    const candidate = approximate?.approximateGroup?.candidate?.[0];
    rxcui = Number(candidate?.score || 0) >= 80 ? candidate.rxcui : null;
  }
  if (!rxcui) return { rxcui: null, canonicalName: query, aliases: [] };

  const [properties, ingredients, allProperties] = await Promise.all([
    safeJson(`${API.rxnorm}/rxcui/${rxcui}/properties.json`, warnings, "RxNorm 属性"),
    safeJson(`${API.rxnorm}/rxcui/${rxcui}/related.json?tty=IN+PIN`, warnings, "RxNorm 成分"),
    safeJson(`${API.rxnorm}/rxcui/${rxcui}/allProperties.json?prop=names`, warnings, "RxNorm 别名")
  ]);
  const concepts = ingredients?.allRelatedGroup?.conceptGroup?.flatMap(group => group.conceptProperties || []) || [];
  const ingredient = concepts.find(item => item.tty === "IN") || concepts[0];
  const aliases = unique(allProperties?.propConceptGroup?.propConcept?.map(item => item.propValue) || []);
  return {
    rxcui,
    canonicalName: ingredient?.name || properties?.properties?.name || query,
    aliases
  };
}

async function getRxNav(rxcui, warnings) {
  if (!rxcui) return { classes: { atc: [], epc: [], moa: [], pe: [] }, prescription: {} };
  const [terms, classes] = await Promise.all([
    safeJson(`${API.rxnorm}/RxTerms/rxcui/${rxcui}/allinfo.json`, warnings, "RxTerms"),
    safeJson(`${API.rxnorm}/rxclass/class/byRxcui.json?rxcui=${rxcui}`, warnings, "RxClass")
  ]);
  const prescription = terms?.rxtermsProperties || {};
  const output = { atc: [], epc: [], moa: [], pe: [] };
  for (const row of classes?.rxclassDrugInfoList?.rxclassDrugInfo || []) {
    const concept = row.rxclassMinConceptItem;
    if (!concept) continue;
    const item = { code: concept.classId, name: concept.className };
    if (concept.classType === "ATC") output.atc.push(item);
    if (concept.classType === "EPC") output.epc.push(concept.className);
    if (concept.classType === "MoA") output.moa.push(concept.className);
    if (concept.classType === "PE") output.pe.push(concept.className);
  }
  output.epc = unique(output.epc);
  output.moa = unique(output.moa);
  output.pe = unique(output.pe);
  return { classes: output, prescription };
}

async function getChembl(query, warnings) {
  const search = await safeJson(`${API.chembl}/molecule/search.json?q=${encodeURIComponent(query)}&limit=8`, warnings, "ChEMBL 搜索", 8000);
  const candidates = search?.molecules || [];
  const normalized = query.toLowerCase();
  const molecule = candidates.find(item => item.pref_name?.toLowerCase() === normalized || item.molecule_chembl_id?.toLowerCase() === normalized) || candidates[0];
  if (!molecule) return null;
  const id = molecule.molecule_chembl_id;
  const [moleculeDetails, mechanisms, indications, activities] = await Promise.all([
    safeJson(`${API.chembl}/molecule/${id}.json`, warnings, "ChEMBL 分子", 8000),
    safeJson(`${API.chembl}/mechanism.json?molecule_chembl_id=${id}&limit=100`, warnings, "ChEMBL 机制", 8000),
    safeJson(`${API.chembl}/drug_indication.json?molecule_chembl_id=${id}&limit=100`, warnings, "ChEMBL 适应症", 8000),
    safeJson(`${API.chembl}/activity.json?molecule_chembl_id=${id}&pchembl_value__isnull=false&limit=20&order_by=-pchembl_value`, warnings, "ChEMBL 活性", 8000)
  ]);
  const completeMolecule = moleculeDetails || molecule;
  const mechanismRows = mechanisms?.mechanisms || [];
  const targetIds = unique(mechanismRows.map(row => row.target_chembl_id)).slice(0, 8);
  const targetResults = await Promise.all(targetIds.map(async targetId => {
    const target = await safeJson(`${API.chembl}/target/${targetId}.json`, warnings, "ChEMBL 靶点", 5000);
    const component = target?.target_components?.[0];
    const protein = component?.accession ? await safeJson(`${API.uniprot}/${component.accession}.json`, warnings, "UniProt", 5000) : null;
    const shortName = protein?.proteinDescription?.recommendedName?.shortNames?.[0]?.value || null;
    const gene = protein?.genes?.[0]?.geneName?.value || null;
    const functionComment = protein?.comments?.find(comment => comment.commentType === "FUNCTION")?.texts?.map(item => item.value).filter(Boolean).join(" ") || null;
    return target ? {
      id: targetId,
      name: target.pref_name,
      accession: component?.accession,
      componentName: component?.component_description,
      shortName,
      gene,
      functionComment
    } : null;
  }));
  const targetDetails = new Map(targetResults.filter(Boolean).map(target => [target.id, target]));
  const properties = completeMolecule.molecule_properties || {};
  const structures = completeMolecule.molecule_structures || {};
  return {
    id,
    preferredName: completeMolecule.pref_name,
    moleculeType: completeMolecule.molecule_type,
    maxPhase: completeMolecule.max_phase,
    firstApproval: completeMolecule.first_approval,
    aliases: uniqueNames((completeMolecule.molecule_synonyms || []).map(row => row.molecule_synonym)),
    structure: {
      formula: properties.full_molformula || properties.molecular_formula,
      molecularWeight: properties.full_mwt || properties.mw_freebase,
      smiles: structures.canonical_smiles,
      imageUrl: structures.canonical_smiles ? `${API.chembl}/image/${id}.svg` : null
    },
    mechanisms: mechanismRows.map(row => {
      const target = targetDetails.get(row.target_chembl_id);
      return {
        action: row.action_type,
        mechanism: row.mechanism_of_action,
        targetId: row.target_chembl_id,
        target: target?.name || row.target_chembl_id,
        targetShortName: target?.shortName,
        targetGene: target?.gene,
        targetAccession: target?.accession,
        targetFunction: target?.functionComment,
        targetUrl: target?.accession ? `https://www.uniprot.org/uniprotkb/${target.accession}/entry` : null,
        bindingSite: row.binding_site_name,
        directInteraction: row.direct_interaction === 1
      };
    }),
    indications: (indications?.drug_indications || []).map(row => ({
      name: row.mesh_heading || row.efo_term,
      meshId: row.mesh_id,
      maxPhase: row.max_phase_for_ind
    })),
    activities: (activities?.activities || []).map(row => ({
      assay: row.assay_description,
      type: row.standard_type,
      relation: row.standard_relation,
      value: row.standard_value,
      units: row.standard_units,
      pchembl: row.pchembl_value,
      targetId: row.target_chembl_id,
      target: row.target_pref_name || row.target_chembl_id,
      organism: row.target_organism
    }))
  };
}

async function getPubChem(name, warnings) {
  const properties = await safeJson(`${API.pubchem}/compound/name/${encodeURIComponent(name)}/property/Title,MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,IsomericSMILES/JSON`, warnings, "PubChem");
  const row = properties?.PropertyTable?.Properties?.[0];
  if (!row) return null;
  return {
    cid: row.CID,
    title: row.Title,
    formula: row.MolecularFormula,
    molecularWeight: row.MolecularWeight,
    iupac: row.IUPACName,
    smiles: row.ConnectivitySMILES || row.CanonicalSMILES || row.SMILES,
    isomericSmiles: row.SMILES || row.IsomericSMILES,
    imageUrl: `${API.pubchem}/compound/cid/${row.CID}/PNG`
  };
}

async function getFda(query, warnings) {
  const escaped = query.replace(/["\\]/g, " ").trim();
  if (!escaped) return [];
  const fields = ["openfda.generic_name", "openfda.brand_name", "openfda.substance_name"];
  const responses = await Promise.all(fields.map(field => safeJson(`${API.fda}?search=${encodeURIComponent(`${field}:"${escaped}"`)}&limit=10`, warnings, "FDA", 10000)));
  const records = [];
  const seen = new Set();
  for (const record of responses.flatMap(data => data?.results || [])) {
    if (seen.has(record.application_number)) continue;
    seen.add(record.application_number);
    records.push(record);
  }
  return records.map(record => {
    const approvals = (record.submissions || [])
      .filter(item => item.submission_status === "AP")
      .map(item => ({
        date: item.submission_status_date,
        type: item.submission_type,
        class: item.submission_class_code_description,
        documents: item.application_docs || []
      }))
      .sort((left, right) => (left.date || "").localeCompare(right.date || ""));
    return {
      applicationNumber: record.application_number,
      sponsor: record.sponsor_name,
      brandNames: unique([...(record.openfda?.brand_name || []), ...(record.products || []).map(item => item.brand_name)]),
      genericNames: unique(record.openfda?.generic_name || []),
      firstApprovalDate: approvals[0]?.date || null,
      approvals
    };
  });
}

async function getTrials(names, warnings) {
  const term = unique(names).slice(0, 8).map(name => `"${name.replace(/"/g, "")}"`).join(" OR ");
  if (!term) return [];
  const fields = ["NCTId", "BriefTitle", "OverallStatus", "Phase", "Condition", "InterventionName", "BriefSummary", "StartDate", "CompletionDate", "HasResults", "PrimaryOutcomeMeasure", "PrimaryOutcomeDescription"].join(",");
  const url = `${API.trials}/studies?query.intr=${encodeURIComponent(term)}&format=json&pageSize=20&countTotal=true&fields=${encodeURIComponent(fields)}`;
  const data = await safeJson(url, warnings, "ClinicalTrials.gov", 18000);
  return (data?.studies || []).map(study => {
    const protocol = study.protocolSection || {};
    const results = study.resultsSection || {};
    const id = protocol.identificationModule?.nctId;
    const primary = results.outcomeMeasuresModule?.outcomeMeasures?.find(item => item.type === "PRIMARY");
    return {
      id,
      title: protocol.identificationModule?.briefTitle,
      status: protocol.statusModule?.overallStatus,
      phases: protocol.designModule?.phases || [],
      conditions: protocol.conditionsModule?.conditions || [],
      startDate: protocol.statusModule?.startDateStruct?.date,
      completionDate: protocol.statusModule?.completionDateStruct?.date,
      hasResults: study.hasResults === true || Boolean(study.resultsSection),
      summary: protocol.descriptionModule?.briefSummary,
      primaryOutcome: primary?.title || protocol.outcomesModule?.primaryOutcomes?.[0]?.measure,
      primaryResult: primary?.classes?.[0]?.categories?.[0]?.measurements?.[0]?.value,
      url: id ? `https://clinicaltrials.gov/study/${id}` : ""
    };
  }).filter(row => row.id);
}

async function searchDrug(query) {
  const trimmed = clean(query);
  if (!trimmed) throw new Error("请输入药物名称或编号");
  const warnings = [];
  const rxPromise = resolveRxNorm(trimmed, warnings);
  const chemblPromise = getChembl(trimmed, warnings);
  const rxnavPromise = rxPromise.then(rx => getRxNav(rx.rxcui, warnings));
  const [rx, chembl, rxnav, pubchem, fda, trials] = await Promise.all([
    rxPromise,
    chemblPromise,
    rxnavPromise,
    getPubChem(trimmed, warnings),
    getFda(trimmed, warnings),
    getTrials([trimmed], warnings)
  ]);
  const canonicalName = chembl?.preferredName || rx.canonicalName || trimmed;
  const aliases = uniqueNames([trimmed, canonicalName, ...rx.aliases, ...(chembl?.aliases || [])]);
  const brandNames = unique(fda.flatMap(record => record.brandNames));
  const genericNames = unique([canonicalName, ...fda.flatMap(record => record.genericNames)]);
  const success = Boolean(rx.rxcui || chembl || pubchem || fda.length || trials.length);
  return {
    type: "drug",
    success,
    query: trimmed,
    name: canonicalName,
    identifiers: { rxcui: rx.rxcui, chembl: chembl?.id, pubchemCid: pubchem?.cid },
    names: { preferred: canonicalName, generic: genericNames, brands: brandNames, aliases },
    format: { moleculeType: chembl?.moleculeType, description: chembl?.moleculeType || (pubchem ? "Small molecule" : null) },
    structure: pubchem || chembl?.structure || null,
    prescription: rxnav.prescription,
    classes: rxnav.classes,
    mechanisms: chembl?.mechanisms || [],
    indications: chembl?.indications || [],
    approvals: fda,
    trials,
    preclinical: chembl?.activities || [],
    development: { maxPhase: chembl?.maxPhase, firstApprovalYear: chembl?.firstApproval },
    sources: {
      chembl: chembl ? `https://www.ebi.ac.uk/chembl/explore/compound/${chembl.id}` : null,
      pubchem: pubchem ? `https://pubchem.ncbi.nlm.nih.gov/compound/${pubchem.cid}` : null,
      rxnorm: rx.rxcui ? `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${rx.rxcui}` : null,
      clinicalTrials: `https://clinicaltrials.gov/search?intr=${encodeURIComponent(canonicalName)}`,
      drugsFda: "https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm"
    },
    warnings
  };
}

module.exports = {
  API,
  getChembl,
  getFda,
  getPubChem,
  getRxNav,
  getTrials,
  resolveRxNorm,
  searchDrug,
  unique,
  uniqueNames
};
