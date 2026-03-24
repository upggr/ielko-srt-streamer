'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = Router();

router.post('/login', (req, res) => {
  const { password } = req.body;
  const appPassword = process.env.APP_PASSWORD || '';
  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'Password required' });
    return;
  }
  const expected = Buffer.from(appPassword.padEnd(password.length, '\0'));
  const provided = Buffer.from(password.padEnd(appPassword.length, '\0'));
  let match = false;
  try { match = crypto.timingSafeEqual(expected, provided) && password.length === appPassword.length; } catch {}
  if (!match) { res.status(401).json({ error: 'Invalid password' }); return; }

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(token, expiresAt);
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  res.json({ token });
});

router.post('/logout', (req, res) => {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(auth.slice(7));
  }
  res.json({ ok: true });
});

module.exports = router;
