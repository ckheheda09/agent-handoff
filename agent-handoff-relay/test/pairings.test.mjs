import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRelay } from '../src/server.mjs';
import { createAdmin,newAdminCredential } from '../src/admin.mjs';
const recipient='age1vs97lys2zllv3npfuvm7efuk2jxctvyjhsqvq8chfsrr7gz6vads2h3flq';
const input={name:'DSH 演示电脑',os:'linux x64',agents:['dsh'],recipient};
const origin='https://admin.test:17862';
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-pairing-')),logs=[];
  const auth=await newAdminCredential();let relay,admin,cookie='',csrf='';
  async function start(){
    relay=createRelay({data:root,log:x=>logs.push(x)});
    admin=createAdmin(relay,{credential:auth.credential,origin,relayURL:'https://relay.test:17861',log:x=>logs.push(x)});
    await Promise.all([relay.server,admin.server].map(s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve))));cookie='';csrf='';
  }
  await start();
  async function request(route,body,headers={},method=body===undefined?'GET':'POST',isAdmin=false){
    return fetch(`http://127.0.0.1:${(isAdmin?admin:relay).server.address().port}`+route,{method,headers:{...(isAdmin?{Cookie:cookie,Origin:origin,'X-CSRF-Token':csrf}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  }
  async function login(){const r=await request('/admin/api/login',{username:'admin',password:auth.password},{},'POST',true);cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await r.json()).csrf;}
  async function begin(){const r=await request('/v1/pairings',input);assert.equal(r.status,201);return r.json();}
  const f={root,logs,request,login,begin,get relay(){return relay;},
    async decision(p,action='approve',headers={},data={user_code:p.user_code}){return request(`/admin/api/pairings/${p.id}/${action}`,data,headers,'POST',true);},
    async poll(p){return request(`/v1/pairings/${p.id}/poll`,{},{Authorization:`Bearer ${p.device_code}`});},
    async restart(){await admin.close();await relay.close();await start();}};
  t.after(async()=>{await admin.close();await relay.close();fs.rmSync(root,{recursive:true,force:true});});return f;
}
test('pairing requires explicit admin approval, creates one credential/key and never publishes pairing secrets',async t=>{
  const f=await fixture(t),p=await f.begin();assert.equal(p.verification_uri,origin);
  assert.match(p.user_code,/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(f.relay.store.stats().devices.length,0);
  assert.equal((await f.poll(p)).status,200);
  assert.equal((await (await f.poll(p)).json()).status,'slow_down');
  assert.equal((await f.decision(p)).status,401);await f.login();
  assert.equal((await f.decision(p,'approve',{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await f.decision(p,'approve',{Origin:'https://evil.test'})).status,403);
  assert.equal((await f.decision(p,'approve',{}, {user_code:'WRNG-CODE'})).status,400);
  const before=await (await f.request('/admin/api/snapshot',undefined,{},'GET',true)).json();
  assert.equal(before.pairings[0].name,input.name);assert(!JSON.stringify(before).includes(p.device_code));assert(!JSON.stringify(before).includes(recipient));
  assert.equal((await f.decision(p)).status,200);assert.equal((await f.decision(p)).status,200);
  assert.equal((await f.decision(p,'reject')).status,409);
  assert.equal(f.relay.store.stats().devices.length,0);
  f.relay.store.db.prepare('UPDATE device_pairings SET last_poll_at=0 WHERE id=?').run(p.id);
  const claimed=await (await f.poll(p)).json();assert.equal(claimed.status,'approved');const c=claimed.credential;
  assert.equal((await f.request('/v1/me',undefined,{Authorization:`Bearer ${c.token}`})).status,200);
  assert.equal((await f.request('/v1/me',undefined,{Authorization:`Bearer ${p.device_code}`})).status,401);
  assert.equal(f.relay.store.stats().devices.length,1);
  assert.equal(f.relay.store.db.prepare('SELECT recipient FROM device_encryption_keys WHERE device_id=?').get(c.device_id).recipient,recipient);
  const database=JSON.stringify(f.relay.store.db.prepare('SELECT * FROM device_pairings').all());
  assert(!database.includes(c.token));assert(!database.includes(p.device_code));
  const snap=await (await f.request('/admin/api/snapshot',undefined,{},'GET',true)).json();assert.equal(snap.pairings.length,0);
  assert(!JSON.stringify(f.logs).includes(c.token));assert(!JSON.stringify(f.logs).includes(p.device_code));
  assert.equal(f.logs.filter(x=>x.event==='pairing_approved').length,1);assert.equal(f.logs.filter(x=>x.event==='device_enrolled').length,1);
  await f.restart();
  f.relay.store.db.prepare('UPDATE device_pairings SET last_poll_at=0 WHERE id=?').run(p.id);
  assert.equal((await (await f.poll(p)).json()).credential.token,c.token);
  f.relay.store.rotateDevice(c.device_id);
  f.relay.store.db.prepare('UPDATE device_pairings SET last_poll_at=0 WHERE id=?').run(p.id);
  assert.equal((await f.poll(p)).status,410);
  f.relay.store.deleteDevice(c.device_id);
  assert.equal((await f.poll(p)).status,410);assert.equal(f.relay.store.stats().devices.length,0);
});
test('rejected, expired and guessed pairings cannot obtain credentials, and pending approvals survive restart',async t=>{
  const f=await fixture(t);const p=await f.begin();await f.restart();await f.login();
  assert.equal(f.relay.pairings.list().length,1);
  assert.equal((await f.request(`/v1/pairings/${p.id}/poll`,{},{Authorization:'Bearer '+'x'.repeat(43)})).status,404);
  assert.equal((await f.decision(p,'reject')).status,200);assert.equal((await f.poll(p)).status,403);
  const expired=await f.begin();f.relay.store.db.prepare('UPDATE device_pairings SET expires_at=0 WHERE id=?').run(expired.id);
  assert.equal((await f.decision(expired)).status,410);assert.equal((await f.poll(expired)).status,410);
  assert.equal(f.relay.pairings.list().length,0);assert.equal(f.relay.store.stats().devices.length,0);
});
test('pairing validates metadata and public keys and bounds pending state and request frequency',async t=>{
  const f=await fixture(t);
  for(const invalid of [{...input,private_key:'must-never-be-sent'},{...input,recipient:'age1bad'},{...input,name:'bad\nname'},{...input,agents:['unknown']},{...input,os:'x'.repeat(81)}])assert.equal((await f.request('/v1/pairings',invalid)).status,400);
  for(let i=0;i<10;i++)f.relay.pairings.start(input,'same-source');
  assert.throws(()=>f.relay.pairings.start(input,'same-source'),{code:'pairing_rate_limit'});
  for(let i=0;i<90;i++)f.relay.pairings.start(input,'source-'+i);
  assert.throws(()=>f.relay.pairings.start(input,'last-source'),{code:'pairing_capacity'});
  f.relay.pairings.sweep(Date.now()+2*86400_000);assert.equal(f.relay.store.db.prepare('SELECT COUNT(*) AS n FROM device_pairings').get().n,0);
});
