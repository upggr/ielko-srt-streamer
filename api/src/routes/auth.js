'use strict';
const { Router } = require('express');
const crypto = require('crypto');
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

// One-time setup token exchange — used by services.buy-it.gr to auto-login on first visit
// Returns a session token if the setup token is valid and unused, then invalidates it
router.post('/setup', (req, res) => {
  const { setupToken } = req.body;
  if (!setupToken || typeof setupToken !== 'string') {
    return res.status(400).json({ error: 'setupToken required' });
  }

  const stored = getConfig('setup_token');
  const used = getConfig('setup_token_used');

  if (!stored || used === '1') {
    return res.status(410).json({ error: 'Setup token already used or not available' });
  }

  // Constant-time compare
  let match = false;
  try {
    const a = Buffer.from(stored.padEnd(setupToken.length, '\0'));
    const b = Buffer.from(setupToken.padEnd(stored.length, '\0'));
    match = crypto.timingSafeEqual(a, b) && stored.length === setupToken.length;
  } catch {}

  if (!match) {
    return res.status(401).json({ error: 'Invalid setup token' });
  }

  // Invalidate token immediately
  setConfig('setup_token_used', '1');

  // Create a session (30-day expiry)
  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];
  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(token, expiresAt);

  res.json({ token });
});

// GET /api/auth/setup-token — returns the raw setup token (once) for services.buy-it.gr to retrieve
// This is called by services.buy-it.gr via a signed request containing the LICENSE_KEY
router.get('/setup-token', (req, res) => {
  const licenseKey = req.query.licenseKey;
  if (!licenseKey || licenseKey !== process.env.LICENSE_KEY) {
    return res.status(401).json({ error: 'Invalid license key' });
  }
  const token = getConfig('setup_token');
  const used = getConfig('setup_token_used');
  res.json({ setupToken: token, used: used === '1' });
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
