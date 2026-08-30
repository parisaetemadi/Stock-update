// Market value, trailing revenue, profit and margins for the companies in the
// Drug-research value chain, written to data/drugchain.json.
//
// The company list is not duplicated here: it is fetched from Drug-research,
// which is where the chain is defined. This script only knows how to price a
// ticker, which is the one thing this repository is for.
//
// Runs here rather than in Drug-research so all the market fetching lives in
// one public repo with free Actions minutes, and so the commits never rebuild
// the private site.
//
// A company that cannot be priced is left out of the file rather than guessed
// at. The page counts what is missing and says so, which is the honest failure
// mode -- better a chart that admits a gap than one silently drawn from stale
// figures.

import { writeFile, mkdir } from 'node:fs/promises';

const COMPANIES_URL =
  'https://raw.githubusercontent.com/parisaetemadi/Drug-research/main/data/companies.json';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Yahoo session: a cookie, then a crumb minted against it ---------- */

async function session() {
  const res = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA } });
  // fc.yahoo.com answers 404 but sets the cookie we need, so the status is ignored.
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map(c => c.split(';')[0])
    .join('; ');
  if (!cookie) throw new Error('no cookie from Yahoo');

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie }
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes('<')) throw new Error('no crumb from Yahoo');
  return { cookie, crumb };
}

// Yahoo answers the first quote call after a fresh crumb with a 429 often
// enough that a single attempt is not a fair test of whether the endpoint is
// available. Back off and retry; a run that still 429s after this is being
// refused, not rate-limited, and the caller gives up quickly rather than
// grinding through every symbol.
const RETRY_DELAYS = [1000, 2500, 6000, 12000];

async function getJson(url, sess) {
  let last;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Cookie: sess.cookie, Accept: 'application/json' }
    });
    if (res.ok) return res.json();
    last = new Error(`http ${res.status}`);
    if (res.status !== 429 || attempt === RETRY_DELAYS.length) throw last;
    await sleep(RETRY_DELAYS[attempt]);
    // A stale crumb reads as a 429, so mint a new session before the last try.
    if (attempt === RETRY_DELAYS.length - 1) {
      try { Object.assign(sess, await session()); } catch { /* keep the old one */ }
    }
  }
  throw last;
}

/* ---------- quotes, in batches ---------- */

async function quoteBatch(symbols, sess) {
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote'
    + `?symbols=${symbols.map(encodeURIComponent).join(',')}`
    + `&crumb=${encodeURIComponent(sess.crumb)}`;
  const json = await getJson(url, sess);
  return json?.quoteResponse?.result ?? [];
}

// The batch endpoint returns a market cap but no income statement, and the page
// wants revenue, profit and margins on hover. quoteSummary carries all of it,
// one symbol at a time, so every company gets its own call.
async function quoteSummary(symbol, sess) {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
    + '?modules=price,financialData,defaultKeyStatistics,incomeStatementHistory'
    + `&crumb=${encodeURIComponent(sess.crumb)}`;
  const json = await getJson(url, sess);
  return json?.quoteSummary?.result?.[0] ?? null;
}

// Yahoo reports net income in two places and neither is reliably present:
// defaultKeyStatistics has a trailing-twelve-month figure, the income statement
// has the last full year. Prefer the trailing one, fall back to the annual.
function netIncomeOf(summary) {
  const ttm = summary?.defaultKeyStatistics?.netIncomeToCommon?.raw;
  if (typeof ttm === 'number') return ttm;
  const annual = summary?.incomeStatementHistory?.incomeStatementHistory?.[0]?.netIncome?.raw;
  return typeof annual === 'number' ? annual : null;
}

/* ---------- currency ---------- */

// Market caps come back in the listing currency. Everything on the page is in
// dollars, so each currency seen is converted once.
async function fxRate(currency, sess) {
  if (currency === 'USD') return 1;
  // Yahoo quotes GBp (pence) for some London listings.
  if (currency === 'GBp') return (await fxRate('GBP', sess)) / 100;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${currency}USD=X?interval=1d&range=5d`;
  const json = await getJson(url, sess);
  const rate = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!rate) throw new Error(`no fx for ${currency}`);
  return rate;
}

/* ---------- main ---------- */

const listRes = await fetch(COMPANIES_URL, { headers: { 'User-Agent': UA } });
if (!listRes.ok) throw new Error(`could not read the company list: http ${listRes.status}`);
const { companies } = await listRes.json();
const symbols = companies.map(c => c.ticker);

const sess = await session();
console.log(`session ok, ${symbols.length} symbols to price`);

const raw = new Map();
for (let i = 0; i < symbols.length; i += 20) {
  const batch = symbols.slice(i, i + 20);
  try {
    for (const r of await quoteBatch(batch, sess)) raw.set(r.symbol, r);
  } catch (err) {
    console.warn(`batch ${i} failed (${err.message}), falling back one by one`);
  }
  await sleep(400);
}

// Then one detail call per symbol for the figures the batch does not carry.
// This also backfills the market cap for anything the batches dropped.
let consecutiveRefusals = 0;
for (const symbol of symbols) {
  if (consecutiveRefusals >= 8) {
    console.warn(`giving up after ${consecutiveRefusals} consecutive refusals — the endpoint is not serving this runner`);
    break;
  }
  try {
    const r = await quoteSummary(symbol, sess);
    consecutiveRefusals = 0;
    if (!r) continue;
    const prior = raw.get(symbol) ?? {};
    const fin = r.financialData ?? {};
    raw.set(symbol, {
      ...prior,
      symbol,
      marketCap: prior.marketCap ?? r?.price?.marketCap?.raw ?? null,
      currency: prior.currency ?? r?.price?.currency ?? null,
      totalRevenue: fin.totalRevenue?.raw ?? prior.totalRevenue ?? null,
      netIncome: netIncomeOf(r),
      // Margins are ratios, so they need no currency conversion.
      grossMargin: fin.grossMargins?.raw ?? null,
      operatingMargin: fin.operatingMargins?.raw ?? null,
      profitMargin: fin.profitMargins?.raw ?? null,
      revenueGrowth: fin.revenueGrowth?.raw ?? null
    });
  } catch (err) {
    if (err.message.includes('429')) consecutiveRefusals++;
    console.warn(`${symbol}: ${err.message}`);
  }
  await sleep(250);
}

const currencies = [...new Set([...raw.values()].map(r => r.currency).filter(Boolean))];
const fx = {};
for (const c of currencies) {
  try {
    fx[c] = await fxRate(c, sess);
  } catch (err) {
    console.warn(`fx ${c}: ${err.message}`);
  }
  await sleep(200);
}
console.log('fx:', fx);

const quotes = {};
const missing = [];
for (const { ticker } of companies) {
  const r = raw.get(ticker);
  const rate = r && fx[r.currency];
  if (!r?.marketCap || !rate) { missing.push(ticker); continue; }
  quotes[ticker] = {
    marketCap: Math.round(r.marketCap * rate),
    revenue: r.totalRevenue != null ? Math.round(r.totalRevenue * rate) : null,
    netIncome: r.netIncome != null ? Math.round(r.netIncome * rate) : null,
    grossMargin: r.grossMargin ?? null,
    operatingMargin: r.operatingMargin ?? null,
    profitMargin: r.profitMargin ?? null,
    revenueGrowth: r.revenueGrowth ?? null,
    currency: r.currency
  };
}

if (Object.keys(quotes).length < companies.length * 0.6) {
  // A handful of gaps is normal; most of the list going missing means the
  // endpoint changed, and overwriting good data with that would be worse than
  // failing the run.
  throw new Error(
    `only ${Object.keys(quotes).length}/${companies.length} priced — refusing to overwrite. `
    + 'If the log is full of 429s, Yahoo is refusing the quote and quoteSummary endpoints for this '
    + 'runner; the v8 chart endpoint the other scripts here use is unaffected, but carries no '
    + 'market cap or income statement.'
  );
}

const out = {
  generatedAt: new Date().toISOString(),
  source: 'Yahoo Finance',
  companyListFrom: COMPANIES_URL,
  priced: Object.keys(quotes).length,
  missing,
  fx,
  quotes
};

await mkdir(new URL('../data', import.meta.url), { recursive: true });
await writeFile(new URL('../data/drugchain.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${out.priced} quotes, ${missing.length} missing: ${missing.join(', ') || 'none'}`);
