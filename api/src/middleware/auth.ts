import { Request, Response, NextFunction } from 'express';
import db from '../db';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  const session = db.prepare(
    'SELECT * FROM sessions WHERE token = ? AND expires_at > datetime("now")'
  ).get(token);

  if (!session) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  next();
}
