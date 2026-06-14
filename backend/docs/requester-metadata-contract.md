# Requester Metadata Contract

Defines the metadata search/normalization API used by the requester request form and
dashboard. Implemented by `backend/services/book-metadata.js` and the
`GET /api/metadata/search` endpoint in `backend/server.js`.

## Endpoint

### `GET /api/metadata/search?q=<query>&limit=<n>`

| Param | Rules |
| ----- | ----- |
| `q` | Required, minimum 2 characters. Below that → `400`. |
| `limit` | Optional, default 10, clamped to `[1, 25]`. |

Response:
```json
{
  "query": "the hobbit",
  "cached": false,
  "results": [ { /* normalized candidate */ } ]
}
```
- Rate limited per IP (30 / minute).
- Provider failure → `502 { "error": "Metadata provider unavailable", "results": [] }`.

## Normalized candidate shape

Every result is normalized to exactly these fields (nullable where unknown):

```json
{
  "source": "openlibrary | googlebooks",
  "sourceId": "stable provider id (string) | null",
  "title": "string",
  "authors": ["string", "..."],
  "isbn10": "10-char ISBN | null",
  "isbn13": "13-char ISBN | null",
  "publishedYear": 1937,
  "publisher": "string | null",
  "summary": "string | null",
  "coverUrl": "https URL | null"
}
```

### Field normalization rules

- **title / authors / publisher / summary**: HTML-stripped, entity-stripped, whitespace
  collapsed, length-clamped (`title` 500, `authors[i]` 200, `publisher` 300, `summary` 4000).
- **isbn10 / isbn13**: digits/`X` only; kept only if length is exactly 10 / 13 respectively.
- **publishedYear**: first 4-digit run in the date, range `[0, 3000]`, else `null`.
- **coverUrl**: only `http(s)` URLs survive (`javascript:`/`data:` rejected); Google
  thumbnails are upgraded to `https` to avoid mixed-content.

## Provider precedence

Controlled by `METADATA_PROVIDER` (default `openlibrary`).

1. Run the primary provider.
2. If it yields **zero** results, run the fallback (`openlibrary ↔ googlebooks`).
   Google Books is used as fallback only when usable (no key required, or
   `GOOGLE_BOOKS_API_KEY` set).
3. De-dupe by `sourceId` (fallback: `title|authors`), drop entries with no title.

| Env var | Default | Purpose |
| ------- | ------- | ------- |
| `METADATA_PROVIDER` | `openlibrary` | Primary provider |
| `OPENLIBRARY_URL` | `https://openlibrary.org` | Open Library base |
| `GOOGLE_BOOKS_API_KEY` | _(unset)_ | Optional Google Books key |
| `GOOGLE_BOOKS_URL` | `https://www.googleapis.com/books/v1` | Google Books base |
| `METADATA_CACHE_TTL_MS` | `86400000` (24 h) | Cache TTL |
| `METADATA_HTTP_TIMEOUT_MS` | `8000` | Per-request timeout |

## Sanitization requirements (SEC-005)

- All free-text fields are sanitized in the service before they ever leave the module,
  and again on persistence in `POST /api/book-request` (`bookMetadata.sanitizeText`,
  `safeUrl`). Cover URLs are validated with `safeUrl`.
- The dashboard renders all values through client-side `escapeHtml`; covers fall back to
  a placeholder via `onerror`.
- CSP already allows `img-src https:`; cover hosts (`covers.openlibrary.org`,
  `books.google.com`) are permitted (RISK-006, DEP-006).

## Caching (TASK-023)

`book_metadata_cache(query_hash, query, payload, created_at, expires_at)`.
- Key = `sha256("<provider>:<limit>:<lower(query)>")`.
- Hits within TTL return `"cached": true` and avoid external calls.
- Expired rows are purged by the hourly `cleanupRequesterAuthArtifacts()` job.

## Persisted request metadata

`POST /api/book-request` accepts optional, sanitized fields persisted onto `requests`:
`metadata_source`, `metadata_source_id`, `cover_url`, `summary`, `publisher`,
`published_year`, `isbn10`, `isbn13`. These are surfaced back in the dashboard payload
under each item's `metadata` object.
