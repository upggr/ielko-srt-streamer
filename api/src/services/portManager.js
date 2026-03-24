'use strict';
const db = require('../db');

const PORT_MIN = parseInt(process.env.SRT_PORT_MIN || '10000');
const PORT_MAX = parseInt(process.env.SRT_PORT_MAX || '11000');

function allocatePort() {
  const used = new Set(db.prepare('SELECT port FROM endpoints').all().map(r => r.port));
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error('No available ports in range');
}

module.exports = { allocatePort };
