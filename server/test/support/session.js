'use strict';
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');

function installTestSessions(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    revoked_at INTEGER, created_at INTEGER NOT NULL
  )`);
  return (userId, secret) => {
    const id = randomUUID();
    const token = jwt.sign({ id: userId, jti: id }, secret, { expiresIn: '1h' });
    db.prepare('INSERT INTO auth_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(id, userId, jwt.decode(token).exp, Math.floor(Date.now() / 1000));
    return token;
  };
}

module.exports = { installTestSessions };
