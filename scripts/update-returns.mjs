import { writeFile, mkdir } from 'node:fs/promises';

// Trailing returns per ticker, for the period selector on the dashboard.
//
// This runs on the DAILY schedule, not the 10-minute price one: a 1-week or
// 5-year return barely moves intraday, and pulling five years of daily closes
// for every ticker every ten minutes would be pure waste.
//
// One request per ticker covers all periods — the whole 5y daily close series
// comes back at once and each period is just a lookup within it.

const PERIODS = ['1W', '1M', 'YTD', '1Y', '5Y'];

// Market instruments (top of the Finance panel) plus the seeded watchlist.
const TICKERS = [
  'IXIC', 'GSPC', 'CL', 'GC', 'SI', 'BTC', 'ETH',
  'CEG', 'BWXT', 'NEE', 'SMR', 'URA',
  'NVDA', 'AMD', 'QCOM', 'MU', 'SNDK', 'STX', 'WDC', 'SMCI', 'ACMR', 'COHR',
  'AAPL', 'AMZN', 'GOOG', 'META', 'MSFT', 'TSLA',
  'PLTR', 'DLR', 'EQIX', 'ARKK',
  'ASTS', 'AEVA',
  'BUG', 'SHOP',
  'XBI',
  'HBNK.TO',
  'USO', 'TNX', 'US1Y', 'US2Y', 'US30Y', 'USDCAD'
];

const YAHOO_SYMBOL_OVERRIDES = {
  IXIC: '^IXIC', GSPC: '^GSPC', CL: 'CL=F', GC: 'GC=F', SI: 'SI=F',
  BTC: 'BTC-USD', ETH: 'ETH-USD',
  TNX: '^TNX', USDCAD: 'USDCAD=X'
};

// Yahoo has no clean percentage-yield ticker for the 2-year, same as in
// update-watchlist.mjs.
// Yahoo only publishes a clean percentage-yield ticker for a couple of
// maturities, so the rest come from FRED's constant-maturity series.
const FRED_SYMBOL_OVERRIDES = { US1Y: 'DGS1', US2Y: 'DGS2', US30Y: 'DGS30' };

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*'
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

// Start date for each period, given "today".
function periodStart(period, today) {
  const d = new Date(today);
  switch (period) {
    case '1W': d.setUTCDate(d.getUTCDate() - 7); return isoDay(d);
    case '1M': d.setUTCMonth(d.getUTCMonth() - 1); return isoDay(d);
    // Year-to-date is measured from the final close of last year.
    case 'YTD': return `${today.getUTCFullYear() - 1}-12-31`;
    case '1Y': d.setUTCFullYear(d.getUTCFullYear() - 1); return isoDay(d);
    case '5Y': d.setUTCFullYear(d.getUTCFullYear() - 5); return isoDay(d);
    default: return null;
  }
}

// Percentage change from the last close on or before `from` to the latest close.
// Returns null when the series doesn't reach back that far — a stock listed two
// years ago genuinely has no 5-year return, and inventing one would be worse
// than showing nothing.
function returnSince(series, from) {
  if (series.length === 0) return null;
  const latest = series[series.length - 1];
  let base = null;
  for (const point of series) {
    if (point.date <= from) base = point; else break;
  }
  if (!base || !base.close || !latest.close) return null;
  return ((latest.close - base.close) / base.close) * 100;
}

async function fetchYahooSeries(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5y`;
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`yahoo http ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const stamps = result?.timestamp;
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(stamps) || !Array.isArray(closes)) throw new Error('no series');

  return stamps
    .map((stamp, i) => ({ date: isoDay(new Date(stamp * 1000)), close: closes[i] }))
    .filter(p => p.close != null);
}

async function fetchFredSeries(seriesId) {
  const cosd = isoDay(new Date(Date.now() - 6 * 365 * 86400000));
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${cosd}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (dashboard-cron)' } });
  if (!res.ok) throw new Error(`fred http ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2 || !lines[0].toLowerCase().includes('date')) {
    throw new Error(`unexpected fred response: ${text.slice(0, 100)}`);
  }
  return lines.slice(1)
    .map(line => {
      const [date, value] = line.split(',');
      return { date, close: Number(value) };
    })
    .filter(p => p.date && !isNaN(p.close));
}

async function main() {
  const generatedAt = new Date().toISOString();
  const today = new Date();
  const returns = {};
  let covered = 0;

  for (const ticker of TICKERS) {
    try {
      const fredId = FRED_SYMBOL_OVERRIDES[ticker];
      const series = fredId
        ? await fetchFredSeries(fredId)
        : await fetchYahooSeries(YAHOO_SYMBOL_OVERRIDES[ticker] || ticker);

      const entry = {};
      for (const period of PERIODS) {
        const value = returnSince(series, periodStart(period, today));
        if (value != null) entry[period] = value;
      }
      if (Object.keys(entry).length > 0) {
        returns[ticker] = entry;
        covered++;
      }
      const missing = PERIODS.filter(p => entry[p] == null);
      if (missing.length) console.error(`[returns] ${ticker}: no history for ${missing.join(', ')}`);
    } catch (err) {
      console.error(`[returns] ${ticker}: ${err.message}`);
    }
    await sleep(120);
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/returns.json', JSON.stringify({ generatedAt, periods: PERIODS, returns }, null, 2) + '\n');
  console.log(`Wrote data/returns.json with ${covered}/${TICKERS.length} tickers.`);
}

main().catch(err => { console.error(err); process.exit(1); });
