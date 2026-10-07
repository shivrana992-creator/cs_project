'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { createHmac } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const jwt = require('jsonwebtoken');
const { installTestSessions } = require('./support/session');

process.env.PAYMENT_MODE = 'razorpay';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'test-payment-secret';
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT, mfa_enabled INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1);
  CREATE TABLE symposiums (id INTEGER PRIMARY KEY, title TEXT, fee REAL, organizer_id INTEGER, status TEXT, capacity INTEGER, registration_deadline TEXT);
  CREATE TABLE registrations (id INTEGER PRIMARY KEY, user_id INTEGER, symposium_id INTEGER, status TEXT, payment_status TEXT, amount_paid REAL, checkin_token TEXT, payment_reference TEXT, payment_order_id TEXT, payment_method TEXT, payment_date TEXT, refund_reference TEXT, refund_status TEXT, attendance_marked INTEGER DEFAULT 0, registration_date TEXT DEFAULT (datetime('now')), updated_at TEXT, UNIQUE(user_id,symposium_id));
  CREATE TABLE notifications (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, message TEXT);
  CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO users VALUES (1,'Participant','participant@test.example','participant',0,1);
  INSERT INTO symposiums VALUES (1,'Paid event',125,1,'approved',10,'2099-01-01');
  INSERT INTO registrations (id,user_id,symposium_id,status,payment_status,amount_paid) VALUES (1,1,1,'registered','pending',0);
`);
const issueTestSession = installTestSessions(db);
const dbModule = require.resolve('../src/db/database');
require.cache[dbModule] = { id: dbModule, filename: dbModule, loaded: true, exports: db };
const accountingModule = require.resolve('../src/middleware/accounting');
require.cache[accountingModule] = { id: accountingModule, filename: accountingModule, loaded: true, exports: new Proxy({}, { get: () => () => {} }) };
const { JWT_SECRET } = require('../src/middleware/auth');
const app = express();
app.use(express.json());
app.use('/api/registrations', require('../src/routes/registrations'));
let server, base;
const originalFetch = global.fetch;
global.fetch = (url, options) => {
  if (!String(url).startsWith('https://api.razorpay.com/v1/')) return originalFetch(url, options);
  if (String(url).endsWith('/orders')) return Promise.resolve(new Response(JSON.stringify({ id: 'order_test123', amount: 12500, currency: 'INR' }), { status: 200 }));
  if (String(url).endsWith('/payments/pay_test123')) return Promise.resolve(new Response(JSON.stringify({ id: 'pay_test123', order_id: 'order_test123', status: 'captured', currency: 'INR', amount: 12500, method: 'upi' }), { status: 200 }));
  if (String(url).endsWith('/payments/pay_test123/refund')) return Promise.resolve(new Response(JSON.stringify({ id: 'rfnd_test123', payment_id: 'pay_test123', status: 'pending' }), { status: 200 }));
  throw new Error(`Unexpected payment URL: ${url}`);
};
const headers = { Authorization: `Bearer ${issueTestSession(1, JWT_SECRET)}`, 'Content-Type': 'application/json' };
const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
before(async () => {
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}/api/registrations/1`;
});
after(async () => { global.fetch = originalFetch; await new Promise(resolve => server.close(resolve)); db.close(); });

test('real checkout requires order, signature, and captured payment before confirmation', async () => {
  assert.equal((await post('/payment', {})).status, 409);
  const started = await post('/payment/order', {});
  assert.equal(started.status, 200);
  assert.equal((await started.json()).order_id, 'order_test123');
  assert.equal(db.prepare('SELECT payment_order_id FROM registrations WHERE id=1').get().payment_order_id, 'order_test123');
  assert.equal((await post('/cancel', {})).status, 409);
  assert.equal((await post('/payment/confirm', { razorpay_order_id: 'order_test123', razorpay_payment_id: 'pay_test123', razorpay_signature: '0'.repeat(64) })).status, 400);
  const signature = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update('order_test123|pay_test123').digest('hex');
  assert.equal((await post('/payment/confirm', { razorpay_order_id: 'order_test123', razorpay_payment_id: 'pay_test123', razorpay_signature: signature })).status, 200);
  assert.equal((await post('/payment/confirm', { razorpay_order_id: 'order_test123', razorpay_payment_id: 'pay_test123', razorpay_signature: signature })).status, 200);
  assert.equal(db.prepare('SELECT status FROM registrations WHERE id=1').get().status, 'confirmed');
});

test('cancellation submits the linked refund and records provider status', async () => {
  const canceled = await post('/cancel', {});
  assert.equal(canceled.status, 200);
  const reg = db.prepare('SELECT status,payment_status,refund_reference,refund_status FROM registrations WHERE id=1').get();
  assert.equal(reg.status, 'cancelled');
  assert.equal(reg.refund_reference, 'rfnd_test123');
  assert.equal(reg.refund_status, 'pending');
});
