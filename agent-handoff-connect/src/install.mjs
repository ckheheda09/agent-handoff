import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VERSION, check, identifier, endpoint, relayURL, privateDir, atomic, sha, shaFile, profileFile, jsonFile, locked, exec } from './util.mjs';
import { ensureAge, identity } from './age.mjs';
import { AGENTS, locations, spec, applyAdapters, editConfig } from './adapters.mjs';
import { makeClient } from './client.mjs';

export async function install(options) {
  const root=path.resolve(options.home),profile=options.profile||'default';
  check(identifier(profile)&&endpoint(options.agentProfile||'default'),'Invalid relay/Agent profile');await privateDir(root);
  return locked(path.join(root,'setup.lock'),async()=>{
    const file=profileFile(root,profile);const previous=fs.existsSync(file)?jsonFile(file):undefined;
    const credential=options.credentials?jsonFile(path.resolve(options.credentials)):previous;
    check(credential&&identifier(credential.device_id)&&/^[A-Za-z0-9_-]{43}$/.test(credential.token),'Import a device credential JSON from the relay admin console');
    check(!previous||previous.device_id===credential.device_id,'This relay profile belongs to another device; use a new --profile');
    const url=relayURL(options.relay||credential.relay_url,options.allowHTTP||false);
    const workspace=await fs.promises.realpath(path.resolve(options.workspace||previous?.workspace||process.cwd()));
    check((await fs.promises.stat(workspace)).isDirectory(),'Workspace must be a directory');
    const selected=[...new Set(options.agents)];check(selected.every(a=>AGENTS[a]),'Agent choices: dsh, hermes, openai');
    const notifications=options.notifications || previous?.notifications || 'system';
    check(['system','off'].includes(notifications),'Use --notifications system or off');
    const c={config_version:1,profile,device_id:credential.device_id,token:credential.token,relay_url:url,allow_loopback_http:!!options.allowHTTP,workspace,
      agent_profile:options.agentProfile||'default',state_dir:path.join(root,'state',profile),notifications,installed:[]};
    // Verify the actual service before touching any Agent configuration.
    if(options.ca){const pem=await fs.promises.readFile(path.resolve(options.ca),'utf8');check(pem.includes('-----BEGIN CERTIFICATE-----'),'CA must be a PEM certificate');
      const dest=path.join(root,'certificates',sha(pem)+'.crt');await atomic(dest,pem);c.ca_file=dest;
    }
    const client=makeClient(c);const me=await client.json('/v1/me');check(me.device_id===c.device_id,'Credential device ID does not match relay authentication');
    check(me.max_payload_bytes>0,'This URL is not a compatible handoff relay');
    const age=await ensureAge(root,{bin:options.ageBin,keygen:options.ageKeygen,download:options.downloadAge!==false});
    c.age=await identity(root,previous?.age?.identity?path.basename(previous.age.identity,'.txt'):sha(credential.relay_url+'\n'+c.device_id).slice(0,32),age);
    await client.json('/v1/me/encryption-key','POST',{recipient:c.age.recipient});
    await privateDir(c.state_dir);
    const bundle=path.resolve(options.bundle);check((await fs.promises.stat(bundle)).isFile(),'Installer runtime bundle missing');
    const runtime=path.join(root,'runtime',VERSION+'-'+(await shaFile(bundle)).slice(0,16),'cli.mjs');
    await privateDir(path.dirname(runtime));if(!fs.existsSync(runtime))await atomic(runtime,await fs.promises.readFile(bundle),{mode:0o700});
    const files=locations(options.agentHome||os.homedir(),options.agentHome?{}:process.env);
    if(options.dshConfig)files.dsh=path.resolve(options.dshConfig);
    if(options.hermesConfig)files.hermes=path.resolve(options.hermesConfig);
    if(options.openaiConfig)files.openai=path.resolve(options.openaiConfig);
    if(options.dshProfile){check(identifier(options.dshProfile),'Invalid DSH profile');files.dsh=path.join(path.dirname(path.dirname(files.dsh)),options.dshProfile,'cordis.patch.yml');}
    const specs=selected.map(agent=>spec({agent,profile,file:files[agent],runtime,config:file,workspace,agentProfile:c.agent_profile}));
    const result=await applyAdapters(specs,previous?.installed||[]);c.installed=result.installed;c.runtime=runtime;c.updated_at=new Date().toISOString();
    try{await atomic(file,JSON.stringify(c,null,2)+'\n',{backup:true});}
    catch(e){await applyAdapters(previous?.installed||[],specs);throw e;}
    return {status:'configured',version:VERSION,profile,device_id:c.device_id,relay_url:url,workspace,age_recipient:c.age.recipient,config:file,runtime,notifications,agents:selected.map(a=>AGENTS[a].name),changes:result.changes,
      next:'Restart the selected Agent, or reload its MCP servers. Then ask it to call handoff_connection and handoff_devices. The bridge reports heartbeats only while an MCP client is connected.'};
  });
}
export async function doctor(c) {
  const results=[];async function probe(name,fn){try{results.push({name,ok:true,value:await fn()});}catch(e){results.push({name,ok:false,error:e.message});}}
  const client=makeClient(c);
  await probe('relay',async()=>{const me=await client.json('/v1/me');check(me.device_id===c.device_id,'Device mismatch');return me;});
  await probe('encryption_key',async()=>{const peer=(await client.json('/v1/devices')).devices.find(d=>d.id===c.device_id);check(peer?.recipient===c.age.recipient,'Public key is missing or different');return c.age.recipient;});
  await probe('age_identity',async()=>{check(fs.existsSync(c.age.identity),'Private key is missing; restore the original key from backup');const {stdout}=await exec(c.age.keygen,['-y',c.age.identity],{timeout:10000,windowsHide:true});check(stdout.trim()===c.age.recipient,'Private key does not match registered public key');return 'private key matches public key';});
  await probe('workspace',async()=>{check((await fs.promises.stat(c.workspace)).isDirectory(),'Workspace missing');return c.workspace;});
  for(const s of c.installed||[])await probe(s.agent+'_config',async()=>{check(fs.existsSync(s.file),'Agent config missing');const source=fs.readFileSync(s.file,'utf8');
    // Removing a managed entry in memory validates both presence and expected content.
    const output=editConfig(source,s,s,{remove:true});check(output!==source,'Managed server entry missing');return s.file;});
  return {ok:results.every(r=>r.ok),device_id:c.device_id,profile:c.profile,results};
}
export async function uninstall(root,file,c) {
  return locked(path.join(root,'setup.lock'),async()=>{
    const result=await applyAdapters([],c.installed||[]);await atomic(file,JSON.stringify({...c,installed:[]},null,2)+'\n',{backup:true});
    return {status:'uninstalled',changes:result.changes,retained:'Device credentials, identity keys, encrypted retry cache and received files are preserved. Restart the Agent.'};
  });
}
