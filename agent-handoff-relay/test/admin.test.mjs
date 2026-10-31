import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createRelay } from '../src/server.mjs';
import { createAdmin, newAdminCredential } from '../src/admin.mjs';
import { AGE_MAGIC, digest, Store } from '../src/store.mjs';
const origin = 'https://relay.test:17862';
test('installer assets use a public exact allowlist and the Agent guide advertises the real installer',async t=>{
  const f=await fixture(t, {downloads:true});
  const packageResponse=await f.request('/downloads/agent-handoff-connect-0.3.0.tgz');assert.equal(packageResponse.status,200);
  assert.equal(packageResponse.headers.get('content-type'),'application/octet-stream');const bytes=Buffer.from(await packageResponse.arrayBuffer());assert.deepEqual([...bytes.subarray(0,2)],[31,139]);
  assert.equal((await f.request('/downloads/relay-ca.crt')).status,200);assert.equal((await f.request('/downloads/INSTALL.md')).status,200);
  assert.equal((await f.request('/downloads/admin-auth.json')).status,401);
  const page=await (await f.request('/')).text();assert(page.includes('安装多端 Agent 插件'));assert(!page.includes('自动插件仍需接入'));
  const js=await (await f.request('/app.js')).text();assert(js.includes('npx --yes --cafile'));assert(!js.includes('while true'));
});
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'relay-admin-'));
  const downloadsDir = path.join(root, 'downloads');
  fs.mkdirSync(downloadsDir);
  if (options.downloads) {
    fs.writeFileSync(path.join(downloadsDir, 'agent-handoff-connect-0.3.0.tgz'), gzipSync('test-only installer fixture'));
    fs.writeFileSync(path.join(downloadsDir, 'relay-ca.crt'), 'test-only public CA asset');
    fs.writeFileSync(path.join(downloadsDir, 'INSTALL.md'), '# Test installation guide\n');
  }
  const relay = createRelay({data:root}); const a = relay.store.addDevice('a','Mac'), b = relay.store.addDevice('b','Linux');
  const auth = await newAdminCredential();
  const admin = createAdmin(relay,{credential:auth.credential,origin,relayURL:'https://relay.test:17861',downloadsDir});
  await Promise.all([relay.server,admin.server].map(s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve))));
  let cookie = '', csrf = '';
  const base = `http://127.0.0.1:${admin.server.address().port}`;
  async function request(route,body,headers = {}) { return fetch(base+route,{method:body === undefined ? 'GET':'POST',headers:{Cookie:cookie,Origin:origin,'X-CSRF-Token':csrf,...(body === undefined ? {} : {'Content-Type':'application/json'}),...headers},body:body === undefined ? undefined:JSON.stringify(body)}); }
  async function login() { const r = await request('/admin/api/login',{username:'admin',password:auth.password}); cookie = r.headers.get('set-cookie').split(';')[0]; csrf = (await r.json()).csrf; return cookie; }
  async function api(who,route,method='GET',body,extra={}) { return fetch(`http://127.0.0.1:${relay.server.address().port}`+route,{method,headers:{Authorization:`Bearer ${who === 'a' ? a : who === 'b' ? b : who}`, ...(body === undefined ? {} : {'Content-Type':'application/json'}),...extra},body:body === undefined ? undefined:JSON.stringify(body)}); }
  t.after(async()=>{ await admin.close(); await relay.close(); fs.rmSync(root,{recursive:true,force:true}); });
  return {relay,admin,root,request,login,api,auth,base};
}
test('admin sessions, hardened assets, origin/CSRF and logout',async t=>{
  const f = await fixture(t);
  assert.equal((await f.request('/admin/api/snapshot')).status,401);
  assert.equal((await f.request('/downloads/agent-handoff-connect-0.3.0.tgz')).status,401);
  const page = await f.request('/'); assert.equal(page.status,200); assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
  assert.equal((await f.request('/admin/api/login',{username:'admin',password:f.auth.password},{Origin:'https://evil.test'})).status,403);
  const login = await f.request('/admin/api/login',{username:'admin',password:f.auth.password}); const cookie = login.headers.get('set-cookie');
  for(const attr of ['HttpOnly','Secure','SameSite=Strict','Path=/']) assert.ok(cookie.includes(attr));
  await f.login();
  assert.equal((await f.request('/admin/api/devices',{id:'x',name:'X'},{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await f.request('/admin/api/devices',{id:'x',name:'X'},{Origin:'https://evil.test'})).status,403);
  const snap = await (await f.request('/admin/api/snapshot')).text(); assert.ok(!snap.includes('token')); assert.ok(!snap.includes(f.auth.credential.hash));
  assert.equal((await f.request('/admin/api/logout',{})).status,200);
  assert.equal((await f.request('/admin/api/snapshot')).status,401);
});
test('device creation, rotation and revocation use separate credentials',async t=>{
  const f = await fixture(t); await f.login();
  const created = await f.request('/admin/api/devices',{id:'new',name:'New laptop'}); assert.equal(created.status,201); const first = await created.json();
  assert.equal((await f.api(first.token,'/v1/me')).status,200);
  const second = await (await f.request('/admin/api/devices/new/rotate',{})).json(); assert.notEqual(first.token,second.token);
  assert.equal((await f.api(first.token,'/v1/me')).status,401); assert.equal((await f.api(second.token,'/v1/me')).status,200);
  assert.equal((await f.request('/admin/api/devices/new/revoke',{})).status,200);
  assert.equal((await f.api(second.token,'/v1/me')).status,401); assert.equal((await f.api('a','/v1/me')).status,200);
});
test('login limits reject repeated bad credentials',async t=>{
  const f = await fixture(t);
  for(let i=0;i<10;i++) assert.equal((await f.request('/admin/api/login',{username:'admin',password:'wrong'})).status,401);
  assert.equal((await f.request('/admin/api/login',{username:'admin',password:f.auth.password})).status,429);
});
test('route identities do not imply heartbeat, authenticated identity cannot be spoofed',async t=>{
  const f = await fixture(t); const data = Buffer.concat([AGE_MAGIC,Buffer.from('fixture')]);
  await f.api('a','/v1/handoffs','POST',{id:'route',recipient:'b',adapter_id:'hermes.desktop',size:data.length,sha256:digest(data),payload_format:'age-v1'});
  let snap = f.relay.monitor.snapshot(); assert.equal(snap.agents[0].source,'route'); assert.equal(snap.agents[0].last_seen_at,null);
  assert.equal((await f.api('b','/v1/agents/heartbeat','POST',{adapter_id:'hermes.desktop',device_id:'a'})).status,400);
  assert.equal((await f.api('b','/v1/agents/heartbeat','POST',{adapter_id:'hermes.desktop',name:'Actual Agent',version:'1'})).status,200);
  snap = f.relay.monitor.snapshot(); assert.equal(snap.agents[0].device_id,'b'); assert.equal(snap.agents[0].source,'heartbeat'); assert.ok(snap.agents[0].last_seen_at);
  assert.equal(snap.devices.find(d=>d.id === 'b').requests,2);
  assert.equal((await f.api('invalid','/v1/agents/heartbeat','POST',{adapter_id:'test'})).status,401);
});
test('upload/download totals, receipt idempotency and safe detail metadata',async t=>{
  const f = await fixture(t); await f.login(); const data = Buffer.concat([AGE_MAGIC,Buffer.from('telemetry-fixture')]);
  await f.api('a','/v1/handoffs','POST',{id:'flow',recipient:'b',size:data.length,sha256:digest(data),payload_format:'age-v1'});
  const upload = await fetch(`http://127.0.0.1:${f.relay.server.address().port}/v1/handoffs/flow/payload`,{method:'PATCH',headers:{Authorization:`Bearer ${f.relay.store.rotateDevice('a')}`,'Content-Type':'application/octet-stream','Upload-Offset':'0'},body:data}); assert.equal(upload.status,200);
  // Rotation here affects only the isolated test fixture.
  const token = f.relay.store.rotateDevice('a');
  assert.equal((await f.api(token,'/v1/handoffs/flow/commit','POST',{})).status,200);
  const download = await f.api('b','/v1/handoffs/flow/payload'); assert.deepEqual(Buffer.from(await download.arrayBuffer()),data);
  for(let i=0;i<2;i++) assert.equal((await f.api('b','/v1/handoffs/flow/receipts','POST',{request_id:'r1',state:'verified'})).status,200);
  const snap = f.relay.monitor.snapshot(); assert.equal(snap.totals.uploaded,data.length); assert.equal(snap.totals.downloaded,data.length); assert.equal(snap.active_transfers.length,0);
  assert.equal(snap.events.filter(e=>e.kind === 'receipt').length,1);
  const detail = await (await f.request('/admin/api/handoffs/flow')).json(); assert.equal(detail.receipts.length,1); assert.equal(detail.receipt_state,'verified'); assert.ok(!('sha256' in detail));
  assert.equal((await f.request('/admin/api/handoffs/missing')).status,404);
});
test('monitor survives restart, keeps schema compatibility, prunes old telemetry',async t=>{
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'relay-monitor-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const legacy = new Store(root); legacy.addDevice('legacy','Old device'); legacy.close();
  let relay = createRelay({data:root}); relay.monitor.heartbeat('legacy',{adapter_id:'test.agent'}); relay.monitor.event('old');
  relay.store.db.prepare('UPDATE flow_events SET created_at=?').run(Date.now()-8*86400_000); relay.monitor.prune(); assert.equal(relay.monitor.snapshot().events.length,0);
  assert.equal(relay.store.db.prepare('PRAGMA user_version').get().user_version,1); await relay.close();
  relay = createRelay({data:root}); assert.equal(relay.monitor.snapshot().agents[0].adapter_id,'test.agent'); await relay.close();
  const olderCLI = new Store(root); assert.equal(olderCLI.stats().devices.length,1); olderCLI.close();
});
test('in-flight upload exposes received bytes before a chunk is acknowledged',async t=>{
  const f = await fixture(t);const data=Buffer.concat([AGE_MAGIC,Buffer.alloc(128*1024)]);
  await f.api('a','/v1/handoffs','POST',{id:'progress',recipient:'b',size:data.length,sha256:digest(data),payload_format:'age-v1'});
  const token=f.relay.store.rotateDevice('a');
  let request;
  const done=new Promise((resolve,reject)=>{
    request=http.request({host:'127.0.0.1',port:f.relay.server.address().port,path:'/v1/handoffs/progress/payload',method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream','Content-Length':data.length,'Upload-Offset':'0'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});request.on('error',reject);
  });
  request.write(data.subarray(0,4096));
  for(let i=0;i<40 && !f.relay.monitor.snapshot().active_transfers[0]?.bytes;i++) await new Promise(r=>setTimeout(r,10));
  const transfer=f.relay.monitor.snapshot().active_transfers[0];
  try {assert.equal(transfer.direction,'upload');assert.equal(transfer.bytes,4096);assert.equal(transfer.total,data.length);assert.equal(f.relay.store.get('progress').offset,0);}
  finally {request.end(data.subarray(4096));}
  assert.equal(await done,200);assert.equal(f.relay.monitor.snapshot().active_transfers.length,0);assert.equal(f.relay.monitor.snapshot().totals.uploaded,data.length);
});
