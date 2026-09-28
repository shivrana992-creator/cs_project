'use strict';
const db = require('../db/database');

/**
 * Generic accounting logger — call from route handlers.
 * All logging errors are silently swallowed so they never break requests.
 */

function logLogin(data) {
  try {
    db.prepare(`INSERT INTO login_logs (user_id, email, action, ip_address, user_agent, details)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(data.user_id || null, data.email || null, data.action, data.ip || null, data.user_agent || null, data.details || null);
  } catch {}
}

function logRegistration(data) {
  try {
    db.prepare(`INSERT INTO registration_logs (user_id, symposium_id, registration_id, action, old_status, new_status, details, ip_address)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(data.user_id, data.symposium_id, data.registration_id || null, data.action,
           data.old_status || null, data.new_status || null, data.details || null, data.ip || null);
  } catch {}
}

function logAttendance(data) {
  try {
    db.prepare(`INSERT INTO attendance_logs (user_id, symposium_id, registration_id, marked_by, action, details, ip_address)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(data.user_id, data.symposium_id, data.registration_id, data.marked_by, data.action, data.details || null, data.ip || null);
  } catch {}
}

function logCertificate(data) {
  try {
    db.prepare(`INSERT INTO certificate_logs (cert_uuid, user_id, symposium_id, generated_by, action, ip_address, details)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(data.cert_uuid || null, data.user_id, data.symposium_id, data.generated_by || data.user_id,
           data.action, data.ip || null, data.details || null);
  } catch {}
}

function logActivity(data) {
  try {
    db.prepare(`INSERT INTO activity_logs (user_id, role, action, resource_type, resource_id, details, ip_address)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(data.user_id || null, data.role || null, data.action, data.resource_type || null,
           data.resource_id || null, data.details || null, data.ip || null);
  } catch {}
}

function logAudit(data) {
  try {
    db.prepare(`INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, old_value, new_value, severity, ip_address)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(data.actor_id || null, data.actor_role || null, data.action, data.resource_type,
           data.resource_id || null, data.old_value ? JSON.stringify(data.old_value) : null,
           data.new_value ? JSON.stringify(data.new_value) : null, data.severity || 'info', data.ip || null);
  } catch {}
}

/** Express middleware that logs every authenticated request to activity_logs */
function activityLogger(req, res, next) {
  res.on('finish', () => {
    if (req.user && res.statusCode < 400) {
      logActivity({
        user_id: req.user.id, role: req.user.role,
        action: `${req.method} ${req.baseUrl}${req.path}`,
        resource_type: 'api', details: `status:${res.statusCode}`, ip: req.ip,
      });
    }
  });
  next();
}

module.exports = { logLogin, logRegistration, logAttendance, logCertificate, logActivity, logAudit, activityLogger };
