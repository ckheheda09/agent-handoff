import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { check, sha, atomic, privateDir, jsonFile, identifier } from './util.mjs';
import { ensureAge, identity } from './age.mjs';
import { makeClient } from './client.mjs';

export async function pairDevice(options, transport) {
  const key=sha(transport.relay_url+'\n'+options.profile);
  const credentialFile=path.join(options.home,'credentials',key+'.json');
  if(fs.existsSync(credentialFile))return jsonFile(credentialFile);
  const dir=path.join(options.home,'enrollments');await privateDir(dir);
  const file=path.join(dir,key+'.json');
  let state=fs.existsSync(file)?jsonFile(file):{identity_key:'enroll-'+randomUUID()};
  check(identifier(state.identity_key),'Invalid saved enrollment identity');
  const age=await ensureAge(options.home,{bin:options.ageBin,keygen:options.ageKeygen,download:options.downloadAge!==false});
  const localIdentity=await identity(options.home,state.identity_key,age);
  // Save the local identity before issuing a request; failed/retried installs reuse it.
  await atomic(file,JSON.stringify(state)+'\n');
  if(!state.id || state.expires_at<=Date.now()) {
    const request={name:options.deviceName||os.hostname().slice(0,128),os:`${os.platform()} ${os.release()} (${os.arch()})`.slice(0,80),agents:options.agents,recipient:localIdentity.recipient};
    const created=await makeClient(transport).json('/v1/pairings','POST',request,{timeout:15000});
    check(identifier(created.id)&&/^[A-Za-z0-9_-]{43}$/.test(created.device_code)&&/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(created.user_code)&&
      Number.isSafeInteger(created.expires_at)&&created.expires_at>Date.now(),'Invalid pairing response');
    state={...created,identity_key:state.identity_key};await atomic(file,JSON.stringify(state)+'\n');
  }
  const notice={id:state.id,user_code:state.user_code,expires_at:state.expires_at,verification_uri:state.verification_uri,name:options.deviceName||os.hostname().slice(0,128)};
  if(options.onPairing)await options.onPairing(notice);
  else process.stderr.write(`\n配对码：${notice.user_code}\n请在管理网页${notice.verification_uri?' '+notice.verification_uri:''}的“待接入设备”核对配对码并批准。\n等待批准，最长 10 分钟；无需下载设备凭证。\n`);
  const poller=makeClient({...transport,token:state.device_code});
  const timeout=options.pairingTimeoutSeconds??600;
  check(Number.isFinite(timeout)&&timeout>=1&&timeout<=600,'Pairing timeout must be 1–600 seconds');
  const deadline=Math.min(state.expires_at,Date.now()+timeout*1000);
  let interval=Math.max(3,Math.min(30,Number(state.interval_seconds)||3));
  const interrupted=new AbortController();
  const stop=()=>interrupted.abort(new Error('配对等待已取消；申请和本地密钥已保存，可重跑继续。'));
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
  while(Date.now()<deadline) {
    if(interrupted.signal.aborted)throw interrupted.signal.reason;
    let response;
    try {response=await poller.json(`/v1/pairings/${state.id}/poll`,'POST',{}, {timeout:15000});}
    catch(error) {
      if(['pairing_rejected','pairing_expired','pairing_credential_retired','pairing_not_found'].includes(error.code)) {
        await fs.promises.rm(file,{force:true});throw new Error(`配对未完成：${error.code}。重新运行安装可发起新的申请。`);
      }
      if(error.status && error.status<500 && error.status!==429)throw error;
      // Preserve pending identity/code on transient network failures.
      await delay(Math.min(interval*1000,Math.max(0,deadline-Date.now())),undefined,{signal:interrupted.signal});continue;
    }
    if(response.status==='approved') {
      const credential=response.credential;
      check(credential&&identifier(credential.device_id)&&/^[A-Za-z0-9_-]{43}$/.test(credential.token),'Invalid enrolled credential');
      const saved={...credential,relay_url:transport.relay_url,identity_key:state.identity_key};
      await privateDir(path.dirname(credentialFile));await atomic(credentialFile,JSON.stringify(saved)+'\n');
      await fs.promises.rm(file,{force:true});return saved;
    }
    check(['pending','slow_down'].includes(response.status),'Unexpected pairing state');
    interval=Math.max(interval,Math.min(30,Number(response.interval_seconds)||3));
    await delay(Math.min(interval*1000,Math.max(0,deadline-Date.now())),undefined,{signal:interrupted.signal});
  }
  throw new Error('等待配对批准超时；申请和本地密钥已保存。可在有效期内重跑同一安装命令继续。');
  } finally {process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
