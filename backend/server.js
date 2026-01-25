// backend/server.js - With Zoho email, Readarr integration, Cloudflare Turnstile,
// plus CORS whitelist, Helmet security headers, rate limiting,
// ⭐ duplicate guard and PATCH status updates.
const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const nodemailer = require('nodemailer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult, param } = require('express-validator');
require('dotenv').config();

const app = express();

/* ----------------------------- Security & CORS ----------------------------- */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.set('trust proxy', 1);

const allowedOrigins = (process.env.CORS_ORIGINS ||
  'https://books.jcubhub.com,http://localhost:3003,http://127.0.0.1:3003,http://192.168.0.168:3003'
)
  .split(',')
  .map(s => s.trim());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      console.warn('CORS blocked origin:', origin);
      return cb(new Error('Not allowed by CORS'), false);
    },
    methods: ['GET', 'POST', 'PATCH'],
  })
);

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/* -------------------------------- Parsers -------------------------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ------------------------------ Data storage ------------------------------ */
const dataDir = path.join(__dirname, 'data');
const requestsFile = path.join(dataDir, 'book-requests.json');

async function ensureDataDir() {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    try {
      await fs.access(requestsFile);
    } catch {
      await fs.writeFile(requestsFile, JSON.stringify([], null, 2));
      console.log('📁 Created new book-requests.json file');
    }
  } catch (error) {
    console.error('Error creating data directory:', error);
  }
}
ensureDataDir();

// ⭐ small helpers
async function readAllRequests() {
  const content = await fs.readFile(requestsFile, 'utf8');
  return JSON.parse(content || '[]');
}
async function writeAllRequests(list) {
  await fs.writeFile(requestsFile, JSON.stringify(list, null, 2));
}
function nowIso() {
  return new Date().toISOString();
}

/* --------------------------------- Email --------------------------------- */
const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.com',
  port: 465,
  secure: true, // SSL
  auth: {
    user: process.env.ZOHO_USER,
    pass: process.env.ZOHO_PASS,
  },
});

transporter.verify(function (error) {
  if (error) {
    console.log('❌ Zoho Mail configuration error:', error);
  } else {
    console.log('✅ Zoho Mail server is ready to send emails');
  }
});

/* ------------------------- Turnstile verification ------------------------- */
// Expects token in either 'cf-turnstile-response' (forms) or 'turnstileToken' (JSON)
async function verifyTurnstile(req, res, next) {
  try {
    const token =
      (req.body && (req.body['cf-turnstile-response'] || req.body.turnstileToken)) || '';

    if (process.env.NODE_ENV === 'production' && !process.env.TURNSTILE_SECRET_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Server misconfiguration: TURNSTILE_SECRET_KEY missing.',
      });
    }

    if (!process.env.TURNSTILE_SECRET_KEY) {
      console.warn('⚠️ TURNSTILE_SECRET_KEY not set; skipping verification (non-production).');
      return next();
    }

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Turnstile verification token is missing.',
      });
    }

    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: process.env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: req.ip || '',
      }),
    });

    const outcome = await verifyRes.json();
    if (!outcome.success) {
      console.warn('❌ Turnstile failed:', outcome['error-codes']);
      return res.status(400).json({
        success: false,
        message: 'Turnstile verification failed.',
        errors: outcome['error-codes'] || [],
      });
    }

    return next();
  } catch (err) {
    console.error('❌ Turnstile verification error:', err);
    return res.status(400).json({
      success: false,
      message: 'Turnstile verification error.',
    });
  }
}

/* ------------------------------ Validation ------------------------------- */
const validateBookRequest = [
  body('name').notEmpty().trim().escape(),
  body('email').isEmail().normalizeEmail(),
  body('bookTitle').notEmpty().trim(),
  body('author').optional({ checkFalsy: true }).trim(),
  body('isbn').optional({ checkFalsy: true }).trim().escape(),
  body('category')
    .optional({ checkFalsy: true })
    .isIn(['fiction', 'non-fiction', 'academic', 'technical', 'biography', 'self-help', 'other']),
  body('additionalInfo').optional({ checkFalsy: true }).trim().escape(),
];

/* ------------------------------- Persistence ------------------------------ */
async function saveRequest(requestData) {
  const requests = await readAllRequests();
  const newRequest = {
    id: Date.now().toString(),
    ...requestData,
    requestDate: nowIso(),
    status: 'pending',
    // ⭐ track status changes
    statusHistory: [
      { status: 'pending', at: nowIso(), note: 'Request created' }
    ],
  };
  requests.push(newRequest);
  await writeAllRequests(requests);
  return newRequest;
}

// ⭐ duplicate guard helper
async function findRecentDuplicate(email, bookTitle, withinMs = 24 * 60 * 60 * 1000) {
  const requests = await readAllRequests();
  const normEmail = String(email).trim().toLowerCase();
  const normTitle = String(bookTitle).replace(/\s+/g, ' ').trim().toLowerCase();
  const cutoff = Date.now() - withinMs;

  // Find last matching submission
  const dup = [...requests].reverse().find(r => {
    const rEmail = (r.email || '').toLowerCase();
    const rTitle = (r.bookTitle || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const t = new Date(r.requestDate || 0).getTime();
    return rEmail === normEmail && rTitle === normTitle && t >= cutoff;
  });
  return dup || null;
}

/* --------------------------- Readarr URL helper --------------------------- */
function generateReadarrUrl(bookTitle, author) {
  const baseUrl = process.env.READARR_URL || 'http://localhost:8787';
  let searchQuery = bookTitle;
  if (author) searchQuery = `${bookTitle} ${author}`;
  const encodedQuery = encodeURIComponent(searchQuery);
  return `${baseUrl}/add/search?term=${encodedQuery}`;
}

/* --------------------------------- Routes -------------------------------- */
// POST: Create a request (duplicate-guarded)
app.post('/api/book-request', writeLimiter, verifyTurnstile, validateBookRequest, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    let {
      name,
      email,
      bookTitle,
      author = '',
      isbn = '',
      category = '',
      additionalInfo = '',
    } = req.body;

    // Normalize inputs
    category = (category || 'other').toString().trim().toLowerCase();
    const allowed = ['fiction', 'non-fiction', 'academic', 'technical', 'biography', 'self-help', 'other'];
    if (!allowed.includes(category)) category = 'other';

    if (isbn) isbn = String(isbn).replace(/[^0-9Xx]/g, '').toUpperCase();
    bookTitle = bookTitle.replace(/\s+/g, ' ').trim();
    author = author.replace(/\s+/g, ' ').trim();

    // ⭐ Duplicate guard: same email + title within 24h returns existing request
    const dup = await findRecentDuplicate(email, bookTitle);
    if (dup) {
      console.log(`🔁 Duplicate request detected -> returning existing id ${dup.id}`);
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: 'A similar request was already submitted recently.',
        requestId: dup.id,
      });
    }

    // Save
    const payload = { name, email, bookTitle, author, isbn, category, additionalInfo };
    const savedRequest = await saveRequest(payload);
    console.log('📚 New book request saved:', savedRequest.id);

    const readarrSearchUrl = generateReadarrUrl(bookTitle, author);
    console.log('🔍 Readarr URL:', readarrSearchUrl);

    try {
      // Admin email
      const adminMailOptions = {
        from: `"JcubHub Books" <${process.env.ZOHO_USER}>`,
        replyTo: `"${name}" <${email}>`,
        to: process.env.ADMIN_EMAIL || process.env.ZOHO_USER,
        subject: `New Book Request: ${bookTitle}`,
        html: `
          <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f9f9f9; padding: 20px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0;">
              <h1 style="margin: 0; font-size: 24px;">📚 New Book Request</h1>
            </div>
            <div style="background: white; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
              <h2 style="color: #333; border-bottom: 2px solid #667eea; padding-bottom: 10px;">Request Details</h2>
              <div style="margin: 20px 0;">
                <p style="margin: 8px 0;"><strong style="color: #667eea;">From:</strong> ${name}</p>
                <p style="margin: 8px 0;"><strong style="color: #667eea;">Email:</strong> <a href="mailto:${email}">${email}</a></p>
                <p style="margin: 8px 0;"><strong style="color: #667eea;">Book Title:</strong> <span style="font-size: 18px; color: #333;">${bookTitle}</span></p>
                ${author ? `<p style="margin: 8px 0;"><strong style="color: #667eea;">Author:</strong> ${author}</p>` : ''}
                ${isbn ? `<p style="margin: 8px 0;"><strong style="color: #667eea;">ISBN:</strong> ${isbn}</p>` : ''}
                ${category ? `<p style="margin: 8px 0;"><strong style="color: #667eea;">Category:</strong> ${category}</p>` : ''}
                ${additionalInfo ? `<div style="margin: 15px 0; padding: 15px; background: #f5f5f5; border-left: 4px solid #667eea; border-radius: 4px;"><strong style="color: #667eea;">Additional Info:</strong><br>${additionalInfo}</div>` : ''}
              </div>
              <div style="background: #e8f4fd; border: 2px solid #2196F3; border-radius: 8px; padding: 20px; margin: 25px 0;">
                <h3 style="color: #2196F3; margin-top: 0;">🔍 Quick Actions</h3>
                <a href="${readarrSearchUrl}" style="display: inline-block; background: #2196F3; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 10px 10px 10px 0;">
                  Search in Readarr
                </a>
                <p style="color: #666; font-size: 12px; margin-top: 10px;">
                  Click the button above to search for this book in Readarr and add it to your library.
                </p>
              </div>
              <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee; color: #999; font-size: 12px;">
                <p><strong>Request ID:</strong> ${savedRequest.id}</p>
                <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
              </div>
            </div>
          </div>
        `,
      };
      await transporter.sendMail(adminMailOptions);
      console.log('✅ Admin notification sent with Readarr link');

      // User confirmation
      const userMailOptions = {
        from: `"JcubHub Books" <${process.env.ZOHO_USER}>`,
        to: email,
        subject: 'Book Request Received - JcubHub Books',
        html: `
          <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
              <h1 style="margin: 0;">Thank You!</h1>
            </div>
            <div style="background: white; padding: 30px; border: 1px solid #eee; border-radius: 0 0 10px 10px;">
              <p style="font-size: 16px; color: #333;">Hi ${name},</p>
              <p style="color: #666; line-height: 1.6;">
                We've received your request for <strong style="color: #667eea;">"${bookTitle}"</strong>${author ? ` by ${author}` : ''}.
              </p>
              <p style="color: #666; line-height: 1.6;">
                Our team has been notified and will search for this book in our collection. 
                If we can add it to our library, you'll be notified once it's available for download.
              </p>
              <div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p style="margin: 0; color: #999; font-size: 12px;">
                  <strong>Reference ID:</strong> ${savedRequest.id}<br>
                  <strong>Submitted:</strong> ${new Date().toLocaleString()}
                </p>
              </div>
              <p style="color: #666; margin-top: 30px;">
                Best regards,<br>
                <strong style="color: #667eea;">JcubHub Books Team</strong>
              </p>
            </div>
          </div>
        `,
      };
      await transporter.sendMail(userMailOptions);
      console.log('✅ User confirmation email sent');
    } catch (emailError) {
      console.error('⚠️ Error sending emails:', emailError.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Book request submitted successfully',
      requestId: savedRequest.id,
    });
  } catch (error) {
    console.error('❌ Error processing book request:', error);
    return res.status(500).json({
      success: false,
      message: 'An error occurred while processing your request. Please try again.',
    });
  }
});

// GET: list requests (protected)
app.get('/api/book-requests', adminLimiter, async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (process.env.API_KEY && apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const requests = await readAllRequests();
    return res.json({
      success: true,
      count: requests.length,
      requests: requests.slice().reverse(), // newest first
    });
  } catch (error) {
    console.error('Error reading requests:', error);
    return res.status(500).json({ success: false, message: 'Error retrieving requests' });
  }
});

// ⭐ PATCH: update status (protected)
const allowedStatuses = ['pending', 'in_progress', 'added', 'rejected'];

app.patch(
  '/api/book-requests/:id',
  writeLimiter,
  adminLimiter,
  param('id').notEmpty().trim(),
  body('status').isIn(allowedStatuses),
  body('note').optional({ checkFalsy: true }).trim(),
  body('notifyUser').optional().toBoolean(),
  async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (process.env.API_KEY && apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { id } = req.params;
    const { status, note = '', notifyUser = false } = req.body;

    try {
      const requests = await readAllRequests();
      const idx = requests.findIndex(r => String(r.id) === String(id));
      if (idx === -1) {
        return res.status(404).json({ success: false, message: 'Request not found' });
      }

      const prev = requests[idx];
      requests[idx].status = status;
      requests[idx].updatedAt = nowIso();
      if (!Array.isArray(requests[idx].statusHistory)) requests[idx].statusHistory = [];
      requests[idx].statusHistory.push({ status, at: nowIso(), note });

      await writeAllRequests(requests);

      // Optional: notify user of status change
      if (notifyUser && prev.email) {
        try {
          const subjectMap = {
            pending: 'Your Book Request is Pending',
            in_progress: 'We’re Working on Your Book Request',
            added: 'Your Requested Book is Available',
            rejected: 'Update on Your Book Request',
          };
          let extra = '';
          if (status === 'added') {
            extra = `<p style="margin:0 0 8px 0;">We’ve added <strong>${prev.bookTitle}</strong>${prev.author ? ` by ${prev.author}` : ''} to our library. You can check the downloads page shortly.</p>`;
          } else if (status === 'rejected') {
            extra = `<p style="margin:0 0 8px 0;">We couldn’t add <strong>${prev.bookTitle}</strong> at this time.</p>`;
          }

          await transporter.sendMail({
            from: `"JcubHub Books" <${process.env.ZOHO_USER}>`,
            to: prev.email,
            subject: subjectMap[status] || 'Update on Your Book Request',
            html: `
              <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0; text-align: center;">
                  <h2 style="margin:0;">Request Update</h2>
                </div>
                <div style="background:#fff; padding: 20px; border: 1px solid #eee; border-radius: 0 0 10px 10px;">
                  <p style="margin:0 0 8px 0;">Hello ${prev.name || ''},</p>
                  ${extra || `<p style="margin:0 0 8px 0;">Status updated to: <strong>${status}</strong>.</p>`}
                  ${note ? `<p style="margin:8px 0 0 0;"><em>${note}</em></p>` : ''}
                  <p style="margin:16px 0 0 0; color:#666; font-size:12px;">Reference ID: ${prev.id}</p>
                </div>
              </div>
            `,
          });
          console.log(`📧 Status email sent to ${prev.email} for ${id}`);
        } catch (e) {
          console.error('⚠️ Error sending status email:', e.message);
        }
      }

      return res.json({ success: true, message: 'Status updated', request: requests[idx] });
    } catch (e) {
      console.error('❌ Error updating status:', e);
      return res.status(500).json({ success: false, message: 'Error updating status' });
    }
  }
);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: nowIso(),
    emailConfigured: !!transporter,
    readarrUrl: process.env.READARR_URL || 'Not configured',
  });
});

// Start server
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║     📚 JcubHub Books API Started       ║
╠════════════════════════════════════════╣
║ Port:     ${PORT}                         ║
║ Email:    Zoho Mail                    ║
║ Storage:  JSON File                    ║
║ Readarr:  ${process.env.READARR_URL || 'http://localhost:8787'}     ║
╚════════════════════════════════════════╝
  `);
});
