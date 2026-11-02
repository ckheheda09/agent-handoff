import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { check, shaFile, identifier, relayURL } from './util.mjs';

export function makeClient(config) {
  const base=relayURL(config.relay_url,config.allow_loopback_http);
  const ca=config.ca_file ? [...tls.rootCertificates,fs.readFileSync(config.ca_file,'utf8')] : undefined;
  async function request(route,{method='GET',body,headers={},timeout=120000}={}) {
    check(route.startsWith('/v1/'),'Invalid API path');
    const u=new URL(route,base);check(u.origin===base,'Cross-origin request refused');
    return new Promise((resolve,reject)=>{
      const req=(u.protocol==='https:'?https:http).request(u,{method,ca,headers:{Authorization:`Bearer ${config.token}`,...headers,...(body?{'Content-Length':body.length}:{})}},res=>{
        if(res.statusCode>=200&&res.statusCode<300)resolve(res);
        else {const chunks=[];let n=0;res.on('data',b=>{n+=b.length;if(n<65536)chunks.push(b);});res.on('end',()=>{
          let code;try{code=JSON.parse(Buffer.concat(chunks)).error;}catch{}
          const e=new Error(`Relay HTTP ${res.statusCode}: ${code||'request_failed'}`);e.status=res.statusCode;e.code=code;reject(e);
        });}
      });
      const timer=setTimeout(()=>req.destroy(new Error('Relay request timed out')),timeout);timer.unref();
      req.on('error',e=>{clearTimeout(timer);reject(e);});req.on('response',res=>res.on('close',()=>clearTimeout(timer)));
      req.end(body);
    });
  }
  async function json(route,method='GET',value,{timeout=120000}={}) {
    const body=value===undefined?undefined:Buffer.from(JSON.stringify(value));
    const res=await request(route,{method,body,timeout,headers:body?{'Content-Type':'application/json'}:{}});
    let n=0;const chunks=[];for await(const b of res){n+=b.length;check(n<=5*1024**2,'Relay JSON too large');chunks.push(b);}
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  return {json,
    async send({id,file,to,adapter,profile}) {
      check(identifier(id)&&identifier(to),'Invalid handoff/device ID');
      const info=await fs.promises.stat(file);const hash=await shaFile(file);
      let s=await json('/v1/handoffs','POST',{id,recipient:to,size:info.size,sha256:hash,payload_format:'age-v1',adapter_id:adapter,profile_id:profile});
      check(['ready','uploading'].includes(s.status),'Handoff cannot be resumed');if(s.status==='ready')return s;
      const me=await json('/v1/me');const chunk=Math.min(me.max_chunk_bytes,8*1024**2);
      check(Number.isSafeInteger(chunk)&&chunk>0,'Invalid chunk limit');
      const fd=await fs.promises.open(file,'r');
      try {while(s.offset<info.size){
        const bytes=Buffer.alloc(Math.min(chunk,info.size-s.offset));let n=0;
        while(n<bytes.length){const r=await fd.read(bytes,n,bytes.length-n,s.offset+n);check(r.bytesRead>0,'Ciphertext changed');n+=r.bytesRead;}
        const res=await request(`/v1/handoffs/${id}/payload`,{method:'PATCH',body:bytes,headers:{'Content-Type':'application/octet-stream','Upload-Offset':String(s.offset)}});
        const parts=[];for await(const b of res)parts.push(b);const next=JSON.parse(Buffer.concat(parts));
        check(next.offset===s.offset+bytes.length,'Unexpected upload offset');s={...s,...next};
      }}finally{await fd.close();}
      return json(`/v1/handoffs/${id}/commit`,'POST',{});
    },
    async download({id,file}) {
      check(identifier(id),'Invalid handoff ID');const s=await json(`/v1/handoffs/${id}`);
      check(s.status==='ready'&&Number.isSafeInteger(s.size)&&s.size>0&&s.size<=1024**3&&/^[a-f0-9]{64}$/.test(s.sha256),'Invalid payload metadata');
      if(fs.existsSync(file)){check((await fs.promises.lstat(file)).isFile()&&await shaFile(file)===s.sha256,'Ciphertext cache conflict');return s;}
      await fs.promises.mkdir(path.dirname(file),{recursive:true,mode:0o700});const part=file+'.part';let offset=0;const hasPartial=fs.existsSync(part);
      if(hasPartial){const st=await fs.promises.lstat(part);check(st.isFile()&&!st.isSymbolicLink(),'Invalid partial file');offset=st.size;}
      check(offset<=s.size,'Partial file exceeds payload');
      if(offset<s.size){const res=await request(`/v1/handoffs/${id}/payload`,{timeout:3600000,headers:offset?{Range:`bytes=${offset}-`}:{}});
        check(res.statusCode===(offset?206:200)&&res.headers['x-payload-sha256']===s.sha256,'Unexpected payload response');
        if(offset)check(res.headers['content-range']===`bytes ${offset}-${s.size-1}/${s.size}`,'Unexpected content range');
        const fd=await fs.promises.open(part,hasPartial?'r+':'wx',0o600);
        try{for await(const b of res){check(offset+b.length<=s.size,'Payload exceeds declared size');let n=0;while(n<b.length){const w=await fd.write(b,n,b.length-n,offset+n);n+=w.bytesWritten;}offset+=b.length;}await fd.sync();}finally{await fd.close();}
      }
      check(offset===s.size&&await shaFile(part)===s.sha256,'Payload checksum mismatch; remove the .part file to retry from zero');
      await fs.promises.link(part,file);await fs.promises.unlink(part);return s;
    }
  };
}
