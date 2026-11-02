'use strict';
const $ = id => document.getElementById(id);
let csrf = '', snapshot, timer, busy = false, currentView = 'overview';
const date = n => n ? new Date(n).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
const bytes = n => { let i = 0; const units = ['B','KB','MB','GB','TB']; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${Number(n || 0).toFixed(i ? 1 : 0)} ${units[i]}`; };
const recent = n => n && snapshot.now - n < 90_000;
const states = { uploading:'上传中', ready:'可接收', cancelled:'已取消', expired:'已过期', pending:'等待接收', verified:'密文已校验', accepted:'已接受', started:'已开始', completed:'已完成', rejected:'已拒绝', failed:'失败' };
const kinds = { created:'创建交接', upload_chunk:'上传确认', upload_failed:'上传未完成', published:'发布交接', download:'下载发送完成', download_aborted:'下载中断', receipt:'接收端回执', cancelled:'取消交接', expired:'交接过期', agent_connected:'Agent 身份心跳', device_added:'登记设备', device_renamed:'设备改名', device_rotated:'更新凭证', device_revoked:'撤销设备' };
function el(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function set(id, text) { $(id).textContent = text; }
function badge(text, cls = '') { return el('span', text, `badge ${cls}`); }
function identity(name, id) { const box = el('div',undefined,'identity'); box.append(el('b',name || id)); if (name && name !== id) box.append(el('small',id)); return box; }
function notify(text, success = false) { set('notice', text); $('notice').className = `notice${success ? ' success' : ''}`; $('notice').hidden = false; }
const errors = { invalid_login:'账号或密码不正确', login_rate_limit:'尝试次数过多，请稍后重试', device_exists:'设备标识已存在', invalid_device_id:'设备标识格式不正确', invalid_device_name:'请输入 1–128 个字符的名称，不可包含控制字符', device_not_found:'设备不存在，请刷新列表', origin_rejected:'请求来源不匹配', csrf_rejected:'会话校验失败，请重新登录' };
async function api(path, data) {
  const res = await fetch(`/admin/api/${path}`, { method: data === undefined ? 'GET' : 'POST', credentials:'same-origin', headers: data === undefined ? {} : { 'Content-Type':'application/json', 'X-CSRF-Token':csrf }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(12_000) });
  const value = await res.json();
  if (!res.ok) { if (res.status === 401 && path !== 'login') showLogin(); throw new Error(errors[value.error] || value.error || '请求失败'); }
  return value;
}
function showLogin() { clearTimeout(timer); csrf = ''; $('dashboard').hidden = true; $('loginView').hidden = false; }
async function enter(user) { csrf = user.csrf; set('adminName', user.username); $('loginView').hidden = true; $('dashboard').hidden = false; view(currentView); await refresh(); }
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault(); const button = e.submitter; button.disabled = true; set('loginError','');
  try { const user = await api('login', { username:$('username').value, password:$('password').value }); $('password').value = ''; await enter(user); }
  catch (err) { set('loginError', err.message); } finally { button.disabled = false; }
});
$('logoutButton').addEventListener('click', async () => { try { await api('logout', {}); showLogin(); } catch (err) { notify(err.message); } });
function view(name) {
  currentView = name; const labels = { overview:['数据流总览','查看设备连接与任务交接的每一步。'], agents:['设备与 Agent','独立设备凭证，真实 Agent 心跳。'], flows:['交接记录','查看投递状态、接收端回执与传输事件。'] };
  for (const key of Object.keys(labels)) $(`${key}Section`).hidden = name !== key;
  document.querySelectorAll('.nav-button').forEach(n => { n.classList.toggle('active', n.dataset.view === name); if(n.dataset.view === name) n.setAttribute('aria-current','page'); else n.removeAttribute('aria-current'); });
  $('mainNavigation').classList.remove('open'); $('menuButton').setAttribute('aria-expanded','false');
  set('pageTitle', labels[name][0]); set('breadcrumbLabel',labels[name][0]); set('pageDescription',labels[name][1]);
  if (name === 'overview') requestAnimationFrame(drawNetwork);
}
document.querySelectorAll('.nav-button').forEach(n => n.addEventListener('click', () => view(n.dataset.view)));
$('menuButton').addEventListener('click',()=>{ const open=$('mainNavigation').classList.toggle('open'); $('menuButton').setAttribute('aria-expanded',String(open)); });
document.addEventListener('keydown',e=>{if(e.key==='Escape'){ $('mainNavigation').classList.remove('open'); $('menuButton').setAttribute('aria-expanded','false'); }});
$('allTransfersButton').addEventListener('click', () => view('flows'));
document.querySelectorAll('.close-dialog').forEach(n => n.addEventListener('click', () => n.closest('dialog').close()));
function guide() { set('heartbeatExample', '# 在要接入的设备上运行；先保存 CA 证书和设备凭证\nnpx --yes --cafile /path/to/relay-ca.crt --package=https://relay.example.com:17862/downloads/agent-handoff-connect-0.5.0.tgz agent-handoff\n\n# 向导中选择 Agent，填写中转服务 URL、凭证、CA 和工作目录。\n# 默认中转地址：https://relay.example.com:17861\n# 可选择其他兼容中转，也可用 --profile 保存多套服务。'); $('guideDialog').showModal(); }
$('guideButton').addEventListener('click', guide); $('agentGuideButton').addEventListener('click', guide);
async function refresh() {
  clearTimeout(timer); if (busy || !csrf) return; busy = true;
  try { snapshot = await api('snapshot'); render(); set('connectionLabel','● 数据已连接'); if ($('notice').textContent.startsWith('数据更新失败：')) $('notice').hidden = true; set('lastUpdated',`更新于 ${date(snapshot.now)} · 北京时间`); }
  catch (err) { set('connectionLabel','● 更新中断'); if (csrf) notify(`数据更新失败：${err.message}。当前显示上次数据。`); }
  finally { busy = false; if (csrf) timer = setTimeout(refresh, document.hidden ? 10_000 : 2000); }
}
$('refreshButton').addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
function render() {
  const s = snapshot, activeDevices = s.devices.filter(d => d.active && recent(d.last_seen_at));
  set('clockLabel',date(s.now)); set('navDeviceCount',s.devices.filter(d => d.active).length);
  set('metricDevices',s.devices.filter(d => d.active).length); set('metricDeviceCaption',`${activeDevices.length} 台近期活动 · ${s.devices.filter(d => !d.active).length} 台已撤销`);
  const heartbeatCount = s.agents.filter(a => a.device_active && a.source === 'heartbeat' && recent(a.last_seen_at)).length;
  set('metricAgents',heartbeatCount);
  set('agentSummary',`${s.devices.filter(d=>d.active).length} 台设备已登记 · ${heartbeatCount} 个 Agent 心跳活跃。设备凭证登记后，还需由 Agent 主动上报身份。`);
  set('metricActive',s.active_transfers.length); set('metricTransferCaption',`${s.totals.uploading} 个待上传完成 · ${s.totals.ready} 个可接收`);
  set('metricStorage',bytes(s.totals.reserved_bytes)); $('storageBar').style.width = `${Math.min(100,s.totals.reserved_bytes / s.totals.quota * 100)}%`;
  set('metricStorageCaption',`配额 ${bytes(s.totals.quota)} · 磁盘剩余 ${bytes(s.totals.disk_available)}`);
  set('relayState',s.active_transfers.length ? `${s.active_transfers.length} 路传输中` : '当前无传输');
  set('networkFooter',`${activeDevices.length} 台设备近期活动 · ${s.totals.handoffs} 次交接`);
  renderNetwork(); renderTraffic(); renderEvents(); renderTransfers(); renderDevices(); renderAgents();
}
function renderNetwork() {
  const devices = snapshot.devices.filter(d => d.active).slice(0,6);
  for (const id of ['sourceNodes','targetNodes']) {
    $(id).replaceChildren();
    if (!devices.length) $(id).append(el('p','尚无设备','empty-state'));
    for (const d of devices) {
      const n = el('div',undefined,`device-node${recent(d.last_seen_at) ? ' active' : ''}`); n.dataset.device = d.id;
      n.append(el('span',d.id.startsWith('mac') ? 'M' : d.id.startsWith('win') ? 'W' : 'L','node-icon'));
      const copy = el('div',undefined,'node-copy'); copy.append(el('b',d.name || d.id)); if(d.name && d.name !== d.id) copy.append(el('small',d.id));
      n.append(copy, el('i',undefined,`status-dot${recent(d.last_seen_at) ? '' : ' gray'}`)); $(id).append(n);
    }
  }
  requestAnimationFrame(drawNetwork);
}
function svg(tag, attrs) { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key,value] of Object.entries(attrs)) n.setAttribute(key,value); return n; }
function drawNetwork() {
  if (!snapshot || currentView !== 'overview') return;
  const graph = $('networkGraph').getBoundingClientRect(), relay = $('relayNode').getBoundingClientRect(), canvas = $('networkSvg'); canvas.replaceChildren(); canvas.setAttribute('viewBox',`0 0 ${graph.width} ${graph.height}`);
  for (const side of ['sourceNodes','targetNodes']) for (const node of $(side).children) {
    if (!node.dataset.device) continue;
    const left = side === 'sourceNodes', r = node.getBoundingClientRect(), id = node.dataset.device;
    const active = snapshot.active_transfers.some(t => left ? t.direction === 'upload' && t.device_id === id : t.direction === 'download' && t.device_id === id);
    const used = snapshot.transfers.some(t => left ? t.sender === id : t.recipient === id);
    const x1 = left ? r.right-graph.left : relay.right-graph.left, x2 = left ? relay.left-graph.left : r.left-graph.left;
    const y1 = left ? r.top+r.height/2-graph.top : relay.top+relay.height/2-graph.top, y2 = left ? relay.top+relay.height/2-graph.top : r.top+r.height/2-graph.top;
    const middle = (x1+x2)/2;
    canvas.append(svg('path',{ d:`M${x1},${y1} C${middle},${y1} ${middle},${y2} ${x2},${y2}`, class:`connection-path${active ? ' transmitting' : used ? ' recent' : ''}` }));
  }
}
window.addEventListener('resize',()=>{drawNetwork();if(snapshot && currentView==='overview')renderTraffic();});
function renderTraffic() {
  const now = Math.floor(snapshot.now/60000)*60000, points = Array.from({length:60},(_,i) => snapshot.traffic.find(p => p.minute === now-(59-i)*60000) || {uploaded:0,downloaded:0});
  set('trafficUpload',bytes(points.reduce((n,p)=>n+p.uploaded,0))); set('trafficDownload',bytes(points.reduce((n,p)=>n+p.downloaded,0)));
  set('trafficNote',`统计始于 ${date(snapshot.telemetry_since)}。下载按服务端发送字节统计，接收结果以回执为准。`);
  const chart = $('trafficChart'); chart.replaceChildren();
  const width=Math.max(280,chart.clientWidth || 600), height=150, left=48, right=12, top=12, bottom=28, plotW=width-left-right, plotH=height-top-bottom;
  chart.setAttribute('viewBox',`0 0 ${width} ${height}`);
  const peak=Math.max(0,...points.flatMap(p=>[p.uploaded,p.downloaded]));
  const raw=Math.max(1,peak/3), pow=10**Math.floor(Math.log10(raw)), step=[1,2,5,10].find(v=>v*pow>=raw)*pow, max=step*3;
  const text=(value,x,y,anchor='start')=>{ const n=svg('text',{x,y,fill:'#5d5f60','font-size':11,'text-anchor':anchor}); n.textContent=value; chart.append(n); };
  for(let i=0;i<=3;i++){const y=top+plotH-i*plotH/3;chart.append(svg('line',{x1:left,x2:width-right,y1:y,y2:y,stroke:'#e8eaec'}));text(bytes(i*step),left-8,y+4,'end');}
  for(const minute of [0,20,40,59]){ const x=left+minute*plotW/59; text(minute===59?'现在':`${59-minute} 分钟前`,x,height-6,minute===0?'start':minute===59?'end':'middle'); }
  for(const [key,color,dash] of [['downloaded','#61676d','5 4'],['uploaded','#1b6c80','']]){
    chart.append(svg('polyline',{points:points.map((p,i)=>`${left+i*plotW/59},${top+plotH-p[key]/max*plotH}`).join(' '),fill:'none',stroke:color,'stroke-width':2,'stroke-dasharray':dash,'stroke-linejoin':'round'}));
  }
}

function eventText(e) { return `${kinds[e.kind] || e.kind}${e.code ? ` · ${states[e.code] || e.code}` : ''}${e.bytes ? ` · ${bytes(e.bytes)}` : ''}`; }
function renderEvents() {
  const root = $('eventList'); root.replaceChildren(); set('eventCount',snapshot.events.length);
  if (!snapshot.events.length) root.append(el('div','还没有活动。设备请求、心跳和交接会显示在这里。','empty-state'));
  for (const e of snapshot.events.slice(0,20)) { const n = el('div',undefined,'event-item'); n.append(el('span','↗','event-symbol')); const body = el('div',undefined,'event-copy'); body.append(el('b',eventText(e)),el('small',[e.device_id,e.peer_id && `→ ${e.peer_id}`,e.handoff_id].filter(Boolean).join(' '))); n.append(body,el('time',new Date(e.created_at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))); root.append(n); }
}
function renderTransfers() {
  if (!snapshot) return;
  for (const [id,rows] of [['recentTransfersBody',snapshot.transfers.slice(0,4)],['allTransfersBody',snapshot.transfers.filter(t => (!($('flowStatus').value) || t.status === $('flowStatus').value) && [t.id,t.sender,t.recipient,t.adapter_id,t.profile_id].join(' ').toLowerCase().includes($('flowSearch').value.toLowerCase()))]]) {
    const root = $(id); root.replaceChildren(); if(id==='allTransfersBody') set('flowCount',`${rows.length.toLocaleString('zh-CN')} 条匹配记录 · 最近 ${snapshot.transfers.length.toLocaleString('zh-CN')} 条交接`);
    if (!rows.length) { const row = el('tr'), cell = el('td','暂无匹配的交接记录','empty-cell'); cell.colSpan = 6; row.append(cell); root.append(row); }
    for (const t of rows) {
      const row = el('tr',undefined,'transfer-row'); row.tabIndex = 0; row.setAttribute('role','button'); row.setAttribute('aria-label',`查看交接 ${t.id}`);
      const active = snapshot.active_transfers.filter(a => a.handoff_id === t.id);
      const status = t.status === 'ready' && t.receipt_state !== 'pending' ? t.receipt_state : t.status;
      const idCell=el('td'), idLabel=el('span',t.id,'id-label'); idLabel.title=t.id; idCell.append(idLabel);
      const route=el('td'); route.append(el('span',t.sender,'route-label'),el('span',`→ ${t.recipient}`,'cell-sub'));
      const agent=el('td'); agent.dataset.label='Agent'; agent.append(el('span',t.adapter_id),el('span',t.profile_id,'cell-sub'));
      const size=el('td',undefined,'num'); size.append(el('span',bytes(t.size)),el('span',`${t.size ? Math.floor(t.offset/t.size*100) : 0}% 已上传`,'cell-sub'));
      for(const a of active) size.append(el('span',`${a.direction==='upload'?'分片上传':'下载'} ${bytes(a.bytes)}/${bytes(a.total)}`,'cell-sub'));
      row.append(idCell,route,agent,size);
      const cell = el('td'); cell.append(badge(states[status] || status, t.status)); const created=el('td',undefined,'num'); const stamp=date(t.created_at).split(' ');created.append(el('span',stamp[0]),el('span',stamp.slice(1).join(' '),'cell-sub')); row.append(cell,created);
      row.addEventListener('click',()=>details(t.id)); row.addEventListener('keydown',e=>{if(e.key === 'Enter' || e.key === ' ') {e.preventDefault(); details(t.id);}}); root.append(row);
    }
  }
}
$('flowSearch').addEventListener('input',renderTransfers); $('flowStatus').addEventListener('change',renderTransfers);
async function details(id) {
  const root = $('transferDetails'); root.replaceChildren(el('p','正在读取…')); $('transferDialog').showModal();
  try {
    const t = await api(`handoffs/${encodeURIComponent(id)}`); root.replaceChildren(); const grid = el('dl',undefined,'detail-grid');
    for (const [label,value] of [['标识',t.id],['来源 → 目标',`${t.sender} → ${t.recipient}`],['目标 Agent',`${t.adapter_id} / ${t.profile_id}`],['上传',`${bytes(t.offset)} / ${bytes(t.size)}`],['投递状态',states[t.status]],['接收端状态',states[t.receipt_state]],['创建时间',date(t.created_at)],['过期时间',date(t.expires_at)]]) grid.append(el('dt',label),el('dd',value)); root.append(grid,el('h3','接收端回执','detail-heading'),el('p','回执由目标设备报告，不代表控制台独立验证了模型执行结果。','muted'));
    if (!t.receipts.length) root.append(el('p','暂无回执','muted'));
    for (const r of t.receipts) root.append(el('p',`${date(r.created_at)} · ${states[r.state] || r.state}${r.code ? ` · ${r.code}` : ''}`,'detail-receipt'));
    root.append(el('h3','传输事件','detail-heading'));
    for (const e of t.events) root.append(el('p',`${date(e.created_at)} · ${eventText(e)}`,'detail-receipt'));
    if (!t.events.length) root.append(el('p','监控启用前的传输没有流量事件。','muted'));
  } catch (err) { root.replaceChildren(el('p',err.message)); }
}
function download(value) { const url = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'})); const a = el('a'); a.href = url; a.download = `${value.device_id}.json`; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),10_000); }
function renderDevices() {
  const root = $('devicesBody'); root.replaceChildren();
  if (!snapshot.devices.length) { const row=el('tr'),cell=el('td','尚未登记设备。点击“登记设备”下载专用凭证。','empty-cell'); cell.colSpan=5;row.append(cell);root.append(row); }
  for (const d of snapshot.devices) {
    const row = el('tr'), name = el('td'); name.append(identity(d.name,d.id)); const status = el('td'); status.append(badge(!d.active ? '已撤销' : recent(d.last_seen_at) ? '近期活动' : '暂无近期活动', !d.active ? 'revoked' : recent(d.last_seen_at) ? 'heartbeat' : 'route'));
    const seen=el('td',undefined,'num'); const stamp=date(d.last_seen_at).split(' '); seen.append(el('span',stamp[0])); if(stamp.length>1)seen.append(el('span',stamp.slice(1).join(' '),'cell-sub'));
    seen.dataset.label='最近活动'; const requests=el('td',d.requests.toLocaleString('zh-CN'),'num'); requests.dataset.label='请求次数'; row.append(name,status,seen,requests); const actions = el('td',undefined,'device-actions');
    const renameButton = el('button','改名','text-button');
    renameButton.setAttribute('aria-label', `改名 ${d.name || d.id}`);
    renameButton.addEventListener('click',()=>{
      $('renameDeviceId').value = d.id; $('renameDeviceName').value = d.name || d.id;
      set('renameError',''); $('renameDialog').showModal(); $('renameDeviceName').focus();
    }); actions.append(renameButton);
    for (const [action,label] of [['rotate','更新凭证'],['revoke','撤销']]) {
      if (!d.active && action === 'revoke') continue; const button = el('button',label,action === 'revoke' ? 'text-button danger' : 'text-button');
      if(action === 'rotate') button.title = '生成新的访问令牌。旧令牌立即失效，设备端需重新导入凭证。';
      button.addEventListener('click',async()=>{ if (!confirm(action === 'rotate' ? `更新 ${d.id} 的凭证？原凭证会立即失效。` : `撤销 ${d.id}？这台设备将无法继续访问。`)) return; button.disabled = true;
        try { const value = await api(`devices/${encodeURIComponent(d.id)}/${action}`,{}); if(action === 'rotate') download(value); notify(action === 'rotate' ? '凭证已更新，请保存下载文件并替换设备上的旧凭证。' : '设备已撤销。',true); await refresh(); } catch(err) {notify(err.message);} finally {button.disabled=false;}
      }); actions.append(button);
    }
    row.append(actions); root.append(row);
  }
}
function renderAgents() {
  const root = $('agentCards'); root.replaceChildren();
  if (!snapshot.agents.length) { const empty=el('div',undefined,'empty-state'); empty.append(el('strong','还没有 Agent 上报身份'),el('span','在目标设备上启动心跳后，这里会显示 Agent 名称、版本和最近活动。')); root.append(empty); }
  for (const a of snapshot.agents) {
    const card = el('article',undefined,'agent-card'), head = el('div',undefined,'agent-card-top'); head.append(el('span','◉','agent-avatar'), badge(!a.device_active ? '设备已撤销' : a.source === 'route' ? '仅交接路由' : recent(a.last_seen_at) ? '心跳活跃' : '心跳已超时',!a.device_active ? 'revoked' : a.source === 'route' ? 'route' : recent(a.last_seen_at) ? 'heartbeat' : 'route'));
    card.append(head,el('h3',a.name),el('p',`${a.adapter_id} / ${a.profile_id}`,'agent-adapter'),el('p',`设备：${a.device_name && a.device_name !== a.device_id ? `${a.device_name} (${a.device_id})` : a.device_id}`),el('p',`版本：${a.version || '未报告'}`),el('small',a.source === 'route' ? '仅有目标路由记录，尚未收到身份心跳。' : `最近心跳：${date(a.last_seen_at)}`)); root.append(card);
  }
}
$('newDeviceButton').addEventListener('click',()=>{ $('deviceForm').reset(); set('deviceError',''); $('deviceDialog').showModal(); });
$('deviceForm').addEventListener('submit',async e=>{ e.preventDefault(); e.submitter.disabled = true; try { const value = await api('devices',{id:$('deviceId').value,name:$('deviceName').value || $('deviceId').value}); download(value); $('deviceDialog').close(); notify('设备已登记，专用凭证已下载。请妥善保存。',true); await refresh(); } catch(err) {set('deviceError',err.message);} finally {e.submitter.disabled=false;} });
$('renameForm').addEventListener('submit',async e=>{
  e.preventDefault(); const button=e.submitter; button.disabled=true; set('renameError','');
  try {
    await api(`devices/${encodeURIComponent($('renameDeviceId').value)}/rename`,{name:$('renameDeviceName').value});
    $('renameDialog').close(); notify('设备名称已保存。',true); await refresh();
  } catch(err) {set('renameError',err.message);} finally {button.disabled=false;}
});
api('session').then(enter).catch(showLogin);
