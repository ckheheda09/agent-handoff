import { createHash } from 'node:crypto';
import { must, validID, AGE_MAGIC } from './store.mjs';

export const SESSION_LIMIT = 3 * 1024 ** 2;
export class Sessions {
  constructor(store) { this.store = store; this.db = store.db; }
  get(device, id, payload = false) {
    const row = this.db.prepare(`SELECT s.*,d.name AS source_name,r.state AS receive_state,a.device_id AS reader_device
      FROM shared_sessions s LEFT JOIN session_readers a ON a.session_id=s.id AND a.device_id=?
      JOIN devices d ON d.id=s.sender LEFT JOIN session_reads r ON r.session_id=s.id AND r.device_id=?
      WHERE s.id=? AND s.expires_at>? AND s.payload IS NOT NULL`).get(device,device,id,Date.now());
    must(row,404,'session_not_found');
    must(!payload || row.reader_device,409,'session_sync_required');
    const {payload:bytes,fingerprint,reader_device,...meta}=row;
    const readable=!!reader_device;
    const readers=device===row.sender?this.db.prepare('SELECT device_id,recipient FROM session_readers WHERE session_id=? ORDER BY device_id').all(id).sort((a,b)=>a.device_id.localeCompare(b.device_id)):undefined;
    return {...meta,readable,access_state:readable?'readable':'waiting_source_sync',...(readers?{readers}:{}),...(payload?{payload:Buffer.from(bytes).toString('base64')}:{} )};
  }
  list(device, after, limit) {
    return this.db.prepare(`SELECT s.seq AS cursor,s.id,s.title,s.sender,d.name AS source_name,s.source_agent,
      s.created_at,s.expires_at,s.size,s.sha256,COALESCE(r.state,'available') AS receive_state,a.device_id AS reader_device
      FROM shared_sessions s LEFT JOIN session_readers a ON a.session_id=s.id AND a.device_id=?
      JOIN devices d ON d.id=s.sender LEFT JOIN session_reads r ON r.session_id=s.id AND r.device_id=?
      WHERE s.seq>? AND s.expires_at>? AND s.payload IS NOT NULL ORDER BY s.seq LIMIT ?`).all(device,device,after,Date.now(),limit).map(({reader_device,...row})=>({...row,readable:!!reader_device,
        access_state:reader_device?'readable':'waiting_source_sync',
        ...(row.sender===device?{readers:this.db.prepare('SELECT device_id,recipient FROM session_readers WHERE session_id=? ORDER BY device_id').all(row.id).sort((a,b)=>a.device_id.localeCompare(b.device_id))}:{})}));
  }
  publish(device, data) {
    const fields=['id','title','source_agent','readers','payload','sha256'];
    must(Object.keys(data).every(k=>fields.includes(k)),400,'unknown_field');
    must(validID(data.id) && typeof data.title==='string' && data.title.trim().length>0 && Buffer.byteLength(data.title)<=500 && !/[\x00-\x1f\x7f]/.test(data.title),400,'invalid_session_title');
    must(typeof data.source_agent==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(data.source_agent),400,'invalid_agent');
    must(Array.isArray(data.readers) && data.readers.length>0 && data.readers.length<=100,400,'invalid_session_readers');
    const readers=[...data.readers].sort((a,b)=>String(a?.device_id).localeCompare(String(b?.device_id)));
    must(readers.every(r=>r && Object.keys(r).length===2 && validID(r.device_id) && typeof r.recipient==='string') && new Set(readers.map(r=>r.device_id)).size===readers.length && readers.some(r=>r.device_id===device),400,'invalid_session_readers');
    must(typeof data.payload==='string' && data.payload.length<=SESSION_LIMIT*4/3+4,413,'session_size_limit');
    const payload=Buffer.from(data.payload,'base64');
    must(payload.length>=AGE_MAGIC.length && payload.length<=SESSION_LIMIT && payload.toString('base64')===data.payload && payload.subarray(0,AGE_MAGIC.length).equals(AGE_MAGIC),400,'encrypted_age_payload_required');
    const sha256=createHash('sha256').update(payload).digest('hex');must(data.sha256===sha256,422,'checksum_mismatch');
    const fingerprint=createHash('sha256').update(JSON.stringify({title:data.title,source_agent:data.source_agent,readers,sha256})).digest('hex');
    return this.store.transaction(()=>{
      const old=this.db.prepare('SELECT sender,fingerprint FROM shared_sessions WHERE id=?').get(data.id);
      if(old){must(old.sender===device && old.fingerprint===fingerprint,409,'session_idempotency_conflict');return this.get(device,data.id);}
      for(const r of readers) must(this.db.prepare(`SELECT d.id FROM devices d JOIN device_encryption_keys k ON k.device_id=d.id
        WHERE d.id=? AND d.active=1 AND k.recipient=?`).get(r.device_id,r.recipient),409,'session_reader_changed');
      this.sweep();
      must(this.store.reservedBytes()+payload.length<=this.store.quota,507,'storage_quota_exceeded');
      const now=Date.now();
      this.db.prepare(`INSERT INTO shared_sessions(id,sender,title,source_agent,size,sha256,fingerprint,payload,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(data.id,device,data.title,data.source_agent,payload.length,sha256,fingerprint,payload,now,now+this.store.ttl);
      const add=this.db.prepare('INSERT INTO session_readers(session_id,device_id,recipient) VALUES(?,?,?)');
      for(const r of readers)add.run(data.id,r.device_id,r.recipient);
      return this.get(device,data.id);
    });
  }
  syncReaders(device,id,data) {
    must(Object.keys(data).every(k=>['readers','payload','sha256','previous_sha256'].includes(k)),400,'unknown_field');
    must(typeof data.previous_sha256==='string' && /^[a-f0-9]{64}$/.test(data.previous_sha256),400,'invalid_previous_checksum');
    must(Array.isArray(data.readers) && data.readers.length>0 && data.readers.length<=100,400,'invalid_session_readers');
    const readers=[...data.readers].sort((a,b)=>String(a?.device_id).localeCompare(String(b?.device_id)));
    must(readers.every(r=>r && Object.keys(r).length===2 && validID(r.device_id) && typeof r.recipient==='string') && new Set(readers.map(r=>r.device_id)).size===readers.length && readers.some(r=>r.device_id===device),400,'invalid_session_readers');
    must(typeof data.payload==='string' && data.payload.length<=SESSION_LIMIT*4/3+4,413,'session_size_limit');
    const payload=Buffer.from(data.payload,'base64');
    must(payload.length>=AGE_MAGIC.length && payload.length<=SESSION_LIMIT && payload.toString('base64')===data.payload && payload.subarray(0,AGE_MAGIC.length).equals(AGE_MAGIC),400,'encrypted_age_payload_required');
    const sha256=createHash('sha256').update(payload).digest('hex');must(data.sha256===sha256,422,'checksum_mismatch');
    return this.store.transaction(()=>{
      const row=this.get(device,id);must(row.sender===device,403,'session_sender_only');
      for(const r of readers)must(this.db.prepare(`SELECT d.id FROM devices d JOIN device_encryption_keys k ON k.device_id=d.id
        WHERE d.id=? AND d.active=1 AND k.recipient=?`).get(r.device_id,r.recipient),409,'session_reader_changed');
      const activeReaders=this.db.prepare(`SELECT a.device_id FROM session_readers a JOIN devices d ON d.id=a.device_id WHERE a.session_id=? AND d.active=1`).all(id);
      must(activeReaders.every(r=>readers.some(n=>n.device_id===r.device_id)),409,'session_reader_removed');
      if(row.sha256===sha256 && JSON.stringify(row.readers)===JSON.stringify(readers))return {...row,status:'synced'};
      must(row.sha256===data.previous_sha256,409,'session_payload_changed');
      must(this.store.reservedBytes()-row.size+payload.length<=this.store.quota,507,'storage_quota_exceeded');
      this.db.prepare('UPDATE shared_sessions SET payload=?,size=?,sha256=? WHERE id=?').run(payload,payload.length,sha256,id);
      this.db.prepare('DELETE FROM session_readers WHERE session_id=?').run(id);
      const add=this.db.prepare('INSERT INTO session_readers(session_id,device_id,recipient) VALUES(?,?,?)');
      for(const r of readers)add.run(id,r.device_id,r.recipient);
      return {...this.get(device,id),status:'synced'};
    });
  }
  received(device,id) {
    must(this.get(device,id).readable,409,'session_sync_required');
    this.db.prepare(`INSERT INTO session_reads(session_id,device_id,state,received_at) VALUES(?,?,'received',?)
      ON CONFLICT(session_id,device_id) DO NOTHING`).run(id,device,Date.now());
    return {id,state:'received',evidence:'recipient_device_reported'};
  }
  sweep(now=Date.now()) {return this.db.prepare('UPDATE shared_sessions SET payload=NULL WHERE expires_at<=? AND payload IS NOT NULL').run(now).changes;}
}
