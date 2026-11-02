import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { digest, must } from './store.mjs';
import { validRecipient } from './directory.mjs';

const TTL = 10 * 60_000;
const INTERVAL = 3;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
// Device codes are random bearer secrets. Only their hashes are stored. The
// domain-separated credential is reproducible for response-loss retries, without
// putting plaintext access tokens or a new server master key in the database.
const credentialToken = (code, id) => createHmac('sha256', code).update(`agent-handoff-pairing-token-v1:${id}`).digest('base64url');
export class Pairings {
  constructor(store, options = {}) {
    this.store = store; this.db = store.db; this.log = options.log; this.verificationURL = null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS device_pairings(
      id TEXT PRIMARY KEY,user_code TEXT UNIQUE NOT NULL,secret_hash TEXT UNIQUE NOT NULL,
      device_id TEXT NOT NULL,name TEXT NOT NULL,os TEXT NOT NULL,agents TEXT NOT NULL,recipient TEXT NOT NULL,
      source_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,last_poll_at INTEGER NOT NULL DEFAULT 0,
      approved_by TEXT,approved_at INTEGER,claimed_at INTEGER);`);
    this.sweep();
  }
  start(input, source, now = Date.now()) {
    must(input && Object.keys(input).every(k => ['name','os','agents','recipient'].includes(k)), 400, 'unknown_field');
    must(text(input.name,128) && text(input.os,80), 400, 'invalid_device_metadata');
    must(Array.isArray(input.agents) && input.agents.length <= 10 &&
      input.agents.every(a => ['dsh','hermes','codex','chatgpt'].includes(a)), 400, 'invalid_agent');
    must(validRecipient(input.recipient), 400, 'invalid_age_recipient');
    this.sweep(now);
    return this.store.transaction(() => {
      const sourceHash = digest(source);
      must(this.db.prepare('SELECT COUNT(*) AS n FROM device_pairings WHERE source_hash=? AND created_at>?').get(sourceHash,now-TTL).n < 10,429,'pairing_rate_limit');
      must(this.db.prepare("SELECT COUNT(*) AS n FROM device_pairings WHERE expires_at>? AND status IN ('pending','approved')").get(now).n < 100,429,'pairing_capacity');
      const id = randomUUID(), secret = randomBytes(32).toString('base64url');
      const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
      let userCode;
      do {const chars = [...randomBytes(8)].map(n => alphabet[n % alphabet.length]).join('');userCode = chars.slice(0,4)+'-'+chars.slice(4);} while(this.db.prepare('SELECT 1 FROM device_pairings WHERE user_code=?').get(userCode));
      this.db.prepare(`INSERT INTO device_pairings(id,user_code,secret_hash,device_id,name,os,agents,recipient,source_hash,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,userCode,digest(secret),'device-'+randomBytes(8).toString('hex'),input.name.trim(),input.os.trim(),JSON.stringify([...new Set(input.agents)]),input.recipient,sourceHash,now,now+TTL);
      return { id, device_code: secret, user_code: userCode, expires_at: now+TTL, interval_seconds: INTERVAL, verification_uri: this.verificationURL };
    });
  }
  list(now = Date.now()) {
    return this.db.prepare(`SELECT id,user_code,name,os,agents,status,created_at,expires_at FROM device_pairings
      WHERE status IN ('pending','approved') AND expires_at>? ORDER BY created_at DESC`).all(now)
      .map(row => ({...row,agents:JSON.parse(row.agents)}));
  }
  decide(id, action, input, actor, now = Date.now()) {
    must(input && Object.keys(input).length === 1 && typeof input.user_code === 'string',400,'pairing_code_required');
    return this.store.transaction(() => {
      const row = this.db.prepare('SELECT * FROM device_pairings WHERE id=?').get(id);
      must(row,404,'pairing_not_found');must(row.expires_at>now,410,'pairing_expired');
      must(row.user_code===input.user_code,400,'pairing_code_mismatch');
      const status = action === 'approve' ? 'approved' : 'rejected';
      if(row.status===status) return {id,status,changed:false};
      must(row.status==='pending',409,'pairing_already_decided');
      this.db.prepare('UPDATE device_pairings SET status=?,approved_by=?,approved_at=? WHERE id=?').run(status,actor,now,id);
      return {id,status,changed:true};
    });
  }
  poll(id, header, now = Date.now()) {
    const code = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    must(secretPattern.test(code),404,'pairing_not_found');
    return this.store.transaction(() => {
      const row = this.db.prepare('SELECT * FROM device_pairings WHERE id=? AND secret_hash=?').get(id,digest(code));
      must(row,404,'pairing_not_found');must(row.expires_at>now,410,'pairing_expired');
      must(row.status!=='rejected',403,'pairing_rejected');
      if(now-row.last_poll_at<INTERVAL*1000) return {status:'slow_down',interval_seconds:INTERVAL+2};
      this.db.prepare('UPDATE device_pairings SET last_poll_at=? WHERE id=?').run(now,id);
      if(row.status==='pending')return {status:'pending',interval_seconds:INTERVAL};
      const token = credentialToken(code,id);
      if(row.status==='approved') {
        this.store.addDevice(row.device_id,row.name);
        this.db.prepare('UPDATE devices SET token_hash=? WHERE id=?').run(digest(token),row.device_id);
        this.db.prepare('INSERT INTO device_encryption_keys(device_id,recipient,created_at) VALUES(?,?,?)').run(row.device_id,row.recipient,now);
        this.db.prepare("UPDATE device_pairings SET status='claimed',claimed_at=? WHERE id=?").run(now,id);
        this.log?.({event:'device_enrolled',device_id:row.device_id,name:row.name,actor:row.approved_by,created_at:now});
      } else {
        // A lost response can be retried, but rotation/deletion must win forever.
        const current = this.db.prepare('SELECT token_hash,active FROM devices WHERE id=?').get(row.device_id);
        must(current?.active===1 && current.token_hash===digest(token),410,'pairing_credential_retired');
      }
      return {status:'approved',credential:{credential_version:1,device_id:row.device_id,token}};
    });
  }
  sweep(now = Date.now()) {
    // Expired codes cannot be polled. Keep bounded recent rows for rate limiting;
    // system logs carry administrative history, never the secret device code.
    this.db.prepare('DELETE FROM device_pairings WHERE expires_at<?').run(now-86400_000);
  }
}
