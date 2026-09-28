'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const db = require('./db/database');
const { activityLogger } = require('./middleware/accounting');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Security Middleware ────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // handled by frontend
}));

// Rate limiting
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Too many requests. Please try again later.' } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many login attempts. Please try again in 15 minutes.' } });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/', generalLimiter);

// CORS
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Activity Logger (logs all authenticated API calls) ────────────────────────
app.use(activityLogger);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/symposiums',    require('./routes/symposiums'));
app.use('/api/registrations', require('./routes/registrations'));
app.use('/api/attendance',    require('./routes/attendance'));
app.use('/api/certificates',  require('./routes/certificates'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/notifications', require('./routes/notifications'));

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const stats = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    users:        db.prepare('SELECT count(*) as c FROM users').get().c,
    symposiums:   db.prepare('SELECT count(*) as c FROM symposiums').get().c,
    registrations: db.prepare('SELECT count(*) as c FROM registrations').get().c,
    certificates: db.prepare('SELECT count(*) as c FROM certificates').get().c,
  };
  res.json(stats);
});

// ── 404 Handler ───────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` }));

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[SERVER] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 SymposiHub API Server running on http://localhost:${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/api/health`);
  console.log(`🔐 Security: Helmet + Rate Limiting + CORS + JWT + bcrypt\n`);
});

module.exports = app;
