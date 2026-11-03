import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../agent-handoff-relay/src/server.mjs';
import { identity } from '../src/age.mjs';
import { makeClient } from '../src/client.mjs';
import { exec } from '../src/util.mjs';
import { publishSession,listSessions,resumeSession,syncPublishedSessions } from '../src/sessions.mjs';
const bin=process.env.TEST_AGE_BIN||(await exec(process.platform==='win32'?'where':'which',['age'])).stdout.trim().split(/\r?\n/)[0];
const keygen=process.env.TEST_AGE_KEYGEN||path.join(path.dirname(bin),'age-keygen');
async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-session-sync-'));
  const relay=createRelay({data:path.join(root,'relay')});
  await new Promise(resolve=>relay.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await relay.close();fs.rmSync(root,{recursive:true,force:true});});
  async function add(id){
    const token=relay.store.addDevice(id,id),home=path.join(root,id);
    const age=await identity(home,id,{bin,keygen});
    const c={device_id:id,token,profile:'test',runtime_agent:'hermes',agent_profile:'default',relay_url:`http://127.0.0.1:${relay.server.address().port}`,allow_loopback_http:true,age,state_dir:path.join(home,'state'),notifications:'off'};
    const client=makeClient(c);await client.json('/v1/me/encryption-key','POST',{recipient:age.recipient});return {c,client};
  }
  return {root,relay,add};
}

test('late devices get explicit pending status then full unchanged context after source sync; all readers can receive repeatedly',async t=>{
  const f=await fixture(t),a=await f.add('source');
  const input={id:'late-reader-session',title:'历史会话',context:'已完成的真实工作，不能在第二台设备接收后消失。',next_steps:'继续验证多设备接收。'};
  const sent=await publishSession(a.c,a.client,input);
  await resumeSession(a.c,a.client,{id:sent.id});
  const b=await f.add('later-reader');
  const pending=await listSessions(b.c,b.client);assert.equal(pending.items.length,1);assert.equal(pending.items[0].readable,false);
  assert.equal((await resumeSession(b.c,b.client,{id:sent.id})).status,'waiting_source_sync');
  const synced=await listSessions(a.c,a.client);assert.equal(synced.synchronization.synced,1);assert.deepEqual(synced.synchronization.errors,[]);
  const received=await resumeSession(b.c,b.client,{title:input.title});assert.equal(received.context,input.context);assert.equal(received.next_steps,input.next_steps);
  const c=await f.add('third-reader');
  const sync=await syncPublishedSessions(a.c,a.client);assert.equal(sync.synced,1);assert.deepEqual(sync.errors,[]);
  for(const reader of [a,b,c,b]){
    const got=await resumeSession({...reader.c,runtime_agent:'openai.desktop'},reader.client,{id:sent.id});
    assert.equal(got.status,'received');assert.equal(got.context,input.context);assert.equal(got.source.agent,'hermes');
  }
  assert.equal((await listSessions(c.c,c.client)).items[0].receive_state,'received');
  assert.equal((await listSessions(a.c,a.client)).synchronization.synced,0);
  assert.equal((await publishSession(a.c,a.client,input)).id,sent.id);
  assert.equal(f.relay.store.db.prepare('SELECT count(*) AS n FROM shared_sessions').get().n,1);
  assert.equal(fs.readdirSync(a.c.state_dir).some(n=>n.startsWith('.session-sync-')),false);
});

test('legacy reader records are upgraded; revoked readers lose server access without blocking new readers',async t=>{
  const f=await fixture(t),a=await f.add('a'),b=await f.add('b');
  const sent=await publishSession(a.c,a.client,{id:'legacy-readers',title:'旧会话',context:'旧版客户端上传的会话摘要',next_steps:'保留原会话编号'});
  f.relay.store.db.prepare('UPDATE session_readers SET recipient=NULL').run();
  assert.equal((await syncPublishedSessions(a.c,a.client)).synced,1);
  await resumeSession(b.c,b.client,{id:sent.id});f.relay.store.deleteDevice('b','test');
  const c=await f.add('c');assert.equal((await syncPublishedSessions(a.c,a.client)).synced,1);
  assert.equal((await resumeSession(c.c,c.client,{id:sent.id})).context,'旧版客户端上传的会话摘要');
  await assert.rejects(resumeSession(b.c,b.client,{id:sent.id}),/401/);
  assert.deepEqual(f.relay.store.db.prepare('SELECT device_id FROM session_readers ORDER BY device_id').all().map(r=>r.device_id),['a','c']);
});

test('failed synchronization is visible and retains original ciphertext and local cleanup',async t=>{
  const f=await fixture(t),a=await f.add('a');
  const sent=await publishSession(a.c,a.client,{id:'failed-sync',title:'同步失败可重试',context:'正文保留',next_steps:'恢复后重试'});
  await f.add('b');const original=f.relay.sessions.get('a',sent.id,true);
  const failing={json:(route,...args)=>route.endsWith('/readers')?Promise.reject(new Error('simulated lost connection')):a.client.json(route,...args)};
  const result=await listSessions(a.c,failing);assert.equal(result.synchronization.errors.length,1);
  assert.equal(f.relay.sessions.get('a',sent.id,true).sha256,original.sha256);
  assert.equal(fs.readdirSync(a.c.state_dir).some(n=>n.startsWith('.session-sync-')),false);
  assert.equal((await syncPublishedSessions(a.c,a.client)).synced,1);
});

test('packaged MCP startup synchronizes historical access for later devices without a receive or publish action',async t=>{
  const f=await fixture(t),a=await f.add('publisher');
  const sent=await publishSession(a.c,a.client,{id:'mcp-startup-sync',title:'启动时同步',context:'原文必须保留',next_steps:'另一台设备接收'});
  const b=await f.add('later');
  const config=path.join(f.root,'mcp-profile.json');fs.writeFileSync(config,JSON.stringify({...a.c,config_version:1}),{mode:0o600});
  const runtime=fileURLToPath(new URL('../dist/cli.mjs',import.meta.url));
  const client=new Client({name:'session-sync-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[runtime,'mcp','--config',config,'--agent','openai.desktop','--agent-profile','default'],stderr:'pipe'});
  try{
    await client.connect(transport);
    for(let n=0;n<100 && !f.relay.sessions.get('later',sent.id).readable;n++)await new Promise(r=>setTimeout(r,20));
    assert.equal(f.relay.sessions.get('later',sent.id).readable,true);
    const tools=(await client.listTools()).tools;
    assert.equal(tools.find(t=>t.name==='handoff_sessions').annotations.readOnlyHint,false);
    const got=await resumeSession(b.c,b.client,{id:sent.id});assert.equal(got.context,'原文必须保留');
  }finally{await client.close();}
});
