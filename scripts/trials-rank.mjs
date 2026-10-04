/* Turning a pile of ClinicalTrials.gov study records into "the ten drugs
   running the most late-stage trials right now".

   The ranking has to be something a reader can check, not an opinion. "Hottest
   drug" is a judgement; "the drug with the most active Phase 2/3 industry
   trials" is a count, and a count can be recomputed from the same public data
   by anyone who doubts it. The page says which definition it is using.

   Everything here is pure, so the maths can be tested without a network call —
   which matters, because the registry is not reachable from where this is
   written and the only live run happens on a GitHub runner. */

export const PHASE_RANK = { PHASE4: 4, PHASE3: 3, PHASE2: 2, PHASE1: 1, EARLY_PHASE1: 0 };
export const PHASE_LABEL = {
  PHASE4: 'Phase 4', PHASE3: 'Phase 3', PHASE2: 'Phase 2',
  PHASE1: 'Phase 1', EARLY_PHASE1: 'Early Phase 1', NA: 'N/A'
};

/* Intervention names in the registry are free text written by whoever
   registered the study, so the same molecule appears as "Pembrolizumab",
   "pembrolizumab 200 mg", "Pembrolizumab (MK-3475)" and "KEYTRUDA®". Counting
   those as four drugs would produce a top ten of spelling variants. */
export function normaliseDrug(raw) {
  if (!raw) return null;
  let name = String(raw).trim();

  // Strip a leading label the registrar added rather than a name: "Drug: X".
  name = name.replace(/^(drug|biological|device|combination product)\s*:\s*/i, '');
  // Anything parenthetical or bracketed is a code, brand or qualifier.
  name = name.replace(/[([{][^)\]}]*[)\]}]/g, ' ');
  // Dose, strength, route and schedule, which vary per arm of the same trial.
  name = name.replace(/\b\d+(\.\d+)?\s*(mg|mcg|µg|ug|g|ml|mL|iu|IU|units?|%)\b.*$/i, ' ');
  name = name.replace(/\b(oral|iv|intravenous|subcutaneous|sc|im|topical|inhaled|tablet|capsule|injection|infusion|solution|placebo-controlled)\b/gi, ' ');
  name = name.replace(/[®™]/g, ' ');
  name = name.replace(/\s+/g, ' ').trim();
  // Trailing punctuation left behind by the strips above.
  name = name.replace(/[\s,;:+\-/]+$/, '').trim();

  if (name.length < 3 || name.length > 60) return null;
  return name;
}

/* Things that are in the interventions list but are not the drug under study.
   A top ten led by "Placebo" would be true and useless. */
const NOT_A_DRUG = [
  /^placebo/i, /^saline/i, /^normal saline/i, /^vehicle/i, /^sham/i,
  /^standard (of )?(care|therapy|treatment)/i, /^soc$/i, /^best supportive care/i,
  /^control/i, /^no (intervention|treatment)/i, /^observation/i, /^usual care/i,
  /^questionnaire/i, /^survey/i, /^blood (draw|sample)/i, /^biopsy/i,
  /^chemotherapy$/i, /^radiotherapy$/i, /^radiation$/i, /^surgery$/i,
  /^dietary supplement/i, /^exercise/i, /^physical therapy/i,
  /^comparator/i, /^matching placebo/i, /^dummy/i
];

export function isStudyDrug(name) {
  if (!name) return false;
  return !NOT_A_DRUG.some(re => re.test(name));
}

// Case- and punctuation-insensitive key, so "Semaglutide" and "semaglutide."
// collapse while the nicest-looking spelling is what gets displayed.
export const drugKey = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

function phasesOf(study) {
  return study?.protocolSection?.designModule?.phases || [];
}

function topPhase(phases) {
  let best = null;
  for (const p of phases) {
    const rank = PHASE_RANK[p];
    if (rank == null) continue;
    if (!best || rank > best.rank) best = { phase: p, rank };
  }
  return best;
}

export function interventionsOf(study) {
  const list = study?.protocolSection?.armsInterventionsModule?.interventions || [];
  const out = [];
  for (const item of list) {
    // Only what is actually a medicine. Devices, procedures and behavioural
    // arms are real interventions but they are not drugs in trials.
    if (!['DRUG', 'BIOLOGICAL'].includes(item?.type)) continue;
    const name = normaliseDrug(item?.name);
    if (name && isStudyDrug(name)) out.push(name);
  }
  // One study counts once per drug however many arms mention it.
  return [...new Set(out)];
}

/* A study earns its place in the count only if it is a late-stage,
   industry-run, currently-live trial. Each of those is a deliberate narrowing:
   Phase 1 is where everything is, academic registrations are not what "in
   trials now" means to someone reading a markets dashboard, and a completed or
   terminated study is history rather than activity. */
export function countsTowardRanking(study) {
  const status = study?.protocolSection?.statusModule?.overallStatus;
  if (!['RECRUITING', 'NOT_YET_RECRUITING', 'ACTIVE_NOT_RECRUITING', 'ENROLLING_BY_INVITATION'].includes(status)) {
    return false;
  }
  const phase = topPhase(phasesOf(study));
  if (!phase || phase.rank < 2) return false;      // Phase 2 and up
  const sponsorClass = study?.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.class;
  return sponsorClass === 'INDUSTRY';
}

export function rankDrugs(studies, { limit = 10 } = {}) {
  const byKey = new Map();

  for (const study of studies) {
    if (!countsTowardRanking(study)) continue;
    const p = study.protocolSection || {};
    const phase = topPhase(phasesOf(study));
    const sponsor = p.sponsorCollaboratorsModule?.leadSponsor?.name || '';
    const conditions = p.conditionsModule?.conditions || [];
    const enrolment = p.designModule?.enrollmentInfo?.count || 0;
    const updated = p.statusModule?.lastUpdatePostDateStruct?.date || '';
    const nctId = p.identificationModule?.nctId;

    for (const name of interventionsOf(study)) {
      const key = drugKey(name);
      if (!key) continue;
      let entry = byKey.get(key);
      if (!entry) {
        entry = {
          key, name, trials: 0, phaseRank: -1, phase: null,
          sponsors: new Map(), conditions: new Map(),
          enrolment: 0, lastUpdate: '', nctIds: []
        };
        byKey.set(key, entry);
      }
      entry.trials++;
      entry.enrolment += enrolment;
      if (nctId) entry.nctIds.push(nctId);
      if (updated > entry.lastUpdate) entry.lastUpdate = updated;
      if (phase.rank > entry.phaseRank) { entry.phaseRank = phase.rank; entry.phase = phase.phase; }
      // Prefer the spelling that looks most like a name: the shortest one.
      if (name.length < entry.name.length) entry.name = name;
      if (sponsor) entry.sponsors.set(sponsor, (entry.sponsors.get(sponsor) || 0) + 1);
      for (const c of conditions) entry.conditions.set(c, (entry.conditions.get(c) || 0) + 1);
    }
  }

  const commonest = map => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';

  return [...byKey.values()]
    // Most trials wins; then the later phase; then the bigger enrolment. The
    // name is the final tie-break so the same input always gives the same
    // order — a list that reshuffles weekly for no reason reads as noise.
    .sort((a, b) =>
      b.trials - a.trials ||
      b.phaseRank - a.phaseRank ||
      b.enrolment - a.enrolment ||
      a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(e => ({
      name: e.name,
      trials: e.trials,
      phase: PHASE_LABEL[e.phase] || 'N/A',
      sponsor: commonest(e.sponsors),
      condition: commonest(e.conditions),
      enrolment: e.enrolment,
      lastUpdate: e.lastUpdate,
      // One representative registry record, so every row is checkable.
      link: e.nctIds.length ? `https://clinicaltrials.gov/study/${e.nctIds[0]}` : null
    }));
}
