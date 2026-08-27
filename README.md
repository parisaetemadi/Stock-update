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

## Sources

- Prices: Yahoo Finance chart API; CoinGecko for crypto; FRED for the 2-year yield
- US CPI: Bureau of Labor Statistics public API
- US PCE: FRED (`PCEPI`)
- Canada CPI: Statistics Canada Web Data Service, with FRED series as fallbacks
- Earnings dates: Nasdaq public earnings calendar
- Biotech headlines: Fierce Biotech, Endpoints News, STAT News, BioPharma Dive RSS

No API keys are required, so there are no secrets in this repo.
