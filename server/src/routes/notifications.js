'use strict';
const express = require('express');
const db = require('../db/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.get('/', authenticate, (req, res) => {
  const notifications = db.prepare('SELECT id, title, message, read_at, created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id);
  res.json({ notifications });
});
router.post('/:id/read', authenticate, (req, res) => {
  const result = db.prepare("UPDATE notifications SET read_at=datetime('now') WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ message: 'Notification marked as read.' });
});
module.exports = router;
