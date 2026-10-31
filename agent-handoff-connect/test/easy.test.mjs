import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDestination, pendingInbox, handoff } from '../src/workflow.mjs';
import { createInboxWatcher, desktopNotify, notificationCommand } from '../src/notify.mjs';

const c={runtime_agent:'hermes',agent_profile:'default'};
const route=(adapter_id='hermes',profile_id='default')=>({adapter_id,profile_id,last_seen_at:Date.now()});
const device=(id,name,agents=[route()])=>({id,name,recipient:'public-test-key',agents});
const row=(id,cursor,extra={})=>({id,cursor,status:'ready',receipt_state:'pending',adapter_id:'hermes',profile_id:'default',expires_at:Date.now()+60000,...extra});

test('device display names resolve exactly; ambiguous names and Agent routes never send silently',()=>{
  const directory={devices:[device('office','办公室电脑'),device('home','家庭电脑')]};
  assert.equal(resolveDestination(c,directory,{target:'办公室电脑'}).device,'office');
  assert.equal(resolveDestination(c,directory,{target:'OFFICE'}).device,'office');
  assert.equal(resolveDestination(c,directory,{target:'办公室'}).status,'choose_device');
  const duplicate={devices:[device('one','电脑'),device('two','电脑')]};
  assert.equal(resolveDestination(c,duplicate,{target:'电脑'}).choices.length,2);
  const many={devices:[device('office','办公室电脑',[route(),route('openai.desktop')])]};
  assert.equal(resolveDestination(c,many,{target:'office'}).status,'choose_agent');
  assert.equal(resolveDestination(c,many,{target:'office',agent:'codex'}).adapter,'openai.desktop');
  const profiles={devices:[device('office','办公室电脑',[route('hermes','one'),route('hermes','two')])]};
  assert.equal(resolveDestination(c,profiles,{target:'office',agent:'hermes'}).status,'choose_agent');
  assert.equal(resolveDestination(c,profiles,{target:'office',agent_profile:'two'}).agent_profile,'two');
  assert.equal(resolveDestination(c,{devices:[{id:'office',name:'电脑'}]},{target:'office'}).status,'recipient_not_ready');
  assert.equal(resolveDestination(c,{devices:[device('office','电脑',[])]},{target:'office'}).status,'choose_agent');
  assert.equal(resolveDestination(c,{devices:[device('office','电脑',[])]},{target:'office',agent:'dsh'}).adapter,'deepseek.harness');
});

test('a single live route is preferred over stale observations; explicit offline routing is supported',()=>{
  const directory={devices:[device('office','电脑',[route(),{...route('openai.desktop'),last_seen_at:Date.now()-1000000}])]};
  assert.equal(resolveDestination(c,directory,{target:'office'}).adapter,'hermes');
  assert.equal(resolveDestination(c,directory,{target:'office',agent:'codex'}).adapter,'openai.desktop');
});

test('pending receive scans beyond the first 100 completed deliveries and filters other Agent routes',async()=>{
  const first=Array.from({length:100},(_,i)=>row('done-'+i,i+1,{receipt_state:'completed'}));
  const calls=[];
  const client={async json(url){calls.push(url);return url.includes('after=0&')?{items:first,next_cursor:100}:{items:[row('other',101,{adapter_id:'openai.desktop'}),row('expired',102,{expires_at:1}),row('next',103)],next_cursor:103};}};
  const pending=await pendingInbox(c,client);assert.equal(pending.complete,true);assert.deepEqual(pending.items.map(x=>x.id),['next']);assert.equal(calls.length,2);
  const truncated=await pendingInbox(c,client,{maxPages:1});assert.equal(truncated.complete,false);
});

test('empty and multiple inboxes return simple choices without downloads or receipts',async()=>{
  const client={async json(url){assert(url.startsWith('/v1/inbox?'));return {items:[],next_cursor:0};}};
  assert.equal((await handoff(c,client)).status,'empty');
  client.json=async url=>{assert(url.startsWith('/v1/inbox?'));return {items:[row('first',1),row('second',2)],next_cursor:2};};
  const result=await handoff(c,client);assert.equal(result.status,'choose_handoff');assert.equal(result.choices.length,2);
  await assert.rejects(handoff(c,client,{action:'receive',target:'office'}),/Send fields/);
});

test('notifications are route filtered, do not download, are grouped and deduplicate across restarts',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-notices-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config={...c,state_dir:root,notifications:'system'};let cursor=0,osNotices=0,logs=0;
  const client={async json(url){const after=Number(new URL(url,'http://local').searchParams.get('after'));return {items:after>=2?[]:[row('one',1),row('two',2),row('other',3,{adapter_id:'openai.desktop'})],next_cursor:Math.max(after,3)};}};
  const options={onNotice:async value=>{assert.equal(value.count,2);assert(!JSON.stringify(value).includes('one'));logs++;},notify:async count=>{assert.equal(count,2);osNotices++;return {status:'submitted'};}};
  const a=createInboxWatcher(config,client,options);await a.poll();await a.poll();await a.stop();
  const b=createInboxWatcher(config,client,options);await b.poll();await b.stop();
  assert.equal(osNotices,1);assert.equal(logs,1);
  const saved=fs.readdirSync(path.join(root,'notifications')).find(f=>f.endsWith('.json'));
  cursor=JSON.parse(fs.readFileSync(path.join(root,'notifications',saved))).cursor;assert.equal(cursor,3);
  if(process.platform!=='win32')assert.equal(fs.statSync(path.join(root,'notifications',saved)).mode&0o777,0o600);
});

test('parallel connections share notification cursor; off mode retains MCP notice and failures stay nonfatal',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-notices-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let notices=0;const config={...c,state_dir:root,notifications:'off'};
  const client={async json(url){const after=Number(new URL(url,'http://local').searchParams.get('after'));return {items:after?[]:[row('one',1)],next_cursor:1};}};
  const options={onNotice:async()=>{notices++;},notify:async()=>{throw Error('must not run');}};
  const a=createInboxWatcher(config,client,options),b=createInboxWatcher(config,client,options);
  await Promise.all([a.poll(),b.poll()]);await b.poll();assert.equal(notices,1);await Promise.all([a.stop(),b.stop()]);
  const broken=createInboxWatcher({...config,state_dir:path.join(root,'broken')},{json:async()=>{throw Error('Relay unavailable');}});
  await broken.poll();assert.equal(broken.status().last_error,'Relay unavailable');await broken.stop();
});

test('desktop dispatch uses static scripts and arguments, and reports headless or unavailable platforms',async()=>{
  for(const platform of ['darwin','win32','linux']) {
    const command=notificationCommand(2,platform,{DISPLAY:':0'});assert(command);assert.equal(command.options.timeout,12000);
    assert(!command.options.shell);assert(command.args.every(a=>typeof a==='string'));
    const result=await desktopNotify(2,{platform,env:{DISPLAY:':0'},run:async(file,args)=>{assert.equal(file,command.file);assert.deepEqual(args,command.args);}});
    assert.equal(result.status,'submitted');
  }
  assert.equal((await desktopNotify(1,{platform:'linux',env:{}})).status,'unavailable');
  assert.equal((await desktopNotify(1,{platform:'darwin',run:async()=>{throw Object.assign(Error('No helper'),{code:'ENOENT'});}})).status,'unavailable');
});
