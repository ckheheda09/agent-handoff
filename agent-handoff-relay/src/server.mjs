import http from 'node:http';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Monitor } from './monitor.mjs';
import { Directory } from './directory.mjs';
import { Pairings } from './pairings.mjs';
import { Sessions, SESSION_LIMIT } from './sessions.mjs';
import { Store, Fault, must, validID, AGE_MAGIC, acquireLock, publicRow } from './store.mjs';

export const CHUNK = 8 * 1024 ** 2;
const JSON_LIMIT = 16 * 1024;
function number(value, max = Number.MAX_SAFE_INTEGER) {
  must(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 400, 'invalid_integer');
  const n = Number(value); must(Number.isSafeInteger(n) && n <= max, 400, 'invalid_integer'); return n;
}
function send(res, status, data, extra = {}) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', ...extra }); res.end(JSON.stringify(data) + '\n');
}
async function readBody(req, max, onChunk = () => {}) {
  must(req.headers['content-length'] !== undefined && !req.headers['transfer-encoding'], 411, 'content_length_required');
  const expected = number(req.headers['content-length']); must(expected <= max, 413, 'request_too_large');
  const parts = []; let size = 0;
  for await (const part of req) { size += part.length; must(size <= expected && size <= max, 413, 'request_too_large'); parts.push(part); onChunk(part.length); }
  must(size === expected, 400, 'incomplete_body'); return Buffer.concat(parts, size);
}
async function readJSON(req, max = JSON_LIMIT) {
  must(req.headers['content-type']?.split(';')[0].trim() === 'application/json', 415, 'json_required');
  const data = await readBody(req, max);
  try { const value = JSON.parse(data); must(value && typeof value === 'object' && !Array.isArray(value), 400, 'invalid_json'); return value; }
  catch (e) { if (e instanceof Fault) throw e; throw new Fault(400, 'invalid_json'); }
}
async function hashFile(file) {
  const h = createHash('sha256'); for await (const part of fs.createReadStream(file)) h.update(part); return h.digest('hex');
}

export function createRelay(options) {
  const store = new Store(options.data, options); let releaseLock; let monitor; let directory;
  try { releaseLock = acquireLock(store.root); store.recoverReleased(); monitor = new Monitor(store); directory = new Directory(store); }
  catch (e) { releaseLock?.(); store.close(); throw e; }
  const sessions = new Sessions(store); sessions.sweep();
  const pairings = new Pairings(store, options);
  const locks = new Map(); let activeUploads = 0; let activeCommits = 0; let closed = false;
  let activeHandlers = 0; const idleWaiters = [];
  async function exclusive(id, fn) {
    const previous = locks.get(id) ?? Promise.resolve(); let release;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = previous.catch(() => {}).then(() => gate); locks.set(id, pending);
    await previous.catch(() => {});
    try { return await fn(); } finally { release(); if (locks.get(id) === pending) locks.delete(id); }
  }
  function accessible(id, device, senderOnly = false) {
    must(store.db.prepare('SELECT id FROM devices WHERE id=? AND active=1').get(device), 401, 'unauthorized');
    const row = store.forDevice(id, device);
    must(!senderOnly || row.sender === device, 404, 'handoff_not_found');
    return row;
  }
  function current(row) {
    must(row.expires_at > Date.now() && row.status !== 'expired', 410, 'handoff_expired');
    must(row.status !== 'cancelled', 410, 'handoff_cancelled');
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    activeHandlers++;
    const requestId = randomUUID(); const started = Date.now();
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => options.log?.({ event: 'request', request_id: requestId, method: req.method,
      status: res.statusCode, elapsed_ms: Date.now() - started }));
    try {
      const url = new URL(req.url, 'http://localhost'); const route = url.pathname;
      if (req.method === 'GET' && route === '/healthz') { store.db.prepare('SELECT 1').get(); return send(res, 200, { status: 'ok', version: '0.5.1' }); }
      if (req.method === 'POST' && route === '/v1/pairings') {
        const source = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',')[0].trim();
        return send(res,201,pairings.start(await readJSON(req),source));
      }
      const pairingPoll = route.match(/^\/v1\/pairings\/([A-Za-z0-9_-]{1,80})\/poll$/);
      if (req.method === 'POST' && pairingPoll) {
        const input=await readJSON(req);must(Object.keys(input).length===0,400,'unknown_field');
        return send(res,200,pairings.poll(pairingPoll[1],req.headers.authorization));
      }
      const device = store.authenticate(req.headers.authorization);
      monitor.touch(device);
      if (req.method === 'POST' && route === '/v1/agents/heartbeat') return send(res, 200, monitor.heartbeat(device, await readJSON(req)));
      if (req.method === 'GET' && route === '/v1/me') return send(res, 200, { device_id: device, max_chunk_bytes: CHUNK, max_payload_bytes: store.maxPayload });
      if (req.method === 'GET' && route === '/v1/devices') return send(res, 200, directory.list());
      if (req.method === 'POST' && route === '/v1/me/encryption-key') return send(res, 200, directory.publish(device, await readJSON(req)));
      if (req.method === 'GET' && route === '/v1/sessions') {
        const after=number(url.searchParams.get('after') ?? '0'),limit=number(url.searchParams.get('limit') ?? '50',100);
        must(limit>=1,400,'invalid_limit');const items=sessions.list(device,after,limit);
        return send(res,200,{items,next_cursor:items.at(-1)?.cursor ?? after});
      }
      if (req.method === 'POST' && route === '/v1/sessions') {
        const result=sessions.publish(device,await readJSON(req,SESSION_LIMIT*4/3+65536));
        return send(res,200,{...result,status:'published'});
      }
      const sessionMatch=route.match(/^\/v1\/sessions\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})(?:\/(payload|received|readers))?$/);
      if(sessionMatch){
        const [,id,action]=sessionMatch;
        if(req.method==='GET' && (!action || action==='payload'))return send(res,200,sessions.get(device,id,action==='payload'));
        if(req.method==='POST' && action==='readers')return send(res,200,sessions.syncReaders(device,id,await readJSON(req,SESSION_LIMIT*4/3+65536)));
        if(req.method==='POST' && action==='received'){await readJSON(req);return send(res,200,sessions.received(device,id));}
        throw new Fault(405,'method_not_allowed');
      }
      if (req.method === 'POST' && route === '/v1/handoffs') {
        const result = store.create(device, await readJSON(req));
        monitor.route(result.row);
        if (result.created) monitor.event('created', { device, peer: result.row.recipient, handoff: result.row.id, adapter: result.row.adapter_id, profile: result.row.profile_id });
        return send(res, result.created ? 201 : 200, publicRow(result.row));
      }
      if (req.method === 'GET' && ['/v1/inbox', '/v1/outbox'].includes(route)) {
        const after = number(url.searchParams.get('after') ?? '0'); const limit = number(url.searchParams.get('limit') ?? '100', 100);
        must(limit >= 1, 400, 'invalid_limit');
        const items = store.list(device, route.slice(4), after, limit).map(publicRow);
        return send(res, 200, { items, next_cursor: items.at(-1)?.cursor ?? after });
      }
      const match = route.match(/^\/v1\/handoffs\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})(?:\/(payload|commit|receipts))?$/);
      must(match, 404, 'not_found'); const [, id, action] = match;
      if (req.method === 'GET' && !action) {
        const row = accessible(id, device); const receipts = store.db.prepare('SELECT request_id,state,code,created_at FROM receipts WHERE handoff_id=? ORDER BY seq').all(id);
        return send(res, 200, { ...publicRow(row), receipts });
      }
      if (req.method === 'PATCH' && action === 'payload') {
        must(activeUploads < (options.maxConcurrentUploads ?? 2), 429, 'upload_concurrency_limit'); activeUploads++;
        let transfer;
        try {
          const row = accessible(id, device, true); current(row); const offset = number(req.headers['upload-offset']);
          must(req.headers['content-type'] === 'application/octet-stream', 415, 'binary_required');
          transfer = monitor.begin('upload', row, device, Number(req.headers['content-length']) || 0);
          const bytes = await readBody(req, CHUNK, n => { transfer.bytes += n; }); must(bytes.length > 0, 400, 'empty_chunk');
          return await exclusive(id, async () => {
            const row = accessible(id, device, true); current(row);
            const updated = store.append(row, offset, bytes);
            monitor.finish(transfer, 'upload_chunk');
            return send(res, 200, { id, offset: updated.offset });
          });
        } finally { activeUploads--; if (transfer && monitor.active.has(transfer.id)) monitor.finish(transfer, 'upload_failed', false); }
      }
      if (req.method === 'POST' && action === 'commit') {
        must(activeCommits < 2, 429, 'commit_concurrency_limit'); activeCommits++;
        try {
        await readJSON(req);
        return await exclusive(id, async () => {
          const row = accessible(id, device, true); current(row);
          if (row.status === 'ready') return send(res, 200, publicRow(row));
          must(row.status === 'uploading' && row.offset === row.size, 409, 'upload_incomplete');
          const file = store.reconcileFile(row); const fd = fs.openSync(file, 'r'); const magic = Buffer.alloc(AGE_MAGIC.length);
          try { fs.readSync(fd, magic, 0, magic.length, 0); } finally { fs.closeSync(fd); }
          must(magic.equals(AGE_MAGIC), 422, 'age_header_required');
          must(await hashFile(file) === row.sha256, 422, 'checksum_mismatch');
          // Re-check revocation after potentially long disk hashing.
          must(store.db.prepare('SELECT id FROM devices WHERE id=? AND active=1').get(device), 401, 'unauthorized');
          const updated = store.publish(row);
          monitor.event('published', { device, peer: row.recipient, handoff: id, adapter: row.adapter_id, profile: row.profile_id });
          return send(res, 200, publicRow(updated));
        });
        } finally { activeCommits--; }
      }
      if (req.method === 'GET' && action === 'payload') {
        const row = accessible(id, device); current(row); must(row.status === 'ready', 409, 'payload_not_ready');
        let start = 0; let end = row.size - 1; let status = 200;
        if (req.headers.range) {
          const r = req.headers.range.match(/^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)?$/);
          must(r, 416, 'invalid_range'); start = number(r[1]); end = r[2] ? number(r[2]) : end;
          must(start < row.size && end >= start && end < row.size, 416, 'invalid_range'); status = 206;
        }
        const file = store.payloadPath(id); const fd = fs.openSync(file, 'r');
        const actual = fs.fstatSync(fd);
        if (actual.size !== row.size) { fs.closeSync(fd); throw new Fault(409, 'payload_truncated'); }
        res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1,
          'Content-Disposition': `attachment; filename="${id}.age"`, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'X-Payload-Sha256': row.sha256, 'Accept-Ranges': 'bytes',
          ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${row.size}` } : {}) });
        const transfer = monitor.begin('download', row, device, end - start + 1);
        const meter = new Transform({ transform(chunk, _encoding, callback) { transfer.bytes += chunk.length; callback(null, chunk); } });
        try {
          await pipeline(fs.createReadStream(file, { fd, start, end, autoClose: true }), meter, res);
          monitor.finish(transfer, 'download');
        } catch (e) { monitor.finish(transfer, 'download_aborted', false); throw e; }
        return;
      }
      if (req.method === 'POST' && action === 'receipts') {
        const data = await readJSON(req);
        return await exclusive(id, async () => {
          const row = accessible(id, device); must(row.recipient === device, 403, 'recipient_only'); current(row);
          must(row.status === 'ready', 409, 'payload_not_ready');
          const existed = typeof data.request_id === 'string' && store.db.prepare('SELECT request_id FROM receipts WHERE request_id=?').get(data.request_id);
          const receipt = store.receipt(device, row, data);
          if (!existed) monitor.event('receipt', { device, peer: row.sender, handoff: id, code: receipt.state });
          return send(res, 200, receipt);
        });
      }
      if (req.method === 'DELETE' && !action) {
        return await exclusive(id, async () => {
          const row = accessible(id, device, true);
          if (row.status === 'cancelled') return send(res, 200, publicRow(row));
          must(['pending', 'verified', 'rejected', 'failed'].includes(row.receipt_state), 409, 'already_accepted');
          const updated = store.release(row, 'cancelled');
          monitor.event('cancelled', { device, peer: row.recipient, handoff: id });
          return send(res, 200, publicRow(updated));
        });
      }
      throw new Fault(405, 'method_not_allowed');
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (!(e instanceof Fault)) options.log?.({ event: 'error', request_id: requestId, code: 'internal_error' });
      send(res, e.status ?? 500, { error: e.code && e instanceof Fault ? e.code : 'internal_error', request_id: requestId }, { Connection: 'close' });
      req.resume();
    } finally {
      activeHandlers--;
      if (activeHandlers === 0) for (const resolve of idleWaiters.splice(0)) resolve();
    }
  });
  server.headersTimeout = 15_000; server.requestTimeout = 120_000; server.maxConnections = 128;
  server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
  server.on('clientError', (_e, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return {
    server, store, monitor, sessions, pairings,
    async close() {
      if (closed) return; closed = true;
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      if (activeHandlers) await new Promise(resolve => idleWaiters.push(resolve));
      store.close(); releaseLock();
    },
    // GC runs under the same per-handoff locks as uploads, commits, and receipts.
    async sweep(now = Date.now()) {
      const rows = store.db.prepare("SELECT id FROM handoffs WHERE status IN ('uploading','ready') AND expires_at<=?").all(now);
      for (const { id } of rows) await exclusive(id, async () => {
        const row = store.get(id);
        if (['uploading', 'ready'].includes(row.status) && row.expires_at <= now) {
          store.release(row, 'expired'); monitor.event('expired', { device: row.sender, peer: row.recipient, handoff: id });
        }
      });
      sessions.sweep(now);
      pairings.sweep(now);
      monitor.prune();
      return rows.length;
    }
  };
}
