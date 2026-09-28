'use strict';
const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');
const db = require('../db/database');

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured in production.');
}
const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');

function authenticate(req, res, next) {
  try {
    const token = req.cookies?.token || (req.headers.authorization?.startsWith('Bearer ') && req.headers.authorization.slice(7));
    if (!token) return res.status(401).json({ error: 'Authentication required. Please log in.' });

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' });
      }
      return res.status(401).json({ error: 'Invalid token. Please log in again.' });
    }

    // MFA check: if mfa_pending is set, block access to all routes except MFA verification
    if (decoded.mfa_pending && !req.path.startsWith('/api/auth/mfa')) {
      return res.status(403).json({ error: 'MFA verification required.', code: 'MFA_REQUIRED' });
    }

    const user = db.prepare('SELECT id, name, email, role, mfa_enabled, is_active FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found. Please log in again.' });
    if (!user.is_active) return res.status(403).json({ error: 'Account is disabled. Contact administrator.' });

    req.user = user;
    req.token = decoded;
    next();
  } catch (err) {
    console.error('[AUTH] Middleware error:', err);
    res.status(500).json({ error: 'Authentication error.' });
  }
}

function optionalAuthenticate(req, res, next) {
  try {
    const token = req.cookies?.token || (req.headers.authorization?.startsWith('Bearer ') && req.headers.authorization.slice(7));
    if (!token) { req.user = null; return next(); }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = db.prepare('SELECT id, name, email, role, mfa_enabled, is_active FROM users WHERE id = ?').get(decoded.id);
      req.user = (user && user.is_active) ? user : null;
    } catch {
      req.user = null;
    }
    next();
  } catch {
    req.user = null;
    next();
  }
}

module.exports = { authenticate, optionalAuthenticate, JWT_SECRET };
