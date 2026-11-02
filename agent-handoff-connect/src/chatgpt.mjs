import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { unzipSync } from 'fflate';
import assets from './tunnel-assets.json' with {type:'json'};
import { atomic, check, privateDir, shaFile, exec, locked } from './util.mjs';
import { tunnelProfile, validateTunnelID } from './hosts.mjs';

// tunnel-client parses mcp.command as shell-style argv. No shell is launched here.
export function commandString(argv) {
  return argv.map(arg=>`'${arg.replaceAll("'", "'\\''")}'`).join(' ');
}
export async function ensureTunnel(root,{bin,download=true}={}) {
  if(bin){check(path.isAbsolute(bin),'tunnel-client path must be absolute');await exec(bin,['--version'],{timeout:10000,windowsHide:true});return bin;}
  const platform={darwin:'darwin',linux:'linux',win32:'windows'}[process.platform],arch={x64:'amd64',arm64:'arm64'}[process.arch];
  const asset=assets.assets[platform+'-'+arch];check(asset,'No bundled tunnel-client for this platform; use --tunnel-bin');
  const dest=path.join(root,'tools',`tunnel-client-${assets.version}-${platform}-${arch}`),name='tunnel-client'+(platform==='windows'?'.exe':'');
  const executable=path.join(dest,name);
  if(fs.existsSync(executable)){check((await fs.promises.lstat(executable)).isFile(),'Invalid tunnel-client executable');return executable;}
  check(download,'tunnel-client is missing');await privateDir(path.dirname(dest));
  const temp=await fs.promises.mkdtemp(path.join(path.dirname(dest),'tunnel-download-'));
  try{
    const res=await fetch(asset.url,{signal:AbortSignal.timeout(120000)});check(res.ok,`tunnel-client download HTTP ${res.status}`);
    const archive=path.join(temp,'release.zip');const fd=await fs.promises.open(archive,'wx',0o600);let n=0;
    try{for await(const b of res.body){n+=b.length;check(n<=128*1024**2,'tunnel-client release exceeds download limit');await fd.writeFile(b);}}finally{await fd.close();}
    check(await shaFile(archive)===asset.sha256,'Official tunnel-client checksum mismatch');
    const zip=unzipSync(await fs.promises.readFile(archive),{filter:f=>path.posix.basename(f.name)===name});
    const keys=Object.keys(zip).filter(k=>path.posix.basename(k)===name);check(keys.length===1,'Official release must contain exactly one tunnel-client executable');
    const stage=path.join(temp,'bin');await privateDir(stage);await fs.promises.writeFile(path.join(stage,name),zip[keys[0]],{mode:0o700});
    try{await fs.promises.rename(stage,dest);}catch(e){if(!fs.existsSync(executable))throw e;}
    return executable;
  }finally{await fs.promises.rm(temp,{recursive:true,force:true});}
}
export async function connectChatGPT(c,config,{tunnelID,bin,root,env=process.env,ensure=ensureTunnel,run=runForeground}={}) {
  check(c.hosts?.includes('chatgpt'),'Run setup --agents chatgpt (plus any other desired hosts) first');
  const state=path.join(c.state_dir,'chatgpt-tunnel.json');
  const saved=fs.existsSync(state)?JSON.parse(await fs.promises.readFile(state,'utf8')):{};
  const id=tunnelID||saved.tunnel_id||env.CONTROL_PLANE_TUNNEL_ID;
  check(validateTunnelID(id),'ChatGPT 安全隧道缺少 tunnel_id。先在 OpenAI Platform 的 tunnel settings 创建并关联 ChatGPT 工作区，然后使用 --tunnel-id tunnel_...。详见 HOSTS.md。');
  check(env.CONTROL_PLANE_API_KEY,'请在本机安全设置 CONTROL_PLANE_API_KEY（Tunnels Read + Use），不要把密钥发到聊天或作为命令参数。');
  return locked(path.join(c.state_dir,'chatgpt-tunnel.lock'),async()=>{
    const executable=await ensure(root,{bin:bin||saved.bin});const profile=tunnelProfile(c);
    const profileDir=path.join(c.state_dir,'tunnel-client');await privateDir(profileDir);
    const common=['--profile',profile,'--profile-dir',profileDir];
    const command=commandString([c.node||process.execPath,c.runtime,'mcp','--config',config,'--agent','chatgpt.desktop','--agent-profile',c.agent_profile]);
    await run(executable,['init','--sample','sample_mcp_stdio_local',...common,'--force','--health-listen-addr','127.0.0.1:0','--tunnel-id',id,'--mcp-command',command],{env,stdio:['ignore','inherit','inherit']});
    await atomic(state,JSON.stringify({tunnel_id:id,bin:executable,profile},null,2)+'\n');
    await run(executable,['doctor',...common,'--explain'],{env,stdio:'inherit'});
    process.stderr.write('请保持此终端运行。在 ChatGPT 的自定义 MCP 接入中选择 Tunnel 和此 tunnel_id，再在聊天中选择 Agent Handoff，说“接力”。隧道启动不代表 ChatGPT 已完成工具调用验证。\n');
    await run(executable,['run',...common,'--mcp.stdio-send-initialized-notification','--health.url-file',path.join(c.state_dir,'chatgpt-health-url.txt')],{env,stdio:'inherit'});
  });
}
export function runForeground(command,args,options={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{...options,shell:false,windowsHide:true});
    const int=()=>child.kill('SIGINT'),term=()=>child.kill('SIGTERM');
    process.once('SIGINT',int);process.once('SIGTERM',term);
    const cleanup=()=>{process.removeListener('SIGINT',int);process.removeListener('SIGTERM',term);};
    child.once('error',e=>{cleanup();reject(e);});
    child.once('exit',(code,signal)=>{cleanup();if(code===0)resolve();else reject(new Error(`tunnel-client exited ${code??signal}`));});
  });
}
