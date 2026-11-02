import { DatabaseSync, backup } from 'node:sqlite';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AGE_MAGIC = Buffer.from('age-encryption.org/v1\n');
export const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export const SHA = /^[a-f0-9]{64}$/;
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export class Fault extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export function must(ok, status, code) { if (!ok) throw new Fault(status, code); }
export function validID(value) { return typeof value === 'string' && ID.test(value); }
function syncDirectory(directory) {
  if (process.platform === 'win32') return; // Deployment server is Linux; Windows directory fsync is unsupported.
  const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// A single server owns the payload directory. CLI metadata writes use SQLite transactions.
const localLocks = new Set();
export function acquireLock(root) {
  const file = path.join(root, 'server.lock');
  must(!localLocks.has(file), 409, 'server_already_running');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      const identity = randomUUID();
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity }));
      fs.fsyncSync(fd); fs.closeSync(fd); localLocks.add(file);
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file)).identity === identity) fs.unlinkSync(file);
        } catch { /* preserve unrelated locks */ }
        localLocks.delete(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file)); }
      catch { throw new Fault(409, 'unreadable_server_lock'); }
      must(Number.isSafeInteger(owner.pid) && owner.pid > 0, 409, 'invalid_server_lock');
      let alive = owner.pid !== process.pid;
      if (alive) {
        try { process.kill(owner.pid, 0); }
        catch (e) { if (e.code === 'ESRCH') alive = false; else throw new Fault(409, 'server_lock_unverifiable'); }
      }
      must(!alive, 409, 'server_already_running');
      fs.unlinkSync(file);
    }
  }
  throw new Fault(409, 'server_lock_race');
}

export class Store {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.quota = options.quota ?? 10 * 1024 ** 3;
    this.maxPayload = options.maxPayload ?? 1024 ** 3;
    this.maxPending = options.maxPending ?? 20;
    this.ttl = options.ttl ?? 30 * 86400_000;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.payloadRoot = path.join(this.root, 'payloads');
    fs.mkdirSync(this.payloadRoot, { mode: 0o700, recursive: true });
    this.db = new DatabaseSync(path.join(this.root, 'relay.db'));
    fs.chmodSync(path.join(this.root, 'relay.db'), 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    must(version <= 1, 500, 'database_version_too_new');
    if (version === 0) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE devices(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
      CREATE TABLE handoffs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        sender TEXT NOT NULL REFERENCES devices(id), recipient TEXT NOT NULL REFERENCES devices(id),
        adapter_id TEXT NOT NULL, profile_id TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        offset INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'uploading',
        receipt_state TEXT NOT NULL DEFAULT 'pending', released INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, ready_at INTEGER, expires_at INTEGER NOT NULL);
      CREATE TABLE deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT, handoff_id TEXT UNIQUE NOT NULL REFERENCES handoffs(id));
      CREATE TABLE receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL,
        handoff_id TEXT NOT NULL REFERENCES handoffs(id), device_id TEXT NOT NULL REFERENCES devices(id),
        state TEXT NOT NULL, code TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX inbox_lookup ON handoffs(recipient, status);
      CREATE INDEX outbox_lookup ON handoffs(sender, seq);
      PRAGMA user_version=1;
      COMMIT;
    `);
    // Durable audit is separate from the bounded dashboard telemetry.
    this.db.exec(`CREATE TABLE IF NOT EXISTS device_deletions(
      device_id TEXT PRIMARY KEY REFERENCES devices(id),name TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,actor TEXT NOT NULL);`);
    // Additive tables keep existing device and directed-handoff data compatible.
    this.db.exec(`CREATE TABLE IF NOT EXISTS shared_sessions(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,sender TEXT NOT NULL REFERENCES devices(id),
      title TEXT NOT NULL,source_agent TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,
      fingerprint TEXT NOT NULL,payload BLOB,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_readers(session_id TEXT NOT NULL REFERENCES shared_sessions(id),
        device_id TEXT NOT NULL REFERENCES devices(id),PRIMARY KEY(session_id,device_id));
      CREATE TABLE IF NOT EXISTS session_reads(session_id TEXT NOT NULL REFERENCES shared_sessions(id),
        device_id TEXT NOT NULL REFERENCES devices(id),state TEXT NOT NULL,received_at INTEGER NOT NULL,
        PRIMARY KEY(session_id,device_id));
      CREATE INDEX IF NOT EXISTS session_reader_lookup ON session_readers(device_id,session_id);`);
  }
  reservedBytes() {
    return this.db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM handoffs WHERE released=0').get().n +
      this.db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM shared_sessions WHERE payload IS NOT NULL').get().n;
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  addDevice(id, name) {
    must(validID(id), 400, 'invalid_device_id');
    must(typeof name === 'string' && name.length > 0 && name.length <= 128, 400, 'invalid_device_name');
    must(!this.db.prepare('SELECT 1 FROM device_deletions WHERE device_id=?').get(id), 409, 'device_deleted');
    const token = randomBytes(32).toString('base64url');
    try { this.db.prepare('INSERT INTO devices(id,name,token_hash,created_at) VALUES(?,?,?,?)').run(id, name, digest(token), Date.now()); }
    catch (e) { if (this.db.prepare('SELECT id FROM devices WHERE id=?').get(id)) throw new Fault(409, 'device_exists'); throw e; }
    return token;
  }
  renameDevice(id, name) {
    must(validID(id), 400, 'invalid_device_id');
    must(typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 128 &&
      !/[\x00-\x1f\x7f]/.test(name), 400, 'invalid_device_name');
    must(!this.db.prepare('SELECT 1 FROM device_deletions WHERE device_id=?').get(id), 410, 'device_deleted');
    name = name.trim();
    const result = this.db.prepare('UPDATE devices SET name=? WHERE id=?').run(name, id);
    must(result.changes === 1, 404, 'device_not_found');
    return { id, name };
  }
  rotateDevice(id) {
    must(!this.db.prepare('SELECT 1 FROM device_deletions WHERE device_id=?').get(id), 410, 'device_deleted');
    must(this.db.prepare('SELECT id FROM devices WHERE id=?').get(id), 404, 'device_not_found');
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE devices SET token_hash=?,active=1 WHERE id=?').run(digest(token), id);
    return token;
  }
  deleteDevice(id, actor = 'cli') {
    must(validID(id), 400, 'invalid_device_id');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM device_deletions WHERE device_id=?').get(id);
      if (previous) return { created: false, audit: { event: 'device_deleted', ...previous } };
      const device = this.db.prepare('SELECT name FROM devices WHERE id=?').get(id);
      must(device, 404, 'device_not_found');
      const audit = { event: 'device_deleted', device_id: id, name: device.name, deleted_at: Date.now(), actor };
      this.db.prepare('INSERT INTO device_deletions(device_id,name,deleted_at,actor) VALUES(?,?,?,?)')
        .run(id, audit.name, audit.deleted_at, actor);
      // Keep foreign-key history while permanently discarding the credential.
      this.db.prepare('UPDATE devices SET active=0,token_hash=? WHERE id=?').run(digest(randomBytes(32)), id);
      return { created: true, audit };
    });
  }
  revokeDevice(id) {
    const r = this.db.prepare('UPDATE devices SET active=0 WHERE id=?').run(id);
    must(r.changes === 1, 404, 'device_not_found');
  }
  authenticate(header) {
    must(typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(header), 401, 'unauthorized');
    const row = this.db.prepare('SELECT id FROM devices WHERE active=1 AND token_hash=?').get(digest(header.slice(7)));
    must(row, 401, 'unauthorized'); return row.id;
  }
  payloadPath(id) { must(validID(id), 400, 'invalid_handoff_id'); return path.join(this.payloadRoot, `${id}.age`); }
  get(id) { return this.db.prepare('SELECT * FROM handoffs WHERE id=?').get(id); }
  forDevice(id, device) {
    const row = this.get(id); must(row && (row.sender === device || row.recipient === device), 404, 'handoff_not_found'); return row;
  }
  create(sender, data) {
    must(data && typeof data === 'object' && !Array.isArray(data), 400, 'invalid_request');
    const allowed = ['id', 'recipient', 'size', 'sha256', 'payload_format', 'adapter_id', 'profile_id'];
    must(Object.keys(data).every(k => allowed.includes(k)), 400, 'unknown_field');
    const { id, recipient, size, sha256, payload_format, adapter_id = 'generic', profile_id = 'default' } = data;
    const endpoint = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
    must(validID(id) && validID(recipient) && endpoint(adapter_id) && endpoint(profile_id), 400, 'invalid_identifier');
    must(payload_format === 'age-v1', 400, 'encrypted_age_payload_required');
    must(Number.isSafeInteger(size) && size >= AGE_MAGIC.length && size <= this.maxPayload, 413, 'payload_size_limit');
    must(typeof sha256 === 'string' && SHA.test(sha256), 400, 'invalid_sha256');
    return this.transaction(() => {
      const existing = this.get(id);
      if (existing) {
        must(existing.sender === sender, 404, 'handoff_not_found');
        must(existing.recipient === recipient && existing.size === size && existing.sha256 === sha256 &&
          existing.adapter_id === adapter_id && existing.profile_id === profile_id, 409, 'idempotency_conflict');
        return { row: existing, created: false };
      }
      must(this.db.prepare('SELECT id FROM devices WHERE id=? AND active=1').get(recipient), 404, 'recipient_unavailable');
      const used = this.reservedBytes();
      must(used + size <= this.quota, 507, 'storage_quota_exceeded');
      const pending = this.db.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE sender=? AND status='uploading'").get(sender).n;
      must(pending < this.maxPending, 429, 'too_many_pending_uploads');
      const now = Date.now();
      this.db.prepare(`INSERT INTO handoffs(id,sender,recipient,adapter_id,profile_id,size,sha256,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, sender, recipient, adapter_id, profile_id, size, sha256, now, now + this.ttl);
      return { row: this.get(id), created: true };
    });
  }
  reconcileFile(row) {
    const file = this.payloadPath(row.id);
    if (!fs.existsSync(file)) {
      must(row.offset === 0, 409, 'payload_missing');
      const fd = fs.openSync(file, 'wx', 0o600); fs.fsyncSync(fd); fs.closeSync(fd); syncDirectory(this.payloadRoot);
    }
    const info = fs.lstatSync(file);
    must(info.isFile() && !info.isSymbolicLink(), 500, 'invalid_payload_file');
    must(info.size >= row.offset, 409, 'payload_truncated');
    if (info.size > row.offset) {
      const fd = fs.openSync(file, 'r+');
      try { fs.ftruncateSync(fd, row.offset); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return file;
  }
  append(row, offset, bytes) {
    must(row.status === 'uploading', 409, 'not_uploading');
    must(offset === row.offset, 409, 'offset_conflict');
    must(offset + bytes.length <= row.size, 413, 'payload_exceeds_declared_size');
    const file = this.reconcileFile(row); const fd = fs.openSync(file, 'r+');
    try {
      let written = 0;
      while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written, offset + written);
      fs.fsyncSync(fd);
      this.db.prepare('UPDATE handoffs SET offset=? WHERE id=?').run(offset + bytes.length, row.id);
    } catch (error) {
      fs.ftruncateSync(fd, offset); fs.fsyncSync(fd); throw error;
    } finally { fs.closeSync(fd); }
    return this.get(row.id);
  }
  publish(row) {
    return this.transaction(() => {
      this.db.prepare("UPDATE handoffs SET status='ready',ready_at=? WHERE id=? AND status='uploading'").run(Date.now(), row.id);
      this.db.prepare('INSERT OR IGNORE INTO deliveries(handoff_id) VALUES(?)').run(row.id);
      return this.get(row.id);
    });
  }
  receipt(device, row, data) {
    must(data && typeof data === 'object' && !Array.isArray(data), 400, 'invalid_request');
    must(Object.keys(data).every(k => ['request_id', 'state', 'code'].includes(k)), 400, 'unknown_field');
    const { request_id, state, code = '' } = data;
    must(validID(request_id), 400, 'invalid_receipt_id');
    must(typeof code === 'string' && /^[A-Za-z0-9_-]{0,64}$/.test(code), 400, 'invalid_receipt_code');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(request_id);
      if (old) {
        must(old.device_id === device && old.handoff_id === row.id && old.state === state && old.code === code, 409, 'receipt_idempotency_conflict');
        return old;
      }
      const transitions = {
        pending: ['verified', 'rejected', 'failed'], verified: ['accepted', 'rejected', 'failed'],
        accepted: ['started', 'failed'], started: ['completed', 'failed'], completed: [], rejected: [], failed: []
      };
      must(transitions[row.receipt_state]?.includes(state), 409, 'invalid_receipt_transition');
      this.db.prepare('INSERT INTO receipts(request_id,handoff_id,device_id,state,code,created_at) VALUES(?,?,?,?,?,?)')
        .run(request_id, row.id, device, state, code, Date.now());
      this.db.prepare('UPDATE handoffs SET receipt_state=? WHERE id=?').run(state, row.id);
      return this.db.prepare('SELECT * FROM receipts WHERE request_id=?').get(request_id);
    });
  }
  release(row, status) {
    this.db.prepare('UPDATE handoffs SET status=? WHERE id=?').run(status, row.id);
    this.deleteReleasedFile(row.id);
    return this.get(row.id);
  }
  deleteReleasedFile(id) {
    fs.rmSync(this.payloadPath(id), { force: true });
    syncDirectory(this.payloadRoot);
    this.db.prepare('UPDATE handoffs SET released=1 WHERE id=?').run(id);
  }
  recoverReleased() {
    for (const row of this.db.prepare("SELECT id FROM handoffs WHERE status IN ('cancelled','expired') AND released=0").all()) this.deleteReleasedFile(row.id);
  }
  list(device, kind, after, limit) {
    if (kind === 'inbox') return this.db.prepare(`SELECT h.*,d.seq AS cursor FROM deliveries d JOIN handoffs h ON h.id=d.handoff_id
      WHERE h.recipient=? AND d.seq>? ORDER BY d.seq LIMIT ?`).all(device, after, limit);
    return this.db.prepare('SELECT *,seq AS cursor FROM handoffs WHERE sender=? AND seq>? ORDER BY seq LIMIT ?').all(device, after, limit);
  }
  stats() {
    return {
      reserved_bytes: this.reservedBytes(),
      devices: this.db.prepare('SELECT id,name,active,created_at FROM devices WHERE active=1 ORDER BY id').all(),
      statuses: this.db.prepare('SELECT status,COUNT(*) AS count FROM handoffs GROUP BY status').all()
    };
  }
  async backupTo(file) { await backup(this.db, file); }
  close() { this.db.close(); }
}

export function publicRow(row) {
  const { seq, released, ...rest } = row;
  return { ...rest, payload_format: 'age-v1', receipt_evidence: 'recipient_device_reported' };
}
