'use strict';
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const db = require('./database');

async function seed() {
  console.log('[SEED] Starting database seed...');

  // ─── Users ────────────────────────────────────────────────────────────────
  const users = [
    { name: 'System Admin',       email: 'admin@symposium.edu',       password: 'Admin@123',       role: 'admin' },
    { name: 'Dr. Priya Sharma',   email: 'organizer@symposium.edu',   password: 'Organizer@123',   role: 'organizer' },
    { name: 'Prof. Ramesh Kumar', email: 'coordinator@symposium.edu', password: 'Coordinator@123', role: 'coordinator' },
    { name: 'Arjun Patel',        email: 'student@symposium.edu',     password: 'Student@123',     role: 'participant' },
    { name: 'Sneha Nair',         email: 'sneha@college.edu',         password: 'Student@123',     role: 'participant' },
    { name: 'Vikram Singh',       email: 'vikram@college.edu',        password: 'Student@123',     role: 'participant' },
    { name: 'Dr. Ananya Bose',    email: 'organizer2@symposium.edu',  password: 'Organizer@123',   role: 'organizer' },
  ];

  const userIds = {};
  for (const u of users) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(u.email);
    if (existing) { userIds[u.email] = existing.id; continue; }
    const hash = await bcrypt.hash(u.password, 12);
    const result = db.prepare(
      `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)`
    ).run(u.name, u.email, hash, u.role);
    userIds[u.email] = result.lastInsertRowid;
    console.log(`[SEED] Created user: ${u.email} (${u.role})`);
  }

  const orgId  = userIds['organizer@symposium.edu'];
  const org2Id = userIds['organizer2@symposium.edu'];
  const coordId = userIds['coordinator@symposium.edu'];
  const stuId  = userIds['student@symposium.edu'];
  const snehaId = userIds['sneha@college.edu'];
  const vikramId = userIds['vikram@college.edu'];

  // ─── Symposiums ────────────────────────────────────────────────────────────
  const symposiums = [
    {
      title: 'International Symposium on Artificial Intelligence & Cybersecurity 2026',
      description: 'A premier gathering of researchers, industry professionals, and academics exploring the intersection of AI and cybersecurity. Topics include adversarial ML, zero-trust architectures, AI-driven threat detection, and ethical hacking.',
      category: 'Technology',
      location: 'IIT Bombay, Mumbai',
      start_date: '2026-10-15',
      end_date: '2026-10-17',
      registration_deadline: '2026-10-10',
      fee: 500,
      capacity: 200,
      organizer_id: orgId,
      coordinator_id: coordId,
      status: 'approved',
      banner_color: '#4F46E5',
    },
    {
      title: 'National Biotechnology & Genomics Conclave 2026',
      description: 'An interdisciplinary symposium bringing together biotechnology researchers, clinicians, and policy makers to discuss advancements in genomics, CRISPR, personalized medicine, and bioinformatics.',
      category: 'Science',
      location: 'AIIMS, New Delhi',
      start_date: '2026-11-05',
      end_date: '2026-11-06',
      registration_deadline: '2026-10-30',
      fee: 300,
      capacity: 150,
      organizer_id: org2Id,
      coordinator_id: coordId,
      status: 'approved',
      banner_color: '#059669',
    },
    {
      title: 'Cloud Native Computing & DevOps Symposium 2026',
      description: 'Exploring Kubernetes, service meshes, GitOps, platform engineering, FinOps and the future of cloud-native software delivery. Featuring hands-on workshops and live demos.',
      category: 'Technology',
      location: 'IISC Bangalore',
      start_date: '2026-12-12',
      end_date: '2026-12-13',
      registration_deadline: '2026-12-05',
      fee: 0,
      capacity: 300,
      organizer_id: orgId,
      coordinator_id: coordId,
      status: 'approved',
      banner_color: '#DC2626',
    },
    {
      title: 'Sustainable Energy & Climate Innovation Forum 2026',
      description: 'Discussing solar, wind, hydrogen and fusion energy breakthroughs, carbon capture technologies, energy policy and the path to net-zero emissions.',
      category: 'Environment',
      location: 'NIT Trichy, Tamil Nadu',
      start_date: '2027-01-20',
      end_date: '2027-01-21',
      registration_deadline: '2027-01-10',
      fee: 200,
      capacity: 120,
      organizer_id: org2Id,
      coordinator_id: coordId,
      status: 'pending_approval',
      banner_color: '#D97706',
    },
  ];

  const sympIds = [];
  for (const s of symposiums) {
    const existing = db.prepare('SELECT id FROM symposiums WHERE title = ?').get(s.title);
    if (existing) { sympIds.push(existing.id); continue; }
    const result = db.prepare(`
      INSERT INTO symposiums (title, description, category, location, start_date, end_date,
        registration_deadline, fee, capacity, organizer_id, coordinator_id, status, banner_color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.title, s.description, s.category, s.location, s.start_date, s.end_date,
           s.registration_deadline, s.fee, s.capacity, s.organizer_id, s.coordinator_id,
           s.status, s.banner_color);
    sympIds.push(result.lastInsertRowid);
    console.log(`[SEED] Created symposium: ${s.title}`);
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────
  const sessionData = [
    // Symposium 1 – AI & Cybersecurity
    { symposium_id: sympIds[0], title: 'Keynote: AI in Modern Cybersecurity', speaker: 'Dr. Aarav Mehta', description: 'Opening keynote on how AI is reshaping threat landscapes.', start_time: '2026-10-15T09:00', end_time: '2026-10-15T10:00', room: 'Main Auditorium' },
    { symposium_id: sympIds[0], title: 'Adversarial Machine Learning', speaker: 'Prof. Sunita Rao', description: 'Deep dive into adversarial attacks and defenses in ML systems.', start_time: '2026-10-15T10:30', end_time: '2026-10-15T12:00', room: 'Hall A' },
    { symposium_id: sympIds[0], title: 'Zero Trust Architecture Workshop', speaker: 'Mr. Rohan Desai', description: 'Hands-on workshop on implementing zero-trust in enterprise.', start_time: '2026-10-15T14:00', end_time: '2026-10-15T17:00', room: 'Lab 3' },
    { symposium_id: sympIds[0], title: 'AI-Driven Threat Detection', speaker: 'Dr. Kavitha Pillai', description: 'Real-time threat detection using deep learning models.', start_time: '2026-10-16T09:30', end_time: '2026-10-16T11:00', room: 'Hall B' },
    // Symposium 2 – Biotech
    { symposium_id: sympIds[1], title: 'CRISPR 2.0: Next Generation Editing', speaker: 'Dr. Nisha Gupta', description: 'Overview of base editing and prime editing advances.', start_time: '2026-11-05T09:00', end_time: '2026-11-05T10:30', room: 'Main Hall' },
    { symposium_id: sympIds[1], title: 'Personalized Medicine & Genomics', speaker: 'Prof. Sanjay Iyer', description: 'How whole genome sequencing is enabling targeted therapy.', start_time: '2026-11-05T11:00', end_time: '2026-11-05T12:30', room: 'Seminar Room 1' },
    // Symposium 3 – Cloud Native
    { symposium_id: sympIds[2], title: 'Kubernetes at Scale', speaker: 'Ms. Riya Khanna', description: 'Operating Kubernetes clusters in production at scale.', start_time: '2026-12-12T09:00', end_time: '2026-12-12T10:30', room: 'Main Auditorium' },
    { symposium_id: sympIds[2], title: 'GitOps & Platform Engineering', speaker: 'Mr. Aditya Varma', description: 'Building developer platforms with GitOps principles.', start_time: '2026-12-12T11:00', end_time: '2026-12-12T12:30', room: 'Hall A' },
  ];

  for (const sess of sessionData) {
    const existing = db.prepare('SELECT id FROM sessions WHERE symposium_id=? AND title=?').get(sess.symposium_id, sess.title);
    if (existing) continue;
    db.prepare(`INSERT INTO sessions (symposium_id, title, speaker, description, start_time, end_time, room) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sess.symposium_id, sess.title, sess.speaker, sess.description, sess.start_time, sess.end_time, sess.room);
  }
  console.log('[SEED] Sessions created.');

  // ─── Registrations ─────────────────────────────────────────────────────────
  const regData = [
    { user_id: stuId,    symposium_id: sympIds[0], status: 'attended',           payment_status: 'paid',  amount_paid: 500, attendance_marked: 1 },
    { user_id: snehaId,  symposium_id: sympIds[0], status: 'confirmed',          payment_status: 'paid',  amount_paid: 500, attendance_marked: 0 },
    { user_id: vikramId, symposium_id: sympIds[0], status: 'pending_payment',    payment_status: 'pending', amount_paid: 0, attendance_marked: 0 },
    { user_id: stuId,    symposium_id: sympIds[1], status: 'confirmed',          payment_status: 'paid',  amount_paid: 300, attendance_marked: 0 },
    { user_id: snehaId,  symposium_id: sympIds[2], status: 'registered',         payment_status: 'free',  amount_paid: 0,   attendance_marked: 0 },
    { user_id: stuId,    symposium_id: sympIds[2], status: 'certificate_issued', payment_status: 'free',  amount_paid: 0,   attendance_marked: 1 },
  ];

  const regIds = {};
  for (const r of regData) {
    const existing = db.prepare('SELECT id FROM registrations WHERE user_id=? AND symposium_id=?').get(r.user_id, r.symposium_id);
    if (existing) { regIds[`${r.user_id}_${r.symposium_id}`] = existing.id; continue; }
    const payRef = r.payment_status === 'paid' ? `PAY-${randomUUID().split('-')[0].toUpperCase()}` : null;
    const result = db.prepare(`
      INSERT INTO registrations (user_id, symposium_id, status, payment_status, payment_reference, amount_paid, attendance_marked, payment_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(r.user_id, r.symposium_id, r.status, r.payment_status, payRef, r.amount_paid, r.attendance_marked,
           r.payment_status === 'paid' ? new Date().toISOString() : null);
    regIds[`${r.user_id}_${r.symposium_id}`] = result.lastInsertRowid;
  }
  console.log('[SEED] Registrations created.');

  // ─── Certificates ──────────────────────────────────────────────────────────
  const { certificateHash } = require('../certificates/integrity');
  const certReg = db.prepare('SELECT id FROM registrations WHERE user_id=? AND symposium_id=? AND status=?')
    .get(stuId, sympIds[2], 'certificate_issued');

  if (certReg) {
    const existing = db.prepare('SELECT id FROM certificates WHERE user_id=? AND symposium_id=?').get(stuId, sympIds[2]);
    if (!existing) {
      const certUUID = randomUUID();
      const symp = db.prepare('SELECT title FROM symposiums WHERE id=?').get(sympIds[2]);
      const user = db.prepare('SELECT name, email FROM users WHERE id=?').get(stuId);
      const issueDate = new Date().toISOString();
      const hash = certificateHash(certUUID, user.name, symp.title, issueDate);
      db.prepare(`INSERT INTO certificates (cert_uuid, user_id, symposium_id, registration_id, issue_date, integrity_hash, generated_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(certUUID, stuId, sympIds[2], certReg.id, issueDate, hash, orgId);
      console.log('[SEED] Certificate created, UUID:', certUUID);

      // Certificate log
      db.prepare(`INSERT INTO certificate_logs (cert_uuid, user_id, symposium_id, generated_by, action, details)
                  VALUES (?, ?, ?, ?, 'generated', ?)`)
        .run(certUUID, stuId, sympIds[2], orgId, 'Initial certificate generated by seed');
    }
  }

  // Also create cert for attendance_marked symposium[0] student
  const certReg2 = db.prepare('SELECT id FROM registrations WHERE user_id=? AND symposium_id=? AND status=?')
    .get(stuId, sympIds[0], 'attended');
  if (certReg2) {
    const existing2 = db.prepare('SELECT id FROM certificates WHERE user_id=? AND symposium_id=?').get(stuId, sympIds[0]);
    if (!existing2) {
      const certUUID2 = randomUUID();
      const symp2 = db.prepare('SELECT title FROM symposiums WHERE id=?').get(sympIds[0]);
      const user2 = db.prepare('SELECT name FROM users WHERE id=?').get(stuId);
      const issueDate2 = new Date().toISOString();
      const hash2 = certificateHash(certUUID2, user2.name, symp2.title, issueDate2);
      db.prepare(`INSERT INTO certificates (cert_uuid, user_id, symposium_id, registration_id, issue_date, integrity_hash, generated_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(certUUID2, stuId, sympIds[0], certReg2.id, issueDate2, hash2, orgId);
    }
  }

  // ─── Seed sample accounting logs ──────────────────────────────────────────
  const adminId = userIds['admin@symposium.edu'];

  db.prepare(`INSERT INTO login_logs (user_id, email, action, ip_address, details) VALUES (?, ?, 'login_success', '127.0.0.1', 'Seed login record')`)
    .run(adminId, 'admin@symposium.edu');
  db.prepare(`INSERT INTO login_logs (user_id, email, action, ip_address, details) VALUES (?, ?, 'login_success', '192.168.1.10', 'Seed login record')`)
    .run(stuId, 'student@symposium.edu');
  db.prepare(`INSERT INTO activity_logs (user_id, role, action, resource_type, resource_id, details) VALUES (?, 'admin', 'system_seeded', 'system', NULL, 'Database seeded with demo data')`)
    .run(adminId);
  db.prepare(`INSERT INTO audit_logs (actor_id, actor_role, action, resource_type, resource_id, new_value, severity) VALUES (?, 'admin', 'database_initialized', 'system', NULL, 'Demo data loaded', 'info')`)
    .run(adminId);

  console.log('[SEED] ✅ Seed complete!');
  console.log('\n📌 Demo Credentials:');
  console.log('  Admin       → admin@symposium.edu       / Admin@123');
  console.log('  Organizer   → organizer@symposium.edu   / Organizer@123');
  console.log('  Coordinator → coordinator@symposium.edu / Coordinator@123');
  console.log('  Participant → student@symposium.edu     / Student@123');
}

seed().catch(err => { console.error('[SEED] Error:', err); process.exit(1); });
