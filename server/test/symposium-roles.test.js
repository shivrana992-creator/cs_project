'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
const jwt = require('jsonwebtoken');
const { installTestSessions } = require('./support/session');

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT, mfa_enabled INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1);
  CREATE TABLE symposiums (
    id INTEGER PRIMARY KEY, title TEXT, description TEXT, category TEXT, location TEXT,
    start_date TEXT, end_date TEXT, registration_deadline TEXT, fee REAL, capacity INTEGER,
    organizer_id INTEGER, coordinator_id INTEGER, status TEXT, banner_color TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
  );
  CREATE TABLE registrations (id INTEGER PRIMARY KEY, symposium_id INTEGER, status TEXT);
  INSERT INTO users (id, name, email, role) VALUES
    (1, 'Organizer One', 'organizer1@example.test', 'organizer'),
    (2, 'Organizer Two', 'organizer2@example.test', 'organizer'),
    (3, 'Coordinator', 'coordinator@example.test', 'coordinator'),
    (4, 'Admin', 'admin@example.test', 'admin');
  INSERT INTO symposiums (id, title, location, start_date, end_date, registration_deadline, fee, capacity, organizer_id, status) VALUES
    (1, 'First event', 'Hall A', '2099-02-01', '2099-02-02', '2099-01-01', 0, 100, 1, 'pending_approval'),
    (2, 'Second event', 'Hall B', '2099-03-01', '2099-03-02', '2099-02-01', 0, 100, 2, 'approved');
`);
const issueTestSession = installTestSessions(db);

const dbModule = require.resolve('../src/db/database');
require.cache[dbModule] = { id: dbModule, filename: dbModule, loaded: true, exports: db };
const accountingModule = require.resolve('../src/middleware/accounting');
require.cache[accountingModule] = { id: accountingModule, filename: accountingModule, loaded: true, exports: new Proxy({}, { get: () => () => {} }) };

const { JWT_SECRET } = require('../src/middleware/auth');
const app = express();
app.use(express.json());
app.use('/api/symposiums', require('../src/routes/symposiums'));

let server, base;
const request = (method, path, userId, body) => fetch(`${base}${path}`, {
  method,
  headers: { Authorization: `Bearer ${issueTestSession(userId, JWT_SECRET)}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

before(async () => {
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${server.address().port}/api/symposiums`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });

test('coordinator can review and approve events but cannot create or edit them', async () => {
  const list = await request('GET', '/all', 3);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).symposiums.map(event => event.id).sort(), [1, 2]);

  const create = await request('POST', '/', 3, {
    title: 'Coordinator event', location: 'Hall C', start_date: '2099-04-01',
    end_date: '2099-04-02', registration_deadline: '2099-03-01',
  });
  assert.equal(create.status, 403);

  const edit = await request('PUT', '/1', 3, { title: 'Changed by coordinator' });
  assert.equal(edit.status, 403);
  assert.equal(db.prepare('SELECT title FROM symposiums WHERE id=1').get().title, 'First event');

  const approve = await request('POST', '/1/approve', 3, {});
  assert.equal(approve.status, 200);
  assert.deepEqual({ ...db.prepare('SELECT status, coordinator_id FROM symposiums WHERE id=1').get() }, {
    status: 'approved', coordinator_id: 3,
  });
});

test('organizers edit their own events, while admins can edit either event', async () => {
  assert.equal((await request('PUT', '/1', 1, { title: 'Organizer update' })).status, 200);
  assert.equal((await request('PUT', '/2', 1, { title: 'Wrong organizer update' })).status, 403);
  assert.equal(db.prepare('SELECT title FROM symposiums WHERE id=2').get().title, 'Second event');
  assert.equal((await request('PUT', '/2', 4, { title: 'Admin update' })).status, 200);
  assert.equal(db.prepare('SELECT title FROM symposiums WHERE id=2').get().title, 'Admin update');
});
