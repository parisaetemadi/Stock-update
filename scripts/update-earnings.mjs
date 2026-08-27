import { writeFile, mkdir } from 'node:fs/promises';

// Kept in sync by hand with DEFAULT_WATCHLIST in app.js. Earnings dates change
// rarely, so this runs on the daily schedule rather than the 10-minute price one.
const TICKERS = [
  'CEG', 'BWXT', 'NEE', 'SMR', 'URA',
  'NVDA', 'AMD', 'QCOM', 'MU', 'SNDK', 'STX', 'WDC', 'SMCI', 'ACMR', 'COHR',
  'AAPL', 'AMZN', 'GOOG', 'META', 'MSFT', 'TSLA',
  'PLTR', 'DLR', 'EQIX', 'ARKK',
  'ASTS', 'AEVA',
  'BUG', 'SHOP',
  'HBNK.TO',
  'USO', 'TNX', 'US2Y', 'USDCAD'
];

const LOOKAHEAD_DAYS = 14;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.nasdaq.com',
  'Referer': 'https://www.nasdaq.com/'
};

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Nasdaq's public earnings calendar returns every US-listed ticker reporting
// on a given day (no API key, no per-symbol lookup — unlike Yahoo's
// quoteSummary endpoint, which now requires an auth crumb we don't have).
async function fetchEarningsSymbolsForDate(dateISO) {
  const url = `https://api.nasdaq.com/api/calendar/earnings?date=${dateISO}`;
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`nasdaq http ${res.status}`);
  const json = await res.json();
  const rows = json?.data?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map(r => r.symbol).filter(Boolean);
}

async function main() {
  const generatedAt = new Date().toISOString();
  const dates = {};
  const remaining = new Set(TICKERS);
  const today = new Date();

  for (let i = 0; i <= LOOKAHEAD_DAYS && remaining.size > 0; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + i);
    const dateISO = isoDate(d);
    try {
      const symbols = await fetchEarningsSymbolsForDate(dateISO);
      for (const symbol of symbols) {
        if (remaining.has(symbol)) {
          dates[symbol] = dateISO;
          remaining.delete(symbol);
        }
      }
    } catch (err) {
      console.error(`[earnings] ${dateISO}: ${err.message}`);
    }
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/earnings.json', JSON.stringify({ generatedAt, dates }, null, 2) + '\n');
  console.log(`Wrote data/earnings.json with ${Object.keys(dates).length}/${TICKERS.length} tickers.`);
}

main().catch(err => { console.error(err); process.exit(1); });
