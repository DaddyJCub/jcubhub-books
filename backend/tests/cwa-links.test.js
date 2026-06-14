'use strict';

// Unit tests for CWA (Calibre-Web) link parsing/normalization. Pure (no DB), so these
// run under `npm test` even where the native better-sqlite3 build is unavailable.

const { test, before } = require('node:test');
const assert = require('node:assert');

before(() => { process.env.CWA_URL = 'https://cwa.jcubhub.com'; });

const m = require('../services/cwa-links');

test('normalizeCwaBookLink maps every CWA link shape to /book/<id>', () => {
  const cases = {
    '/book/153': 'https://cwa.jcubhub.com/book/153',
    '/opds/book/153': 'https://cwa.jcubhub.com/book/153',
    '/opds/download/153/epub/Andy%20Weir/Project%20Hail%20Mary.epub': 'https://cwa.jcubhub.com/book/153',
    '/opds/cover/153': 'https://cwa.jcubhub.com/book/153',
    '/get/EPUB/153/Calibre_Library': 'https://cwa.jcubhub.com/book/153'
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.strictEqual(m.normalizeCwaBookLink(input), expected, `for ${input}`);
  }
});

test('a search URL is not treated as a direct book link', () => {
  const search = m.buildCwaSearchLink('Project Hail Mary', 'Andy Weir');
  assert.match(search, /\/search\/stored\/\?query=/);
  assert.ok(!/\/book\/[^/?#]+/i.test(search), 'search URL must not look like a /book link');
});

test('parser prefers the id-bearing link over the cover image (regression)', () => {
  // Representative Calibre-Web acquisition entry: cover link first, download link second.
  const xml = `<feed><entry>
    <title>Project Hail Mary</title>
    <author><name>Andy Weir</name></author>
    <link rel="http://opds-spec.org/image" href="/opds/cover/153" type="image/jpeg"/>
    <link rel="http://opds-spec.org/acquisition" href="/opds/download/153/epub/x.epub" type="application/epub+zip"/>
  </entry></feed>`;
  const entries = m.parseCwaOpdsEntries(xml);
  assert.strictEqual(entries.length, 1);
  const best = m.chooseBestCwaEntry(entries, 'Project Hail Mary', 'Andy Weir');
  assert.ok(best, 'entry should match');
  const resolved = m.normalizeCwaBookLink(best.bookHref);
  assert.strictEqual(resolved, 'https://cwa.jcubhub.com/book/153');
});

test('non-matching title yields no confident entry', () => {
  const xml = `<feed><entry>
    <title>Some Other Book</title>
    <author><name>Nobody</name></author>
    <link rel="http://opds-spec.org/acquisition" href="/opds/download/9/epub/x.epub" type="application/epub+zip"/>
  </entry></feed>`;
  const entries = m.parseCwaOpdsEntries(xml);
  const best = m.chooseBestCwaEntry(entries, 'Project Hail Mary', 'Andy Weir');
  assert.strictEqual(best, null);
});
