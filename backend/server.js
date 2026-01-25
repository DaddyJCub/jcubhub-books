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

// Initialize SQLite database
const dbPath = path.join(__dirname, 'data', 'books.db');
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
  if (adminExists.count === 0 && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    const passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    db.prepare('INSERT INTO admin_users (username, password_hash, created_at) VALUES (?, ?, ?)').run(
      process.env.ADMIN_USERNAME,
      passwordHash,
      new Date().toISOString()
    );
    console.log('Default admin user created');
  }
}

initDatabase();

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
    console.warn('TURNSTILE_SECRET_KEY not configured, skipping verification');
    return true;
  }

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET_KEY,
        response: token
      })
    });
    const data = await response.json();
    return data.success;
  } catch (error) {
    console.error('Turnstile verification error:', error);
    return false;
  }
}

async function sendEmail(to, subject, html) {
  if (!transporter) {
    console.log('Email not configured, skipping:', subject);
    return;
  }

  try {
    await transporter.sendMail({
      from: `"JcubHub Books" <${process.env.ZOHO_EMAIL}>`,
      to,
      subject,
      html
    });
    console.log('Email sent:', subject);
  } catch (error) {
    console.error('Email error:', error);
  }
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
    return xml.includes('<entry>') && xml.toLowerCase().includes(author.toLowerCase());
  } catch (error) {
    console.error('CWA availability check error:', error);
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
    return books.length > 0 ? books[0] : null;
  } catch (error) {
    console.error('Readarr search error:', error);
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '2.0.0'
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
      await sendEmail(requesterEmail, 'Book Request Received - JcubHub Books', `
        <h2>Book Request Received</h2>
        <p>Hi ${requesterName},</p>
        <p>We've received your request for "<strong>${bookTitle}</strong>" by ${author}.</p>
        <p>Request ID: <strong>${id}</strong></p>
        ${cwaAvailable ? '<p style="color: green;">Good news! This book may already be available in our library. Check CWA!</p>' : ''}
        <p>We'll notify you when your request is processed.</p>
        <br>
        <p>Best regards,<br>JcubHub Books</p>
      `);
    }

    // Send admin notification
    if (process.env.ADMIN_EMAIL) {
      await sendEmail(process.env.ADMIN_EMAIL, 'New Book Request - JcubHub Books', `
        <h2>New Book Request</h2>
        <p><strong>ID:</strong> ${id}</p>
        <p><strong>From:</strong> ${requesterName} (${requesterEmail})</p>
        <p><strong>Book:</strong> ${bookTitle} by ${author}</p>
        <p><strong>Format:</strong> ${format}</p>
        <p><strong>Notes:</strong> ${notes || 'None'}</p>
        <p><strong>CWA Available:</strong> ${cwaAvailable ? 'Yes' : 'No'}</p>
        ${readarrUrl ? `<p><a href="${readarrUrl}">Search in Readarr</a></p>` : ''}
      `);
    }

    res.status(201).json({
      success: true,
      requestId: id,
      message: 'Your book request has been submitted successfully!',
      cwaAvailable
    });
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
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });

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
    body('notes').optional().trim()
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

    const { status, notes } = req.body;
    const now = new Date().toISOString();

    if (status) {
      // Update request
      db.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run(status, now, req.params.id);
      
      // Add to history
      db.prepare('INSERT INTO status_history (request_id, status, changed_at, notes) VALUES (?, ?, ?, ?)').run(
        req.params.id, status, now, notes || ''
      );

      // Send notification email if status is completed and user opted in
      if (status === 'completed' && request.notify_on_complete) {
        const cwaLink = process.env.CWA_URL || 'https://cwa.jcubhub.com';
        await sendEmail(request.requester_email, 'Your Book is Ready! - JcubHub Books', `
          <h2>Great News! Your Book is Ready</h2>
          <p>Hi ${request.requester_name},</p>
          <p>Your requested book "<strong>${request.book_title}</strong>" by ${request.author} is now available!</p>
          <p>You can download it from our library at <a href="${cwaLink}">CWA</a>.</p>
          <br>
          <p>Happy reading!<br>JcubHub Books</p>
        `);
      }
    }

    const updated = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
    res.json(updated);
  }
);

// Delete request
app.delete('/api/admin/requests/:id', authenticateToken, (req, res) => {
  const result = db.prepare('DELETE FROM requests WHERE id = ?').run(req.params.id);
  
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Request not found' });
  }

  res.json({ success: true, message: 'Request deleted' });
});

// Get dashboard stats
app.get('/api/admin/stats', authenticateToken, (req, res) => {
  const stats = {
    total: db.prepare('SELECT COUNT(*) as count FROM requests').get().count,
    pending: db.prepare("SELECT COUNT(*) as count FROM requests WHERE status = 'pending'").get().count,
    completed: db.prepare("SELECT COUNT(*) as count FROM requests WHERE status = 'completed'").get().count,
    rejected: db.prepare("SELECT COUNT(*) as count FROM requests WHERE status IN ('rejected', 'unavailable')").get().count,
    recentRequests: db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 5').all()
  };

  res.json(stats);
});

// ============================================
// Readarr Integration Routes
// ============================================

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
          await sendEmail(request.requester_email, 'Your Book is Ready! - JcubHub Books', `
            <h2>Great News! Your Book is Ready</h2>
            <p>Hi ${request.requester_name},</p>
            <p>Your requested book "<strong>${request.book_title}</strong>" by ${request.author} is now available!</p>
            <p>You can download it from our library at <a href="${cwaLink}">CWA</a>.</p>
            <br>
            <p>Happy reading!<br>JcubHub Books</p>
          `);
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
        await sendEmail(request.requester_email, 'Your Book is Ready! - JcubHub Books', `
          <h2>Great News! Your Book is Ready</h2>
          <p>Hi ${request.requester_name},</p>
          <p>Your requested book "<strong>${request.book_title}</strong>" by ${request.author} is now available!</p>
          <p>You can download it from our library at <a href="${cwaLink}">CWA</a>.</p>
          <br>
          <p>Happy reading!<br>JcubHub Books</p>
        `);
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
// Start Server
// ============================================

app.listen(PORT, () => {
  console.log(`JcubHub Books server running on port ${PORT}`);
  console.log(`Static files served from: ${path.join(__dirname, 'public')}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
