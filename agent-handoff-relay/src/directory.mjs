import { must } from './store.mjs';

// Native age X25519 recipients are Bech32 values with a 32-byte payload.
export function validRecipient(value) {
  if (typeof value !== 'string' || !/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(value)) return false;
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data = [...value.slice(4)].map(c => alphabet.indexOf(c));
  let checksum = 1;
  for (const n of [3,3,3,0,1,7,5,...data]) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ n;
    [0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3].forEach((g,i) => { if ((top >>> i) & 1) checksum ^= g; });
  }
  return (checksum >>> 0) === 1 && (data[51] & 15) === 0;
}

export class Directory {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS device_encryption_keys(
      device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      recipient TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  }
  publish(device, input) {
    must(input && Object.keys(input).length === 1 && validRecipient(input.recipient), 400, 'invalid_age_recipient');
    return this.store.transaction(() => {
      const old = this.store.db.prepare('SELECT recipient FROM device_encryption_keys WHERE device_id=?').get(device);
      // An installer must reuse its identity. Replacing it would strand existing encrypted handoffs.
      must(!old || old.recipient === input.recipient, 409, 'encryption_key_conflict');
      this.store.db.prepare('INSERT OR IGNORE INTO device_encryption_keys VALUES(?,?,?)').run(device,input.recipient,Date.now());
      return { device_id: device, recipient: input.recipient };
    });
  }
  list() {
    const devices = this.store.db.prepare(`SELECT d.id,d.name,k.recipient FROM devices d
      LEFT JOIN device_encryption_keys k ON k.device_id=d.id WHERE d.active=1 ORDER BY d.created_at`).all();
    const agents = this.store.db.prepare(`SELECT a.device_id,a.adapter_id,a.profile_id,a.name,a.version,a.last_seen_at
      FROM agent_presence a JOIN devices d ON d.id=a.device_id WHERE d.active=1 AND a.source='heartbeat'`).all();
    return { devices: devices.map(d => ({ ...d, agents: agents.filter(a=>a.device_id===d.id) })) };
  }
}
