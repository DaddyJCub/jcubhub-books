#!/usr/bin/env node
'use strict';

// Standalone CWA link diagnostic — read-only (OPDS GET only; never adds/changes anything).
//
// Verifies that, for a given title, your CWA OPDS feed yields a DIRECT /book/<id> link
// rather than a /search/stored/?query= URL. Uses the SAME parsing/normalization module
// as the live server (services/cwa-links.js), so a pass here means the shipped code works
// against YOUR instance.
//
// Usage (inside the app container):
//   docker compose exec jcubhub-books node scripts/cwa-link-check.js "Project Hail Mary"
//   docker compose exec jcubhub-books node scripts/cwa-link-check.js "Project Hail Mary" "Andy Weir"
//
// Reads CWA_URL / CWA_USERNAME / CWA_PASSWORD from the environment (already set in the container).

const {
  getCwaBaseUrl,
  buildCwaSearchLink,
  normalizeCwaBookLink,
  chooseBestCwaEntry,
  parseCwaOpdsEntries,
  buildCwaOpdsSearchUrls
} = require('../services/cwa-links');

const title = process.argv[2];
const author = process.argv[3] || '';

if (!title) {
  console.error('Usage: node scripts/cwa-link-check.js "<book title>" ["<author>"]');
  process.exit(2);
}

const cwaBase = getCwaBaseUrl();
if (!cwaBase) {
  console.error('CWA_URL is not set — cannot run diagnostic.');
  process.exit(2);
}
if (!process.env.CWA_USERNAME || !process.env.CWA_PASSWORD) {
  console.error('CWA_USERNAME / CWA_PASSWORD are not set — cannot authenticate to OPDS.');
  process.exit(2);
}

const credentials = Buffer.from(`${process.env.CWA_USERNAME}:${process.env.CWA_PASSWORD}`).toString('base64');
const headers = {
  Authorization: `Basic ${credentials}`,
  Accept: 'application/atom+xml, application/xml, text/xml, */*'
};

function line() { console.log('-'.repeat(70)); }

async function fetchOpds(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log(`CWA base : ${cwaBase}`);
  console.log(`Query    : "${title}"${author ? ` / "${author}"` : ''}`);
  line();

  const searchTerms = Array.from(new Set([
    [title, author].filter(Boolean).join(' ').trim(),
    title.trim()
  ].filter(Boolean)));

  let matched = null;
  let allEntries = [];

  for (const term of searchTerms) {
    const urls = buildCwaOpdsSearchUrls(cwaBase, term);
    for (const url of urls) {
      let resp;
      try {
        resp = await fetchOpds(url);
      } catch (e) {
        console.log(`[skip]  ${url}\n        request failed: ${e.message}`);
        continue;
      }
      if (!resp.ok || !/(<feed\b|<entry\b)/i.test(resp.text)) {
        console.log(`[skip]  ${url}\n        status ${resp.status}, no feed/entry in body`);
        continue;
      }
      const entries = parseCwaOpdsEntries(resp.text);
      console.log(`[ok]    ${url}\n        ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} parsed`);
      if (entries.length && !allEntries.length) allEntries = entries;
      const best = chooseBestCwaEntry(entries, title, author);
      if (best) { matched = best; break; }
    }
    if (matched) break;
  }

  line();
  // Dump the raw links of the top few entries so the actual link shapes are visible.
  const sample = (matched ? [matched] : allEntries).slice(0, 3);
  if (!sample.length) {
    console.log('No entries returned by OPDS for this query.');
  }
  for (const entry of sample) {
    console.log(`Entry: "${entry.title}" — ${entry.author || '(no author)'}`);
    for (const l of (entry.links || [])) {
      console.log(`   link rel="${l.rel}" type="${l.type}"`);
      console.log(`        href = ${l.href}`);
      console.log(`        ->   ${normalizeCwaBookLink(l.href) || '(not a book link)'}`);
    }
    console.log(`   chosen bookHref = ${entry.bookHref || '(none)'}`);
    console.log(`   resolves to     = ${normalizeCwaBookLink(entry.bookHref) || '(none)'}`);
    line();
  }

  // Final verdict — this is exactly what resolveCwaLinkForRequest would return.
  const resolved = matched
    ? (normalizeCwaBookLink(matched.bookHref) || buildCwaSearchLink(title, author))
    : buildCwaSearchLink(title, author);
  const isDirect = !!resolved && /\/book\/[^/?#]+/i.test(resolved);

  console.log(`RESULT: ${resolved}`);
  console.log(isDirect
    ? 'VERDICT: ✅ DIRECT book link — Read/Download will open the book.'
    : 'VERDICT: ⚠️ search link (no confident direct match). See link dump above for the shapes your CWA emits.');
  process.exit(isDirect ? 0 : 1);
})().catch(err => {
  console.error('Diagnostic error:', err.message);
  process.exit(2);
});
