'use strict';
const { Router } = require('express');
const crypto = require('crypto');
const { bearerMatchesLicenseKey } = require('../utils/licenseBearer');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { getConfig, setConfig } = require('../bootstrap');
const { requireAuth } = require('../middleware/auth');

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

// POST /api/auth/token — generate a fresh short-lived SSO token
// Called by services.buy-it.gr using LICENSE_KEY as Bearer auth
// Returns a token valid for 5 minutes, single-use
router.post('/token', (req, res) => {
  if (!bearerMatchesLicenseKey(req.headers['authorization'], process.env.LICENSE_KEY)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ssoToken = uuidv4();
  // Store as a short-lived pending token (5 min), not yet a full session
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(`sso:${ssoToken}`, expiresAt);
  res.json({ token: ssoToken });
});

// POST /api/auth/setup — exchange SSO token for a full session
// Called by the /setup page in the browser
router.post('/setup', (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token required' });
  }

  const row = db.prepare(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).get(`sso:${token}`);

  if (!row) return res.status(401).json({ error: 'Invalid or expired SSO token' });

  // Consume the SSO token immediately (single-use)
  db.prepare('DELETE FROM sessions WHERE token = ?').run(`sso:${token}`);

  // Create a full 30-day session
  const sessionToken = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(sessionToken, expiresAt);

  res.json({ token: sessionToken });
});

// Change password — requires existing session auth
router.post('/change-password', requireAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  setConfig('app_password', newPassword);
  process.env.APP_PASSWORD = newPassword;
  // Invalidate all existing sessions so old tokens stop working
  db.prepare('DELETE FROM sessions').run();
  res.json({ ok: true });
});

module.exports = router;
