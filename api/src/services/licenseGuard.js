'use strict';
const https = require('https');
const http = require('http');
const { removePath, addPath, listPaths } = require('./mediamtxClient');
const { withPlanLimits } = require('./mediamtxPathConfig');
const { stopYouTube, stopFacebook, stopInstagram, stopTranscode } = require('./ffmpegManager');
const db = require('../db');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BUILD_SHA = process.env.BUILD_SHA || 'dev';

/** Read on each check so .env/bootstrap updates apply without stale module constants. */
function licenseValidateUrlNow() {
  return (process.env.LICENSE_VALIDATE_URL || 'https://services.buy-it.gr/api/license/validate').trim();
}
function licenseKeyNow() {
  return String(process.env.LICENSE_KEY || '').trim();
}
function serverIpNow() {
  return String(process.env.SERVER_IP || '').trim();
}

// In-memory license state — source of truth for the running process
let licenseState = {
  valid: false,
  plan: null,
  streams: 0,
  reason: 'Not checked yet',
  lastChecked: null,
  checking: false,
  currentVersion: BUILD_SHA,
  latestVersion: null,
  updateAvailable: false,
};

function getState() { return { ...licenseState }; }

function fetchLicenseCheck() {
  return new Promise((resolve) => {
    const key = licenseKeyNow();
    if (!key) {
      resolve({ valid: false, reason: 'No LICENSE_KEY configured' });
      return;
    }

    const url = new URL(licenseValidateUrlNow());
    url.searchParams.set('key', key);
    const sip = serverIpNow();
    if (sip && sip !== '0.0.0.0') url.searchParams.set('ip', sip);

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url.toString(), { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ valid: false, reason: `Invalid response from license server` });
        }
      });
    });
    req.on('error', (e) => resolve({ valid: false, reason: `License server unreachable: ${e.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ valid: false, reason: 'License server timeout' }); });
  });
}

async function killAllStreaming() {
  console.log('[license] LICENSE INVALID — killing all streaming activity');

  // Stop all restream processes
  const endpoints = db.prepare('SELECT * FROM endpoints').all();
  for (const ep of endpoints) {
    try { stopYouTube(ep.id); } catch {}
    try { stopFacebook(ep.id); } catch {}
    try { stopInstagram(ep.id); } catch {}
    try { stopTranscode(ep.id, ep.name); } catch {}
  }

  // Remove all mediamtx paths so no one can publish or receive
  try {
    const result = await listPaths();
    if (result && result.status === 200 && result.body && result.body.items) {
      for (const p of result.body.items) {
        try { await removePath(p.name); } catch {}
      }
    }
  } catch {}

  // Mark all endpoints stopped in DB
  db.prepare("UPDATE endpoints SET status='stopped' WHERE status='running'").run();
}

async function reapplyAllMediamtxPaths() {
  const endpoints = db.prepare('SELECT * FROM endpoints').all();
  const plan = licenseState.plan;
  for (const ep of endpoints) {
    try {
      const conf = ep.source_mode === 'pull' && ep.source_url ? { source: ep.source_url } : {};
      await addPath(ep.name, withPlanLimits(plan, conf));
    } catch {}
  }
}

async function restoreStreaming() {
  console.log('[license] License valid — restoring mediamtx paths');
  await reapplyAllMediamtxPaths();
}

let wasValid = null; // track transitions

async function checkLicense() {
  if (licenseState.checking) return;
  licenseState.checking = true;

  const previousPlan = licenseState.plan;
  const result = await fetchLicenseCheck();
  const nowValid = result.valid === true;

  const latestVersion = result.latestVersion || null;
  const updateAvailable = !!(latestVersion && latestVersion !== BUILD_SHA && BUILD_SHA !== 'dev');

  licenseState = {
    valid: nowValid,
    plan: result.plan || null,
    streams: result.streams || 0,
    reason: result.reason || null,
    lastChecked: new Date().toISOString(),
    checking: false,
    currentVersion: BUILD_SHA,
    latestVersion,
    updateAvailable,
  };

  console.log(`[license] check: valid=${nowValid} plan=${result.plan || '-'} streams=${result.streams || 0}${result.reason ? ' reason=' + result.reason : ''}${updateAvailable ? ` UPDATE AVAILABLE: ${latestVersion}` : ''}`);

  if (!nowValid && wasValid !== false) {
    // Transition: valid → invalid (or first check invalid)
    await killAllStreaming();
  } else if (nowValid && wasValid === false) {
    // Transition: invalid → valid — restore paths
    await restoreStreaming();
  } else if (nowValid && wasValid !== false && (result.plan || null) !== (previousPlan || null)) {
    console.log('[license] plan changed — updating mediamtx path limits');
    await reapplyAllMediamtxPaths();
  }

  wasValid = nowValid;
}

function startLicenseWatchdog() {
  // First check after 5s (give mediamtx time to start)
  setTimeout(checkLicense, 5000);
  setInterval(checkLicense, CHECK_INTERVAL_MS);
}

// Express middleware: block streaming-related API actions when unlicensed
function requireLicense(req, res, next) {
  if (!licenseState.valid) {
    return res.status(402).json({
      error: 'License invalid',
      reason: licenseState.reason || 'No valid license',
      licensed: false,
    });
  }
  next();
}

module.exports = { startLicenseWatchdog, getState, requireLicense, checkLicense };
