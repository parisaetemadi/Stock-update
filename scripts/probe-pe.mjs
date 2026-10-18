/* Throwaway: finds out which S&P 500 earnings source is actually reachable and
   parseable from a runner. There is no P/E series on FRED, and the candidates
   differ a lot in how much work they are, so this answers that before anything
   is built on one. Deleted once the answer is known. */

const CANDIDATES = [
  ['Shiller ie_data.xls (Yale)', 'https://www.econ.yale.edu/~shiller/data/ie_data.xls'],
  ['Shiller ie_data.xls (http)', 'http://www.econ.yale.edu/~shiller/data/ie_data.xls'],
  ['multpl P/E by month', 'https://www.multpl.com/s-p-500-pe-ratio/table/by-month'],
  ['multpl earnings by month', 'https://www.multpl.com/s-p-500-earnings/table/by-month'],
  ['FRED SP500 index', 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500'],
  ['Nasdaq Data Link MULTPL (no key)', 'https://data.nasdaq.com/api/v3/datasets/MULTPL/SP500_PE_RATIO_MONTH.csv']
];

for (const [name, url] of CANDIDATES) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: '*/*'
      },
      redirect: 'follow'
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const head = buf.subarray(0, 120).toString('latin1').replace(/[\r\n]+/g, ' ⏎ ');
    console.log(`\n=== ${name}`);
    console.log(`    ${res.status} ${res.headers.get('content-type') || '?'} ${buf.length} bytes`);
    console.log(`    head: ${head}`);
    // An .xls is a CFB container ("\xD0\xCF\x11\xE0"); .xlsx is a zip ("PK").
    if (buf[0] === 0xD0 && buf[1] === 0xCF) console.log('    -> legacy .xls (CFB container)');
    if (buf[0] === 0x50 && buf[1] === 0x4B) console.log('    -> zip container (xlsx)');
    if (/^\s*(date|year|month)/i.test(head)) console.log('    -> looks like CSV with a header');
  } catch (err) {
    console.log(`\n=== ${name}\n    FAILED: ${err.message}`);
  }
}
