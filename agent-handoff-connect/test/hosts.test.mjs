import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {connectChatGPT,commandString} from '../src/chatgpt.mjs';
import {detectHosts,hostGuide} from '../src/hosts.mjs';

test('host discovery recommends existing hosts, and native commands avoid the Hermes builtin handoff',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'host-discovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.hermes'));fs.mkdirSync(path.join(root,'.codex'));
  assert.deepEqual(detectHosts(root,{}).filter(h=>h!=='chatgpt'),['hermes','codex']);
  assert.equal(hostGuide(['hermes'],'default')[0].entry,'/relay');
  assert.equal(hostGuide(['codex'],'office')[0].entry,'$relay-office');
  assert.equal(hostGuide(['chatgpt'],'default')[0].adapter,'chatgpt.desktop');
});

test('ChatGPT tunnel fails before download if account setup is missing, never saves keys, and supports reconnect',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chatgpt-tunnel-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const c={hosts:['chatgpt'],state_dir:root,node:process.execPath,runtime:'/private/path with spaces/runtime.mjs',agent_profile:'default'};
  const calls=[];const opts={root,tunnelID:'tunnel_0123456789abcdef0123456789abcdef',env:{CONTROL_PLANE_API_KEY:'secret-must-not-be-saved'},ensure:async()=>'/official/tunnel-client',run:async(bin,args,options)=>calls.push({bin,args,options})};
  await assert.rejects(connectChatGPT(c,'/private/config.json',{...opts,tunnelID:undefined,env:{}}),/tunnel_id/);assert.equal(calls.length,0);
  await assert.rejects(connectChatGPT(c,'/private/config.json',{...opts,env:{}}),/CONTROL_PLANE_API_KEY/);assert.equal(calls.length,0);
  await connectChatGPT(c,'/private/config.json',opts);
  assert.deepEqual(calls.map(x=>x.args[0]),['init','doctor','run']);
  assert(calls[0].args.includes('--force'));assert(calls[0].args.includes('--profile-dir'));
  assert(calls[2].args.includes('--mcp.stdio-send-initialized-notification'));
  const command=calls[0].args[calls[0].args.indexOf('--mcp-command')+1];assert(command.includes("'chatgpt.desktop'"));assert(command.includes("'/private/path with spaces/runtime.mjs'"));
  const state=fs.readFileSync(path.join(root,'chatgpt-tunnel.json'),'utf8');assert(!state.includes('secret-must-not-be-saved'));
  assert(!JSON.stringify(calls.map(x=>x.args)).includes('secret-must-not-be-saved'));
  if(process.platform!=='win32')assert.equal(fs.statSync(path.join(root,'chatgpt-tunnel.json')).mode&0o777,0o600);
  await connectChatGPT(c,'/private/config.json',{...opts,tunnelID:undefined});assert.equal(calls.length,6);
  assert(!fs.existsSync(path.join(root,'chatgpt-tunnel.lock')));
});

test('ChatGPT doctor failure stops startup and releases connection lock',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'chatgpt-fail-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[];
  await assert.rejects(connectChatGPT({hosts:['chatgpt'],state_dir:root,runtime:'/runtime',agent_profile:'default'},'/config',{
    root,tunnelID:'tunnel_0123456789abcdef0123456789abcdef',env:{CONTROL_PLANE_API_KEY:'private-key'},ensure:async()=>'/binary',run:async(_,args)=>{calls.push(args[0]);if(args[0]==='doctor')throw new Error('not authorized');}
  }),/not authorized/);
  assert.deepEqual(calls,['init','doctor']);assert(!fs.existsSync(path.join(root,'chatgpt-tunnel.lock')));
  assert.equal(commandString(["a'b",'$HOME',String.raw`C:\a b\node.exe`]),String.raw`'a'\''b' '$HOME' 'C:\a b\node.exe'`);
});
