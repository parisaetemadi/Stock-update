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
| `data/macro.json` | Index of the macro series: label, units, source, latest reading | 4x daily |
| `data/macro/<id>.json` | Full history of one macro series | 4x daily |

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


## The macro history feed

`data/macro.json` is an index, not the data. It lists every series with its
label, units, FRED source and current reading; the observations themselves live
in `data/macro/<id>.json`, one file per series. A page showing one chart at a
time therefore downloads the index (about a kilobyte) and a single series,
rather than the whole archive.

Eight series are published: the 2-, 10- and 30-year Treasury yields, US CPI
inflation and unemployment, Canadian CPI inflation and unemployment, and the
S&P 500 price/earnings ratio. No Canadian yields. Most come from FRED's graph
CSV endpoint, which needs no API key; Canadian CPI comes from StatCan.

**The P/E is the one scrape here, and it is deliberate.** FRED has no S&P 500
price/earnings series. A probe against a runner found three possibilities: the
Yale Shiller spreadsheet, which answers only over plain http and is a 1.6MB
legacy .xls that would mean adding a spreadsheet parser to a repository with no
dependencies at all; Nasdaq Data Link, which now wants a key; and multpl.com,
which serves a two-column HTML table back to 1871. The table won on cost, and
the trade is that a redesign of that page breaks it. So the parser throws on
anything that is not a long run of dated numbers rather than publishing a stub,
and a failed week keeps the previous file. The rows carry a dagger where multpl
is estimating a value, and negative ratios — real, in 2009 — are kept.

Two details worth knowing before reading the numbers:

**History is thinned, not truncated.** The last five years are published exactly
as FRED reports them. Older observations are reduced to one per month — the last
of each month — because a daily series back to 1962 is some sixteen thousand
points that no chart can draw and nobody should have to download. The boundary
is published as `fullDetailFrom` so a page can say so rather than implying the
whole line is daily.

**A blank is missing data, not a zero.** FRED marks a missing observation as
`.` in some series and as nothing at all in others. `Number(".")` is `NaN` and
falls out of a numeric check on its own, but `Number("")` is `0`, which is
finite — so every US market holiday in `DGS1MO` was published as a genuine 0%
yield and charted as a spike to the axis. The parser now rejects a blank field
explicitly, while still keeping a real `0.00` (a policy rate can print zero).

**Inflation is derived here, levels are not.** A CPI series from FRED is an index,
not a rate. `update-macro.mjs` converts it to a year-over-year percentage by
matching observation dates twelve months apart — never by counting rows back,
which silently becomes a thirteen-month comparison the moment the series has a
gap. Yields and unemployment rates are published as they come.

**A source that answers is not the same as a source that is current.** FRED still
serves `CANCPIALLMINMEI`, and the response looks entirely normal — the series
simply stopped being updated in March 2025. Charting it would have shown
Canadian inflation as of eighteen months ago under a heading calling it the
latest reading. So a spec names several candidate sources and each must prove
its most recent observation is recent enough for its own frequency before it is
used; Canadian CPI now comes from StatCan, which is both the authority and
current. Whichever source actually won is recorded in the feed, so a page cites
what it really charted.

Run `node scripts/macro-series.test.mjs` to exercise the parsing, both
transforms, the thinning and the freshness gate. A series that fails entirely
keeps the previous run's file rather than disappearing from the page.


## Why the macro series refresh four times a day

Because once a day was landing in the wrong place, and the evidence says so.
Over 53 scheduled runs the daily job fired between 13:35 and 21:16 UTC with a
median of 15:21. The Federal Reserve's H.15, which is where FRED's Treasury
yields come from, publishes around 4:15pm Eastern — 20:15 to 21:15 UTC. Fifty-
one of those 53 runs therefore happened before the day's yields existed, and
the curve on the dashboard was structurally a day behind. CPI and the
unemployment rate, out at 8:30am Eastern, were being caught, but only because
the earliest fire was 13:35.

Aiming better is not available. GitHub runs scheduled jobs hours late and at a
drifting hour, so no cron line reliably lands just after a release. More
attempts is the answer instead: 02:00, 09:00, 15:00 and 22:00 UTC, which
between them straddle both the morning releases and H.15 however far any one
of them slips.

Four fixed entries rather than an interval, deliberately. A `*/10` schedule in
this repository produced 13 runs in 72 hours against the ~1,300 it asked for —
GitHub sheds frequent schedules under load — while the daily entries have fired
53 times out of 53. Four low-frequency entries behave like the ones that work.

With four schedules now writing to `data/` alongside a price job that writes
every ten minutes, every workflow's commit step rebases and retries rather than
letting a lost push drop a refresh silently.
