# Stock-update

Public data feed for a personal dashboard.

GitHub Actions refreshes the JSON files in [`data/`](data/) on a schedule and
commits them here. The dashboard fetches them directly from
`raw.githubusercontent.com`.

| File | Contents | Refreshed |
| --- | --- | --- |
| `data/market.json` | Index, commodity and crypto prices | every 10 min |
| `data/watchlist.json` | Watchlist ticker prices | every 10 min |
| `data/econ.json` | US CPI, US PCE, Canada CPI (year-over-year) | daily |
| `data/earnings.json` | Next earnings date per ticker | daily |
| `data/biotech.json` | Biotech news headlines | daily |
| `data/drugchain.json` | Market value, revenue, profit and margins for the [Drug-research](https://github.com/parisaetemadi/Drug-research) value chain | daily |

## Why this is a separate public repo

The dashboard itself is private. This repo holds only public information —
market prices, published inflation statistics, and news headlines — and being
public buys two things the dashboard repo can't have:

- **Unlimited Actions minutes.** Private repositories are metered; at a
  10-minute cadence this pipeline would use roughly twice the free monthly
  allowance on its own.
- **No rebuilds of the dashboard.** Every commit to the site's repo triggers a
  host rebuild, and those are capped. Data commits landing here instead means
  the site only rebuilds when its code actually changes.

## The drug value chain feed

`data/drugchain.json` prices the companies in the
[Drug-research](https://github.com/parisaetemadi/Drug-research) value chain. The
list of companies is **not** kept here — `update-drugchain.mjs` fetches
`data/companies.json` from that repo at run time, so the chain is defined in one
place and this repo only does what it is for: turning a ticker into a number.

Each company gets a market value, trailing revenue, net income and gross,
operating and net margins, converted into dollars from whatever currency the
listing quotes. Companies that cannot be priced are named in `missing` and left
out of `quotes` rather than guessed at, and the run **fails without writing** if
fewer than 60% of the list prices — a broken endpoint should leave yesterday's
numbers alone, not half-empty the chart that reads them.

## Sources

- Prices: Yahoo Finance chart API; CoinGecko for crypto; FRED for the 2-year yield
- Drug value chain market data: Yahoo Finance quote and quoteSummary endpoints
- US CPI: Bureau of Labor Statistics public API
- US PCE: FRED (`PCEPI`)
- Canada CPI: Statistics Canada Web Data Service, with FRED series as fallbacks
- Earnings dates: Nasdaq public earnings calendar
- Biotech headlines: Fierce Biotech, Endpoints News, STAT News, BioPharma Dive RSS

No API keys are required, so there are no secrets in this repo.
