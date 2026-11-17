const crypto = require('node:crypto');

const hosted = process.env.OZON_OBSERVER_MODE === 'hosted';
const port = 8765;
let origin = 'http://127.0.0.1:' + port;
let dashboardCredentials;
let ingestionCredentials;

if (hosted) {
  const value = new URL(process.env.OZON_OBSERVER_ORIGIN);
  if (value.protocol !== 'https:' || value.origin !== process.env.OZON_OBSERVER_ORIGIN) {
    throw new Error('OZON_OBSERVER_ORIGIN must be an HTTPS origin without a path.');
  }
  origin = value.origin;
  const user = process.env.OZON_DASHBOARD_USER;
  const password = process.env.OZON_DASHBOARD_PASSWORD;
  const token = process.env.OZON_INGEST_TOKEN;
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(user || '') ||
      !/^[!-~]{24,256}$/.test(password || '') ||
      !/^[a-zA-Z0-9_-]{32,256}$/.test(token || '') || password === token) {
    throw new Error('Configure distinct dashboard and ingestion credentials.');
  }
  dashboardCredentials = 'Basic ' + Buffer.from(user + ':' + password).toString('base64');
  ingestionCredentials = 'Bearer ' + token;
}

function equal(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const digest = value => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(actual),digest(expected));
}

function dashboardAllowed(req) {
  return !hosted || equal(req.headers.authorization,dashboardCredentials);
}

function ingestionAllowed(req) {
  const extension = /^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin || '');
  return extension && (!hosted || equal(req.headers.authorization,ingestionCredentials));
}

module.exports = { hosted, port, origin, dashboardAllowed, ingestionAllowed };
