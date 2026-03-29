'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../db');

const MOUNTS_DIR = process.env.ICECAST_CONFIG_DIR || '/icecast-config';
const MOUNTS_FILE = path.join(MOUNTS_DIR, 'mounts.xml');

/**
 * Regenerate /icecast-config/mounts.xml from all icecast endpoints in the DB.
 * The icecast container watches this file and sends itself SIGHUP on change.
 */
function rewriteMountsConfig() {
  try {
    fs.mkdirSync(MOUNTS_DIR, { recursive: true });
  } catch {}

  const endpoints = db.prepare("SELECT name, icecast_source_password FROM endpoints WHERE protocol = 'icecast'").all();

  let xml = '<icecast>\n';
  for (const ep of endpoints) {
    if (ep.source_mode === 'pull' && ep.source_url) {
      // Icecast relay: pull from external Icecast/Shoutcast source
      try {
        const u = new URL(ep.source_url);
        xml += `  <relay>\n`;
        xml += `    <server>${escapeXml(u.hostname)}</server>\n`;
        xml += `    <port>${escapeXml(u.port || '8000')}</port>\n`;
        xml += `    <mount>${escapeXml(u.pathname || '/')}</mount>\n`;
        xml += `    <local-mount>/${escapeXml(ep.name)}</local-mount>\n`;
        xml += `    <on-demand>0</on-demand>\n`;
        xml += `  </relay>\n`;
      } catch {}
    } else if (ep.icecast_source_password) {
      // Icecast push: per-mount password
      xml += `  <mount type="normal">\n`;
      xml += `    <mount-name>/${escapeXml(ep.name)}</mount-name>\n`;
      xml += `    <password>${escapeXml(ep.icecast_source_password)}</password>\n`;
      xml += `    <max-listeners>-1</max-listeners>\n`;
      xml += `  </mount>\n`;
    }
  }
  xml += '</icecast>\n';

  try {
    fs.writeFileSync(MOUNTS_FILE, xml, 'utf8');
    console.log(`[icecast] wrote ${endpoints.length} mount(s) to ${MOUNTS_FILE}`);
  } catch (e) {
    console.warn(`[icecast] could not write mounts config: ${e.message}`);
  }
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { rewriteMountsConfig };
