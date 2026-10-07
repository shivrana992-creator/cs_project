'use strict';
const db = require('./db/database');

function setting(key, fallback) {
  return db.prepare('SELECT value FROM system_settings WHERE key=?').get(key)?.value ?? fallback;
}

function sessionMinutes() {
  const value = Number(setting('session_timeout_minutes', '30'));
  return Number.isInteger(value) && value >= 5 && value <= 480 ? value : 30;
}

module.exports = { setting, sessionMinutes };
