import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { VERSION, check, rootDir, profileFile, loadConfig, jsonFile } from './util.mjs';
import { install, doctor, uninstall } from './install.mjs';
import { AGENTS } from './adapters.mjs';
import { startMcp } from './mcp.mjs';
import { makeClient } from './client.mjs';
import { sendHandoff, receiveHandoff } from './handoff.mjs';
import { handoff } from './workflow.mjs';
import { desktopNotify } from './notify.mjs';

process.umask(0o077);
const HELP=`Agent Handoff ${VERSION}

  agent-handoff                         交互式安装 / 重新配置
  agent-handoff setup                   选择 Agent、凭证、中转 URL、CA 和工作目录
  agent-handoff doctor [--profile NAME]  检查服务、密钥、Agent 配置
  agent-handoff profiles                列出已配置的中转服务（隐藏密钥）
  agent-handoff uninstall               移除当前 profile 的 MCP 配置，保留身份与数据
  agent-handoff handoff                 接收唯一待接力任务；多条时列出选择
  agent-handoff notify-test             发送一条不含会话内容的系统测试通知
  agent-handoff peers | inbox | outbox
  agent-handoff send --input TASK.json 发送上下文与文件
  agent-handoff receive --id ID
  agent-handoff status --id ID
  agent-handoff receipt --id ID --state STATE --code REASON [--request-id ID]
  agent-handoff cancel --id ID

安装参数：
  --agents dsh,hermes,openai   可多选；ChatGPT Desktop / Codex 共用一个配置
  --relay https://host:port   可配置任意兼容中转；默认为凭证中的地址
  --credentials FILE          管理后台下载的设备凭证 JSON
  --ca FILE                   自签服务的 PEM CA；留空使用系统信任
  --workspace DIR             允许交接的工作目录
  --profile NAME              中转配置名称，默认 default；支持多服务
  --agent-profile NAME        Agent 路由身份，默认 default
  --dsh-profile NAME          DSH 原生配置名称，默认 desktop
  --dsh-config FILE | --hermes-config FILE | --openai-config FILE
  --home DIR                  本插件配置目录（亦支持 AGENT_HANDOFF_HOME）
  --agent-home DIR            自定义 Agent 用户目录，用于隔离安装
  --age-bin FILE --age-keygen FILE  使用已有 age；缺省下载并校验官方版本
  --notifications system|off  新交接系统提醒，默认 system；宿主连接时检查
  --no-download-age           禁止下载 age
  --allow-loopback-http      允许 localhost HTTP SSH 隧道
  --yes                      使用参数，无交互

私钥和设备令牌不发送给其他设备。文件包在本地 age 加密后才上传。
`;
const stringOptions=['notifications','home','profile','agents','relay','credentials','ca','workspace','agent-profile','dsh-profile','dsh-config','hermes-config','openai-config','agent-home','age-bin','age-keygen','config','agent','input','id','state','code','request-id'];
function expand(value){if(!value)return value;let s=value.trim();if((s.startsWith('"')&&s.endsWith('"'))||(s.startsWith("'")&&s.endsWith("'")))s=s.slice(1,-1);if(s==='~')s=os.homedir();if(s.startsWith('~/')||s.startsWith('~\\'))s=path.join(os.homedir(),s.slice(2));return path.resolve(s);}
function output(v){stdout.write(JSON.stringify(v,null,2)+'\n');}
async function main(){
  const {values:v,positionals}=parseArgs({options:{...Object.fromEntries(stringOptions.map(k=>[k,{type:'string'}])),help:{type:'boolean',short:'h'},version:{type:'boolean'},yes:{type:'boolean'},'no-download-age':{type:'boolean'},'allow-loopback-http':{type:'boolean'}},allowPositionals:true});
  if(v.help){stdout.write(HELP);return;}if(v.version){stdout.write(VERSION+'\n');return;}
  const [major,minor]=process.versions.node.split('.').map(Number);check(major>22||(major===22&&minor>=18),'Node.js 22.18+ is required');
  const root=expand(v.home||rootDir()),profile=v.profile||'default',file=expand(v.config||profileFile(root,profile));
  const cmd=positionals[0]||'setup';check(positionals.length<=1,'Unexpected arguments');
  if(cmd==='profiles'){
    const dir=path.join(root,'profiles');const items=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>{const c=jsonFile(path.join(dir,f));return {profile:c.profile,device_id:c.device_id,relay_url:c.relay_url,agents:(c.installed||[]).map(s=>s.agent),workspace:c.workspace};}):[];return output({profiles:items});
  }
  if(cmd==='setup'){
    let previous;try{previous=loadConfig(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    check(!v.config,'Use --home and --profile for setup; --config is for running an existing bridge');
    let agents=v.agents,relay=v.relay,credentials=expand(v.credentials),ca=v.ca==='system'?undefined:expand(v.ca),workspace=expand(v.workspace),dshProfile=v['dsh-profile'];
    const interactive=!v.yes;
    if(interactive){check(stdin.isTTY,'Run in a terminal, or pass --yes --agents ... --credentials ... --workspace ...');const rl=createInterface({input:stdin,output:stdout});
      const ask=async(label,fallback='')=>{const value=(await rl.question(`${label}${fallback?` [${fallback}]`:''}: `)).trim();return value||fallback;};
      try{
        stdout.write(`\nAgent Handoff ${VERSION} · 中转配置 ${profile}\n`);
        stdout.write('1. DeepSeek Harness（桌面 / CLI）\n2. Hermes\n3. ChatGPT Desktop / Codex\n');
        const defaultChoices=previous?.installed?.map(s=>({dsh:1,hermes:2,openai:3}[s.agent])).join(',')||'1,2,3';
        if(!agents){const selected=await ask('选择 Agent，可用逗号多选',defaultChoices);agents=selected.split(/[,，\s]+/).filter(Boolean).map(n=>({'1':'dsh','2':'hermes','3':'openai'}[n]||n)).join(',');}
        if(!credentials&&!previous)credentials=expand(await ask('设备凭证 JSON 路径（从管理后台下载）'));
        const creds=credentials?jsonFile(credentials):previous;
        relay=relay||await ask('中转服务 URL',creds?.relay_url||'');
        if(v.ca===undefined){const choice=await ask('CA 证书路径，填 system 使用系统信任',previous?.ca_file||'system');ca=choice==='system'?undefined:expand(choice);}
        workspace=workspace||expand(await ask('允许交接的工作目录',previous?.workspace||process.cwd()));
        if(agents.split(',').includes('dsh')&&!v['dsh-config'])dshProfile=dshProfile||await ask('DeepSeek Harness 配置名称', 'desktop');
        stdout.write('配置修改前会备份；缺少 age 时会下载并校验官方发布包。\n');
      }finally{rl.close();}
    }
    if(!interactive&&v.ca===undefined)ca=previous?.ca_file;
    check(agents,'Select --agents dsh,hermes,openai (or none for manual CLI)');
    const selected=agents==='none'?[]:agents.split(',').map(s=>({codex:'openai',chatgpt:'openai'}[s.trim()]||s.trim()));
    const result=await install({home:root,profile,agents:selected,relay,credentials,ca,workspace,agentProfile:v['agent-profile']||previous?.agent_profile||'default',dshProfile,agentHome:expand(v['agent-home']),dshConfig:expand(v['dsh-config']),hermesConfig:expand(v['hermes-config']),openaiConfig:expand(v['openai-config']),ageBin:expand(v['age-bin']),ageKeygen:expand(v['age-keygen']),notifications:v.notifications||previous?.notifications,downloadAge:!v['no-download-age'],allowHTTP:!!v['allow-loopback-http']||previous?.allow_loopback_http,bundle:fileURLToPath(import.meta.url)});
    return output(result);
  }
  const c=loadConfig(file);
  if(cmd==='mcp'){c.runtime_agent=v.agent;c.agent_profile=v['agent-profile']||c.agent_profile;await startMcp(c);return;}
  if(cmd==='doctor'){const result=await doctor(c);output(result);if(!result.ok)process.exitCode=1;return;}
  if(cmd==='uninstall')return output(await uninstall(root,file,c));
  const client=makeClient(c);let value;
  switch(cmd){
    case 'notify-test':value=await desktopNotify(1);break;
    case 'handoff':value=await handoff(c,client,v.input?jsonFile(expand(v.input)):{id:v.id});break;
    case 'peers':value=await client.json('/v1/devices');break;
    case 'inbox':value=await client.json('/v1/inbox');break;
    case 'outbox':value=await client.json('/v1/outbox');break;
    case 'send':check(v.input,'Use --input TASK.json');value=await sendHandoff(c,client,jsonFile(expand(v.input)));break;
    case 'receive':value=await receiveHandoff(c,client,v.id);break;
    case 'status':check(v.id&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v.id),'Use --id ID');value=await client.json(`/v1/handoffs/${v.id}`);break;
    case 'receipt':check(v.id&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v.id),'Use --id ID');check(['accepted','started','completed','rejected','failed'].includes(v.state),'Invalid receipt state');check(v.code&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(v.code),'Use --code REASON');value=await client.json(`/v1/handoffs/${v.id}/receipts`,'POST',{request_id:v['request-id']||crypto.randomUUID(),state:v.state,code:v.code});break;
    case 'cancel':check(v.id&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v.id),'Use --id ID');value=await client.json(`/v1/handoffs/${v.id}`,'DELETE');break;
    default:throw new Error('Unknown command. Run agent-handoff --help');
  }
  output(value);
}
main().catch(e=>{process.stderr.write(`agent-handoff: ${e.message}\n`);process.exitCode=1;});
