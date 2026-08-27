import { writeFile, mkdir } from 'node:fs/promises';

// Kept in sync by hand with DEFAULT_WATCHLIST in app.js. Fetched here, server-side,
// because browsers can't reliably call these APIs directly (CORS/auth walls) — the
// client-side fetch is just a best-effort top-up for crypto tickers.
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

const CRYPTO_COIN_IDS = { ETH: 'ethereum', BTC: 'bitcoin' };
const YAHOO_SYMBOL_OVERRIDES = { TNX: '^TNX', USDCAD: 'USDCAD=X' };
// Yahoo has no clean percentage-yield ticker for the 2-year (unlike ^TNX for the
// 10-year) — use FRED's well-known DGS2 series instead (Market Yield on U.S.
// Treasury Securities at 2-Year Constant Maturity).
const FRED_SYMBOL_OVERRIDES = { US2Y: 'DGS2' };

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*'
};

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`yahoo http ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error('no data');
  const price = meta.regularMarketPrice;
  // meta.chartPreviousClose is unreliable with range=5d (it isn't consistently
  // "yesterday's close") — use the actual daily close series instead: the
  // second-to-last close is the prior trading day's close.
  const closes = (result?.indicators?.quote?.[0]?.close || []).filter(c => c != null);
  const prevClose = closes.length >= 2 ? closes[closes.length - 2] : (meta.chartPreviousClose ?? meta.previousClose);
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : null;
  return { price, changePct };
}

// FRED's graph CSV endpoint doesn't require an API key.
async function fetchFredLatest(seriesId) {
  const now = new Date();
  const cosd = new Date(now.getFullYear(), now.getMonth() - 2, 1).toISOString().slice(0, 10);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${cosd}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (dashboard-cron)' } });
  if (!res.ok) throw new Error(`fred http ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2 || !lines[0].toUpperCase().startsWith('DATE')) {
    throw new Error(`unexpected fred response: ${text.slice(0, 100)}`);
  }
  const rows = lines.slice(1).map(line => {
    const [date, value] = line.split(',');
    return { date, value: Number(value) };
  }).filter(r => r.date && !isNaN(r.value));
  if (rows.length < 2) throw new Error('not enough data points');

  const latest = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const changePct = prev.value ? ((latest.value - prev.value) / prev.value) * 100 : null;
  return { price: latest.value, changePct };
}

async function fetchCoinGecko(coinId) {
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`);
  if (!res.ok) throw new Error(`coingecko http ${res.status}`);
  const json = await res.json();
  const price = json?.[coinId]?.usd;
  const changePct = json?.[coinId]?.usd_24h_change;
  if (price == null) throw new Error('no data');
  return { price, changePct };
}

async function main() {
  const generatedAt = new Date().toISOString();
  const prices = {};

  for (const ticker of TICKERS) {
    try {
      const coinId = CRYPTO_COIN_IDS[ticker];
      const fredId = FRED_SYMBOL_OVERRIDES[ticker];
      const symbol = YAHOO_SYMBOL_OVERRIDES[ticker] || ticker;
      let data;
      if (coinId) data = await fetchCoinGecko(coinId);
      else if (fredId) data = await fetchFredLatest(fredId);
      else data = await fetchYahoo(symbol);
      prices[ticker] = { ...data, time: generatedAt };
    } catch (err) {
      console.error(`[watchlist] ${ticker}: ${err.message}`);
    }
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/watchlist.json', JSON.stringify({ generatedAt, prices }, null, 2) + '\n');
  console.log(`Wrote data/watchlist.json with ${Object.keys(prices).length}/${TICKERS.length} tickers.`);
}

main().catch(err => { console.error(err); process.exit(1); });
