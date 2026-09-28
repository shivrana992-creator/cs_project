'use strict';
const db = require('../db/database');

function requireRole(...allowedRoles) {
  // flatten in case array of arrays
  const roles = allowedRoles.flat();
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!roles.includes(req.user.role)) {
      // Log unauthorized attempt
      try {
        db.prepare(`INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, severity, ip_address, details)
                    VALUES (?, ?, 'unauthorized_access_attempt', ?, 'warning', ?, ?)`)
          .run(req.user.id, req.user.role, req.baseUrl + req.path, req.ip,
               `Role '${req.user.role}' attempted access requiring: ${roles.join(', ')}`);
      } catch {}
      return res.status(403).json({
        error: `Access denied. Required role: ${roles.join(' or ')}. Your role: ${req.user.role}.`
      });
    }
    next();
  };
}

module.exports = { requireRole };
