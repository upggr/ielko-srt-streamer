'use strict';
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const db = require('./db');

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function fetchPublicIp() {
  return new Promise((resolve) => {
    // Try multiple providers in order
    const providers = [
      { host: 'api.ipify.org', path: '/?format=text', ssl: true },
      { host: 'ifconfig.me', path: '/ip', ssl: true },
      { host: 'icanhazip.com', path: '/', ssl: true },
    ];
    let tried = 0;
    function tryNext() {
      if (tried >= providers.length) { resolve(null); return; }
      const p = providers[tried++];
      const lib = p.ssl ? https : http;
      const req = lib.get({ host: p.host, path: p.path, headers: { 'User-Agent': 'curl/7.0' } }, res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => {
          const ip = d.trim();
          if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) resolve(ip);
          else tryNext();
        });
      });
      req.on('error', tryNext);
      req.setTimeout(4000, () => { req.destroy(); tryNext(); });
    }
    tryNext();
  });
}

async function bootstrap() {
  let changed = false;

  // --- APP_PASSWORD ---
  if (!process.env.APP_PASSWORD) {
    let pw = getConfig('app_password');
    if (!pw) {
      pw = randomSecret(24);
      setConfig('app_password', pw);
      console.log(`[bootstrap] Generated APP_PASSWORD: ${pw}`);
      console.log('[bootstrap] ⚠️  Save this password — it will not be shown again');
      changed = true;
    }
    process.env.APP_PASSWORD = pw;
  }

  // --- SESSION_SECRET ---
  if (!process.env.SESSION_SECRET) {
    let secret = getConfig('session_secret');
    if (!secret) {
      secret = randomSecret(40);
      setConfig('session_secret', secret);
      changed = true;
    }
    process.env.SESSION_SECRET = secret;
  }

  // --- SERVER_IP ---
  if (!process.env.SERVER_IP || process.env.SERVER_IP === '88.198.184.233') {
    let ip = getConfig('server_ip');
    if (!ip) {
      console.log('[bootstrap] Detecting public IP...');
      ip = await fetchPublicIp();
      if (ip) {
        setConfig('server_ip', ip);
        console.log(`[bootstrap] Detected SERVER_IP: ${ip}`);
        changed = true;
      } else {
        console.warn('[bootstrap] Could not detect public IP — set SERVER_IP env var manually');
        ip = '0.0.0.0';
      }
    }
    process.env.SERVER_IP = ip;
  }

  // --- PUBLIC_URL: prefer PUBLIC_HOST (HTTPS / Caddy) from services.buy-it.gr install ---
  const publicHost = (process.env.PUBLIC_HOST || '').trim();
  const validPublicHost =
    publicHost &&
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z0-9.-]+$/i.test(publicHost) &&
    !publicHost.includes('..');

  if (validPublicHost) {
    const host = publicHost.toLowerCase();
    const httpsUrl = `https://${host}`;
    process.env.PUBLIC_URL = httpsUrl;
    const stored = getConfig('public_url');
    if (stored !== httpsUrl) {
      setConfig('public_url', httpsUrl);
      changed = true;
    }
    const prevDomain = getConfig('domain');
    if (prevDomain !== host) {
      setConfig('domain', host);
      changed = true;
    }
    if (getConfig('ssl_enabled') !== '1') {
      setConfig('ssl_enabled', '1');
      changed = true;
    }
    if (!process.env.TRUST_PROXY) {
      process.env.TRUST_PROXY = '1';
    }
  } else if (!process.env.PUBLIC_URL || process.env.PUBLIC_URL === 'https://streams.ioniantv.gr') {
    let url = getConfig('public_url');
    if (!url) {
      url = `http://${process.env.SERVER_IP}:3000`;
      setConfig('public_url', url);
      changed = true;
    }
    process.env.PUBLIC_URL = url;
  }

  // --- SETUP_TOKEN (one-time auto-login token for first boot) ---
  let setupToken = getConfig('setup_token');
  if (!setupToken) {
    setupToken = randomSecret(32);
    setConfig('setup_token', setupToken);
    setConfig('setup_token_used', '0');
    console.log(`[bootstrap] Setup token generated. Use via services.buy-it.gr dashboard.`);
    changed = true;
  }

  if (changed) {
    console.log('[bootstrap] Configuration initialized. Access the UI to complete setup.');
  }
}

module.exports = { bootstrap, getConfig, setConfig };
