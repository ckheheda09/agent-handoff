import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Fault, must } from './store.mjs';

const scrypt = promisify(scryptCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
const COOKIE = '__Host-relay_admin';
const TTL = 8 * 3600_000;
export async function newAdminCredential(username = 'admin') {
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return { credential: { username, salt, hash: derived.toString('hex') }, password };
}

export function createAdmin(relay, options) {
  const credential = options.credential ?? JSON.parse(fs.readFileSync(options.credentialFile, 'utf8'));
  must(typeof credential.username === 'string' && /^[a-f0-9]{32}$/.test(credential.salt) &&
    /^[a-f0-9]{128}$/.test(credential.hash), 500, 'invalid_admin_credential');
  const origin = new URL(options.origin).origin;
  const sessions = new Map(); const attempts = new Map(); let logins = 0;
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', fs.readFileSync(new URL('../web/index.html', import.meta.url))]],
    ['/app.js', ['text/javascript; charset=utf-8', fs.readFileSync(new URL('../web/app.js', import.meta.url))]],
    ['/style.css', ['text/css; charset=utf-8', fs.readFileSync(new URL('../web/style.css', import.meta.url))]],
  ]);
  for (const name of ['plex-sans-400.ttf','plex-sans-500.ttf','plex-sans-600.ttf','plex-mono-400.ttf','plex-mono-500.ttf']) {
    assets.set(`/fonts/${name}`, ['font/ttf', Buffer.from(fs.readFileSync(new URL(`../web/fonts/${name}.b64`, import.meta.url), 'utf8').trim(), 'base64')]);
  }
  // Public distribution is an explicit allowlist, never a filesystem path supplied by a request.
  for (const [name,type] of [
    ['agent-handoff-connect-0.5.0.tgz','application/octet-stream'],
    ['agent-handoff-connect-0.5.0.tgz.sha256','text/plain; charset=utf-8'],
    ['HOSTS.md','text/plain; charset=utf-8'],
    ['agent-handoff-connect-0.4.0.tgz','application/octet-stream'],
    ['agent-handoff-connect-0.4.0.tgz.sha256','text/plain; charset=utf-8'],
    ['agent-handoff-connect-0.3.0.tgz','application/octet-stream'],
    ['agent-handoff-connect-0.3.0.tgz.sha256','text/plain; charset=utf-8'],
    ['relay-ca.crt','application/x-pem-file'],
    ['INSTALL.md','text/plain; charset=utf-8'],
  ]) {
    const file = path.join(options.downloadsDir ?? fileURLToPath(new URL('../web/downloads/', import.meta.url)), name);
    if (fs.existsSync(file)) assets.set(`/downloads/${name}`, [type,fs.readFileSync(file)]);
  }
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  function send(res, status, data, extra = {}) {
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra });
    res.end(JSON.stringify(data));
  }
  async function body(req) {
    must(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'json_required');
    let n = 0; const parts = [];
    for await (const p of req) { n += p.length; must(n <= 4096, 413, 'request_too_large'); parts.push(p); }
    let data;
    try { data = JSON.parse(Buffer.concat(parts).toString()); } catch { throw new Fault(400, 'invalid_json'); }
    must(data && typeof data === 'object' && !Array.isArray(data), 400, 'invalid_json'); return data;
  }
  function session(req) {
    const cookie = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
    const sid = cookie?.slice(COOKIE.length + 1) ?? '';
    must(/^[A-Za-z0-9_-]{43}$/.test(sid), 401, 'login_required');
    const key = hash(sid); const value = sessions.get(key);
    if (!value || value.expires <= Date.now()) { sessions.delete(key); throw new Fault(401, 'login_required'); }
    return { ...value, key };
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    try {
      const route = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && assets.has(route)) {
        const [type, content] = assets.get(route); res.writeHead(200, { ...headers, 'Content-Type': type }); return res.end(content);
      }
      if (req.method === 'GET' && route === '/healthz') return send(res, 200, { status: 'ok', component: 'admin' });
      if (req.method !== 'GET') must(req.headers.origin === origin, 403, 'origin_rejected');
      if (req.method === 'POST' && route === '/admin/api/login') {
        const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',')[0].trim();
        const now = Date.now();
        for (const [key, item] of attempts) if (item.until <= now) attempts.delete(key);
        if (attempts.size > 2000) throw new Fault(429, 'login_rate_limit');
        const rate = attempts.get(ip) ?? { failures: 0, until: now + 300_000 };
        must(rate.failures < 10 && logins < 2, 429, 'login_rate_limit');
        const data = await body(req);
        must(typeof data.username === 'string' && data.username.length <= 100 &&
          typeof data.password === 'string' && data.password.length <= 256, 400, 'invalid_login');
        logins++;
        let derived;
        try { derived = await scrypt(data.password, credential.salt, 64); } finally { logins--; }
        const good = timingSafeEqual(derived, Buffer.from(credential.hash, 'hex')) && data.username === credential.username;
        if (!good) { rate.failures++; attempts.set(ip, rate); throw new Fault(401, 'invalid_login'); }
        attempts.delete(ip);
        for (const [key, item] of sessions) if (item.expires <= now) sessions.delete(key);
        if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
        const sid = randomBytes(32).toString('base64url'); const csrf = randomBytes(24).toString('base64url');
        sessions.set(hash(sid), { username: credential.username, csrf, expires: now + TTL });
        return send(res, 200, { username: credential.username, csrf }, {
          'Set-Cookie': `${COOKIE}=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
        });
      }
      const user = session(req);
      if (req.method === 'GET' && route === '/admin/api/session') return send(res, 200, { username: user.username, csrf: user.csrf });
      if (req.method === 'GET' && route === '/admin/api/snapshot') return send(res, 200, relay.monitor.snapshot());
      const detail = route.match(/^\/admin\/api\/handoffs\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})$/);
      if (req.method === 'GET' && detail) {
        const row = relay.store.get(detail[1]); must(row, 404, 'handoff_not_found');
        const { id,sender,recipient,adapter_id,profile_id,size,offset,status,receipt_state,created_at,ready_at,expires_at } = row;
        return send(res, 200, { id,sender,recipient,adapter_id,profile_id,size,offset,status,receipt_state,created_at,ready_at,expires_at,
          receipts: relay.store.db.prepare('SELECT state,code,created_at FROM receipts WHERE handoff_id=? ORDER BY seq').all(id),
          events: relay.store.db.prepare('SELECT * FROM flow_events WHERE handoff_id=? ORDER BY seq DESC LIMIT 100').all(id) });
      }
      if (req.method !== 'GET') must(req.headers['x-csrf-token'] === user.csrf, 403, 'csrf_rejected');
      if (req.method === 'POST' && route === '/admin/api/logout') {
        sessions.delete(user.key);
        return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (req.method === 'POST' && route === '/admin/api/devices') {
        const data = await body(req);
        const token = relay.store.addDevice(data.id, data.name ?? data.id);
        relay.monitor.event('device_added', { device: data.id });
        return send(res, 201, { credential_version: 1, device_id: data.id, relay_url: options.relayURL, token });
      }
      const rename = route.match(/^\/admin\/api\/devices\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/rename$/);
      if (req.method === 'POST' && rename) {
        const data = await body(req);
        must(Object.keys(data).every(key => key === 'name'), 400, 'unknown_field');
        const device = relay.store.renameDevice(rename[1], data.name);
        relay.monitor.event('device_renamed', { device: device.id });
        return send(res, 200, device);
      }
      const match = route.match(/^\/admin\/api\/devices\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/(rotate|revoke)$/);
      if (req.method === 'POST' && match) {
        const [, id, action] = match;
        if (action === 'revoke') {
          relay.store.revokeDevice(id); relay.monitor.event('device_revoked', { device: id });
          return send(res, 200, { ok: true });
        }
        const token = relay.store.rotateDevice(id); relay.monitor.event('device_rotated', { device: id });
        return send(res, 200, { credential_version: 1, device_id: id, relay_url: options.relayURL, token });
      }
      throw new Fault(404, 'not_found');
    } catch (e) {
      if (!res.headersSent) send(res, e instanceof Fault ? e.status : 500, { error: e instanceof Fault ? e.code : 'internal_error' });
      else res.destroy();
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxConnections = 64;
  server.keepAliveTimeout = 5000;
  return { server, close: () => new Promise(resolve => { sessions.clear(); server.close(resolve); server.closeIdleConnections(); }) };
}
