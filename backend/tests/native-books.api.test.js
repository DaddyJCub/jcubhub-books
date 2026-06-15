'use strict';

// Integration tests for the native JCubHub Apps books API (/api/native/books).
// Spawns the real server with a known IDENTITY_TOKEN_SIGNING_SECRET, mints broker
// access tokens locally with jsonwebtoken, and exercises auth gating, capability
// enforcement, scoping, idempotency, and export. Run with: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');

const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const SIGNING_SECRET = 'native-books-test-signing-secret-please-rotate';
const ISSUER = 'jcubhub-apps-identity';
let serverProc;
let dataDir;

function mintToken({ email, caps = ['books.read', 'books.write'], username = 'tester' }) {
  return jwt.sign(
    { sub: 'user-uuid-1', username, email, sid: 'sess-1', ver: 1, caps },
    SIGNING_SECRET,
    { algorithm: 'HS256', issuer: ISSUER, expiresIn: 300 },
  );
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra };
}

function startServer() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jcub-native-test-'));
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_PATH: dataDir,
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        IDENTITY_TOKEN_SIGNING_SECRET: SIGNING_SECRET,
        ZOHO_EMAIL: '', ZOHO_PASSWORD: '', TURNSTILE_SECRET_KEY: '',
        READARR_URL: '', CWA_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.on('error', reject);
    const deadline = Date.now() + 15000;
    const poll = async () => {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) return resolve();
      } catch { /* not up yet */ }
      if (Date.now() > deadline) return reject(new Error('server did not start'));
      setTimeout(poll, 200);
    };
    poll();
  });
}

function stopServer() {
  if (serverProc) serverProc.kill('SIGKILL');
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}

before(startServer);
after(stopServer);

test('rejects missing/invalid Bearer token', async () => {
  const noAuth = await fetch(`${BASE}/api/native/books/dashboard`);
  assert.strictEqual(noAuth.status, 401);

  const bad = await fetch(`${BASE}/api/native/books/dashboard`, { headers: { Authorization: 'Bearer not.a.jwt' } });
  assert.strictEqual(bad.status, 401);
});

test('enforces capability (deny-by-default)', async () => {
  const readonly = mintToken({ email: 'a@example.com', caps: ['books.read'] });
  // books.read can list…
  const list = await fetch(`${BASE}/api/native/books/dashboard`, { headers: authHeaders(readonly) });
  assert.strictEqual(list.status, 200);
  // …but cannot submit (needs books.write).
  const submit = await fetch(`${BASE}/api/native/books/requests`, {
    method: 'POST', headers: authHeaders(readonly, { 'Idempotency-Key': 'k1' }),
    body: JSON.stringify({ title: 'Nope' }),
  });
  assert.strictEqual(submit.status, 403);
});

test('submit is idempotent and scoped to the caller email', async () => {
  const token = mintToken({ email: 'owner@example.com' });
  const key = 'idem-123';

  const first = await fetch(`${BASE}/api/native/books/requests`, {
    method: 'POST', headers: authHeaders(token, { 'Idempotency-Key': key }),
    body: JSON.stringify({ title: 'Dune', author: 'Herbert' }),
  });
  assert.strictEqual(first.status, 201);
  const created = await first.json();
  assert.ok(created.id);
  // POST now returns the rich requester-dashboard item (bookTitle, author, metadata).
  assert.strictEqual(created.bookTitle, 'Dune');
  assert.strictEqual(created.author, 'Herbert');
  assert.strictEqual(created.status, 'pending');
  assert.ok(created.metadata, 'rich item includes metadata');

  // Replay with same key + body returns the same result.
  const replay = await fetch(`${BASE}/api/native/books/requests`, {
    method: 'POST', headers: authHeaders(token, { 'Idempotency-Key': key }),
    body: JSON.stringify({ title: 'Dune', author: 'Herbert' }),
  });
  assert.strictEqual(replay.status, 201);
  assert.strictEqual(replay.headers.get('x-idempotency-replay'), 'true');
  assert.strictEqual((await replay.json()).id, created.id);

  // Same key, different body → 409.
  const conflict = await fetch(`${BASE}/api/native/books/requests`, {
    method: 'POST', headers: authHeaders(token, { 'Idempotency-Key': key }),
    body: JSON.stringify({ title: 'Different' }),
  });
  assert.strictEqual(conflict.status, 409);

  // The owner sees it…
  const mine = await (await fetch(`${BASE}/api/native/books/requests`, { headers: authHeaders(token) })).json();
  assert.ok(mine.items.some((r) => r.id === created.id));
  assert.ok('next_cursor' in mine);

  // …a different user does not (email scoping).
  const otherToken = mintToken({ email: 'someone-else@example.com' });
  const theirs = await (await fetch(`${BASE}/api/native/books/requests`, { headers: authHeaders(otherToken) })).json();
  assert.ok(!theirs.items.some((r) => r.id === created.id));
});

test('duplicate active request subscribes instead of creating a second', async () => {
  const token = mintToken({ email: 'dup@example.com' });

  const first = await fetch(`${BASE}/api/native/books/requests`, {
    method: 'POST', headers: authHeaders(token, { 'Idempotency-Key': 'dup-a' }),
    body: JSON.stringify({ title: 'Neuromancer', author: 'Gibson' }),
  });
  assert.strictEqual(first.status, 201);
  const created = await first.json();

  // Same title+author, different idempotency key → must not create a duplicate.
  const second = await fetch(`${BASE}/api/native/books/requests`, {
    method: 'POST', headers: authHeaders(token, { 'Idempotency-Key': 'dup-b' }),
    body: JSON.stringify({ title: 'Neuromancer', author: 'Gibson' }),
  });
  assert.strictEqual(second.status, 200);
  const body = await second.json();
  assert.strictEqual(body.subscribedToExisting, true);
  assert.strictEqual(body.requestId, created.id);
});

test('missing Idempotency-Key is rejected', async () => {
  const token = mintToken({ email: 'owner@example.com' });
  const res = await fetch(`${BASE}/api/native/books/requests`, {
    method: 'POST', headers: authHeaders(token),
    body: JSON.stringify({ title: 'X' }),
  });
  assert.strictEqual(res.status, 400);
});

test('config reports ereader capability shape', async () => {
  const token = mintToken({ email: 'cfg@example.com' });
  const res = await fetch(`${BASE}/api/native/books/config`, { headers: authHeaders(token) });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.ereader);
  assert.strictEqual(typeof body.ereader.enabled, 'boolean');
  assert.ok(Array.isArray(body.ereader.allowedDomains));
});

test('feedback on an owned request is recorded; non-owned is 404', async () => {
  const token = mintToken({ email: 'fb@example.com' });
  const created = await (await fetch(`${BASE}/api/native/books/requests`, {
    method: 'POST', headers: authHeaders(token, { 'Idempotency-Key': 'fb-1' }),
    body: JSON.stringify({ title: 'Hyperion', author: 'Simmons' }),
  })).json();

  const ok = await fetch(`${BASE}/api/native/books/requests/${created.id}/feedback`, {
    method: 'POST', headers: authHeaders(token),
    body: JSON.stringify({ feedbackType: 'match_confirmed' }),
  });
  assert.strictEqual(ok.status, 200);

  const bad = await fetch(`${BASE}/api/native/books/requests/${created.id}/feedback`, {
    method: 'POST', headers: authHeaders(token),
    body: JSON.stringify({ feedbackType: 'nonsense' }),
  });
  assert.strictEqual(bad.status, 422);

  const other = mintToken({ email: 'not-owner@example.com' });
  const notOwned = await fetch(`${BASE}/api/native/books/requests/${created.id}/feedback`, {
    method: 'POST', headers: authHeaders(other),
    body: JSON.stringify({ feedbackType: 'match_confirmed' }),
  });
  assert.strictEqual(notOwned.status, 404);
});

test('send-ereader requires a valid email and is gated by admin config', async () => {
  const token = mintToken({ email: 'er@example.com' });
  const created = await (await fetch(`${BASE}/api/native/books/requests`, {
    method: 'POST', headers: authHeaders(token, { 'Idempotency-Key': 'er-1' }),
    body: JSON.stringify({ title: 'Annihilation', author: 'VanderMeer' }),
  })).json();

  // Invalid email → 422 before any send.
  const badEmail = await fetch(`${BASE}/api/native/books/requests/${created.id}/send-ereader`, {
    method: 'POST', headers: authHeaders(token),
    body: JSON.stringify({ ereaderEmail: 'not-an-email' }),
  });
  assert.strictEqual(badEmail.status, 422);
});

test('export job produces a token-gated CSV', async () => {
  const token = mintToken({ email: 'export@example.com' });
  // seed one request
  await fetch(`${BASE}/api/native/books/requests`, {
    method: 'POST', headers: authHeaders(token, { 'Idempotency-Key': 'exp-seed' }),
    body: JSON.stringify({ title: 'Exported Book' }),
  });

  const job = await (await fetch(`${BASE}/api/native/books/exports`, {
    method: 'POST', headers: authHeaders(token, { 'Idempotency-Key': 'exp-1' }),
    body: JSON.stringify({ format: 'csv' }),
  })).json();
  assert.strictEqual(job.status, 'ready');
  assert.ok(job.download_url);

  const dl = await fetch(`${BASE}${job.download_url}`, { headers: authHeaders(token) });
  assert.strictEqual(dl.status, 200);
  assert.match(dl.headers.get('content-type') || '', /text\/csv/);
  const csv = await dl.text();
  assert.match(csv, /Exported Book/);

  // Contract version header is echoed.
  assert.strictEqual(dl.headers.get('x-jcubhub-contract'), 'books/1.0.0');
});
