import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const VERSION = '0.7.0';
export const exec = promisify(execFile);
export function check(ok, message) { if (!ok) throw new Error(message); }
export const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
export const endpoint = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value);
export const sha = value => createHash('sha256').update(value).digest('hex');
export async function shaFile(file) { const h=createHash('sha256'); for await(const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); }
export function rootDir(home = os.homedir(), platform = process.platform) {
  return process.env.AGENT_HANDOFF_HOME || (platform==='win32' ? path.join(process.env.LOCALAPPDATA || path.join(home,'AppData','Local'),'AgentHandoff') : path.join(home,'.config','agent-handoff'));
}
export async function privateDir(dir) {
  await fs.promises.mkdir(dir,{recursive:true,mode:0o700});
  check(!(await fs.promises.lstat(dir)).isSymbolicLink(), 'Private directory cannot be a symlink');
  if(process.platform==='win32') {
    const {stdout}=await exec('whoami',[],{windowsHide:true});
    await exec('icacls',[dir,'/inheritance:r','/grant:r',`${stdout.trim()}:(OI)(CI)F`],{windowsHide:true});
  } else await fs.promises.chmod(dir,0o700);
}
export async function atomic(file, value, {backup=false, mode=0o600}={}) {
  await fs.promises.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  let previous;
  try { check(!(await fs.promises.lstat(file)).isSymbolicLink(),'Config cannot be a symlink'); previous=await fs.promises.readFile(file); }
  catch(e){if(e.code!=='ENOENT')throw e;}
  let backupFile;
  if(backup && previous) {backupFile=`${file}.handoff-backup-${Date.now()}-${randomUUID().slice(0,8)}`;await fs.promises.writeFile(backupFile,previous,{flag:'wx',mode});}
  const temp=`${file}.${randomUUID()}.tmp`;
  try {await fs.promises.writeFile(temp,value,{flag:'wx',mode});await fs.promises.rename(temp,file);}
  finally {await fs.promises.rm(temp,{force:true});}
  return backupFile;
}
export function jsonFile(file) {return JSON.parse(fs.readFileSync(file,'utf8'));}
export function profileFile(root,profile) {check(identifier(profile),'Invalid relay profile name');return path.join(root,'profiles',`${profile}.json`);}
export function loadConfig(file) {
  const c=jsonFile(file);check(c.config_version===1,'Unsupported connection config');
  check(identifier(c.device_id)&&identifier(c.profile)&&/^[A-Za-z0-9_-]{43}$/.test(c.token),'Invalid device credentials');
  c.relay_url=relayURL(c.relay_url,c.allow_loopback_http);return c;
}
export function relayURL(value,allowHTTP=false) {
  const u=new URL(value);check(!u.username&&!u.password&&!u.search&&!u.hash&&['','/'].includes(u.pathname),'Relay URL must be an origin without credentials, query or path');
  check(u.protocol==='https:'||(allowHTTP&&u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)),'Use HTTPS, or explicitly enable loopback HTTP for an SSH tunnel');
  return u.origin;
}
export async function locked(dir,fn) {
  // Locks are never silently broken: a crash leaves a clear, inspectable lock directory.
  try {await fs.promises.mkdir(dir,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new Error(`Operation is locked: ${dir}. If no bridge is running, remove this stale lock and retry.`);throw e;}
  try {await fs.promises.writeFile(path.join(dir,'owner.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{mode:0o600});return await fn();}
  finally {await fs.promises.rm(dir,{recursive:true,force:true});}
}
