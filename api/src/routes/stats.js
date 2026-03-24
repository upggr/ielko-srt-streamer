'use strict';
const { Router } = require('express');
const { execSync } = require('child_process');
const db = require('../db');

const router = Router();

router.get('/', (req, res) => {
  const endpoints = db.prepare('SELECT status FROM endpoints').all();
  const total = endpoints.length;
  const live = endpoints.filter(e => e.status === 'running').length;
  const stopped = endpoints.filter(e => e.status === 'stopped').length;
  const errored = endpoints.filter(e => e.status === 'error').length;

  let cpuLoad = '', memFree = '', uptime = '';
  try { cpuLoad = execSync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", { timeout: 2000 }).toString().trim(); } catch {}
  try { memFree = execSync("free -m | awk '/Mem:/ {printf \"%dMB / %dMB\", $3, $2}'", { timeout: 2000 }).toString().trim(); } catch {}
  try { uptime = execSync('uptime -p', { timeout: 2000 }).toString().trim(); } catch {}

  res.json({ endpoints: { total, live, stopped, errored }, system: { cpuLoad, memFree, uptime } });
});

module.exports = router;
