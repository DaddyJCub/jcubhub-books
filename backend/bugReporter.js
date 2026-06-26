// JcubHub Books → JCubHub CM bug reporter (Sentinel report contract v1.0.0).
// Fail-open: never throws, never blocks. Recursion-guarded + per-fingerprint
// throttle. No-op unless BUG_REPORT_URL and BUG_REPORT_SECRET are set.
//
// Env: BUG_REPORT_URL, BUG_REPORT_SECRET, BUG_APP_ID (default "books"),
//      ENVIRONMENT, APP_VERSION.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const ENVIRONMENT = process.env.ENVIRONMENT || 'production';
const APP_VERSION = process.env.APP_VERSION || null;
const TIMEOUT_MS = parseInt(process.env.BUG_REPORT_TIMEOUT_MS || '5000', 10);

const THROTTLE_MS = 60000;
const recent = new Map();
let inReport = false;

// Config is resolved at report time so it can be managed in the admin UI (DB
// app_settings) with no redeploy. configure() injects a getter(key)->value|null;
// env vars remain as a fallback. Keys: bug_report_enabled, bug_report_url,
// bug_report_secret, bug_app_id.
let settingGetter = null;

function configure(getter) {
  settingGetter = getter;
}

function cfg(key, env, def = '') {
  if (settingGetter) {
    try {
      const v = settingGetter(key);
      if (v != null && String(v).trim()) return String(v).trim();
    } catch (_) {}
  }
  return (process.env[env] || def).trim();
}

function reportUrl() { return cfg('bug_report_url', 'BUG_REPORT_URL'); }
function reportSecret() { return cfg('bug_report_secret', 'BUG_REPORT_SECRET'); }
function appId() { return cfg('bug_app_id', 'BUG_APP_ID', 'books') || 'books'; }

function explicitlyDisabled() {
  if (settingGetter) {
    try {
      const v = String(settingGetter('bug_report_enabled') || '').trim().toLowerCase();
      if (['0', 'false', 'no', 'off'].includes(v)) return true;
    } catch (_) {}
  }
  return false;
}

function enabled() {
  return !explicitlyDisabled() && Boolean(reportUrl() && reportSecret());
}

function fingerprint(message, stack, app_id) {
  const basis = `${app_id}|${String(message).slice(0, 200)}|${String(stack || '').slice(0, 200)}`;
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

function throttled(fp) {
  const now = Date.now();
  for (const [k, ts] of recent) if (now - ts > THROTTLE_MS) recent.delete(k);
  if (recent.has(fp)) return true;
  recent.set(fp, now);
  return false;
}

function post(payload, url, secret, app_id) {
  try {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        timeout: TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-JCubHub-App': app_id,
          'X-JCubHub-Signature': `sha256=${sig}`,
          'X-JCubHub-Report-Contract': '1.0.0',
        },
      },
      (res) => res.resume(),
    );
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch (_) {
    /* fail open */
  }
}

function report(opts = {}) {
  if (!enabled() || inReport) return;
  try {
    inReport = true;
    const app_id = appId();
    const message = String(opts.message || 'error').slice(0, 4000);
    const stack = opts.stack ? String(opts.stack).slice(0, 16000) : null;
    const fp = fingerprint(message, stack, app_id);
    if (throttled(fp)) return;
    const payload = {
      app_id,
      type: opts.type || 'error',
      message,
      severity: opts.severity || undefined,
      environment: ENVIRONMENT,
      app_version: APP_VERSION || undefined,
      stack_trace: stack || undefined,
      fingerprint: fp,
      route: opts.route || undefined,
      http_method: opts.method || undefined,
      status_code: opts.statusCode || undefined,
      user_agent: opts.userAgent || undefined,
      reporter: opts.reporter || 'auto',
      reporter_email: opts.reporterEmail || undefined,
      context: opts.context || undefined,
      occurred_at: new Date().toISOString(),
    };
    post(payload, reportUrl(), reportSecret(), app_id);
  } catch (_) {
    /* fail open */
  } finally {
    inReport = false;
  }
}

function reportException(err, opts = {}) {
  report({
    message: err && err.message ? `${err.name || 'Error'}: ${err.message}` : String(err),
    stack: err && err.stack ? err.stack : undefined,
    ...opts,
  });
}

// Express error-handling middleware (4-arg). Mount BEFORE the existing handler.
function expressErrorReporter(err, req, res, next) {
  try {
    reportException(err, {
      severity: 'high',
      route: req && req.path,
      method: req && req.method,
      statusCode: err && err.status ? err.status : 500,
      userAgent: req && req.headers && req.headers['user-agent'],
    });
  } catch (_) {}
  next(err);
}

// Express route handler for the client-side JS beacon (keeps secret server-side).
function clientErrorHandler(req, res) {
  try {
    const d = req.body || {};
    report({
      message: String(d.message || 'client error').slice(0, 1000),
      type: d.type === 'suggestion' ? 'suggestion' : 'error',
      severity: 'low',
      stack: d.stack ? String(d.stack) : undefined,
      route: d.route ? String(d.route).slice(0, 1024) : undefined,
      userAgent: req.headers && req.headers['user-agent'],
      context: { source: 'client_js' },
    });
  } catch (_) {}
  res.status(204).end();
}

module.exports = {
  configure,
  report,
  reportException,
  expressErrorReporter,
  clientErrorHandler,
  enabled,
};
