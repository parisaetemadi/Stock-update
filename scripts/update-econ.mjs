import { writeFile, mkdir } from 'node:fs/promises';

// CPI-U, U.S. city average, all items, not seasonally adjusted.
const CPI_SERIES_ID = 'CUUR0000SA0';

// A monthly reading older than this isn't a current rate — publishing it beside
// an up-to-date US number would misrepresent it, so it's rejected instead.
const MAX_STALENESS_DAYS = 150;

function monthsAgoISO(dateISO, months) {
  const [y, m] = dateISO.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function daysOld(dateISO) {
  return (Date.now() - new Date(dateISO + 'T00:00:00Z').getTime()) / 86400000;
}

// Year-over-year from monthly observations, anchored on the actual observation
// dates. Indexing 13 rows back only gives a true YoY when the series has no
// gaps — FRED writes "." for missing months, and dropping those silently
// shifts the comparison to 13 months apart. Matching the date explicitly can
// only ever return a genuine 12-month comparison, or nothing.
export function yoyFromMonthly(points) {
  const rows = points
    .filter(p => p.date && Number.isFinite(p.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length === 0) return null;

  const latest = rows[rows.length - 1];
  const wantDate = monthsAgoISO(latest.date, 12);
  const yearAgo = rows.find(r => r.date.slice(0, 7) === wantDate.slice(0, 7));
  if (!yearAgo || !yearAgo.value) return null;

  return {
    yoy: ((latest.value - yearAgo.value) / yearAgo.value) * 100,
    date: latest.date,
    comparedTo: yearAgo.date,
    period: new Date(latest.date + 'T00:00:00Z').toLocaleDateString('en-US', {
      month: 'long', year: 'numeric', timeZone: 'UTC'
    })
  };
}

function assertFresh(label, result) {
  if (!result) return null;
  const age = daysOld(result.date);
  if (age > MAX_STALENESS_DAYS) {
    console.error(`[econ] ${label}: latest observation ${result.date} is ${Math.round(age)} days old — rejecting as stale`);
    return null;
  }
  console.error(`[econ] ${label}: ${result.yoy.toFixed(2)}% YoY (${result.date} vs ${result.comparedTo}, ${Math.round(age)}d old)`);
  return result;
}

async function fetchUsCpi() {
  const now = new Date();
  const res = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seriesid: [CPI_SERIES_ID],
      startyear: String(now.getFullYear() - 2),
      endyear: String(now.getFullYear())
    })
  });
  if (!res.ok) throw new Error(`bls http ${res.status}`);
  const json = await res.json();
  const series = json?.Results?.series?.[0]?.data;
  if (!series || series.length === 0) throw new Error('bls: no series data');

  // period is "M01".."M12"; M13 is the annual average, which isn't a month.
  const points = series
    .filter(d => /^M(0[1-9]|1[0-2])$/.test(d.period))
    .map(d => ({ date: `${d.year}-${d.period.slice(1)}-01`, value: Number(d.value) }));

  const result = yoyFromMonthly(points);
  if (!result) throw new Error('bls: no 12-month-earlier observation to compare against');
  return result;
}

// FRED's graph CSV endpoint doesn't require an API key (it backs the public
// chart on fred.stlouisfed.org).
async function fetchFredMonthly(seriesId) {
  const now = new Date();
  const cosd = new Date(Date.UTC(now.getUTCFullYear() - 4, now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${cosd}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (dashboard-cron)' } });
  if (!res.ok) throw new Error(`fred http ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n').filter(Boolean);
  // FRED's header column name has varied ("DATE" vs "observation_date").
  if (lines.length < 2 || !lines[0].toLowerCase().includes('date')) {
    throw new Error(`unexpected fred response: ${text.slice(0, 100)}`);
  }
  return lines.slice(1).map(line => {
    const [date, value] = line.split(',');
    return { date, value: Number(value) };
  });
}

// Statistics Canada's Web Data Service is the authoritative source and needs no
// key. Vector 41690973 is the headline all-items CPI for Canada (monthly, NSA,
// 2002=100) — the series StatCan quotes in its own CPI releases.
async function fetchStatCanMonthly() {
  const res = await fetch('https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorsAndLatestNPeriods', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ vectorId: 41690973, latestN: 18 }])
  });
  if (!res.ok) throw new Error(`statcan http ${res.status}`);
  const json = await res.json();
  const entry = Array.isArray(json) ? json[0] : null;
  if (entry?.status !== 'SUCCESS') throw new Error(`statcan status ${entry?.status ?? 'unknown'}`);
  const points = entry?.object?.vectorDataPoint;
  if (!Array.isArray(points) || points.length === 0) throw new Error('statcan: no data points');
  return points.map(p => ({ date: p.refPer, value: Number(p.value) }));
}

// Tried in order; the first that yields a fresh, genuine 12-month comparison wins.
const CANADA_SOURCES = [
  { label: 'StatCan v41690973', load: fetchStatCanMonthly },
  { label: 'FRED CANCPIALLMINMEI', load: () => fetchFredMonthly('CANCPIALLMINMEI') },
  { label: 'FRED CPALTT01CAM661N', load: () => fetchFredMonthly('CPALTT01CAM661N') },
  { label: 'FRED CANCPALTT01IXNBM', load: () => fetchFredMonthly('CANCPALTT01IXNBM') }
];

async function fetchCanadaCpi() {
  for (const source of CANADA_SOURCES) {
    try {
      const result = assertFresh(source.label, yoyFromMonthly(await source.load()));
      if (result) return result;
    } catch (err) {
      console.error(`[econ] ${source.label}: ${err.message}`);
    }
  }
  return null;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const econ = {};

  try {
    const us = assertFresh('US CPI (BLS)', await fetchUsCpi());
    if (us) econ.us = { cpiYoY: us.yoy, period: us.period };
  } catch (err) {
    console.error(`[econ] US CPI: ${err.message}`);
  }

  try {
    const pce = assertFresh('US PCE (FRED PCEPI)', yoyFromMonthly(await fetchFredMonthly('PCEPI')));
    if (pce) econ.usPce = { pceYoY: pce.yoy, period: pce.period };
  } catch (err) {
    console.error(`[econ] US PCE: ${err.message}`);
  }

  const canada = await fetchCanadaCpi();
  if (canada) econ.canada = { cpiYoY: canada.yoy, period: canada.period };

  await mkdir('data', { recursive: true });
  await writeFile('data/econ.json', JSON.stringify({ generatedAt, ...econ }, null, 2) + '\n');
  const fmt = v => (v ? v.toFixed(1) + '%' : 'n/a');
  console.log(`Wrote data/econ.json — US CPI: ${fmt(econ.us?.cpiYoY)}, US PCE: ${fmt(econ.usPce?.pceYoY)}, Canada CPI: ${fmt(econ.canada?.cpiYoY)}.`);
}

// Only run the pipeline when invoked directly, so the YoY helper stays testable.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
