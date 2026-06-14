// Book metadata provider client + normalization layer.
//
// Normalizes search results from configured providers (primary: Open Library;
// optional fallback: Google Books) into canonical candidate objects:
//   { source, sourceId, title, authors[], isbn10, isbn13, publishedYear, publisher, summary, coverUrl }
//
// All free-text fields (title, authors, publisher, summary) are sanitized here so
// callers never persist or render raw third-party HTML (SEC-005).

const DEFAULT_OPEN_LIBRARY_URL = 'https://openlibrary.org';
const DEFAULT_GOOGLE_BOOKS_URL = 'https://www.googleapis.com/books/v1';

function stripHtml(value) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, ' ')      // drop tags
    .replace(/&[a-z]+;/gi, ' ')    // drop named entities
    .replace(/[<>]/g, '')          // drop stray angle brackets
    .replace(/\s+/g, ' ')
    .trim();
}

// Public sanitizer: collapse whitespace, strip markup, clamp length.
function sanitizeText(value, maxLength = 4000) {
  const cleaned = stripHtml(value);
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength).trim()}…` : cleaned;
}

function digitsOnlyIsbn(value) {
  const raw = String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (raw.length === 10 || raw.length === 13) return raw;
  return null;
}

function pickYear(value) {
  const match = String(value || '').match(/(\d{4})/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  return year >= 0 && year <= 3000 ? year : null;
}

// Only allow http/https cover URLs (avoids javascript:/data: injection via metadata).
function safeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeCandidate(partial) {
  const isbn10 = digitsOnlyIsbn(partial.isbn10) && String(digitsOnlyIsbn(partial.isbn10)).length === 10
    ? digitsOnlyIsbn(partial.isbn10)
    : null;
  const isbn13 = digitsOnlyIsbn(partial.isbn13) && String(digitsOnlyIsbn(partial.isbn13)).length === 13
    ? digitsOnlyIsbn(partial.isbn13)
    : null;

  const authors = Array.isArray(partial.authors)
    ? partial.authors.map(a => sanitizeText(a, 200)).filter(Boolean)
    : [];

  return {
    source: partial.source || null,
    sourceId: partial.sourceId ? String(partial.sourceId) : null,
    title: sanitizeText(partial.title, 500),
    authors,
    isbn10,
    isbn13,
    publishedYear: pickYear(partial.publishedYear),
    publisher: sanitizeText(partial.publisher, 300) || null,
    summary: sanitizeText(partial.summary, 4000) || null,
    coverUrl: safeUrl(partial.coverUrl)
  };
}

async function fetchJson(url, { timeoutMs = 8000, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: controller.signal });
    if (!response.ok) {
      return { ok: false, status: response.status, data: null };
    }
    const data = await response.json();
    return { ok: true, status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

function mapOpenLibraryDoc(doc, baseUrl) {
  const isbns = Array.isArray(doc.isbn) ? doc.isbn : [];
  const isbn13 = isbns.find(v => digitsOnlyIsbn(v) && String(digitsOnlyIsbn(v)).length === 13) || null;
  const isbn10 = isbns.find(v => digitsOnlyIsbn(v) && String(digitsOnlyIsbn(v)).length === 10) || null;
  let coverUrl = null;
  if (doc.cover_i) {
    coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`;
  } else if (isbn13 || isbn10) {
    coverUrl = `https://covers.openlibrary.org/b/isbn/${isbn13 || isbn10}-M.jpg`;
  }

  return normalizeCandidate({
    source: 'openlibrary',
    sourceId: doc.key || (doc.cover_edition_key ? `/books/${doc.cover_edition_key}` : null),
    title: doc.title,
    authors: doc.author_name || [],
    isbn10,
    isbn13,
    publishedYear: doc.first_publish_year,
    publisher: Array.isArray(doc.publisher) ? doc.publisher[0] : doc.publisher,
    summary: typeof doc.first_sentence === 'string'
      ? doc.first_sentence
      : (Array.isArray(doc.first_sentence) ? doc.first_sentence[0] : ''),
    coverUrl
  });
}

async function searchOpenLibrary(query, limit, config) {
  const base = config.openLibraryUrl || DEFAULT_OPEN_LIBRARY_URL;
  const url = new URL('/search.json', base);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', 'key,title,author_name,first_publish_year,isbn,cover_i,cover_edition_key,publisher,first_sentence');

  const { ok, data } = await fetchJson(url.toString(), { timeoutMs: config.searchTimeoutMs });
  if (!ok || !data || !Array.isArray(data.docs)) return [];
  return data.docs.slice(0, limit).map(doc => mapOpenLibraryDoc(doc, base));
}

function mapGoogleVolume(volume) {
  const info = volume.volumeInfo || {};
  const ids = Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers : [];
  const isbn13 = ids.find(i => i.type === 'ISBN_13')?.identifier || null;
  const isbn10 = ids.find(i => i.type === 'ISBN_10')?.identifier || null;
  const coverUrl = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || null;

  return normalizeCandidate({
    source: 'googlebooks',
    sourceId: volume.id,
    title: info.title,
    authors: info.authors || [],
    isbn10,
    isbn13,
    publishedYear: info.publishedDate,
    publisher: info.publisher,
    summary: info.description,
    // Google cover thumbnails come back as http; upgrade to https for CSP/mixed-content safety.
    coverUrl: coverUrl ? coverUrl.replace(/^http:/, 'https:') : null
  });
}

async function searchGoogleBooks(query, limit, config) {
  const base = config.googleBooksUrl || DEFAULT_GOOGLE_BOOKS_URL;
  const url = new URL('/volumes', base);
  url.searchParams.set('q', query);
  url.searchParams.set('maxResults', String(Math.min(limit, 40)));
  if (config.googleBooksKey) url.searchParams.set('key', config.googleBooksKey);

  const { ok, data } = await fetchJson(url.toString(), { timeoutMs: config.searchTimeoutMs });
  if (!ok || !data || !Array.isArray(data.items)) return [];
  return data.items.slice(0, limit).map(mapGoogleVolume);
}

// Search the configured provider, then fall back to the secondary if the primary
// returns nothing. Returns normalized candidates. Throws only on total failure.
async function searchBookMetadata(query, { limit = 10, config = {}, logger = null } = {}) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  const cappedLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 25));
  const primary = (config.primary || 'openlibrary').toLowerCase();

  const runProvider = async (name) => {
    try {
      if (name === 'googlebooks') return await searchGoogleBooks(cleanQuery, cappedLimit, config);
      return await searchOpenLibrary(cleanQuery, cappedLimit, config);
    } catch (error) {
      if (logger) logger.warn('Metadata provider failed', { provider: name, error: error.message });
      return [];
    }
  };

  let results = await runProvider(primary);
  if (results.length === 0) {
    const fallback = primary === 'openlibrary' ? 'googlebooks' : 'openlibrary';
    // Only try Google Books fallback when it is usable without a key, or a key is set.
    if (fallback === 'openlibrary' || config.googleBooksKey || fallback === 'googlebooks') {
      results = await runProvider(fallback);
    }
  }

  // De-dupe by sourceId/title and drop entries with no title.
  const seen = new Set();
  return results.filter(candidate => {
    if (!candidate.title) return false;
    const key = candidate.sourceId || `${candidate.title}|${candidate.authors.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  searchBookMetadata,
  normalizeCandidate,
  sanitizeText,
  safeUrl,
  digitsOnlyIsbn,
  pickYear
};
