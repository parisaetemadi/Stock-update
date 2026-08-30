# Stock-update

Public data feed for a personal dashboard.

GitHub Actions refreshes the JSON files in [`data/`](data/) on a schedule and
commits them here. The dashboard fetches them directly from
`raw.githubusercontent.com`.

| File | Contents | Refreshed |
| --- | --- | --- |
| `data/market.json` | Index, commodity and crypto prices | scheduled every 10 min* |
| `data/watchlist.json` | Watchlist ticker prices | scheduled every 10 min* |
| `data/econ.json` | US CPI, US PCE, Canada CPI (year-over-year) | daily |
| `data/earnings.json` | Next earnings date per ticker | daily |
| `data/biotech.json` | Biotech news headlines | daily |
| `data/returns.json` | 1W / 1M / YTD / 1Y / 5Y change per ticker | daily |

\* The cron says `*/10 * * * *`; GitHub does not honour it. Measured over the
72 hours to 30 Aug 2026, the schedule produced **13 runs, not ~1,300** — an
average of one every five and a half hours, with gaps of eight and ten hours.
GitHub drops scheduled runs under load and offers no guarantee about them, so
this is a floor, not a cadence. The dashboard gets genuinely current prices
from its own Cloudflare function on page load; these files are the fallback
for when that can't answer, and the manual **Run workflow** button on both
workflows refreshes them on demand.

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
