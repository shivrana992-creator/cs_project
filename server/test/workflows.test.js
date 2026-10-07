'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const cookieParser = require('cookie-parser');
const { installTestSessions } = require('./support/session');

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, password_hash TEXT, role TEXT, mfa_enabled INTEGER DEFAULT 0, mfa_secret TEXT, mfa_backup_codes TEXT, is_active INTEGER DEFAULT 1, email_verified INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE symposiums (id INTEGER PRIMARY KEY, title TEXT, start_date TEXT, end_date TEXT, location TEXT, registration_deadline TEXT, status TEXT, fee REAL, capacity INTEGER, organizer_id INTEGER);
  CREATE TABLE registrations (id INTEGER PRIMARY KEY, user_id INTEGER, symposium_id INTEGER, status TEXT, payment_status TEXT, amount_paid REAL, checkin_token TEXT, payment_reference TEXT, payment_order_id TEXT, payment_method TEXT, payment_date TEXT, refund_reference TEXT, refund_status TEXT, attendance_marked INTEGER DEFAULT 0, registration_date TEXT DEFAULT (datetime('now')), updated_at TEXT, UNIQUE(user_id,symposium_id));
  CREATE TABLE certificates (id INTEGER PRIMARY KEY, cert_uuid TEXT UNIQUE, user_id INTEGER, symposium_id INTEGER, registration_id INTEGER, issue_date TEXT, integrity_hash TEXT, integrity_algorithm TEXT NOT NULL DEFAULT 'sha256', generated_by INTEGER, revoked_at TEXT);
  CREATE TABLE notifications (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, message TEXT);
  CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO symposiums VALUES (1,'Paid event','2099-02-01','2099-02-02','Hall','2099-01-01','approved',50,10,1), (2,'Free event','2099-03-01','2099-03-02','Hall','2099-02-01','approved',0,10,1);
  INSERT INTO system_settings VALUES ('allow_self_registration','true'), ('session_timeout_minutes','45'), ('max_registrations_per_user','10');
`);
const issueTestSession = installTestSessions(db);
db.prepare('INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)').run(1, 'Organizer', 'organizer@test.example', bcrypt.hashSync('Password@1', 4), 'organizer');
db.prepare('INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)').run(2, 'Participant', 'participant@test.example', bcrypt.hashSync('Password@1', 4), 'participant');
const dbModule = require.resolve('../src/db/database');
require.cache[dbModule] = { id: dbModule, filename: dbModule, loaded: true, exports: db };
const accountingModule = require.resolve('../src/middleware/accounting');
require.cache[accountingModule] = { id: accountingModule, filename: accountingModule, loaded: true, exports: new Proxy({}, { get: () => () => {} }) };
const { JWT_SECRET } = require('../src/middleware/auth');
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', require('../src/routes/auth'));
app.use('/api/registrations', require('../src/routes/registrations'));
app.use('/api/attendance', require('../src/routes/attendance'));
app.use('/api/certificates', require('../src/routes/certificates'));
let server, base;
const headers = id => ({ Authorization: `Bearer ${issueTestSession(id, JWT_SECRET)}`, 'Content-Type': 'application/json' });
const post = (path, body, id = 2) => fetch(`${base}${path}`, { method: 'POST', headers: headers(id), body: JSON.stringify(body) });

before(async () => {
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });

test('settings enforce self registration and session duration', async () => {
  db.prepare("UPDATE system_settings SET value='false' WHERE key='allow_self_registration'").run();
  const blocked = await post('/auth/register', { name: 'New User', email: 'new@test.example', password: 'Password@1' });
  assert.equal(blocked.status, 403);
  db.prepare("UPDATE system_settings SET value='true' WHERE key='allow_self_registration'").run();
  const config = await (await fetch(`${base}/auth/config`)).json();
  assert.equal(config.config.session_timeout_minutes, 45);
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'participant@test.example', password: 'Password@1' }) });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /Max-Age=2700/);
});

test('logout revokes one session and switching accounts revokes the replaced session', async () => {
  const login = async (email, cookie) => {
    const response = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ email, password: 'Password@1' }),
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const me = cookie => fetch(`${base}/auth/me`, { headers: { Cookie: cookie } });
  const first = await login('participant@test.example');
  const second = await login('participant@test.example');
  assert.equal((await me(first)).status, 200);
  assert.equal((await me(second)).status, 200);

  const staleTabLogout = await fetch(`${base}/auth/logout`, {
    method: 'POST', headers: { Cookie: second, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_user_id: 1 }),
  });
  assert.equal(staleTabLogout.status, 409);
  assert.equal((await me(second)).status, 200);

  assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Cookie: first } })).status, 200);
  assert.equal((await me(first)).status, 401);
  assert.equal((await me(second)).status, 200);

  const organizer = await login('organizer@test.example', second);
  assert.equal((await me(second)).status, 401);
  assert.equal((await me(organizer)).status, 200);
  assert.equal((await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${jwt.sign({ id: 2 }, JWT_SECRET)}` } })).status, 401);
});

test('bulk attendance refuses unpaid registration and issued certificate changes', async () => {
  const created = await post('/registrations', { symposium_id: 1 });
  assert.equal(created.status, 201);
  const id = (await created.json()).registration_id;
  assert.equal((await post('/attendance/mark', { bulk: [{ registration_id: id, present: true }] }, 1)).status, 200);
  assert.equal(db.prepare('SELECT status FROM registrations WHERE id=?').get(id).status, 'registered');
  assert.equal((await post(`/registrations/${id}/payment`, {})).status, 200);
  assert.equal((await post('/attendance/mark', { bulk: [{ registration_id: id, present: true }] }, 1)).status, 200);
  assert.equal(db.prepare('SELECT status FROM registrations WHERE id=?').get(id).status, 'attended');
  assert.equal((await post('/certificates/generate', { registration_id: id }, 1)).status, 201);
  assert.equal((await post('/attendance/mark', { bulk: [{ registration_id: id, present: false }] }, 1)).status, 200);
  assert.equal(db.prepare('SELECT status,attendance_marked FROM registrations WHERE id=?').get(id).status, 'certificate_issued');
  assert.equal(db.prepare('SELECT attendance_marked FROM registrations WHERE id=?').get(id).attendance_marked, 1);
});

test('canceled registration can be reinstated with new payment state', async () => {
  const created = await post('/registrations', { symposium_id: 2 });
  assert.equal(created.status, 201);
  const id = (await created.json()).registration_id;
  assert.equal((await post(`/registrations/${id}/cancel`, {})).status, 200);
  const again = await post('/registrations', { symposium_id: 2 });
  assert.equal(again.status, 201);
  assert.equal((await again.json()).registration_id, id);
  assert.deepEqual({ ...db.prepare('SELECT status,payment_status,attendance_marked FROM registrations WHERE id=?').get(id) }, { status: 'confirmed', payment_status: 'free', attendance_marked: 0 });
});

test('MFA backup codes are stored as hashes and work once', async () => {
  const setup = await post('/auth/mfa/setup', {});
  assert.equal(setup.status, 200);
  const secret = (await setup.json()).secret;
  const verified = await post('/auth/mfa/verify-setup', { code: authenticator.generate(secret) });
  assert.equal(verified.status, 200);
  const backup = (await verified.json()).backup_codes[0];
  const stored = db.prepare('SELECT mfa_backup_codes FROM users WHERE id=2').get().mfa_backup_codes;
  assert.equal(stored.includes(backup), false);
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'participant@test.example', password: 'Password@1' }) });
  assert.equal(login.status, 200);
  const challenge = (await login.json()).mfa_token;
  assert.equal((await post('/auth/mfa/verify-login', { mfa_token: challenge, code: backup })).status, 200);
  assert.equal((await post('/auth/mfa/verify-login', { mfa_token: challenge, code: backup })).status, 401);
});
