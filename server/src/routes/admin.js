'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { logAudit, logActivity } = require('../middleware/accounting');

const router = express.Router();

// ── GET /api/admin/users ───────────────────────────────────────────────────────
router.get('/users', authenticate, requireRole('admin'), (req, res) => {
  try {
    const { role, search } = req.query;
    const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 20));
    let query = `SELECT id, name, email, role, mfa_enabled, is_active, created_at FROM users WHERE 1=1`;
    const params = [];
    if (role) { query += ` AND role = ?`; params.push(role); }
    if (search) { query += ` AND (name LIKE ? OR email LIKE ?)`; const q = `%${search}%`; params.push(q, q); }
    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, (page - 1) * limit);
    const users = db.prepare(query).all(...params);
    const total = db.prepare(`SELECT count(*) as c FROM users WHERE 1=1 ${role ? 'AND role=?' : ''} ${search ? 'AND (name LIKE ? OR email LIKE ?)' : ''}`).get(...params.slice(0, -2)).c;
    res.json({ users, total, page, limit });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// ── PUT /api/admin/users/:id ───────────────────────────────────────────────────
router.put('/users/:id', authenticate, requireRole('admin'), (req, res) => {
  try {
    const { role, is_active } = req.body;
    if (role !== undefined && !['participant', 'organizer', 'coordinator', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    if (is_active !== undefined && ![true, false, 0, 1].includes(is_active)) return res.status(400).json({ error: 'is_active must be true or false.' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.id === req.user.id) return res.status(400).json({ error: 'Cannot modify your own account via admin panel.' });
    const old = { role: user.role, is_active: user.is_active };
    if (role) db.prepare(`UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?`).run(role, user.id);
    if (is_active !== undefined) db.prepare(`UPDATE users SET is_active = ?, updated_at = datetime('now') WHERE id = ?`).run(is_active ? 1 : 0, user.id);
    logAudit({ actor_id: req.user.id, actor_role: 'admin', action: 'user_updated', resource_type: 'user', resource_id: user.id, old_value: old, new_value: { role, is_active }, severity: 'warning', ip: req.ip });
    res.json({ message: 'User updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

// ── POST /api/admin/users/:id/reset-mfa ───────────────────────────────────────
router.post('/users/:id/reset-mfa', authenticate, requireRole('admin'), (req, res) => {
  try {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    db.prepare(`UPDATE users SET mfa_enabled=0, mfa_secret=NULL, mfa_backup_codes=NULL, updated_at=datetime('now') WHERE id=?`).run(user.id);
    logAudit({ actor_id: req.user.id, actor_role: 'admin', action: 'mfa_reset_by_admin', resource_type: 'user', resource_id: user.id, severity: 'warning', ip: req.ip });
    res.json({ message: 'MFA reset successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset MFA.' });
  }
});

// ── POST /api/admin/users/:id/reset-password ──────────────────────────────────
router.post('/users/:id/reset-password', authenticate, requireRole('admin'), (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters.' });
    const hash = bcrypt.hashSync(new_password, 12);
    db.prepare(`UPDATE users SET password_hash=?, updated_at=datetime('now') WHERE id=?`).run(hash, req.params.id);
    logAudit({ actor_id: req.user.id, actor_role: 'admin', action: 'password_reset_by_admin', resource_type: 'user', resource_id: parseInt(req.params.id), severity: 'critical', ip: req.ip });
    res.json({ message: 'Password reset successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// ── GET /api/admin/settings ────────────────────────────────────────────────────
router.get('/settings', authenticate, requireRole('admin'), (req, res) => {
  try {
    const settings = db.prepare('SELECT key, value FROM system_settings').all();
    const obj = {};
    settings.forEach(s => { obj[s.key] = s.value; });
    res.json({ settings: obj });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});

// ── PUT /api/admin/settings ────────────────────────────────────────────────────
router.put('/settings', authenticate, requireRole('admin'), (req, res) => {
  try {
    const allowed = ['session_timeout_minutes', 'mfa_enforcement', 'allow_self_registration', 'max_registrations_per_user', 'certificate_template_color', 'site_name', 'contact_email'];
    const old = {};
    for (const [key, value] of Object.entries(req.body)) {
      if (!allowed.includes(key)) continue;
      const cur = db.prepare('SELECT value FROM system_settings WHERE key=?').get(key);
      old[key] = cur?.value;
      db.prepare(`INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
                  ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
        .run(key, String(value), req.user.id);
    }
    logAudit({ actor_id: req.user.id, actor_role: 'admin', action: 'settings_updated', resource_type: 'system', old_value: old, new_value: req.body, severity: 'warning', ip: req.ip });
    res.json({ message: 'Settings saved successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

// ── GET /api/admin/stats ────────────────────────────────────────────────────────
router.get('/stats', authenticate, requireRole('admin', 'coordinator'), (req, res) => {
  try {
    const stats = {
      total_users:          db.prepare(`SELECT count(*) as c FROM users`).get().c,
      total_symposiums:     db.prepare(`SELECT count(*) as c FROM symposiums`).get().c,
      approved_symposiums:  db.prepare(`SELECT count(*) as c FROM symposiums WHERE status='approved'`).get().c,
      pending_symposiums:   db.prepare(`SELECT count(*) as c FROM symposiums WHERE status='pending_approval'`).get().c,
      total_registrations:  db.prepare(`SELECT count(*) as c FROM registrations WHERE status != 'cancelled'`).get().c,
      total_attendees:      db.prepare(`SELECT count(*) as c FROM registrations WHERE attendance_marked=1`).get().c,
      total_certificates:   db.prepare(`SELECT count(*) as c FROM certificates`).get().c,
      users_by_role:        db.prepare(`SELECT role, count(*) as count FROM users GROUP BY role`).all(),
      recent_registrations: db.prepare(`SELECT r.*, u.name as pname, s.title as stitle FROM registrations r JOIN users u ON r.user_id=u.id JOIN symposiums s ON r.symposium_id=s.id ORDER BY r.registration_date DESC LIMIT 5`).all(),
    };
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

router.get('/reports/attendance.csv', authenticate, requireRole('admin', 'organizer', 'coordinator'), (req, res) => {
  try {
    const symposiumId = Number.parseInt(req.query.symposium_id, 10);
    if (!Number.isSafeInteger(symposiumId) || symposiumId < 1) return res.status(400).json({ error: 'A valid symposium_id is required.' });
    const symposium = db.prepare('SELECT id, title, organizer_id FROM symposiums WHERE id=?').get(symposiumId);
    if (!symposium) return res.status(404).json({ error: 'Symposium not found.' });
    if (req.user.role === 'organizer' && symposium.organizer_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    const rows = db.prepare(`SELECT u.name, u.email, r.status, r.payment_status, r.attendance_marked, r.registration_date
      FROM registrations r JOIN users u ON u.id=r.user_id WHERE r.symposium_id=? ORDER BY u.name`).all(symposiumId);
    const cell = value => {
      let safe = String(value ?? '');
      if (/^[\s\u0000-\u001f]*[=+@-]/.test(safe)) safe = `'${safe}`;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const csv = ['Name,Email,Registration Status,Payment,Present,Registered At', ...rows.map(r => [r.name, r.email, r.status, r.payment_status, r.attendance_marked ? 'Yes' : 'No', r.registration_date].map(cell).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="symposium-${symposiumId}-attendance.csv"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: 'Report export failed.' }); }
});

// ── Accounting Logs ────────────────────────────────────────────────────────────
function logsRoute(tableName, extraJoin = '') {
  return (req, res) => {
    try {
      const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
      const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 25));
      const { search } = req.query;
      let query = `SELECT l.* ${extraJoin ? ', u.name as actor_name, u.email as actor_email' : ''} FROM ${tableName} l ${extraJoin} WHERE 1=1`;
      const params = [];
      if (search) { query += ` AND (l.action LIKE ? OR l.ip_address LIKE ?)`; const q = `%${search}%`; params.push(q, q); }
      query += ` ORDER BY l.id DESC LIMIT ? OFFSET ?`;
      params.push(limit, (page - 1) * limit);
      const logs = db.prepare(query).all(...params);
      const total = db.prepare(`SELECT count(*) as c FROM ${tableName}`).get().c;
      res.json({ logs, total, page, limit });
    } catch (err) {
      res.status(500).json({ error: `Failed to fetch ${tableName}.` });
    }
  };
}

router.get('/logs/login',        authenticate, requireRole('admin'), logsRoute('login_logs'));
router.get('/logs/registration', authenticate, requireRole('admin', 'coordinator'), logsRoute('registration_logs'));
router.get('/logs/attendance',   authenticate, requireRole('admin', 'organizer', 'coordinator'), logsRoute('attendance_logs'));
router.get('/logs/certificate',  authenticate, requireRole('admin', 'organizer'), logsRoute('certificate_logs'));
router.get('/logs/activity',     authenticate, requireRole('admin'), logsRoute('activity_logs'));
router.get('/logs/audit',        authenticate, requireRole('admin'), logsRoute('audit_logs'));

module.exports = router;
