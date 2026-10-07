'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { createHmac } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

process.env.PAYMENT_MODE = 'razorpay';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'test-payment-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-webhook-secret';
const payments = require('../src/payments/razorpay');
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE symposiums (id INTEGER PRIMARY KEY, fee REAL);
  CREATE TABLE registrations (id INTEGER PRIMARY KEY, user_id INTEGER, symposium_id INTEGER, status TEXT, payment_status TEXT, payment_order_id TEXT, payment_reference TEXT, payment_method TEXT, amount_paid REAL, payment_date TEXT, refund_reference TEXT, refund_status TEXT, updated_at TEXT);
  CREATE TABLE notifications (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, message TEXT);
  INSERT INTO symposiums VALUES (1, 125);
  INSERT INTO registrations (id,user_id,symposium_id,status,payment_status,payment_order_id) VALUES (1,2,1,'registered','pending','order_test123');
`);
const dbModule = require.resolve('../src/db/database');
require.cache[dbModule] = { id: dbModule, filename: dbModule, loaded: true, exports: db };
const app = express();
app.use('/webhook', require('../src/payments/webhook'));
let server, base;
before(async () => {
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}/webhook`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });

function deliver(body, secret = process.env.RAZORPAY_WEBHOOK_SECRET) {
  const raw = JSON.stringify(body);
  const signature = createHmac('sha256', secret).update(raw).digest('hex');
  return fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature }, body: raw });
}

test('checkout signature uses the stored order and rejects tampering', () => {
  const signature = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update('order_test123|pay_test123').digest('hex');
  assert.equal(payments.verifyCheckoutSignature('order_test123', 'pay_test123', signature), true);
  assert.equal(payments.verifyCheckoutSignature('order_other', 'pay_test123', signature), false);
  assert.equal(payments.amountPaise(10.99), 1099);
  assert.throws(() => payments.amountPaise(10.999));
});

test('webhook rejects invalid signature and captures a matching payment once', async () => {
  const event = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_test123', order_id: 'order_test123', status: 'captured', currency: 'INR', amount: 12500, method: 'upi' } } } };
  assert.equal((await deliver(event, 'wrong-secret')).status, 400);
  assert.equal((await deliver(event)).status, 200);
  assert.equal((await deliver(event)).status, 200);
  const reg = db.prepare('SELECT status,payment_status,payment_reference FROM registrations WHERE id=1').get();
  assert.equal(reg.status, 'confirmed');
  assert.equal(reg.payment_status, 'paid');
  assert.equal(reg.payment_reference, 'pay_test123');
  assert.equal(db.prepare('SELECT count(*) AS count FROM notifications').get().count, 1);
});

test('refund webhook records a failed refund for follow-up', async () => {
  db.prepare("UPDATE registrations SET status='cancelled',payment_status='refunded',refund_reference='rfnd_test123',refund_status='pending' WHERE id=1").run();
  const event = { event: 'refund.failed', payload: { refund: { entity: { id: 'rfnd_test123', payment_id: 'pay_test123' } } } };
  assert.equal((await deliver(event)).status, 200);
  const reg = db.prepare('SELECT payment_status,refund_status FROM registrations WHERE id=1').get();
  assert.equal(reg.payment_status, 'paid');
  assert.equal(reg.refund_status, 'failed');
});
