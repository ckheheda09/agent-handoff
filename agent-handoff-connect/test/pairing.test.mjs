import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRelay } from '../../agent-handoff-relay/src/server.mjs';
import { install,doctor } from '../src/install.mjs';
import { loadConfig,exec,sha } from '../src/util.mjs';
import { makeClient } from '../src/client.mjs';
import { publishSession,resumeSession } from '../src/sessions.mjs';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ageBin=process.env.TEST_AGE_BIN||(await exec('which',['age'])).stdout.trim();
const ageKeygen=process.env.TEST_AGE_KEYGEN||path.join(path.dirname(ageBin),'age-keygen');
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-autopair-')),relay=createRelay({data:path.join(root,'relay')});
 await new Promise(resolve=>relay.server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${relay.server.address().port}`;
 t.after(async()=>{await relay.close();fs.rmSync(root,{recursive:true,force:true});});
 function options(label,agents=[]){const workspace=path.join(root,label+'-workspace');fs.mkdirSync(workspace,{recursive:true});return {home:path.join(root,label),profile:'default',agents,relay:url,workspace,allowHTTP:true,ageBin,ageKeygen,downloadAge:false,notifications:'off',deviceName:label,agentHome:path.join(root,label+'-hosts'),bundle:path.join(project,'dist/cli.mjs')};}
 function approve(notice){assert(!('device_code' in notice));assert(!('recipient' in notice));assert(!('token' in notice));const row=relay.pairings.list().find(p=>p.id===notice.id);assert.equal(row.user_code,notice.user_code);relay.pairings.decide(row.id,'approve',{user_code:notice.user_code},'test-admin');}
 return {root,relay,url,options,approve};
}
test('first install pairs all four hosts without importing credentials, keeps private keys local and transfers encrypted sessions',async t=>{
 const f=await fixture(t),a=f.options('paired-dsh',['dsh','hermes','codex','chatgpt']);
 let notices=0;a.onPairing=notice=>{notices++;assert.equal(f.relay.store.stats().devices.length,0);f.approve(notice);};
 const installed=await install(a),ac=loadConfig(installed.config);assert.equal(notices,1);assert.equal(installed.agents.length,4);
 assert.equal((await doctor(ac)).ok,true);assert(fs.existsSync(ac.age.identity));assert.equal(f.relay.pairings.list().length,0);
 const key=sha(f.url+'\ndefault'),credentialFile=path.join(a.home,'credentials',key+'.json');assert(fs.existsSync(credentialFile));
 assert.equal(fs.existsSync(path.join(a.home,'enrollments',key+'.json')),false);
 if(process.platform!=='win32')assert.equal(fs.statSync(credentialFile).mode&0o777,0o600);
 const dbText=JSON.stringify(f.relay.store.db.prepare('SELECT * FROM device_pairings').all());
 assert(!dbText.includes(ac.token));assert(!dbText.includes(fs.readFileSync(ac.age.identity,'utf8')));
 const b=f.options('paired-hermes',['hermes']);b.onPairing=f.approve;const bc=loadConfig((await install(b)).config);
 const sent=await publishSession(ac,makeClient(ac),{id:'paired-session',title:'配对后的会话',context:'本地生成密钥并通过管理员批准',next_steps:'由另一台设备继续'});
 assert.equal((await resumeSession(bc,makeClient(bc),{id:sent.id})).context,'本地生成密钥并通过管理员批准');
 const again=await install({...a,onPairing:()=>assert.fail('existing device must not re-enroll')});
 assert.equal(loadConfig(again.config).age.identity,ac.age.identity);assert.equal(f.relay.store.stats().devices.length,2);
});
test('timed-out pairing resumes the same request and identity, and rejected pairing never installs host configuration',async t=>{
 const f=await fixture(t),o=f.options('resume',['dsh']);let first;
 await assert.rejects(install({...o,pairingTimeoutSeconds:1,onPairing:notice=>{first=notice;}}),/超时/);
 const key=sha(f.url+'\ndefault'),stateFile=path.join(o.home,'enrollments',key+'.json');const before=JSON.parse(fs.readFileSync(stateFile));
 assert.equal(fs.existsSync(path.join(o.home,'profiles','default.json')),false);assert.equal(f.relay.store.stats().devices.length,0);
 f.relay.store.db.prepare('UPDATE device_pairings SET last_poll_at=0 WHERE id=?').run(first.id);
 const installed=await install({...o,onPairing:notice=>{assert.equal(notice.id,first.id);assert.equal(notice.user_code,first.user_code);f.approve(notice);}});
 const c=loadConfig(installed.config);assert.equal(path.basename(c.age.identity,'.txt'),before.identity_key);
 const denied=f.options('denied',['dsh']);
 await assert.rejects(install({...denied,onPairing:notice=>f.relay.pairings.decide(notice.id,'reject',{user_code:notice.user_code},'test-admin')}),/pairing_rejected/);
 assert.equal(fs.existsSync(path.join(denied.home,'profiles','default.json')),false);
 assert.equal(fs.existsSync(path.join(denied.agentHome,'.dsh','profiles','desktop','cordis.patch.yml')),false);
});
test('lost claim responses and subsequent local config failures do not duplicate devices or lose the enrolled credential',async t=>{
 const f=await fixture(t),o=f.options('retry',['dsh']);const config=path.join(o.agentHome,'.dsh','profiles','desktop','cordis.patch.yml');
 fs.mkdirSync(path.dirname(config),{recursive:true});fs.writeFileSync(config,'invalid: mapping\n');let claimed;
 o.onPairing=notice=>{
  f.approve(notice);const file=path.join(o.home,'enrollments',sha(f.url+'\ndefault')+'.json');const saved=JSON.parse(fs.readFileSync(file));
  claimed=f.relay.pairings.poll(notice.id,`Bearer ${saved.device_code}`).credential;
  f.relay.store.db.prepare('UPDATE device_pairings SET last_poll_at=0 WHERE id=?').run(notice.id);
 };
 await assert.rejects(install(o),/YAML patch array/);assert.equal(f.relay.store.stats().devices.length,1);
 fs.writeFileSync(config,'[]\n');
 const c=loadConfig((await install({...o,onPairing:()=>assert.fail('credential should be recovered automatically')})).config);
 assert.equal(c.token,claimed.token);assert.equal(c.device_id,claimed.device_id);assert.equal(f.relay.store.stats().devices.length,1);
});

test('packaged CLI waits for pairing approval, handles cancellation without a stale setup lock, and resumes',async t=>{
 const f=await fixture(t),o=f.options('cli',['dsh']);
 function launch(){
  const child=spawn(process.execPath,[o.bundle,'setup','--yes','--agents','dsh','--relay',f.url,'--allow-loopback-http','--home',o.home,'--workspace',o.workspace,'--agent-home',o.agentHome,'--age-bin',ageBin,'--age-keygen',ageKeygen,'--no-download-age','--notifications','off'],{stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const done=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal,out,err})));
  t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});return {child,done,get err(){return err;}};
 }
 const first=launch();let row;
 for(let i=0;i<100;i++){row=f.relay.store.db.prepare('SELECT * FROM device_pairings WHERE last_poll_at>0').get();if(row&&first.err.includes(row.user_code))break;await new Promise(r=>setTimeout(r,20));}
 assert(row);assert(first.err.includes(row.user_code));first.child.kill('SIGINT');
 const cancelled=await first.done;assert.equal(cancelled.code,1);assert.equal(fs.existsSync(path.join(o.home,'setup.lock')),false);
 f.relay.store.db.prepare('UPDATE device_pairings SET last_poll_at=0 WHERE id=?').run(row.id);
 const second=launch();
 for(let i=0;i<100&&!second.err.includes(row.user_code);i++)await new Promise(r=>setTimeout(r,20));
 assert(second.err.includes(row.user_code));f.relay.pairings.decide(row.id,'approve',{user_code:row.user_code},'test-admin');
 const completed=await second.done;assert.equal(completed.code,0,completed.err);assert.equal(JSON.parse(completed.out).status,'configured');
 const c=loadConfig(JSON.parse(completed.out).config);assert(!completed.out.includes(c.token));assert(!completed.err.includes(c.token));
 assert.equal(f.relay.store.stats().devices.length,1);assert.equal(fs.existsSync(path.join(o.home,'setup.lock')),false);
});
