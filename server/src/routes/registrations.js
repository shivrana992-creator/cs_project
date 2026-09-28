'use strict';
const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { logRegistration, logActivity, logAudit } = require('../middleware/accounting');

const router = express.Router();

// ── POST /api/registrations  (participant registers for a symposium) ───────────
router.post('/', authenticate, requireRole('participant'), (req, res) => {
  try {
    const { symposium_id } = req.body;
    if (!symposium_id) return res.status(400).json({ error: 'symposium_id is required.' });

    const symp = db.prepare('SELECT * FROM symposiums WHERE id = ?').get(symposium_id);
    if (!symp) return res.status(404).json({ error: 'Symposium not found.' });
    if (symp.status !== 'approved') return res.status(400).json({ error: 'This symposium is not open for registration.' });

    // Registration deadline check
    if (new Date() > new Date(symp.registration_deadline + 'T23:59:59')) {
      return res.status(400).json({ error: 'Registration deadline has passed.' });
    }

    // Capacity check
    const regCount = db.prepare(`SELECT count(*) as c FROM registrations WHERE symposium_id = ? AND status NOT IN ('cancelled')`).get(symposium_id);
    if (regCount.c >= symp.capacity) return res.status(400).json({ error: 'Symposium is fully booked.' });

    // Duplicate check
    const existing = db.prepare('SELECT id FROM registrations WHERE user_id = ? AND symposium_id = ?').get(req.user.id, symposium_id);
    if (existing) return res.status(409).json({ error: 'You are already registered for this symposium.' });

    const payStatus = symp.fee === 0 ? 'free' : 'pending';
    const regStatus = symp.fee === 0 ? 'confirmed' : 'registered';

    const result = db.prepare(`
      INSERT INTO registrations (user_id, symposium_id, status, payment_status, amount_paid, checkin_token)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.user.id, symposium_id, regStatus, payStatus, 0, randomUUID());
    db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(req.user.id, 'Registration received', `Your registration for ${symp.title} is ${symp.fee === 0 ? 'confirmed' : 'awaiting demo payment'}.`);

    logRegistration({ user_id: req.user.id, symposium_id, registration_id: result.lastInsertRowid, action: 'registered', new_status: regStatus, ip: req.ip });
    logActivity({ user_id: req.user.id, role: req.user.role, action: 'symposium_registration', resource_type: 'registration', resource_id: result.lastInsertRowid, ip: req.ip });

    res.status(201).json({ message: 'Registration successful!', registration_id: result.lastInsertRowid, status: regStatus, payment_required: symp.fee > 0, fee: symp.fee });
  } catch (err) {
    console.error('[REG] Register error:', err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

// ── POST /api/registrations/:id/payment ──────────────────────────────────────
router.post('/:id/payment', authenticate, requireRole('participant'), (req, res) => {
  try {
    const reg = db.prepare('SELECT * FROM registrations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!reg) return res.status(404).json({ error: 'Registration not found.' });
    if (reg.payment_status === 'paid') return res.status(400).json({ error: 'Payment already completed.' });
    if (reg.status === 'cancelled') return res.status(400).json({ error: 'Registration is cancelled.' });

    const { method = 'card' } = req.body;
    const payRef = `PAY-${randomUUID().split('-')[0].toUpperCase()}`;

    db.prepare(`UPDATE registrations SET status='confirmed', payment_status='paid', payment_reference=?, payment_method=?,
                amount_paid=(SELECT fee FROM symposiums WHERE id=registrations.symposium_id),
                payment_date=datetime('now'), updated_at=datetime('now') WHERE id=?`)
      .run(payRef, method, reg.id);
    const symposiumTitle = db.prepare('SELECT title FROM symposiums WHERE id=?').get(reg.symposium_id)?.title || 'the symposium';
    db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(req.user.id, 'Demo payment completed', `Your registration for ${symposiumTitle} is confirmed. No real payment was taken.`);

    logRegistration({ user_id: req.user.id, symposium_id: reg.symposium_id, registration_id: reg.id, action: 'payment_completed', old_status: reg.status, new_status: 'confirmed', details: `ref:${payRef}`, ip: req.ip });
    logAudit({ actor_id: req.user.id, actor_role: 'participant', action: 'payment_processed', resource_type: 'registration', resource_id: reg.id, new_value: { ref: payRef, method }, severity: 'info', ip: req.ip });

    res.json({ message: 'Payment successful! Registration confirmed.', payment_reference: payRef });
  } catch (err) {
    res.status(500).json({ error: 'Payment processing failed.' });
  }
});

// ── GET /api/registrations/my  (participant's own registrations) ──────────────
router.get('/my', authenticate, requireRole('participant'), (req, res) => {
  try {
    const regs = db.prepare(`
      SELECT r.*, r.checkin_token, s.title as symposium_title, s.start_date, s.end_date, s.location,
             s.banner_color, s.fee, s.category,
             (SELECT cert_uuid FROM certificates c WHERE c.registration_id = r.id LIMIT 1) as cert_uuid
      FROM registrations r
      JOIN symposiums s ON r.symposium_id = s.id
      WHERE r.user_id = ?
      ORDER BY r.registration_date DESC
    `).all(req.user.id);
    res.json({ registrations: regs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch registrations.' });
  }
});

// ── GET /api/registrations/symposium/:sympId  (organizer views all registrants) ─
router.get('/symposium/:sympId', authenticate, requireRole('organizer', 'admin', 'coordinator'), (req, res) => {
  try {
    const symp = db.prepare('SELECT * FROM symposiums WHERE id = ?').get(req.params.sympId);
    if (!symp) return res.status(404).json({ error: 'Symposium not found.' });
    if (req.user.role === 'organizer' && symp.organizer_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });

    const regs = db.prepare(`
      SELECT r.*, u.name as participant_name, u.email as participant_email,
             (SELECT cert_uuid FROM certificates c WHERE c.registration_id = r.id LIMIT 1) as cert_uuid
      FROM registrations r
      JOIN users u ON r.user_id = u.id
      WHERE r.symposium_id = ?
      ORDER BY r.registration_date DESC
    `).all(req.params.sympId);
    res.json({ registrations: regs, symposium: symp });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch registrations.' });
  }
});

// ── GET /api/registrations/:id  (single registration) ────────────────────────
router.get('/:id', authenticate, (req, res) => {
  try {
    const reg = db.prepare(`
      SELECT r.*, s.title as symposium_title, s.location, s.start_date, s.end_date, s.banner_color,
             u.name as participant_name, u.email as participant_email
      FROM registrations r JOIN symposiums s ON r.symposium_id = s.id JOIN users u ON r.user_id = u.id
      WHERE r.id = ?
    `).get(req.params.id);
    if (!reg) return res.status(404).json({ error: 'Registration not found.' });
    if (req.user.role === 'participant' && reg.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    res.json({ registration: reg });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch registration.' });
  }
});

// ── POST /api/registrations/:id/cancel ────────────────────────────────────────
router.post('/:id/cancel', authenticate, requireRole('participant', 'admin'), (req, res) => {
  try {
    const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(req.params.id);
    if (!reg) return res.status(404).json({ error: 'Registration not found.' });
    if (req.user.role === 'participant' && reg.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    if (['cancelled', 'attended', 'certificate_issued'].includes(reg.status)) return res.status(400).json({ error: `Cannot cancel registration with status: ${reg.status}` });

    const demoRefund = reg.payment_status === 'paid';
    db.prepare(`UPDATE registrations SET status='cancelled', payment_status=CASE WHEN payment_status='paid' THEN 'refunded' ELSE payment_status END, updated_at=datetime('now') WHERE id=?`).run(reg.id);
    if (demoRefund) db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(reg.user_id, 'Demo refund recorded', 'The demo payment status was marked refunded. No real payment was taken or returned.');
    logRegistration({ user_id: reg.user_id, symposium_id: reg.symposium_id, registration_id: reg.id, action: 'registration_cancelled', old_status: reg.status, new_status: 'cancelled', ip: req.ip });
    res.json({ message: demoRefund ? 'Registration cancelled. Demo refund recorded; no real money was involved.' : 'Registration cancelled.', demo_refund: demoRefund });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel registration.' });
  }
});

module.exports = router;
