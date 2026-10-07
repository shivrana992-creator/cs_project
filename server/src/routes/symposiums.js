'use strict';
const express = require('express');
const db = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { logActivity, logAudit } = require('../middleware/accounting');

const router = express.Router();

// ── GET /api/symposiums  (public) ─────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { search, category, upcoming } = req.query;
    let query = `
      SELECT s.*, u.name as organizer_name,
             (SELECT count(*) FROM registrations r WHERE r.symposium_id = s.id AND r.status NOT IN ('cancelled')) as registered_count
      FROM symposiums s
      LEFT JOIN users u ON s.organizer_id = u.id
      WHERE 1=1
    `;
    const params = [];

    query += ` AND s.status = 'approved'`;
    if (search) { query += ` AND (s.title LIKE ? OR s.description LIKE ? OR s.location LIKE ?)`; const q = `%${search}%`; params.push(q, q, q); }
    if (category) { query += ` AND s.category = ?`; params.push(category); }
    if (upcoming === 'true') { query += ` AND s.start_date >= date('now')`; }
    query += ` ORDER BY s.start_date ASC`;

    const symposiums = db.prepare(query).all(...params);
    res.json({ symposiums });
  } catch (err) {
    console.error('[SYMP] List error:', err);
    res.status(500).json({ error: 'Failed to fetch symposiums.' });
  }
});

// ── GET /api/symposiums/all (admin/organizer/coordinator) ─────────────────────
router.get('/all', authenticate, requireRole('admin', 'organizer', 'coordinator'), (req, res) => {
  try {
    const { role, id } = req.user;
    let query = `
      SELECT s.*, u.name as organizer_name,
             (SELECT count(*) FROM registrations r WHERE r.symposium_id = s.id AND r.status NOT IN ('cancelled')) as registered_count
      FROM symposiums s LEFT JOIN users u ON s.organizer_id = u.id WHERE 1=1
    `;
    const params = [];
    if (role === 'organizer') { query += ` AND s.organizer_id = ?`; params.push(id); }
    query += ` ORDER BY s.created_at DESC`;
    res.json({ symposiums: db.prepare(query).all(...params) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch symposiums.' });
  }
});

// ── GET /api/symposiums/:id ────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const symp = db.prepare(`
      SELECT s.*, u.name as organizer_name,
             c.name as coordinator_name,
             (SELECT count(*) FROM registrations r WHERE r.symposium_id = s.id AND r.status NOT IN ('cancelled')) as registered_count
      FROM symposiums s
      LEFT JOIN users u ON s.organizer_id = u.id
      LEFT JOIN users c ON s.coordinator_id = c.id
      WHERE s.id = ? AND s.status = 'approved'
    `).get(req.params.id);
    if (!symp) return res.status(404).json({ error: 'Symposium not found.' });
    const sessions = db.prepare('SELECT * FROM sessions WHERE symposium_id = ? ORDER BY start_time').all(req.params.id);
    res.json({ symposium: symp, sessions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch symposium.' });
  }
});

// ── POST /api/symposiums ──────────────────────────────────────────────────────
router.post('/', authenticate, requireRole('organizer', 'admin'), (req, res) => {
  try {
    const { title, description, category, location, start_date, end_date, registration_deadline, fee = 0, capacity = 100, banner_color = '#4F46E5', sessions = [] } = req.body;
    if (!title || !location || !start_date || !end_date || !registration_deadline) {
      return res.status(400).json({ error: 'Title, location, start_date, end_date, and registration_deadline are required.' });
    }
    if (String(title).length > 200 || String(location).length > 200) return res.status(400).json({ error: 'Title and location must be 200 characters or less.' });
    const start = Date.parse(start_date), end = Date.parse(end_date), deadline = Date.parse(registration_deadline);
    if (![start, end, deadline].every(Number.isFinite) || end < start) return res.status(400).json({ error: 'Enter valid event dates and make the end date on or after the start date.' });
    if (deadline >= start) {
      return res.status(400).json({ error: 'Registration deadline must be before the start date.' });
    }
    if (!Number.isFinite(Number(fee)) || Number(fee) < 0 || Math.abs(Number(fee) * 100 - Math.round(Number(fee) * 100)) > 0.000001 || !Number.isInteger(Number(capacity)) || Number(capacity) < 1 || Number(capacity) > 100000) return res.status(400).json({ error: 'Fee must be non-negative with at most two decimal places; capacity must be between 1 and 100000.' });

    const status = req.user.role === 'admin' ? 'approved' : 'pending_approval';
    const result = db.prepare(`
      INSERT INTO symposiums (title, description, category, location, start_date, end_date, registration_deadline, fee, capacity, organizer_id, status, banner_color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, description || null, category || null, location, start_date, end_date, registration_deadline, fee, capacity, req.user.id, status, banner_color);

    const sympId = result.lastInsertRowid;

    if (Array.isArray(sessions) && sessions.length > 0) {
      const insertSess = db.prepare(`INSERT INTO sessions (symposium_id, title, speaker, description, start_time, end_time, room) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const sess of sessions) {
        if (sess.title && sess.start_time && sess.end_time) {
          insertSess.run(sympId, sess.title, sess.speaker || null, sess.description || null, sess.start_time, sess.end_time, sess.room || null);
        }
      }
    }

    logActivity({ user_id: req.user.id, role: req.user.role, action: 'symposium_created', resource_type: 'symposium', resource_id: sympId, ip: req.ip });
    logAudit({ actor_id: req.user.id, actor_role: req.user.role, action: 'symposium_created', resource_type: 'symposium', resource_id: sympId, new_value: { title, status }, severity: 'info', ip: req.ip });

    res.status(201).json({ message: 'Symposium created successfully.', id: sympId, status });
  } catch (err) {
    console.error('[SYMP] Create error:', err);
    res.status(500).json({ error: 'Failed to create symposium.' });
  }
});

// ── PUT /api/symposiums/:id ────────────────────────────────────────────────────
router.put('/:id', authenticate, requireRole('organizer', 'admin'), (req, res) => {
  try {
    const symp = db.prepare('SELECT * FROM symposiums WHERE id = ?').get(req.params.id);
    if (!symp) return res.status(404).json({ error: 'Symposium not found.' });
    if (req.user.role === 'organizer' && symp.organizer_id !== req.user.id) return res.status(403).json({ error: 'Cannot edit another organizer\'s symposium.' });

    const { title, description, category, location, start_date, end_date, registration_deadline, fee, capacity, banner_color } = req.body;
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 200)) return res.status(400).json({ error: 'Title must be 1 to 200 characters.' });
    if (location !== undefined && (typeof location !== 'string' || !location.trim() || location.length > 200)) return res.status(400).json({ error: 'Location must be 1 to 200 characters.' });
    if (fee !== undefined && (!Number.isFinite(Number(fee)) || Number(fee) < 0 || Math.abs(Number(fee) * 100 - Math.round(Number(fee) * 100)) > 0.000001)) return res.status(400).json({ error: 'Fee must be non-negative with at most two decimal places.' });
    if (capacity !== undefined && (!Number.isInteger(Number(capacity)) || Number(capacity) < 1 || Number(capacity) > 100000)) return res.status(400).json({ error: 'Capacity must be between 1 and 100000.' });
    const updatedStart = Date.parse(start_date || symp.start_date), updatedEnd = Date.parse(end_date || symp.end_date), updatedDeadline = Date.parse(registration_deadline || symp.registration_deadline);
    if (![updatedStart, updatedEnd, updatedDeadline].every(Number.isFinite) || updatedEnd < updatedStart || updatedDeadline >= updatedStart) return res.status(400).json({ error: 'Event dates or registration deadline are invalid.' });
    const old = { ...symp };
    db.prepare(`
      UPDATE symposiums SET title=COALESCE(?,title), description=COALESCE(?,description), category=COALESCE(?,category),
        location=COALESCE(?,location), start_date=COALESCE(?,start_date), end_date=COALESCE(?,end_date),
        registration_deadline=COALESCE(?,registration_deadline), fee=COALESCE(?,fee), capacity=COALESCE(?,capacity),
        banner_color=COALESCE(?,banner_color), updated_at=datetime('now') WHERE id=?
    `).run(title||null, description||null, category||null, location||null, start_date||null, end_date||null,
           registration_deadline||null, fee!=null?fee:null, capacity||null, banner_color||null, req.params.id);

    logAudit({ actor_id: req.user.id, actor_role: req.user.role, action: 'symposium_updated', resource_type: 'symposium', resource_id: symp.id, old_value: old, new_value: req.body, severity: 'info', ip: req.ip });
    res.json({ message: 'Symposium updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update symposium.' });
  }
});

// ── POST /api/symposiums/:id/approve  (coordinator/admin) ─────────────────────
router.post('/:id/approve', authenticate, requireRole('coordinator', 'admin'), (req, res) => {
  try {
    const symp = db.prepare('SELECT * FROM symposiums WHERE id = ?').get(req.params.id);
    if (!symp) return res.status(404).json({ error: 'Symposium not found.' });
    db.prepare(`UPDATE symposiums SET status='approved', coordinator_id=?, updated_at=datetime('now') WHERE id=?`).run(req.user.id, symp.id);
    logAudit({ actor_id: req.user.id, actor_role: req.user.role, action: 'symposium_approved', resource_type: 'symposium', resource_id: symp.id, old_value: { status: symp.status }, new_value: { status: 'approved' }, severity: 'info', ip: req.ip });
    res.json({ message: 'Symposium approved.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve symposium.' });
  }
});

// ── POST /api/symposiums/:id/reject ──────────────────────────────────────────
router.post('/:id/reject', authenticate, requireRole('coordinator', 'admin'), (req, res) => {
  try {
    const symp = db.prepare('SELECT * FROM symposiums WHERE id = ?').get(req.params.id);
    if (!symp) return res.status(404).json({ error: 'Symposium not found.' });
    db.prepare(`UPDATE symposiums SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(symp.id);
    logAudit({ actor_id: req.user.id, actor_role: req.user.role, action: 'symposium_rejected', resource_type: 'symposium', resource_id: symp.id, severity: 'warning', ip: req.ip });
    res.json({ message: 'Symposium rejected.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject symposium.' });
  }
});

// ── DELETE /api/symposiums/:id ─────────────────────────────────────────────────
router.delete('/:id', authenticate, requireRole('admin'), (req, res) => {
  try {
    const symp = db.prepare('SELECT * FROM symposiums WHERE id = ?').get(req.params.id);
    if (!symp) return res.status(404).json({ error: 'Symposium not found.' });
    db.prepare('DELETE FROM symposiums WHERE id = ?').run(req.params.id);
    logAudit({ actor_id: req.user.id, actor_role: req.user.role, action: 'symposium_deleted', resource_type: 'symposium', resource_id: symp.id, old_value: symp, severity: 'critical', ip: req.ip });
    res.json({ message: 'Symposium deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete symposium.' });
  }
});

module.exports = router;
