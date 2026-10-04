/* Turning a pile of ClinicalTrials.gov study records into "the ten drugs
   running the most late-stage trials right now".

   The ranking has to be something a reader can check, not an opinion. "Hottest
   drug" is a judgement; "the drug with the most active Phase 2/3 industry
   trials" is a count, and a count can be recomputed from the same public data
   by anyone who doubts it. The page says which definition it is using.

   Everything here is pure, so the maths can be tested without a network call —
   which matters, because the registry is not reachable from where this is
   written and the only live run happens on a GitHub runner. */

/* Phase 4 is deliberately absent. A Phase 4 study is post-marketing
   surveillance of a drug that is already approved and on the shelf — the
   opposite of "in trials now" in the sense that matters for a pipeline, and
   another reason the first run filled up with old generics. */
export const PHASE_RANK = { PHASE3: 3, PHASE2: 2, PHASE1: 1, EARLY_PHASE1: 0 };
export const PHASE_LABEL = {
  PHASE3: 'Phase 3', PHASE2: 'Phase 2',
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

/* The drug a study is actually testing, as opposed to every drug it mentions.

   Counting every mentioned drug produced a top ten of carboplatin, cisplatin,
   paclitaxel and gemcitabine — decades-old generics that appear in hundreds of
   oncology trials because they are the chemotherapy backbone every new drug is
   tested on top of. True, and useless: they are the comparator, not the
   subject. It is the placebo problem one level up, and the fix is the same
   idea applied properly.

   The registry does not flag a lead intervention, but the arm structure gives
   it away. A trial of a new drug reads "new drug + carbo/taxol" against
   "carbo/taxol", so the backbone appears on BOTH sides while the new drug
   appears only on the experimental one. So a drug counts for a study only when
   it is in an experimental arm and in no comparator arm of that same study. */
const COMPARATOR_ARMS = ['ACTIVE_COMPARATOR', 'PLACEBO_COMPARATOR', 'SHAM_COMPARATOR', 'NO_INTERVENTION'];

export function interventionsOf(study) {
  const module = study?.protocolSection?.armsInterventionsModule || {};
  const medicines = new Map();      // raw registry name -> display name

  for (const item of module.interventions || []) {
    // Only what is actually a medicine. Devices, procedures and behavioural
    // arms are real interventions but they are not drugs in trials.
    if (!['DRUG', 'BIOLOGICAL'].includes(item?.type)) continue;
    const name = normaliseDrug(item?.name);
    if (name && isStudyDrug(name)) medicines.set(item.name, name);
  }
  if (medicines.size === 0) return [];

  const armGroups = module.armGroups || [];
  // A single-arm study has no comparator to distinguish against; everything in
  // it is under test by definition.
  if (armGroups.length === 0) return [...new Set(medicines.values())];

  const experimental = new Set();
  const comparator = new Set();
  for (const arm of armGroups) {
    const bucket = COMPARATOR_ARMS.includes(arm?.type) ? comparator
      : arm?.type === 'EXPERIMENTAL' ? experimental
      : null;                                  // OTHER: tells us nothing
    if (!bucket) continue;
    for (const raw of arm?.interventionNames || []) {
      // Arms refer to interventions as "Drug: X", matching the label the
      // registrar used rather than the intervention's own name field.
      const display = medicines.get(raw) || medicines.get(raw.replace(/^[^:]+:\s*/, ''));
      if (display) bucket.add(display);
      else {
        const guess = normaliseDrug(raw);
        if (guess && [...medicines.values()].includes(guess)) bucket.add(guess);
      }
    }
  }

  // Arms that named nothing recognisable leave us no better off than having no
  // arms at all, so fall back rather than returning an empty study.
  if (experimental.size === 0 && comparator.size === 0) return [...new Set(medicines.values())];

  return [...experimental].filter(name => !comparator.has(name));
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
      // Prefer a capitalised spelling, then the shorter one — registrars write
      // the same molecule as "Semaglutide" and "semaglutide" and a lowercase
      // row in a list of proper names reads as a mistake.
      const better = (a, b) => {
        const capA = /^[A-Z]/.test(a), capB = /^[A-Z]/.test(b);
        if (capA !== capB) return capA ? a : b;
        return a.length <= b.length ? a : b;
      };
      entry.name = better(entry.name, name);
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
