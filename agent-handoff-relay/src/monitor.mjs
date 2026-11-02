import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { must } from './store.mjs';

const endpoint = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
export class Monitor {
  constructor(store) {
    this.store = store; this.db = store.db; this.active = new Map(); this.started = Date.now();
    // Additive extension: legacy schema-1 clients/CLI can still read the database.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS device_presence(device_id TEXT PRIMARY KEY,last_seen_at INTEGER NOT NULL,requests INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS agent_presence(device_id TEXT NOT NULL,adapter_id TEXT NOT NULL,profile_id TEXT NOT NULL,
        name TEXT NOT NULL,version TEXT NOT NULL DEFAULT '',source TEXT NOT NULL,last_seen_at INTEGER,
        PRIMARY KEY(device_id,adapter_id,profile_id));
      CREATE TABLE IF NOT EXISTS flow_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,created_at INTEGER NOT NULL,
        kind TEXT NOT NULL,device_id TEXT,peer_id TEXT,handoff_id TEXT,adapter_id TEXT,profile_id TEXT,
        bytes INTEGER NOT NULL DEFAULT 0,code TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS flow_events_time ON flow_events(created_at);
    `);
    this.db.prepare("INSERT OR IGNORE INTO monitor_meta(key,value) VALUES('started_at',?)").run(String(this.started));
    // Historical routes are evidence of intended destinations, not running agents.
    this.db.exec(`INSERT OR IGNORE INTO agent_presence(device_id,adapter_id,profile_id,name,source)
      SELECT DISTINCT recipient,adapter_id,profile_id,adapter_id,'route' FROM handoffs WHERE adapter_id!='generic'`);
    this.prune();
  }
  touch(device) {
    this.db.prepare(`INSERT INTO device_presence(device_id,last_seen_at,requests) VALUES(?,?,1)
      ON CONFLICT(device_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,requests=requests+1`).run(device, Date.now());
  }
  event(kind, data = {}) {
    this.db.prepare(`INSERT INTO flow_events(created_at,kind,device_id,peer_id,handoff_id,adapter_id,profile_id,bytes,code)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(Date.now(), kind, data.device ?? null, data.peer ?? null, data.handoff ?? null,
      data.adapter ?? null, data.profile ?? null, data.bytes ?? 0, data.code ?? '');
  }
  route(row) {
    if (row.adapter_id !== 'generic') this.db.prepare(`INSERT OR IGNORE INTO agent_presence(device_id,adapter_id,profile_id,name,source)
      VALUES(?,?,?,?,'route')`).run(row.recipient, row.adapter_id, row.profile_id, row.adapter_id);
  }
  heartbeat(device, data) {
    must(data && Object.keys(data).every(k => ['adapter_id','profile_id','name','version'].includes(k)), 400, 'unknown_field');
    const { adapter_id, profile_id = 'default', name = adapter_id, version = '' } = data;
    must(endpoint(adapter_id) && endpoint(profile_id), 400, 'invalid_agent_identifier');
    must(typeof name === 'string' && name.length > 0 && name.length <= 100 &&
      typeof version === 'string' && version.length <= 64, 400, 'invalid_agent_metadata');
    const old = this.db.prepare('SELECT source FROM agent_presence WHERE device_id=? AND adapter_id=? AND profile_id=?')
      .get(device, adapter_id, profile_id);
    must(old || this.db.prepare('SELECT COUNT(*) AS n FROM agent_presence WHERE device_id=?').get(device).n < 100,
      429, 'agent_registration_limit');
    const now = Date.now();
    this.db.prepare(`INSERT INTO agent_presence(device_id,adapter_id,profile_id,name,version,source,last_seen_at)
      VALUES(?,?,?,?,?,'heartbeat',?) ON CONFLICT(device_id,adapter_id,profile_id) DO UPDATE SET
      name=excluded.name,version=excluded.version,source='heartbeat',last_seen_at=excluded.last_seen_at`)
      .run(device, adapter_id, profile_id, name, version, now);
    if (old?.source !== 'heartbeat') this.event('agent_connected', { device, adapter: adapter_id, profile: profile_id });
    return { device_id: device, adapter_id, profile_id, last_seen_at: now, heartbeat_interval_seconds: 30 };
  }
  begin(direction, row, actor, total) {
    const transfer = { id: randomUUID(), direction, handoff_id: row.id, device_id: actor,
      sender: row.sender, recipient: row.recipient, total, bytes: 0, started_at: Date.now() };
    this.active.set(transfer.id, transfer); return transfer;
  }
  finish(transfer, kind, success = true) {
    this.active.delete(transfer.id);
    this.event(kind, { device: transfer.device_id, peer: transfer.direction === 'upload' ? transfer.recipient : transfer.sender,
      handoff: transfer.handoff_id, bytes: success || transfer.direction === 'download' ? transfer.bytes : 0 });
  }
  prune() {
    this.db.prepare('DELETE FROM flow_events WHERE created_at<?').run(Date.now() - 7 * 86400_000);
    this.db.exec('DELETE FROM flow_events WHERE seq < (SELECT COALESCE(MAX(seq),0)-20000 FROM flow_events)');
  }
  snapshot() {
    const now = Date.now();
    const devices = this.db.prepare(`SELECT d.id,d.name,d.active,d.created_at,p.last_seen_at,COALESCE(p.requests,0) AS requests
      FROM devices d LEFT JOIN device_presence p ON p.device_id=d.id ORDER BY d.created_at`).all();
    const agents = this.db.prepare(`SELECT a.*,d.name AS device_name,d.active AS device_active FROM agent_presence a
      JOIN devices d ON d.id=a.device_id ORDER BY a.last_seen_at DESC,a.device_id`).all();
    const transfers = this.db.prepare(`SELECT id,sender,recipient,adapter_id,profile_id,size,offset,status,receipt_state,created_at,ready_at,expires_at
      FROM handoffs ORDER BY seq DESC LIMIT 200`).all();
    const totals = this.db.prepare(`SELECT COUNT(*) AS handoffs,COALESCE(SUM(CASE WHEN released=0 THEN size ELSE 0 END),0) AS reserved_bytes,
      COALESCE(SUM(CASE WHEN status='uploading' THEN 1 ELSE 0 END),0) AS uploading,
      COALESCE(SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END),0) AS ready FROM handoffs`).get();
    totals.reserved_bytes=this.store.reservedBytes();
    const traffic = this.db.prepare(`SELECT CAST(created_at/60000 AS INTEGER)*60000 AS minute,
      SUM(CASE WHEN kind='upload_chunk' THEN bytes ELSE 0 END) AS uploaded,
      SUM(CASE WHEN kind IN ('download','download_aborted') THEN bytes ELSE 0 END) AS downloaded
      FROM flow_events WHERE created_at>=? GROUP BY minute ORDER BY minute`).all(now - 3600_000);
    const byteTotals = this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind='upload_chunk' THEN bytes ELSE 0 END),0) AS uploaded,
      COALESCE(SUM(CASE WHEN kind IN ('download','download_aborted') THEN bytes ELSE 0 END),0) AS downloaded
      FROM flow_events`).get();
    const events = this.db.prepare('SELECT * FROM flow_events ORDER BY seq DESC LIMIT 100').all();
    const disk = fs.statfsSync(this.store.root);
    return { now, telemetry_since: Number(this.db.prepare("SELECT value FROM monitor_meta WHERE key='started_at'").get().value),
      uptime_seconds: Math.floor((now - this.started)/1000), devices, agents, transfers, events, traffic,
      active_transfers: [...this.active.values()], totals: { ...totals, ...byteTotals,
        quota: this.store.quota, disk_available: disk.bavail * disk.bsize },
      retention: { days: 7, max_events: 20000 } };
  }
}
