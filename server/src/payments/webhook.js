'use strict';
const express = require('express');
const db = require('../db/database');
const payments = require('./razorpay');

const router = express.Router();
router.post('/', express.raw({ type: 'application/json', limit: '256kb' }), (req, res) => {
  if (!payments.configured()) return res.status(404).json({ error: 'Not found.' });
  if (!Buffer.isBuffer(req.body) || !payments.verifyWebhookSignature(req.body, req.headers['x-razorpay-signature'])) return res.status(400).json({ error: 'Invalid signature.' });
  try {
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event === 'payment.captured') {
      const payment = event.payload?.payment?.entity;
      if (payment?.id && payment.order_id && payment.currency === 'INR' && payment.status === 'captured') {
        const reg = db.prepare(`SELECT r.id,r.user_id,r.symposium_id,s.fee FROM registrations r JOIN symposiums s ON s.id=r.symposium_id WHERE r.payment_order_id=?`).get(payment.order_id);
        if (reg && payment.amount === payments.amountPaise(reg.fee)) {
          const result = db.prepare(`UPDATE registrations SET status='confirmed', payment_status='paid', payment_reference=?, payment_method=?, amount_paid=?, payment_date=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='registered' AND payment_status='pending'`).run(payment.id, payment.method || 'razorpay', reg.fee, reg.id);
          if (result.changes) db.prepare('INSERT INTO notifications (user_id,title,message) VALUES (?,?,?)').run(reg.user_id, 'Payment completed', 'Your symposium registration is confirmed.');
        }
      }
    }
    if (event.event === 'refund.processed' || event.event === 'refund.failed') {
      const refund = event.payload?.refund?.entity;
      if (refund?.id && refund.payment_id) {
        const status = event.event === 'refund.processed' ? 'processed' : 'failed';
        const reg = db.prepare('SELECT id,user_id,refund_status FROM registrations WHERE refund_reference=? AND payment_reference=?').get(refund.id, refund.payment_id);
        if (reg && reg.refund_status !== status) {
          db.prepare("UPDATE registrations SET refund_status=?, payment_status=?, updated_at=datetime('now') WHERE id=?").run(status, status === 'failed' ? 'paid' : 'refunded', reg.id);
          db.prepare('INSERT INTO notifications (user_id,title,message) VALUES (?,?,?)').run(reg.user_id, status === 'failed' ? 'Refund needs attention' : 'Refund processed', status === 'failed' ? 'Your refund could not be processed. Please contact the organizer.' : 'Your refund has been processed.');
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[PAYMENT] Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

module.exports = router;
