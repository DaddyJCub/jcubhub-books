'use strict';
// Native books API (contract: docs/native-platform/contracts/books.openapi.yaml,
// books/1.0.0). Bearer-only, capability-gated, scoped to the caller's email.
//
// Mounted at /api/native/books in server.js. Reuses the existing SQLite `db`,
// `generateId`, and `buildRequesterDashboardItem` passed in as deps so it stays
// consistent with the cookie-session requester API (parity, not a fork).

const express = require('express');
const { requireBrokerAuth, requireCapability } = require('../middleware/native-auth');

const CONTRACT = 'books/1.0.0';

// In-memory idempotency cache: key -> { body, response, expires }. 10-min TTL.
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const idempotency = new Map();

function rememberIdempotent(key, requestBody, response) {
  idempotency.set(key, { requestBody: JSON.stringify(requestBody || {}), response, expires: Date.now() + IDEMPOTENCY_TTL_MS });
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

function createNativeBooksRouter(deps) {
  const { db, generateId, buildRequesterDashboardItem, log } = deps;
  const router = express.Router();

  // Echo the contract version on every native response.
  router.use((req, res, next) => {
    res.set('X-JCubHub-Contract', CONTRACT);
    next();
  });
  router.use(requireBrokerAuth);

  function toBookRequest(row) {
    return { id: row.id, title: row.book_title, status: row.status, created_at: row.created_at };
  }

  function pageRequests(email, cursor, limit) {
    const offset = decodeCursor(cursor);
    const rows = db.prepare(
      `SELECT * FROM requests WHERE LOWER(requester_email) = LOWER(?)
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    ).all(email, limit + 1, offset);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items, next_cursor: hasMore ? encodeCursor(offset + limit) : null };
  }

  // GET /dashboard — list (cursor paged, dashboard item shape + base fields).
  router.get('/dashboard', requireCapability('books.read'), (req, res) => {
    const limit = clampLimit(req.query.limit);
    const { items, next_cursor } = pageRequests(req.native.email, req.query.cursor, limit);
    res.json({ items: items.map(buildRequesterDashboardItem), next_cursor });
  });

  // GET /requests — history (cursor paged, stable ids).
  router.get('/requests', requireCapability('books.read'), (req, res) => {
    const limit = clampLimit(req.query.limit);
    const { items, next_cursor } = pageRequests(req.native.email, req.query.cursor, limit);
    res.json({ items: items.map(toBookRequest), next_cursor });
  });

  // POST /requests — submit a request (idempotent; requires books.write).
  router.post('/requests', requireCapability('books.write'), (req, res) => {
    const idemKey = req.get('Idempotency-Key');
    if (!idemKey) return res.status(400).json(errBody('validation_error', 'Idempotency-Key header is required'));

    const replay = getIdempotent(idemKey);
    if (replay) {
      if (replay.requestBody !== JSON.stringify(req.body || {})) {
        return res.status(409).json(errBody('idempotency_replay', 'Idempotency-Key reused with a different body'));
      }
      res.set('X-Idempotency-Replay', 'true');
      return res.status(201).json(replay.response);
    }

    const title = String((req.body && req.body.title) || '').trim();
    if (!title) return res.status(422).json(errBody('validation_error', 'title is required'));
    const notes = req.body && req.body.notes ? String(req.body.notes) : null;
    const author = req.body && req.body.author ? String(req.body.author) : 'Unknown';
    const format = req.body && req.body.format ? String(req.body.format) : 'any';

    const now = new Date().toISOString();
    const id = generateId();
    db.prepare(
      `INSERT INTO requests
         (id, requester_name, requester_email, book_title, author, format, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(id, req.native.username || req.native.email, req.native.email, title, author, format, notes, now, now);

    try {
      db.prepare(`INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, 'pending', ?, ?)`)
        .run(id, now, 'Created via native app');
    } catch (e) { /* status_history is best-effort */ }

    const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    const response = toBookRequest(row);
    rememberIdempotent(idemKey, req.body, response);
    if (log) log('info', 'native.books.request.created', { id, email: req.native.email });
    res.status(201).json(response);
  });

  // POST /exports — start an export job (idempotent). Synchronous (ready immediately).
  router.post('/exports', requireCapability('books.read'), (req, res) => {
    const idemKey = req.get('Idempotency-Key');
    if (!idemKey) return res.status(400).json(errBody('validation_error', 'Idempotency-Key header is required'));
    const replay = getIdempotent(idemKey);
    if (replay) { res.set('X-Idempotency-Replay', 'true'); return res.status(202).json(replay.response); }

    const id = generateId();
    const response = {
      id,
      status: 'ready',
      download_url: `/api/native/books/exports/${id}/download`,
    };
    // Store the export's owner so the download route can re-scope by email.
    exportsOwner.set(id, { email: req.native.email, expires: Date.now() + IDEMPOTENCY_TTL_MS });
    rememberIdempotent(idemKey, req.body, response);
    res.status(202).json(response);
  });

  // GET /exports/:id — job status.
  router.get('/exports/:id', requireCapability('books.read'), (req, res) => {
    const owner = exportsOwner.get(req.params.id);
    if (!owner || owner.email !== req.native.email) return res.status(404).json(errBody('not_found', 'Export not found'));
    res.json({ id: req.params.id, status: 'ready', download_url: `/api/native/books/exports/${req.params.id}/download` });
  });

  // GET /exports/:id/download — token-gated CSV (no cookie).
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

const exportsOwner = new Map();

module.exports = { createNativeBooksRouter, CONTRACT };
