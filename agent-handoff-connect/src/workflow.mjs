import { check, endpoint } from './util.mjs';
import { sendHandoff, receiveHandoff } from './handoff.mjs';

const aliases = { dsh:'deepseek.harness', deepseek:'deepseek.harness', hermes:'hermes', codex:'openai.desktop', chatgpt:'openai.desktop', openai:'openai.desktop' };
const normalize = text => text.trim().normalize('NFC').toLowerCase();
const choice = (status, message, choices) => ({status,message,choices});
export function matchesRoute(c, row) {
  return (!c.runtime_agent || row.adapter_id === c.runtime_agent || row.adapter_id === 'generic') &&
    (!c.runtime_agent || row.profile_id === (c.agent_profile || 'default'));
}
export async function pendingInbox(c, client, {after=0, maxPages=100, timeout=120000}={}) {
  const items=[]; let cursor=after;
  for(let page=0;page<maxPages;page++) {
    const result=await client.json(`/v1/inbox?after=${cursor}&limit=100`,'GET',undefined,{timeout});
    check(Array.isArray(result.items) && Number.isSafeInteger(result.next_cursor) && result.next_cursor>=cursor,'Invalid inbox response');
    items.push(...result.items.filter(row=>row.status==='ready' && row.expires_at>Date.now() &&
      ['pending','verified'].includes(row.receipt_state) && matchesRoute(c,row)));
    if(result.items.length<100) return {items,next_cursor:result.next_cursor,complete:true};
    check(result.next_cursor>cursor,'Inbox cursor did not advance'); cursor=result.next_cursor;
  }
  return {items,next_cursor:cursor,complete:false};
}
export function resolveDestination(c, directory, input) {
  check(typeof input.target==='string' && input.target.trim().length>0 && input.target.length<=128,'Tell me the destination device name or ID.');
  const devices=directory.devices || [], query=normalize(input.target);
  // Never silently send to a partial or fuzzy name, or choose between duplicate display names.
  const exactID=devices.find(d=>normalize(d.id)===query);
  const matches=exactID?[exactID]:devices.filter(d=>normalize(d.name || d.id)===query);
  if(matches.length!==1) return choice('choose_device',matches.length?'有多台设备同名，请选择设备标识。':'没有找到这个设备，请选择列表中的名称或标识。',
    (matches.length?matches:devices).map(d=>({id:d.id,name:d.name,ready:!!d.recipient})));
  const device=matches[0];
  if(!device.recipient) return {status:'recipient_not_ready',device:device.id,message:'接收设备尚未登记加密公钥。请先在该设备安装并连接插件。'};
  let agent;
  if(input.agent!==undefined) {
    check(typeof input.agent==='string','Invalid Agent name'); agent=aliases[normalize(input.agent)] || input.agent;
    check(endpoint(agent),'Invalid Agent identity');
  }
  if(input.agent_profile!==undefined) check(endpoint(input.agent_profile),'Invalid Agent profile');
  const routes=[...new Map((device.agents || []).filter(a=>endpoint(a.adapter_id)&&endpoint(a.profile_id))
    .filter(a=>(!agent || a.adapter_id===agent) && (!input.agent_profile || a.profile_id===input.agent_profile))
    .map(a=>[a.adapter_id+'\n'+a.profile_id,a])).values()];
  const live=routes.filter(a=>a.last_seen_at && Date.now()-a.last_seen_at<90_000);
  const candidates=live.length?live:routes;
  let route;
  if(candidates.length===1) route=candidates[0];
  else if(candidates.length===0 && agent) route={adapter_id:agent,profile_id:input.agent_profile || 'default'};
  else return choice('choose_agent',candidates.length?'这台设备有多个 Agent 路由，请选择一个。':'这台设备尚未上报 Agent，请连接目标 Agent，或指定它的名称。',
    candidates.map(a=>({device:device.id,agent:a.adapter_id,agent_profile:a.profile_id})));
  return {status:'resolved',device:device.id,device_name:device.name,adapter:route.adapter_id,agent_profile:route.profile_id};
}
export async function handoff(c, client, input={}) {
  const action=input.action || (input.target!==undefined?'send':'receive');
  check(['send','receive','list'].includes(action),'Use action send, receive or list');
  if(action==='send') {
    const destination=resolveDestination(c,await client.json('/v1/devices'),input);
    if(destination.status!=='resolved') return destination;
    check(typeof input.context==='string' && input.context.trim().length>0,'请由当前 Agent 从本次会话整理真实上下文，作为 context 发送；不要让用户重写会话。');
    const title=input.title || input.context.trim().split('\n')[0].slice(0,100);
    const result=await sendHandoff(c,client,{id:input.id,to:destination.device,adapter:destination.adapter,agent_profile:destination.agent_profile,
      title,context:input.context,next_steps:input.next_steps || '阅读交接上下文和文件，按其中的待办继续工作。',files:input.files || []});
    return {...result,destination,message:`已交接给 ${destination.device_name || destination.device}。请在接收端说“接力”。`};
  }
  check(input.target===undefined && input.context===undefined && input.files===undefined,'Send fields require action send');
  if(input.id && action!=='list') return {status:'received',...await receiveHandoff(c,client,input.id)};
  const inbox=await pendingInbox(c,client);
  if(!inbox.items.length && inbox.complete) return {status:'empty',message:'当前没有待接力任务。'};
  if(action==='list' || inbox.items.length!==1 || !inbox.complete)
    return {...choice('choose_handoff','请选择要接力的任务；不会擅自选择最新一条。',inbox.items.map(row=>({id:row.id,sender:row.sender,created_at:row.created_at,size:row.size,receipt_state:row.receipt_state}))),complete:inbox.complete,next_cursor:inbox.next_cursor};
  return {status:'received',...await receiveHandoff(c,client,inbox.items[0].id)};
}
