import { writeFile, mkdir } from 'node:fs/promises';

const INSTRUMENTS = [
  { id: 'IXIC', symbol: '^IXIC' },
  { id: 'GSPC', symbol: '^GSPC' },
  { id: 'CL', symbol: 'CL=F' },
  { id: 'GC', symbol: 'GC=F' }
];

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

async function fetchCoinGecko() {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true');
  if (!res.ok) throw new Error(`coingecko http ${res.status}`);
  const json = await res.json();
  const price = json?.bitcoin?.usd;
  const changePct = json?.bitcoin?.usd_24h_change;
  if (price == null) throw new Error('coingecko: no data');
  return { price, changePct };
}

async function main() {
  const generatedAt = new Date().toISOString();
  const instruments = {};

  for (const inst of INSTRUMENTS) {
    try {
      instruments[inst.id] = { ...(await fetchYahoo(inst.symbol)), time: generatedAt };
    } catch (err) {
      console.error(`[market] ${inst.id}: ${err.message}`);
    }
  }

  try {
    instruments.BTC = { ...(await fetchCoinGecko()), time: generatedAt };
  } catch (err) {
    console.error(`[market] BTC: ${err.message}`);
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/market.json', JSON.stringify({ generatedAt, instruments }, null, 2) + '\n');
  console.log(`Wrote data/market.json with ${Object.keys(instruments).length} instruments.`);
}

main().catch(err => { console.error(err); process.exit(1); });
