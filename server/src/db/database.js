'use strict';
require('../config');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { repairLegacyIssueDates } = require('../certificates/integrity');

const DB_PATH = process.env.DB_PATH === ':memory:' ? ':memory:' : process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, '../../data/symposium.db');
const DB_DIR = DB_PATH === ':memory:' ? null : path.dirname(DB_PATH);

if (DB_DIR && !fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

function initializeDatabase() {
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA synchronous=NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'participant' CHECK(role IN ('participant','organizer','coordinator','admin')),
      mfa_enabled INTEGER NOT NULL DEFAULT 0,
      mfa_secret TEXT,
      mfa_backup_codes TEXT,
      email_verified INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS symposiums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT,
      location TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      registration_deadline TEXT NOT NULL,
      fee REAL NOT NULL DEFAULT 0,
      capacity INTEGER NOT NULL DEFAULT 100,
      organizer_id INTEGER NOT NULL,
      coordinator_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_approval','approved','ongoing','completed','cancelled')),
      banner_color TEXT DEFAULT '#4F46E5',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (organizer_id) REFERENCES users(id),
      FOREIGN KEY (coordinator_id) REFERENCES users(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symposium_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      speaker TEXT,
      description TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      room TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (symposium_id) REFERENCES symposiums(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      symposium_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','pending_payment','confirmed','attended','certificate_issued','cancelled')),
      payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('pending','paid','free','refunded')),
      payment_reference TEXT,
      payment_order_id TEXT,
      payment_method TEXT,
      refund_reference TEXT,
      refund_status TEXT,
      amount_paid REAL DEFAULT 0,
      attendance_marked INTEGER DEFAULT 0,
      checkin_token TEXT UNIQUE,
      registration_date TEXT NOT NULL DEFAULT (datetime('now')),
      payment_date TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, symposium_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (symposium_id) REFERENCES symposiums(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cert_uuid TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      symposium_id INTEGER NOT NULL,
      registration_id INTEGER NOT NULL,
      issue_date TEXT NOT NULL DEFAULT (datetime('now')),
      integrity_hash TEXT NOT NULL,
      integrity_algorithm TEXT NOT NULL DEFAULT 'sha256',
      revoked_at TEXT,
      revoked_reason TEXT,
      generated_by INTEGER NOT NULL,
      download_count INTEGER DEFAULT 0,
      last_downloaded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (symposium_id) REFERENCES symposiums(id),
      FOREIGN KEY (registration_id) REFERENCES registrations(id),
      FOREIGN KEY (generated_by) REFERENCES users(id)
    )
  `);

  // Lightweight schema upgrades for databases created by earlier project versions.
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!userColumns.includes('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
  const certificateColumns = db.prepare('PRAGMA table_info(certificates)').all().map(c => c.name);
  if (!certificateColumns.includes('revoked_at')) db.exec('ALTER TABLE certificates ADD COLUMN revoked_at TEXT');
  if (!certificateColumns.includes('revoked_reason')) db.exec('ALTER TABLE certificates ADD COLUMN revoked_reason TEXT');
  if (!certificateColumns.includes('integrity_algorithm')) db.exec("ALTER TABLE certificates ADD COLUMN integrity_algorithm TEXT NOT NULL DEFAULT 'sha256'");
  const registrationColumns = db.prepare('PRAGMA table_info(registrations)').all().map(c => c.name);
  if (!registrationColumns.includes('checkin_token')) db.exec('ALTER TABLE registrations ADD COLUMN checkin_token TEXT');
  if (!registrationColumns.includes('payment_order_id')) db.exec('ALTER TABLE registrations ADD COLUMN payment_order_id TEXT');
  if (!registrationColumns.includes('refund_reference')) db.exec('ALTER TABLE registrations ADD COLUMN refund_reference TEXT');
  if (!registrationColumns.includes('refund_status')) db.exec('ALTER TABLE registrations ADD COLUMN refund_status TEXT');

  db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS account_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('email_verification','password_reset')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      email TEXT,
      action TEXT NOT NULL CHECK(action IN ('login_success','login_failure','logout','mfa_success','mfa_failure','session_expired')),
      ip_address TEXT,
      user_agent TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS registration_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      symposium_id INTEGER NOT NULL,
      registration_id INTEGER,
      action TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      details TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      symposium_id INTEGER NOT NULL,
      registration_id INTEGER NOT NULL,
      marked_by INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('marked_present','marked_absent','bulk_marked')),
      details TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS certificate_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cert_uuid TEXT,
      user_id INTEGER NOT NULL,
      symposium_id INTEGER NOT NULL,
      generated_by INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('generated','downloaded','verified','revoked')),
      ip_address TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      role TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id INTEGER,
      details TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      actor_role TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id INTEGER,
      old_value TEXT,
      new_value TEXT,
      severity TEXT DEFAULT 'info' CHECK(severity IN ('info','warning','critical')),
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Default system settings
  const existing = db.prepare("SELECT count(*) as c FROM system_settings").get();
  if (existing.c === 0) {
    const insertSetting = db.prepare("INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)");
    insertSetting.run('session_timeout_minutes', '30');
    insertSetting.run('allow_self_registration', 'true');
    insertSetting.run('max_registrations_per_user', '10');
    insertSetting.run('site_name', 'SymposiHub');
    insertSetting.run('contact_email', 'admin@symposium.edu');
  }

  console.log('[DB] Database initialized at:', DB_PATH);
}

initializeDatabase();
const repairedCertificates = repairLegacyIssueDates(db);
if (repairedCertificates) console.log(`[DB] Recovered original issue timestamps for ${repairedCertificates} certificates.`);

module.exports = db;
