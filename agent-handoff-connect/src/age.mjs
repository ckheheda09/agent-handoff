import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as tar from 'tar';
import { unzipSync } from 'fflate';
import assets from './age-assets.json' with {type:'json'};
import { check, exec, privateDir, shaFile } from './util.mjs';

const AGE_VERSION='1.3.2';
export async function ensureAge(root,{bin,keygen,download=true}={}) {
  if(bin) {
    check(path.isAbsolute(bin)&&path.isAbsolute(keygen||''),'age and age-keygen must be absolute executable paths');
    await exec(bin,['--version'],{timeout:10000,windowsHide:true});
    await exec(keygen,['--version'],{timeout:10000,windowsHide:true});return {bin,keygen};
  }
  try {const find=process.platform==='win32'?'where':'which';
    const a=(await exec(find,['age'],{windowsHide:true})).stdout.trim().split(/\r?\n/)[0];
    const k=(await exec(find,['age-keygen'],{windowsHide:true})).stdout.trim().split(/\r?\n/)[0];
    if(a&&k)return ensureAge(root,{bin:a,keygen:k});
  }catch{}
  const platform={darwin:'darwin',linux:'linux',win32:'windows'}[process.platform];
  const arch={x64:'amd64',arm64:'arm64',arm:'arm'}[process.arch];
  const name=`age-v${AGE_VERSION}-${platform}-${arch}.${platform==='windows'?'zip':'tar.gz'}`;
  const asset=assets[name];check(asset,`No bundled age release for ${process.platform}/${process.arch}; provide --age-bin and --age-keygen`);
  const dest=path.join(root,'tools',`age-${AGE_VERSION}-${platform}-${arch}`);const suffix=platform==='windows'?'.exe':'';
  const result={bin:path.join(dest,'age'+suffix),keygen:path.join(dest,'age-keygen'+suffix)};
  if(fs.existsSync(result.bin)&&fs.existsSync(result.keygen))return result;
  check(download,'age is missing. Enable the verified download, or provide --age-bin and --age-keygen');
  await privateDir(path.dirname(dest));const temp=await fs.promises.mkdtemp(path.join(path.dirname(dest),'age-download-'));
  try{
    const res=await fetch(asset.url,{signal:AbortSignal.timeout(120000)});check(res.ok,`age download HTTP ${res.status}`);
    const archive=path.join(temp,name);const fd=await fs.promises.open(archive,'wx',0o600);let n=0;
    try{for await(const b of res.body){n+=b.length;check(n<=32*1024**2,'age release exceeds download limit');await fd.writeFile(b);}}finally{await fd.close();}
    check(await shaFile(archive)===asset.sha256,'Official age release checksum mismatch');
    await privateDir(path.join(temp,'unpacked'));
    if(suffix){const zip=unzipSync(await fs.promises.readFile(archive));
      for(const file of ['age.exe','age-keygen.exe']){const key=Object.keys(zip).find(k=>k===`age/${file}`);check(key,`Missing ${file}`);await fs.promises.writeFile(path.join(temp,'unpacked',file),zip[key],{mode:0o700});}
    }else{
      await tar.x({file:archive,cwd:path.join(temp,'unpacked'),strip:1,strict:true,filter:p=>['age/age','age/age-keygen'].includes(p)});
    }
    for(const file of ['age'+suffix,'age-keygen'+suffix])check((await fs.promises.lstat(path.join(temp,'unpacked',file))).isFile(),'Invalid age executable');
    try{await fs.promises.rename(path.join(temp,'unpacked'),dest);}catch(e){if(!fs.existsSync(result.bin)||!fs.existsSync(result.keygen))throw e;}
    return result;
  }finally{await fs.promises.rm(temp,{recursive:true,force:true});}
}
export async function identity(root,deviceKey,age) {
  const dir=path.join(root,'identities');await privateDir(dir);const file=path.join(dir,deviceKey+'.txt');
  if(!fs.existsSync(file)){
    const temp=file+'.'+randomUUID()+'.tmp';
    try{await exec(age.keygen,['-o',temp],{timeout:30000,windowsHide:true});await fs.promises.chmod(temp,0o600);
      // Exclusive creation preserves a key generated concurrently by a second installer.
      try{await fs.promises.link(temp,file);}catch(e){if(e.code!=='EEXIST')throw e;}
    }finally{await fs.promises.rm(temp,{force:true});}
  }
  check(!(await fs.promises.lstat(file)).isSymbolicLink(),'Identity cannot be a symlink');
  const {stdout}=await exec(age.keygen,['-y',file],{timeout:10000,windowsHide:true});const recipient=stdout.trim();
  check(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(recipient),'Invalid age identity');
  return {...age,identity:file,recipient};
}
export async function encrypt(age,recipient,input,output) {
  check(/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(recipient),'Recipient must be a native age X25519 public key');
  await exec(age.bin,['--encrypt','--recipient',recipient,'--output',output,input],{timeout:3600000,windowsHide:true,maxBuffer:65536});
  await fs.promises.chmod(output,0o600);
}
export async function decrypt(age,input,output) {
  await exec(age.bin,['--decrypt','--identity',age.identity,'--output',output,input],{timeout:3600000,windowsHide:true,maxBuffer:65536});
  await fs.promises.chmod(output,0o600);
}
