'use strict';
const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { logRegistration, logActivity, logAudit } = require('../middleware/accounting');
const { setting } = require('../settings');
const payments = require('../payments/razorpay');

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
    const existing = db.prepare('SELECT id, status FROM registrations WHERE user_id = ? AND symposium_id = ?').get(req.user.id, symposium_id);
    if (existing && existing.status !== 'cancelled') return res.status(409).json({ error: 'You are already registered for this symposium.' });
    const maxRegistrations = Number(setting('max_registrations_per_user', '10'));
    if (Number.isInteger(maxRegistrations) && maxRegistrations > 0) {
      const active = db.prepare("SELECT count(*) AS c FROM registrations WHERE user_id=? AND status!='cancelled'").get(req.user.id).c;
      if (active >= maxRegistrations) return res.status(400).json({ error: 'You have reached the active registration limit.' });
    }

    const payStatus = symp.fee === 0 ? 'free' : 'pending';
    const regStatus = symp.fee === 0 ? 'confirmed' : 'registered';

    const result = existing
      ? (db.prepare(`UPDATE registrations SET status=?, payment_status=?, amount_paid=0, payment_reference=NULL,
          payment_order_id=NULL, payment_method=NULL, payment_date=NULL, refund_reference=NULL, refund_status=NULL,
          attendance_marked=0, checkin_token=?,
          registration_date=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='cancelled'`)
          .run(regStatus, payStatus, randomUUID(), existing.id), { lastInsertRowid: existing.id })
      : db.prepare(`INSERT INTO registrations (user_id, symposium_id, status, payment_status, amount_paid, checkin_token)
          VALUES (?, ?, ?, ?, ?, ?)`).run(req.user.id, symposium_id, regStatus, payStatus, 0, randomUUID());
    db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(req.user.id, 'Registration received', `Your registration for ${symp.title} is ${symp.fee === 0 ? 'confirmed' : 'awaiting payment'}.`);

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
    if (payments.configured()) return res.status(409).json({ error: 'Use the payment checkout for this registration.' });
    const reg = db.prepare('SELECT * FROM registrations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!reg) return res.status(404).json({ error: 'Registration not found.' });
    if (reg.payment_status !== 'pending' || reg.status !== 'registered') return res.status(400).json({ error: 'Only pending registrations can be paid.' });

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

router.post('/:id/payment/order', authenticate, requireRole('participant'), async (req, res) => {
  if (!payments.configured()) return res.status(409).json({ error: 'Real payments are not configured.' });
  try {
    const reg = db.prepare(`SELECT r.*, s.fee, s.title FROM registrations r JOIN symposiums s ON s.id=r.symposium_id WHERE r.id=? AND r.user_id=?`).get(req.params.id, req.user.id);
    if (!reg) return res.status(404).json({ error: 'Registration not found.' });
    if (reg.status !== 'registered' || reg.payment_status !== 'pending') return res.status(409).json({ error: 'Registration is not awaiting payment.' });
    const amount = payments.amountPaise(reg.fee);
    let orderId = reg.payment_order_id;
    if (!orderId) {
      const order = await payments.request('/orders', 'POST', { amount, currency: 'INR', receipt: `reg_${reg.id}_${randomUUID().slice(0, 8)}` });
      if (!order.id || order.amount !== amount || order.currency !== 'INR') throw new Error('Unexpected order response.');
      const updated = db.prepare("UPDATE registrations SET payment_order_id=?, updated_at=datetime('now') WHERE id=? AND status='registered' AND payment_order_id IS NULL").run(order.id, reg.id);
      if (!updated.changes) return res.status(409).json({ error: 'Registration changed. Please refresh.' });
      orderId = order.id;
    }
    res.json({ order_id: orderId, amount, currency: 'INR', key_id: payments.credentials().keyId, name: setting('site_name', 'SymposiHub'), description: reg.title });
  } catch (err) {
    console.error('[PAYMENT] Order error:', err);
    res.status(502).json({ error: 'Could not start payment. Please try again.' });
  }
});

router.post('/:id/payment/confirm', authenticate, requireRole('participant'), async (req, res) => {
  if (!payments.configured()) return res.status(409).json({ error: 'Real payments are not configured.' });
  try {
    const reg = db.prepare(`SELECT r.*, s.fee FROM registrations r JOIN symposiums s ON s.id=r.symposium_id WHERE r.id=? AND r.user_id=?`).get(req.params.id, req.user.id);
    if (!reg) return res.status(404).json({ error: 'Registration not found.' });
    const { razorpay_payment_id: paymentId, razorpay_order_id: orderId, razorpay_signature: signature } = req.body;
    if (orderId !== reg.payment_order_id || !payments.verifyCheckoutSignature(reg.payment_order_id, paymentId, signature)) return res.status(400).json({ error: 'Payment verification failed.' });
    if (reg.status === 'confirmed' && reg.payment_status === 'paid' && reg.payment_reference === paymentId) return res.json({ message: 'Payment confirmed.', payment_reference: paymentId });
    if (reg.status !== 'registered' || reg.payment_status !== 'pending') return res.status(409).json({ error: 'Registration is not awaiting payment.' });
    const payment = await payments.request(`/payments/${encodeURIComponent(paymentId)}`);
    if (payment.id !== paymentId || payment.order_id !== reg.payment_order_id || payment.status !== 'captured' || payment.currency !== 'INR' || payment.amount !== payments.amountPaise(reg.fee)) return res.status(409).json({ error: 'Payment has not been captured for this registration.' });
    const updated = db.prepare(`UPDATE registrations SET status='confirmed', payment_status='paid', payment_reference=?, payment_method=?, amount_paid=?, payment_date=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='registered' AND payment_status='pending'`).run(paymentId, payment.method || 'razorpay', reg.fee, reg.id);
    if (!updated.changes) {
      const latest = db.prepare('SELECT status,payment_status,payment_reference FROM registrations WHERE id=?').get(reg.id);
      if (latest.status === 'confirmed' && latest.payment_status === 'paid' && latest.payment_reference === paymentId) return res.json({ message: 'Payment confirmed.', payment_reference: paymentId });
      return res.status(409).json({ error: 'Registration changed. Please refresh.' });
    }
    db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(req.user.id, 'Payment completed', 'Your symposium registration is confirmed.');
    logRegistration({ user_id: req.user.id, symposium_id: reg.symposium_id, registration_id: reg.id, action: 'payment_completed', old_status: reg.status, new_status: 'confirmed', details: `ref:${paymentId}`, ip: req.ip });
    logAudit({ actor_id: req.user.id, actor_role: 'participant', action: 'payment_processed', resource_type: 'registration', resource_id: reg.id, new_value: { ref: paymentId, method: payment.method }, severity: 'info', ip: req.ip });
    res.json({ message: 'Payment confirmed.', payment_reference: paymentId });
  } catch (err) {
    console.error('[PAYMENT] Confirmation error:', err);
    res.status(502).json({ error: 'Could not verify payment. Please try again.' });
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

router.get('/:id/refund-status', authenticate, requireRole('participant', 'admin'), async (req, res) => {
  try {
    const reg = db.prepare('SELECT id,user_id,payment_reference,refund_reference,refund_status FROM registrations WHERE id=?').get(req.params.id);
    if (!reg) return res.status(404).json({ error: 'Registration not found.' });
    if (req.user.role === 'participant' && reg.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    if (!payments.configured() || !reg.refund_reference) return res.json({ refund_status: reg.refund_status });
    const refund = await payments.request(`/refunds/${encodeURIComponent(reg.refund_reference)}`);
    if (refund.id !== reg.refund_reference || refund.payment_id !== reg.payment_reference) throw new Error('Unexpected refund response.');
    db.prepare("UPDATE registrations SET refund_status=?, payment_status=?, updated_at=datetime('now') WHERE id=?").run(refund.status, refund.status === 'failed' ? 'paid' : 'refunded', reg.id);
    res.json({ refund_status: refund.status });
  } catch (err) {
    console.error('[PAYMENT] Refund status error:', err);
    res.status(502).json({ error: 'Could not check refund status.' });
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
      SELECT r.*, s.title as symposium_title, s.location, s.start_date, s.end_date, s.banner_color, s.organizer_id,
             u.name as participant_name, u.email as participant_email
      FROM registrations r JOIN symposiums s ON r.symposium_id = s.id JOIN users u ON r.user_id = u.id
      WHERE r.id = ?
    `).get(req.params.id);
    if (!reg) return res.status(404).json({ error: 'Registration not found.' });
    if (req.user.role === 'participant' && reg.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    if (req.user.role === 'organizer' && reg.organizer_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    res.json({ registration: reg });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch registration.' });
  }
});

// ── POST /api/registrations/:id/cancel ────────────────────────────────────────
router.post('/:id/cancel', authenticate, requireRole('participant', 'admin'), async (req, res) => {
  try {
    const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(req.params.id);
    if (!reg) return res.status(404).json({ error: 'Registration not found.' });
    if (req.user.role === 'participant' && reg.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    if (['cancelled', 'attended', 'certificate_issued'].includes(reg.status)) return res.status(400).json({ error: `Cannot cancel registration with status: ${reg.status}` });
    if (payments.configured() && reg.payment_status === 'pending' && reg.payment_order_id) return res.status(409).json({ error: 'Payment checkout has started. Complete payment or contact the organizer to resolve it before canceling.' });

    const hasPayment = reg.payment_status === 'paid';
    let refund = null;
    if (hasPayment && payments.configured()) {
      if (!/^pay_[a-zA-Z0-9]+$/.test(reg.payment_reference || '')) return res.status(409).json({ error: 'This payment needs a manual refund. Contact an administrator.' });
      const reserved = db.prepare("UPDATE registrations SET refund_status='requested',updated_at=datetime('now') WHERE id=? AND status!='cancelled' AND refund_status IS NULL").run(reg.id);
      if (!reserved.changes) return res.status(409).json({ error: 'A refund is already being handled for this registration.' });
      try {
        refund = await payments.request(`/payments/${encodeURIComponent(reg.payment_reference)}/refund`, 'POST', { amount: payments.amountPaise(reg.amount_paid), notes: { registration_id: String(reg.id) } });
        if (!refund.id || refund.payment_id !== reg.payment_reference) throw new Error('Unexpected refund response.');
      } catch (err) {
        db.prepare("UPDATE registrations SET refund_status='needs_review' WHERE id=?").run(reg.id);
        throw err;
      }
    }
    db.prepare(`UPDATE registrations SET status='cancelled', payment_status=CASE WHEN payment_status='paid' THEN 'refunded' ELSE payment_status END,
      refund_reference=?, refund_status=?, updated_at=datetime('now') WHERE id=?`).run(refund?.id || null, refund?.status || (hasPayment ? 'demo' : null), reg.id);
    if (hasPayment) db.prepare('INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)').run(reg.user_id, refund ? 'Refund submitted' : 'Demo refund recorded', refund ? `Refund ${refund.id} was submitted with status ${refund.status}.` : 'The demo payment status was marked refunded. No real payment was taken or returned.');
    logRegistration({ user_id: reg.user_id, symposium_id: reg.symposium_id, registration_id: reg.id, action: 'registration_cancelled', old_status: reg.status, new_status: 'cancelled', ip: req.ip });
    res.json({ message: refund ? 'Registration cancelled. Refund submitted.' : hasPayment ? 'Registration cancelled. Demo refund recorded; no real money was involved.' : 'Registration cancelled.', refund_status: refund?.status || null, demo_refund: hasPayment && !refund });
  } catch (err) {
    console.error('[REG] Cancel error:', err);
    res.status(502).json({ error: 'Cancellation could not be completed. Please try again.' });
  }
});

module.exports = router;
