import fs from 'node:fs';
import path from 'node:path';
import { exec, sha, atomic, privateDir, locked, jsonFile } from './util.mjs';
import { pendingInbox } from './workflow.mjs';
import { listSessions } from './sessions.mjs';

export function notificationCommand(count, platform=process.platform, env=process.env) {
  const title='Agent Handoff · 收到接力';
  const body=`收到 ${count} 个新会话或交接。对 Agent 说“查看远端会话”或“接力”选择接收。`;
  const options={timeout:12_000,windowsHide:true,maxBuffer:32*1024};
  if(platform==='darwin') return {file:'/usr/bin/osascript',args:['-e','on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run',title,body],options};
  if(platform==='linux') {
    if(!env.DISPLAY && !env.WAYLAND_DISPLAY && !env.DBUS_SESSION_BUS_ADDRESS) return undefined;
    return {file:'notify-send',args:['--app-name=Agent Handoff','--expire-time=10000','--',title,body],options};
  }
  if(platform==='win32') {
    const script='$s = New-Object -ComObject WScript.Shell; [void]$s.Popup($env:AGENT_HANDOFF_NOTICE_BODY, 10, $env:AGENT_HANDOFF_NOTICE_TITLE, 64)';
    return {file:'powershell.exe',args:['-NoProfile','-NonInteractive','-Command',script],options:{...options,env:{...env,AGENT_HANDOFF_NOTICE_TITLE:title,AGENT_HANDOFF_NOTICE_BODY:body}}};
  }
}
export async function desktopNotify(count, {platform=process.platform,env=process.env,run=exec}={}) {
  const command=notificationCommand(count,platform,env);
  if(!command) return {status:'unavailable',reason:'需要可用的桌面通知会话。'};
  try {await run(command.file,command.args,command.options);return {status:'submitted',platform};}
  catch(e){return {status:'unavailable',reason:e.code || 'notification_failed'};}
}

export function createInboxWatcher(c,client,{onNotice=async()=>{},notify=desktopNotify,intervalMs=10_000}={}) {
  let timer,busy=false,stopped=false,lastError=null,lastDesktop=null,completion=Promise.resolve();
  const key=sha((c.runtime_agent || 'manual')+'\n'+(c.agent_profile || 'default')).slice(0,24);
  const root=path.join(c.state_dir,'notifications'),file=path.join(root,key+'.json');
  async function poll() {
    if(stopped || busy) return; busy=true;
    try {
      await privateDir(root);
      await locked(file+'.lock',async()=>{
        if(stopped) return;
        const state=fs.existsSync(file)?jsonFile(file):{cursor:0};
        const inbox=await pendingInbox(c,client,{after:state.cursor,maxPages:5,timeout:12_000});
        let shared={items:[],next_cursor:state.session_cursor || 0};
        try {shared=await listSessions(c,client,{after:state.session_cursor || 0,limit:100,timeout:12_000,sync:false});}
        catch(e){if(e.status!==404)throw e;}
        if(stopped) return;
        const sharedCount=shared.items.filter(row=>typeof row.title==='string' && typeof row.source_agent==='string' && row.sender!==c.device_id && row.receive_state==='available').length;
        const count=inbox.items.length+sharedCount;
        if(count) {
          // MCP logging is independent of desktop notification permissions. No payload is downloaded.
          await onNotice({event:'handoff_available',count,message:'收到新的会话或交接，对 Agent 说“查看远端会话”或“接力”选择接收。'});
          if(c.notifications!=='off') lastDesktop=await notify(count);
        }
        await atomic(file,JSON.stringify({cursor:inbox.next_cursor,session_cursor:shared.next_cursor,updated_at:Date.now()}));
      }); lastError=null;
    } catch(e) {
      // Other connections for this same route share a private cursor and lock.
      if(!String(e.message).startsWith('Operation is locked:')) lastError=e.message;
    } finally {busy=false;}
  }
  function tick(){if(busy || stopped)return completion;completion=poll();return completion;}
  return {
    poll:tick,
    start(){if(timer || stopped)return;void tick();timer=setInterval(()=>void tick(),intervalMs);timer.unref();},
    async stop(){stopped=true;clearInterval(timer);timer=undefined;await completion;},
    status(){return {enabled:c.notifications!=='off',poll_interval_seconds:intervalMs/1000,last_error:lastError,desktop:lastDesktop,
      note:'系统接收通知请求成功不保证屏幕显示；取决于桌面会话、通知权限和勿扰设置。宿主退出后不再检查。'};}
  };
}
