/* Publishes data/trials.json: the ten investigational drugs running the most
   live, late-stage, industry-sponsored trials, straight from ClinicalTrials.gov.

   This replaces a list that was typed into the dashboard by hand and went a
   month without being touched. The point of moving it here is not just that it
   refreshes itself — it is that "top ten" now means something checkable. The
   feed carries the count, the phase, the sponsor and a link to a registry
   record for every row, so any line on the page can be verified against the
   source rather than taken on trust.

   The registry's API v2 needs no key. Field paths are verbose but stable. */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { rankDrugs } from './trials-rank.mjs';

const BASE = 'https://clinicaltrials.gov/api/v2/studies';

/* Counting live trials alone does not find new drugs — it finds busy ones.
   Two runs proved it: the first returned carboplatin, cisplatin, paclitaxel
   and gemcitabine, and after excluding comparator arms the list still held
   carboplatin, cyclophosphamide, dexamethasone and fludarabine. All real
   counts; all drugs from the 1990s that appear everywhere because they are
   part of everyone's regimen.

   What separates them from a pipeline is age, and age is a fact the registry
   knows. A molecule that first entered a trial before this cutoff has been in
   development for the better part of a decade and is not news; one whose first
   trial is recent is. So each candidate is asked a single question — does any
   study of you start before this date? — and an established drug answers yes. */
const NOVEL_SINCE = '2019-01-01';
/* Deep on purpose. A novel drug runs fewer trials than a thirty-year-old
   regimen staple, so it ranks well below one — screening only the top sixty
   found five new drugs and ran out, because nearly everything above them was
   established. The pool has to reach past the generics for the pipeline to be
   underneath. */
const CANDIDATE_POOL = 400;
const SCREEN_PAUSE_MS = 120;      // one cheap call each; no need to hammer
const PAGE_SIZE = 1000;          // the API's maximum
const MAX_PAGES = 12;            // ~12k studies; well past what the filter returns
const RETRIES = 3;

// Only the fields the ranking reads. Asking for everything returns megabytes of
// eligibility prose per study and the whole sweep would not finish.
const FIELDS = [
  'protocolSection.identificationModule.nctId',
  'protocolSection.statusModule.overallStatus',
  'protocolSection.statusModule.lastUpdatePostDateStruct',
  'protocolSection.designModule.phases',
  'protocolSection.designModule.enrollmentInfo',
  'protocolSection.sponsorCollaboratorsModule.leadSponsor',
  'protocolSection.conditionsModule.conditions',
  'protocolSection.armsInterventionsModule.interventions',
  // The arm structure is what separates the drug under test from the backbone
  // it is given on top of; without it the ranking is a list of generics.
  'protocolSection.armsInterventionsModule.armGroups'
].join(',');

// Narrowed server-side as far as the API allows, so the sweep stays small. The
// rest of the filtering is in trials-rank.mjs, where it is tested.
const QUERY = {
  'filter.overallStatus': 'RECRUITING|NOT_YET_RECRUITING|ACTIVE_NOT_RECRUITING|ENROLLING_BY_INVITATION',
  'filter.advanced': 'AREA[StudyType]INTERVENTIONAL AND AREA[LeadSponsorClass]INDUSTRY AND (AREA[Phase]PHASE2 OR AREA[Phase]PHASE3)',
  fields: FIELDS,
  pageSize: String(PAGE_SIZE),
  countTotal: 'true',
  format: 'json'
};

async function get(params) {
  const url = `${BASE}?${new URLSearchParams(params)}`;
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'parisa-dashboard-cron' }
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  throw lastErr;
}

const fetchPage = pageToken =>
  get(pageToken ? { ...QUERY, pageToken } : QUERY);

/* One cheap question per candidate: is there any study of this drug that
   started before the cutoff? pageSize=1 with countTotal means the registry
   answers with a number rather than the studies themselves. */
async function isEstablished(name) {
  const json = await get({
    'query.intr': name,
    'filter.advanced': `AREA[StartDate]RANGE[MIN,${NOVEL_SINCE}]`,
    countTotal: 'true',
    pageSize: '1',
    fields: 'protocolSection.identificationModule.nctId',
    format: 'json'
  });
  return (json.totalCount || 0) > 0;
}

async function keepNovel(candidates, limit) {
  const kept = [];
  const dropped = [];
  let screened = 0;
  for (const drug of candidates) {
    if (kept.length >= limit) break;
    screened++;
    try {
      if (await isEstablished(drug.name)) { dropped.push(drug.name); continue; }
      kept.push(drug);
      console.error(`[trials] new: ${drug.name} (${drug.trials} trials)`);
    } catch (err) {
      // A lookup that fails tells us nothing either way. Keeping the drug
      // would risk putting a 1990s generic back at the top of the list, so an
      // unanswered question counts as "not proven new".
      console.error(`[trials] ${drug.name}: novelty check failed (${err.message}) — skipping`);
      dropped.push(`${drug.name}?`);
    }
    await new Promise(r => setTimeout(r, SCREEN_PAUSE_MS));
  }
  console.error(`[trials] screened ${screened} candidates, kept ${kept.length}, dropped ${dropped.length} as established or unverified`);
  return kept;
}

async function sweep() {
  const studies = [];
  let token = null;
  let total = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchPage(token);
    if (total == null && typeof json.totalCount === 'number') total = json.totalCount;
    const batch = json.studies || [];
    studies.push(...batch);
    console.error(`[trials] page ${page + 1}: ${batch.length} studies (${studies.length} so far${total ? ` of ${total}` : ''})`);
    token = json.nextPageToken;
    if (!token || batch.length === 0) break;
  }
  return { studies, total };
}

// A week with a failed fetch should keep last week's list rather than emptying
// the panel — a stale top ten is far better than none, and the feed says when
// it was built.
async function previous() {
  try {
    return JSON.parse(await readFile('data/trials.json', 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const generatedAt = new Date().toISOString();
  let swept;
  try {
    swept = await sweep();
  } catch (err) {
    console.error(`[trials] sweep failed: ${err.message}`);
    const old = await previous();
    if (!old) throw new Error('no previous trials.json to fall back on');
    console.error(`[trials] keeping the list from ${old.generatedAt}`);
    return;
  }

  const candidates = rankDrugs(swept.studies, { limit: CANDIDATE_POOL });
  console.error(`[trials] ${candidates.length} candidates ranked; screening for novelty since ${NOVEL_SINCE}`);
  const drugs = await keepNovel(candidates, 10);
  if (drugs.length === 0) {
    const old = await previous();
    if (old) {
      console.error('[trials] ranking came back empty — keeping the previous list');
      return;
    }
    throw new Error('ranking came back empty and there is nothing to fall back on');
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/trials.json', JSON.stringify({
    generatedAt,
    // Stated in the feed so the page can print the rule it is showing rather
    // than asserting a "top ten" the reader has no way to interpret.
    basis: `Drugs whose first registered trial began in ${NOVEL_SINCE.slice(0, 4)} or later, ranked by how many live industry-sponsored Phase 2\u20133 trials each is the subject of.`,
    novelSince: NOVEL_SINCE,
    source: 'ClinicalTrials.gov API v2',
    studiesConsidered: swept.studies.length,
    drugs
  }, null, 2) + '\n');

  console.log(`Wrote data/trials.json — ${drugs.length} drugs from ${swept.studies.length} studies.`);
  drugs.forEach((d, i) => console.log(`  ${String(i + 1).padStart(2)}. ${d.name} — ${d.trials} trials, ${d.phase}, ${d.sponsor || 'sponsor n/a'} (${d.condition || 'condition n/a'})`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
