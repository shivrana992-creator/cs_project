'use strict';
const { createHash } = require('node:crypto');

function certificateHash(uuid, participantName, symposiumTitle, issueDate) {
  return createHash('sha256').update(`${uuid}|${participantName}|${symposiumTitle}|${issueDate}`).digest('hex');
}

function recoverIssueDate(cert) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cert.issue_date)) return null;
  const storedSecond = Date.parse(cert.issue_date.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(storedSecond)) return null;
  // The old insert used SQLite's clock after hashing an ISO timestamp. Only
  // recover a timestamp when it reproduces the existing hash exactly.
  for (let offset = 999; offset >= -5000; offset--) {
    const candidate = new Date(storedSecond + offset).toISOString();
    if (certificateHash(cert.cert_uuid, cert.participant_name, cert.symposium_title, candidate) === cert.integrity_hash) return candidate;
  }
  return null;
}

function repairLegacyIssueDates(db) {
  const certificates = db.prepare(`SELECT c.*, u.name AS participant_name, s.title AS symposium_title
    FROM certificates c JOIN users u ON u.id=c.user_id JOIN symposiums s ON s.id=c.symposium_id
    WHERE c.issue_date LIKE '____-__-__ __:__:__'`).all();
  const repairs = certificates.map(cert => ({ cert, recovered: recoverIssueDate(cert) })).filter(item => item.recovered);
  if (!repairs.length) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const update = db.prepare('UPDATE certificates SET issue_date=? WHERE id=? AND issue_date=? AND integrity_hash=?');
    const audit = db.prepare(`INSERT INTO audit_logs (action, resource_type, resource_id, old_value, new_value, severity)
      VALUES ('certificate_issue_date_recovered', 'certificate', ?, ?, ?, 'info')`);
    let repaired = 0;
    for (const { cert, recovered } of repairs) {
      if (!update.run(recovered, cert.id, cert.issue_date, cert.integrity_hash).changes) continue;
      audit.run(cert.id, JSON.stringify({ issue_date: cert.issue_date }), JSON.stringify({ issue_date: recovered }));
      repaired++;
    }
    db.exec('COMMIT');
    return repaired;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function verificationUrl(appUrl, uuid) {
  const url = new URL(appUrl);
  url.hash = `/verify/${encodeURIComponent(uuid)}`;
  return url.href;
}

module.exports = { certificateHash, recoverIssueDate, repairLegacyIssueDates, verificationUrl };
