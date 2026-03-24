'use strict';
const http = require('http');

const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://mediamtx:9997';

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(MEDIAMTX_API + path);
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      port: url.port || 9997,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function addPath(name, conf) {
  return apiRequest('POST', `/v3/config/paths/add/${name}`, conf || {});
}

async function removePath(name) {
  return apiRequest('DELETE', `/v3/config/paths/delete/${name}`, null);
}

async function getPathStatus(name) {
  return apiRequest('GET', `/v3/paths/get/${name}`, null);
}

async function listPaths() {
  return apiRequest('GET', '/v3/paths/list', null);
}

module.exports = { addPath, removePath, getPathStatus, listPaths };
