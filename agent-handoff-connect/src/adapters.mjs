import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, isSeq } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { atomic, check, VERSION, identifier, sha } from './util.mjs';

export const AGENTS={
  dsh:{name:'DeepSeek Harness（桌面 / CLI）',adapter:'deepseek.harness'},
  hermes:{name:'Hermes',adapter:'hermes'},
  openai:{name:'ChatGPT Desktop / Codex（共用 MCP 配置）',adapter:'openai.desktop'},
};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function locations(home,env=process.env) {
  return {dsh:path.join(env.DSH_HOME||path.join(home,'.dsh'),'profiles','desktop','cordis.patch.yml'),
    hermes:path.join(env.HERMES_HOME||path.join(home,'.hermes'),'config.yaml'),
    openai:path.join(env.CODEX_HOME||path.join(home,'.codex'),'config.toml')};
}
export function spec({agent,profile,file,runtime,config,workspace,node=process.execPath,agentProfile='default'}) {
  check(AGENTS[agent]&&identifier(profile),'Unknown Agent or relay profile');
  const name=profile==='default'?'agent_handoff':`agent_handoff_${sha(profile).slice(0,12)}`;
  const args=[runtime,'mcp','--config',config,'--agent',AGENTS[agent].adapter,'--agent-profile',agentProfile];
  let entry={command:node,args};
  if(agent==='openai')entry={...entry,startup_timeout_sec:30,tool_timeout_sec:3600,enabled:true};
  if(agent==='dsh')entry={id:`agent-handoff-${profile}`,name:'@deepseek-ai/dsh-mcp-client',config:{serverName:name,transport:'stdio',command:node,args,cwd:workspace,toolCallTimeoutMs:3600000}};
  return {agent,file:path.resolve(file),key:agent==='dsh'?entry.id:name,entry,version:VERSION};
}
export function editConfig(source,s,old,{remove=false}={}) {
  if(s.agent==='openai'){
    const parsed=parseToml(source||'');const current=parsed.mcp_servers?.[s.key];
    if(current)check(old&&same(current,old.entry),'MCP server name is already in use or was modified; choose another relay profile');
    if(remove&&!current)return source;
    const lines=source.split(/\r?\n/);let start=-1,end=lines.length;
    const section=`mcp_servers.${s.key}`;
    for(let i=0;i<lines.length;i++){
      const match=lines[i].match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
      if(match){if(start>=0){end=i;break;}if(match[1]===section)start=i;}
    }
    check(!current||start>=0,'Existing MCP entry uses a non-managed TOML format; choose another relay profile');
    const table=remove?'':`[${section}]\n`+Object.entries(s.entry).map(([k,v])=>`${k} = ${JSON.stringify(v)}`).join('\n')+'\n';
    let output=start>=0?[...lines.slice(0,start),...(table?[table.trimEnd(),'']:[]),...lines.slice(end)].join('\n'):source.trimEnd()+'\n\n'+table;
    parseToml(output);return output.replace(/^\n\n/,'');
  }
  const doc=parseDocument(source|| (s.agent==='dsh'?'[]\n':'{}\n'),{keepSourceTokens:true});
  check(!doc.errors.length,'Existing YAML config is invalid');
  if(s.agent==='hermes'){
    const current=doc.getIn(['mcp_servers',s.key])?.toJSON?.();
    if(current)check(old&&same(current,old.entry),'MCP server name is already in use or was modified; choose another relay profile');
    if(remove)doc.deleteIn(['mcp_servers',s.key]);else doc.setIn(['mcp_servers',s.key],s.entry);
  }else{
    check(isSeq(doc.contents),'DSH cordis.patch.yml must be a YAML patch array');
    const found=[];
    for(const patch of doc.contents.items){const inserts=patch?.get?.('insert');if(isSeq(inserts))for(let i=0;i<inserts.items.length;i++)if(inserts.items[i]?.get?.('id')===s.key)found.push({inserts,i,node:inserts.items[i]});}
    check(found.length<=1,'Duplicate DSH plugin IDs');
    if(found.length){check(old&&same(found[0].node.toJSON(),old.entry),'DSH plugin ID is already in use or was modified');found[0].inserts.items.splice(found[0].i,1);}
    if(!remove)doc.add({insert:[s.entry]});
  }
  return doc.toString();
}
export async function applyAdapters(specs,previous=[]) {
  // Plan every edit first; malformed user config cannot leave half an installation.
  const paths=new Map();const plans=[];
  for(const s of [...previous.filter(o=>!specs.some(n=>n.file===o.file&&n.key===o.key&&n.agent===o.agent)),...specs]){
    const remove=!specs.includes(s);const old=previous.find(o=>o.file===s.file&&o.key===s.key&&o.agent===s.agent);
    const original=paths.get(s.file)?.text??(fs.existsSync(s.file)?fs.readFileSync(s.file,'utf8'):'');
    const text=editConfig(original,s,old,{remove});paths.set(s.file,{text,original:paths.get(s.file)?.original??original});
  }
  const done=[];
  try{for(const [file,{text,original}]of paths){const before=fs.existsSync(file)?fs.readFileSync(file):null;
    check((before?.toString()||'')===original,'Agent config changed during setup; retry after saving the other editor');
    const backup=await atomic(file,text,{backup:true});done.push({file,before});plans.push({file,backup});
  }}catch(e){for(const item of done.reverse()){if(item.before)await atomic(item.file,item.before);else await fs.promises.rm(item.file,{force:true});}throw e;}
  return {installed:specs,changes:plans};
}
