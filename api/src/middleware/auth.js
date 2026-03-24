'use strict';
const db = require('../db');

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const token = authHeader.slice(7);
  const session = db.prepare(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).get(token);
  if (!session) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  next();
}

module.exports = { requireAuth };
