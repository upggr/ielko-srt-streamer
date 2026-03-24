import { Router } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import db from '../db';

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
  try {
    match = crypto.timingSafeEqual(expected, provided) && password.length === appPassword.length;
  } catch {
    match = false;
  }

  if (!match) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const token = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').split('.')[0];

  db.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(token, expiresAt);

  // clean expired sessions
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();

  res.json({ token });
});

router.post('/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }
  res.json({ ok: true });
});

export default router;
