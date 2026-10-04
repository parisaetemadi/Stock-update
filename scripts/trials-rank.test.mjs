/* Tests for the trials ranking. Run: node scripts/trials-rank.test.mjs

   The registry is not reachable from where this is written, so the only live
   run happens on a GitHub runner. That makes these tests the whole of the
   offline safety net: every judgement the ranking makes is pinned here against
   a record shaped the way the API really returns one. */

import assert from 'node:assert/strict';
import { normaliseDrug, isStudyDrug, interventionsOf, countsTowardRanking, rankDrugs } from './trials-rank.mjs';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

// A study record in the shape the v2 API returns.
const study = ({ nct = 'NCT00000001', status = 'RECRUITING', phases = ['PHASE3'],
  sponsor = 'Acme Pharma', sponsorClass = 'INDUSTRY', interventions = [],
  conditions = ['Obesity'], enrolment = 100, updated = '2026-10-01' } = {}) => ({
  protocolSection: {
    identificationModule: { nctId: nct },
    statusModule: { overallStatus: status, lastUpdatePostDateStruct: { date: updated } },
    designModule: { phases, enrollmentInfo: { count: enrolment } },
    sponsorCollaboratorsModule: { leadSponsor: { name: sponsor, class: sponsorClass } },
    conditionsModule: { conditions },
    armsInterventionsModule: { interventions }
  }
});
const drug = name => ({ type: 'DRUG', name });

console.log('normaliseDrug');

test('collapses the spelling variants of one molecule', () => {
  const forms = ['Pembrolizumab', 'pembrolizumab 200 mg', 'Pembrolizumab (MK-3475)',
                 'Drug: Pembrolizumab', 'Pembrolizumab®', 'Pembrolizumab IV'];
  const out = new Set(forms.map(f => normaliseDrug(f).toLowerCase()));
  assert.equal(out.size, 1, `got ${[...out].join(' | ')}`);
});

test('keeps a hyphenated development code intact', () => {
  assert.equal(normaliseDrug('VERVE-102'), 'VERVE-102');
});

test('strips a dose without eating the name', () => {
  assert.equal(normaliseDrug('Semaglutide 2.4 mg weekly'), 'Semaglutide');
});

test('rejects something too short to be a name', () => {
  assert.equal(normaliseDrug('A'), null);
  assert.equal(normaliseDrug('  '), null);
});

console.log('isStudyDrug');

test('throws out comparators and non-drugs', () => {
  for (const junk of ['Placebo', 'placebo', 'Matching Placebo', 'Normal Saline',
                      'Standard of Care', 'Best Supportive Care', 'Sham', 'Observation',
                      'Questionnaire', 'Usual care']) {
    assert.equal(isStudyDrug(junk), false, `${junk} counted as a drug`);
  }
});

test('keeps real drugs', () => {
  for (const name of ['Semaglutide', 'Pembrolizumab', 'VERVE-102', 'Lenacapavir']) {
    assert.equal(isStudyDrug(name), true, `${name} was thrown out`);
  }
});

console.log('interventionsOf');

test('counts a drug once however many arms mention it', () => {
  const s = study({ interventions: [drug('Semaglutide 1 mg'), drug('Semaglutide 2.4 mg'), drug('Placebo')] });
  assert.deepEqual(interventionsOf(s), ['Semaglutide']);
});

test('ignores devices and procedures', () => {
  const s = study({ interventions: [
    { type: 'DEVICE', name: 'Infusion pump' },
    { type: 'PROCEDURE', name: 'Surgery' },
    { type: 'BIOLOGICAL', name: 'Intismeran autogene' }
  ] });
  assert.deepEqual(interventionsOf(s), ['Intismeran autogene']);
});

console.log('countsTowardRanking');

test('a live Phase 3 industry trial counts', () => {
  assert.equal(countsTowardRanking(study()), true);
});

test('a finished trial is history, not activity', () => {
  for (const status of ['COMPLETED', 'TERMINATED', 'WITHDRAWN', 'SUSPENDED', 'UNKNOWN']) {
    assert.equal(countsTowardRanking(study({ status })), false, status);
  }
});

test('Phase 1 is excluded — "in trials now" means late stage here', () => {
  assert.equal(countsTowardRanking(study({ phases: ['PHASE1'] })), false);
  assert.equal(countsTowardRanking(study({ phases: ['EARLY_PHASE1'] })), false);
  assert.equal(countsTowardRanking(study({ phases: ['PHASE1', 'PHASE2'] })), true, 'Ph1/2 should count on its top phase');
});

test('an academic sponsor is excluded', () => {
  assert.equal(countsTowardRanking(study({ sponsorClass: 'OTHER' })), false);
  assert.equal(countsTowardRanking(study({ sponsorClass: 'NIH' })), false);
});

test('a study with no phase stated does not sneak in', () => {
  assert.equal(countsTowardRanking(study({ phases: [] })), false);
  assert.equal(countsTowardRanking(study({ phases: ['NA'] })), false);
});

console.log('rankDrugs');

const many = (name, n, extra = {}) =>
  Array.from({ length: n }, (_, i) => study({ nct: `NCT${name}${i}`, interventions: [drug(name)], ...extra }));

test('ranks by how many trials a drug is running', () => {
  const out = rankDrugs([...many('Alpha', 5), ...many('Beta', 3), ...many('Gamma', 1)]);
  assert.deepEqual(out.map(d => d.name), ['Alpha', 'Beta', 'Gamma']);
  assert.equal(out[0].trials, 5);
});

test('returns at most ten', () => {
  const studies = [];
  for (let i = 0; i < 25; i++) studies.push(...many(`Drug${String(i).padStart(2, '0')}`, 25 - i));
  const out = rankDrugs(studies);
  assert.equal(out.length, 10);
  assert.equal(out[0].name, 'Drug00');
});

test('a tie on trial count is broken by phase, then enrolment, then name', () => {
  const out = rankDrugs([
    ...many('Later', 2, { phases: ['PHASE3'], enrolment: 10 }),
    ...many('Earlier', 2, { phases: ['PHASE2'], enrolment: 9000 }),
    ...many('Bigger', 2, { phases: ['PHASE3'], enrolment: 500 })
  ]);
  assert.deepEqual(out.map(d => d.name), ['Bigger', 'Later', 'Earlier']);
});

test('the same input always gives the same order', () => {
  const studies = [...many('Aaa', 2), ...many('Bbb', 2), ...many('Ccc', 2)];
  const first = rankDrugs(studies).map(d => d.name);
  const again = rankDrugs([...studies].reverse()).map(d => d.name);
  assert.deepEqual(first, again, 'order depended on input order');
});

test('each row carries what the reader needs to check it', () => {
  const [row] = rankDrugs(many('Semaglutide', 3, { sponsor: 'Novo Nordisk A/S', conditions: ['Obesity'] }));
  assert.equal(row.sponsor, 'Novo Nordisk A/S');
  assert.equal(row.condition, 'Obesity');
  assert.equal(row.phase, 'Phase 3');
  assert.match(row.link, /^https:\/\/clinicaltrials\.gov\/study\/NCT/);
});

test('the commonest sponsor and condition win, not the first seen', () => {
  const [row] = rankDrugs([
    study({ nct: 'NCT1', interventions: [drug('Zeta')], sponsor: 'One Off Inc', conditions: ['Rare Thing'] }),
    study({ nct: 'NCT2', interventions: [drug('Zeta')], sponsor: 'Big Pharma', conditions: ['Common Thing'] }),
    study({ nct: 'NCT3', interventions: [drug('Zeta')], sponsor: 'Big Pharma', conditions: ['Common Thing'] })
  ]);
  assert.equal(row.sponsor, 'Big Pharma');
  assert.equal(row.condition, 'Common Thing');
});

test('placebo never reaches the list however many trials use it', () => {
  const studies = [];
  for (let i = 0; i < 50; i++) {
    studies.push(study({ nct: `NCT${i}`, interventions: [drug('Placebo'), drug(`Real${i % 3}`)] }));
  }
  const out = rankDrugs(studies);
  assert.equal(out.some(d => /placebo/i.test(d.name)), false, JSON.stringify(out.map(d => d.name)));
  assert.equal(out.length, 3);
});

test('an empty registry response yields an empty list, not a crash', () => {
  assert.deepEqual(rankDrugs([]), []);
});

console.log(`\n${passed} passed`);
