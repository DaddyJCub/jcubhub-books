// JcubHub Books - Unified Server
// Single Express server with static file serving, SQLite database, JWT auth, and API integrations

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const nodemailer = require('nodemailer');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const bookMetadata = require('./services/book-metadata');
const { createNativeBooksRouter } = require('./routes/native-books');

const app = express();
const PORT = process.env.PORT || 3003;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // debug, info, warn, error

// Trust proxy for Docker/reverse proxy setups (fixes X-Forwarded-For warnings)
app.set('trust proxy', 1);

// ============================================
// Logging Utility
// ============================================

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL]) {
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(meta).length > 0 ? ` | ${JSON.stringify(meta)}` : '';
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`);
  }
}

const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta)
};

// ============================================
// Startup Logging
// ============================================

logger.info('='.repeat(50));
logger.info('JcubHub Books Server Starting...');
logger.info('='.repeat(50));
logger.info('Environment Configuration:', {
  PORT,
  LOG_LEVEL,
  NODE_ENV: process.env.NODE_ENV || 'development'
});

// Log which integrations are configured
const integrations = {
  email: !!(process.env.ZOHO_EMAIL && process.env.ZOHO_PASSWORD),
  turnstile: !!process.env.TURNSTILE_SECRET_KEY,
  readarr: !!(process.env.READARR_URL && process.env.READARR_API_KEY),
  cwa: !!(process.env.CWA_URL && process.env.CWA_USERNAME && process.env.CWA_PASSWORD),
  adminConfigured: !!(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD)
};

// Automation settings (can be overridden by env vars)
const automation = {
  autoAddToReadarr: process.env.AUTO_ADD_READARR === 'true',  // Auto-add new requests to Readarr
  autoSyncInterval: parseInt(process.env.AUTO_SYNC_INTERVAL) || 0,  // Minutes between CWA syncs (0 = disabled)
  autoApprove: process.env.AUTO_APPROVE === 'true'  // Auto-approve all requests
};

// Case-insensitive boolean env parsing (so EREADER_SEND_ENABLED=TRUE works, not just "true").
function envBool(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

const ereader = {
  enabled: envBool(process.env.EREADER_SEND_ENABLED),
  allowedDomains: String(process.env.EREADER_ALLOWED_DOMAINS || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean)
};

// Requester (end-user) authentication settings. The provider abstraction lets us
// swap email-link auth for Authentik (OIDC) later without changing requester API contracts.
const requesterAuth = {
  provider: String(process.env.REQUESTER_AUTH_PROVIDER || 'email_link').trim().toLowerCase(),
  magicLinkTtlMin: parseInt(process.env.REQUESTER_MAGIC_LINK_TTL_MIN, 10) || 15,
  sessionTtlHours: parseInt(process.env.REQUESTER_SESSION_TTL_HOURS, 10) || 24 * 14,
  cookieName: process.env.REQUESTER_SESSION_COOKIE || 'jcub_requester_session',
  cookieSecure: process.env.REQUESTER_COOKIE_SECURE
    ? envBool(process.env.REQUESTER_COOKIE_SECURE)
    : process.env.NODE_ENV === 'production',
  // Test-only: when true, auth-start responses echo the raw magic token so automated
  // tests can complete the verify step. MUST stay false/unset in production.
  exposeToken: envBool(process.env.REQUESTER_AUTH_EXPOSE_TOKEN) && process.env.NODE_ENV !== 'production'
};

// External book-metadata provider settings (REQ-009/REQ-010, DEP-005).
const metadata = {
  primary: String(process.env.METADATA_PROVIDER || 'openlibrary').trim().toLowerCase(),
  openLibraryUrl: String(process.env.OPENLIBRARY_URL || 'https://openlibrary.org').replace(/\/+$/, ''),
  googleBooksKey: process.env.GOOGLE_BOOKS_API_KEY || '',
  googleBooksUrl: String(process.env.GOOGLE_BOOKS_URL || 'https://www.googleapis.com/books/v1').replace(/\/+$/, ''),
  cacheTtlMs: parseInt(process.env.METADATA_CACHE_TTL_MS, 10) || 24 * 60 * 60 * 1000,
  searchTimeoutMs: parseInt(process.env.METADATA_HTTP_TIMEOUT_MS, 10) || 8000
};

logger.info('Integrations Status:', integrations);
logger.info('Automation Settings:', automation);
logger.info('eReader Settings:', { enabled: ereader.enabled, allowedDomains: ereader.allowedDomains });
logger.info('Requester Auth Settings:', {
  provider: requesterAuth.provider,
  magicLinkTtlMin: requesterAuth.magicLinkTtlMin,
  sessionTtlHours: requesterAuth.sessionTtlHours,
  cookieSecure: requesterAuth.cookieSecure,
  exposeToken: requesterAuth.exposeToken
});
logger.info('Metadata Settings:', {
  primary: metadata.primary,
  openLibraryUrl: metadata.openLibraryUrl,
  googleBooks: !!metadata.googleBooksKey
});

// Initialize SQLite database
// Use DATA_PATH env var if set (for Docker volume mounts), otherwise fallback to local data folder
const dataDir = process.env.DATA_PATH || path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'books.db');

// Ensure data directory exists (important for volume mounts)
const fs = require('fs');
if (!fs.existsSync(dataDir)) {
  logger.info('Creating data directory', { path: dataDir });
  fs.mkdirSync(dataDir, { recursive: true });
}

logger.info('Database Configuration:', { 
  dataDir, 
  dbPath,
  dirExists: fs.existsSync(dataDir),
  dbExists: fs.existsSync(dbPath)
});

const db = new Database(dbPath);

function getAppSetting(key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setAppSetting(key, value) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, String(value), now);
}

function loadAutomationSettingsFromDb() {
  const storedAutoApprove = getAppSetting('automation.autoApprove');
  const storedAutoAddToReadarr = getAppSetting('automation.autoAddToReadarr');

  if (storedAutoApprove !== null) {
    automation.autoApprove = envBool(storedAutoApprove);
  }

  if (storedAutoAddToReadarr !== null) {
    automation.autoAddToReadarr = envBool(storedAutoAddToReadarr);
  }

  logger.info('Automation settings loaded from database', {
    autoApprove: automation.autoApprove,
    autoAddToReadarr: automation.autoAddToReadarr
  });
}

function updateAutomationSettings(nextValues = {}) {
  if (typeof nextValues.autoApprove === 'boolean') {
    automation.autoApprove = nextValues.autoApprove;
    setAppSetting('automation.autoApprove', nextValues.autoApprove);
  }

  if (typeof nextValues.autoAddToReadarr === 'boolean') {
    automation.autoAddToReadarr = nextValues.autoAddToReadarr;
    setAppSetting('automation.autoAddToReadarr', nextValues.autoAddToReadarr);
  }

  return {
    autoApprove: automation.autoApprove,
    autoAddToReadarr: automation.autoAddToReadarr,
    autoSyncInterval: automation.autoSyncInterval
  };
}

// Database initialization
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      requester_name TEXT NOT NULL,
      requester_email TEXT NOT NULL,
      book_title TEXT NOT NULL,
      author TEXT NOT NULL,
      isbn TEXT,
      format TEXT NOT NULL,
      notes TEXT,
      status TEXT DEFAULT 'pending',
      notify_on_complete INTEGER DEFAULT 1,
      readarr_url TEXT,
      readarr_book_id INTEGER,
      readarr_author_id INTEGER,
      readarr_foreign_book_id TEXT,
      readarr_foreign_author_id TEXT,
      readarr_selected_title TEXT,
      readarr_selected_author TEXT,
      readarr_selected_release_date TEXT,
      last_readarr_error TEXT,
      status_token TEXT,
      cwa_available INTEGER DEFAULT 0,
      cwa_book_link TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      status TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      notes TEXT,
      FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS request_subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      subscriber_name TEXT NOT NULL,
      subscriber_email TEXT NOT NULL,
      notify_on_complete INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (request_id) REFERENCES requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // Migration: Add ISBN column if it doesn't exist (for existing databases)
  try {
    db.exec(`ALTER TABLE requests ADD COLUMN isbn TEXT`);
    logger.info('Migration: Added ISBN column to requests table');
  } catch (e) {
    // Column already exists, ignore
  }

  const requestColumns = [
    { name: 'readarr_book_id', sql: 'ALTER TABLE requests ADD COLUMN readarr_book_id INTEGER' },
    { name: 'readarr_author_id', sql: 'ALTER TABLE requests ADD COLUMN readarr_author_id INTEGER' },
    { name: 'readarr_foreign_book_id', sql: 'ALTER TABLE requests ADD COLUMN readarr_foreign_book_id TEXT' },
    { name: 'readarr_foreign_author_id', sql: 'ALTER TABLE requests ADD COLUMN readarr_foreign_author_id TEXT' },
    { name: 'readarr_selected_title', sql: 'ALTER TABLE requests ADD COLUMN readarr_selected_title TEXT' },
    { name: 'readarr_selected_author', sql: 'ALTER TABLE requests ADD COLUMN readarr_selected_author TEXT' },
    { name: 'readarr_selected_release_date', sql: 'ALTER TABLE requests ADD COLUMN readarr_selected_release_date TEXT' },
    { name: 'last_readarr_error', sql: 'ALTER TABLE requests ADD COLUMN last_readarr_error TEXT' },
    { name: 'status_token', sql: 'ALTER TABLE requests ADD COLUMN status_token TEXT' },
    { name: 'cwa_available', sql: 'ALTER TABLE requests ADD COLUMN cwa_available INTEGER DEFAULT 0' },
    { name: 'cwa_book_link', sql: 'ALTER TABLE requests ADD COLUMN cwa_book_link TEXT' }
  ];

  for (const column of requestColumns) {
    try {
      db.exec(column.sql);
      logger.info('Migration: Added column to requests table', { column: column.name });
    } catch (e) {
      // Column already exists, ignore
    }
  }

  const indexes = [
    { name: 'idx_requests_status', sql: 'CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status)' },
    { name: 'idx_requests_email', sql: 'CREATE INDEX IF NOT EXISTS idx_requests_email ON requests(requester_email)' },
    { name: 'idx_requests_readarr_book_id', sql: 'CREATE INDEX IF NOT EXISTS idx_requests_readarr_book_id ON requests(readarr_book_id)' },
    { name: 'idx_requests_readarr_foreign_book_id', sql: 'CREATE INDEX IF NOT EXISTS idx_requests_readarr_foreign_book_id ON requests(readarr_foreign_book_id)' },
    { name: 'idx_requests_status_token', sql: 'CREATE INDEX IF NOT EXISTS idx_requests_status_token ON requests(status_token)' },
    { name: 'idx_requests_cwa_book_link', sql: 'CREATE INDEX IF NOT EXISTS idx_requests_cwa_book_link ON requests(cwa_book_link)' },
    { name: 'idx_request_subscribers_request_id', sql: 'CREATE INDEX IF NOT EXISTS idx_request_subscribers_request_id ON request_subscribers(request_id)' },
    { name: 'idx_request_subscribers_unique_email', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_request_subscribers_unique_email ON request_subscribers(request_id, subscriber_email)' },
    { name: 'idx_status_history_request', sql: 'CREATE INDEX IF NOT EXISTS idx_status_history_request ON status_history(request_id)' }
  ];

  for (const index of indexes) {
    try {
      db.exec(index.sql);
    } catch (e) {
      logger.warn('Could not create index', { index: index.name, error: e.message });
    }
  }

  // Strong dedupe locks: prevent multiple requests from tracking the same Readarr book IDs.
  // If historical duplicates exist these may fail; we keep startup running and log the issue.
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_requests_readarr_book_id ON requests(readarr_book_id) WHERE readarr_book_id IS NOT NULL');
  } catch (e) {
    logger.warn('Could not enforce unique index uq_requests_readarr_book_id', { error: e.message });
  }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_requests_readarr_foreign_book_id ON requests(readarr_foreign_book_id) WHERE readarr_foreign_book_id IS NOT NULL');
  } catch (e) {
    logger.warn('Could not enforce unique index uq_requests_readarr_foreign_book_id', { error: e.message });
  }

  // ----------------------------------------------------------------------
  // Requester dashboard: email-link auth + metadata schema (additive only).
  // ----------------------------------------------------------------------

  // Magic-link tokens (one-time-use, hashed at rest, short-lived).
  db.exec(`
    CREATE TABLE IF NOT EXISTS requester_magic_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL,
      ip_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS requester_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      session_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      user_agent_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS book_metadata_cache (
      query_hash TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  // Additive metadata columns on requests (DAT-002: never drop/rename).
  const metadataColumns = [
    { name: 'metadata_source', sql: 'ALTER TABLE requests ADD COLUMN metadata_source TEXT' },
    { name: 'metadata_source_id', sql: 'ALTER TABLE requests ADD COLUMN metadata_source_id TEXT' },
    { name: 'cover_url', sql: 'ALTER TABLE requests ADD COLUMN cover_url TEXT' },
    { name: 'summary', sql: 'ALTER TABLE requests ADD COLUMN summary TEXT' },
    { name: 'publisher', sql: 'ALTER TABLE requests ADD COLUMN publisher TEXT' },
    { name: 'published_year', sql: 'ALTER TABLE requests ADD COLUMN published_year INTEGER' },
    { name: 'isbn10', sql: 'ALTER TABLE requests ADD COLUMN isbn10 TEXT' },
    { name: 'isbn13', sql: 'ALTER TABLE requests ADD COLUMN isbn13 TEXT' }
  ];

  for (const column of metadataColumns) {
    try {
      db.exec(column.sql);
      logger.info('Migration: Added metadata column to requests table', { column: column.name });
    } catch (e) {
      // Column already exists, ignore
    }
  }

  const requesterIndexes = [
    { name: 'idx_magic_links_email', sql: 'CREATE INDEX IF NOT EXISTS idx_magic_links_email ON requester_magic_links(email)' },
    { name: 'idx_magic_links_expires', sql: 'CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON requester_magic_links(expires_at)' },
    { name: 'idx_magic_links_token_hash', sql: 'CREATE INDEX IF NOT EXISTS idx_magic_links_token_hash ON requester_magic_links(token_hash)' },
    { name: 'idx_requester_sessions_email', sql: 'CREATE INDEX IF NOT EXISTS idx_requester_sessions_email ON requester_sessions(email)' },
    { name: 'idx_requester_sessions_hash', sql: 'CREATE INDEX IF NOT EXISTS idx_requester_sessions_hash ON requester_sessions(session_hash)' },
    { name: 'idx_requester_sessions_expires', sql: 'CREATE INDEX IF NOT EXISTS idx_requester_sessions_expires ON requester_sessions(expires_at)' },
    { name: 'idx_requests_metadata_source_id', sql: 'CREATE INDEX IF NOT EXISTS idx_requests_metadata_source_id ON requests(metadata_source_id)' },
    { name: 'idx_requests_isbn13', sql: 'CREATE INDEX IF NOT EXISTS idx_requests_isbn13 ON requests(isbn13)' },
    { name: 'idx_requests_isbn10', sql: 'CREATE INDEX IF NOT EXISTS idx_requests_isbn10 ON requests(isbn10)' },
    { name: 'idx_metadata_cache_expires', sql: 'CREATE INDEX IF NOT EXISTS idx_metadata_cache_expires ON book_metadata_cache(expires_at)' }
  ];

  for (const index of requesterIndexes) {
    try {
      db.exec(index.sql);
    } catch (e) {
      logger.warn('Could not create index', { index: index.name, error: e.message });
    }
  }

  // Create default admin if not exists
  const adminExists = db.prepare('SELECT COUNT(*) as count FROM admin_users').get();
  if (adminExists.count === 0) {
    if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
      const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
      db.prepare('INSERT INTO admin_users (username, password_hash, created_at) VALUES (?, ?, ?)').run(
        process.env.ADMIN_USERNAME,
        passwordHash,
        new Date().toISOString()
      );
      logger.info('Default admin user created', { username: process.env.ADMIN_USERNAME });
    } else {
      logger.warn('No admin user exists and ADMIN_USERNAME/ADMIN_PASSWORD not set!');
      logger.warn('Set these environment variables and restart to create admin user.');
    }
  } else {
    logger.debug('Admin user already exists', { count: adminExists.count });
  }
  
  // Log database stats
  const requestCount = db.prepare('SELECT COUNT(*) as count FROM requests').get();
  const adminCount = db.prepare('SELECT COUNT(*) as count FROM admin_users').get();
  logger.info('Database initialized', { 
    path: dbPath, 
    requests: requestCount.count, 
    admins: adminCount.count 
  });
}

// Initialize database with error handling
try {
  initDatabase();
  loadAutomationSettingsFromDb();
} catch (error) {
  logger.error('Failed to initialize database', { error: error.message, stack: error.stack });
  process.exit(1);
}

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = crypto.randomBytes(4).toString('hex');
  req.requestId = requestId;
  
  // Log request
  logger.debug(`--> ${req.method} ${req.path}`, { 
    requestId, 
    ip: req.ip,
    userAgent: req.get('User-Agent')?.substring(0, 50)
  });
  
  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'warn' : 'debug';
    logger[level](`<-- ${req.method} ${req.path} ${res.statusCode}`, { 
      requestId, 
      duration: `${duration}ms` 
    });
  });
  
  next();
});

// Security middleware with CSP for Turnstile
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://challenges.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      frameSrc: ["https://challenges.cloudflare.com"],
      connectSrc: ["'self'", "https://challenges.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Stricter rate limit for book requests
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many book requests. Please try again later.' }
});

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// Email transporter
let transporter = null;
if (process.env.ZOHO_EMAIL && process.env.ZOHO_PASSWORD) {
  transporter = nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.ZOHO_EMAIL,
      pass: process.env.ZOHO_PASSWORD
    }
  });
}

// ============================================
// Helper Functions
// ============================================

function generateId() {
  return `BR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function generateStatusToken() {
  return crypto.randomBytes(16).toString('hex');
}

const READARR_HTTP_TIMEOUT_MS = parseInt(process.env.READARR_HTTP_TIMEOUT_MS, 10) || 12000;
const READARR_HTTP_RETRIES = parseInt(process.env.READARR_HTTP_RETRIES, 10) || 1;
const READARR_CACHE_TTL_MS = parseInt(process.env.READARR_CACHE_TTL_MS, 10) || 5 * 60 * 1000;

const readarrConfigCache = {
  qualityProfiles: null,
  metadataProfiles: null,
  rootFolders: null,
  fetchedAt: 0
};

const READARR_API_PREFIX = (() => {
  const raw = String(process.env.READARR_API_PREFIX || '/api/v1').trim();
  if (!raw) return '/api/v1';
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  return prefixed.replace(/\/+$/, '') || '/api/v1';
})();

function buildReadarrApiUrl(apiPath = '') {
  const base = String(process.env.READARR_URL || '').replace(/\/+$/, '');
  const normalizedPath = String(apiPath || '').startsWith('/')
    ? String(apiPath || '')
    : `/${String(apiPath || '')}`;
  return `${base}${READARR_API_PREFIX}${normalizedPath}`;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parsePositiveInt(value) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function matchesByForeignId(record, foreignBookId, foreignAuthorId) {
  const recordBook = String(record.readarr_foreign_book_id || '').trim();
  const recordAuthor = String(record.readarr_foreign_author_id || '').trim();
  const payloadBook = String(foreignBookId || '').trim();
  const payloadAuthor = String(foreignAuthorId || '').trim();

  if (recordBook && payloadBook) {
    return recordBook === payloadBook;
  }

  if (recordAuthor && payloadAuthor) {
    return recordAuthor === payloadAuthor;
  }

  return false;
}

async function fetchWithTimeout(url, options = {}, label = 'HTTP request') {
  let lastError;

  for (let attempt = 0; attempt <= READARR_HTTP_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), READARR_HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      if (response.status >= 500 && attempt < READARR_HTTP_RETRIES) {
        logger.warn(`${label} failed, retrying`, { url, status: response.status, attempt: attempt + 1 });
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < READARR_HTTP_RETRIES) {
        logger.warn(`${label} error, retrying`, { url, attempt: attempt + 1, error: error.message });
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error(`${label} failed`);
}

async function verifyTurnstile(token) {
  if (!process.env.TURNSTILE_SECRET_KEY) {
    logger.warn('TURNSTILE_SECRET_KEY not configured, skipping verification');
    return true;
  }

  try {
    logger.debug('Verifying Turnstile token');
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET_KEY,
        response: token
      })
    });
    const data = await response.json();
    logger.debug('Turnstile verification result', { success: data.success });
    return data.success;
  } catch (error) {
    logger.error('Turnstile verification error', { error: error.message });
    return false;
  }
}

async function sendEmail(to, subject, html) {
  if (!transporter) {
    logger.debug('Email not configured, skipping', { subject });
    return;
  }

  try {
    await transporter.sendMail({
      from: `"JcubHub Books" <${process.env.ZOHO_EMAIL}>`,
      to,
      subject,
      html
    });
    logger.info('Email sent successfully', { to, subject });
  } catch (error) {
    logger.error('Email send failed', { to, subject, error: error.message });
  }
}

// Styled email template wrapper - Light theme for better email client compatibility
function wrapEmailHtml(content, title = 'JcubHub Books') {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f7; color: #1d1d1f;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f5f5f7;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td align="center" style="padding-bottom: 30px;">
              <h1 style="margin: 0; font-size: 28px; font-weight: 700; color: #667eea;">
                📚 JcubHub Books
              </h1>
            </td>
          </tr>
          
          <!-- Main Content Card -->
          <tr>
            <td>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border-radius: 16px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);">
                <tr>
                  <td style="padding: 40px;">
                    ${content}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top: 30px;">
              <p style="margin: 0; font-size: 12px; color: #86868b;">
                © ${new Date().getFullYear()} JcubHub Books • Your Personal Library
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function generateReadarrUrl(author, bookTitle, isbn) {
  if (!process.env.READARR_URL) return null;
  // Use ISBN if available for more accurate search
  const searchQuery = isbn 
    ? encodeURIComponent(isbn) 
    : encodeURIComponent(`${author} ${bookTitle}`);
  return `${process.env.READARR_URL}/add/search?term=${searchQuery}`;
}

// CWA (Calibre-Web) link parsing/normalization lives in services/cwa-links.js so the
// live availability check and scripts/cwa-link-check.js share one implementation.
const {
  getCwaBaseUrl,
  buildCwaSearchLink,
  normalizeCwaBookLink,
  normalizeForMatch,
  parseCwaOpdsEntries,
  chooseBestCwaEntry,
  buildCwaOpdsSearchUrls
} = require('./services/cwa-links');

async function fetchCwaOpdsEntries(cwaBase, credentials, searchTerm) {
  const opdsUrls = buildCwaOpdsSearchUrls(cwaBase, searchTerm);
  const headers = {
    'Authorization': `Basic ${credentials}`,
    'Accept': 'application/atom+xml, application/xml, text/xml, */*'
  };

  for (const url of opdsUrls) {
    try {
      const response = await fetchWithTimeout(url, { headers }, 'CWA availability check');
      if (!response.ok) {
        logger.debug('CWA OPDS search returned non-OK response', {
          url,
          status: response.status,
          searchTerm
        });
        continue;
      }

      const xml = await response.text();
      if (!/(<feed\b|<entry\b)/i.test(xml)) {
        logger.debug('CWA OPDS search returned unexpected payload', {
          url,
          searchTerm,
          sample: String(xml).slice(0, 120)
        });
        continue;
      }

      const entries = parseCwaOpdsEntries(xml);
      logger.debug('CWA OPDS search parsed entries', {
        url,
        searchTerm,
        entryCount: entries.length
      });
      return { entries, sourceUrl: url };
    } catch (error) {
      logger.warn('CWA OPDS search request failed', {
        url,
        searchTerm,
        error: error.message
      });
    }
  }

  return { entries: [], sourceUrl: null };
}

async function checkCwaAvailability(bookTitle, author, isbn = '') {
  const cwaBase = getCwaBaseUrl();
  if (!cwaBase || !process.env.CWA_USERNAME || !process.env.CWA_PASSWORD) {
    return { available: false };
  }

  try {
    const credentials = Buffer.from(`${process.env.CWA_USERNAME}:${process.env.CWA_PASSWORD}`).toString('base64');
    const searchTerms = Array.from(new Set([
      [bookTitle, author].filter(Boolean).join(' ').trim(),
      String(bookTitle || '').trim(),
      String(isbn || '').trim()
    ].filter(Boolean)));

    for (const searchTerm of searchTerms) {
      const { entries, sourceUrl } = await fetchCwaOpdsEntries(cwaBase, credentials, searchTerm);
      if (!entries.length) continue;

      const bestEntry = chooseBestCwaEntry(entries, bookTitle, author);
      const directLinkEntries = entries.filter(entry => !!normalizeCwaBookLink(entry.bookHref));
      const singleDirectLinkEntry = (!bestEntry && directLinkEntries.length === 1)
        ? directLinkEntries[0]
        : null;
      const isbnFallbackEntry = (!bestEntry && isbn && searchTerm === String(isbn).trim() && entries.length === 1)
        ? entries[0]
        : null;
      const resolvedEntry = bestEntry || singleDirectLinkEntry || isbnFallbackEntry;
      if (!resolvedEntry) {
        logger.debug('CWA OPDS had entries but no confident match', {
          bookTitle,
          author,
          isbn: isbn || null,
          searchTerm,
          entryCount: entries.length,
          sourceUrl
        });
        continue;
      }

      const bookLink = normalizeCwaBookLink(resolvedEntry.bookHref) || buildCwaSearchLink(bookTitle, author);

      logger.debug('CWA availability check', {
        bookTitle,
        author,
        isbn: isbn || null,
        found: true,
        searchTerm,
        matchedVia: bestEntry ? 'scored_match' : singleDirectLinkEntry ? 'single_direct_link' : 'isbn_single_result',
        sourceUrl,
        entryCount: entries.length,
        matchedTitle: resolvedEntry.title || null,
        matchedAuthor: resolvedEntry.author || null,
        bookLink
      });

      return {
        available: true,
        bookLink,
        matchedTitle: resolvedEntry.title || null,
        matchedAuthor: resolvedEntry.author || null
      };
    }

    logger.debug('CWA availability check', {
      bookTitle,
      author,
      isbn: isbn || null,
      found: false,
      attemptedSearchTerms: searchTerms
    });

    return {
      available: false,
      bookLink: buildCwaSearchLink(bookTitle, author)
    };
  } catch (error) {
    logger.error('CWA availability check error', { bookTitle, error: error.message });
    return { available: false };
  }
}

function isAudioTaggedValue(value) {
  return /\b(audiobook|audio\s*book|audio|audible|unabridged|abridged|cassette)\b/i.test(String(value || ''));
}

function isTextTaggedValue(value) {
  return /\b(ebook|e-book|epub|mobi|pdf|kindle|text|hardcover|paperback|print|novel)\b/i.test(String(value || ''));
}

// Chaptarr/Readarr lookup results put the author on book.author.authorName; the legacy
// top-level book.authorName field does not exist on lookup payloads.
function getReadarrAuthorName(book) {
  return String(book?.author?.authorName || book?.authorName || '').trim();
}

// IMPORTANT: book.mediaType (and author.lastSelectedMediaType) are NOT reliable format
// signals in Chaptarr. Goodreads-backed lookups report mediaType "audiobook" for plain
// text editions, so we must classify from edition-level evidence instead.
//
// Reliable EBOOK / text evidence:
//   - localEbookBooks present (already have it as an ebook)
//   - any edition (or the book) reports a positive pageCount  → it's a text edition
//   - edition.isEbook === true
//   - explicit text tokens in title/format
function hasReadarrEbookSignals(book) {
  if (Array.isArray(book?.localEbookBooks) && book.localEbookBooks.length > 0) return true;
  if (Number(book?.pageCount) > 0) return true;

  const editions = Array.isArray(book?.editions) ? book.editions : [];
  for (const edition of editions) {
    if (edition?.isEbook === true) return true;
    if (Number(edition?.pageCount) > 0) return true;
  }

  const textFields = [book?.bookType, book?.bookFormat, book?.releaseType, book?.title]
    .filter(Boolean).map(v => String(v));
  const editionTextFields = editions.flatMap(edition => [
    edition?.format,
    edition?.bookFormat,
    edition?.releaseType,
    edition?.title,
    edition?.moniker
  ].filter(Boolean).map(v => String(v)));

  return textFields.concat(editionTextFields).some(isTextTaggedValue);
}

// Reliable AUDIOBOOK evidence (positive only — never derived from mediaType):
//   - localAudiobookBooks present
//   - an edition with narrators, chapters, or audiobook cross-monitoring
//   - explicit audio tokens in the title/format (e.g. "Unabridged", "Audio Cassette")
function hasReadarrAudiobookSignals(book) {
  if (Array.isArray(book?.localAudiobookBooks) && book.localAudiobookBooks.length > 0) return true;

  const editions = Array.isArray(book?.editions) ? book.editions : [];
  for (const edition of editions) {
    if (Array.isArray(edition?.narratorNames) && edition.narratorNames.length > 0) return true;
    if (edition?.hasChapters === true) return true;
    if (Array.isArray(edition?.chapters) && edition.chapters.length > 0) return true;
    if (edition?.monitoredByAnotherAudiobookBook === true) return true;
  }

  const titleFields = [book?.title].filter(Boolean).map(v => String(v));
  const editionTitleFields = editions.flatMap(edition => [
    edition?.title,
    edition?.format,
    edition?.bookFormat,
    edition?.releaseType
  ].filter(Boolean).map(v => String(v)));

  return titleFields.concat(editionTitleFields).some(isAudioTaggedValue);
}

function isLikelyAudiobookResult(book) {
  const hasEbookSignals = hasReadarrEbookSignals(book);
  const hasAudiobookSignals = hasReadarrAudiobookSignals(book);

  // Only treat as audiobook-only when there is positive audio evidence AND no text evidence.
  if (hasAudiobookSignals && !hasEbookSignals) {
    return true;
  }

  // Mixed/text records are fine for ebook requests; prefer the ebook edition downstream.
  if (hasEbookSignals) {
    return false;
  }

  return isAudioTaggedValue(String(book?.title || ''));
}

function isCompanionBookTitle(title) {
  const value = String(title || '').toLowerCase();
  if (!value) return false;

  const patterns = [
    /\bsummary\b/,
    /\banalysis\b/,
    /\bstudy\s*guide\b/,
    /\bworkbook\b/,
    /\breading\s*list\b/,
    /\btrivia\b/,
    /\bfor\s+fans\b/,
    /\breviewed\s+by\b/,
    /\bsupersummary\b/
  ];

  return patterns.some(pattern => pattern.test(value));
}

function scoreReadarrLookupResult(book, normalizedSearchTitle, normalizedSearchAuthor, preferredFormat = 'any') {
  const bookTitleLower = (book.title || '').toLowerCase();
  const bookAuthorLower = getReadarrAuthorName(book).toLowerCase();
  const companionTitle = isCompanionBookTitle(bookTitleLower);
  const rawLikelyAudiobook = isLikelyAudiobookResult(book);
  let likelyAudiobook = rawLikelyAudiobook;
  const hasEbookSignals = hasReadarrEbookSignals(book);
  let score = 0;
  const scoreBreakdown = [];
  let titleMatchStrength = 0;
  let authorMatch = false;

  if (bookTitleLower === normalizedSearchTitle) {
    score += 100;
    scoreBreakdown.push('+100 exact title');
    titleMatchStrength = 3;
  } else if (bookTitleLower.startsWith(normalizedSearchTitle)) {
    score += 50;
    scoreBreakdown.push('+50 title starts with');
    titleMatchStrength = 2;
  } else if (bookTitleLower.includes(normalizedSearchTitle)) {
    score += 25;
    scoreBreakdown.push('+25 title contains');
    titleMatchStrength = 1;
  }

  if (companionTitle) {
    score -= 90;
    scoreBreakdown.push('-90 companion book');
  }

  if (normalizedSearchAuthor &&
      (bookAuthorLower.includes(normalizedSearchAuthor) ||
      normalizedSearchAuthor.includes(bookAuthorLower))) {
    authorMatch = true;
    score += 20;
    scoreBreakdown.push('+20 author match');
  }

  const highConfidenceTextIntent = !companionTitle && authorMatch && titleMatchStrength >= 2;

  if (preferredFormat !== 'audiobook' && rawLikelyAudiobook && highConfidenceTextIntent) {
    likelyAudiobook = false;
    scoreBreakdown.push('+25 non-audio override (strong title/author match)');
    score += 25;
  }

  if (preferredFormat === 'audiobook') {
    if (likelyAudiobook) {
      score += 35;
      scoreBreakdown.push('+35 audiobook preferred');
      if (hasEbookSignals) {
        score -= 15;
        scoreBreakdown.push('-15 mixed ebook signal while audiobook requested');
      }
    } else {
      score -= 15;
      scoreBreakdown.push('-15 non-audiobook while audiobook requested');
    }
  } else {
    if (hasEbookSignals) {
      score += 45;
      scoreBreakdown.push('+45 ebook signal');
    } else {
      score -= 20;
      scoreBreakdown.push('-20 no ebook signal');
    }

    if (likelyAudiobook) {
      score -= 80;
      scoreBreakdown.push('-80 audiobook penalty');
    } else if (rawLikelyAudiobook && highConfidenceTextIntent) {
      score -= 10;
      scoreBreakdown.push('-10 audio-biased metadata caution');
    }
  }

  return {
    score,
    likelyAudiobook,
    rawLikelyAudiobook,
    hasEbookSignals,
    companionTitle,
    highConfidenceTextIntent,
    scoreBreakdown
  };
}

async function lookupReadarrBooksByTerm(rawQuery, contextLabel = 'Readarr lookup') {
  const encoded = encodeURIComponent(String(rawQuery || '').trim());
  const response = await fetchWithTimeout(buildReadarrApiUrl(`/book/lookup?term=${encoded}`), {
    headers: {
      'X-Api-Key': process.env.READARR_API_KEY
    }
  }, contextLabel);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      books: []
    };
  }

  const books = await response.json();
  return {
    ok: true,
    status: response.status,
    statusText: response.statusText,
    books: Array.isArray(books) ? books : []
  };
}

function buildScoredReadarrEntries(books, normalizedSearchTitle, normalizedSearchAuthor, preferredFormat = 'any') {
  const scoredEntries = (Array.isArray(books) ? books : []).map(book => {
    const details = scoreReadarrLookupResult(book, normalizedSearchTitle, normalizedSearchAuthor, preferredFormat);
    return {
      book,
      score: details.score,
      likelyAudiobook: details.likelyAudiobook,
      rawLikelyAudiobook: details.rawLikelyAudiobook,
      hasEbookSignals: details.hasEbookSignals,
      companionTitle: details.companionTitle,
      highConfidenceTextIntent: details.highConfidenceTextIntent,
      scoreBreakdown: details.scoreBreakdown
    };
  });

  scoredEntries.sort((a, b) => b.score - a.score);
  return scoredEntries;
}

async function searchReadarr(bookTitle, author, isbn, options = {}) {
  if (!process.env.READARR_URL || !process.env.READARR_API_KEY) {
    return null;
  }

  const preferredFormat = String(options.preferredFormat || 'any').toLowerCase();
  const excludeAudiobook = options.excludeAudiobook === true;
  const excludeForeignBookId = String(options.excludeForeignBookId || '').trim();
  const searchTermOverride = String(options.searchTermOverride || '').trim();
  const ignoreIsbn = options.ignoreIsbn === true;

  try {
    // Build a query set for better coverage when Chaptarr returns audiobook-heavy lookup results.
    const rawQuery = searchTermOverride || (!ignoreIsbn && isbn ? isbn : `${author} ${bookTitle}`);
    const queryCandidates = [rawQuery];

    if (!searchTermOverride) {
      // Goodreads-backed lookup ignores format keywords (e.g. "<title> ebook" returns 0
      // results), so we vary word order instead. The bare-title query is important: it is
      // often the only query that surfaces the standalone edition rather than collections
      // or summary/companion books.
      queryCandidates.push(`${bookTitle}`);
      queryCandidates.push(`${bookTitle} ${author}`);
      queryCandidates.push(`${author} ${bookTitle}`);
    }

    const querySet = Array.from(new Set(queryCandidates.map(q => String(q || '').trim()).filter(Boolean)));
    const booksByKey = new Map();

    for (const queryTerm of querySet) {
      logger.info('Readarr search', { searchQuery: queryTerm, usingIsbn: !!isbn });
      const lookupResult = await lookupReadarrBooksByTerm(queryTerm, 'Readarr search');
      if (!lookupResult.ok) {
        logger.warn('Readarr search failed', { status: lookupResult.status, queryTerm });
        continue;
      }

      for (const book of lookupResult.books) {
        const key = String(book?.foreignBookId || book?.titleSlug || `${book?.title || ''}|${getReadarrAuthorName(book)}`);
        if (!booksByKey.has(key)) {
          booksByKey.set(key, book);
        }
      }
    }

    const books = Array.from(booksByKey.values());

    const topResults = books.slice(0, 3).map(b => ({
      title: b.title,
      author: getReadarrAuthorName(b),
      foreignBookId: b.foreignBookId,
      likelyAudiobook: isLikelyAudiobookResult(b)
    }));
    logger.info('Readarr search results', {
      searchQuery: rawQuery,
      queryCount: querySet.length,
      totalFound: books.length,
      topResults
    });

    if (books.length === 0) return null;

    const normalizedSearchTitle = bookTitle.toLowerCase().trim();
    const normalizedSearchAuthor = author.toLowerCase().trim();

    const scored = buildScoredReadarrEntries(books, normalizedSearchTitle, normalizedSearchAuthor, preferredFormat);
    let candidates = scored;

    if (excludeForeignBookId) {
      const filteredByForeignId = candidates.filter(item => String(item.book?.foreignBookId || '') !== excludeForeignBookId);
      if (filteredByForeignId.length > 0) {
        candidates = filteredByForeignId;
      }
    }

    if (excludeAudiobook) {
      // Exclude only candidates that are positively identified as audiobooks/companions.
      // Do NOT require a positive ebook signal here: most Goodreads lookup records carry no
      // explicit ebook tag, and demanding one was rejecting legitimate books (the
      // "only audiobook/companion candidates" failures). Prefer records that do have ebook
      // signals, but fall back to any non-audiobook candidate so auto-add still succeeds.
      const notAudiobook = candidates.filter(item => !item.likelyAudiobook && !item.companionTitle);
      const withEbookSignals = notAudiobook.filter(item => item.hasEbookSignals);

      if (withEbookSignals.length > 0) {
        candidates = withEbookSignals;
      } else if (notAudiobook.length > 0) {
        candidates = notAudiobook;
      } else {
        // Genuinely nothing but audiobooks/companions for this title.
        return null;
      }
    }

    if (preferredFormat !== 'audiobook') {
      const nonCompanion = candidates.filter(item => !item.companionTitle);
      if (nonCompanion.length > 0) {
        candidates = nonCompanion;
      }
    }

    const bestMatch = candidates[0] || scored[0];

    if (preferredFormat !== 'audiobook' && bestMatch.companionTitle && bestMatch.score < 10) {
      return null;
    }

    logger.info('Readarr best match selected', { 
      searchTitle: bookTitle,
      selectedTitle: bestMatch.book.title,
      score: bestMatch.score,
      likelyAudiobook: bestMatch.likelyAudiobook,
      wasFirst: bestMatch.book === books[0],
      preferredFormat,
      excludeAudiobook
    });
    
    return bestMatch.book;
  } catch (error) {
    logger.error('Readarr search error', { bookTitle, author, isbn, error: error.message });
    return null;
  }
}

function getRequestSubscribers(requestId) {
  return db.prepare(`
    SELECT id, request_id, subscriber_name, subscriber_email, notify_on_complete, created_at
    FROM request_subscribers
    WHERE request_id = ?
    ORDER BY created_at ASC
  `).all(requestId);
}

function addSubscriberToRequest(requestId, subscriberName, subscriberEmail, notifyOnComplete = true) {
  const now = new Date().toISOString();
  const name = (subscriberName || '').trim() || 'Subscriber';
  db.prepare(`
    INSERT OR IGNORE INTO request_subscribers
      (request_id, subscriber_name, subscriber_email, notify_on_complete, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    requestId,
    name,
    subscriberEmail,
    notifyOnComplete ? 1 : 0,
    now
  );
}

async function notifySubscribers(request, subject, html, options = {}) {
  const subscribers = getRequestSubscribers(request.id);
  if (subscribers.length === 0) return;

  const exclude = new Set(
    (options.excludeEmails || []).map(email => String(email || '').toLowerCase().trim())
  );

  for (const sub of subscribers) {
    if (!sub.notify_on_complete) continue;
    const normalized = String(sub.subscriber_email || '').toLowerCase().trim();
    if (!normalized || exclude.has(normalized)) continue;
    await sendEmail(sub.subscriber_email, subject, html);
  }
}

function findPublicRequest(requestId, email, statusToken) {
  let request = null;

  if (statusToken) {
    request = db.prepare('SELECT * FROM requests WHERE status_token = ?').get(statusToken);
    if (!request) return null;

    if (!email) return request;

    const requesterMatch = String(request.requester_email || '').toLowerCase() === String(email || '').toLowerCase();
    if (requesterMatch) return request;

    const subMatch = db.prepare(`
      SELECT 1
      FROM request_subscribers
      WHERE request_id = ?
      AND LOWER(subscriber_email) = LOWER(?)
      LIMIT 1
    `).get(request.id, email);
    return subMatch ? request : null;
  }

  if (!requestId || !email) return null;

  request = db.prepare(`
    SELECT * FROM requests
    WHERE id = ?
    AND LOWER(requester_email) = LOWER(?)
  `).get(requestId, email);
  if (request) return request;

  return db.prepare(`
    SELECT r.*
    FROM requests r
    JOIN request_subscribers s ON s.request_id = r.id
    WHERE r.id = ?
    AND LOWER(s.subscriber_email) = LOWER(?)
    LIMIT 1
  `).get(requestId, email);
}

function updateRequestCwaState(requestId, now, available, cwaBookLink = null) {
  db.prepare(`
    UPDATE requests
    SET cwa_available = ?,
        cwa_book_link = COALESCE(?, cwa_book_link),
        updated_at = ?
    WHERE id = ?
  `).run(available ? 1 : 0, cwaBookLink || null, now, requestId);
}

// A "direct" link points at a specific book page (/book/<id>) rather than a search page.
function isDirectCwaBookLink(url) {
  return !!url && /\/book\/[^\/?#]+/i.test(String(url));
}

async function resolveCwaLinkForRequest(request, cwaCheck = null) {
  if (cwaCheck?.bookLink) {
    return cwaCheck.bookLink;
  }

  // If we already have a stored DIRECT book link, use it (cheap path).
  const normalizedStoredLink = request?.cwa_book_link
    ? (normalizeCwaBookLink(request.cwa_book_link) || request.cwa_book_link)
    : null;
  if (normalizedStoredLink && isDirectCwaBookLink(normalizedStoredLink)) {
    if (request.id && normalizedStoredLink !== request.cwa_book_link) {
      updateRequestCwaState(request.id, new Date().toISOString(), true, normalizedStoredLink);
    }
    return normalizedStoredLink;
  }

  // Stored link is a search URL (or nothing). Try to upgrade to a direct book link by
  // re-querying CWA — this fixes legacy completions that stored a search URL.
  if (integrations.cwa) {
    const resolved = await checkCwaAvailability(request.book_title, request.author, request.isbn || '');
    if (resolved.available && isDirectCwaBookLink(resolved.bookLink)) {
      if (request?.id) {
        updateRequestCwaState(request.id, new Date().toISOString(), true, resolved.bookLink);
      }
      return resolved.bookLink;
    }
  }

  // Fall back to whatever non-direct link we had, else a fresh search link.
  return normalizedStoredLink || buildCwaSearchLink(request?.book_title || '', request?.author || '');
}

function findTrackedRequestConflict(currentRequestId, identifiers = {}) {
  const readarrBookId = parsePositiveInt(identifiers.readarrBookId);
  const foreignBookId = String(identifiers.foreignBookId || '').trim();

  if (!readarrBookId && !foreignBookId) return null;

  return db.prepare(`
    SELECT id, status, book_title, author, readarr_book_id, readarr_foreign_book_id
    FROM requests
    WHERE id != ?
    AND status NOT IN ('rejected', 'unavailable')
    AND (
      (? IS NOT NULL AND readarr_book_id = ?)
      OR
      (? != '' AND readarr_foreign_book_id = ?)
    )
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(
    currentRequestId || '',
    readarrBookId,
    readarrBookId,
    foreignBookId,
    foreignBookId
  );
}

async function notifyAdminLifecycle(eventType, request, details = {}) {
  if (!process.env.ADMIN_EMAIL) return;
  if (!request || !request.id) return;

  const safeBookTitle = escapeHtml(request.book_title);
  const safeAuthor = escapeHtml(request.author);
  const safeRequestId = escapeHtml(request.id);
  const safeDetails = escapeHtml(details.message || '');
  const cwaLink = details.cwaLink || request.cwa_book_link || buildCwaSearchLink(request.book_title, request.author) || '';

  let subject = '';
  let title = '';
  let content = '';

  if (eventType === 'completed') {
    subject = `Request Completed: ${request.id} - JcubHub Books`;
    title = 'Request Completed';
    content = `
      <h2 style="margin: 0 0 16px 0;">Request Completed</h2>
      <p style="margin: 0 0 8px 0;"><strong>ID:</strong> ${safeRequestId}</p>
      <p style="margin: 0 0 8px 0;"><strong>Book:</strong> ${safeBookTitle} by ${safeAuthor}</p>
      <p style="margin: 0 0 8px 0;"><strong>Requester:</strong> ${escapeHtml(request.requester_name)} (${escapeHtml(request.requester_email)})</p>
      ${cwaLink ? `<p style="margin: 16px 0 0 0;"><a href="${cwaLink}" style="color:#667eea;">Open in CWA</a></p>` : ''}
    `;
  } else if (eventType === 'readarr_failed') {
    subject = `Readarr Failure: ${request.id} - JcubHub Books`;
    title = 'Readarr Failure';
    content = `
      <h2 style="margin: 0 0 16px 0;">Readarr Add Failed</h2>
      <p style="margin: 0 0 8px 0;"><strong>ID:</strong> ${safeRequestId}</p>
      <p style="margin: 0 0 8px 0;"><strong>Book:</strong> ${safeBookTitle} by ${safeAuthor}</p>
      <p style="margin: 0 0 8px 0;"><strong>Error:</strong> ${safeDetails || 'Unknown error'}</p>
      <p style="margin: 0 0 8px 0;"><strong>Status:</strong> ${escapeHtml(request.status || 'unknown')}</p>
    `;
  } else if (eventType === 'mismatch_reported') {
    subject = `Potential Match Mismatch: ${request.id} - JcubHub Books`;
    title = 'Match Mismatch Reported';
    content = `
      <h2 style="margin: 0 0 16px 0;">User Reported Wrong Match</h2>
      <p style="margin: 0 0 8px 0;"><strong>ID:</strong> ${safeRequestId}</p>
      <p style="margin: 0 0 8px 0;"><strong>Book:</strong> ${safeBookTitle} by ${safeAuthor}</p>
      <p style="margin: 0 0 8px 0;"><strong>Reporter:</strong> ${escapeHtml(details.reporterEmail || request.requester_email || '')}</p>
      ${safeDetails ? `<p style="margin: 0 0 8px 0;"><strong>Notes:</strong> ${safeDetails}</p>` : ''}
    `;
  } else {
    return;
  }

  await sendEmail(process.env.ADMIN_EMAIL, subject, wrapEmailHtml(content, title));
}

async function getReadarrConfig(forceRefresh = false) {
  const now = Date.now();
  const cacheValid = !forceRefresh &&
    readarrConfigCache.fetchedAt > 0 &&
    (now - readarrConfigCache.fetchedAt) < READARR_CACHE_TTL_MS &&
    readarrConfigCache.qualityProfiles &&
    readarrConfigCache.metadataProfiles &&
    readarrConfigCache.rootFolders;

  if (cacheValid) {
    return readarrConfigCache;
  }

  const headers = { 'X-Api-Key': process.env.READARR_API_KEY };
  const [profilesResponse, metadataResponse, rootFolderResponse] = await Promise.all([
    fetchWithTimeout(buildReadarrApiUrl('/qualityprofile'), { headers }, 'Readarr quality profiles'),
    fetchWithTimeout(buildReadarrApiUrl('/metadataprofile'), { headers }, 'Readarr metadata profiles'),
    fetchWithTimeout(buildReadarrApiUrl('/rootfolder'), { headers }, 'Readarr root folders')
  ]);

  if (!profilesResponse.ok) {
    throw new Error(`Failed to fetch quality profiles from Readarr (HTTP ${profilesResponse.status})`);
  }
  if (!metadataResponse.ok) {
    throw new Error(`Failed to fetch metadata profiles from Readarr (HTTP ${metadataResponse.status})`);
  }
  if (!rootFolderResponse.ok) {
    throw new Error(`Failed to fetch root folders from Readarr (HTTP ${rootFolderResponse.status})`);
  }

  const qualityProfiles = await profilesResponse.json();
  const metadataProfiles = await metadataResponse.json();
  const rootFolders = await rootFolderResponse.json();

  if (!qualityProfiles.length) throw new Error('No quality profiles configured in Readarr');
  if (!metadataProfiles.length) throw new Error('No metadata profiles configured in Readarr');
  if (!rootFolders.length) throw new Error('No root folders configured in Readarr');

  readarrConfigCache.qualityProfiles = qualityProfiles;
  readarrConfigCache.metadataProfiles = metadataProfiles;
  readarrConfigCache.rootFolders = rootFolders;
  readarrConfigCache.fetchedAt = now;

  logger.info('Readarr configuration cached', {
    qualityProfiles: qualityProfiles.length,
    metadataProfiles: metadataProfiles.length,
    rootFolders: rootFolders.length
  });

  return readarrConfigCache;
}

function selectQualityProfileId(format, profiles) {
  const requestedFormat = String(format || 'any').toLowerCase();
  const formatEnvMap = {
    epub: process.env.READARR_QUALITY_PROFILE_ID_EPUB,
    pdf: process.env.READARR_QUALITY_PROFILE_ID_PDF,
    mobi: process.env.READARR_QUALITY_PROFILE_ID_MOBI,
    audiobook: process.env.READARR_QUALITY_PROFILE_ID_AUDIOBOOK,
    any: process.env.READARR_QUALITY_PROFILE_ID
  };

  const requestedId = parsePositiveInt(formatEnvMap[requestedFormat]) || parsePositiveInt(process.env.READARR_QUALITY_PROFILE_ID);
  if (requestedId && profiles.some(p => p.id === requestedId)) {
    return requestedId;
  }

  if (requestedId) {
    logger.warn('Configured quality profile not found, using first profile', { requestedId, format: requestedFormat });
  }

  return profiles[0].id;
}

function selectMetadataProfileId(format, profiles) {
  const requestedFormat = String(format || 'any').toLowerCase();
  const formatEnvMap = {
    epub: process.env.READARR_METADATA_PROFILE_ID_EPUB,
    pdf: process.env.READARR_METADATA_PROFILE_ID_PDF,
    mobi: process.env.READARR_METADATA_PROFILE_ID_MOBI,
    audiobook: process.env.READARR_METADATA_PROFILE_ID_AUDIOBOOK,
    any: process.env.READARR_METADATA_PROFILE_ID
  };

  const requestedId = parsePositiveInt(formatEnvMap[requestedFormat]) || parsePositiveInt(process.env.READARR_METADATA_PROFILE_ID);
  const looksAudiobook = profile => /\baudiobook\b|\baudio\b/i.test(String(profile?.name || ''));

  if (requestedId) {
    const requestedProfile = profiles.find(p => p.id === requestedId);
    if (requestedProfile) {
      if (requestedFormat !== 'audiobook' && looksAudiobook(requestedProfile)) {
        logger.warn('Configured metadata profile looks audiobook for non-audiobook request, auto-selecting safer profile', {
          requestedId,
          requestedFormat,
          profileName: requestedProfile.name
        });
      } else {
        return requestedId;
      }
    } else {
      logger.warn('Configured metadata profile not found, using automatic selection', { requestedId, requestedFormat });
    }
  }

  if (requestedFormat === 'audiobook') {
    const audiobookProfile = profiles.find(looksAudiobook);
    if (audiobookProfile) return audiobookProfile.id;
  } else {
    const nonAudioProfiles = profiles.filter(p => !looksAudiobook(p));
    if (nonAudioProfiles.length > 0) {
      const namedPreferred = nonAudioProfiles.find(p => /\b(ebook|e-book|standard|default|none|text)\b/i.test(String(p.name || '')));
      return (namedPreferred || nonAudioProfiles[0]).id;
    }
  }

  return profiles[0].id;
}

function selectRootFolderPath(format, rootFolders) {
  const requestedFormat = String(format || 'any').toLowerCase();
  const formatEnvMap = {
    epub: process.env.READARR_ROOT_FOLDER_EPUB,
    pdf: process.env.READARR_ROOT_FOLDER_PDF,
    mobi: process.env.READARR_ROOT_FOLDER_MOBI,
    audiobook: process.env.READARR_ROOT_FOLDER_AUDIOBOOK,
    any: process.env.READARR_ROOT_FOLDER
  };

  const requestedPath = formatEnvMap[requestedFormat] || process.env.READARR_ROOT_FOLDER;
  if (requestedPath && rootFolders.some(r => r.path === requestedPath)) {
    return requestedPath;
  }

  if (requestedPath) {
    logger.warn('Configured root folder not found, using first root folder', { requestedPath, format: requestedFormat });
  }

  return rootFolders[0].path;
}

function normalizeAuthorNameForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveExistingReadarrAuthorId(searchResult) {
  const directId =
    parsePositiveInt(searchResult?.authorId) ||
    parsePositiveInt(searchResult?.author?.id) ||
    parsePositiveInt(searchResult?.author?.authorId) ||
    parsePositiveInt(searchResult?.localAuthorId) ||
    0;

  if (directId > 0) return directId;
  if (!process.env.READARR_URL || !process.env.READARR_API_KEY) return 0;

  const foreignAuthorId = String(searchResult?.author?.foreignAuthorId || searchResult?.foreignAuthorId || '').trim();
  const authorName = String(searchResult?.author?.authorName || searchResult?.authorName || '').trim();
  const authorNameLastFirst = String(searchResult?.author?.authorNameLastFirst || '').trim();

  if (!foreignAuthorId && !authorName && !authorNameLastFirst) {
    return 0;
  }

  try {
    const toAuthorArray = payload => {
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.records)) return payload.records;
      return [];
    };

    const response = await fetchWithTimeout(buildReadarrApiUrl('/author?includeAllBooks=false'), {
      headers: {
        'X-Api-Key': process.env.READARR_API_KEY
      }
    }, 'Readarr author lookup');

    let authors = [];
    if (response.ok) {
      const payload = await response.json();
      authors = toAuthorArray(payload);
    }

    if (authors.length === 0 && (authorName || authorNameLastFirst || foreignAuthorId)) {
      const term = encodeURIComponent(authorName || authorNameLastFirst || foreignAuthorId);
      const lookupResponse = await fetchWithTimeout(buildReadarrApiUrl(`/author/lookup?term=${term}`), {
        headers: {
          'X-Api-Key': process.env.READARR_API_KEY
        }
      }, 'Readarr author lookup (fallback)');

      if (lookupResponse.ok) {
        const lookupPayload = await lookupResponse.json();
        authors = toAuthorArray(lookupPayload);
      }
    }

    if (authors.length === 0) return 0;

    if (foreignAuthorId) {
      const byForeignId = authors.find(author => String(author?.foreignAuthorId || '').trim() === foreignAuthorId);
      if (parsePositiveInt(byForeignId?.id)) {
        return parsePositiveInt(byForeignId.id);
      }
    }

    const candidateNames = [authorName, authorNameLastFirst]
      .map(normalizeAuthorNameForMatch)
      .filter(Boolean);

    if (candidateNames.length === 0) return 0;

    const ranked = authors
      .map(author => {
        const variants = [
          author?.authorName,
          author?.authorNameLastFirst,
          author?.sortName,
          author?.name
        ]
          .map(normalizeAuthorNameForMatch)
          .filter(Boolean);

        let score = 0;
        for (const candidate of candidateNames) {
          for (const variant of variants) {
            if (candidate && variant) {
              if (candidate === variant) score = Math.max(score, 100);
              else if (candidate.includes(variant) || variant.includes(candidate)) score = Math.max(score, 60);
            }
          }
        }

        return {
          id: parsePositiveInt(author?.id) || 0,
          score
        };
      })
      .filter(item => item.id > 0 && item.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.id || 0;
  } catch (error) {
    logger.warn('Could not resolve existing author id from Readarr', { error: error.message });
    return 0;
  }
}

function buildReadarrBookPayload(searchResult, effectiveFormat, readarrConfig, options = {}) {
  const { qualityProfiles, metadataProfiles, rootFolders } = readarrConfig;
  const qualityProfileId = selectQualityProfileId(effectiveFormat, qualityProfiles);
  const metadataProfileId = selectMetadataProfileId(effectiveFormat, metadataProfiles);
  const rootFolderPath = selectRootFolderPath(effectiveFormat, rootFolders);
  const shouldStripAudiobookHints = effectiveFormat !== 'audiobook' || !!options.stripAudiobookMetadata;
  const payloadMediaType = effectiveFormat === 'audiobook' ? 'audiobook' : 'ebook';
  const audiobookSelected = payloadMediaType === 'audiobook';
  const ebookSelected = !audiobookSelected;
  const stripAudiobookFieldRegex = /^(audiobookrootfolderpath|audiobookqualityprofileid|audiobookmetadataprofileid|narratorprofileid|availablenarrators|narratorentity|narratornames|iswantednarrator)$/i;

  const stripAudiobookOnlyFieldsDeep = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(stripAudiobookOnlyFieldsDeep);
      return;
    }

    for (const key of Object.keys(value)) {
      if (stripAudiobookFieldRegex.test(String(key || ''))) {
        delete value[key];
        continue;
      }

      const child = value[key];
      if (child && typeof child === 'object') {
        stripAudiobookOnlyFieldsDeep(child);
      }
    }
  };

  const sanitizedSearchResult = { ...searchResult };
  if (shouldStripAudiobookHints) {
    if (isAudioTaggedValue(sanitizedSearchResult.bookType)) delete sanitizedSearchResult.bookType;
    if (isAudioTaggedValue(sanitizedSearchResult.mediaType)) delete sanitizedSearchResult.mediaType;
    if (isAudioTaggedValue(sanitizedSearchResult.bookFormat)) delete sanitizedSearchResult.bookFormat;
    if (isAudioTaggedValue(sanitizedSearchResult.releaseType)) delete sanitizedSearchResult.releaseType;

    if (Array.isArray(sanitizedSearchResult.editions) && sanitizedSearchResult.editions.length > 0) {
      const editions = sanitizedSearchResult.editions.map(edition => ({ ...edition }));

      const isAudioEdition = edition => {
        const tags = [
          edition?.format,
          edition?.bookFormat,
          edition?.mediaType,
          edition?.releaseType,
          edition?.title,
          edition?.moniker
        ];
        const hasNarrator = Array.isArray(edition?.narratorNames) && edition.narratorNames.length > 0;
        const hasChapters = edition?.hasChapters === true || (Array.isArray(edition?.chapters) && edition.chapters.length > 0);
        return tags.some(isAudioTaggedValue) || hasNarrator || hasChapters;
      };

      const textEditions = editions.filter(edition => !isAudioEdition(edition));

      // Never drop every edition: Chaptarr needs at least one edition to satisfy ebook
      // metadata-profile filtering, otherwise the add fails with
      // "No ebook edition survived metadata profile filtering for this book".
      const pool = textEditions.length > 0 ? textEditions : editions;

      // Goodreads lookups routinely leave isEbook=false on plain text editions, which makes
      // Chaptarr refuse the ebook add. Promote a single preferred edition to a monitored
      // ebook (prefer an already-monitored edition, then the one with the most pages).
      const preferred =
        pool.find(edition => edition?.monitored) ||
        pool.slice().sort((a, b) => (Number(b?.pageCount) || 0) - (Number(a?.pageCount) || 0))[0] ||
        pool[0];

      pool.forEach(edition => {
        if (edition === preferred) {
          edition.isEbook = true;
          edition.monitored = true;
        } else {
          edition.monitored = false;
        }
      });

      sanitizedSearchResult.editions = pool;
    }
  }

  const safeAuthorFolder = (searchResult.author?.authorName || searchResult.authorName || 'Unknown')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const authorId =
    parsePositiveInt(options.resolvedAuthorId) ||
    parsePositiveInt(searchResult.authorId) ||
    parsePositiveInt(searchResult.author?.id) ||
    parsePositiveInt(searchResult.author?.authorId) ||
    parsePositiveInt(searchResult.localAuthorId) ||
    0;
  let authorForBook = null;

  // If Readarr/Chaptarr already knows this author, avoid posting full author payload.
  // That payload can include fork-specific audiobook-only fields and trigger false validation.
  if (searchResult.author && (authorId === 0 || options.forceFullAuthorPayload === true)) {
    const baseAuthor = {
      ...searchResult.author,
      path: `${rootFolderPath}/${safeAuthorFolder}`
    };

    authorForBook = {
      ...baseAuthor,
      qualityProfileId,
      metadataProfileId,
      rootFolderPath,
      ebookQualityProfileId: qualityProfileId,
      ebookMetadataProfileId: metadataProfileId,
      ebookRootFolderPath: rootFolderPath,
      audiobookMonitored: audiobookSelected,
      ebookMonitored: ebookSelected,
      // Track only the specific requested book, not the author's whole back catalogue.
      // (A value of 2 here = "monitor existing bibliography", which made every add import
      // the author's entire catalogue. The requested book is still monitored via its own
      // monitored:true flag below.)
      audiobookMonitorExisting: 0,
      audiobookMonitorFuture: false,
      ebookMonitorExisting: 0,
      ebookMonitorFuture: false,
      lastSelectedMediaType: payloadMediaType,
      monitored: true
    };

    if (ebookSelected) {
      delete authorForBook.audiobookRootFolderPath;
      delete authorForBook.audiobookQualityProfileId;
      delete authorForBook.audiobookMetadataProfileId;
      delete authorForBook.narratorProfileId;
      delete authorForBook.audiobookTags;
    }
  } else if (authorId > 0) {
    // Existing local author path: include a minimal author object to avoid fork null-reference issues
    // without sending audiobook-only profile/root fields.
    authorForBook = {
      id: authorId,
      authorName: searchResult.author?.authorName || searchResult.authorName || null,
      foreignAuthorId: searchResult.author?.foreignAuthorId || null,
      monitored: true,
      qualityProfileId,
      metadataProfileId,
      rootFolderPath,
      ebookQualityProfileId: qualityProfileId,
      ebookMetadataProfileId: metadataProfileId,
      ebookRootFolderPath: rootFolderPath,
      audiobookMonitored: audiobookSelected,
      ebookMonitored: ebookSelected,
      // Track only the specific requested book, not the author's whole back catalogue.
      // (A value of 2 here = "monitor existing bibliography", which made every add import
      // the author's entire catalogue. The requested book is still monitored via its own
      // monitored:true flag below.)
      audiobookMonitorExisting: 0,
      audiobookMonitorFuture: false,
      ebookMonitorExisting: 0,
      ebookMonitorFuture: false,
      lastSelectedMediaType: payloadMediaType
    };
  }

  const bookToAdd = {
    ...sanitizedSearchResult,
    qualityProfileId,
    metadataProfileId,
    rootFolderPath,
    ebookQualityProfileId: qualityProfileId,
    ebookMetadataProfileId: metadataProfileId,
    ebookRootFolderPath: rootFolderPath,
    authorId: authorId || 0,
    mediaType: payloadMediaType,
    monitored: true,
    audiobookMonitored: audiobookSelected,
    ebookMonitored: ebookSelected,
    anyEditionOk: true,
    addOptions: {
      addType: 'manual',
      searchForNewBook: true,
      // 'none' = when the author is created, do not bulk-monitor their existing catalogue.
      // Only the book being added (monitored:true) is tracked.
      monitor: 'none',
      addNewAuthor: authorId === 0 && !!authorForBook
    }
  };

  if (authorForBook) {
    bookToAdd.author = authorForBook;
  } else {
    delete bookToAdd.author;
  }

  if (ebookSelected) {
    delete bookToAdd.audiobookRootFolderPath;
    delete bookToAdd.audiobookQualityProfileId;
    delete bookToAdd.audiobookMetadataProfileId;
    delete bookToAdd.narratorProfileId;
    delete bookToAdd.availableNarrators;
    delete bookToAdd.narratorEntity;
    delete bookToAdd.narratorNames;
    delete bookToAdd.isWantedNarrator;
    stripAudiobookOnlyFieldsDeep(bookToAdd);
  }

  return {
    bookToAdd,
    qualityProfileId,
    metadataProfileId,
    rootFolderPath,
    authorId,
    payloadMediaType,
    shouldStripAudiobookHints
  };
}

async function addBookToReadarr(bookData) {
  if (!process.env.READARR_URL || !process.env.READARR_API_KEY) {
    return { success: false, error: 'Readarr not configured' };
  }

  try {
    const requestedFormat = String(bookData.format || 'any').toLowerCase();
    const effectiveFormat = String(bookData._formatOverrideForRetry || requestedFormat || 'any').toLowerCase();
    const skipAutoCandidateSwap = bookData._skipAutoCandidateSwap === true;
    const allowAudiobookCandidate = bookData._allowAudiobookCandidate === true;

    // First search for the book (use ISBN if available for accuracy)
    let searchResult = bookData._forcedSearchResult || await searchReadarr(
      bookData.bookTitle,
      bookData.author,
      bookData.isbn,
      {
        preferredFormat: effectiveFormat,
        excludeAudiobook: effectiveFormat !== 'audiobook'
      }
    );
    if (!searchResult) {
      if (effectiveFormat !== 'audiobook') {
        return {
          success: false,
          error: 'Chaptarr lookup returned only audiobook/companion candidates for this request. Manual review is required.'
        };
      }
      return { success: false, error: 'Book not found in Readarr' };
    }
    
    if (!skipAutoCandidateSwap && effectiveFormat !== 'audiobook' && isLikelyAudiobookResult(searchResult)) {
      const alternateSearchResult = await searchReadarr(
        bookData.bookTitle,
        bookData.author,
        bookData.isbn,
        {
          preferredFormat: effectiveFormat,
          excludeAudiobook: true,
          excludeForeignBookId: searchResult.foreignBookId || ''
        }
      );

      if (alternateSearchResult) {
        logger.info('Switched to non-audiobook search candidate before add', {
          bookTitle: bookData.bookTitle,
          previousForeignBookId: searchResult.foreignBookId || null,
          newForeignBookId: alternateSearchResult.foreignBookId || null
        });
        searchResult = alternateSearchResult;
      } else {
        const ebookBiasedSearch = await searchReadarr(
          bookData.bookTitle,
          bookData.author,
          bookData.isbn,
          {
            preferredFormat: effectiveFormat,
            excludeAudiobook: true,
            ignoreIsbn: true,
            searchTermOverride: `${bookData.author} ${bookData.bookTitle} ebook`
          }
        );

        if (ebookBiasedSearch) {
          searchResult = ebookBiasedSearch;
        } else {
          return {
            success: false,
            error: 'Chaptarr lookup returned only audiobook/companion candidates for this request. Manual review is required.'
          };
        }
      }
    }

    if (skipAutoCandidateSwap && effectiveFormat !== 'audiobook' && isLikelyAudiobookResult(searchResult) && !allowAudiobookCandidate) {
      return {
        success: false,
        error: 'Selected candidate appears to be audiobook content. Choose a different candidate or explicitly allow audiobook override.'
      };
    }

    const selectedBook = {
      title: searchResult.title || bookData.bookTitle || '',
      author: searchResult.author?.authorName || searchResult.authorName || bookData.author || '',
      releaseDate: searchResult.releaseDate || null,
      foreignBookId: searchResult.foreignBookId || null
    };

    const preflightConflict = findTrackedRequestConflict(bookData.requestId, {
      readarrBookId: parsePositiveInt(searchResult.id),
      foreignBookId: selectedBook.foreignBookId
    });
    if (preflightConflict) {
      return {
        success: false,
        duplicateDetected: true,
        duplicateOfRequestId: preflightConflict.id,
        error: `Book is already tracked by request ${preflightConflict.id}`
      };
    }

    // Debug: Log the structure of the search result
    logger.info('Readarr search result structure', {
      hasAuthor: !!searchResult.author,
      authorId: searchResult.author?.id,
      authorName: searchResult.author?.authorName,
      foreignAuthorId: searchResult.author?.foreignAuthorId,
      foreignBookId: searchResult.foreignBookId,
      bookTitle: searchResult.title,
      requestedFormat,
      effectiveFormat,
      editions: searchResult.editions?.length || 0
    });

    const readarrConfig = await getReadarrConfig();
    const resolvedAuthorId = await resolveExistingReadarrAuthorId(searchResult);
    const {
      bookToAdd,
      qualityProfileId,
      metadataProfileId,
      rootFolderPath
    } = buildReadarrBookPayload(searchResult, effectiveFormat, readarrConfig, {
      stripAudiobookMetadata: !!bookData._stripAudiobookMetadata,
      resolvedAuthorId,
      forceFullAuthorPayload: !!bookData._forceFullAuthorPayload
    });

    if (resolvedAuthorId > 0) {
      logger.info('Resolved existing Readarr author id for add payload', {
        bookTitle: bookData.bookTitle,
        resolvedAuthorId
      });
    }
    
    logger.info('Using Readarr settings', { qualityProfileId, metadataProfileId, rootFolderPath });

    logger.info('Adding book to Readarr', {
      bookTitle: bookData.bookTitle,
      qualityProfileId,
      metadataProfileId,
      rootFolderPath,
      foreignBookId: searchResult.foreignBookId,
      authorName: searchResult.author?.authorName || searchResult.authorName
    });

    // Debug: Log key fields of bookToAdd
    logger.info('Readarr book payload', {
      title: bookToAdd.title,
      foreignBookId: bookToAdd.foreignBookId,
      authorId: bookToAdd.authorId,
      authorName: bookToAdd.author?.authorName,
      authorForeignId: bookToAdd.author?.foreignAuthorId,
      authorQualityProfile: bookToAdd.author?.qualityProfileId,
      authorEbookQualityProfile: bookToAdd.author?.ebookQualityProfileId,
      authorEbookMetadataProfile: bookToAdd.author?.ebookMetadataProfileId,
      qualityProfileId: bookToAdd.qualityProfileId,
      metadataProfileId: bookToAdd.metadataProfileId,
      rootFolderPath: bookToAdd.rootFolderPath,
      mediaType: bookToAdd.mediaType,
      audiobookMonitored: bookToAdd.audiobookMonitored,
      ebookMonitored: bookToAdd.ebookMonitored,
      authorPath: bookToAdd.author?.path,
      monitored: bookToAdd.monitored,
      addOptions: bookToAdd.addOptions
    });

    // Add the book to Readarr
    const response = await fetchWithTimeout(buildReadarrApiUrl('/book'), {
      method: 'POST',
      headers: {
        'X-Api-Key': process.env.READARR_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bookToAdd)
    }, 'Readarr add book');

    if (response.ok) {
      const data = await response.json();
      logger.info('Book added to Readarr successfully', { 
        bookTitle: bookData.bookTitle,
        readarrBookId: data.id,
        readarrAuthorId: data.authorId,
        monitored: data.monitored,
        grabbed: data.grabbed,
        authorMonitored: data.author?.monitored
      });
      
      if (process.env.READARR_FORCE_COMMAND_SEARCH === 'true') {
        try {
          const searchCommand = {
            name: 'BookSearch',
            bookIds: [data.id]
          };
          const searchResponse = await fetchWithTimeout(buildReadarrApiUrl('/command'), {
            method: 'POST',
            headers: {
              'X-Api-Key': process.env.READARR_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(searchCommand)
          }, 'Readarr command search');
          if (searchResponse.ok) {
            logger.info('Book search triggered in Readarr', { bookId: data.id });
          } else {
            logger.warn('Failed to trigger book search', { status: searchResponse.status });
          }
        } catch (searchError) {
          logger.warn('Error triggering book search', { error: searchError.message });
        }
      }
      
      return {
        success: true,
        data,
        identifiers: {
          readarrBookId: data.id || null,
          readarrAuthorId: data.authorId || data.author?.id || searchResult.author?.id || null,
          foreignBookId: data.foreignBookId || searchResult.foreignBookId || null,
          foreignAuthorId: data.author?.foreignAuthorId || searchResult.author?.foreignAuthorId || null
        },
        selectedBook
      };
    } else {
      const errorText = await response.text();
      let errorMessage = 'Failed to add book';
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.message || errorData[0]?.errorMessage || JSON.stringify(errorData);
      } catch {
        errorMessage = errorText || `HTTP ${response.status}`;
      }
      logger.error('Readarr add book failed', { 
        bookTitle: bookData.bookTitle,
        status: response.status,
        error: errorMessage 
      });

      const nullReferenceError = /object reference not set to an instance of an object/i.test(errorMessage || '');
      if (nullReferenceError && !bookData._nullRefRetryAttempted) {
        logger.warn('Retrying Readarr add with full author payload after null-reference error', {
          bookTitle: bookData.bookTitle,
          foreignBookId: searchResult.foreignBookId || null,
          resolvedAuthorId
        });

        return addBookToReadarr({
          ...bookData,
          _forcedSearchResult: searchResult,
          _forceFullAuthorPayload: true,
          _stripAudiobookMetadata: true,
          _nullRefRetryAttempted: true
        });
      }

      const audiobookProfileError = /audiobook metadata profile is not set|audiobookrootfolderpath|selected root folder is not configured for audiobooks|audiobooks are disabled/i.test(errorMessage || '');
      const canRetryNonAudiobook = audiobookProfileError && !bookData._audioRetryAttempted;

      if (canRetryNonAudiobook) {
        logger.warn('Retrying Readarr add with non-audiobook candidate', {
          bookTitle: bookData.bookTitle,
          requestedFormat,
          effectiveFormat,
          previousForeignBookId: searchResult.foreignBookId || null
        });

        const retryFormat = effectiveFormat === 'audiobook' ? 'any' : effectiveFormat;

        const alternateSearchResult = await searchReadarr(
          bookData.bookTitle,
          bookData.author,
          bookData.isbn,
          {
            preferredFormat: retryFormat,
            excludeAudiobook: true,
            excludeForeignBookId: searchResult.foreignBookId || ''
          }
        );

        const previousForeignBookId = String(searchResult.foreignBookId || '').trim();
        const alternateForeignBookId = String(alternateSearchResult?.foreignBookId || '').trim();
        const hasDistinctAlternate = !!alternateSearchResult && (!!alternateForeignBookId || !!alternateSearchResult.id) &&
          (alternateForeignBookId !== previousForeignBookId || alternateSearchResult.id !== searchResult.id);

        if (hasDistinctAlternate) {
          return addBookToReadarr({
            ...bookData,
            _forcedSearchResult: alternateSearchResult,
            _formatOverrideForRetry: retryFormat,
            _stripAudiobookMetadata: true,
            _audioRetryAttempted: true
          });
        }

        const ebookBiasedSearch = await searchReadarr(
          bookData.bookTitle,
          bookData.author,
          bookData.isbn,
          {
            preferredFormat: retryFormat,
            excludeAudiobook: true,
            ignoreIsbn: true,
            searchTermOverride: `${bookData.author} ${bookData.bookTitle} ebook`
          }
        );

        if (ebookBiasedSearch) {
          return addBookToReadarr({
            ...bookData,
            _forcedSearchResult: ebookBiasedSearch,
            _formatOverrideForRetry: retryFormat,
            _stripAudiobookMetadata: true,
            _audioRetryAttempted: true
          });
        }

        return addBookToReadarr({
          ...bookData,
          _forcedSearchResult: searchResult,
          _formatOverrideForRetry: retryFormat,
          _stripAudiobookMetadata: true,
          _audioRetryAttempted: true
        });
      }

      return { success: false, error: errorMessage, statusCode: response.status };
    }
  } catch (error) {
    logger.error('Readarr add book error', { error: error.message });
    return { success: false, error: error.message };
  }
}

function setRequestStatus(requestId, status, now, notes = '') {
  db.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run(status, now, requestId);
  db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
    requestId,
    status,
    now,
    notes
  );
}

function persistReadarrResult(requestId, readarrResult, now) {
  if (readarrResult?.success) {
    const conflict = findTrackedRequestConflict(requestId, readarrResult.identifiers || {});
    if (conflict) {
      const conflictMessage = `Duplicate Readarr tracking blocked: already tracked by request ${conflict.id}`;
      db.prepare('UPDATE requests SET last_readarr_error = ?, updated_at = ? WHERE id = ?').run(
        conflictMessage,
        now,
        requestId
      );
      return {
        stored: false,
        conflict
      };
    }

    try {
      db.prepare(`
        UPDATE requests
        SET readarr_book_id = ?,
            readarr_author_id = ?,
            readarr_foreign_book_id = ?,
            readarr_foreign_author_id = ?,
            readarr_selected_title = ?,
            readarr_selected_author = ?,
            readarr_selected_release_date = ?,
            last_readarr_error = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(
        readarrResult.identifiers?.readarrBookId || null,
        readarrResult.identifiers?.readarrAuthorId || null,
        readarrResult.identifiers?.foreignBookId || null,
        readarrResult.identifiers?.foreignAuthorId || null,
        readarrResult.selectedBook?.title || null,
        readarrResult.selectedBook?.author || null,
        readarrResult.selectedBook?.releaseDate || null,
        now,
        requestId
      );
    } catch (e) {
      db.prepare('UPDATE requests SET last_readarr_error = ?, updated_at = ? WHERE id = ?').run(
        `Duplicate Readarr tracking blocked: ${e.message}`,
        now,
        requestId
      );
      return { stored: false };
    }
    return { stored: true };
  }

  db.prepare('UPDATE requests SET last_readarr_error = ?, updated_at = ? WHERE id = ?').run(
    readarrResult?.error || 'Unknown Readarr error',
    now,
    requestId
  );
  return { stored: false };
}

// ============================================
// Requester Auth Helpers (email-link)
// ============================================

function normalizeRequesterEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function generateMagicToken() {
  return crypto.randomBytes(32).toString('hex');
}

// SHA-256 hash for at-rest storage of tokens/sessions. Tokens are high-entropy
// random values, so a fast hash is appropriate (no need for bcrypt work factor).
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function hashOpaque(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

// Create a requester session row + return the raw session token (only returned once).
function createRequesterSession(email, req) {
  const now = new Date();
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(now.getTime() + requesterAuth.sessionTtlHours * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO requester_sessions (email, session_hash, expires_at, created_at, last_seen_at, user_agent_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    normalizeRequesterEmail(email),
    hashToken(sessionToken),
    expiresAt.toISOString(),
    now.toISOString(),
    now.toISOString(),
    hashOpaque(req?.get?.('User-Agent') || '')
  );
  return { sessionToken, expiresAt };
}

function setRequesterSessionCookie(res, sessionToken, expiresAt) {
  res.cookie(requesterAuth.cookieName, sessionToken, {
    httpOnly: true,
    secure: requesterAuth.cookieSecure,
    sameSite: 'lax',
    expires: expiresAt,
    path: '/'
  });
}

function clearRequesterSessionCookie(res) {
  res.clearCookie(requesterAuth.cookieName, {
    httpOnly: true,
    secure: requesterAuth.cookieSecure,
    sameSite: 'lax',
    path: '/'
  });
}

// Resolve the active (non-expired, non-revoked) session from the request cookie.
function readRequesterSessionFromCookie(req) {
  const cookies = parseCookies(req);
  const raw = cookies[requesterAuth.cookieName];
  if (!raw) return null;

  const row = db.prepare(`
    SELECT * FROM requester_sessions
    WHERE session_hash = ?
    LIMIT 1
  `).get(hashToken(raw));

  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;

  // Best-effort last-seen update (non-fatal).
  try {
    db.prepare('UPDATE requester_sessions SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  } catch (e) {
    // ignore
  }

  return { id: row.id, email: row.email, expiresAt: row.expires_at, rawToken: raw };
}

// Mint a magic-link login URL for use in outbound emails (auto sign-in).
// Returns null when no absolute base URL is available (PUBLIC_URL unset and no req).
function buildRequesterLoginLink(email, ttlMinutes, baseUrl) {
  const normalized = normalizeRequesterEmail(email);
  const base = String(baseUrl || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (!normalized || !base) return null;

  const token = generateMagicToken();
  const now = new Date();
  const ttl = ttlMinutes || requesterAuth.magicLinkTtlMin;
  const expiresAt = new Date(now.getTime() + ttl * 60 * 1000);
  db.prepare(`
    INSERT INTO requester_magic_links (email, token_hash, expires_at, created_at, ip_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(normalized, hashToken(token), expiresAt.toISOString(), now.toISOString(), null);

  return `${base}/requester/auth/callback?token=${encodeURIComponent(token)}`;
}

// Email CTA that logs the recipient straight into their dashboard. Notification emails are
// async, so these links use a longer TTL (default 7 days) than interactive sign-in links;
// they remain one-time-use. Returns '' when no base URL is configured (link omitted safely).
function dashboardEmailCta(email) {
  const ttl = parseInt(process.env.REQUESTER_EMAIL_LINK_TTL_MIN, 10) || (7 * 24 * 60);
  const url = buildRequesterLoginLink(email, ttl);
  if (!url) return '';
  return `
    <div style="text-align:center; margin: 18px 0 0 0;">
      <a href="${url}" style="display:inline-block; color:#667eea; text-decoration:none; font-size:14px; font-weight:600;">View all my requests in my dashboard →</a>
    </div>`;
}

// Send a "book ready"-style email to the requester and each subscriber, appending a
// PER-RECIPIENT auto-login dashboard link (never share one recipient's token with another).
async function sendReadyEmails(request, innerContent, subject, title) {
  const requesterNorm = normalizeRequesterEmail(request.requester_email);
  if (request.notify_on_complete) {
    const body = wrapEmailHtml(innerContent + dashboardEmailCta(request.requester_email), title);
    await sendEmail(request.requester_email, subject, body);
  }
  const subscribers = getRequestSubscribers(request.id);
  for (const sub of subscribers) {
    if (!sub.notify_on_complete) continue;
    const norm = normalizeRequesterEmail(sub.subscriber_email);
    if (!norm || norm === requesterNorm) continue;
    const body = wrapEmailHtml(innerContent + dashboardEmailCta(sub.subscriber_email), title);
    await sendEmail(sub.subscriber_email, subject, body);
  }
}

// Deterministic cleanup of expired/used auth artifacts (TASK-004).
function cleanupRequesterAuthArtifacts() {
  const now = new Date().toISOString();
  try {
    const links = db.prepare(
      'DELETE FROM requester_magic_links WHERE expires_at < ? OR used_at IS NOT NULL'
    ).run(now);
    const sessions = db.prepare(
      'DELETE FROM requester_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL'
    ).run(now);
    const caches = db.prepare(
      'DELETE FROM book_metadata_cache WHERE expires_at < ?'
    ).run(now);
    logger.debug('Requester auth cleanup complete', {
      magicLinksDeleted: links.changes,
      sessionsDeleted: sessions.changes,
      metadataCacheDeleted: caches.changes
    });
  } catch (error) {
    logger.warn('Requester auth cleanup failed', { error: error.message });
  }
}

// ----------------------------------------------------------------------
// Requester auth provider abstraction (GUD-001).
// `emailLinkProvider` is the current implementation. A future `authentikProvider`
// can implement the same interface without changing requester API contracts.
// ----------------------------------------------------------------------

const emailLinkProvider = {
  name: 'email_link',

  // Always returns generic outcome; never reveals whether the email is known (SEC-004).
  startLogin(email, req) {
    const normalized = normalizeRequesterEmail(email);
    const token = generateMagicToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + requesterAuth.magicLinkTtlMin * 60 * 1000);

    db.prepare(`
      INSERT INTO requester_magic_links (email, token_hash, expires_at, created_at, ip_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      normalized,
      hashToken(token),
      expiresAt.toISOString(),
      now.toISOString(),
      hashOpaque(req?.ip || '')
    );

    return { token, expiresAt, email: normalized };
  },

  // Validate a one-time token, mark it used, and create a session.
  verifyLink(token, req) {
    const tokenHash = hashToken(token);
    const row = db.prepare('SELECT * FROM requester_magic_links WHERE token_hash = ? LIMIT 1').get(tokenHash);

    if (!row) return { ok: false, reason: 'invalid' };
    if (row.used_at) return { ok: false, reason: 'used' };
    if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };

    db.prepare('UPDATE requester_magic_links SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);

    const { sessionToken, expiresAt } = createRequesterSession(row.email, req);
    return { ok: true, email: row.email, sessionToken, expiresAt };
  },

  getSession(req) {
    return readRequesterSessionFromCookie(req);
  },

  logout(req) {
    const session = readRequesterSessionFromCookie(req);
    if (!session) return false;
    db.prepare('UPDATE requester_sessions SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), session.id);
    return true;
  }
};

function selectRequesterAuthProvider() {
  // Only email_link is implemented today; Authentik is documented for later wiring.
  if (requesterAuth.provider === 'authentik') {
    logger.warn('REQUESTER_AUTH_PROVIDER=authentik selected but not yet implemented; using email_link');
  }
  return emailLinkProvider;
}

const requesterAuthProvider = selectRequesterAuthProvider();

// Middleware: authenticate requester session (isolated from admin JWT middleware).
function authenticateRequesterSession(req, res, next) {
  const session = requesterAuthProvider.getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Requester authentication required' });
  }
  req.requester = { email: session.email, sessionId: session.id };
  next();
}

// ============================================
// JWT Middleware
// ============================================

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// ============================================
// Public Routes
// ============================================

// Health check with debug info
app.get('/api/health', (req, res) => {
  const requestCount = db.prepare('SELECT COUNT(*) as count FROM requests').get();
  const pendingCount = db.prepare("SELECT COUNT(*) as count FROM requests WHERE status = 'pending'").get();
  
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    uptime: Math.floor(process.uptime()) + 's',
    integrations: {
      email: !!(process.env.ZOHO_EMAIL && process.env.ZOHO_PASSWORD),
      turnstile: !!process.env.TURNSTILE_SECRET_KEY,
      readarr: !!(process.env.READARR_URL && process.env.READARR_API_KEY),
      cwa: !!(process.env.CWA_URL && process.env.CWA_USERNAME && process.env.CWA_PASSWORD)
    },
    database: {
      totalRequests: requestCount.count,
      pendingRequests: pendingCount.count
    }
  });
});

// Submit book request (public)
app.post('/api/book-request',
  requestLimiter,
  [
    body('requesterName').trim().notEmpty().withMessage('Name is required'),
    body('requesterEmail').isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('bookTitle').trim().notEmpty().withMessage('Book title is required'),
    body('author').trim().notEmpty().withMessage('Author is required'),
    body('isbn').optional({ values: 'falsy' }).trim().matches(/^[\dXx-]{10,17}$/).withMessage('Invalid ISBN format'),
    body('format').isIn(['epub', 'pdf', 'mobi', 'audiobook', 'any']).withMessage('Invalid format'),
    body('notes').optional().trim(),
    body('notifyOnComplete').optional().isBoolean(),
    body('turnstileToken').notEmpty().withMessage('Captcha verification required'),
    body('metadataSource').optional({ values: 'falsy' }).trim().isLength({ max: 40 }),
    body('metadataSourceId').optional({ values: 'falsy' }).trim().isLength({ max: 200 }),
    body('coverUrl').optional({ values: 'falsy' }).trim().isLength({ max: 1000 }),
    body('summary').optional({ values: 'falsy' }).trim().isLength({ max: 6000 }),
    body('publisher').optional({ values: 'falsy' }).trim().isLength({ max: 300 }),
    body('publishedYear').optional({ values: 'falsy' }).toInt().isInt({ min: 0, max: 3000 }),
    body('isbn10').optional({ values: 'falsy' }).trim().isLength({ max: 13 }),
    body('isbn13').optional({ values: 'falsy' }).trim().isLength({ max: 17 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { requesterName, requesterEmail, bookTitle, author, isbn, format, notes, notifyOnComplete, turnstileToken } = req.body;

    // Normalize + sanitize optional metadata (SEC-005). External text is never trusted raw.
    const meta = {
      source: req.body.metadataSource ? bookMetadata.sanitizeText(req.body.metadataSource, 40) : null,
      sourceId: req.body.metadataSourceId ? bookMetadata.sanitizeText(req.body.metadataSourceId, 200) : null,
      coverUrl: req.body.coverUrl ? bookMetadata.safeUrl(req.body.coverUrl) : null,
      summary: req.body.summary ? bookMetadata.sanitizeText(req.body.summary, 6000) : null,
      publisher: req.body.publisher ? bookMetadata.sanitizeText(req.body.publisher, 300) : null,
      publishedYear: bookMetadata.pickYear(req.body.publishedYear),
      isbn10: (() => {
        const v = bookMetadata.digitsOnlyIsbn(req.body.isbn10);
        return v && String(v).length === 10 ? v : null;
      })(),
      isbn13: (() => {
        const v = bookMetadata.digitsOnlyIsbn(req.body.isbn13);
        return v && String(v).length === 13 ? v : null;
      })()
    };
    const safeRequesterName = escapeHtml(requesterName);
    const safeRequesterEmail = escapeHtml(requesterEmail);
    const safeBookTitle = escapeHtml(bookTitle);
    const safeAuthor = escapeHtml(author);
    const safeFormat = escapeHtml(format);
    const safeNotes = escapeHtml(notes || 'None');

    // Verify Turnstile
    const isValidCaptcha = await verifyTurnstile(turnstileToken);
    if (!isValidCaptcha) {
      return res.status(400).json({ error: 'Captcha verification failed. Please try again.' });
    }

    // Check CWA availability FIRST - if available, don't create request
    const cwaCheck = await checkCwaAvailability(bookTitle, author, isbn || '');
    
    if (cwaCheck.available) {
      logger.info('Book already available in CWA, blocking request', { bookTitle, author });
      return res.status(200).json({ 
        alreadyAvailable: true,
        message: 'Great news! This book is already available in our library.',
        bookLink: cwaCheck.bookLink || buildCwaSearchLink(bookTitle, author)
      });
    }

    // If a matching active request already exists, subscribe this user instead of creating a duplicate
    const existingRequest = db.prepare(`
      SELECT *
      FROM requests
      WHERE status IN ('pending', 'approved', 'searching', 'downloading')
      AND LOWER(TRIM(book_title)) = LOWER(TRIM(?))
      AND LOWER(TRIM(author)) = LOWER(TRIM(?))
      ORDER BY created_at DESC
      LIMIT 1
    `).get(bookTitle, author);

    if (existingRequest) {
      let statusToken = existingRequest.status_token;
      if (!statusToken) {
        statusToken = generateStatusToken();
        db.prepare('UPDATE requests SET status_token = ?, updated_at = ? WHERE id = ?').run(
          statusToken,
          new Date().toISOString(),
          existingRequest.id
        );
      }

      const alreadyRequester = String(existingRequest.requester_email || '').toLowerCase() === String(requesterEmail || '').toLowerCase();
      const alreadySubscribed = db.prepare(`
        SELECT 1
        FROM request_subscribers
        WHERE request_id = ?
        AND LOWER(subscriber_email) = LOWER(?)
        LIMIT 1
      `).get(existingRequest.id, requesterEmail);
      const addedAsSubscriber = !alreadyRequester && !alreadySubscribed;

      if (addedAsSubscriber) {
        addSubscriberToRequest(existingRequest.id, requesterName, requesterEmail, notifyOnComplete !== false);
      }

      if (addedAsSubscriber && notifyOnComplete !== false) {
        const subscriptionEmailContent = `
          <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f;">Subscribed to Request Updates</h2>
          <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${safeRequesterName},</p>
          <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">
            A matching request already exists for "<strong style="color: #667eea;">${safeBookTitle}</strong>" by ${safeAuthor}.
          </p>
          <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">
            You have been subscribed and will receive updates as the request status changes.
          </p>
          <div style="background: #f0f0ff; border-left: 4px solid #667eea; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
            <p style="margin: 0; font-size: 14px; color: #86868b;">Request ID</p>
            <p style="margin: 5px 0 0 0; font-size: 18px; font-weight: 600; color: #667eea;">${existingRequest.id}</p>
          </div>
        `;
        await sendEmail(requesterEmail, 'Subscribed to Book Request Updates - JcubHub Books', wrapEmailHtml(subscriptionEmailContent, 'Subscribed to Request Updates'));
      }

      return res.status(200).json({
        success: true,
        subscribedToExisting: true,
        requestId: existingRequest.id,
        statusToken,
        message: alreadyRequester || alreadySubscribed
          ? 'You are already subscribed to this request.'
          : 'A matching request already exists. You have been subscribed for updates.',
        status: existingRequest.status
      });
    }

    const now = new Date().toISOString();
    const id = generateId();
    const statusToken = generateStatusToken();
    const readarrUrl = generateReadarrUrl(author, bookTitle, isbn);
    const initialStatus = automation.autoApprove ? 'approved' : 'pending';

    // Insert request (cwa_available is false since we checked above)
    db.prepare(`
      INSERT INTO requests (
        id, requester_name, requester_email, book_title, author, isbn, format, notes, status,
        notify_on_complete, readarr_url, status_token, cwa_available, created_at, updated_at,
        metadata_source, metadata_source_id, cover_url, summary, publisher, published_year, isbn10, isbn13
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, requesterName, requesterEmail, bookTitle, author, isbn || null, format, notes || '', initialStatus,
      notifyOnComplete !== false ? 1 : 0, readarrUrl, statusToken, 0, now, now,
      meta.source, meta.sourceId, meta.coverUrl, meta.summary, meta.publisher, meta.publishedYear, meta.isbn10, meta.isbn13
    );

    addSubscriberToRequest(id, requesterName, requesterEmail, notifyOnComplete !== false);

    // Add initial status history
    db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
      id, initialStatus, now, automation.autoApprove ? 'Request submitted and auto-approved' : 'Request submitted'
    );

    // Send confirmation email if opted in
    if (notifyOnComplete !== false) {
      const emailContent = `
        <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f;">Book Request Received</h2>
        <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${safeRequesterName},</p>
        <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">
          We've received your request for "<strong style="color: #667eea;">${safeBookTitle}</strong>" by ${safeAuthor}.
        </p>
        <div style="background: #f0f0ff; border-left: 4px solid #667eea; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
          <p style="margin: 0; font-size: 14px; color: #86868b;">Request ID</p>
          <p style="margin: 5px 0 0 0; font-size: 18px; font-weight: 600; color: #667eea;">${id}</p>
        </div>
        <p style="margin: 20px 0 0 0; font-size: 16px; color: #1d1d1f;">We'll notify you when your request is processed.</p>
        <p style="margin: 30px 0 0 0; font-size: 14px; color: #86868b;">Best regards,<br><strong style="color: #1d1d1f;">JcubHub Books</strong></p>
      `;
      await sendEmail(requesterEmail, 'Book Request Received - JcubHub Books', wrapEmailHtml(emailContent + dashboardEmailCta(requesterEmail), 'Book Request Received'));
    }

    // Send admin notification
    if (process.env.ADMIN_EMAIL) {
      const adminEmailContent = `
        <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f;">📬 New Book Request</h2>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin: 20px 0;">
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5;">
              <span style="color: #86868b; font-size: 14px;">Request ID</span><br>
              <span style="color: #667eea; font-size: 16px; font-weight: 600;">${id}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5;">
              <span style="color: #86868b; font-size: 14px;">From</span><br>
              <span style="color: #1d1d1f; font-size: 16px;">${safeRequesterName} (${safeRequesterEmail})</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5;">
              <span style="color: #86868b; font-size: 14px;">Book</span><br>
              <span style="color: #1d1d1f; font-size: 16px;"><strong>${safeBookTitle}</strong> by ${safeAuthor}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5;">
              <span style="color: #86868b; font-size: 14px;">Format</span><br>
              <span style="color: #1d1d1f; font-size: 16px;">${safeFormat.toUpperCase()}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5;">
              <span style="color: #86868b; font-size: 14px;">Notes</span><br>
              <span style="color: #1d1d1f; font-size: 16px;">${safeNotes}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0;">
              <span style="color: #86868b; font-size: 14px;">CWA Available</span><br>
              <span style="color: #dc2626; font-size: 16px; font-weight: 600;">✗ No</span>
            </td>
          </tr>
        </table>
        ${readarrUrl ? `
        <a href="${readarrUrl}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; font-size: 14px; margin-top: 10px;">Search in Readarr →</a>
        ` : ''}
      `;
      await sendEmail(process.env.ADMIN_EMAIL, 'New Book Request - JcubHub Books', wrapEmailHtml(adminEmailContent, 'New Book Request'));
    }

    res.status(201).json({
      success: true,
      requestId: id,
      statusToken,
      message: 'Your book request has been submitted successfully!',
      cwaAvailable: false
    });

    logger.info('Book request submitted', { 
      requestId: id, 
      bookTitle, 
      author, 
      format,
      cwaAvailable: false,
      notifyOnComplete: notifyOnComplete !== false
    });

    // Auto-add to Readarr if enabled (book is not in CWA since we checked above)
    if (automation.autoAddToReadarr && integrations.readarr) {
      try {
        logger.info('Auto-adding to Readarr...', { requestId: id, bookTitle, isbn });
        const readarrResult = await addBookToReadarr({ requestId: id, bookTitle, author, isbn, format });
        const persistOutcome = persistReadarrResult(id, readarrResult, new Date().toISOString());
        if (readarrResult.success && persistOutcome?.conflict) {
          readarrResult.success = false;
          readarrResult.error = `Duplicate tracking prevented (existing request ${persistOutcome.conflict.id})`;
        }
        
        if (readarrResult.success && persistOutcome?.stored) {
          const updateNow = new Date().toISOString();
          setRequestStatus(id, 'searching', updateNow, 'Automatically added to Readarr');
          logger.info('Auto-added to Readarr successfully', { requestId: id });
        } else {
          const failureReason = persistOutcome?.conflict
            ? `Duplicate tracking prevented (existing request ${persistOutcome.conflict.id})`
            : (readarrResult.error || 'Unknown Readarr error');
          logger.warn('Auto-add to Readarr failed', { requestId: id, error: failureReason });
          const requestForNotify = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
          await notifyAdminLifecycle('readarr_failed', requestForNotify, { message: failureReason });
        }
      } catch (error) {
        logger.error('Auto-add to Readarr error', { requestId: id, error: error.message });
      }
    }
  }
);

// Public request status lookup
app.post('/api/request-status',
  requestLimiter,
  [
    body('requestId').optional().trim(),
    body('email').optional().isEmail().normalizeEmail(),
    body('statusToken').optional().trim().isLength({ min: 12 }).withMessage('Invalid status token')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { requestId, email, statusToken } = req.body;
    if (!statusToken && !(requestId && email)) {
      return res.status(400).json({ error: 'Provide statusToken or requestId + email' });
    }

    const request = findPublicRequest(requestId, email, statusToken);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const normalizedStoredLink = request.cwa_book_link
      ? (normalizeCwaBookLink(request.cwa_book_link) || request.cwa_book_link)
      : null;
    let cwaBookLink = normalizedStoredLink;
    if (request.cwa_book_link && normalizedStoredLink !== request.cwa_book_link) {
      updateRequestCwaState(request.id, new Date().toISOString(), !!request.cwa_available, normalizedStoredLink);
    }
    const shouldResolveCwaLink = (request.cwa_available || request.status === 'completed') && !cwaBookLink;
    if (shouldResolveCwaLink) {
      const resolved = await checkCwaAvailability(request.book_title, request.author, request.isbn || '');
      if (resolved.available && resolved.bookLink) {
        cwaBookLink = resolved.bookLink;
        updateRequestCwaState(request.id, new Date().toISOString(), true, cwaBookLink);
      } else {
        cwaBookLink = buildCwaSearchLink(request.book_title, request.author);
      }
    }

    const history = db.prepare(`
      SELECT status, changed_at, notes
      FROM status_history
      WHERE request_id = ?
      ORDER BY changed_at DESC
      LIMIT 25
    `).all(request.id);

    const isSubscriber = !!db.prepare(`
      SELECT 1 FROM request_subscribers
      WHERE request_id = ?
      AND LOWER(subscriber_email) = LOWER(?)
      LIMIT 1
    `).get(request.id, email || '');

    res.json({
      id: request.id,
      statusToken: request.status_token || null,
      status: request.status,
      createdAt: request.created_at,
      updatedAt: request.updated_at,
      bookTitle: request.book_title,
      author: request.author,
      format: request.format,
      notes: request.notes || '',
      cwaAvailable: !!request.cwa_available || !!cwaBookLink || request.status === 'completed',
      downloadLink: cwaBookLink || null,
      monitoring: (request.readarr_book_id || request.readarr_foreign_book_id || request.readarr_selected_title) ? {
        readarrBookId: request.readarr_book_id || null,
        foreignBookId: request.readarr_foreign_book_id || null,
        selectedTitle: request.readarr_selected_title || request.book_title,
        selectedAuthor: request.readarr_selected_author || request.author,
        selectedReleaseDate: request.readarr_selected_release_date || null
      } : null,
      isSubscriber,
      history
    });
  }
);

// Public feedback endpoint (end-user verification)
app.post('/api/request-feedback',
  requestLimiter,
  [
    body('requestId').optional().trim(),
    body('email').optional().isEmail().normalizeEmail(),
    body('statusToken').optional().trim().isLength({ min: 12 }).withMessage('Invalid status token'),
    body('feedbackType').isIn(['match_confirmed', 'match_mismatch']).withMessage('Invalid feedback type'),
    body('message').optional().trim().isLength({ max: 1000 }).withMessage('Message too long')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { requestId, email, statusToken, feedbackType, message } = req.body;
    if (!statusToken && !(requestId && email)) {
      return res.status(400).json({ error: 'Provide statusToken or requestId + email' });
    }

    const request = findPublicRequest(requestId, email, statusToken);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const reporter = String(email || request.requester_email || '').trim();
    const now = new Date().toISOString();
    const cleanMessage = String(message || '').trim();
    const feedbackNote = feedbackType === 'match_confirmed'
      ? `End-user confirmed monitored match${reporter ? ` (${reporter})` : ''}${cleanMessage ? `: ${cleanMessage}` : ''}`
      : `End-user reported potential wrong monitored match${reporter ? ` (${reporter})` : ''}${cleanMessage ? `: ${cleanMessage}` : ''}`;

    db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
      request.id,
      request.status,
      now,
      feedbackNote
    );

    if (feedbackType === 'match_mismatch') {
      await notifyAdminLifecycle('mismatch_reported', request, {
        reporterEmail: reporter,
        message: cleanMessage
      });
    }

    res.json({ success: true, message: 'Feedback saved' });
  }
);

// Public send-to-eReader action (email a direct CWA link)
app.post('/api/request-send-ereader',
  requestLimiter,
  [
    body('requestId').optional().trim(),
    body('email').optional().isEmail().normalizeEmail(),
    body('statusToken').optional().trim().isLength({ min: 12 }).withMessage('Invalid status token'),
    body('ereaderEmail').isEmail().normalizeEmail().withMessage('Valid eReader email is required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!ereader.enabled) {
      return res.status(400).json({ error: 'Send-to-eReader is disabled by admin' });
    }
    if (!transporter) {
      return res.status(503).json({ error: 'Email transport is not configured' });
    }

    const { requestId, email, statusToken, ereaderEmail } = req.body;
    if (!statusToken && !(requestId && email)) {
      return res.status(400).json({ error: 'Provide statusToken or requestId + email' });
    }

    const request = findPublicRequest(requestId, email, statusToken);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (!(request.cwa_available || request.status === 'completed')) {
      return res.status(409).json({ error: 'Book is not available yet' });
    }

    const domain = String(ereaderEmail || '').split('@')[1]?.toLowerCase() || '';
    if (ereader.allowedDomains.length > 0 && !ereader.allowedDomains.includes(domain)) {
      return res.status(400).json({
        error: `Unsupported eReader email domain. Allowed domains: ${ereader.allowedDomains.join(', ')}`
      });
    }

    const cwaLink = await resolveCwaLinkForRequest(request);
    if (!cwaLink) {
      return res.status(409).json({ error: 'No download link available yet' });
    }
    updateRequestCwaState(request.id, new Date().toISOString(), true, cwaLink);

    const safeBookTitle = escapeHtml(request.book_title);
    const safeAuthor = escapeHtml(request.author);
    const safeRequestId = escapeHtml(request.id);
    const ereaderContent = `
      <h2 style="margin: 0 0 16px 0;">Your Book Link</h2>
      <p style="margin: 0 0 10px 0;"><strong>${safeBookTitle}</strong> by ${safeAuthor}</p>
      <p style="margin: 0 0 12px 0;">Request ID: ${safeRequestId}</p>
      <p style="margin: 0 0 16px 0;">Open this link from your eReader browser or reading app:</p>
      <p style="margin: 0;"><a href="${cwaLink}" style="color:#667eea;">${escapeHtml(cwaLink)}</a></p>
    `;

    await sendEmail(ereaderEmail, `Book Link: ${request.book_title} - JcubHub Books`, wrapEmailHtml(ereaderContent, 'Send to eReader'));

    const now = new Date().toISOString();
    db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
      request.id,
      request.status,
      now,
      `Sent to eReader (${ereaderEmail}) by ${email || 'status-token user'}`
    );

    res.json({ success: true, sentTo: ereaderEmail, downloadLink: cwaLink });
  }
);

// ============================================
// Requester Dashboard Routes (email-link auth)
// ============================================

// Rate limits for requester auth + metadata (SEC-003). Keyed by IP; auth-start also
// dedupes by normalized email inside the handler.
const requesterAuthStartLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `${req.ip}:${normalizeRequesterEmail(req.body?.email || '')}`,
  // We intentionally key by IP+email; silence the IPv6-keyGenerator advisory.
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many login attempts. Please try again later.' }
});

const requesterAuthVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many verification attempts. Please try again later.' }
});

const metadataSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many metadata searches. Please slow down.' }
});

// Shape a request row into the requester dashboard item contract (metadata-rich).
function buildRequesterDashboardItem(request) {
  const normalizedStored = request.cwa_book_link
    ? (normalizeCwaBookLink(request.cwa_book_link) || request.cwa_book_link)
    : null;
  const available = !!request.cwa_available || request.status === 'completed';
  let readyLink = normalizedStored;
  if (!readyLink && available) {
    readyLink = buildCwaSearchLink(request.book_title, request.author);
  }

  const latest = db.prepare(`
    SELECT status, changed_at, notes
    FROM status_history
    WHERE request_id = ?
    ORDER BY changed_at DESC
    LIMIT 1
  `).get(request.id);

  // Legacy/manually-entered requests have no stored cover. Derive one from any ISBN via
  // Open Library covers (the dashboard falls back to a placeholder via onerror if missing).
  const anyIsbn = request.isbn13 || request.isbn10 || request.isbn;
  const coverUrl = request.cover_url
    || (anyIsbn ? `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(String(anyIsbn).replace(/[^0-9Xx]/g, ''))}-M.jpg?default=false` : null);

  return {
    id: request.id,
    bookTitle: request.book_title,
    author: request.author,
    status: request.status,
    format: request.format,
    createdAt: request.created_at,
    updatedAt: request.updated_at,
    statusToken: request.status_token || null,
    cwaBookLink: normalizedStored,
    readyLink: readyLink || null,
    available,
    latestNote: latest?.notes || null,
    metadata: {
      source: request.metadata_source || null,
      sourceId: request.metadata_source_id || null,
      coverUrl,
      summary: request.summary || null,
      publisher: request.publisher || null,
      publishedYear: request.published_year || null,
      isbn10: request.isbn10 || null,
      isbn13: request.isbn13 || null,
      isbn: request.isbn || null
    },
    flags: {
      hasCover: !!coverUrl,
      hasSummary: !!request.summary,
      missingIsbn: !(request.isbn13 || request.isbn10 || request.isbn)
    }
  };
}

// Start login: stores hashed one-time token + sends magic link. Always 200 (SEC-004).
app.post('/api/requester/auth/start',
  requesterAuthStartLimiter,
  [body('email').isEmail().normalizeEmail().withMessage('Valid email is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const email = normalizeRequesterEmail(req.body.email);
    const genericResponse = {
      success: true,
      message: 'If that email has any requests, a sign-in link has been sent.'
    };

    try {
      const { token, expiresAt } = requesterAuthProvider.startLogin(email, req);

      const baseUrl = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      const verifyUrl = `${baseUrl}/requester/auth/callback?token=${encodeURIComponent(token)}`;
      const ttlMin = requesterAuth.magicLinkTtlMin;

      const emailContent = `
        <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f;">Sign in to your dashboard</h2>
        <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">
          Click the button below to access your book requests dashboard. This link expires in ${ttlMin} minutes and can only be used once.
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">Open My Dashboard →</a>
        </div>
        <p style="margin: 20px 0 0 0; font-size: 13px; color: #86868b;">If you didn't request this, you can safely ignore this email.</p>
      `;
      // Fire-and-forget email so response timing does not leak account existence.
      sendEmail(email, 'Your JcubHub Books sign-in link', wrapEmailHtml(emailContent, 'Sign in')).catch(() => {});

      logger.info('Requester auth start', { emailHash: hashOpaque(email)?.slice(0, 12), expiresAt });

      // Test-only token echo (never in production).
      if (requesterAuth.exposeToken) {
        return res.status(200).json({ ...genericResponse, devToken: token });
      }
      return res.status(200).json(genericResponse);
    } catch (error) {
      logger.error('Requester auth start error', { error: error.message });
      // Still return generic success to avoid enumeration / error-based probing.
      return res.status(200).json(genericResponse);
    }
  }
);

// Verify magic link, set session cookie, redirect to dashboard.
function handleRequesterVerify(req, res) {
  const token = String(req.query.token || '').trim();
  if (!token) {
    return res.status(400).send('Missing token');
  }

  const result = requesterAuthProvider.verifyLink(token, req);
  if (!result.ok) {
    // Redirect back to login with an error reason for user-friendly messaging.
    return res.redirect(`/requester/login?error=${encodeURIComponent(result.reason || 'invalid')}`);
  }

  setRequesterSessionCookie(res, result.sessionToken, result.expiresAt);
  logger.info('Requester auth verified', { emailHash: hashOpaque(result.email)?.slice(0, 12) });
  return res.redirect('/requester/dashboard');
}

app.get('/api/requester/auth/verify', requesterAuthVerifyLimiter, handleRequesterVerify);

// Logout: revoke current session and clear cookie.
app.post('/api/requester/auth/logout', (req, res) => {
  try {
    requesterAuthProvider.logout(req);
  } catch (error) {
    logger.warn('Requester logout error', { error: error.message });
  }
  clearRequesterSessionCookie(res);
  res.json({ success: true });
});

// Current requester identity (used by the dashboard shell).
app.get('/api/requester/me', authenticateRequesterSession, (req, res) => {
  res.json({
    email: req.requester.email,
    authProvider: requesterAuthProvider.name,
    sessionTtlHours: requesterAuth.sessionTtlHours
  });
});

// Dashboard aggregate + items for the authenticated requester email.
app.get('/api/requester/dashboard', authenticateRequesterSession, (req, res) => {
  const email = req.requester.email;

  const rows = db.prepare(`
    SELECT * FROM requests
    WHERE LOWER(requester_email) = LOWER(?)
    ORDER BY updated_at DESC
  `).all(email);

  const counts = {
    pending: 0, approved: 0, searching: 0, downloading: 0,
    completed: 0, rejected: 0, unavailable: 0
  };
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(counts, row.status)) {
      counts[row.status] += 1;
    }
  }

  res.json({
    email,
    total: rows.length,
    counts,
    items: rows.map(buildRequesterDashboardItem)
  });
});

// Find a request owned by the session email (ownership enforced — RISK-003).
function findRequesterOwnedRequest(requestId, email) {
  return db.prepare(`
    SELECT * FROM requests
    WHERE id = ? AND LOWER(requester_email) = LOWER(?)
  `).get(requestId, email);
}

// Full status timeline for an owned request.
app.get('/api/requester/requests/:id/history',
  authenticateRequesterSession,
  [param('id').trim().notEmpty()],
  (req, res) => {
    const request = findRequesterOwnedRequest(req.params.id, req.requester.email);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const history = db.prepare(`
      SELECT status, changed_at, notes
      FROM status_history
      WHERE request_id = ?
      ORDER BY changed_at DESC
    `).all(request.id);

    res.json({ id: request.id, status: request.status, history });
  }
);

// Resolve the freshest direct CWA book link and redirect (opens the book itself, not a
// search page, whenever CWA returns a confident match). Owned requests only.
app.get('/api/requester/requests/:id/open',
  authenticateRequesterSession,
  [param('id').trim().notEmpty()],
  async (req, res) => {
    const request = findRequesterOwnedRequest(req.params.id, req.requester.email);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const link = await resolveCwaLinkForRequest(request);
    if (!link) {
      return res.status(409).json({ error: 'No download link available yet' });
    }
    // Persist the (possibly upgraded to direct) link for future fast loads.
    updateRequestCwaState(request.id, new Date().toISOString(), true, link);
    return res.redirect(link);
  }
);

// Send-to-eReader, scoped to ownership (reuses CWA link resolution logic).
app.post('/api/requester/requests/:id/send-ereader',
  authenticateRequesterSession,
  [
    param('id').trim().notEmpty(),
    body('ereaderEmail').isEmail().normalizeEmail().withMessage('Valid eReader email is required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    if (!ereader.enabled) {
      return res.status(400).json({ error: 'Send-to-eReader is disabled by admin' });
    }
    if (!transporter) {
      return res.status(503).json({ error: 'Email transport is not configured' });
    }

    const request = findRequesterOwnedRequest(req.params.id, req.requester.email);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (!(request.cwa_available || request.status === 'completed')) {
      return res.status(409).json({ error: 'Book is not available yet' });
    }

    const ereaderEmail = req.body.ereaderEmail;
    const domain = String(ereaderEmail || '').split('@')[1]?.toLowerCase() || '';
    if (ereader.allowedDomains.length > 0 && !ereader.allowedDomains.includes(domain)) {
      return res.status(400).json({
        error: `Unsupported eReader email domain. Allowed domains: ${ereader.allowedDomains.join(', ')}`
      });
    }

    const cwaLink = await resolveCwaLinkForRequest(request);
    if (!cwaLink) {
      return res.status(409).json({ error: 'No download link available yet' });
    }
    updateRequestCwaState(request.id, new Date().toISOString(), true, cwaLink);

    const safeBookTitle = escapeHtml(request.book_title);
    const safeAuthor = escapeHtml(request.author);
    const ereaderContent = `
      <h2 style="margin: 0 0 16px 0;">Your Book Link</h2>
      <p style="margin: 0 0 10px 0;"><strong>${safeBookTitle}</strong> by ${safeAuthor}</p>
      <p style="margin: 0 0 16px 0;">Open this link from your eReader browser or reading app:</p>
      <p style="margin: 0;"><a href="${cwaLink}" style="color:#667eea;">${escapeHtml(cwaLink)}</a></p>
    `;
    await sendEmail(ereaderEmail, `Book Link: ${request.book_title} - JcubHub Books`, wrapEmailHtml(ereaderContent, 'Send to eReader'));

    db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
      request.id,
      request.status,
      new Date().toISOString(),
      `Sent to eReader (${ereaderEmail}) by requester ${req.requester.email}`
    );

    res.json({ success: true, sentTo: ereaderEmail, downloadLink: cwaLink });
  }
);

// Feedback (confirm/report match), scoped to ownership.
app.post('/api/requester/requests/:id/feedback',
  authenticateRequesterSession,
  [
    param('id').trim().notEmpty(),
    body('feedbackType').isIn(['match_confirmed', 'match_mismatch']).withMessage('Invalid feedback type'),
    body('message').optional().trim().isLength({ max: 1000 }).withMessage('Message too long')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const request = findRequesterOwnedRequest(req.params.id, req.requester.email);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const { feedbackType, message } = req.body;
    const reporter = req.requester.email;
    const cleanMessage = String(message || '').trim();
    const feedbackNote = feedbackType === 'match_confirmed'
      ? `End-user confirmed monitored match (${reporter})${cleanMessage ? `: ${cleanMessage}` : ''}`
      : `End-user reported potential wrong monitored match (${reporter})${cleanMessage ? `: ${cleanMessage}` : ''}`;

    db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
      request.id,
      request.status,
      new Date().toISOString(),
      feedbackNote
    );

    if (feedbackType === 'match_mismatch') {
      await notifyAdminLifecycle('mismatch_reported', request, { reporterEmail: reporter, message: cleanMessage });
    }

    res.json({ success: true, message: 'Feedback saved' });
  }
);

// CSV export of requester-owned rows (deterministic column order).
app.get('/api/requester/dashboard/export.csv', authenticateRequesterSession, (req, res) => {
  const email = req.requester.email;
  const rows = db.prepare(`
    SELECT * FROM requests
    WHERE LOWER(requester_email) = LOWER(?)
    ORDER BY created_at DESC
  `).all(email);

  const columns = [
    'id', 'book_title', 'author', 'status', 'format',
    'isbn13', 'isbn10', 'isbn', 'publisher', 'published_year',
    'created_at', 'updated_at', 'cwa_book_link'
  ];

  const escapeCsv = (value) => {
    const str = value === null || value === undefined ? '' : String(value);
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map(col => escapeCsv(row[col])).join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="my-book-requests.csv"');
  res.send(lines.join('\r\n'));
});

// ============================================
// Metadata Search Routes
// ============================================

function getCachedMetadata(queryKey) {
  const row = db.prepare('SELECT payload, expires_at FROM book_metadata_cache WHERE query_hash = ?').get(queryKey);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

function setCachedMetadata(queryKey, query, payload) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + metadata.cacheTtlMs);
  db.prepare(`
    INSERT INTO book_metadata_cache (query_hash, query, payload, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(query_hash) DO UPDATE SET
      payload = excluded.payload,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `).run(queryKey, query, JSON.stringify(payload), now.toISOString(), expiresAt.toISOString());
}

// Metadata search for the requester form (cached + rate-limited).
app.get('/api/metadata/search', metadataSearchLimiter, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }

  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 10, 25));
  const queryKey = hashToken(`${metadata.primary}:${limit}:${query.toLowerCase()}`);

  const cached = getCachedMetadata(queryKey);
  if (cached) {
    return res.json({ query, cached: true, results: cached });
  }

  try {
    const results = await bookMetadata.searchBookMetadata(query, {
      limit,
      config: metadata,
      logger
    });
    setCachedMetadata(queryKey, query, results);
    res.json({ query, cached: false, results });
  } catch (error) {
    logger.error('Metadata search error', { query, error: error.message });
    res.status(502).json({ error: 'Metadata provider unavailable', results: [] });
  }
});

// ============================================
// Authentication Routes
// ============================================

// Admin login
app.post('/api/auth/login',
  [
    body('username').trim().notEmpty(),
    body('password').notEmpty()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, password } = req.body;

    const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      logger.warn('Failed login attempt', { username, ip: req.ip });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });

    logger.info('Admin login successful', { username, ip: req.ip });
    res.json({ token, username: user.username });
  }
);

// Verify token
app.get('/api/auth/verify', authenticateToken, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// ============================================
// Admin Routes (Protected)
// ============================================

// Get all requests
app.get('/api/admin/requests', authenticateToken, (req, res) => {
  const { status, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM requests';
  let countQuery = 'SELECT COUNT(*) as total FROM requests';
  const params = [];

  if (status) {
    query += ' WHERE status = ?';
    countQuery += ' WHERE status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';

  const requests = db.prepare(query).all(...params, parseInt(limit), parseInt(offset));
  const { total } = db.prepare(countQuery).get(...params);

  res.json({
    requests,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  });
});

// Get single request with history
app.get('/api/admin/requests/:id', authenticateToken, (req, res) => {
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  const history = db.prepare('SELECT * FROM status_history WHERE request_id = ? ORDER BY changed_at DESC').all(req.params.id);
  const subscribers = getRequestSubscribers(req.params.id);

  res.json({ ...request, statusHistory: history, subscribers });
});

// Update request status
app.patch('/api/admin/requests/:id',
  authenticateToken,
  [
    body('status').optional().isIn(['pending', 'approved', 'searching', 'downloading', 'completed', 'rejected', 'unavailable']),
    body('notes').optional().trim(),
    body('addToReadarr').optional().isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const { status, notes, addToReadarr } = req.body;
    if (!status && !addToReadarr) {
      return res.status(400).json({ error: 'Either status or addToReadarr must be provided' });
    }
    const effectiveTargetStatus = status || request.status;
    if (addToReadarr && ['completed', 'rejected', 'unavailable'].includes(effectiveTargetStatus)) {
      return res.status(409).json({ error: `Cannot add a ${effectiveTargetStatus} request to Readarr` });
    }

    let now = new Date().toISOString();
    let readarrResult = null;
    let notificationStatus = null;
    let appliedStatus = request.status;

    if (status && (!addToReadarr || status !== 'searching')) {
      setRequestStatus(req.params.id, status, now, notes || '');
      appliedStatus = status;
      notificationStatus = status;
    }

    if (addToReadarr) {
      readarrResult = await addBookToReadarr({
        requestId: req.params.id,
        bookTitle: request.book_title,
        author: request.author,
        isbn: request.isbn,
        format: request.format
      });

      now = new Date().toISOString();
      const persistOutcome = persistReadarrResult(req.params.id, readarrResult, now);
      if (readarrResult.success && persistOutcome?.conflict) {
        readarrResult.success = false;
        readarrResult.error = `Duplicate tracking prevented (existing request ${persistOutcome.conflict.id})`;
        readarrResult.duplicateDetected = true;
        readarrResult.duplicateOfRequestId = persistOutcome.conflict.id;
      }

      if (readarrResult.success && persistOutcome?.stored) {
        setRequestStatus(req.params.id, 'searching', now, 'Automatically added to Readarr');
        appliedStatus = 'searching';
        notificationStatus = 'searching';
        logger.info('Auto-added to Readarr', { requestId: req.params.id, bookTitle: request.book_title });
      } else {
        const readarrFailure = persistOutcome?.conflict
          ? `Duplicate tracking prevented (existing request ${persistOutcome.conflict.id})`
          : (readarrResult.error || 'Unknown Readarr error');
        logger.warn('Failed to auto-add to Readarr', { requestId: req.params.id, error: readarrFailure });
        await notifyAdminLifecycle('readarr_failed', request, { message: readarrFailure });

        if (status === 'searching') {
          const fallbackStatus = request.status === 'pending' ? 'approved' : request.status;
          if (fallbackStatus !== appliedStatus) {
            setRequestStatus(req.params.id, fallbackStatus, now, 'Readarr add failed; kept previous workflow status');
            appliedStatus = fallbackStatus;
            notificationStatus = fallbackStatus;
          }
        }

        db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
          req.params.id,
          appliedStatus,
          now,
          `Readarr add failed: ${readarrFailure}`
        );
      }
    }

      // Send notification emails based on effective status
      if (notificationStatus) {
        const cwaLink = await resolveCwaLinkForRequest(request);
        if (notificationStatus === 'completed') {
          updateRequestCwaState(req.params.id, now, true, cwaLink);
        }
        const safeRequesterName = escapeHtml(request.requester_name);
        const safeBookTitle = escapeHtml(request.book_title);
        const safeAuthor = escapeHtml(request.author);
        let emailContent = null;
        let emailSubject = null;
        let emailTitle = null;
        
        if (notificationStatus === 'completed') {
          emailSubject = 'Your Book is Ready! - JcubHub Books';
          emailTitle = 'Your Book is Ready';
          emailContent = `
            <div style="text-align: center; margin-bottom: 30px;">
              <span style="font-size: 48px;">🎉</span>
            </div>
            <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Great News! Your Book is Ready</h2>
            <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${safeRequesterName},</p>
            <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
              Your requested book "<strong style="color: #667eea;">${safeBookTitle}</strong>" by ${safeAuthor} is now available in our library!
            </p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${cwaLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">Download from Library →</a>
            </div>
            <p style="margin: 30px 0 0 0; font-size: 14px; color: #86868b; text-align: center;">Happy reading!<br><strong style="color: #1d1d1f;">JcubHub Books</strong></p>
          `;
        } else if (notificationStatus === 'approved' || notificationStatus === 'searching') {
          emailSubject = 'Book Request Approved - JcubHub Books';
          emailTitle = 'Request Approved';
          emailContent = `
            <div style="text-align: center; margin-bottom: 30px;">
              <span style="font-size: 48px;">✅</span>
            </div>
            <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Your Request Has Been Approved!</h2>
            <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${safeRequesterName},</p>
            <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
              Great news! Your request for "<strong style="color: #667eea;">${safeBookTitle}</strong>" by ${safeAuthor} has been approved.
            </p>
            <div style="background: #f0f0ff; border-left: 4px solid #667eea; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
              <p style="margin: 0; font-size: 14px; color: #86868b;">What happens next?</p>
              <p style="margin: 5px 0 0 0; font-size: 16px; color: #1d1d1f;">We're now searching for your book. You'll receive another email when it's ready to download.</p>
            </div>
            <p style="margin: 30px 0 0 0; font-size: 14px; color: #86868b; text-align: center;">Thank you for your patience!<br><strong style="color: #1d1d1f;">JcubHub Books</strong></p>
          `;
        } else if (notificationStatus === 'rejected') {
          emailSubject = 'Book Request Update - JcubHub Books';
          emailTitle = 'Request Update';
          const rejectionReason = escapeHtml(notes || 'The book could not be added to our library at this time.');
          emailContent = `
            <div style="text-align: center; margin-bottom: 30px;">
              <span style="font-size: 48px;">📚</span>
            </div>
            <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Update on Your Book Request</h2>
            <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${safeRequesterName},</p>
            <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
              We've reviewed your request for "<strong style="color: #667eea;">${safeBookTitle}</strong>" by ${safeAuthor}.
            </p>
            <div style="background: #fef2f2; border-left: 4px solid #ef4444; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
              <p style="margin: 0; font-size: 14px; color: #991b1b;">Unfortunately, we're unable to fulfill this request:</p>
              <p style="margin: 5px 0 0 0; font-size: 16px; color: #1d1d1f;">${rejectionReason}</p>
            </div>
            <p style="margin: 20px 0 0 0; font-size: 16px; color: #1d1d1f;">Feel free to submit another request for a different book anytime.</p>
            <p style="margin: 30px 0 0 0; font-size: 14px; color: #86868b; text-align: center;"><strong style="color: #1d1d1f;">JcubHub Books</strong></p>
          `;
        } else if (notificationStatus === 'unavailable') {
          emailSubject = 'Book Unavailable - JcubHub Books';
          emailTitle = 'Book Unavailable';
          emailContent = `
            <div style="text-align: center; margin-bottom: 30px;">
              <span style="font-size: 48px;">😔</span>
            </div>
            <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Book Currently Unavailable</h2>
            <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${safeRequesterName},</p>
            <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
              We searched extensively but couldn't find "<strong style="color: #667eea;">${safeBookTitle}</strong>" by ${safeAuthor} in any of our sources.
            </p>
            <div style="background: #fffbeb; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
              <p style="margin: 0; font-size: 16px; color: #1d1d1f;">This could be because the book is very new, rare, or has limited digital availability. We'll keep trying if new sources become available.</p>
            </div>
            <p style="margin: 20px 0 0 0; font-size: 16px; color: #1d1d1f;">Feel free to check back or request another book.</p>
            <p style="margin: 30px 0 0 0; font-size: 14px; color: #86868b; text-align: center;"><strong style="color: #1d1d1f;">JcubHub Books</strong></p>
          `;
        }
        
        if (emailContent && emailSubject) {
          try {
            // Per-recipient auto-login dashboard CTA appended inside sendReadyEmails.
            await sendReadyEmails(request, emailContent, emailSubject, emailTitle);
            logger.info('Status notification emails sent', { requestId: req.params.id, status: notificationStatus });
          } catch (emailError) {
            logger.error('Failed to send status notification email', { error: emailError.message, requestId: req.params.id });
          }
        }

        if (notificationStatus === 'completed') {
          await notifyAdminLifecycle('completed', { ...request, id: req.params.id, cwa_book_link: cwaLink }, { cwaLink });
        } else if (notificationStatus === 'rejected' || notificationStatus === 'unavailable') {
          await notifyAdminLifecycle('readarr_failed', { ...request, id: req.params.id }, {
            message: notes || `Status changed to ${notificationStatus}`
          });
        }
      }

    logger.info('Request status updated', {
      requestId: req.params.id,
      oldStatus: request.status,
      newStatus: appliedStatus,
      admin: req.user.username,
      addedToReadarr: readarrResult?.success || false
    });

    const updated = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
    res.json({ 
      ...updated, 
      readarrResult: readarrResult 
    });
  }
);

// Delete request
app.delete('/api/admin/requests/:id', authenticateToken, (req, res) => {
  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  const result = db.prepare('DELETE FROM requests WHERE id = ?').run(req.params.id);
  
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Request not found' });
  }

  logger.info('Request deleted', { 
    requestId: req.params.id, 
    bookTitle: request?.book_title,
    admin: req.user.username
  });
  
  res.json({ success: true, message: 'Request deleted' });
});

// Get dashboard stats
app.get('/api/admin/stats', authenticateToken, (req, res) => {
  const stats = {
    total: db.prepare('SELECT COUNT(*) as count FROM requests').get().count,
    pending: db.prepare("SELECT COUNT(*) as count FROM requests WHERE status = 'pending'").get().count,
    searching: db.prepare("SELECT COUNT(*) as count FROM requests WHERE status = 'searching'").get().count,
    completed: db.prepare("SELECT COUNT(*) as count FROM requests WHERE status = 'completed'").get().count,
    rejected: db.prepare("SELECT COUNT(*) as count FROM requests WHERE status IN ('rejected', 'unavailable')").get().count,
    recentRequests: db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 5').all(),
    automation: automation
  };

  res.json(stats);
});

app.patch('/api/admin/automation',
  authenticateToken,
  [
    body('autoApprove').optional().isBoolean(),
    body('autoAddToReadarr').optional().isBoolean()
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const hasAutoApprove = Object.prototype.hasOwnProperty.call(req.body, 'autoApprove');
    const hasAutoAdd = Object.prototype.hasOwnProperty.call(req.body, 'autoAddToReadarr');
    if (!hasAutoApprove && !hasAutoAdd) {
      return res.status(400).json({ error: 'No automation settings provided' });
    }

    const updated = updateAutomationSettings({
      autoApprove: hasAutoApprove ? req.body.autoApprove === true : undefined,
      autoAddToReadarr: hasAutoAdd ? req.body.autoAddToReadarr === true : undefined
    });

    logger.info('Admin updated automation settings', {
      admin: req.user?.username,
      autoApprove: updated.autoApprove,
      autoAddToReadarr: updated.autoAddToReadarr
    });

    res.json({ success: true, automation: updated });
  }
);

// ============================================
// Batch Operations
// ============================================

// Process all pending requests (add to Readarr)
app.post('/api/admin/batch/process-pending', authenticateToken, async (req, res) => {
  const pendingRequests = db.prepare("SELECT * FROM requests WHERE status = 'pending'").all();
  
  if (pendingRequests.length === 0) {
    return res.json({ success: true, processed: 0, message: 'No pending requests' });
  }

  const results = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    errors: []
  };

  for (const request of pendingRequests) {
      results.processed++;
      
      try {
        const readarrResult = await addBookToReadarr({
          requestId: request.id,
          bookTitle: request.book_title,
          author: request.author,
          isbn: request.isbn,
          format: request.format
        });

        const now = new Date().toISOString();
        const persistOutcome = persistReadarrResult(request.id, readarrResult, now);
        if (readarrResult.success && persistOutcome?.conflict) {
          readarrResult.success = false;
          readarrResult.error = `Duplicate tracking prevented (existing request ${persistOutcome.conflict.id})`;
        }
        
        if (readarrResult.success && persistOutcome?.stored) {
          setRequestStatus(request.id, 'searching', now, 'Batch processed - Added to Readarr');
          results.succeeded++;
        } else {
          const readarrFailure = persistOutcome?.conflict
            ? `Duplicate tracking prevented (existing request ${persistOutcome.conflict.id})`
            : (readarrResult.error || 'Unknown Readarr error');
          // Mark as approved but note the error
          setRequestStatus(request.id, 'approved', now, `Approved but Readarr add failed: ${readarrFailure}`);
          results.failed++;
          results.errors.push({ id: request.id, book: request.book_title, error: readarrFailure });
          await notifyAdminLifecycle('readarr_failed', request, { message: readarrFailure });
        }
      } catch (error) {
        results.failed++;
        results.errors.push({ id: request.id, book: request.book_title, error: error.message });
        await notifyAdminLifecycle('readarr_failed', request, { message: error.message });
      }
    }

  logger.info('Batch process completed', { 
    admin: req.user.username, 
    ...results 
  });

  res.json({ 
    success: true, 
    ...results,
    message: `Processed ${results.processed} requests: ${results.succeeded} added to Readarr, ${results.failed} failed`
  });
});

// Mark all searching/downloading as completed (for manual batch completion)
app.post('/api/admin/batch/complete-all', authenticateToken, async (req, res) => {
  const inProgress = db.prepare("SELECT * FROM requests WHERE status IN ('searching', 'downloading')").all();
  
  if (inProgress.length === 0) {
    return res.json({ success: true, completed: 0, message: 'No in-progress requests' });
  }

  const now = new Date().toISOString();
  let completedCount = 0;

  for (const request of inProgress) {
    const cwaLink = await resolveCwaLinkForRequest(request);
    updateRequestCwaState(request.id, now, true, cwaLink);
    db.prepare("UPDATE requests SET status = 'completed', updated_at = ? WHERE id = ?").run(now, request.id);
    db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
      request.id, 'completed', now, 'Batch completed by admin'
    );

    // Notify requester (if opted in) and any subscribers
    if (request.notify_on_complete || (await getRequestSubscribers(request.id)).length > 0) {
      const safeRequesterName = escapeHtml(request.requester_name);
      const safeBookTitle = escapeHtml(request.book_title);
      const safeAuthor = escapeHtml(request.author);
      const emailContent = `
        <div style="text-align: center; margin-bottom: 30px;">
          <span style="font-size: 48px;">🎉</span>
        </div>
        <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Great News! Your Book is Ready</h2>
        <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${safeRequesterName},</p>
        <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
          Your requested book "<strong style="color: #667eea;">${safeBookTitle}</strong>" by ${safeAuthor} is now available!
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${cwaLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">Download from Library →</a>
        </div>
      `;
      await sendReadyEmails(request, emailContent, 'Your Book is Ready! - JcubHub Books', 'Your Book is Ready');
    }

    await notifyAdminLifecycle('completed', { ...request, cwa_book_link: cwaLink }, { cwaLink });
    
    completedCount++;
  }

  logger.info('Batch complete all', { admin: req.user.username, completedCount });
  res.json({ success: true, completed: completedCount });
});

// ============================================
// Readarr Integration Routes
// ============================================

// Get Readarr queue/status
app.get('/api/admin/readarr/queue', authenticateToken, async (req, res) => {
  if (!process.env.READARR_URL || !process.env.READARR_API_KEY) {
    return res.status(400).json({ error: 'Readarr not configured' });
  }

  try {
    // Get download queue
    const queueResponse = await fetchWithTimeout(buildReadarrApiUrl('/queue?includeBook=true'), {
      headers: { 'X-Api-Key': process.env.READARR_API_KEY }
    }, 'Readarr queue');
    
    // Get recent history (last 20 completed)
    const historyResponse = await fetchWithTimeout(buildReadarrApiUrl('/history?pageSize=20&sortKey=date&sortDirection=descending'), {
      headers: { 'X-Api-Key': process.env.READARR_API_KEY }
    }, 'Readarr history');

    const queue = queueResponse.ok ? await queueResponse.json() : { records: [] };
    const history = historyResponse.ok ? await historyResponse.json() : { records: [] };

    res.json({
      queue: queue.records || [],
      queueCount: queue.totalRecords || 0,
      recentDownloads: (history.records || []).filter(h => h.eventType === 'downloadFolderImported').slice(0, 10)
    });
  } catch (error) {
    logger.error('Readarr queue fetch error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch Readarr queue' });
  }
});

// Search book in Readarr
app.get('/api/admin/readarr/search', authenticateToken, async (req, res) => {
  const { title, author } = req.query;
  
  if (!title && !author) {
    return res.status(400).json({ error: 'Title or author required' });
  }

  const result = await searchReadarr(title || '', author || '');
  res.json({ results: result ? [result] : [] });
});

// Downloadable API snapshot for troubleshooting Readarr/Chaptarr compatibility
app.post('/api/admin/readarr/snapshot', authenticateToken, async (req, res) => {
  const {
    title,
    author,
    isbn,
    format,
    requestId,
    includeLookup,
    forceRefreshConfig
  } = req.body || {};

  if (!process.env.READARR_URL || !process.env.READARR_API_KEY) {
    return res.status(400).json({ success: false, error: 'Readarr not configured' });
  }

  let sourceRequest = null;
  if (requestId) {
    sourceRequest = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
    if (!sourceRequest) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }
  }

  const effectiveTitle = String(sourceRequest?.book_title || title || '').trim();
  const effectiveAuthor = String(sourceRequest?.author || author || '').trim();
  const effectiveIsbn = String(sourceRequest?.isbn || isbn || '').trim();
  const effectiveFormat = String(sourceRequest?.format || format || 'any').toLowerCase();
  const shouldIncludeLookup = includeLookup !== false && !!effectiveTitle && !!effectiveAuthor;

  const headers = { 'X-Api-Key': process.env.READARR_API_KEY };

  const safeFetchJson = async (endpoint, label) => {
    const url = buildReadarrApiUrl(endpoint);
    try {
      const response = await fetchWithTimeout(url, { headers }, label);
      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = null;
      }

      return {
        ok: response.ok,
        statusCode: response.status,
        statusText: response.statusText,
        data,
        bodyPreview: rawText?.substring(0, 1200) || ''
      };
    } catch (error) {
      return {
        ok: false,
        statusCode: 0,
        statusText: 'request_error',
        error: error.message
      };
    }
  };

  const [
    statusInfo,
    routesInfo,
    qualityProfilesInfo,
    metadataProfilesInfo,
    rootFoldersInfo
  ] = await Promise.all([
    safeFetchJson('/system/status', 'Readarr system status snapshot'),
    safeFetchJson('/system/routes', 'Readarr system routes snapshot'),
    safeFetchJson('/qualityprofile', 'Readarr quality profiles snapshot'),
    safeFetchJson('/metadataprofile', 'Readarr metadata profiles snapshot'),
    safeFetchJson('/rootfolder', 'Readarr root folders snapshot')
  ]);

  const qualityProfiles = Array.isArray(qualityProfilesInfo.data) ? qualityProfilesInfo.data : [];
  const metadataProfiles = Array.isArray(metadataProfilesInfo.data) ? metadataProfilesInfo.data : [];
  const rootFolders = Array.isArray(rootFoldersInfo.data) ? rootFoldersInfo.data : [];

  const fallbackConfig = {
    qualityProfiles,
    metadataProfiles,
    rootFolders
  };

  let readarrConfig = fallbackConfig;
  try {
    readarrConfig = await getReadarrConfig(forceRefreshConfig === true);
  } catch (error) {
    logger.warn('Could not refresh cached Readarr config for snapshot, using direct API response', { error: error.message });
  }

  const qualityProfileId = (readarrConfig.qualityProfiles?.length || 0) > 0
    ? selectQualityProfileId(effectiveFormat, readarrConfig.qualityProfiles)
    : null;
  const metadataProfileId = (readarrConfig.metadataProfiles?.length || 0) > 0
    ? selectMetadataProfileId(effectiveFormat, readarrConfig.metadataProfiles)
    : null;
  const rootFolderPath = (readarrConfig.rootFolders?.length || 0) > 0
    ? selectRootFolderPath(effectiveFormat, readarrConfig.rootFolders)
    : null;

  const routesRaw = routesInfo.data;
  const routePaths = Array.isArray(routesRaw)
    ? routesRaw
        .map(route => {
          if (typeof route === 'string') return route;
          if (route && typeof route.path === 'string') return route.path;
          if (route && typeof route.route === 'string') return route.route;
          return null;
        })
        .filter(Boolean)
    : [];

  const routeSummary = {
    total: routePaths.length,
    sample: routePaths.slice(0, 50),
    capabilities: {
      hasBookLookup: routePaths.some(path => /\/book\/lookup/i.test(path)),
      hasBookAdd: routePaths.some(path => /\/book$/i.test(path)),
      hasQualityProfiles: routePaths.some(path => /\/qualityprofile/i.test(path)),
      hasMetadataProfiles: routePaths.some(path => /\/metadataprofile/i.test(path)),
      hasRootFolders: routePaths.some(path => /\/rootfolder/i.test(path)),
      hasCommand: routePaths.some(path => /\/command/i.test(path))
    }
  };

  let lookup = {
    included: false,
    query: null,
    totalResults: 0,
    topResults: [],
    payloadPreview: null
  };

  if (shouldIncludeLookup) {
    const rawQuery = effectiveIsbn || `${effectiveAuthor} ${effectiveTitle}`;
    const lookupInfo = await safeFetchJson(`/book/lookup?term=${encodeURIComponent(rawQuery)}`, 'Readarr lookup snapshot');

    const rawBooks = Array.isArray(lookupInfo.data) ? lookupInfo.data : [];
    const normalizedSearchTitle = effectiveTitle.toLowerCase().trim();
    const normalizedSearchAuthor = effectiveAuthor.toLowerCase().trim();

    const scoredEntries = rawBooks.map(book => {
      const details = scoreReadarrLookupResult(book, normalizedSearchTitle, normalizedSearchAuthor, effectiveFormat);
      return {
        book,
        score: details.score,
        likelyAudiobook: details.likelyAudiobook,
        scoreBreakdown: details.scoreBreakdown
      };
    }).sort((a, b) => b.score - a.score);

    let payloadPreview = null;
    if (scoredEntries[0] && readarrConfig.qualityProfiles?.length && readarrConfig.metadataProfiles?.length && readarrConfig.rootFolders?.length) {
      const resolvedAuthorId = await resolveExistingReadarrAuthorId(scoredEntries[0].book);
      const payload = buildReadarrBookPayload(scoredEntries[0].book, effectiveFormat, readarrConfig, {
        stripAudiobookMetadata: effectiveFormat !== 'audiobook',
        resolvedAuthorId
      });

      payloadPreview = {
        mediaType: payload.bookToAdd.mediaType || null,
        selectedTitle: payload.bookToAdd.title || null,
        selectedForeignBookId: payload.bookToAdd.foreignBookId || null,
        authorId: payload.bookToAdd.authorId || null,
        resolvedAuthorId: payload.authorId || null,
        addNewAuthor: payload.bookToAdd.addOptions?.addNewAuthor,
        addOptions: payload.bookToAdd.addOptions || null,
        profileSelection: {
          qualityProfileId: payload.bookToAdd.qualityProfileId || null,
          metadataProfileId: payload.bookToAdd.metadataProfileId || null,
          ebookQualityProfileId: payload.bookToAdd.ebookQualityProfileId || null,
          ebookMetadataProfileId: payload.bookToAdd.ebookMetadataProfileId || null
        },
        rootFolders: {
          rootFolderPath: payload.bookToAdd.rootFolderPath || null,
          ebookRootFolderPath: payload.bookToAdd.ebookRootFolderPath || null,
          audiobookRootFolderPath: payload.bookToAdd.audiobookRootFolderPath || null
        },
        audiobookFlags: {
          likelyAudiobook: isLikelyAudiobookResult(scoredEntries[0].book),
          audiobookMonitored: payload.bookToAdd.audiobookMonitored,
          ebookMonitored: payload.bookToAdd.ebookMonitored
        }
      };
    }

    lookup = {
      included: true,
      query: rawQuery,
      totalResults: rawBooks.length,
      lookupStatus: {
        ok: lookupInfo.ok,
        statusCode: lookupInfo.statusCode,
        statusText: lookupInfo.statusText
      },
      topResults: scoredEntries.slice(0, 5).map(entry => ({
        title: entry.book.title,
        author: getReadarrAuthorName(entry.book),
        foreignBookId: entry.book.foreignBookId,
        mediaType: entry.book.mediaType || null,
        score: entry.score,
        likelyAudiobook: entry.likelyAudiobook,
        scoreBreakdown: entry.scoreBreakdown
      })),
      payloadPreview
    };
  }

  const selectedQuality = (readarrConfig.qualityProfiles || []).find(p => p.id === qualityProfileId) || null;
  const selectedMetadata = (readarrConfig.metadataProfiles || []).find(p => p.id === metadataProfileId) || null;

  const recommendations = [];
  if (effectiveFormat !== 'audiobook' && /\baudio\b/i.test(String(selectedMetadata?.name || ''))) {
    recommendations.push('Selected metadata profile appears audiobook-oriented for a non-audiobook request.');
  }
  if (lookup.topResults[0]?.likelyAudiobook && effectiveFormat !== 'audiobook') {
    recommendations.push('Top lookup result appears audiobook-oriented; consider adding searchTermOverride with ebook hints.');
  }
  if (!routeSummary.capabilities.hasBookAdd) {
    recommendations.push(`Route list does not clearly expose ${READARR_API_PREFIX}/book add endpoint.`);
  }

  return res.json({
    success: true,
    generatedAt: new Date().toISOString(),
    readarr: {
      url: process.env.READARR_URL,
      systemStatus: {
        ok: statusInfo.ok,
        statusCode: statusInfo.statusCode,
        statusText: statusInfo.statusText,
        version: statusInfo.data?.version || null,
        branch: statusInfo.data?.branch || null,
        osName: statusInfo.data?.osName || null
      },
      routes: {
        ok: routesInfo.ok,
        statusCode: routesInfo.statusCode,
        statusText: routesInfo.statusText,
        summary: routeSummary
      }
    },
    requestContext: {
      sourceRequest: sourceRequest ? {
        id: sourceRequest.id,
        status: sourceRequest.status,
        format: sourceRequest.format,
        title: sourceRequest.book_title,
        author: sourceRequest.author
      } : null,
      effectiveInput: {
        title: effectiveTitle,
        author: effectiveAuthor,
        isbn: effectiveIsbn,
        format: effectiveFormat,
        includeLookup: shouldIncludeLookup
      }
    },
    profiles: {
      qualityProfiles: {
        count: qualityProfiles.length,
        items: qualityProfiles.map(profile => ({ id: profile.id, name: profile.name }))
      },
      metadataProfiles: {
        count: metadataProfiles.length,
        items: metadataProfiles.map(profile => ({ id: profile.id, name: profile.name }))
      },
      rootFolders: {
        count: rootFolders.length,
        items: rootFolders.map(folder => ({ path: folder.path, freeSpace: folder.freeSpace || null }))
      },
      selected: {
        qualityProfileId,
        qualityProfileName: selectedQuality?.name || null,
        metadataProfileId,
        metadataProfileName: selectedMetadata?.name || null,
        rootFolderPath
      }
    },
    envMapping: {
      quality: {
        default: parsePositiveInt(process.env.READARR_QUALITY_PROFILE_ID),
        epub: parsePositiveInt(process.env.READARR_QUALITY_PROFILE_ID_EPUB),
        pdf: parsePositiveInt(process.env.READARR_QUALITY_PROFILE_ID_PDF),
        mobi: parsePositiveInt(process.env.READARR_QUALITY_PROFILE_ID_MOBI),
        audiobook: parsePositiveInt(process.env.READARR_QUALITY_PROFILE_ID_AUDIOBOOK)
      },
      metadata: {
        default: parsePositiveInt(process.env.READARR_METADATA_PROFILE_ID),
        epub: parsePositiveInt(process.env.READARR_METADATA_PROFILE_ID_EPUB),
        pdf: parsePositiveInt(process.env.READARR_METADATA_PROFILE_ID_PDF),
        mobi: parsePositiveInt(process.env.READARR_METADATA_PROFILE_ID_MOBI),
        audiobook: parsePositiveInt(process.env.READARR_METADATA_PROFILE_ID_AUDIOBOOK)
      },
      rootFolder: {
        default: process.env.READARR_ROOT_FOLDER || null,
        epub: process.env.READARR_ROOT_FOLDER_EPUB || null,
        pdf: process.env.READARR_ROOT_FOLDER_PDF || null,
        mobi: process.env.READARR_ROOT_FOLDER_MOBI || null,
        audiobook: process.env.READARR_ROOT_FOLDER_AUDIOBOOK || null
      }
    },
    lookup,
    recommendations
  });
});

// Test Readarr integration - search without adding (returns all results with scores)
app.post('/api/admin/readarr/test', authenticateToken, async (req, res) => {
  const {
    title,
    author,
    isbn,
    format,
    requestId,
    attemptAdd,
    forceRefreshConfig,
    includeRawResults,
    candidateForeignBookId
  } = req.body || {};

  const requestedFormat = String(format || 'any').toLowerCase();
  const shouldAttemptAdd = attemptAdd === true;
  const requestedCandidateForeignBookId = String(candidateForeignBookId || '').trim();

  try {
    if (!process.env.READARR_URL || !process.env.READARR_API_KEY) {
      return res.json({
        success: false,
        message: 'Readarr is not configured (READARR_URL and READARR_API_KEY required)',
        configured: false
      });
    }

    let sourceRequest = null;
    if (requestId) {
      sourceRequest = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
      if (!sourceRequest) {
        return res.status(404).json({ error: 'Request not found' });
      }
    }

    const effectiveTitle = String(sourceRequest?.book_title || title || '').trim();
    const effectiveAuthor = String(sourceRequest?.author || author || '').trim();
    const effectiveIsbn = String(sourceRequest?.isbn || isbn || '').trim();
    const effectiveFormat = String(sourceRequest?.format || requestedFormat || 'any').toLowerCase();

    if (!effectiveTitle || !effectiveAuthor) {
      return res.status(400).json({ error: 'Title and author are required (or provide requestId)' });
    }

    const statusResponse = await fetchWithTimeout(buildReadarrApiUrl('/system/status'), {
      headers: { 'X-Api-Key': process.env.READARR_API_KEY }
    }, 'Readarr system status');

    if (!statusResponse.ok) {
      return res.json({
        success: false,
        message: `Readarr connection failed: ${statusResponse.status} ${statusResponse.statusText}`,
        configured: true
      });
    }

    const readarrStatus = await statusResponse.json();
    const readarrConfig = await getReadarrConfig(forceRefreshConfig === true);

    const qualityProfileId = selectQualityProfileId(effectiveFormat, readarrConfig.qualityProfiles);
    const metadataProfileId = selectMetadataProfileId(effectiveFormat, readarrConfig.metadataProfiles);
    const rootFolderPath = selectRootFolderPath(effectiveFormat, readarrConfig.rootFolders);

    const rawQuery = effectiveIsbn ? effectiveIsbn : `${effectiveAuthor} ${effectiveTitle}`;
    const searchQuery = encodeURIComponent(rawQuery);

    logger.info('Test Readarr search', {
      title: effectiveTitle,
      author: effectiveAuthor,
      isbn: effectiveIsbn || '(none)',
      format: effectiveFormat,
      searchQuery: rawQuery,
      attemptAdd: shouldAttemptAdd,
      candidateForeignBookId: requestedCandidateForeignBookId || null,
      requestId: sourceRequest?.id || null
    });

    const searchResponse = await fetchWithTimeout(buildReadarrApiUrl(`/book/lookup?term=${searchQuery}`), {
      headers: { 'X-Api-Key': process.env.READARR_API_KEY }
    }, 'Readarr test search');

    if (!searchResponse.ok) {
      return res.json({
        success: false,
        message: `Readarr search failed: ${searchResponse.status}`,
        configured: true,
        readarrVersion: readarrStatus.version,
        diagnostics: {
          searchStatusCode: searchResponse.status,
          searchStatusText: searchResponse.statusText,
          selectedProfiles: { qualityProfileId, metadataProfileId, rootFolderPath }
        }
      });
    }

    const books = await searchResponse.json();
    const normalizedSearchTitle = effectiveTitle.toLowerCase().trim();
    const normalizedSearchAuthor = effectiveAuthor.toLowerCase().trim();

    const scoredEntries = buildScoredReadarrEntries(
      books,
      normalizedSearchTitle,
      normalizedSearchAuthor,
      effectiveFormat
    );

    let selectedIndex = 0;
    let selectionWarning = null;
    if (requestedCandidateForeignBookId) {
      const matchingIndex = scoredEntries.findIndex(
        entry => String(entry.book?.foreignBookId || '') === requestedCandidateForeignBookId
      );
      if (matchingIndex >= 0) {
        selectedIndex = matchingIndex;
      } else {
        selectionWarning = `Requested candidate ${requestedCandidateForeignBookId} was not found in current lookup results. Using top-ranked candidate instead.`;
      }
    }

    const selectedEntry = scoredEntries[selectedIndex] || null;

    const scoredResults = scoredEntries.slice(0, 10).map((entry, idx) => ({
      title: entry.book.title,
      author: getReadarrAuthorName(entry.book),
      foreignBookId: entry.book.foreignBookId,
      releaseDate: entry.book.releaseDate,
      overview: entry.book.overview?.substring(0, 150) + (entry.book.overview?.length > 150 ? '...' : ''),
      score: entry.score,
      scoreBreakdown: entry.scoreBreakdown,
      likelyAudiobook: entry.likelyAudiobook,
      rawLikelyAudiobook: entry.rawLikelyAudiobook,
      hasEbookSignals: entry.hasEbookSignals,
      highConfidenceTextIntent: entry.highConfidenceTextIntent,
      formatHints: {
        bookType: entry.book.bookType || null,
        mediaType: entry.book.mediaType || null,
        bookFormat: entry.book.bookFormat || null,
        editionFormats: Array.isArray(entry.book.editions)
          ? entry.book.editions
              .map(e => e?.format || e?.bookFormat || e?.mediaType || e?.releaseType || null)
              .filter(Boolean)
              .slice(0, 5)
          : []
      },
      isSelected: idx === selectedIndex
    }));

    let payloadPreview = null;
    let addAttemptResult = {
      attempted: false,
      note: 'Set attemptAdd=true to post this payload directly to Readarr/Chaptarr for live validation.'
    };

    if (selectedEntry) {
      const resolvedAuthorId = await resolveExistingReadarrAuthorId(selectedEntry.book);
      const payload = buildReadarrBookPayload(selectedEntry.book, effectiveFormat, readarrConfig, {
        stripAudiobookMetadata: effectiveFormat !== 'audiobook',
        resolvedAuthorId
      });

      payloadPreview = {
        title: payload.bookToAdd.title,
        foreignBookId: payload.bookToAdd.foreignBookId,
        authorId: payload.bookToAdd.authorId,
        resolvedAuthorId: payload.authorId || null,
        authorName: payload.bookToAdd.author?.authorName || payload.bookToAdd.authorName || null,
        forceFullAuthorPayload: false,
        addNewAuthor: payload.bookToAdd.addOptions?.addNewAuthor,
        qualityProfileId: payload.bookToAdd.qualityProfileId,
        metadataProfileId: payload.bookToAdd.metadataProfileId,
        ebookQualityProfileId: payload.bookToAdd.ebookQualityProfileId || null,
        ebookMetadataProfileId: payload.bookToAdd.ebookMetadataProfileId || null,
        rootFolderPath: payload.bookToAdd.rootFolderPath,
        ebookRootFolderPath: payload.bookToAdd.ebookRootFolderPath || null,
        mediaType: payload.bookToAdd.mediaType || null,
        monitored: payload.bookToAdd.monitored,
        audiobookMonitored: payload.bookToAdd.audiobookMonitored,
        ebookMonitored: payload.bookToAdd.ebookMonitored,
        addType: payload.bookToAdd.addOptions?.addType || null,
        addOptions: payload.bookToAdd.addOptions,
        strippedAudiobookHints: payload.shouldStripAudiobookHints,
        likelyAudiobook: isLikelyAudiobookResult(selectedEntry.book),
        rawLikelyAudiobook: selectedEntry.rawLikelyAudiobook,
        hasEbookSignals: selectedEntry.hasEbookSignals,
        highConfidenceTextIntent: selectedEntry.highConfidenceTextIntent
      };

      if (shouldAttemptAdd) {
        const addResponse = await fetchWithTimeout(buildReadarrApiUrl('/book'), {
          method: 'POST',
          headers: {
            'X-Api-Key': process.env.READARR_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload.bookToAdd)
        }, 'Readarr test add');

        const addBodyText = await addResponse.text();
        let parsedBody = null;
        try {
          parsedBody = addBodyText ? JSON.parse(addBodyText) : null;
        } catch {
          parsedBody = null;
        }

        addAttemptResult = {
          attempted: true,
          ok: addResponse.ok,
          statusCode: addResponse.status,
          statusText: addResponse.statusText,
          body: parsedBody || addBodyText,
          bodyPreview: addBodyText?.substring(0, 1000) || ''
        };
      }
    }

    const selectedQuality = readarrConfig.qualityProfiles.find(p => p.id === qualityProfileId);
    const selectedMetadata = readarrConfig.metadataProfiles.find(p => p.id === metadataProfileId);
    const selectedRootFolder = readarrConfig.rootFolders.find(r => r.path === rootFolderPath);

    logger.info('Test Readarr results', {
      searchQuery: rawQuery,
      totalFound: books.length,
      topScore: scoredEntries[0]?.score,
      selectedTitle: selectedEntry?.book?.title,
      selectedForeignBookId: selectedEntry?.book?.foreignBookId || null,
      likelyAudiobook: selectedEntry?.likelyAudiobook,
      attemptAdd: shouldAttemptAdd,
      addStatus: addAttemptResult.statusCode || null
    });

    res.json({
      success: true,
      configured: true,
      readarrVersion: readarrStatus.version,
      readarrBranch: readarrStatus.branch || null,
      searchQuery: rawQuery,
      searchTerms: {
        title: effectiveTitle,
        author: effectiveAuthor,
        isbn: effectiveIsbn,
        format: effectiveFormat
      },
      selectedCandidate: selectedEntry ? {
        index: selectedIndex,
        title: selectedEntry.book?.title || null,
        author: getReadarrAuthorName(selectedEntry.book) || null,
        foreignBookId: selectedEntry.book?.foreignBookId || null,
        score: selectedEntry.score,
        likelyAudiobook: selectedEntry.likelyAudiobook,
        rawLikelyAudiobook: selectedEntry.rawLikelyAudiobook,
        hasEbookSignals: selectedEntry.hasEbookSignals,
        highConfidenceTextIntent: selectedEntry.highConfidenceTextIntent
      } : null,
      selectionWarning,
      totalResults: books.length,
      results: scoredResults,
      payloadPreview,
      addAttempt: addAttemptResult,
      diagnostics: {
        selectedProfiles: {
          qualityProfileId,
          qualityProfileName: selectedQuality?.name || null,
          metadataProfileId,
          metadataProfileName: selectedMetadata?.name || null,
          rootFolderPath,
          rootFolderFreeSpace: selectedRootFolder?.freeSpace || null
        },
        counts: {
          qualityProfiles: readarrConfig.qualityProfiles.length,
          metadataProfiles: readarrConfig.metadataProfiles.length,
          rootFolders: readarrConfig.rootFolders.length
        },
        requestSource: sourceRequest ? {
          id: sourceRequest.id,
          status: sourceRequest.status,
          originalFormat: sourceRequest.format
        } : null
      },
      rawResults: includeRawResults === true ? books.slice(0, 3) : undefined
    });
  } catch (error) {
    logger.error('Readarr test error', { error: error.message });
    res.json({
      success: false,
      message: `Error testing Readarr: ${error.message}`,
      configured: true
    });
  }
});

// Add book to Readarr
app.post('/api/admin/readarr/add', authenticateToken, async (req, res) => {
  const {
    requestId,
    candidateForeignBookId,
    allowAudiobookCandidate
  } = req.body || {};

  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  if (['completed', 'rejected', 'unavailable'].includes(request.status)) {
    return res.status(409).json({ success: false, error: `Cannot add a ${request.status} request to Readarr` });
  }

  if (request.status === 'searching' && request.readarr_book_id) {
    return res.json({ success: true, message: 'Request already tracked in Readarr', alreadyTracked: true });
  }

  const requestedCandidateForeignBookId = String(candidateForeignBookId || '').trim();
  const allowManualAudiobookCandidate = allowAudiobookCandidate === true;
  let forcedSearchResult = null;
  let manualCandidateInfo = null;

  if (requestedCandidateForeignBookId) {
    const requestFormat = String(request.format || 'any').toLowerCase();
    const rawQuery = request.isbn ? request.isbn : `${request.author} ${request.book_title}`;
    const lookupResult = await lookupReadarrBooksByTerm(rawQuery, 'Readarr manual candidate lookup');

    if (!lookupResult.ok) {
      return res.status(502).json({
        success: false,
        error: `Manual candidate lookup failed (${lookupResult.status} ${lookupResult.statusText})`
      });
    }

    const rankedCandidates = buildScoredReadarrEntries(
      lookupResult.books,
      String(request.book_title || '').toLowerCase().trim(),
      String(request.author || '').toLowerCase().trim(),
      requestFormat
    );

    const selectedCandidate = rankedCandidates.find(
      entry => String(entry.book?.foreignBookId || '') === requestedCandidateForeignBookId
    );

    if (!selectedCandidate) {
      return res.status(400).json({
        success: false,
        error: `Candidate ${requestedCandidateForeignBookId} was not found in current lookup results for this request.`
      });
    }

    if (requestFormat !== 'audiobook' && selectedCandidate.likelyAudiobook && !allowManualAudiobookCandidate) {
      return res.status(400).json({
        success: false,
        error: 'Selected candidate appears to be audiobook content. Select a non-audiobook candidate or set allowAudiobookCandidate=true.'
      });
    }

    forcedSearchResult = selectedCandidate.book;
    manualCandidateInfo = {
      title: selectedCandidate.book?.title || null,
      author: getReadarrAuthorName(selectedCandidate.book) || null,
      foreignBookId: selectedCandidate.book?.foreignBookId || null,
      score: selectedCandidate.score,
      likelyAudiobook: selectedCandidate.likelyAudiobook
    };
  }

  const result = await addBookToReadarr({
    requestId,
    bookTitle: request.book_title,
    author: request.author,
    isbn: request.isbn,
    format: request.format,
    _forcedSearchResult: forcedSearchResult,
    _skipAutoCandidateSwap: !!forcedSearchResult,
    _allowAudiobookCandidate: allowManualAudiobookCandidate
  });

  if (manualCandidateInfo) {
    result.manualCandidate = manualCandidateInfo;
  }

  const now = new Date().toISOString();
  const persistOutcome = persistReadarrResult(requestId, result, now);
  if (result.success && persistOutcome?.conflict) {
    result.success = false;
    result.error = `Duplicate tracking prevented (existing request ${persistOutcome.conflict.id})`;
    result.duplicateDetected = true;
    result.duplicateOfRequestId = persistOutcome.conflict.id;
  }

  if (result.success && persistOutcome?.stored) {
    setRequestStatus(requestId, 'searching', now, 'Added to Readarr for download');
  } else if (request.status === 'pending') {
    const readarrFailure = persistOutcome?.conflict
      ? `Duplicate tracking prevented (existing request ${persistOutcome.conflict.id})`
      : (result.error || 'Unknown Readarr error');
    setRequestStatus(requestId, 'approved', now, `Readarr add failed: ${readarrFailure}`);
    await notifyAdminLifecycle('readarr_failed', request, { message: readarrFailure });
  } else {
    const readarrFailure = persistOutcome?.conflict
      ? `Duplicate tracking prevented (existing request ${persistOutcome.conflict.id})`
      : (result.error || 'Unknown Readarr error');
    db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
      requestId,
      request.status,
      now,
      `Readarr add failed: ${readarrFailure}`
    );
    await notifyAdminLifecycle('readarr_failed', request, { message: readarrFailure });
  }

  res.json(result);
});

// ============================================
// Webhook Endpoint (for Readarr/Chaptarr)
// ============================================

app.post('/api/webhook/book-complete',
  [
    body('bookTitle').optional().trim(),
    body('author').optional().trim(),
    body('eventType').optional().trim()
  ],
  async (req, res) => {
    // Verify webhook secret if configured
    if (process.env.WEBHOOK_SECRET) {
      const signature = req.headers['x-webhook-signature'];
      if (signature !== process.env.WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    const eventType = req.body.eventType || req.body.event || req.body.type;
    const webhookTitle = req.body.bookTitle || req.body.title || req.body.book?.title || '';
    const webhookAuthor = req.body.author || req.body.authorName || req.body.book?.authorName || req.body.book?.author?.authorName || '';
    const webhookBookId = parsePositiveInt(req.body.bookId || req.body.book?.id || req.body.book?.bookId || req.body.id);
    const webhookForeignBookId = req.body.foreignBookId || req.body.book?.foreignBookId || null;
    const webhookForeignAuthorId = req.body.foreignAuthorId || req.body.author?.foreignAuthorId || req.body.book?.author?.foreignAuthorId || null;

    // Handle Readarr/Chaptarr completion webhooks
    if (['Download', 'BookFileImported', 'DownloadFolderImported', 'Import'].includes(eventType)) {
      let requests = [];

      if (webhookBookId) {
        requests = db.prepare(`
          SELECT * FROM requests
          WHERE status IN ('pending', 'approved', 'searching', 'downloading')
          AND readarr_book_id = ?
        `).all(webhookBookId);
      }

      if (requests.length === 0 && (webhookForeignBookId || webhookForeignAuthorId)) {
        const candidates = db.prepare(`
          SELECT * FROM requests
          WHERE status IN ('pending', 'approved', 'searching', 'downloading')
          AND (readarr_foreign_book_id IS NOT NULL OR readarr_foreign_author_id IS NOT NULL)
        `).all();
        requests = candidates.filter(r => matchesByForeignId(r, webhookForeignBookId, webhookForeignAuthorId));
      }

      if (requests.length === 0 && webhookTitle && webhookAuthor) {
        requests = db.prepare(`
          SELECT * FROM requests
          WHERE status IN ('pending', 'approved', 'searching', 'downloading')
          AND LOWER(TRIM(book_title)) = LOWER(TRIM(?))
          AND LOWER(TRIM(author)) = LOWER(TRIM(?))
        `).all(webhookTitle, webhookAuthor);
      }

      if (requests.length === 0 && webhookTitle && webhookAuthor) {
        const fuzzyMatches = db.prepare(`
          SELECT * FROM requests
          WHERE status IN ('pending', 'approved', 'searching', 'downloading')
          AND LOWER(book_title) LIKE LOWER(?)
          AND LOWER(author) LIKE LOWER(?)
        `).all(`%${webhookTitle}%`, `%${webhookAuthor}%`);

        if (fuzzyMatches.length === 1) {
          requests = fuzzyMatches;
        } else if (fuzzyMatches.length > 1) {
          logger.warn('Webhook match ambiguous, skipping fuzzy completion', {
            eventType,
            title: webhookTitle,
            author: webhookAuthor,
            matches: fuzzyMatches.length
          });
        }
      }

      const now = new Date().toISOString();

      for (const request of requests) {
        const cwaLink = await resolveCwaLinkForRequest(request);
        updateRequestCwaState(request.id, now, true, cwaLink);
        setRequestStatus(request.id, 'completed', now, 'Book downloaded via Readarr webhook');

        // Notify requester (if opted in) and any subscribers
        if (request.notify_on_complete || (await getRequestSubscribers(request.id)).length > 0) {
          const safeRequesterName = escapeHtml(request.requester_name);
          const safeBookTitle = escapeHtml(request.book_title);
          const safeAuthor = escapeHtml(request.author);
          const webhookEmailContent = `
            <div style="text-align: center; margin-bottom: 30px;">
              <span style="font-size: 48px;">🎉</span>
            </div>
            <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Great News! Your Book is Ready</h2>
            <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${safeRequesterName},</p>
            <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
              Your requested book "<strong style="color: #667eea;">${safeBookTitle}</strong>" by ${safeAuthor} is now available in our library!
            </p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${cwaLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">Download from Library →</a>
            </div>
            <p style="margin: 30px 0 0 0; font-size: 14px; color: #86868b; text-align: center;">Happy reading!<br><strong style="color: #1d1d1f;">JcubHub Books</strong></p>
          `;
          await sendReadyEmails(request, webhookEmailContent, 'Your Book is Ready! - JcubHub Books', 'Your Book is Ready');
        }

        await notifyAdminLifecycle('completed', { ...request, cwa_book_link: cwaLink }, { cwaLink });
      }

      const matchedBy = webhookBookId ? 'readarr_book_id' : (webhookForeignBookId || webhookForeignAuthorId) ? 'foreign_id' : 'title_author';
      return res.json({ success: true, updatedCount: requests.length, matchedBy });
    }

    res.json({ success: true, message: 'Webhook received' });
  }
);

// ============================================
// CWA Sync Endpoint
// ============================================

app.post('/api/admin/sync-cwa', authenticateToken, async (req, res) => {
  if (!process.env.CWA_URL || !process.env.CWA_USERNAME || !process.env.CWA_PASSWORD) {
    return res.status(400).json({ error: 'CWA not configured' });
  }

  // Get all non-completed requests
  const requests = db.prepare("SELECT * FROM requests WHERE status != 'completed' AND status != 'rejected' AND status != 'unavailable'").all();
  const now = new Date().toISOString();
  let updatedCount = 0;

  for (const request of requests) {
    const cwaCheck = await checkCwaAvailability(request.book_title, request.author, request.isbn || '');
    
    if (cwaCheck.available && !request.cwa_available) {
      const cwaLink = cwaCheck.bookLink || buildCwaSearchLink(request.book_title, request.author);
      updateRequestCwaState(request.id, now, true, cwaLink);
      db.prepare("UPDATE requests SET status = 'completed', updated_at = ? WHERE id = ?").run(now, request.id);
      db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
        request.id, 'completed', now, 'Book found in CWA library during sync'
      );

      // Notify requester (if opted in) and any subscribers
      if (request.notify_on_complete || (await getRequestSubscribers(request.id)).length > 0) {
        const safeRequesterName = escapeHtml(request.requester_name);
        const safeBookTitle = escapeHtml(request.book_title);
        const safeAuthor = escapeHtml(request.author);
        const syncEmailContent = `
          <div style="text-align: center; margin-bottom: 30px;">
            <span style="font-size: 48px;">🎉</span>
          </div>
          <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Great News! Your Book is Ready</h2>
          <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${safeRequesterName},</p>
          <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
            Your requested book "<strong style="color: #667eea;">${safeBookTitle}</strong>" by ${safeAuthor} is now available in our library!
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${cwaLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">Download from Library →</a>
          </div>
          <p style="margin: 30px 0 0 0; font-size: 14px; color: #86868b; text-align: center;">Happy reading!<br><strong style="color: #1d1d1f;">JcubHub Books</strong></p>
        `;
        await sendReadyEmails(request, syncEmailContent, 'Your Book is Ready! - JcubHub Books', 'Your Book is Ready');
      }

      await notifyAdminLifecycle('completed', { ...request, cwa_book_link: cwaLink }, { cwaLink });

      updatedCount++;
    }
  }

  res.json({ success: true, checkedCount: requests.length, updatedCount });
});

// ============================================
// Serve Admin SPA
// ============================================

// Requester pages + magic-link callback (callback shares the verify logic).
app.get('/requester/auth/callback', requesterAuthVerifyLimiter, handleRequesterVerify);

app.get('/requester/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'requester-login.html'));
});

// ============================================
// Native JCubHub Apps API (Bearer broker tokens, no cookies)
// Contract: books/1.0.0. Mounted before the SPA catch-all below.
// ============================================
app.use('/api/native/books', createNativeBooksRouter({
  db,
  generateId,
  buildRequesterDashboardItem,
  log,
}));

app.get('/requester/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'requester-dashboard.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Fallback to index.html for SPA routing
app.get('{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// Global Error Handler
// ============================================

app.use((err, req, res, next) => {
  logger.error('Express error', { 
    error: err.message, 
    stack: err.stack,
    path: req.path,
    method: req.method,
    requestId: req.requestId
  });
  
  res.status(err.status || 500).json({ 
    error: process.env.NODE_ENV === 'production' 
      ? 'An unexpected error occurred' 
      : err.message 
  });
});

// ============================================
// Start Server
// ============================================

app.listen(PORT, () => {
  logger.info('='.repeat(50));
  logger.info('Server Started Successfully!');
  logger.info('='.repeat(50));
  logger.info(`Listening on port ${PORT}`);
  logger.info(`Static files: ${path.join(__dirname, 'public')}`);
  logger.info(`Health check: http://localhost:${PORT}/api/health`);
  logger.info(`Admin panel: http://localhost:${PORT}/admin`);
  logger.info(`Requester dashboard: http://localhost:${PORT}/requester/login`);

  // Requester auth artifact cleanup: run at startup and hourly (TASK-004).
  cleanupRequesterAuthArtifacts();
  setInterval(cleanupRequesterAuthArtifacts, 60 * 60 * 1000);

  // Start auto-sync if configured
  if (automation.autoSyncInterval > 0 && integrations.cwa) {
    logger.info(`Auto-sync enabled: checking CWA every ${automation.autoSyncInterval} minutes`);
    setInterval(async () => {
      logger.info('Running scheduled CWA sync...');
      try {
        const requests = db.prepare("SELECT * FROM requests WHERE status != 'completed' AND status != 'rejected' AND status != 'unavailable'").all();
        let updatedCount = 0;
        const now = new Date().toISOString();

        for (const request of requests) {
          const cwaCheck = await checkCwaAvailability(request.book_title, request.author, request.isbn || '');
          
          if (cwaCheck.available && !request.cwa_available) {
            const cwaLink = cwaCheck.bookLink || buildCwaSearchLink(request.book_title, request.author);
            updateRequestCwaState(request.id, now, true, cwaLink);
            db.prepare("UPDATE requests SET status = 'completed', updated_at = ? WHERE id = ?").run(now, request.id);
            db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
              request.id, 'completed', now, 'Auto-completed: Book found in CWA during scheduled sync'
            );

            if (request.notify_on_complete || (await getRequestSubscribers(request.id)).length > 0) {
              const safeRequesterName = escapeHtml(request.requester_name);
              const safeBookTitle = escapeHtml(request.book_title);
              const safeAuthor = escapeHtml(request.author);
              const emailContent = `
                <div style="text-align: center; margin-bottom: 30px;"><span style="font-size: 48px;">🎉</span></div>
                <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Your Book is Ready!</h2>
                <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${safeRequesterName},</p>
                <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
                  "<strong style="color: #667eea;">${safeBookTitle}</strong>" by ${safeAuthor} is now available!
                </p>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${cwaLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">Download from Library →</a>
                </div>
              `;
              await sendReadyEmails(request, emailContent, 'Your Book is Ready! - JcubHub Books', 'Your Book is Ready');
            }
            await notifyAdminLifecycle('completed', { ...request, cwa_book_link: cwaLink }, { cwaLink });
            updatedCount++;
          }
        }
        
        if (updatedCount > 0) {
          logger.info('Scheduled sync completed', { checked: requests.length, updated: updatedCount });
        }
      } catch (error) {
        logger.error('Scheduled sync error', { error: error.message });
      }
    }, automation.autoSyncInterval * 60 * 1000);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  db.close();
  process.exit(0);
});

// Unhandled error logging
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason: String(reason) });
});
