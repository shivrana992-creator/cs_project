'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { installTestSessions } = require('./support/session');
const { certificateHash, signCertificate, verifyCertificate, recoverIssueDate, repairLegacyIssueDates, verificationUrl } = require('../src/certificates/integrity');

// Exercise the real routes and middleware without touching the project database.
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT, mfa_enabled INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1);
  CREATE TABLE symposiums (id INTEGER PRIMARY KEY, title TEXT, start_date TEXT, end_date TEXT, location TEXT, category TEXT, banner_color TEXT, organizer_id INTEGER);
  CREATE TABLE registrations (id INTEGER PRIMARY KEY, user_id INTEGER, symposium_id INTEGER, attendance_marked INTEGER, status TEXT, updated_at TEXT);
  CREATE TABLE certificates (id INTEGER PRIMARY KEY, cert_uuid TEXT UNIQUE, user_id INTEGER, symposium_id INTEGER, registration_id INTEGER,
    issue_date TEXT NOT NULL DEFAULT (datetime('now')), integrity_hash TEXT, integrity_algorithm TEXT NOT NULL DEFAULT 'sha256', generated_by INTEGER, revoked_at TEXT, revoked_reason TEXT,
    download_count INTEGER DEFAULT 0, last_downloaded_at TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE certificate_logs (id INTEGER PRIMARY KEY, cert_uuid TEXT, user_id INTEGER, symposium_id INTEGER, generated_by INTEGER, action TEXT, ip_address TEXT, details TEXT);
  CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, actor_id INTEGER, actor_role TEXT, action TEXT, resource_type TEXT, resource_id INTEGER, old_value TEXT, new_value TEXT, severity TEXT, ip_address TEXT);
  INSERT INTO users (id,name,email,role) VALUES (1,'Test Admin','admin@example.test','admin'), (2,'Test Participant','participant@example.test','participant');
  INSERT INTO symposiums VALUES (1,'Test Symposium','2026-09-01','2026-09-02','Test Venue','Technology','#4f46e5',1), (2,'Bulk Symposium','2026-09-01','2026-09-02','Test Venue','Technology','#4f46e5',1);
  INSERT INTO registrations VALUES (1,2,1,1,'attended',NULL), (2,2,2,1,'attended',NULL);
`);
const issueTestSession = installTestSessions(db);
const dbModule = require.resolve('../src/db/database');
require.cache[dbModule] = { id: dbModule, filename: dbModule, loaded: true, exports: db };
const { JWT_SECRET } = require('../src/middleware/auth');
const router = require('../src/routes/certificates');
const app = express();
app.use(express.json());
app.use('/api/certificates', router);
let server, baseUrl, singleId, bulkId;
const authHeaders = { Authorization: `Bearer ${issueTestSession(1, JWT_SECRET)}`, 'Content-Type': 'application/json' };

before(async () => {
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/certificates`;
});
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); db.close(); });

test('single generation saves the exact hashed timestamp and verifies publicly', async () => {
  const generated = await fetch(`${baseUrl}/generate`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ registration_id: 1 }) });
  assert.equal(generated.status, 201);
  singleId = (await generated.json()).cert_uuid;
  const cert = db.prepare('SELECT * FROM certificates WHERE cert_uuid=?').get(singleId);
  assert.match(cert.issue_date, /T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const response = await fetch(`${baseUrl}/verify/${singleId}`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.valid, true);
  assert.equal(result.certificate.hash_verified, true);
});

test('bulk generation produces valid certificates and skips duplicates', async () => {
  const generate = () => fetch(`${baseUrl}/generate`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ bulk_symposium_id: 2 }) });
  assert.equal((await (await generate()).json()).generated, 1);
  bulkId = db.prepare('SELECT cert_uuid FROM certificates WHERE symposium_id=2').get().cert_uuid;
  assert.equal((await (await fetch(`${baseUrl}/verify/${bulkId}`)).json()).valid, true);
  assert.equal((await (await generate()).json()).generated, 0);
});

test('unknown certificate returns 404 without authentication', async () => {
  const response = await fetch(`${baseUrl}/verify/missing-certificate`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).valid, false);
});

test('changing signed fields fails verification', async () => {
  db.prepare('UPDATE users SET name=? WHERE id=2').run('Altered Participant');
  try {
    const result = await (await fetch(`${baseUrl}/verify/${singleId}`)).json();
    assert.equal(result.valid, false);
    assert.equal(result.certificate.hash_verified, false);
  } finally { db.prepare('UPDATE users SET name=? WHERE id=2').run('Test Participant'); }
});

test('new signatures use the configured secret and reject tampering', () => {
  const previous = process.env.CERTIFICATE_SIGNING_KEY;
  process.env.CERTIFICATE_SIGNING_KEY = 'test-secret-that-is-long-enough-for-signing';
  try {
    const cert = { cert_uuid: 'signed-test', participant_name: 'Participant', symposium_title: 'Symposium', issue_date: '2026-10-05T10:00:00.000Z' };
    Object.assign(cert, signCertificate(cert.cert_uuid, cert.participant_name, cert.symposium_title, cert.issue_date));
    assert.equal(cert.integrity_algorithm, 'hmac-sha256');
    assert.equal(verifyCertificate(cert), true);
    assert.equal(verifyCertificate({ ...cert, participant_name: 'Changed' }), false);
  } finally {
    if (previous === undefined) delete process.env.CERTIFICATE_SIGNING_KEY;
    else process.env.CERTIFICATE_SIGNING_KEY = previous;
  }
});

test('downloaded PDF QR links open the public certificate route', async () => {
  const originalQr = QRCode.toDataURL;
  let qrUrl;
  QRCode.toDataURL = (url, options) => { qrUrl = url; return originalQr(url, options); };
  try {
    const response = await fetch(`${baseUrl}/${singleId}/download`, { headers: authHeaders });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/pdf/);
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    const { resolvePage } = await import('../../client/src/navigation.js');
    const route = resolvePage(new URL(qrUrl).hash.slice(1), null);
    assert.equal(route.allowed, true);
    assert.equal(route.page, 'verify');
    assert.equal(route.certificateId, singleId);
  } finally { QRCode.toDataURL = originalQr; }
});

test('revoked certificates remain invalid even when their hashes match', async () => {
  const revoked = await fetch(`${baseUrl}/${singleId}/revoke`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ reason: 'Test revocation' }) });
  assert.equal(revoked.status, 200);
  const result = await (await fetch(`${baseUrl}/verify/${singleId}`)).json();
  assert.equal(result.valid, false);
  assert.equal(result.revoked, true);
  assert.equal(result.revocation_reason, 'Test revocation');
  assert.equal(result.certificate.hash_verified, true);
  assert.equal((await fetch(`${baseUrl}/${singleId}/download`, { headers: authHeaders })).status, 410);
});

test('legacy timestamp recovery retains the original hash and revocation', () => {
  const legacy = { cert_uuid: 'legacy-certificate', issue_date: '2026-09-29 10:00:00', participant_name: 'Test Participant', symposium_title: 'Test Symposium' };
  const originalDate = '2026-09-29T10:00:00.321Z';
  legacy.integrity_hash = certificateHash(legacy.cert_uuid, legacy.participant_name, legacy.symposium_title, originalDate);
  assert.equal(recoverIssueDate(legacy), originalDate);
  db.prepare(`INSERT INTO certificates (cert_uuid,user_id,symposium_id,registration_id,issue_date,integrity_hash,generated_by,revoked_at,revoked_reason)
    VALUES (?,2,1,1,?,?,1,'2026-09-29 11:00:00','Retain revocation')`).run(legacy.cert_uuid, legacy.issue_date, legacy.integrity_hash);
  assert.equal(repairLegacyIssueDates(db), 1);
  const repaired = db.prepare('SELECT * FROM certificates WHERE cert_uuid=?').get(legacy.cert_uuid);
  assert.equal(repaired.issue_date, originalDate);
  assert.equal(repaired.integrity_hash, legacy.integrity_hash);
  assert.equal(repaired.revoked_reason, 'Retain revocation');
  assert.equal(repaired.revoked_at, '2026-09-29 11:00:00');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='certificate_issue_date_recovered'").get().count, 1);
  assert.equal(repairLegacyIssueDates(db), 0);
});

test('legacy recovery cannot bless a changed record or invalid timestamp', () => {
  const cert = { cert_uuid: 'tampered', issue_date: '2026-09-29 10:00:00', participant_name: 'Altered Participant', symposium_title: 'Test Symposium' };
  cert.integrity_hash = certificateHash(cert.cert_uuid, 'Original Participant', cert.symposium_title, '2026-09-29T10:00:00.321Z');
  assert.equal(recoverIssueDate(cert), null);
  assert.equal(recoverIssueDate({ ...cert, issue_date: 'invalid' }), null);
  db.prepare('INSERT INTO certificates (cert_uuid,user_id,symposium_id,registration_id,issue_date,integrity_hash,generated_by) VALUES (?,2,1,1,?,?,1)').run(cert.cert_uuid, cert.issue_date, cert.integrity_hash);
  assert.equal(repairLegacyIssueDates(db), 0);
  assert.equal(db.prepare('SELECT issue_date FROM certificates WHERE cert_uuid=?').get(cert.cert_uuid).issue_date, cert.issue_date);
});

test('verification links support APP_URL trailing slash and deployment subpaths', () => {
  assert.equal(verificationUrl('https://example.test/app/', 'test-id'), 'https://example.test/app/#/verify/test-id');
  assert.equal(verificationUrl('https://example.test/', 'test-id'), 'https://example.test/#/verify/test-id');
});
