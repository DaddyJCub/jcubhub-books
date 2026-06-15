'use strict';
// Native books API (contract: docs/native-platform/contracts/books.openapi.yaml).
// Bearer-only, capability-gated, scoped to the caller's email. Mirrors the
// requester dashboard + request form so the JCubHub Apps native module has full
// parity (metadata search, rich request items, status timeline).
//
// Mounted at /api/native/books in server.js. Reuses the existing SQLite `db`,
// id/status-token generators, subscriber + dashboard-item helpers, and the
// cached metadata search.

const express = require('express');
const { requireBrokerAuth, requireCapability } = require('../middleware/native-auth');

const CONTRACT = 'books/1.0.0';
const VALID_FORMATS = ['epub', 'pdf', 'mobi', 'audiobook', 'any'];

// In-memory idempotency cache: key -> { requestBody, response, expires }. 10-min TTL.
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const idempotency = new Map();
const exportsOwner = new Map();

function rememberIdempotent(key, requestBody, status, body) {
  idempotency.set(key, { requestBody: JSON.stringify(requestBody || {}), status, body, expires: Date.now() + IDEMPOTENCY_TTL_MS });
}
function getIdempotent(key) {
  const hit = idempotency.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { idempotency.delete(key); return null; }
  return hit;
}

// Opaque cursor = base64 of an integer offset (documented offset-backed paging).
function encodeCursor(offset) { return Buffer.from(String(offset), 'utf8').toString('base64'); }
function decodeCursor(cursor) {
  if (!cursor) return 0;
  const n = parseInt(Buffer.from(String(cursor), 'base64').toString('utf8'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 25;
  return Math.min(n, 100);
}
function errBody(code, message) { return { error: { code, message } }; }
function safeCover(url) {
  if (!url || typeof url !== 'string') return null;
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}
function str(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function createNativeBooksRouter(deps) {
  const {
    db, generateId, generateStatusToken, buildRequesterDashboardItem,
    addSubscriberToRequest, searchMetadata, checkCwaAvailability, buildCwaSearchLink,
    ereaderConfig, resolveOpenLink, sendEreader, recordFeedback, log,
  } = deps;
  const router = express.Router();

  function ownedRequest(id, email) {
    return db.prepare(
      'SELECT * FROM requests WHERE id = ? AND LOWER(requester_email) = LOWER(?)'
    ).get(id, email);
  }
  function isEmail(v) {
    return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
  }

  router.use((req, res, next) => {
    res.set('X-JCubHub-Contract', CONTRACT);
    next();
  });
  router.use(requireBrokerAuth);

  function dashItem(id) {
    const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    return row ? buildRequesterDashboardItem(row) : null;
  }

  function pageDashboard(email, cursor, limit) {
    const offset = decodeCursor(cursor);
    const rows = db.prepare(
      `SELECT * FROM requests WHERE LOWER(requester_email) = LOWER(?)
       ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
    ).all(email, limit + 1, offset);
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map(buildRequesterDashboardItem),
      next_cursor: hasMore ? encodeCursor(offset + limit) : null,
    };
  }

  // GET /dashboard — rich request items (cursor paged), like the requester dashboard.
  router.get('/dashboard', requireCapability('books.read'), (req, res) => {
    const limit = clampLimit(req.query.limit);
    res.json(pageDashboard(req.native.email, req.query.cursor, limit));
  });

  // GET /requests — alias of dashboard (history); rich items for consistency.
  router.get('/requests', requireCapability('books.read'), (req, res) => {
    const limit = clampLimit(req.query.limit);
    res.json(pageDashboard(req.native.email, req.query.cursor, limit));
  });

  // GET /metadata/search?q=&limit= — book metadata search for the request form.
  router.get('/metadata/search', requireCapability('books.read'), async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.status(422).json(errBody('validation_error', 'Query must be at least 2 characters'));
    try {
      const results = await searchMetadata(q, req.query.limit);
      res.json({ query: q, results });
    } catch (err) {
      if (log) log('warn', 'native.books.metadata.error', { error: err.message });
      res.status(502).json(errBody('upstream_unavailable', 'Metadata provider unavailable'));
    }
  });

  // GET /config — module capabilities the UI needs (e.g. send-to-eReader).
  router.get('/config', requireCapability('books.read'), (req, res) => {
    const er = ereaderConfig ? ereaderConfig() : { enabled: false, allowedDomains: [] };
    res.json({ ereader: er });
  });

  // GET /requests/:id/open — resolve the freshest CWA link for an owned request.
  router.get('/requests/:id/open', requireCapability('books.read'), async (req, res) => {
    const request = ownedRequest(req.params.id, req.native.email);
    if (!request) return res.status(404).json(errBody('not_found', 'Request not found'));
    try {
      const url = resolveOpenLink ? await resolveOpenLink(request) : request.cwa_book_link;
      if (!url) return res.status(409).json(errBody('conflict', 'No download link available yet'));
      res.json({ url });
    } catch (err) {
      if (log) log('warn', 'native.books.open.error', { id: request.id, error: err.message });
      res.status(502).json(errBody('upstream_unavailable', 'Could not resolve the book link'));
    }
  });

  // POST /requests/:id/send-ereader — email the book link to an eReader.
  router.post('/requests/:id/send-ereader', requireCapability('books.write'), async (req, res) => {
    const request = ownedRequest(req.params.id, req.native.email);
    if (!request) return res.status(404).json(errBody('not_found', 'Request not found'));
    const ereaderEmail = String((req.body && req.body.ereaderEmail) || '').trim();
    if (!isEmail(ereaderEmail)) return res.status(422).json(errBody('validation_error', 'Valid eReader email is required'));
    if (!sendEreader) return res.status(503).json(errBody('upstream_unavailable', 'Send-to-eReader not available'));
    try {
      const result = await sendEreader(request, ereaderEmail, req.native.email);
      if (!result.ok) {
        return res.status(result.status || 400).json(errBody('conflict', result.error || 'Could not send to eReader'));
      }
      res.json({ success: true, sentTo: ereaderEmail, downloadLink: result.downloadLink });
    } catch (err) {
      if (log) log('warn', 'native.books.ereader.error', { id: request.id, error: err.message });
      res.status(502).json(errBody('upstream_unavailable', 'Could not send to eReader'));
    }
  });

  // POST /requests/:id/feedback — confirm or report the monitored match.
  router.post('/requests/:id/feedback', requireCapability('books.write'), async (req, res) => {
    const request = ownedRequest(req.params.id, req.native.email);
    if (!request) return res.status(404).json(errBody('not_found', 'Request not found'));
    const feedbackType = (req.body && req.body.feedbackType) || '';
    if (!['match_confirmed', 'match_mismatch'].includes(feedbackType)) {
      return res.status(422).json(errBody('validation_error', 'Invalid feedback type'));
    }
    const message = str(req.body && req.body.message, 1000) || '';
    try {
      if (recordFeedback) await recordFeedback(request, feedbackType, message, req.native.email);
      res.json({ success: true });
    } catch (err) {
      if (log) log('warn', 'native.books.feedback.error', { id: request.id, error: err.message });
      res.status(502).json(errBody('internal_error', 'Could not save feedback'));
    }
  });

  // GET /requests/:id/history — status timeline for an owned request.
  router.get('/requests/:id/history', requireCapability('books.read'), (req, res) => {
    const row = db.prepare(
      'SELECT id, status FROM requests WHERE id = ? AND LOWER(requester_email) = LOWER(?)'
    ).get(req.params.id, req.native.email);
    if (!row) return res.status(404).json(errBody('not_found', 'Request not found'));
    const history = db.prepare(
      'SELECT status, changed_at, notes FROM status_history WHERE request_id = ? ORDER BY changed_at DESC'
    ).all(row.id);
    res.json({ id: row.id, status: row.status, history });
  });

  // POST /requests — submit a request with full metadata (idempotent; books.write).
  // Mirrors the public form: blocks if the book is already in the library (CWA),
  // and subscribes (instead of duplicating) if a matching active request exists.
  router.post('/requests', requireCapability('books.write'), async (req, res) => {
    const idemKey = req.get('Idempotency-Key');
    if (!idemKey) return res.status(400).json(errBody('validation_error', 'Idempotency-Key header is required'));

    const replay = getIdempotent(idemKey);
    if (replay) {
      if (replay.requestBody !== JSON.stringify(req.body || {})) {
        return res.status(409).json(errBody('idempotency_replay', 'Idempotency-Key reused with a different body'));
      }
      res.set('X-Idempotency-Replay', 'true');
      return res.status(replay.status).json(replay.body);
    }

    const b = req.body || {};
    const title = str(b.title || b.bookTitle, 500);
    if (!title) return res.status(422).json(errBody('validation_error', 'title is required'));
    const author = str(b.author, 300) || 'Unknown';
    const format = VALID_FORMATS.includes(b.format) ? b.format : 'any';
    const notes = str(b.notes, 2000) || '';
    const isbn = str(b.isbn || b.isbn13 || b.isbn10, 17);
    const email = req.native.email;
    const name = req.native.username || email;
    const notify = b.notifyOnComplete !== false;

    // 1. Already in the library? Block the request and point at the library copy.
    if (checkCwaAvailability) {
      try {
        const cwa = await checkCwaAvailability(title, author, isbn || '');
        if (cwa && cwa.available) {
          const body = {
            alreadyAvailable: true,
            message: 'This book is already available in the library.',
            bookLink: cwa.bookLink || (buildCwaSearchLink ? buildCwaSearchLink(title, author) : null),
          };
          rememberIdempotent(idemKey, req.body, 200, body);
          if (log) log('info', 'native.books.request.already_available', { title, author, email });
          return res.status(200).json(body);
        }
      } catch (e) { /* availability check is best-effort — fall through to create */ }
    }

    // 2. Matching active request already exists? Subscribe instead of duplicating.
    const existing = db.prepare(
      `SELECT * FROM requests
       WHERE status IN ('pending','approved','searching','downloading')
         AND LOWER(TRIM(book_title)) = LOWER(TRIM(?))
         AND LOWER(TRIM(author)) = LOWER(TRIM(?))
       ORDER BY created_at DESC LIMIT 1`
    ).get(title, author);
    if (existing) {
      const isOwner = String(existing.requester_email || '').toLowerCase() === email.toLowerCase();
      const subscribed = db.prepare(
        'SELECT 1 FROM request_subscribers WHERE request_id = ? AND LOWER(subscriber_email) = LOWER(?) LIMIT 1'
      ).get(existing.id, email);
      if (!isOwner && !subscribed && addSubscriberToRequest) {
        try { addSubscriberToRequest(existing.id, name, email, notify); } catch (e) { /* best-effort */ }
      }
      const body = {
        subscribedToExisting: true,
        requestId: existing.id,
        status: existing.status,
        message: isOwner || subscribed
          ? 'You already have a request for this book.'
          : 'A matching request already exists — you have been subscribed for updates.',
        item: buildRequesterDashboardItem(existing),
      };
      rememberIdempotent(idemKey, req.body, 200, body);
      if (log) log('info', 'native.books.request.subscribed_existing', { id: existing.id, email });
      return res.status(200).json(body);
    }

    // 3. Create.
    const meta = {
      source: str(b.source, 50),
      sourceId: str(b.sourceId, 300),
      coverUrl: safeCover(b.coverUrl),
      summary: str(b.summary, 6000),
      publisher: str(b.publisher, 300),
      publishedYear: Number.isFinite(parseInt(b.publishedYear, 10)) ? parseInt(b.publishedYear, 10) : null,
      isbn10: str(b.isbn10, 13),
      isbn13: str(b.isbn13, 17),
    };
    const now = new Date().toISOString();
    const id = generateId();
    const statusToken = generateStatusToken ? generateStatusToken() : null;

    db.prepare(
      `INSERT INTO requests (
        id, requester_name, requester_email, book_title, author, isbn, format, notes, status,
        notify_on_complete, status_token, cwa_available, created_at, updated_at,
        metadata_source, metadata_source_id, cover_url, summary, publisher, published_year, isbn10, isbn13
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, name, email, title, author, isbn, format, notes,
      notify ? 1 : 0, statusToken, now, now,
      meta.source, meta.sourceId, meta.coverUrl, meta.summary, meta.publisher, meta.publishedYear, meta.isbn10, meta.isbn13,
    );

    try {
      if (addSubscriberToRequest) addSubscriberToRequest(id, name, email, notify);
    } catch (e) { /* subscriber is best-effort */ }
    try {
      db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)')
        .run(id, 'pending', now, 'Created via native app');
    } catch (e) { /* history is best-effort */ }

    const item = dashItem(id);
    rememberIdempotent(idemKey, req.body, 201, item);
    if (log) log('info', 'native.books.request.created', { id, email });
    res.status(201).json(item);
  });

  // POST /exports — synchronous CSV export job (idempotent).
  router.post('/exports', requireCapability('books.read'), (req, res) => {
    const idemKey = req.get('Idempotency-Key');
    if (!idemKey) return res.status(400).json(errBody('validation_error', 'Idempotency-Key header is required'));
    const replay = getIdempotent(idemKey);
    if (replay) { res.set('X-Idempotency-Replay', 'true'); return res.status(replay.status).json(replay.body); }

    const id = generateId();
    const response = { id, status: 'ready', download_url: `/api/native/books/exports/${id}/download` };
    exportsOwner.set(id, { email: req.native.email, expires: Date.now() + IDEMPOTENCY_TTL_MS });
    rememberIdempotent(idemKey, req.body, 202, response);
    res.status(202).json(response);
  });

  router.get('/exports/:id', requireCapability('books.read'), (req, res) => {
    const owner = exportsOwner.get(req.params.id);
    if (!owner || owner.email !== req.native.email) return res.status(404).json(errBody('not_found', 'Export not found'));
    res.json({ id: req.params.id, status: 'ready', download_url: `/api/native/books/exports/${req.params.id}/download` });
  });

  router.get('/exports/:id/download', requireCapability('books.read'), (req, res) => {
    const owner = exportsOwner.get(req.params.id);
    if (!owner || owner.email !== req.native.email) return res.status(404).json(errBody('not_found', 'Export not found'));
    const rows = db.prepare(
      `SELECT book_title, author, status, created_at FROM requests
       WHERE LOWER(requester_email) = LOWER(?) ORDER BY created_at DESC`
    ).all(req.native.email);
    const header = 'title,author,status,created_at\n';
    const csv = header + rows.map((r) =>
      [r.book_title, r.author, r.status, r.created_at].map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', `attachment; filename="books-export-${req.params.id}.csv"`);
    res.send(csv);
  });

  return router;
}

module.exports = { createNativeBooksRouter, CONTRACT };
