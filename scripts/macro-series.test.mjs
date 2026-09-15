/* Regression tests for the macro transforms. Run with: node scripts/macro-series.test.mjs

   These cover the two ways a series like this goes quietly wrong: indexing by
   row position across a gap (which turns a 12-month comparison into a 13-month
   one), and thinning that drops or duplicates the boundary observation. */

import assert from 'node:assert/strict';
import { parseFredCsv, toYoY, toDiff, thin, pack } from './macro-series.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (err) { console.error(`  FAIL ${name}\n       ${err.message}`); process.exitCode = 1; }
}

console.log('parseFredCsv');

test('drops "." rows rather than reading them as zero', () => {
  const rows = parseFredCsv('DATE,DGS10\n2026-01-01,.\n2026-01-02,4.10\n');
  assert.deepEqual(rows, [{ date: '2026-01-02', value: 4.1 }]);
});

test('accepts the observation_date header spelling', () => {
  const rows = parseFredCsv('observation_date,UNRATE\n2026-01-01,4.0\n');
  assert.equal(rows.length, 1);
});

test('rejects a response that is not the CSV at all', () => {
  assert.throws(() => parseFredCsv('<html>rate limited</html>'), /unexpected fred response/);
});

test('sorts into date order', () => {
  const rows = parseFredCsv('DATE,X\n2026-03-01,3\n2026-01-01,1\n2026-02-01,2\n');
  assert.deepEqual(rows.map(r => r.value), [1, 2, 3]);
});

console.log('toYoY');

test('compares against the same month a year earlier', () => {
  const rows = [
    { date: '2025-06-01', value: 100 },
    { date: '2026-06-01', value: 103 }
  ];
  assert.deepEqual(toYoY(rows), [{ date: '2026-06-01', value: 3 }]);
});

test('a gap 12 months back yields nothing, not a 13-month comparison', () => {
  // June 2025 is missing; May 2025 sits in the row directly before June 2026.
  // Position-indexing would compare June 2026 against May 2025 and call it YoY.
  const rows = [
    { date: '2025-05-01', value: 50 },
    { date: '2026-06-01', value: 103 }
  ];
  assert.deepEqual(toYoY(rows), []);
});

test('handles a December-to-January year boundary', () => {
  const rows = [
    { date: '2025-12-01', value: 200 },
    { date: '2026-12-01', value: 210 }
  ];
  const [point] = toYoY(rows);
  assert.equal(point.date, '2026-12-01');
  assert.ok(Math.abs(point.value - 5) < 1e-9);
});

test('a zero base is skipped instead of producing Infinity', () => {
  const out = toYoY([{ date: '2025-01-01', value: 0 }, { date: '2026-01-01', value: 4 }]);
  assert.deepEqual(out, []);
});

console.log('toDiff');

test('subtracts the previous month', () => {
  const rows = [
    { date: '2026-01-01', value: 159000 },
    { date: '2026-02-01', value: 159150 }
  ];
  assert.deepEqual(toDiff(rows), [{ date: '2026-02-01', value: 150 }]);
});

test('a missing previous month yields nothing', () => {
  const rows = [
    { date: '2026-01-01', value: 159000 },
    { date: '2026-03-01', value: 159300 }
  ];
  assert.deepEqual(toDiff(rows), []);
});

console.log('thin');

test('keeps every observation at or after the cutoff', () => {
  const rows = [
    { date: '2026-01-05', value: 1 },
    { date: '2026-01-06', value: 2 },
    { date: '2026-01-07', value: 3 }
  ];
  assert.equal(thin(rows, '2026-01-01').length, 3);
});

test('keeps one observation per month before the cutoff — the last', () => {
  const rows = [
    { date: '1990-01-02', value: 1 },
    { date: '1990-01-30', value: 2 },
    { date: '1990-02-05', value: 3 },
    { date: '1990-02-27', value: 4 }
  ];
  assert.deepEqual(thin(rows, '2020-01-01'), [
    { date: '1990-01-30', value: 2 },
    { date: '1990-02-27', value: 4 }
  ]);
});

test('does not drop the last old month when the cutoff falls mid-month', () => {
  // The month straddling the cutoff is the one a naive carry loses: its early
  // rows are thinned, its later rows are kept, and the carried row has to be
  // flushed before them or the join skips a point.
  const rows = [
    { date: '2021-03-01', value: 1 },
    { date: '2021-03-02', value: 2 },
    { date: '2021-03-03', value: 3 },
    { date: '2021-03-04', value: 4 }
  ];
  assert.deepEqual(thin(rows, '2021-03-03').map(r => r.value), [2, 3, 4]);
});

test('never emits a duplicate or an out-of-order date', () => {
  const rows = [];
  for (let y = 2000; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      for (const day of [1, 15, 28]) {
        rows.push({ date: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`, value: y + m });
      }
    }
  }
  const out = thin(rows, '2021-06-15');
  const dates = out.map(r => r.date);
  assert.deepEqual(dates, [...dates].sort(), 'dates came out unsorted');
  assert.equal(new Set(dates).size, dates.length, 'a date was emitted twice');
  assert.ok(out.length < rows.length, 'thinning removed nothing');
});

test('an empty series thins to an empty series', () => {
  assert.deepEqual(thin([], '2020-01-01'), []);
});

console.log('pack');

test('packs into parallel arrays and rounds to four places', () => {
  const out = pack([{ date: '2026-01-01', value: 3.3965478924 }]);
  assert.deepEqual(out, { d: ['2026-01-01'], v: [3.3965] });
});

console.log(`\n${passed} passed`);
