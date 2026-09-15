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

import { writeFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { SERIES, candidatesFor, isFresh, stalenessDays, parseFredCsv, applyTransform, thin, cutoffISO, pack, FULL_DETAIL_YEARS } from './macro-series.mjs';

const RETRIES = 3;

// Statistics Canada's Web Data Service is the authority for Canadian series and
// needs no key. latestN is capped generously rather than exactly: asking for
// more periods than a vector has returns what it has.
async function fetchStatCan(vectorId) {
  const res = await fetch('https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorsAndLatestNPeriods', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ vectorId: Number(vectorId), latestN: 900 }])
  });
  if (!res.ok) throw new Error(`statcan http ${res.status}`);
  const json = await res.json();
  const entry = Array.isArray(json) ? json[0] : null;
  if (entry?.status !== 'SUCCESS') throw new Error(`statcan status ${entry?.status ?? 'unknown'}`);
  const points = entry?.object?.vectorDataPoint;
  if (!Array.isArray(points) || points.length === 0) throw new Error('statcan: no data points');
  return points
    .map(p => ({ date: p.refPer, value: Number(p.value) }))
    .filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

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

function describe(candidate) {
  return candidate.startsWith('statcan:') ? `StatCan v${candidate.slice(8)}` : `FRED ${candidate}`;
}

function load(candidate) {
  return candidate.startsWith('statcan:') ? fetchStatCan(candidate.slice(8)) : fetchOne(candidate);
}

/* A spec may name several sources, tried in order. Two things can go wrong and
   only one of them looks like an error: a source can fail outright, or it can
   answer cheerfully with a series that stopped being updated. FRED still serves
   CANCPIALLMINMEI, frozen since March 2025, and nothing about the response says
   so. A candidate therefore has to be both reachable and current to be used.

   The source that actually won is recorded in the feed, so the page cites what
   it really charted rather than the first id that was guessed at. */
async function fetchSeries(spec) {
  const candidates = candidatesFor(spec);
  const verbose = candidates.length > 1;
  let lastErr;
  for (const candidate of candidates) {
    const name = describe(candidate);
    try {
      const rows = await load(candidate);
      if (rows.length === 0) throw new Error('empty series');
      const latest = rows[rows.length - 1].date;
      if (!isFresh(latest, spec.freq)) {
        throw new Error(`last observation ${latest} is ${Math.round(stalenessDays(latest))} days old — this source has stopped updating`);
      }
      if (verbose) console.error(`[macro] ${spec.id}: using ${name}`);
      return { rows, source: name };
    } catch (err) {
      lastErr = err;
      if (verbose) console.error(`[macro] ${spec.id}: ${name} — ${err.message}`);
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
      const { rows: raw, source } = await fetchSeries(spec);
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
        freq: spec.freq, note: spec.note, source,
        start: points[0].date, count: points.length,
        latest: { date: last.date, value: Number(last.value.toFixed(4)) }
      };
      files.push([spec.id, pack(points)]);
      console.error(`[macro] ${spec.id}: ${points.length} points, latest ${last.date} = ${last.value.toFixed(2)}${spec.unit}`);
    } catch (err) {
      failed.push(spec.id);
      console.error(`[macro] ${spec.id} (${candidatesFor(spec).map(describe).join(' / ')}): ${err.message}`);
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

  // Dropping a series from SERIES has to remove its file too. The workflow
  // commits with `git add data/`, which stages changes and additions but never
  // a deletion nobody performed — so without this the feed keeps serving
  // history for a series the index no longer lists.
  for (const name of await readdir('data/macro')) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (series[id]) continue;
    await unlink(`data/macro/${name}`);
    console.error(`[macro] removed data/macro/${name} — no longer published`);
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
