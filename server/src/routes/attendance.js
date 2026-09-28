'use strict';
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { logAttendance, logActivity, logAudit } = require('../middleware/accounting');

const router = express.Router();

router.post('/check-in', authenticate, requireRole('organizer', 'admin'), (req, res) => {
  try {
    const token = String(req.body.token || '').trim();
    if (!token || token.length > 100) return res.status(400).json({ error: 'A valid check-in QR code is required.' });
    const symposiumId = Number.parseInt(req.body.symposium_id, 10);
    if (!Number.isSafeInteger(symposiumId) || symposiumId < 1) return res.status(400).json({ error: 'A valid symposium is required.' });
    const reg = db.prepare(`SELECT r.*, s.organizer_id FROM registrations r JOIN symposiums s ON s.id=r.symposium_id WHERE r.checkin_token=? AND r.symposium_id=?`).get(token, symposiumId);
    if (!reg) return res.status(404).json({ error: 'Check-in code not found.' });
    if (req.user.role === 'organizer' && reg.organizer_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    if (!['confirmed', 'attended'].includes(reg.status)) return res.status(400).json({ error: 'Only confirmed registrations can check in.' });
    db.prepare("UPDATE registrations SET attendance_marked=1, status='attended', updated_at=datetime('now') WHERE id=?").run(reg.id);
    logAttendance({ user_id: reg.user_id, symposium_id: reg.symposium_id, registration_id: reg.id, marked_by: req.user.id, action: 'marked_present', details: 'QR check-in', ip: req.ip });
    res.json({ message: 'Check-in successful.', participant_name: db.prepare('SELECT name FROM users WHERE id=?').get(reg.user_id).name });
  } catch (err) { res.status(500).json({ error: 'Check-in failed.' }); }
});

router.get('/qr/:registrationId', authenticate, async (req, res) => {
  try {
    const reg = db.prepare('SELECT r.*, s.organizer_id FROM registrations r JOIN symposiums s ON s.id=r.symposium_id WHERE r.id=?').get(req.params.registrationId);
    if (!reg) return res.status(404).json({ error: 'Registration not found.' });
    if (req.user.role === 'participant' && reg.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    if (req.user.role === 'organizer' && reg.organizer_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    if (!['participant', 'organizer', 'admin', 'coordinator'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied.' });
    if (!reg.checkin_token) return res.status(404).json({ error: 'No check-in code is available for this registration.' });
    const png = await QRCode.toBuffer(reg.checkin_token, { type: 'png', width: 240, margin: 2 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(png);
  } catch (err) { res.status(500).json({ error: 'Could not create check-in QR.' }); }
});

// ── POST /api/attendance/mark  (organizer marks individual or bulk attendance) ─
router.post('/mark', authenticate, requireRole('organizer', 'admin'), (req, res) => {
  try {
    const { registration_id, present, bulk } = req.body;

    if (bulk && Array.isArray(bulk)) {
      // Bulk mark: [{registration_id, present}]
      let count = 0;
      for (const item of bulk) {
        const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(item.registration_id);
        if (!reg || reg.status === 'cancelled') continue;
        if (req.user.role === 'organizer') {
          const symp = db.prepare('SELECT organizer_id FROM symposiums WHERE id = ?').get(reg.symposium_id);
          if (symp.organizer_id !== req.user.id) continue;
        }
        const attended = item.present ? 1 : 0;
        const newStatus = attended ? 'attended' : reg.status === 'attended' ? 'confirmed' : reg.status;
        db.prepare(`UPDATE registrations SET attendance_marked=?, status=?, updated_at=datetime('now') WHERE id=?`).run(attended, newStatus, reg.id);
        logAttendance({ user_id: reg.user_id, symposium_id: reg.symposium_id, registration_id: reg.id, marked_by: req.user.id, action: 'bulk_marked', details: `present:${attended}`, ip: req.ip });
        count++;
      }
      logActivity({ user_id: req.user.id, role: req.user.role, action: 'bulk_attendance_marked', resource_type: 'attendance', details: `count:${count}`, ip: req.ip });
      return res.json({ message: `Attendance marked for ${count} participants.` });
    }

    if (!registration_id) return res.status(400).json({ error: 'registration_id required.' });
    const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(registration_id);
    if (!reg) return res.status(404).json({ error: 'Registration not found.' });
    if (reg.status === 'cancelled') return res.status(400).json({ error: 'Cannot mark attendance for cancelled registration.' });
    if (!['confirmed', 'attended'].includes(reg.status)) return res.status(400).json({ error: 'Registration must be confirmed before marking attendance.' });

    if (req.user.role === 'organizer') {
      const symp = db.prepare('SELECT organizer_id FROM symposiums WHERE id = ?').get(reg.symposium_id);
      if (symp.organizer_id !== req.user.id) return res.status(403).json({ error: 'You can only mark attendance for your own symposium.' });
    }

    const attended = present !== false && present !== 0 && present !== 'false';
    const newStatus = attended ? 'attended' : 'confirmed';
    db.prepare(`UPDATE registrations SET attendance_marked=?, status=?, updated_at=datetime('now') WHERE id=?`).run(attended ? 1 : 0, newStatus, reg.id);

    logAttendance({ user_id: reg.user_id, symposium_id: reg.symposium_id, registration_id: reg.id, marked_by: req.user.id, action: attended ? 'marked_present' : 'marked_absent', ip: req.ip });
    logAudit({ actor_id: req.user.id, actor_role: req.user.role, action: 'attendance_marked', resource_type: 'registration', resource_id: reg.id, new_value: { present: attended }, severity: 'info', ip: req.ip });

    res.json({ message: `Attendance marked as ${attended ? 'PRESENT' : 'ABSENT'}.`, new_status: newStatus });
  } catch (err) {
    console.error('[ATTEND] Mark error:', err);
    res.status(500).json({ error: 'Failed to mark attendance.' });
  }
});

// ── GET /api/attendance/symposium/:sympId  (full attendance sheet) ─────────────
router.get('/symposium/:sympId', authenticate, requireRole('organizer', 'admin', 'coordinator'), (req, res) => {
  try {
    const symp = db.prepare('SELECT * FROM symposiums WHERE id = ?').get(req.params.sympId);
    if (!symp) return res.status(404).json({ error: 'Symposium not found.' });
    if (req.user.role === 'organizer' && symp.organizer_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });

    const attendance = db.prepare(`
      SELECT r.id as registration_id, r.user_id, r.status, r.attendance_marked, r.payment_status,
             u.name as participant_name, u.email as participant_email,
             (SELECT cert_uuid FROM certificates c WHERE c.user_id = r.user_id AND c.symposium_id = r.symposium_id LIMIT 1) as cert_uuid
             ,(SELECT revoked_at FROM certificates c WHERE c.user_id = r.user_id AND c.symposium_id = r.symposium_id LIMIT 1) as certificate_revoked_at
      FROM registrations r
      JOIN users u ON r.user_id = u.id
      WHERE r.symposium_id = ? AND r.status NOT IN ('cancelled')
      ORDER BY u.name
    `).all(req.params.sympId);

    const stats = {
      total: attendance.length,
      present: attendance.filter(a => a.attendance_marked === 1).length,
      absent: attendance.filter(a => a.attendance_marked === 0).length,
      certificate_issued: attendance.filter(a => a.status === 'certificate_issued').length,
    };

    res.json({ attendance, symposium: symp, stats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch attendance.' });
  }
});

module.exports = router;
