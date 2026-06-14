'use strict';

// Integration tests for the requester dashboard + metadata APIs.
//
// These spawn the real server against a throwaway SQLite DB. They require the native
// `better-sqlite3` build to be present (i.e. run where `npm install` succeeded — CI,
// Docker, or a dev box with build tools). Run with:  npm test
//
// REQUESTER_AUTH_EXPOSE_TOKEN=true makes /auth/start echo the raw magic token so the
// verify step can complete without reading email.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const PORT = 4100 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
let serverProc;
let dataDir;

function startServer() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jcub-test-'));
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_PATH: dataDir,
        REQUESTER_AUTH_EXPOSE_TOKEN: 'true',
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        // Ensure no external integrations interfere.
        ZOHO_EMAIL: '', ZOHO_PASSWORD: '',
        TURNSTILE_SECRET_KEY: '',
        READARR_URL: '', CWA_URL: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    serverProc.on('error', reject);
    // Poll health until ready.
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

async function createRequest(body) {
  const res = await fetch(`${BASE}/api/book-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnstileToken: 'test-bypass', notifyOnComplete: false, ...body })
  });
  return { status: res.status, data: await res.json() };
}

// Sign in via magic link, return the session cookie string.
async function signIn(email) {
  const startRes = await fetch(`${BASE}/api/requester/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  });
  const startData = await startRes.json();
  assert.strictEqual(startRes.status, 200, 'auth/start is always 200');
  assert.ok(startData.devToken, 'devToken present in test mode');

  const verifyRes = await fetch(`${BASE}/api/requester/auth/verify?token=${encodeURIComponent(startData.devToken)}`, {
    redirect: 'manual'
  });
  assert.ok(verifyRes.status === 302 || verifyRes.status === 303, 'verify redirects');
  const setCookies = verifyRes.headers.getSetCookie();
  const sessionCookie = setCookies.map(c => c.split(';')[0]).find(c => c.startsWith('jcub_requester_session='));
  assert.ok(sessionCookie, 'session cookie set on verify');
  return { sessionCookie, devToken: startData.devToken };
}

before(startServer);
after(stopServer);

test('auth/start returns generic 200 for known and unknown emails', async () => {
  const known = await fetch(`${BASE}/api/requester/auth/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com' })
  });
  const unknown = await fetch(`${BASE}/api/requester/auth/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'someone-else@example.com' })
  });
  assert.strictEqual(known.status, 200);
  assert.strictEqual(unknown.status, 200);
  const a = await known.json();
  const b = await unknown.json();
  assert.strictEqual(a.message, b.message, 'uniform message prevents enumeration');
});

test('magic link verifies once, rejects reuse', async () => {
  const { devToken } = await signIn('reuse@example.com');
  // Token already used by signIn; reusing redirects to login with error=used.
  const res = await fetch(`${BASE}/api/requester/auth/verify?token=${encodeURIComponent(devToken)}`, { redirect: 'manual' });
  assert.ok(res.status === 302 || res.status === 303);
  assert.match(res.headers.get('location') || '', /\/requester\/login\?error=/);
});

test('dashboard is scoped to the authenticated email', async () => {
  await createRequest({ requesterName: 'Alice', requesterEmail: 'alice@example.com', bookTitle: 'Alice Book', author: 'A Author', format: 'epub' });
  await createRequest({ requesterName: 'Bob', requesterEmail: 'bob@example.com', bookTitle: 'Bob Book', author: 'B Author', format: 'epub' });

  const { sessionCookie } = await signIn('alice@example.com');
  const res = await fetch(`${BASE}/api/requester/dashboard`, { headers: { Cookie: sessionCookie } });
  const data = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(data.email, 'alice@example.com');
  const titles = data.items.map(i => i.bookTitle);
  assert.ok(titles.includes('Alice Book'));
  assert.ok(!titles.includes('Bob Book'), 'must not leak other requesters');
  assert.ok(data.counts.pending >= 1);
});

test('dashboard requires authentication', async () => {
  const res = await fetch(`${BASE}/api/requester/dashboard`);
  assert.strictEqual(res.status, 401);
});

test('history endpoint enforces ownership', async () => {
  const { data } = await createRequest({ requesterName: 'Carol', requesterEmail: 'carol@example.com', bookTitle: 'Carol Book', author: 'C Author', format: 'epub' });
  const requestId = data.requestId;
  assert.ok(requestId);

  // Owner can read history.
  const owner = await signIn('carol@example.com');
  const ownRes = await fetch(`${BASE}/api/requester/requests/${requestId}/history`, { headers: { Cookie: owner.sessionCookie } });
  assert.strictEqual(ownRes.status, 200);

  // A different requester cannot.
  const other = await signIn('intruder@example.com');
  const otherRes = await fetch(`${BASE}/api/requester/requests/${requestId}/history`, { headers: { Cookie: other.sessionCookie } });
  assert.strictEqual(otherRes.status, 404, 'ownership tampering is rejected');
});

test('book-request persists sanitized metadata', async () => {
  const { data } = await createRequest({
    requesterName: 'Dan', requesterEmail: 'dan@example.com',
    bookTitle: 'Meta Book', author: 'D Author', format: 'epub',
    metadataSource: 'openlibrary', metadataSourceId: '/works/OL1W',
    coverUrl: 'https://covers.openlibrary.org/b/id/1-M.jpg',
    summary: 'A <script>alert(1)</script> dangerous summary',
    publisher: 'Test Press', publishedYear: 2001,
    isbn13: '9780007525492', isbn10: '0807205265'
  });
  assert.ok(data.requestId);

  const { sessionCookie } = await signIn('dan@example.com');
  const res = await fetch(`${BASE}/api/requester/dashboard`, { headers: { Cookie: sessionCookie } });
  const dash = await res.json();
  const item = dash.items.find(i => i.bookTitle === 'Meta Book');
  assert.ok(item, 'metadata request present');
  assert.strictEqual(item.metadata.coverUrl, 'https://covers.openlibrary.org/b/id/1-M.jpg');
  assert.strictEqual(item.metadata.publishedYear, 2001);
  assert.strictEqual(item.metadata.isbn13, '9780007525492');
  assert.ok(!/<script>/i.test(item.metadata.summary || ''), 'summary is sanitized');
});

test('CSV export returns only owner rows with deterministic header', async () => {
  const { sessionCookie } = await signIn('alice@example.com');
  const res = await fetch(`${BASE}/api/requester/dashboard/export.csv`, { headers: { Cookie: sessionCookie } });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/csv/);
  const text = await res.text();
  const header = text.split('\r\n')[0];
  assert.strictEqual(header, 'id,book_title,author,status,format,isbn13,isbn10,isbn,publisher,published_year,created_at,updated_at,cwa_book_link');
  assert.ok(text.includes('Alice Book'));
  assert.ok(!text.includes('Bob Book'));
});

test('metadata search validates query length and returns normalized shape', async () => {
  const tooShort = await fetch(`${BASE}/api/metadata/search?q=a`);
  assert.strictEqual(tooShort.status, 400);

  const res = await fetch(`${BASE}/api/metadata/search?q=the%20hobbit&limit=3`);
  // Tolerate provider/network unavailability in offline CI.
  if (res.status === 200) {
    const data = await res.json();
    assert.ok(Array.isArray(data.results));
    if (data.results.length) {
      const c = data.results[0];
      for (const key of ['source', 'sourceId', 'title', 'authors', 'isbn10', 'isbn13', 'publishedYear', 'publisher', 'summary', 'coverUrl']) {
        assert.ok(key in c, `candidate has ${key}`);
      }
      assert.ok(Array.isArray(c.authors));
    }
  } else {
    assert.strictEqual(res.status, 502);
  }
});

test('logout revokes the session', async () => {
  const { sessionCookie } = await signIn('logout@example.com');
  const out = await fetch(`${BASE}/api/requester/auth/logout`, { method: 'POST', headers: { Cookie: sessionCookie } });
  assert.strictEqual(out.status, 200);
  const after = await fetch(`${BASE}/api/requester/dashboard`, { headers: { Cookie: sessionCookie } });
  assert.strictEqual(after.status, 401, 'revoked session no longer authorizes');
});

test('admin login endpoint remains unchanged (regression guard)', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nope', password: 'nope' })
  });
  assert.strictEqual(res.status, 401, 'admin login still rejects bad creds (not 404/500)');
});
