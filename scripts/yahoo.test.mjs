// Run: node scripts/yahoo.test.mjs
import { previousClose } from './yahoo.mjs';

const bar = d => Math.floor(Date.UTC(2026, 8, d, 13, 30) / 1000); // 09:30 New York
const week = [bar(3), bar(4), bar(7), bar(8), bar(9)];            // 5th, 6th = weekend
const midSession = Math.floor(Date.UTC(2026, 8, 9, 15, 0) / 1000);

const cases = [
  ['today populated',        week,               [8.10, 8.40, 8.90, 9.50, 9.79], 9.50],
  ["today's close null",     week,               [8.10, 8.40, 8.90, 9.50, null], 9.50],
  ['gap earlier in week',    week,               [8.10, null, 8.90, 9.50, null], 9.50],
  ['no bar for today yet',   week.slice(0, 4),   [8.10, 8.40, 8.90, 9.50],       9.50],
  ['yesterday was a gap',    week,               [8.10, 8.40, 8.90, null, 9.79], 8.90],
];

let failed = 0;
for (const [name, stamps, closes, want] of cases) {
  const got = previousClose({
    meta: { regularMarketPrice: 9.79, regularMarketTime: midSession, gmtoffset: -14400, chartPreviousClose: 7.90 },
    timestamp: stamps,
    indicators: { quote: [{ close: closes }] },
  });
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(22)} want ${want}  got ${got}`);
}

// No usable series at all falls back rather than throwing.
const bare = previousClose({ meta: { chartPreviousClose: 7.9 } });
console.log(`${bare === 7.9 ? 'ok  ' : 'FAIL'}  ${'empty series'.padEnd(22)} want 7.9  got ${bare}`);
if (bare !== 7.9) failed++;

console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
