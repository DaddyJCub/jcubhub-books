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

logger.info('Integrations Status:', integrations);
logger.info('Automation Settings:', automation);

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

// Database initialization
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      requester_name TEXT NOT NULL,
      requester_email TEXT NOT NULL,
      book_title TEXT NOT NULL,
      author TEXT NOT NULL,
      format TEXT NOT NULL,
      notes TEXT,
      status TEXT DEFAULT 'pending',
      notify_on_complete INTEGER DEFAULT 1,
      readarr_url TEXT,
      cwa_available INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_requests_email ON requests(requester_email);
    CREATE INDEX IF NOT EXISTS idx_status_history_request ON status_history(request_id);
  `);

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

function generateReadarrUrl(author, bookTitle) {
  if (!process.env.READARR_URL) return null;
  const searchQuery = encodeURIComponent(`${author} ${bookTitle}`);
  return `${process.env.READARR_URL}/add/search?term=${searchQuery}`;
}

async function checkCwaAvailability(bookTitle, author) {
  if (!process.env.CWA_URL || !process.env.CWA_USERNAME || !process.env.CWA_PASSWORD) {
    return false;
  }

  try {
    const credentials = Buffer.from(`${process.env.CWA_USERNAME}:${process.env.CWA_PASSWORD}`).toString('base64');
    const response = await fetch(`${process.env.CWA_URL}/opds/search?query=${encodeURIComponent(bookTitle)}`, {
      headers: {
        'Authorization': `Basic ${credentials}`
      }
    });

    if (!response.ok) return false;

    const xml = await response.text();
    // Simple check for entries - a proper implementation would parse the OPDS XML
    const found = xml.includes('<entry>') && xml.toLowerCase().includes(author.toLowerCase());
    logger.debug('CWA availability check', { bookTitle, author, found });
    return found;
  } catch (error) {
    logger.error('CWA availability check error', { bookTitle, error: error.message });
    return false;
  }
}

async function searchReadarr(bookTitle, author) {
  if (!process.env.READARR_URL || !process.env.READARR_API_KEY) {
    return null;
  }

  try {
    const searchQuery = encodeURIComponent(`${author} ${bookTitle}`);
    const response = await fetch(`${process.env.READARR_URL}/api/v1/book/lookup?term=${searchQuery}`, {
      headers: {
        'X-Api-Key': process.env.READARR_API_KEY
      }
    });

    if (!response.ok) return null;

    const books = await response.json();
    logger.debug('Readarr search result', { bookTitle, author, found: books.length });
    return books.length > 0 ? books[0] : null;
  } catch (error) {
    logger.error('Readarr search error', { bookTitle, author, error: error.message });
    return null;
  }
}

async function addBookToReadarr(bookData) {
  if (!process.env.READARR_URL || !process.env.READARR_API_KEY) {
    return { success: false, error: 'Readarr not configured' };
  }

  try {
    // First search for the book
    const searchResult = await searchReadarr(bookData.bookTitle, bookData.author);
    if (!searchResult) {
      return { success: false, error: 'Book not found in Readarr' };
    }

    // Add the book to Readarr
    const response = await fetch(`${process.env.READARR_URL}/api/v1/book`, {
      method: 'POST',
      headers: {
        'X-Api-Key': process.env.READARR_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...searchResult,
        monitored: true,
        addOptions: {
          monitor: 'all',
          searchForNewBook: true
        }
      })
    });

    if (response.ok) {
      return { success: true, data: await response.json() };
    } else {
      const errorData = await response.json();
      return { success: false, error: errorData.message || 'Failed to add book' };
    }
  } catch (error) {
    console.error('Readarr add book error:', error);
    return { success: false, error: error.message };
  }
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
    body('format').isIn(['epub', 'pdf', 'mobi', 'any']).withMessage('Invalid format'),
    body('notes').optional().trim(),
    body('notifyOnComplete').optional().isBoolean(),
    body('turnstileToken').notEmpty().withMessage('Captcha verification required')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { requesterName, requesterEmail, bookTitle, author, format, notes, notifyOnComplete, turnstileToken } = req.body;

    // Verify Turnstile
    const isValidCaptcha = await verifyTurnstile(turnstileToken);
    if (!isValidCaptcha) {
      return res.status(400).json({ error: 'Captcha verification failed. Please try again.' });
    }

    // Check for duplicate requests (same email + book in last 24 hours)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const duplicate = db.prepare(`
      SELECT id FROM requests 
      WHERE requester_email = ? 
      AND LOWER(book_title) = LOWER(?) 
      AND created_at > ?
    `).get(requesterEmail, bookTitle, oneDayAgo);

    if (duplicate) {
      return res.status(409).json({ error: 'You have already submitted a request for this book recently.' });
    }

    const now = new Date().toISOString();
    const id = generateId();
    const readarrUrl = generateReadarrUrl(author, bookTitle);

    // Check CWA availability
    const cwaAvailable = await checkCwaAvailability(bookTitle, author);

    // Insert request
    db.prepare(`
      INSERT INTO requests (id, requester_name, requester_email, book_title, author, format, notes, status, notify_on_complete, readarr_url, cwa_available, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(id, requesterName, requesterEmail, bookTitle, author, format, notes || '', notifyOnComplete !== false ? 1 : 0, readarrUrl, cwaAvailable ? 1 : 0, now, now);

    // Add initial status history
    db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
      id, 'pending', now, 'Request submitted'
    );

    // Send confirmation email if opted in
    if (notifyOnComplete !== false) {
      const emailContent = `
        <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f;">Book Request Received</h2>
        <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${requesterName},</p>
        <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">
          We've received your request for "<strong style="color: #667eea;">${bookTitle}</strong>" by ${author}.
        </p>
        <div style="background: #f0f0ff; border-left: 4px solid #667eea; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
          <p style="margin: 0; font-size: 14px; color: #86868b;">Request ID</p>
          <p style="margin: 5px 0 0 0; font-size: 18px; font-weight: 600; color: #667eea;">${id}</p>
        </div>
        ${cwaAvailable ? `
        <div style="background: #f0fdf4; border-left: 4px solid #22c55e; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
          <p style="margin: 0; font-size: 14px; color: #166534;">✓ Good news! This book may already be available in our library.</p>
        </div>
        ` : ''}
        <p style="margin: 20px 0 0 0; font-size: 16px; color: #1d1d1f;">We'll notify you when your request is processed.</p>
        <p style="margin: 30px 0 0 0; font-size: 14px; color: #86868b;">Best regards,<br><strong style="color: #1d1d1f;">JcubHub Books</strong></p>
      `;
      await sendEmail(requesterEmail, 'Book Request Received - JcubHub Books', wrapEmailHtml(emailContent, 'Book Request Received'));
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
              <span style="color: #1d1d1f; font-size: 16px;">${requesterName} (${requesterEmail})</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5;">
              <span style="color: #86868b; font-size: 14px;">Book</span><br>
              <span style="color: #1d1d1f; font-size: 16px;"><strong>${bookTitle}</strong> by ${author}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5;">
              <span style="color: #86868b; font-size: 14px;">Format</span><br>
              <span style="color: #1d1d1f; font-size: 16px;">${format.toUpperCase()}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5;">
              <span style="color: #86868b; font-size: 14px;">Notes</span><br>
              <span style="color: #1d1d1f; font-size: 16px;">${notes || 'None'}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0;">
              <span style="color: #86868b; font-size: 14px;">CWA Available</span><br>
              <span style="color: ${cwaAvailable ? '#166534' : '#dc2626'}; font-size: 16px; font-weight: 600;">${cwaAvailable ? '✓ Yes' : '✗ No'}</span>
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
      message: 'Your book request has been submitted successfully!',
      cwaAvailable
    });

    logger.info('Book request submitted', { 
      requestId: id, 
      bookTitle, 
      author, 
      format,
      cwaAvailable,
      notifyOnComplete: notifyOnComplete !== false
    });

    // Auto-add to Readarr if enabled and book not already in CWA
    if (automation.autoAddToReadarr && !cwaAvailable && integrations.readarr) {
      try {
        logger.info('Auto-adding to Readarr...', { requestId: id, bookTitle });
        const readarrResult = await addBookToReadarr({ bookTitle, author });
        
        if (readarrResult.success) {
          const updateNow = new Date().toISOString();
          db.prepare("UPDATE requests SET status = 'searching', updated_at = ? WHERE id = ?").run(updateNow, id);
          db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
            id, 'searching', updateNow, 'Automatically added to Readarr'
          );
          logger.info('Auto-added to Readarr successfully', { requestId: id });
        } else {
          logger.warn('Auto-add to Readarr failed', { requestId: id, error: readarrResult.error });
        }
      } catch (error) {
        logger.error('Auto-add to Readarr error', { requestId: id, error: error.message });
      }
    }
  }
);

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

  res.json({ ...request, statusHistory: history });
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
    const now = new Date().toISOString();
    let readarrResult = null;

    if (status) {
      // Update request
      db.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run(status, now, req.params.id);
      
      // Add to history
      db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
        req.params.id, status, now, notes || ''
      );

      // Auto-add to Readarr if requested (typically when approving)
      if (addToReadarr) {
        readarrResult = await addBookToReadarr({
          bookTitle: request.book_title,
          author: request.author
        });
        
        if (readarrResult.success) {
          // Update status to searching
          db.prepare("UPDATE requests SET status = 'searching', updated_at = ? WHERE id = ?").run(now, req.params.id);
          db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
            req.params.id, 'searching', now, 'Automatically added to Readarr'
          );
          logger.info('Auto-added to Readarr', { requestId: req.params.id, bookTitle: request.book_title });
        } else {
          logger.warn('Failed to auto-add to Readarr', { requestId: req.params.id, error: readarrResult.error });
        }
      }

      // Send notification email if status is completed and user opted in
      if (status === 'completed' && request.notify_on_complete) {
        const cwaLink = process.env.CWA_URL || 'https://cwa.jcubhub.com';
        const readyEmailContent = `
          <div style="text-align: center; margin-bottom: 30px;">
            <span style="font-size: 48px;">🎉</span>
          </div>
          <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Great News! Your Book is Ready</h2>
          <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${request.requester_name},</p>
          <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
            Your requested book "<strong style="color: #667eea;">${request.book_title}</strong>" by ${request.author} is now available in our library!
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${cwaLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">Download from Library →</a>
          </div>
          <p style="margin: 30px 0 0 0; font-size: 14px; color: #86868b; text-align: center;">Happy reading!<br><strong style="color: #1d1d1f;">JcubHub Books</strong></p>
        `;
        await sendEmail(request.requester_email, 'Your Book is Ready! - JcubHub Books', wrapEmailHtml(readyEmailContent, 'Your Book is Ready'));
      }

      logger.info('Request status updated', { 
        requestId: req.params.id, 
        oldStatus: request.status, 
        newStatus: status,
        admin: req.user.username,
        addedToReadarr: readarrResult?.success || false
      });
    }

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
        bookTitle: request.book_title,
        author: request.author
      });

      const now = new Date().toISOString();
      
      if (readarrResult.success) {
        db.prepare("UPDATE requests SET status = 'searching', updated_at = ? WHERE id = ?").run(now, request.id);
        db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
          request.id, 'searching', now, 'Batch processed - Added to Readarr'
        );
        results.succeeded++;
      } else {
        // Mark as approved but note the error
        db.prepare("UPDATE requests SET status = 'approved', updated_at = ? WHERE id = ?").run(now, request.id);
        db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
          request.id, 'approved', now, `Approved but Readarr add failed: ${readarrResult.error}`
        );
        results.failed++;
        results.errors.push({ id: request.id, book: request.book_title, error: readarrResult.error });
      }
    } catch (error) {
      results.failed++;
      results.errors.push({ id: request.id, book: request.book_title, error: error.message });
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
    db.prepare("UPDATE requests SET status = 'completed', cwa_available = 1, updated_at = ? WHERE id = ?").run(now, request.id);
    db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
      request.id, 'completed', now, 'Batch completed by admin'
    );

    // Send notification if opted in
    if (request.notify_on_complete) {
      const cwaLink = process.env.CWA_URL || 'https://cwa.jcubhub.com';
      const emailContent = `
        <div style="text-align: center; margin-bottom: 30px;">
          <span style="font-size: 48px;">🎉</span>
        </div>
        <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Great News! Your Book is Ready</h2>
        <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${request.requester_name},</p>
        <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
          Your requested book "<strong style="color: #667eea;">${request.book_title}</strong>" by ${request.author} is now available!
        </p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${cwaLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">Download from Library →</a>
        </div>
      `;
      await sendEmail(request.requester_email, 'Your Book is Ready! - JcubHub Books', wrapEmailHtml(emailContent, 'Your Book is Ready'));
    }
    
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
    const queueResponse = await fetch(`${process.env.READARR_URL}/api/v1/queue?includeBook=true`, {
      headers: { 'X-Api-Key': process.env.READARR_API_KEY }
    });
    
    // Get recent history (last 20 completed)
    const historyResponse = await fetch(`${process.env.READARR_URL}/api/v1/history?pageSize=20&sortKey=date&sortDirection=descending`, {
      headers: { 'X-Api-Key': process.env.READARR_API_KEY }
    });

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

// Add book to Readarr
app.post('/api/admin/readarr/add', authenticateToken, async (req, res) => {
  const { requestId } = req.body;

  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  const result = await addBookToReadarr({
    bookTitle: request.book_title,
    author: request.author
  });

  if (result.success) {
    // Update request status
    const now = new Date().toISOString();
    db.prepare("UPDATE requests SET status = 'searching', updated_at = ? WHERE id = ?").run(now, requestId);
    db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
      requestId, 'searching', now, 'Added to Readarr for download'
    );
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

    const { bookTitle, author, eventType } = req.body;

    // Handle Readarr webhook format
    if (eventType === 'Download' || eventType === 'BookFileImported') {
      // Find matching pending requests
      const requests = db.prepare(`
        SELECT * FROM requests 
        WHERE status IN ('pending', 'approved', 'searching', 'downloading')
        AND LOWER(book_title) LIKE LOWER(?)
        AND LOWER(author) LIKE LOWER(?)
      `).all(`%${bookTitle}%`, `%${author}%`);

      const now = new Date().toISOString();

      for (const request of requests) {
        // Update to completed
        db.prepare("UPDATE requests SET status = 'completed', cwa_available = 1, updated_at = ? WHERE id = ?").run(now, request.id);
        db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
          request.id, 'completed', now, 'Book downloaded via Readarr webhook'
        );

        // Send notification if opted in
        if (request.notify_on_complete) {
          const cwaLink = process.env.CWA_URL || 'https://cwa.jcubhub.com';
          const webhookEmailContent = `
            <div style="text-align: center; margin-bottom: 30px;">
              <span style="font-size: 48px;">🎉</span>
            </div>
            <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Great News! Your Book is Ready</h2>
            <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${request.requester_name},</p>
            <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
              Your requested book "<strong style="color: #667eea;">${request.book_title}</strong>" by ${request.author} is now available in our library!
            </p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${cwaLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">Download from Library →</a>
            </div>
            <p style="margin: 30px 0 0 0; font-size: 14px; color: #86868b; text-align: center;">Happy reading!<br><strong style="color: #1d1d1f;">JcubHub Books</strong></p>
          `;
          await sendEmail(request.requester_email, 'Your Book is Ready! - JcubHub Books', wrapEmailHtml(webhookEmailContent, 'Your Book is Ready'));
        }
      }

      return res.json({ success: true, updatedCount: requests.length });
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
    const available = await checkCwaAvailability(request.book_title, request.author);
    
    if (available && !request.cwa_available) {
      db.prepare("UPDATE requests SET cwa_available = 1, status = 'completed', updated_at = ? WHERE id = ?").run(now, request.id);
      db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
        request.id, 'completed', now, 'Book found in CWA library during sync'
      );

      // Send notification if opted in
      if (request.notify_on_complete) {
        const cwaLink = process.env.CWA_URL || 'https://cwa.jcubhub.com';
        const syncEmailContent = `
          <div style="text-align: center; margin-bottom: 30px;">
            <span style="font-size: 48px;">🎉</span>
          </div>
          <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Great News! Your Book is Ready</h2>
          <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${request.requester_name},</p>
          <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
            Your requested book "<strong style="color: #667eea;">${request.book_title}</strong>" by ${request.author} is now available in our library!
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${cwaLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">Download from Library →</a>
          </div>
          <p style="margin: 30px 0 0 0; font-size: 14px; color: #86868b; text-align: center;">Happy reading!<br><strong style="color: #1d1d1f;">JcubHub Books</strong></p>
        `;
        await sendEmail(request.requester_email, 'Your Book is Ready! - JcubHub Books', wrapEmailHtml(syncEmailContent, 'Your Book is Ready'));
      }

      updatedCount++;
    }
  }

  res.json({ success: true, checkedCount: requests.length, updatedCount });
});

// ============================================
// Serve Admin SPA
// ============================================

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
          const available = await checkCwaAvailability(request.book_title, request.author);
          
          if (available && !request.cwa_available) {
            db.prepare("UPDATE requests SET cwa_available = 1, status = 'completed', updated_at = ? WHERE id = ?").run(now, request.id);
            db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
              request.id, 'completed', now, 'Auto-completed: Book found in CWA during scheduled sync'
            );

            if (request.notify_on_complete) {
              const cwaLink = process.env.CWA_URL || 'https://cwa.jcubhub.com';
              const emailContent = `
                <div style="text-align: center; margin-bottom: 30px;"><span style="font-size: 48px;">🎉</span></div>
                <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 600; color: #1d1d1f; text-align: center;">Your Book is Ready!</h2>
                <p style="margin: 0 0 15px 0; font-size: 16px; color: #1d1d1f;">Hi ${request.requester_name},</p>
                <p style="margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f;">
                  "<strong style="color: #667eea;">${request.book_title}</strong>" by ${request.author} is now available!
                </p>
                <div style="text-align: center; margin: 30px 0;">
                  <a href="${cwaLink}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px;">Download from Library →</a>
                </div>
              `;
              await sendEmail(request.requester_email, 'Your Book is Ready! - JcubHub Books', wrapEmailHtml(emailContent, 'Your Book is Ready'));
            }
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
