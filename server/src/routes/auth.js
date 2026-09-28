'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { randomUUID, randomBytes, createHash } = require('crypto');
const db = require('../db/database');
const { JWT_SECRET } = require('../middleware/auth');
const { logLogin, logAudit, logActivity } = require('../middleware/accounting');

const router = express.Router();

const ISSUER = 'SymposiHub';

function issueToken(user, extra = {}) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name, ...extra },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function setCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  });
}

// ── POST /api/auth/register ──────────────────────────────────────────────────
router.post('/register', (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!/(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*])/.test(password)) {
      return res.status(400).json({ error: 'Password must contain uppercase letter, number, and special character (!@#$%^&*).' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'Email already registered. Please login.' });

    const hash = bcrypt.hashSync(password, 12);
    const result = db.prepare('INSERT INTO users (name, email, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 0)').run(name.trim(), email.toLowerCase(), hash, 'participant');
    const verification = randomBytes(32).toString('hex');
    db.prepare("INSERT INTO account_tokens (user_id,purpose,token_hash,expires_at) VALUES (?,'email_verification',?,datetime('now','+24 hours'))").run(result.lastInsertRowid, createHash('sha256').update(verification).digest('hex'));

    logActivity({ user_id: result.lastInsertRowid, role: 'participant', action: 'user_registered', resource_type: 'user', resource_id: result.lastInsertRowid, ip: req.ip });
    logAudit({ actor_id: result.lastInsertRowid, actor_role: 'participant', action: 'user_registered', resource_type: 'user', resource_id: result.lastInsertRowid, severity: 'info', ip: req.ip });

    res.status(201).json({ message: 'Account created. Verify your email before signing in.', ...(process.env.NODE_ENV !== 'production' ? { verification_token: verification } : {}) });
  } catch (err) {
    console.error('[AUTH] Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      logLogin({ user_id: user?.id, email, action: 'login_failure', ip: req.ip, user_agent: req.headers['user-agent'], details: 'Wrong credentials' });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!user.is_active) {
      logLogin({ user_id: user.id, email, action: 'login_failure', ip: req.ip, details: 'Account disabled' });
      return res.status(403).json({ error: 'Account disabled. Contact administrator.' });
    }
    if (!user.email_verified) return res.status(403).json({ error: 'Verify your email before signing in.', code: 'EMAIL_VERIFICATION_REQUIRED' });

    if (user.mfa_enabled) {
      // Issue a short-lived MFA challenge token
      const mfaToken = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name, mfa_pending: true }, JWT_SECRET, { expiresIn: '10m' });
      return res.json({ mfa_required: true, mfa_token: mfaToken, message: 'Enter your authenticator or backup code.' });
    }

    const token = issueToken(user);
    setCookie(res, token);
    logLogin({ user_id: user.id, email, action: 'login_success', ip: req.ip, user_agent: req.headers['user-agent'] });
    logActivity({ user_id: user.id, role: user.role, action: 'login', resource_type: 'auth', ip: req.ip });

    res.json({ message: 'Login successful!', user: { id: user.id, name: user.name, email: user.email, role: user.role, mfa_enabled: user.mfa_enabled } });
  } catch (err) {
    console.error('[AUTH] Login error:', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

router.post('/verify-email', (req, res) => {
  const token = String(req.body.token || '');
  if (token.length !== 64) return res.status(400).json({ error: 'Invalid or expired verification link.' });
  const hash = createHash('sha256').update(token).digest('hex');
  const row = db.prepare("SELECT id,user_id FROM account_tokens WHERE token_hash=? AND purpose='email_verification' AND expires_at>datetime('now')").get(hash);
  if (!row) return res.status(400).json({ error: 'Invalid or expired verification link.' });
  db.prepare('UPDATE users SET email_verified=1, updated_at=datetime(\'now\') WHERE id=?').run(row.user_id);
  db.prepare('DELETE FROM account_tokens WHERE id=?').run(row.id);
  res.json({ message: 'Email verified. You can now sign in.' });
});

router.post('/forgot-password', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT id FROM users WHERE email=? AND is_active=1').get(email);
  const response = { message: 'If that account exists, password reset instructions are ready.' };
  if (user) {
    db.prepare("DELETE FROM account_tokens WHERE user_id=? AND purpose='password_reset'").run(user.id);
    const token = randomBytes(32).toString('hex');
    db.prepare("INSERT INTO account_tokens (user_id,purpose,token_hash,expires_at) VALUES (?,'password_reset',?,datetime('now','+30 minutes'))").run(user.id, createHash('sha256').update(token).digest('hex'));
    if (process.env.NODE_ENV !== 'production') response.reset_token = token;
  }
  res.json(response);
});

router.post('/reset-password', (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (!/(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*])/.test(password) || password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters with an uppercase letter, number, and special character.' });
  const hash = createHash('sha256').update(token).digest('hex');
  const row = db.prepare("SELECT id,user_id FROM account_tokens WHERE token_hash=? AND purpose='password_reset' AND expires_at>datetime('now')").get(hash);
  if (!row) return res.status(400).json({ error: 'Invalid or expired reset link.' });
  db.prepare('UPDATE users SET password_hash=?, updated_at=datetime(\'now\') WHERE id=?').run(bcrypt.hashSync(password, 12), row.user_id);
  db.prepare('DELETE FROM account_tokens WHERE user_id=?').run(row.user_id);
  res.json({ message: 'Password reset successfully. Please sign in.' });
});

// ── POST /api/auth/mfa/setup ─────────────────────────────────────────────────
router.post('/mfa/setup', require('../middleware/auth').authenticate, (req, res) => {
  try {
    const user = req.user;
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(user.email, ISSUER, secret);

    // Store secret temporarily
    db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(secret, user.id);

    QRCode.toDataURL(otpauth, (err, dataUrl) => {
      if (err) return res.status(500).json({ error: 'QR generation failed.' });
      res.json({ secret, qr_code: dataUrl, otpauth_url: otpauth });
    });
  } catch (err) {
    res.status(500).json({ error: 'MFA setup failed.' });
  }
});

// ── POST /api/auth/mfa/verify-setup ──────────────────────────────────────────
router.post('/mfa/verify-setup', require('../middleware/auth').authenticate, (req, res) => {
  try {
    const { code } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user.mfa_secret) return res.status(400).json({ error: 'Run MFA setup first.' });

    const isValid = authenticator.verify({ token: code, secret: user.mfa_secret });
    if (!isValid) return res.status(400).json({ error: 'Invalid OTP code. Please try again.' });

    // Generate backup codes
    const backupCodes = Array.from({ length: 8 }, () => randomBytes(4).toString('hex').toUpperCase());
    db.prepare('UPDATE users SET mfa_enabled = 1, mfa_backup_codes = ? WHERE id = ?').run(JSON.stringify(backupCodes), user.id);

    logAudit({ actor_id: user.id, actor_role: user.role, action: 'mfa_enabled', resource_type: 'user', resource_id: user.id, severity: 'info', ip: req.ip });

    res.json({ message: 'MFA enabled successfully!', backup_codes: backupCodes });
  } catch (err) {
    res.status(500).json({ error: 'MFA verification failed.' });
  }
});

// ── POST /api/auth/mfa/verify-login ──────────────────────────────────────────
router.post('/mfa/verify-login', (req, res) => {
  try {
    const { code, mfa_token } = req.body;
    if (!code || !mfa_token) return res.status(400).json({ error: 'Code and MFA token required.' });

    let decoded;
    try { decoded = jwt.verify(mfa_token, JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Invalid or expired MFA session.' }); }

    if (!decoded.mfa_pending) return res.status(400).json({ error: 'Not an MFA challenge token.' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found.' });

    // Check TOTP
    let isValid = false;
    if (user.mfa_secret) isValid = authenticator.verify({ token: code, secret: user.mfa_secret });

    // Check backup codes
    if (!isValid && user.mfa_backup_codes) {
      const codes = JSON.parse(user.mfa_backup_codes);
      const idx = codes.indexOf(code.toUpperCase());
      if (idx !== -1) {
        isValid = true;
        codes.splice(idx, 1); // use once
        db.prepare('UPDATE users SET mfa_backup_codes = ? WHERE id = ?').run(JSON.stringify(codes), user.id);
      }
    }

    if (!isValid) {
      logLogin({ user_id: user.id, email: user.email, action: 'mfa_failure', ip: req.ip });
      return res.status(401).json({ error: 'Invalid MFA code.' });
    }

    const token = issueToken(user);
    setCookie(res, token);
    logLogin({ user_id: user.id, email: user.email, action: 'mfa_success', ip: req.ip });
    logLogin({ user_id: user.id, email: user.email, action: 'login_success', ip: req.ip });

    res.json({ message: 'MFA verified. Login successful!', user: { id: user.id, name: user.name, email: user.email, role: user.role, mfa_enabled: 1 } });
  } catch (err) {
    res.status(500).json({ error: 'MFA login failed.' });
  }
});

// ── POST /api/auth/mfa/disable ────────────────────────────────────────────────
router.post('/mfa/disable', require('../middleware/auth').authenticate, (req, res) => {
  try {
    const { password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Incorrect password.' });
    db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL WHERE id = ?').run(user.id);
    logAudit({ actor_id: user.id, actor_role: user.role, action: 'mfa_disabled', resource_type: 'user', resource_id: user.id, severity: 'warning', ip: req.ip });
    res.json({ message: 'MFA disabled successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disable MFA.' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', require('../middleware/auth').authenticate, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role, mfa_enabled, is_active, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json({ user });
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', require('../middleware/auth').authenticate, (req, res) => {
  logLogin({ user_id: req.user.id, email: req.user.email, action: 'logout', ip: req.ip });
  res.clearCookie('token');
  res.json({ message: 'Logged out successfully.' });
});

// ── POST /api/auth/change-password ───────────────────────────────────────────
router.post('/change-password', require('../middleware/auth').authenticate, (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect.' });
    if (new_password.length < 8 || !/(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*])/.test(new_password)) {
      return res.status(400).json({ error: 'New password must be 8+ characters with uppercase, number, and special character.' });
    }
    const newHash = bcrypt.hashSync(new_password, 12);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(newHash, user.id);
    logAudit({ actor_id: user.id, actor_role: user.role, action: 'password_changed', resource_type: 'user', resource_id: user.id, severity: 'warning', ip: req.ip });
    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Password change failed.' });
  }
});

module.exports = router;
