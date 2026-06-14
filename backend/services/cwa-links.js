// CWA (Calibre-Web) link parsing + normalization.
//
// Extracted from server.js so the same logic is shared by the live availability check
// AND the standalone diagnostic (scripts/cwa-link-check.js) — guaranteeing what we test
// is exactly what ships. These functions are pure: they read process.env.CWA_URL via
// getCwaBaseUrl() and otherwise depend only on their inputs (no DB, no logger).

function getCwaBaseUrl() {
  const raw = String(process.env.CWA_URL || '').trim();
  if (!raw) return null;

  const trimmed = raw.replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/opds$/i, '') || '/';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/opds$/i, '');
  }
}

function buildCwaSearchLink(bookTitle, author = '') {
  const cwaBase = getCwaBaseUrl();
  if (!cwaBase) return null;

  // Title-only queries are significantly more reliable in many CWA instances.
  // Keep the author argument for call-site compatibility but do not include it
  // in the fallback search URL.
  const titleQuery = String(bookTitle || '').trim();
  const queryText = titleQuery || String(author || '').trim();
  if (!queryText) return cwaBase;

  try {
    const searchUrl = new URL('/search/stored/', cwaBase);
    searchUrl.searchParams.set('query', queryText);
    return searchUrl.toString();
  } catch {
    return `${cwaBase}/search/stored/?query=${encodeURIComponent(queryText)}`;
  }
}

function normalizeCwaBookLink(rawLink) {
  if (!rawLink) return null;
  const cwaBase = getCwaBaseUrl();
  if (!cwaBase) return null;

  const extractBookPath = pathname => {
    const directBook = pathname.match(/\/book\/([^\/?#]+)\/?$/i)?.[1];
    if (directBook) return `/book/${directBook}`;

    const opdsBook = pathname.match(/\/opds\/(?:book|books)\/([^\/?#]+)\/?$/i)?.[1];
    if (opdsBook) return `/book/${opdsBook}`;

    // Acquisition/download links carry the book id: /opds/download/<id>/<fmt>/...
    const opdsDownload = pathname.match(/\/opds\/download\/([^\/?#]+)\//i)?.[1];
    if (opdsDownload) return `/book/${opdsDownload}`;

    // Cover/thumbnail links also carry the id: /opds/cover/<id>
    const opdsCover = pathname.match(/\/opds\/cover\/([^\/?#]+)\/?$/i)?.[1];
    if (opdsCover) return `/book/${opdsCover}`;

    // Calibre-Web direct download: /get/<fmt>/<id>/<library>
    const getDownload = pathname.match(/\/get\/[^\/]+\/([^\/?#]+)(?:\/|$)/i)?.[1];
    if (getDownload) return `/book/${getDownload}`;

    return null;
  };

  try {
    const absolute = new URL(rawLink, cwaBase);
    const mappedBookPath = extractBookPath(absolute.pathname);
    if (mappedBookPath) {
      return new URL(mappedBookPath, cwaBase).toString();
    }

    if (absolute.pathname.startsWith('/opds/')) {
      return null;
    }

    return absolute.toString();
  } catch {
    if (String(rawLink).startsWith('/')) return `${cwaBase}${rawLink}`;
    return `${cwaBase}/${rawLink}`;
  }
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCwaOpdsEntries(xml) {
  const entries = [];
  const entryRegex = /<entry\b[\s\S]*?<\/entry>/gi;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[0];
    const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '')
      .replace(/<[^>]+>/g, '')
      .trim();
    const author = (block.match(/<author>[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i)?.[1] || '')
      .replace(/<[^>]+>/g, '')
      .trim();
    const links = [];
    const linkRegex = /<link\b([^>]+)>/gi;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(block)) !== null) {
      const attrs = linkMatch[1];
      const href = attrs.match(/\bhref="([^"]+)"/i)?.[1] || null;
      const rel = attrs.match(/\brel="([^"]+)"/i)?.[1] || '';
      const type = attrs.match(/\btype="([^"]+)"/i)?.[1] || '';

      if (href) {
        links.push({ href, rel: rel.toLowerCase(), type: type.toLowerCase() });
      }
    }

    // Prefer any link that resolves to a concrete /book/<id> (direct book link, OPDS
    // book link, or — crucially — the acquisition/cover link that carries the id). The
    // old "first non-download link" rule grabbed the cover image link, which has no id,
    // so the book id was lost and callers fell back to a search URL.
    const mapsToBook = link => {
      const norm = normalizeCwaBookLink(link.href);
      return !!norm && /\/book\/[^\/?#]+$/i.test(norm);
    };
    const preferred =
      links.find(link => /\/book\/[^\/?#]+/i.test(link.href)) ||
      links.find(link => /\/opds\/(?:book|books)\/[^\/?#]+/i.test(link.href)) ||
      links.find(link => link.rel.includes('alternate') && link.type.includes('html')) ||
      links.find(mapsToBook) ||
      links.find(link => link.rel.includes('alternate')) ||
      links[0] ||
      null;

    entries.push({
      title,
      author,
      bookHref: preferred?.href || null,
      links
    });
  }

  return entries;
}

function chooseBestCwaEntry(entries, bookTitle, author) {
  if (!entries.length) return null;

  const targetTitle = normalizeForMatch(bookTitle);
  const targetAuthor = normalizeForMatch(author);

  const scored = entries.map(entry => {
    const entryTitle = normalizeForMatch(entry.title);
    const entryAuthor = normalizeForMatch(entry.author);
    let score = 0;

    if (entryTitle && targetTitle) {
      if (entryTitle === targetTitle) score += 100;
      else if (entryTitle.startsWith(targetTitle)) score += 50;
      else if (entryTitle.includes(targetTitle) || targetTitle.includes(entryTitle)) score += 25;
    }

    if (entryAuthor && targetAuthor) {
      if (entryAuthor === targetAuthor) score += 40;
      else if (entryAuthor.includes(targetAuthor) || targetAuthor.includes(entryAuthor)) score += 20;
    }

    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].entry : null;
}

function buildCwaOpdsSearchUrls(cwaBase, searchTerm) {
  const term = String(searchTerm || '').trim();
  if (!term) return [];

  const urls = [];

  try {
    const queryUrl = new URL('/opds/search', cwaBase);
    queryUrl.searchParams.set('query', term);
    urls.push(queryUrl.toString());
  } catch {
    // Ignore malformed URL and allow fallback pattern below.
  }

  try {
    const pathUrl = new URL(`/opds/search/${encodeURIComponent(term)}`, cwaBase);
    urls.push(pathUrl.toString());
  } catch {
    // Ignore malformed URL and return whatever succeeded.
  }

  return Array.from(new Set(urls));
}

module.exports = {
  getCwaBaseUrl,
  buildCwaSearchLink,
  normalizeCwaBookLink,
  normalizeForMatch,
  parseCwaOpdsEntries,
  chooseBestCwaEntry,
  buildCwaOpdsSearchUrls
};
