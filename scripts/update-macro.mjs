/* Publishes data/macro.json: the full history of a dozen macro series, for the
   dashboard's macro page to chart.

   This is deliberately separate from update-econ.mjs. That one publishes three
   latest readings for the dashboard's own cards and must be conservative — it
   rejects a stale number rather than showing one. This publishes history, where
   an old observation is the point rather than a problem, so nothing here is
   rejected for age.

   Every series comes from FRED's graph CSV endpoint, which needs no API key.
   A series that fails is left out of the file and logged; the rest still
   publish, and the page skips what isn't there. */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { SERIES, candidatesFor, parseFredCsv, applyTransform, thin, cutoffISO, pack, FULL_DETAIL_YEARS } from './macro-series.mjs';

const RETRIES = 3;

async function fetchOne(fredId) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      // No cosd: the default is the series' own start, which is the whole point.
      const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(fredId)}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (dashboard-cron)' } });
      if (!res.ok) throw new Error(`http ${res.status}`);
      return parseFredCsv(await res.text());
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }
  throw lastErr;
}

// A spec may name several FRED ids. FRED has renamed its OECD-derived series
// more than once, so rather than hard-coding one id and hoping, each is tried
// until one answers — and the id that actually worked is recorded in the feed,
// so the page cites the series it really charted rather than the first guess.
async function fetchSeries(spec) {
  const ids = candidatesFor(spec);
  let lastErr;
  for (const id of ids) {
    try {
      const rows = await fetchOne(id);
      if (rows.length === 0) throw new Error('empty series');
      if (ids.length > 1) console.error(`[macro] ${spec.id}: using FRED ${id}`);
      return { rows, fredId: id };
    } catch (err) {
      lastErr = err;
      if (ids.length > 1) console.error(`[macro] ${spec.id}: FRED ${id} — ${err.message}`);
    }
  }
  throw lastErr;
}

// A series that fails today shouldn't vanish from the page — yesterday's
// history is still true history, so the previous run's index tells us what was
// there and its per-series file is simply left on disk untouched.
async function previousIndex() {
  try {
    return JSON.parse(await readFile('data/macro.json', 'utf8')).series || {};
  } catch {
    return {};
  }
}

async function main() {
  const generatedAt = new Date().toISOString();
  const cutoff = cutoffISO();
  const previous = await previousIndex();
  const series = {};
  const files = [];
  const failed = [];
  const carried = [];

  for (const spec of SERIES) {
    try {
      const { rows: raw, fredId } = await fetchSeries(spec);
      const rows = applyTransform(raw, spec.transform);
      if (rows.length === 0) throw new Error('no observations survived the transform');
      const points = thin(rows, cutoff);
      const last = rows[rows.length - 1];
      // The index carries what the page needs before a choice is made — the
      // label, the units, and the current reading. The history itself goes in
      // its own file, so opening the page costs one small fetch rather than the
      // whole archive of every series on it.
      series[spec.id] = {
        label: spec.label, group: spec.group, unit: spec.unit, decimals: spec.decimals,
        freq: spec.freq, note: spec.note, source: `FRED ${fredId}`,
        start: points[0].date, count: points.length,
        latest: { date: last.date, value: Number(last.value.toFixed(4)) }
      };
      files.push([spec.id, pack(points)]);
      console.error(`[macro] ${spec.id}: ${points.length} points, latest ${last.date} = ${last.value.toFixed(2)}${spec.unit}`);
    } catch (err) {
      failed.push(spec.id);
      console.error(`[macro] ${spec.id} (FRED ${candidatesFor(spec).join(' / ')}): ${err.message}`);
      if (previous[spec.id]) {
        series[spec.id] = previous[spec.id];
        carried.push(spec.id);
        console.error(`[macro] ${spec.id}: kept the previous run's history`);
      }
    }
  }

  if (Object.keys(series).length === 0) {
    throw new Error('every series failed — refusing to publish an empty feed over a good one');
  }

  await mkdir('data/macro', { recursive: true });
  for (const [id, packed] of files) {
    await writeFile(`data/macro/${id}.json`, JSON.stringify(packed) + '\n');
  }
  await writeFile('data/macro.json', JSON.stringify({
    generatedAt,
    // Recorded rather than assumed, so the page can tell the reader that the
    // older part of a daily line is monthly instead of implying it is not.
    fullDetailFrom: cutoff,
    fullDetailYears: FULL_DETAIL_YEARS,
    order: SERIES.map(s => s.id).filter(id => series[id]),
    series
  }) + '\n');

  const fresh = Object.keys(series).length - carried.length;
  const parts = [`${fresh}/${SERIES.length} series refreshed`];
  if (carried.length) parts.push(`${carried.length} kept from the last run (${carried.join(', ')})`);
  const dropped = failed.filter(id => !carried.includes(id));
  if (dropped.length) parts.push(`${dropped.length} unavailable (${dropped.join(', ')})`);
  console.log(`Wrote data/macro.json — ${parts.join(', ')}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
