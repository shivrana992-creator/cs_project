'use strict';
const express = require('express');
const { randomUUID } = require('crypto');
const { signCertificate, verifyCertificate, verificationUrl } = require('../certificates/integrity');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const db = require('../db/database');
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const { requireRole } = require('../middleware/rbac');
const { logCertificate, logActivity, logAudit } = require('../middleware/accounting');

const router = express.Router();
const APP_URL = process.env.APP_URL || 'http://localhost:5173';

// ── POST /api/certificates/generate ──────────────────────────────────────────
router.post('/generate', authenticate, requireRole('organizer', 'admin'), (req, res) => {
  try {
    const { registration_id, bulk_symposium_id } = req.body;

    // Bulk generate for all attendees of a symposium
    if (bulk_symposium_id) {
      const symp = db.prepare('SELECT * FROM symposiums WHERE id = ?').get(bulk_symposium_id);
      if (!symp) return res.status(404).json({ error: 'Symposium not found.' });
      if (req.user.role === 'organizer' && symp.organizer_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });

      const attendees = db.prepare(`SELECT r.*, u.name as pname, u.email as pemail FROM registrations r JOIN users u ON r.user_id = u.id WHERE r.symposium_id = ? AND r.attendance_marked = 1 AND r.status IN ('attended','certificate_issued')`).all(bulk_symposium_id);
      let generated = 0;
      for (const reg of attendees) {
        const exists = db.prepare('SELECT id FROM certificates WHERE user_id=? AND symposium_id=?').get(reg.user_id, bulk_symposium_id);
        if (exists) continue;
        const uuid = randomUUID();
        const issueDate = new Date().toISOString();
        const signature = signCertificate(uuid, reg.pname, symp.title, issueDate);
        db.prepare(`INSERT INTO certificates (cert_uuid, user_id, symposium_id, registration_id, issue_date, integrity_hash, integrity_algorithm, generated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(uuid, reg.user_id, bulk_symposium_id, reg.id, issueDate, signature.integrity_hash, signature.integrity_algorithm, req.user.id);
        db.prepare(`UPDATE registrations SET status='certificate_issued', updated_at=datetime('now') WHERE id=?`).run(reg.id);
        logCertificate({ cert_uuid: uuid, user_id: reg.user_id, symposium_id: bulk_symposium_id, generated_by: req.user.id, action: 'generated', ip: req.ip });
        generated++;
      }
      return res.json({ message: `Certificates generated for ${generated} attendees.`, generated });
    }

    // Single certificate
    if (!registration_id) return res.status(400).json({ error: 'registration_id or bulk_symposium_id required.' });
    const reg = db.prepare(`SELECT r.*, u.name as pname, u.email as pemail, s.title as stitle, s.start_date, s.end_date, s.location, s.organizer_id FROM registrations r JOIN users u ON r.user_id = u.id JOIN symposiums s ON r.symposium_id = s.id WHERE r.id = ?`).get(registration_id);
    if (!reg) return res.status(404).json({ error: 'Registration not found.' });
    if (req.user.role === 'organizer' && reg.organizer_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    if (!reg.attendance_marked || reg.status === 'cancelled') return res.status(400).json({ error: 'Attendance must be marked as PRESENT before generating a certificate.' });

    const existing = db.prepare('SELECT * FROM certificates WHERE user_id=? AND symposium_id=?').get(reg.user_id, reg.symposium_id);
    if (existing) return res.json({ message: 'Certificate already exists.', cert_uuid: existing.cert_uuid });

    const uuid = randomUUID();
    const issueDate = new Date().toISOString();
    const signature = signCertificate(uuid, reg.pname, reg.stitle, issueDate);
    db.prepare(`INSERT INTO certificates (cert_uuid, user_id, symposium_id, registration_id, issue_date, integrity_hash, integrity_algorithm, generated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(uuid, reg.user_id, reg.symposium_id, reg.id, issueDate, signature.integrity_hash, signature.integrity_algorithm, req.user.id);
    db.prepare(`UPDATE registrations SET status='certificate_issued', updated_at=datetime('now') WHERE id=?`).run(reg.id);

    logCertificate({ cert_uuid: uuid, user_id: reg.user_id, symposium_id: reg.symposium_id, generated_by: req.user.id, action: 'generated', ip: req.ip });
    logAudit({ actor_id: req.user.id, actor_role: req.user.role, action: 'certificate_generated', resource_type: 'certificate', new_value: { uuid, participant: reg.pname }, severity: 'info', ip: req.ip });

    res.status(201).json({ message: 'Certificate generated!', cert_uuid: uuid });
  } catch (err) {
    console.error('[CERT] Generate error:', err);
    res.status(500).json({ error: 'Certificate generation failed.' });
  }
});

// ── GET /api/certificates/my ───────────────────────────────────────────────────
router.get('/my', authenticate, requireRole('participant'), (req, res) => {
  try {
    const certs = db.prepare(`
      SELECT c.*, s.title as symposium_title, s.start_date, s.end_date, s.location, s.category, s.banner_color,
             u2.name as issued_by_name
      FROM certificates c
      JOIN symposiums s ON c.symposium_id = s.id
      LEFT JOIN users u2 ON c.generated_by = u2.id
      WHERE c.user_id = ?
      ORDER BY c.created_at DESC
    `).all(req.user.id);
    res.json({ certificates: certs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch certificates.' });
  }
});

// ── GET /api/certificates/verify/:certId (public) ─────────────────────────────
router.get('/verify/:certId', optionalAuthenticate, (req, res) => {
  try {
    const cert = db.prepare(`
      SELECT c.*, u.name as participant_name,
             s.title as symposium_title, s.start_date, s.end_date, s.location, s.category
      FROM certificates c
      JOIN users u ON c.user_id = u.id
      JOIN symposiums s ON c.symposium_id = s.id
      WHERE c.cert_uuid = ?
    `).get(req.params.certId);

    if (!cert) return res.status(404).json({ valid: false, error: 'Certificate not found or invalid.' });

    // Verify integrity hash
    const hashValid = verifyCertificate(cert);

    logCertificate({ cert_uuid: cert.cert_uuid, user_id: cert.user_id, symposium_id: cert.symposium_id, generated_by: cert.generated_by, action: 'verified', ip: req.ip, details: `hash_valid:${hashValid}` });

    res.json({
        valid: hashValid && !cert.revoked_at,
        revoked: Boolean(cert.revoked_at),
        revocation_reason: cert.revoked_reason || null,
      certificate: {
        cert_uuid: cert.cert_uuid,
        participant_name: cert.participant_name,
        symposium_title: cert.symposium_title,
        symposium_location: cert.location,
        event_dates: `${cert.start_date} to ${cert.end_date}`,
        issue_date: cert.issue_date,
        integrity_hash: cert.integrity_hash,
        hash_verified: hashValid,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// ── GET /api/certificates/:certId/download ─────────────────────────────────────
router.get('/:certId/download', authenticate, async (req, res) => {
  try {
    const cert = db.prepare(`
      SELECT c.*, u.name as participant_name, u.email as participant_email,
             s.title as symposium_title, s.start_date, s.end_date, s.location, s.category, s.banner_color, s.organizer_id,
             u2.name as organizer_name
      FROM certificates c
      JOIN users u ON c.user_id = u.id
      JOIN symposiums s ON c.symposium_id = s.id
      LEFT JOIN users u2 ON c.generated_by = u2.id
      WHERE c.cert_uuid = ?
    `).get(req.params.certId);

    if (!cert) return res.status(404).json({ error: 'Certificate not found.' });
    if (cert.revoked_at) return res.status(410).json({ error: 'This certificate has been revoked.' });
    if (req.user.role === 'participant' && cert.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    if (req.user.role === 'organizer' && cert.organizer_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    if (!['participant', 'organizer', 'admin', 'coordinator'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied.' });

    // Update download count
    db.prepare(`UPDATE certificates SET download_count = download_count + 1, last_downloaded_at = datetime('now') WHERE cert_uuid = ?`).run(cert.cert_uuid);
    logCertificate({ cert_uuid: cert.cert_uuid, user_id: cert.user_id, symposium_id: cert.symposium_id, generated_by: req.user.id, action: 'downloaded', ip: req.ip });

    // Generate QR code
    const verifyUrl = verificationUrl(APP_URL, cert.cert_uuid);
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, { width: 120, margin: 1 });
    const qrBase64 = qrDataUrl.replace('data:image/png;base64,', '');
    const qrBuffer = Buffer.from(qrBase64, 'base64');

    // Parse banner color
    const hexColor = cert.banner_color || '#1e3a5f';
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="certificate-${cert.cert_uuid.split('-')[0]}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    doc.pipe(res);

    const W = 841.89, H = 595.28;

    // Background
    doc.rect(0, 0, W, H).fill('#f8f9ff');

    // Top banner
    doc.rect(0, 0, W, 12).fill(`rgb(${r},${g},${b})`);
    // Bottom banner
    doc.rect(0, H - 12, W, 12).fill(`rgb(${r},${g},${b})`);

    // Decorative side bars
    doc.rect(0, 12, 8, H - 24).fill(`rgb(${Math.min(r+40,255)},${Math.min(g+40,255)},${Math.min(b+40,255)})`);
    doc.rect(W - 8, 12, 8, H - 24).fill(`rgb(${Math.min(r+40,255)},${Math.min(g+40,255)},${Math.min(b+40,255)})`);

    // Border rectangle
    doc.rect(20, 20, W - 40, H - 40).lineWidth(2).stroke(`rgb(${r},${g},${b})`);
    doc.rect(24, 24, W - 48, H - 48).lineWidth(0.5).stroke(`rgb(${Math.min(r+60,255)},${Math.min(g+60,255)},${Math.min(b+60,255)})`);

    // Header
    doc.fontSize(11).fillColor(`rgb(${r},${g},${b})`).font('Helvetica')
       .text('SymposiHub — Academic Excellence', 0, 45, { align: 'center' });

    doc.fontSize(32).fillColor(`rgb(${r},${g},${b})`).font('Helvetica-Bold')
       .text('CERTIFICATE OF PARTICIPATION', 0, 70, { align: 'center' });

    doc.fontSize(13).fillColor('#555').font('Helvetica')
       .text('This is to certify that', 0, 125, { align: 'center' });

    // Participant Name
    doc.fontSize(38).fillColor(`rgb(${r},${g},${b})`).font('Helvetica-Bold')
       .text(cert.participant_name, 0, 148, { align: 'center' });

    // Underline the name
    const nameWidth = doc.widthOfString(cert.participant_name, { fontSize: 38 });
    const nameX = (W - nameWidth) / 2;
    doc.moveTo(nameX, 193).lineTo(nameX + nameWidth, 193).lineWidth(1.5).stroke(`rgb(${r},${g},${b})`);

    doc.fontSize(13).fillColor('#555').font('Helvetica')
       .text('has successfully participated in', 0, 205, { align: 'center' });

    // Symposium Title
    doc.fontSize(18).fillColor('#1a1a2e').font('Helvetica-Bold')
       .text(cert.symposium_title, 60, 225, { align: 'center', width: W - 120 });

    // Date and Location
    const startDate = new Date(cert.start_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const endDate   = new Date(cert.end_date).toLocaleDateString('en-IN',   { day: 'numeric', month: 'long', year: 'numeric' });
    doc.fontSize(12).fillColor('#444').font('Helvetica')
       .text(`Held on ${startDate} – ${endDate}  |  ${cert.location}`, 0, 278, { align: 'center' });

    // Divider
    doc.moveTo(80, 310).lineTo(W - 80, 310).lineWidth(0.8).stroke('#ccc');

    // Signature area (left)
    doc.fontSize(11).fillColor('#333').font('Helvetica-Bold').text('Dr. ' + (cert.organizer_name || 'Event Organizer'), 100, 345);
    doc.fontSize(9).fillColor('#666').font('Helvetica').text('Event Organizer / Chairperson', 100, 360);
    doc.moveTo(100, 342).lineTo(280, 342).lineWidth(0.8).stroke('#555');

    // Signature area (center)
    doc.fontSize(11).fillColor('#333').font('Helvetica-Bold').text('SymposiHub Committee', W/2 - 80, 345);
    doc.fontSize(9).fillColor('#666').font('Helvetica').text('Academic Affairs Board', W/2 - 80, 360);
    doc.moveTo(W/2 - 80, 342).lineTo(W/2 + 100, 342).lineWidth(0.8).stroke('#555');

    // QR Code (right)
    doc.image(qrBuffer, W - 160, 310, { width: 100, height: 100 });
    doc.fontSize(8).fillColor('#666').text('Scan to verify', W - 160, 415, { width: 100, align: 'center' });

    // Certificate ID + Integrity Hash (bottom)
    doc.fontSize(8).fillColor('#999').font('Helvetica')
       .text(`Certificate ID: ${cert.cert_uuid}`, 30, H - 55, { align: 'left' })
       .text(`${cert.integrity_algorithm === 'hmac-sha256' ? 'HMAC-SHA-256' : 'SHA-256'}: ${cert.integrity_hash.slice(0, 32)}...`, 30, H - 43, { align: 'left' })
       .text(`Issued: ${new Date(cert.issue_date).toLocaleDateString('en-IN')}`, W - 180, H - 55);

    doc.end();
  } catch (err) {
    console.error('[CERT] Download error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Certificate download failed.' });
  }
});

router.post('/:certId/revoke', authenticate, requireRole('organizer', 'admin'), (req, res) => {
  try {
    const cert = db.prepare('SELECT c.*, s.organizer_id FROM certificates c JOIN symposiums s ON s.id=c.symposium_id WHERE c.cert_uuid=?').get(req.params.certId);
    if (!cert) return res.status(404).json({ error: 'Certificate not found.' });
    if (req.user.role === 'organizer' && cert.organizer_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!reason) return res.status(400).json({ error: 'A revocation reason is required.' });
    if (cert.revoked_at) return res.status(409).json({ error: 'Certificate is already revoked.' });
    db.prepare("UPDATE certificates SET revoked_at=datetime('now'), revoked_reason=? WHERE id=?").run(reason, cert.id);
    db.prepare("UPDATE registrations SET status='attended', updated_at=datetime('now') WHERE id=? AND status='certificate_issued'").run(cert.registration_id);
    logCertificate({ cert_uuid: cert.cert_uuid, user_id: cert.user_id, symposium_id: cert.symposium_id, generated_by: req.user.id, action: 'revoked', ip: req.ip, details: reason });
    logAudit({ actor_id: req.user.id, actor_role: req.user.role, action: 'certificate_revoked', resource_type: 'certificate', resource_id: cert.id, new_value: { reason }, severity: 'warning', ip: req.ip });
    res.json({ message: 'Certificate revoked.' });
  } catch (err) { res.status(500).json({ error: 'Certificate revocation failed.' }); }
});

// ── GET /api/certificates/symposium/:sympId (organizer) ───────────────────────
router.get('/symposium/:sympId', authenticate, requireRole('organizer', 'admin', 'coordinator'), (req, res) => {
  try {
    const symposium = db.prepare('SELECT organizer_id FROM symposiums WHERE id=?').get(req.params.sympId);
    if (!symposium) return res.status(404).json({ error: 'Symposium not found.' });
    if (req.user.role === 'organizer' && symposium.organizer_id !== req.user.id) return res.status(403).json({ error: 'Access denied.' });
    const certs = db.prepare(`
      SELECT c.*, u.name as participant_name, u.email as participant_email
      FROM certificates c JOIN users u ON c.user_id = u.id
      WHERE c.symposium_id = ? ORDER BY c.created_at DESC
    `).all(req.params.sympId);
    res.json({ certificates: certs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch certificates.' });
  }
});

module.exports = router;
