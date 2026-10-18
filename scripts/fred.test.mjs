/* Every script that reads FRED must go through parseFredCsv.

   FRED writes "no observation" two ways: "." in some series, nothing at all
   in others. Number(".") is NaN and falls out of a numeric check on its own,
   but Number("") is 0 — finite, and so a market holiday sails through as a
   real reading. macro-series.mjs documents this and rejects both. Three other
   scripts had each hand-rolled their own parse and each one let blanks
   through: US holidays published as 0.00% yields, and a change measured
   against one reads as -100%.

   So this is less about the parser, which has its own tests, than about
   nobody writing a fourth copy of it. */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseFredCsv } from './macro-series.mjs';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

console.log('fred parsing');

const dir = new URL('.', import.meta.url).pathname;
const scripts = readdirSync(dir)
  .filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && f !== 'macro-series.mjs');

for (const file of scripts) {
  const src = readFileSync(dir + file, 'utf8');
  if (!src.includes('fredgraph.csv')) continue;

  test(`${file} parses FRED through the shared parser`, () => {
    assert.match(src, /import \{[^}]*parseFredCsv[^}]*\} from '\.\/macro-series\.mjs'/,
      'reads FRED but does not import parseFredCsv');
  });

  test(`${file} does not hand-roll a second CSV parse`, () => {
    assert.doesNotMatch(src, /Number\(value\)/,
      'Number(value) on a raw CSV field — a blank reads as 0, not as missing');
  });
}

// The behaviour all of them now depend on.
const rows = parseFredCsv('DATE,DGS2\n2026-09-23,4.40\n2026-09-24,\n2026-09-25,.\n2026-09-28,4.63\n');

test('a blank observation is dropped, not read as 0', () => {
  assert.deepEqual(rows.map(r => r.date), ['2026-09-23', '2026-09-28']);
  assert.equal(rows.some(r => r.value === 0), false, 'a blank leaked in as zero');
});

test('the latest row is a real reading, so a change against it is real', () => {
  const latest = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const changePct = ((latest.value - prev.value) / prev.value) * 100;
  assert.ok(changePct > 0 && changePct < 20, `implausible change: ${changePct}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
