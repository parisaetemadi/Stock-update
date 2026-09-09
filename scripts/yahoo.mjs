// Shared Yahoo chart helpers.
//
// Both feeds derive a daily change from the same endpoint, and both had their
// own copy of the calculation — so a bug in it was a bug in two places.

// The prior session's close.
//
// This used to filter the nulls out of the daily closes and take the
// second-to-last. Filtering destroys what position means: while a session is
// live Yahoo carries a bar for today whose close is still null, so dropping it
// made "second to last" the day before yesterday, and a one-day move was
// reported as a two-day one. AMCR showed +10% on a day it was up 3%.
//
// Walk the series by index instead, keyed on which session each bar belongs
// to, so a missing close is skipped without shifting the day being read.
// meta.chartPreviousClose is no substitute: at range=5d it is the close
// *before the window*, about a week back.
export function previousClose(result) {
  const meta = result?.meta || {};
  const stamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const offset = typeof meta.gmtoffset === 'number' ? meta.gmtoffset : 0;
  const sessionDay = t => Math.floor((t + offset) / 86400);

  const nowStamp = typeof meta.regularMarketTime === 'number'
    ? meta.regularMarketTime
    : stamps[stamps.length - 1];
  if (nowStamp == null) return meta.chartPreviousClose ?? meta.previousClose ?? null;

  const today = sessionDay(nowStamp);
  for (let i = stamps.length - 1; i >= 0; i--) {
    if (sessionDay(stamps[i]) >= today) continue;
    if (closes[i] != null) return closes[i];
  }
  return meta.chartPreviousClose ?? meta.previousClose ?? null;
}
