import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRelay } from '../../agent-handoff-relay/src/server.mjs';
import { validRecipient } from '../../agent-handoff-relay/src/directory.mjs';
import { install, doctor, uninstall } from '../src/install.mjs';
import { spec, editConfig, applyAdapters } from '../src/adapters.mjs';
import { makeClient } from '../src/client.mjs';
import { loadConfig, exec, sha, shaFile } from '../src/util.mjs';
import { ensureAge, identity, encrypt } from '../src/age.mjs';
import { collect, unpack, sendHandoff, receiveHandoff } from '../src/handoff.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ageBin=process.env.TEST_AGE_BIN||(await exec(process.platform==='win32'?'where':'which',['age'])).stdout.trim().split(/\r?\n/)[0];
const keygen=process.env.TEST_AGE_KEYGEN||path.join(path.dirname(ageBin),'age-keygen');
const age={bin:ageBin,keygen};
async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-connect-test-'));const relay=createRelay({data:path.join(root,'relay')});
  await new Promise(resolve=>relay.server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${relay.server.address().port}`;
  const credentials={};for(const d of ['a','b','c']){const token=relay.store.addDevice(d,d);const file=path.join(root,d+'-credential.json');fs.writeFileSync(file,JSON.stringify({device_id:d,token,relay_url:url}),{mode:0o600});credentials[d]=file;}
  t.after(async()=>{await relay.close();fs.rmSync(root,{recursive:true,force:true});});
  const f={root,relay,url,credentials,async setup(device,agents=[]){const workspace=path.join(root,'workspace-'+device);fs.mkdirSync(workspace,{recursive:true});
    const options={home:path.join(root,'bridge-'+device),profile:'default',agents,notifications:'off',credentials:credentials[device],relay:url,allowHTTP:true,workspace,ageBin,ageKeygen:keygen,bundle:path.join(project,'dist','cli.mjs'),agentHome:path.join(root,'agent-home-'+device)};
    const result=await install(options);return {options,result,c:loadConfig(result.config)};}};
  return f;
}
async function mcp(t,c,adapter){const client=new Client({name:'integration-test',version:'1.0.0'});const transport=new StdioClientTransport({command:process.execPath,args:[c.runtime,'mcp','--config',path.join(path.dirname(path.dirname(c.state_dir)),'profiles','default.json'),'--agent',adapter,'--agent-profile','default'],stderr:'pipe'});
  const notifications=[];client.setNotificationHandler(LoggingMessageNotificationSchema,notice=>{notifications.push(notice);});
  let stderr='';transport.stderr.on('data',b=>{stderr+=b;});await client.connect(transport);t.after(()=>client.close());
  return {client,notifications,get stderr(){return stderr;},async call(name,args={}){const r=await client.callTool({name,arguments:args},undefined,{timeout:60000});assert.equal(r.isError,undefined,r.content?.[0]?.text);return JSON.parse(r.content[0].text);}};
}

test('public key directory authenticates, validates checksums, prevents replacement and hides revoked devices',async t=>{
  const f=await fixture(t),a=await f.setup('a'),b=await f.setup('b');const client=makeClient(a.c);
  assert(validRecipient(a.c.age.recipient));assert(!validRecipient(a.c.age.recipient.slice(0,-1)+(a.c.age.recipient.endsWith('q')?'p':'q')));
  assert.equal((await client.json('/v1/devices')).devices.length,3);
  await assert.rejects(client.json('/v1/me/encryption-key','POST',{recipient:b.c.age.recipient}),/encryption_key_conflict/);
  await assert.rejects(client.json('/v1/me/encryption-key','POST',{recipient:a.c.age.recipient,device_id:'b'}),/invalid_age_recipient/);
  const unauth=await fetch(f.url+'/v1/devices');assert.equal(unauth.status,401);
  f.relay.store.revokeDevice('b');assert(!(await client.json('/v1/devices')).devices.some(d=>d.id==='b'));
  await assert.rejects(makeClient(b.c).json('/v1/me'),/401/);
});

test('Agent config merge, idempotent reinstall, private backups, changing selection and uninstall preserve unrelated settings',async t=>{
  const f=await fixture(t);const home=path.join(f.root,'agent-home-a');fs.mkdirSync(path.join(home,'.dsh','profiles','desktop'),{recursive:true});fs.mkdirSync(path.join(home,'.hermes'),{recursive:true});fs.mkdirSync(path.join(home,'.codex'),{recursive:true});
  const dsh=path.join(home,'.dsh','profiles','desktop','cordis.patch.yml');fs.writeFileSync(dsh,'# keep-js\n- insert:\n    - id: other\n      name: other-plugin\n      config:\n        cwd: !!js process.cwd()\n');
  const hermes=path.join(home,'.hermes','config.yaml');fs.writeFileSync(hermes,'# keep-hermes\nmodel: example\nmcp_servers:\n  other:\n    command: other\n');
  const openai=path.join(home,'.codex','config.toml');fs.writeFileSync(openai,'# keep-openai\nmodel = "example"\n[mcp_servers.other]\ncommand = "other"\n');
  const a=await f.setup('a',['dsh','hermes','openai']);assert.equal(a.c.installed.length,3);assert((await doctor(a.c)).ok);
  const key=fs.readFileSync(a.c.age.identity,'utf8');const result=await install(a.options);const again=loadConfig(result.config);assert.equal(fs.readFileSync(again.age.identity,'utf8'),key);
  assert.equal((fs.readFileSync(openai,'utf8').match(/\[mcp_servers.agent_handoff\]/g)||[]).length,1);
  assert(fs.readFileSync(dsh,'utf8').includes('!!js process.cwd()'));assert(fs.readFileSync(hermes,'utf8').includes('# keep-hermes'));
  assert(result.changes.every(c=>c.backup));if(process.platform!=='win32')for(const change of result.changes)assert.equal(fs.statSync(change.backup).mode&0o777,0o600);
  const fewer=await install({...a.options,agents:['hermes']});assert(!fs.readFileSync(openai,'utf8').includes('[mcp_servers.agent_handoff]'));assert(fs.readFileSync(openai,'utf8').includes('[mcp_servers.other]'));
  await uninstall(a.options.home,fewer.config,loadConfig(fewer.config));assert(!fs.readFileSync(hermes,'utf8').includes('agent_handoff'));assert(fs.existsSync(a.c.age.identity));
});

test('installer refuses modified/colliding config and plans all edits before mutation; Windows paths survive serialization',async t=>{
  const f=await fixture(t);const a=await f.setup('a',['openai']);const file=a.c.installed[0].file;const original=fs.readFileSync(file,'utf8');
  fs.writeFileSync(file,original.replace('enabled = true','enabled = false'));await assert.rejects(install(a.options),/modified/);assert(fs.readFileSync(file,'utf8').includes('enabled = false'));
  const bad=path.join(f.root,'bad.yaml');fs.writeFileSync(bad,'[invalid:');
  const next=path.join(f.root,'fresh.toml');const s1=spec({agent:'openai',profile:'test',file:next,runtime:'C:\\Program Files\\Agent Handoff\\cli.mjs',config:'C:\\Users\\甲\\config.json',workspace:'C:\\work',node:'C:\\Program Files\\nodejs\\node.exe'});
  const output=editConfig('',s1);assert(output.includes('C:\\\\Program Files\\\\nodejs\\\\node.exe'));assert.equal(editConfig(output,s1,s1),output);
  await assert.rejects(applyAdapters([s1,spec({agent:'hermes',profile:'test',file:bad,runtime:'runtime',config:'cfg',workspace:'work'})]),/invalid/);assert(!fs.existsSync(next));
});

test('two actual MCP stdio clients discover tools, report heartbeats, transfer encrypted binary artifacts, resume and record truthful receipts',async t=>{
  const f=await fixture(t),a=await f.setup('a',['dsh']),b=await f.setup('b',['openai']);
  const alice=await mcp(t,a.c,'deepseek.harness'),bob=await mcp(t,b.c,'openai.desktop');
  assert.deepEqual((await alice.client.listTools()).tools.map(t=>t.name).sort(),['handoff','handoff_connection','handoff_devices','handoff_inbox','handoff_outbox','handoff_status','handoff_send','handoff_receive','handoff_receipt','handoff_cancel'].sort());
  assert.equal((await alice.call('handoff_connection')).device.device_id,'a');
  const peers=await alice.call('handoff_devices');assert(peers.devices.find(d=>d.id==='b').recipient);
  const bytes=randomBytes(1024*1024+17);const longName='实际产物'.repeat(10)+'.bin';fs.mkdirSync(path.join(a.c.workspace,'output'));fs.writeFileSync(path.join(a.c.workspace,'output',longName),bytes);fs.writeFileSync(path.join(a.c.workspace,'output','.env'),'MUST_NOT_SEND');
  const input={id:'real-roundtrip',to:'b',adapter:'openai.desktop',title:'Continue analysis',context:'User asked for a binary report. The exact artifact is attached.',next_steps:'Read the attached artifact and continue the task.',files:['./output/']};
  const sent=await alice.call('handoff_send',input);assert.equal(sent.status,'ready');assert.equal(sent.files,1);
  const cipher=f.relay.store.payloadPath(sent.id);assert(!fs.readFileSync(cipher).includes(Buffer.from('Continue analysis')));
  const hash=await shaFile(cipher);await alice.call('handoff_send',input);assert.equal(await shaFile(cipher),hash);
  assert.equal((await bob.call('handoff_inbox')).items[0].id,sent.id);
  const early=await bob.client.callTool({name:'handoff_receipt',arguments:{id:sent.id,state:'completed',code:'premature'}});assert.equal(early.isError,true);
  const received=await bob.call('handoff_receive',{id:sent.id});assert.equal(received.files.length,1);assert.equal(path.basename(received.files[0].path),longName);assert.deepEqual(fs.readFileSync(received.files[0].path),bytes);
  assert.equal((await alice.call('handoff_status',{id:sent.id})).receipt_state,'verified');
  assert.equal((await bob.call('handoff_receive',{id:sent.id})).directory,received.directory);
  for(const state of ['accepted','started','completed'])await bob.call('handoff_receipt',{id:sent.id,state,code:'test_'+state,request_id:'receipt_'+state});
  assert.equal((await alice.call('handoff_status',{id:sent.id})).receipt_state,'completed');
  const agents=f.relay.monitor.snapshot().agents;assert(agents.some(x=>x.device_id==='a'&&x.adapter_id==='deepseek.harness'&&x.source==='heartbeat'));assert(agents.some(x=>x.device_id==='b'&&x.adapter_id==='openai.desktop'));
  assert(!alice.stderr.includes(a.c.token)&&!bob.stderr.includes(b.c.token));
  const changed=await alice.client.callTool({name:'handoff_send',arguments:{...input,context:'different content'}});assert.equal(changed.isError,true);assert(changed.content[0].text.includes('different content'));
});

test('workspace guards reject traversal, credentials, symlinks and filesystem collisions; receive enforces target Agent',async t=>{
  const f=await fixture(t),a=await f.setup('a'),b=await f.setup('b');fs.writeFileSync(path.join(a.c.workspace,'safe.txt'),'safe');fs.writeFileSync(path.join(a.c.workspace,'.env'),'secret');
  await assert.rejects(collect(a.c.workspace,['../a-credential.json']),/allowed|outside/);await assert.rejects(collect(a.c.workspace,['.env']),/credentials/);
  fs.symlinkSync(path.join(a.c.workspace,'safe.txt'),path.join(a.c.workspace,'link.txt'));await assert.rejects(collect(a.c.workspace,['link.txt']),/Symlinks/);
  await sendHandoff(a.c,makeClient(a.c),{id:'wrong-agent',to:'b',adapter:'hermes',title:'T',context:'C',next_steps:'N',files:['safe.txt']});
  await assert.rejects(receiveHandoff({...b.c,runtime_agent:'openai.desktop',agent_profile:'default'},makeClient(b.c),'wrong-agent'),/another Agent/);
  assert.equal((await makeClient(a.c).json('/v1/handoffs/wrong-agent')).receipt_state,'pending');
});

function tarBytes(entries){const parts=[];for(const item of entries){const body=Buffer.from(item.body||'');const h=Buffer.alloc(512);h.write(item.name,0,100);h.write('0000600\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(body.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write(item.type||'0',156);h.write('ustar\0',257);h.write('00',263);const checksum=[...h].reduce((a,b)=>a+b,0);h.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);parts.push(h,body,Buffer.alloc((512-body.length%512)%512));}parts.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(parts));}
test('archive preflight rejects traversal, links, duplicate case paths and unlisted artifacts without writing outside staging',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cases=[[{name:'../escape',body:'bad'}],[{name:'files/link',type:'2'}],[{name:'files/Foo',body:'1'},{name:'files/foo',body:'2'}],[{name:'C:/escape',body:'bad'}],[{name:'manifest.json',body:JSON.stringify({schema:'agent-handoff/1',id:'bad',title:'T',context:'C',next_steps:'N',files:[]})},{name:'HANDOFF.md',body:'notes'},{name:'files/extra',body:'unlisted'}]];
  for(let i=0;i<cases.length;i++){const archive=path.join(root,i+'.gz');fs.writeFileSync(archive,tarBytes(cases[i]));await assert.rejects(unpack(archive,path.join(root,'dest'+i)));}
  assert(!fs.existsSync(path.join(root,'escape')));
});

test('invalid decrypted package never yields verified receipt or accepted task',async t=>{
  const f=await fixture(t),a=await f.setup('a'),b=await f.setup('b');const archive=path.join(f.root,'bad.tar.gz'),cipher=path.join(f.root,'bad.age');
  fs.writeFileSync(archive,tarBytes([{name:'../escape',body:'bad'}]));await encrypt(a.c.age,b.c.age.recipient,archive,cipher);
  await makeClient(a.c).send({id:'hostile',file:cipher,to:'b',adapter:'hermes',profile:'default'});
  await assert.rejects(receiveHandoff(b.c,makeClient(b.c),'hostile'),/Archive|archive/);
  assert.equal((await makeClient(a.c).json('/v1/handoffs/hostile')).receipt_state,'pending');assert(!fs.existsSync(path.join(b.c.workspace,'.agent-handoff','inbox','hostile')));
});

test('failed upload resumes the same cached ciphertext; download resumes partial bytes and preserves complete files',async t=>{
  const f=await fixture(t),a=await f.setup('a'),b=await f.setup('b');fs.writeFileSync(path.join(a.c.workspace,'result.bin'),randomBytes(70000));
  const client=makeClient(a.c),input={id:'resume-interrupted',to:'b',adapter:'hermes',title:'Resume',context:'C',next_steps:'N',files:['result.bin']};
  const interrupted={...client,async send(s){const bytes=fs.readFileSync(s.file);await client.json('/v1/handoffs','POST',{id:s.id,recipient:s.to,size:bytes.length,sha256:sha(bytes),payload_format:'age-v1',adapter_id:s.adapter,profile_id:s.profile});
    const res=await fetch(f.url+`/v1/handoffs/${s.id}/payload`,{method:'PATCH',headers:{Authorization:'Bearer '+a.c.token,'Content-Type':'application/octet-stream','Upload-Offset':'0'},body:bytes.subarray(0,4096)});assert.equal(res.status,200);throw new Error('simulated disconnect');}};
  await assert.rejects(sendHandoff(a.c,interrupted,input),/simulated disconnect/);assert.equal((await client.json('/v1/handoffs/'+input.id)).offset,4096);
  const cached=path.join(a.c.state_dir,'outgoing',input.id,'payload.age'),hash=await shaFile(cached);await sendHandoff(a.c,client,input);assert.equal(await shaFile(cached),hash);
  const out=path.join(f.root,'resumed.age');fs.writeFileSync(out+'.part',fs.readFileSync(cached).subarray(0,3000));await makeClient(b.c).download({id:input.id,file:out});assert.equal(await shaFile(out),hash);
  await makeClient(b.c).download({id:input.id,file:out});assert.equal(await shaFile(out),hash);
  const empty=path.join(f.root,'empty-part.age');fs.writeFileSync(empty+'.part','');await makeClient(b.c).download({id:input.id,file:empty});assert.equal(await shaFile(empty),hash);
});

test('multiple relay profiles coexist, shared device identity is reused, and doctor never generates a missing key',async t=>{
  const f=await fixture(t),a=await f.setup('a',['openai']);
  const second=await install({...a.options,profile:'office'});const other=loadConfig(second.config);assert.equal(other.age.identity,a.c.age.identity);
  const source=fs.readFileSync(a.c.installed[0].file,'utf8');assert(source.includes('[mcp_servers.agent_handoff]'));assert(source.includes('[mcp_servers.agent_handoff_'));
  await uninstall(a.options.home,second.config,other);assert(fs.readFileSync(a.c.installed[0].file,'utf8').includes('[mcp_servers.agent_handoff]'));
  fs.renameSync(a.c.age.identity,a.c.age.identity+'.backup');const result=await doctor(a.c);assert(!result.ok);assert(!fs.existsSync(a.c.age.identity));
});

test('custom relay CA works with strict TLS; unknown CA and redirects are rejected',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ca-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const cert=path.join(root,'cert.pem'),key=path.join(root,'key.pem');
  await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost']);
  const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{if(req.url==='/v1/redirect'){res.writeHead(302,{Location:'https://example.com/steal'});return res.end();}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({device_id:'tls'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const c={relay_url:`https://localhost:${server.address().port}`,token:randomBytes(32).toString('base64url')};await assert.rejects(makeClient(c).json('/v1/me'),/self-signed/);
  const client=makeClient({...c,ca_file:cert});assert.equal((await client.json('/v1/me')).device_id,'tls');await assert.rejects(client.json('/v1/redirect'),/302/);
});


test('one-call MCP handoff resolves device display name, selects its Agent and receives verified files',async t=>{
  const f=await fixture(t),a=await f.setup('a',['dsh']),b=await f.setup('b',['openai']);
  f.relay.store.renameDevice('b','办公室电脑');
  await makeClient(b.c).json('/v1/agents/heartbeat','POST',{adapter_id:'openai.desktop',profile_id:'default'});
  const alice=await mcp(t,a.c,'deepseek.harness'),bob=await mcp(t,b.c,'openai.desktop');
  const bytes=Buffer.from('真实任务产物，保持字节一致。');fs.writeFileSync(path.join(a.c.workspace,'report.txt'),bytes);
  const sent=await alice.call('handoff',{target:'办公室电脑',context:'用户要继续编辑报表。已完成数据核对，剩余工作是补齐图表。',next_steps:'读取 report.txt 并继续补齐图表。',files:['report.txt']});
  assert.equal(sent.status,'ready');assert.equal(sent.destination.adapter,'openai.desktop');assert.equal(sent.destination.device,'b');
  const received=await bob.call('handoff');assert.equal(received.status,'received');assert.equal(received.id,sent.id);
  assert.equal(received.context,'用户要继续编辑报表。已完成数据核对，剩余工作是补齐图表。');
  assert.deepEqual(fs.readFileSync(received.files[0].path),bytes);
  assert.equal((await alice.call('handoff_status',{id:sent.id})).receipt_state,'verified');
  const second=await alice.call('handoff',{target:'办公室电脑',context:'另一项独立待办。'});
  const choices=await bob.call('handoff');assert.equal(choices.status,'choose_handoff');assert.equal(choices.choices.length,2);
  const selected=await bob.call('handoff',{id:second.id});assert.equal(selected.id,second.id);assert.equal(selected.files.length,0);
  assert.equal((await alice.call('handoff_connection')).notifications.enabled,false);
});


test('real MCP initialization emits a pending-handoff notice without receiving or exposing conversation content',async t=>{
  const f=await fixture(t),a=await f.setup('a'),b=await f.setup('b');
  const sent=await sendHandoff(a.c,makeClient(a.c),{to:'b',adapter:'openai.desktop',title:'Private task',context:'PRIVATE_CONTEXT_MUST_NOT_APPEAR_IN_NOTICE',next_steps:'Continue work.',files:[]});
  const bob=await mcp(t,b.c,'openai.desktop');
  for(let i=0;i<100 && !bob.notifications.length;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(bob.notifications.length,1);assert.equal(bob.notifications[0].method,'notifications/message');
  assert.equal(bob.notifications[0].params.data.event,'handoff_available');
  assert.equal(bob.notifications[0].params.data.count,1);
  assert(!JSON.stringify(bob.notifications).includes('PRIVATE_CONTEXT'));
  assert(!fs.existsSync(path.join(b.c.workspace,'.agent-handoff','inbox',sent.id)));
  assert.equal((await makeClient(a.c).json('/v1/handoffs/'+sent.id)).receipt_state,'pending');
});

test('four native host helpers send and receive encrypted tasks without an MCP reload and keep their routes separate',async t=>{
  const f=await fixture(t),hosts=['dsh','hermes','codex','chatgpt'];
  const a=await f.setup('a',['hermes']),b=await f.setup('b',hosts);
  assert.deepEqual(b.c.hosts,hosts);assert.equal(b.c.installed.length,3);assert.equal(b.c.host_files.length,10);
  assert(!b.c.installed.some(s=>s.agent==='chatgpt'));assert((await doctor(b.c)).ok);
  const sender=a.c.host_files.find(s=>s.file.endsWith('run.mjs')).file;
  fs.writeFileSync(path.join(a.c.workspace,'结果.txt'),'实际文件');
  const adapters={dsh:'deepseek.harness',hermes:'hermes',codex:'openai.desktop',chatgpt:'chatgpt.desktop'};
  // stdin carries private task text; the installed launcher supplies config and host itself.
  async function invoke(script,args,input){
    const child=(await import('node:child_process')).spawn(process.execPath,[script,...args],{stdio:['pipe','pipe','pipe']});
    let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.stdin.end(input?JSON.stringify(input):undefined);
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    assert.equal(code,0,err);return JSON.parse(out);
  }
  for(const host of hosts){
    const script=b.c.host_files.find(s=>s.agent===host&&s.file.endsWith('run.mjs')).file;
    const skill=b.c.host_files.find(s=>s.agent===host&&s.file.endsWith('SKILL.md'));
    assert(!skill.file.includes('/handoff/'));assert(!skill.entry.includes(b.c.token));
    const sent=await invoke(sender,['handoff','--input','-'],{target:'b',agent:host,context:`当前会话交给 ${host}。`,files:['结果.txt']});
    assert.equal(sent.destination.adapter,adapters[host]);
    const got=await invoke(script,['handoff']);assert.equal(got.status,'received');assert.equal(got.id,sent.id);
    assert.equal(got.context,`当前会话交给 ${host}。`);assert.equal(fs.readFileSync(got.files[0].path,'utf8'),'实际文件');
    const wrong=hosts.find(h=>h!==host);await assert.rejects(exec(process.execPath,[b.c.runtime,'handoff','--config',b.result.config,'--agent',adapters[wrong],'--id',sent.id]),/another Agent/);
    for(const state of ['accepted','started','completed'])await invoke(script,['receipt','--id',sent.id,'--state',state,'--code','host_test']);
  }
  const observed=(await makeClient(a.c).json('/v1/devices')).devices.find(d=>d.id==='b').agents;
  for(const adapter of Object.values(adapters))assert(observed.some(a=>a.adapter_id===adapter));
});

test('native skill collisions and modified files stop setup before config edits; uninstall removes only managed host assets',async t=>{
  const f=await fixture(t),a=await f.setup('a',['hermes','codex']);
  const managed=a.c.host_files.find(s=>s.file.endsWith('SKILL.md'));
  fs.writeFileSync(managed.file,'my customized skill');
  const before=fs.readFileSync(a.c.installed[1].file,'utf8');
  await assert.rejects(install({...a.options,agents:['hermes','codex','dsh']}),/modified/);
  assert.equal(fs.readFileSync(a.c.installed[1].file,'utf8'),before);
  assert(!fs.existsSync(path.join(a.options.agentHome,'.dsh','profiles','desktop','cordis.patch.yml')));
  fs.writeFileSync(managed.file,managed.entry);
  const custom=path.join(path.dirname(managed.file),'notes.txt');fs.writeFileSync(custom,'user notes');
  await uninstall(a.options.home,a.result.config,a.c);
  assert(!fs.existsSync(managed.file));assert.equal(fs.readFileSync(custom,'utf8'),'user notes');assert(fs.existsSync(a.c.age.identity));
});

test('0.4 openai config upgrades to codex without duplicate entries or changing identity; relay profiles get distinct skills',async t=>{
  const f=await fixture(t),a=await f.setup('a',['codex']);
  // Emulate the previous release: config entries existed, native skills did not.
  for(const asset of a.c.host_files)fs.rmSync(asset.file);
  const old={...a.c,installed:a.c.installed.map(s=>({...s,agent:'openai'}))};delete old.hosts;delete old.host_files;
  fs.writeFileSync(a.result.config,JSON.stringify(old));
  const upgraded=await install({...a.options,agents:['openai','codex']});const c=loadConfig(upgraded.config);
  assert.deepEqual(c.hosts,['codex']);assert.equal(c.age.identity,a.c.age.identity);
  const source=fs.readFileSync(c.installed[0].file,'utf8');assert.equal(source.split('[mcp_servers.agent_handoff]').length,2);
  const second=await install({...a.options,agents:['codex'],profile:'office'});const other=loadConfig(second.config);
  assert(other.host_files.some(s=>s.file.endsWith('/relay-office/SKILL.md')));
  await uninstall(a.options.home,second.config,other);assert(fs.existsSync(c.host_files[0].file));
});
