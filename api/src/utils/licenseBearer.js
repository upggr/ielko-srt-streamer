'use strict';
const crypto = require('crypto');

/** Timing-safe compare: Bearer token equals this server's LICENSE_KEY. */
function bearerMatchesLicenseKey(authHeader, licenseKeyEnv) {
  const raw =
    typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const key = String(raw).trim();
  const licenseKey = String(licenseKeyEnv || '').trim();
  if (!key || !licenseKey) return false;
  try {
    const a = Buffer.from(licenseKey.padEnd(key.length, '\0'));
    const b = Buffer.from(key.padEnd(licenseKey.length, '\0'));
    return crypto.timingSafeEqual(a, b) && licenseKey.length === key.length;
  } catch {
    return false;
  }
}

module.exports = { bearerMatchesLicenseKey };
