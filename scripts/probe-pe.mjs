/* Second pass: what the multpl table actually looks like, so the parser is
   written against the real shape rather than an assumed one. */
const url = 'https://www.multpl.com/s-p-500-pe-ratio/table/by-month';
const res = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
});
const html = await res.text();
console.log('status', res.status, html.length, 'bytes');

const at = html.indexOf('<table');
console.log('\n--- first 1400 chars from <table ---');
console.log(html.slice(at, at + 1400));

const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
console.log(`\n--- ${rows.length} <tr> rows; first five, tags stripped ---`);
for (const r of rows.slice(0, 5)) {
  const cells = [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
    .map(c => c[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  console.log('  ', JSON.stringify(cells));
}
console.log('\n--- last two rows ---');
for (const r of rows.slice(-2)) {
  const cells = [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
    .map(c => c[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  console.log('  ', JSON.stringify(cells));
}
