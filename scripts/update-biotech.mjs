import { writeFile, mkdir } from 'node:fs/promises';

const SOURCES = [
  { id: 'fierce', name: 'Fierce Biotech', rss: 'https://www.fiercebiotech.com/rss/xml' },
  { id: 'endpoints', name: 'Endpoints News', rss: 'https://endpts.com/feed/' },
  { id: 'statnews', name: 'STAT News (Biotech)', rss: 'https://www.statnews.com/category/biotech/feed/' },
  { id: 'biopharmadive', name: 'BioPharma Dive', rss: 'https://www.biopharmadive.com/feeds/news/' }
];

const ITEMS_PER_SOURCE = 8;

function stripCdata(str = '') {
  return str.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

function stripTags(str = '') {
  return str.replace(/<[^>]+>/g, '').trim();
}

function decodeEntities(str = '') {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeEntities(stripTags(stripCdata(match[1]))) : '';
}

// Not every feed emits a standard RFC822 pubDate — Fierce Biotech's is like
// "Aug 24, 2026 10:19am" with no space before am/pm, which JS's Date parser
// silently rejects. Normalize to ISO where possible; keep the raw string
// (rather than dropping the date) if it still can't be parsed.
function normalizePubDate(raw) {
  if (!raw) return raw;
  const spaced = raw.replace(/(\d)(am|pm)\b/i, '$1 $2');
  const d = new Date(spaced);
  return isNaN(d.getTime()) ? raw : d.toISOString();
}

function parseRss(xml) {
  const items = [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
  return items.slice(0, ITEMS_PER_SOURCE).map(block => ({
    title: extractTag(block, 'title'),
    link: extractTag(block, 'link'),
    pubDate: normalizePubDate(extractTag(block, 'pubDate') || extractTag(block, 'dc:date')),
    description: extractTag(block, 'description').slice(0, 240)
  })).filter(item => item.title && item.link);
}

async function fetchSource(src) {
  const res = await fetch(src.rss, {
    headers: { 'User-Agent': 'Mozilla/5.0 (dashboard-cron; +personal use)', Accept: 'application/rss+xml, text/xml' }
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const xml = await res.text();
  const items = parseRss(xml);
  if (items.length === 0) throw new Error('no items parsed');
  return items;
}

async function main() {
  const generatedAt = new Date().toISOString();
  const sources = {};

  for (const src of SOURCES) {
    try {
      sources[src.id] = { name: src.name, items: await fetchSource(src) };
    } catch (err) {
      console.error(`[biotech] ${src.name}: ${err.message}`);
      sources[src.id] = { name: src.name, items: [], error: err.message };
    }
  }

  await mkdir('data', { recursive: true });
  await writeFile('data/biotech.json', JSON.stringify({ generatedAt, sources }, null, 2) + '\n');
  const total = Object.values(sources).reduce((n, s) => n + s.items.length, 0);
  console.log(`Wrote data/biotech.json with ${total} items across ${SOURCES.length} sources.`);
}

main().catch(err => { console.error(err); process.exit(1); });
