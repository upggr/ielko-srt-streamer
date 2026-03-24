import db from '../db';

const PORT_MIN = parseInt(process.env.SRT_PORT_MIN || '10000');
const PORT_MAX = parseInt(process.env.SRT_PORT_MAX || '11000');

export function allocatePort(): number {
  const usedPorts = (db.prepare('SELECT port FROM endpoints').all() as { port: number }[])
    .map(r => r.port);
  const usedSet = new Set(usedPorts);

  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!usedSet.has(p)) return p;
  }

  throw new Error('No available ports in range');
}
