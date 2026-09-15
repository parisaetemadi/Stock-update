/* The macro series published to data/macro.json, and the pure helpers that
   shape them. Kept apart from the fetcher so the maths is testable without a
   network call.

   Every series here is a FRED series id. FRED's graph CSV endpoint needs no API
   key — it is what backs the public chart on fred.stlouisfed.org — so nothing
   in this pipeline depends on a secret. */

// A FRED series can be published either as it comes ("level") or as a
// year-over-year percentage change ("yoy"), which is how a price index becomes
// an inflation rate, or as the month-on-month difference ("diff"), which is how
// a payroll count becomes a jobs-added number.
export const SERIES = [
  // --- US Treasury yields: the short, the long, and the very long ---
  { id: 'dgs2', fred: 'DGS2', group: 'US Treasury yields', label: '2-Year Treasury', transform: 'level', unit: '%', decimals: 2, freq: 'daily',
    note: 'What the US government pays to borrow for two years. Moves on what the market expects the Fed to do next.' },
  { id: 'dgs10', fred: 'DGS10', group: 'US Treasury yields', label: '10-Year Treasury', transform: 'level', unit: '%', decimals: 2, freq: 'daily',
    note: 'The long rate most other borrowing costs \u2014 mortgages included \u2014 are priced off.' },
  { id: 'dgs30', fred: 'DGS30', group: 'US Treasury yields', label: '30-Year Treasury', transform: 'level', unit: '%', decimals: 2, freq: 'daily',
    note: 'The longest point on the curve. Reflects what the market thinks inflation and growth look like decades out.' },

  // --- United States ---
  { id: 'cpi', fred: 'CPIAUCSL', group: 'United States', label: 'US CPI Inflation', transform: 'yoy', unit: '%', decimals: 1, freq: 'monthly',
    note: 'Consumer price index for all urban consumers, all items, against the same month a year earlier.' },
  { id: 'unrate', fred: 'UNRATE', group: 'United States', label: 'US Unemployment Rate', transform: 'level', unit: '%', decimals: 1, freq: 'monthly',
    note: 'Share of the US labour force without a job and looking for one. Seasonally adjusted.' },

  // --- Canada ---
  // StatCan first: it is the authority for its own CPI and it is current.
  // FRED's Canadian series are OECD-derived mirrors that have been renamed and,
  // in CANCPIALLMINMEI's case, frozen — it still answers, with history that
  // stops in March 2025. That is exactly why a candidate has to prove it is
  // recent before it is used, not merely that it replies.
  { id: 'cacpi', candidates: ['statcan:41690973', 'CANCPIALLMINMEI', 'CPALTT01CAM659N', 'CPALTT01CAM661N'],
    group: 'Canada', label: 'Canada CPI Inflation', transform: 'yoy', unit: '%', decimals: 1, freq: 'monthly',
    note: 'Canadian all-items consumer price index against the same month a year earlier.' },
  { id: 'caunrate', candidates: ['LRUNTTTTCAM156S', 'LRUN64TTCAM156S', 'CANURHARMMDSMEI'],
    group: 'Canada', label: 'Canada Unemployment Rate', transform: 'level', unit: '%', decimals: 1, freq: 'monthly',
    note: 'Share of the Canadian labour force without a job and looking for one. Seasonally adjusted.' }
];

// A spec names either one source or a list tried in order. A plain string is a
// FRED series id; the "statcan:" prefix names a StatCan vector instead.
export const candidatesFor = spec => spec.candidates || [spec.fred];

/* ---------- freshness ----------
   A source that answers is not the same as a source that is current. FRED still
   serves CANCPIALLMINMEI, and it still looks like a normal series — it simply
   stopped being updated in March 2025. Charting it would have shown Canadian
   inflation as of eighteen months ago under a heading that says it is the
   latest. So every candidate must prove its most recent observation is recent
   enough for its own frequency before it is accepted.

   The allowances are generous, because these are release schedules rather than
   deadlines: monthly statistics can run six weeks behind, quarterly GDP a
   quarter, and a daily series has to survive a long weekend. */
export const MAX_STALE_DAYS = { daily: 12, weekly: 21, monthly: 120, quarterly: 250 };

export function stalenessDays(latestISO, now = Date.now()) {
  return (now - new Date(latestISO + 'T00:00:00Z').getTime()) / 86400000;
}

export function isFresh(latestISO, freq, now = Date.now()) {
  const limit = MAX_STALE_DAYS[freq] ?? 120;
  return stalenessDays(latestISO, now) <= limit;
}

/* ---------- parsing ----------
   FRED writes "." for a missing observation. Dropping those rows is correct —
   a gap is not a zero — but it means no transform may ever index by position.
   Each one below matches on the observation date instead. */
export function parseFredCsv(text) {
  const lines = String(text).trim().split('\n').filter(Boolean);
  // FRED's header column name has varied ("DATE" vs "observation_date").
  if (lines.length < 2 || !lines[0].toLowerCase().includes('date')) {
    throw new Error(`unexpected fred response: ${String(text).slice(0, 100)}`);
  }
  const rows = [];
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) continue;
    // FRED marks a missing observation two different ways, and only one of them
    // is obvious. Some series write "." — Number(".") is NaN, so that falls out
    // on its own. Others write nothing at all ("2024-01-01,"), and Number("") is
    // 0, which is finite, so a market holiday sails through the numeric check
    // and charts as a genuine 0% yield. Every US holiday in DGS1MO was drawn as
    // a spike to zero because of this. A blank is missing data, not a reading.
    const text = (raw ?? '').trim();
    if (text === '' || text === '.') continue;
    const value = Number(text);
    if (!Number.isFinite(value)) continue;
    rows.push({ date, value });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function shiftMonths(dateISO, months) {
  const [y, m] = dateISO.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Year-over-year percentage change, anchored on the observation dates rather
// than on row positions, so a gap in the series can never quietly turn a
// 12-month comparison into a 13-month one.
export function toYoY(rows) {
  const byMonth = new Map(rows.map(r => [r.date.slice(0, 7), r.value]));
  const out = [];
  for (const row of rows) {
    const base = byMonth.get(shiftMonths(row.date, -12));
    if (base == null || base === 0) continue;
    out.push({ date: row.date, value: ((row.value - base) / base) * 100 });
  }
  return out;
}

// Change from the previous month, for a count that is more legible as a delta
// than as a level. Same rule: the previous month must actually be there.
export function toDiff(rows) {
  const byMonth = new Map(rows.map(r => [r.date.slice(0, 7), r.value]));
  const out = [];
  for (const row of rows) {
    const base = byMonth.get(shiftMonths(row.date, -1));
    if (base == null) continue;
    out.push({ date: row.date, value: row.value - base });
  }
  return out;
}

export function applyTransform(rows, transform) {
  if (transform === 'yoy') return toYoY(rows);
  if (transform === 'diff') return toDiff(rows);
  return rows;
}

/* ---------- thinning ----------
   A daily series back to 1962 is some sixteen thousand points. Every one of
   them is real, but a chart a few hundred pixels wide cannot draw them, and
   shipping them all would make the feed heavier than everything else in it put
   together. So recent history is kept exactly as published, and older history
   is thinned to one observation per month — the last of each month, which is
   the convention for a long-run chart. The boundary is recorded in the feed so
   the page can say so rather than implying the whole series is daily. */
export const FULL_DETAIL_YEARS = 5;

export function thin(rows, cutoffISO) {
  const out = [];
  let carried = null;            // last row of the month being walked
  for (const row of rows) {
    if (row.date >= cutoffISO) {
      if (carried) { out.push(carried); carried = null; }
      out.push(row);
      continue;
    }
    if (carried && carried.date.slice(0, 7) !== row.date.slice(0, 7)) out.push(carried);
    carried = row;
  }
  if (carried) out.push(carried);
  return out;
}

export function cutoffISO(now = new Date()) {
  return new Date(Date.UTC(
    now.getUTCFullYear() - FULL_DETAIL_YEARS, now.getUTCMonth(), now.getUTCDate()
  )).toISOString().slice(0, 10);
}

// Two parallel arrays rather than an array of objects: the same numbers in
// roughly a third of the bytes, which matters at this length.
export function pack(rows) {
  return { d: rows.map(r => r.date), v: rows.map(r => Number(r.value.toFixed(4))) };
}
